import {
  type AstArithmeticExpression,
  type AstConditionalBinaryExpression,
  type AstConditionalExpression,
  type AstConditionalLogicalExpression,
  type AstConditionalUnaryExpression,
  type AstConditionalWord,
  type AstNode,
  type AstNodeArithmeticCommand,
  type AstNodeAssignmentWord,
  type AstNodeCase,
  type AstNodeCommand,
  type AstNodeCompoundList,
  type AstNodeConditionalCommand,
  type AstNodeFor,
  type AstNodeFunction,
  type AstNodeIf,
  type AstNodeLogicalExpression,
  type AstNodePipeline,
  type AstNodeRedirect,
  type AstNodeScript,
  type AstNodeSubshell,
  type AstNodeUntil,
  type AstNodeWhile,
  type AstNodeWord,
  BashSyntaxError,
  parse,
  parseArithmetic,
  type ProtectedRange,
  utils,
} from '@ein/bash-parser';
import { getExitCode, getReturnCode, isExitSignal, isReturnSignal } from './builtins/exit.ts';
import type { BuiltinRegistry } from './builtins/types.ts';
import type { ErrorPosition } from './errors.ts';
import { UnknownNodeTypeError, UnsupportedArithmeticNodeError, UnsupportedOperatorError } from './errors.ts';
import type { ExecContextIf, ExecSyncResult, ShellIf } from './types.ts';

const CONTINUE_CODE = -10 as const;
const BREAK_CODE = -11 as const;

/** Builtins whose arguments are assignments rather than ordinary words */
const DECLARATION_COMMANDS = new Set(['declare', 'typeset', 'local', 'export', 'readonly']);

/**
 * Mark a detached promise as handled, and return it unchanged for awaiting.
 *
 * Background bridges and executions are collected into arrays that are only
 * awaited on the success path. When the command throws, the finally block tears
 * the pipes down and any in-flight promise is abandoned mid-await — it then
 * rejects with nobody listening, and an unhandled rejection is fatal under
 * Deno. A host shell reaching for a pipe that finally has just removed makes
 * this routine rather than theoretical.
 *
 * Attaching a no-op catch marks the promise handled without consuming it: the
 * reference kept in the array still rejects normally for the Promise.all.
 */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * One resolved assignment word, ready to be stored.
 */
type Assignment = {
  name: string;
  /** Set when one element is assigned, `a[2]=x` */
  subscript?: string;
  /** True for `+=` */
  append: boolean;
  /** The scalar value, or the elements of an array literal */
  values: string[];
  /** True when the value was written as a `( … )` element list */
  list: boolean;
  /** Status of the last command substitution in the value */
  status: number;
};

/**
 * Options for configuring the AstExecutor.
 */
export type AstExecutorOptions = {
  /** Optional builtin registry for handling builtin commands */
  builtins?: BuiltinRegistry;
};

/**
 * Class responsible for executing AST nodes parsed from shell scripts.
 */
export class AstExecutor {
  private shell: ShellIf;
  private currentSource?: string;
  private builtins?: BuiltinRegistry;

  constructor(shell: ShellIf, options?: AstExecutorOptions) {
    this.shell = shell;
    this.builtins = options?.builtins;
  }

  /**
   * Extract source location from an AST node.
   * Accepts locations with char offset even if row/col are missing.
   */
  private getSourceLocation(node: AstNode): ErrorPosition | undefined {
    if (!node.loc?.start) return undefined;
    const { row, col, char } = node.loc.start;
    // Accept if we have char offset OR both row and col
    if (char === undefined && (row === undefined || col === undefined)) return undefined;
    return { row, col, char };
  }

  /**
   * Compute row (1-indexed) and col (1-indexed) from char offset (0-indexed).
   */
  private positionFromOffset(source: string, char: number): ErrorPosition {
    let row = 1;
    let col = 1;
    for (let i = 0; i < char && i < source.length; i++) {
      if (source[i] === '\n') {
        row++;
        col = 1;
      } else {
        col++;
      }
    }
    return { row, col, char };
  }

  /**
   * Enhance a BashSyntaxError with full source context and computed row/col.
   */
  private enhanceSyntaxError(err: BashSyntaxError, fullSource: string): BashSyntaxError {
    const needsSource = err.source !== fullSource;
    const needsRowCol = err.location?.start?.char !== undefined &&
      (err.location.start.row === undefined || err.location.start.col === undefined);

    if (!needsSource && !needsRowCol) {
      return err;
    }

    let location = err.location;
    if (needsRowCol && location?.start?.char !== undefined) {
      const pos = this.positionFromOffset(fullSource, location.start.char);
      location = { start: pos, end: location.end };
    }

    return new BashSyntaxError(err.message, fullSource, location, err.cause);
  }

  /**
   * Executes a shell script source code.
   * @param {string} source - The shell script source code.
   * @param {ExecContextIf} ctx - The execution context.
   * @returns {Promise<number>} - The exit code of the executed script.
   */
  public async execute(source: string, ctx: ExecContextIf): Promise<number> {
    this.currentSource = source;
    try {
      // Resolvers given here will be evaluated at parse time.
      // Most things we want to evaluate at execution time and
      // that is instead done during execution with resolveExpansions.
      const ast = await parse(source, {
        insertLOC: true,
        resolveAlias: async (name: string) => ctx.getAlias(name),

        resolveHomeUser: this.shell.resolveHomeUser ? (async (username: string | null) => this.shell.resolveHomeUser!(ctx, username)) : undefined,
      });

      return await this.executeNode(ast, ctx);
    } catch (err) {
      // Enhance BashSyntaxError with full source context
      if (err instanceof BashSyntaxError) {
        throw this.enhanceSyntaxError(err, source);
      }
      throw err;
    } finally {
      this.currentSource = undefined;
    }
  }

  /**
   * Executes a shell script and captures stdout/stderr.
   * @param {string} source - The shell script source code.
   * @param {ExecContextIf} ctx - The execution context.
   * @returns {Promise<ExecSyncResult>} - The result including exit code, stdout, and stderr.
   */
  public async executeAndCapture(source: string, ctx: ExecContextIf): Promise<ExecSyncResult> {
    let stdoutFd: string = '';
    let stderrFd: string = '';
    let stdoutRead: Promise<string> | undefined;
    let stderrRead: Promise<string> | undefined;

    try {
      // Create temporary pipes for capturing output
      stdoutFd = await this.shell.pipeOpen();
      stderrFd = await this.shell.pipeOpen();

      // Drain the pipes while the command runs — pipes have a fixed capacity,
      // so output larger than the capacity would block the writer forever if
      // reading only started after execute() returned.
      stdoutRead = this.shell.pipeRead(stdoutFd);
      stderrRead = this.shell.pipeRead(stderrFd);

      // Setup piped context — a subshell, so env/cwd changes (e.g. `export`) the
      // captured command makes stay local and don't leak into the calling shell.
      const cmdCtx = ctx.subContext();
      cmdCtx.redirectStdout(stdoutFd);
      cmdCtx.redirectStderr(stderrFd);

      // Execute
      const code = await this.execute(source, cmdCtx);

      // Send EOF so the drains finish
      await this.shell.pipeClose(stdoutFd);
      await this.shell.pipeClose(stderrFd);

      const stdout = await stdoutRead;
      const stderr = await stderrRead;

      return { code, stdout, stderr };
    } catch (err) {
      return {
        code: 1,
        stdout: '',
        stderr: `Error: ${(err as Error).message}\n`,
      };
    } finally {
      // Settle the drains (EOF unblocks them) before removing the pipes so
      // no read is left dangling on the error path
      if (stdoutFd) await this.shell.pipeClose(stdoutFd).catch(() => {});
      if (stderrFd) await this.shell.pipeClose(stderrFd).catch(() => {});
      await stdoutRead?.catch(() => {});
      await stderrRead?.catch(() => {});
      // Cleanup pipes
      if (stdoutFd) await this.shell.pipeRemove(stdoutFd).catch(() => {});
      if (stderrFd) await this.shell.pipeRemove(stderrFd).catch(() => {});
    }
  }

  /**
   * Executes an AST node based on its type.
   * @param {AstNode} node - The AST node to execute.
   * @param {ExecContextIf} ctx - The execution context.
   * @returns {Promise<number>} - The exit code of the executed node.
   */
  public async executeNode(node: AstNode, ctx: ExecContextIf): Promise<number> {
    switch (node.type) {
      case 'Script':
        return this.executeScript(node as AstNodeScript, ctx);
      case 'Command':
        return this.executeCommand(node as AstNodeCommand, ctx);
      case 'Function':
        return this.registerFunction(node as AstNodeFunction, ctx);
      case 'If':
        return this.executeIf(node as AstNodeIf, ctx);
      case 'While':
        return this.executeWhile(node as AstNodeWhile, ctx);
      case 'Until':
        return this.executeUntil(node as AstNodeUntil, ctx);
      case 'For':
        return this.executeFor(node as AstNodeFor, ctx);
      case 'Case':
        return this.executeCase(node as AstNodeCase, ctx);
      case 'Subshell':
        return this.executeSubshell(node as AstNodeSubshell, ctx);
      case 'Pipeline':
        return this.executePipeline(node as AstNodePipeline, ctx);
      case 'LogicalExpression':
        return this.executeLogicalExpression(node as AstNodeLogicalExpression, ctx);
      case 'CompoundList':
        return this.executeCompondList(node as AstNodeCompoundList, ctx);
      case 'ArithmeticCommand':
        return this.executeArithmeticCommand(node as AstNodeArithmeticCommand, ctx);
      case 'ConditionalCommand':
        return this.executeConditionalCommand(node as AstNodeConditionalCommand, ctx);
      default:
        throw new UnknownNodeTypeError(node.type, this.getSourceLocation(node), this.currentSource);
    }
  }

  protected async applyRedirections(ctx: ExecContextIf, redirects?: AstNodeRedirect[]) {
    for (const r of (redirects || [])) {
      const { values } = await this.resolveExpansions(r.file, ctx);
      const target = values[0] || r.file.text;

      if (r.op.text === '<') {
        ctx.redirectStdin(target);
      } else if (r.op.text === '>') {
        if (r.numberIo?.text === '2') {
          ctx.redirectStderr(target);
        } else {
          ctx.redirectStdout(target);
        }
      } else if (r.op.text === '>>') {
        // TODO: Implement append redirection
        if (r.numberIo?.text === '2') {
          ctx.redirectStderr(target, true);
        } else {
          ctx.redirectStdout(target, true);
        }
      } else if (r.op.text === '>&') {
        const sourceFd = r.numberIo?.text;

        // Close FD: N>&- or >&-
        if (target === '-') {
          const fd = sourceFd || '1';
          await this.shell.fdClose?.(fd);
          ctx.closeFd(fd);
          continue;
        }

        // Check if target is a numeric file descriptor (fd duplication)
        if (/^\d+$/.test(target)) {
          // Get current destination of target fd
          const targetDest = ctx.getFd(target) ?? target;

          // Redirect source fd to target's destination
          if (sourceFd) {
            ctx.redirectFd(sourceFd, targetDest);
          } else {
            ctx.redirectStdout(targetDest);
          }
        } else {
          // Non-numeric target - it's a filename
          if (sourceFd === '2') {
            ctx.redirectStderr(target);
          } else {
            ctx.redirectStdout(target);
          }
        }
      } else if (r.op.text === '<&') {
        const sourceFd = r.numberIo?.text || '0';

        // Close FD: N<&- or <&-
        if (target === '-') {
          await this.shell.fdClose?.(sourceFd);
          ctx.closeFd(sourceFd);
          continue;
        }

        if (/^\d+$/.test(target)) {
          const targetDest = ctx.getFd(target) ?? target;
          ctx.redirectFd(sourceFd, targetDest);
        } else {
          ctx.redirectStdin(target);
        }
      } else if (r.op.text === '<>') {
        const fd = r.numberIo?.text || '0';
        if (this.shell.fdOpen) {
          await this.shell.fdOpen(ctx, target, 'r+', fd);
        }
      }
    }
  }

  protected async executeScript(node: AstNodeScript, ctx: ExecContextIf): Promise<number> {
    let lastCode = 0;

    for (const command of node.commands) {
      lastCode = await this.executeNode(command, ctx);

      // Handle exit signal - stop script execution and return the exit code
      if (isExitSignal(lastCode)) {
        const exitCode = getExitCode(lastCode);
        ctx.setParams({ '?': String(exitCode) });
        return exitCode;
      }

      // Handle return signal - propagate up (will be caught by function execution)
      if (isReturnSignal(lastCode)) {
        return lastCode;
      }

      // Update $? with the last command's exit code
      ctx.setParams({ '?': String(lastCode) });

      // Note: Non-zero exit codes do NOT stop script execution
      // (unless set -e is enabled, which we'd need to check here)
    }

    return lastCode;
  }

  protected async executeCommand(node: AstNodeCommand, parentCtx: ExecContextIf): Promise<number> {
    // Handle exec: apply redirections to parent context, ignore args.
    // Only a literal `exec` counts. Expanding the name here as well as below ran
    // every command substitution in it twice — `$(pick-a-command) arg` executed
    // `pick-a-command` two times, side effects included.
    if (node.name && !node.name.expansion?.length && node.name.text === 'exec') {
      const redirects = node.suffix?.filter((arg) => arg.type === 'Redirect') as AstNodeRedirect[] | undefined;
      await this.applyRedirections(parentCtx, redirects);
      return 0;
    }

    // Create an execution context
    const ctx = parentCtx.spawnContext();

    // A bare assignment takes the status of the last command substitution in it,
    // so `x=$(false)` sets x to that command's output and leaves $? at 1.
    let assignStatus = 0;

    const assignments: Assignment[] = [];

    for (const arg of node.prefix?.filter((arg) => arg.type === 'AssignmentWord') || []) {
      const assignment = await this.resolveAssignment(arg, ctx);

      if (!assignment) {
        continue;
      }

      assignStatus = assignment.status;
      assignments.push(assignment);
    }

    // Bare assignments (no command) persist in shell, prefix assignments are scoped to the command
    for (const assignment of assignments) {
      await this.applyAssignment(assignment, ctx, Boolean(node?.name));
    }

    if (!node?.name) {
      return assignStatus;
    }

    // Create an args list
    const args: string[] = [];

    // These take assignments rather than words, so their arguments are not field
    // split: `declare x=$V` is one word however many blanks V holds, and
    // `local x=($V)` is an element list.
    const literalName = node.name && !node.name.expansion?.length ? node.name.text : '';
    const declaration = DECLARATION_COMMANDS.has(literalName);

    for (const arg of node.suffix?.filter((arg) => arg.type === 'Word') || []) {
      const assignment = declaration ? utils.parseAssignmentWord(arg.text) : null;

      if (assignment) {
        args.push(await this.resolveDeclarationArg(arg, ctx, assignment));
        continue;
      }

      const { values } = await this.resolveExpansions(arg, ctx);

      args.push(...values);
    }

    // Apply IO redirections
    await this.applyRedirections(ctx, node.suffix?.filter((arg) => arg.type === 'Redirect'));

    // Expand command
    const expandedName = await this.resolveExpansions(node.name, ctx);

    // TODO: We can fail for any number of things above, should we apply the bang inversion to those as well?

    const cmdName = expandedName.values[0]; // TODO: Can we expand to more than one value here?

    // Loop control is carried out of the body as a reserved exit code. Only the
    // command *name* means it — `echo break` is an argument that happens to read
    // "break", and used to terminate the enclosing loop.
    if (cmdName === 'break') {
      return BREAK_CODE;
    }

    if (cmdName === 'continue') {
      return CONTINUE_CODE;
    }
    let code: number;

    return this.withFileBridging(ctx, async () => {
      // Check for builtin first
      const builtin = this.builtins?.get(cmdName);
      if (builtin) {
        const execute = (script: string) => this.execute(script, ctx);
        const result = await builtin(ctx, args || [], this.shell, execute);

        // Write stdout/stderr if present
        if (result.stdout) {
          await this.shell.pipeWrite(ctx.getStdout(), result.stdout);
        }
        if (result.stderr) {
          await this.shell.pipeWrite(ctx.getStderr(), result.stderr);
        }
        code = result.code;
      } else {
        // Check for function
        const fn = ctx.getFunction(cmdName);
        if (fn) {
          code = await this.executeFunction(ctx, fn, args || []);
        } else {
          // Execute external command
          code = await this.shell.execute(
            ctx,
            cmdName,
            args || [],
            {
              async: node.async,
            },
          );
        }
      }

      return node.bang ? (code === 0 ? 1 : 0) : code;
    });
  }

  /**
   * Executes a shell function.
   * @param {ExecContextIf} ctx - The caller's execution context.
   * @param {FunctionDef} fn - The function definition.
   * @param {string[]} args - The arguments to pass to the function.
   * @returns {Promise<number>} - The exit code of the function.
   */
  protected async executeFunction(
    ctx: ExecContextIf,
    fn: { name: string; body: AstNodeCompoundList; ctx: ExecContextIf },
    args: string[],
  ): Promise<number> {
    const fnCtx = fn.ctx.spawnContext();

    // Inherit I/O from caller context
    fnCtx.redirectStdin(ctx.getStdin());
    fnCtx.redirectStdout(ctx.getStdout());
    fnCtx.redirectStderr(ctx.getStderr());

    // Set positional parameters
    for (let i = 0; i < args.length; i++) {
      fnCtx.setLocalParams({ [`${i + 1}`]: args[i] });
    }
    fnCtx.setLocalParams({
      '#': String(args.length),
      '@': args.join(' '),
      '*': args.join(' '),
    });

    const code = await this.executeNode(fn.body, fnCtx);

    // Convert return signal to actual return code
    if (isReturnSignal(code)) {
      return getReturnCode(code);
    }

    return code;
  }

  protected async executeSubshell(node: AstNodeSubshell, parentCtx: ExecContextIf): Promise<number> {
    // `( … )` is a subshell: env/cwd changes inside must not escape to the parent.
    const ctx = parentCtx.subContext();
    return this.withFileBridging(ctx, () => {
      return this.executeNode(node.list, ctx);
    });
  }

  /**
   * Wraps command execution with file-to-pipe bridging.
   * If stdin/stdout/stderr in the context are file paths (not pipes),
   * this creates bridging pipes and handles streaming data between files and pipes.
   * @param ctx - The execution context with possible file redirections
   * @param fn - The function to execute with bridged I/O
   * @returns The exit code from the function
   */
  private async withFileBridging(ctx: ExecContextIf, fn: () => Promise<number>): Promise<number> {
    const pipes: string[] = [];
    const bridges: Promise<void>[] = [];
    let stdoutPipe: string | null = null;
    let stderrPipe: string | null = null;

    try {
      // Handle stdin redirection from file
      const stdin = ctx.getStdin();
      if (!this.shell.isPipe(stdin)) {
        const pipe = await this.shell.pipeOpen();
        pipes.push(pipe);
        // Start reading from file in background (will close pipe when done)
        this.shell.pipeFromFile(ctx, stdin, pipe).catch((err) => console.error('Failed to read from file:', err));
        ctx.redirectStdin(pipe);
      }

      // Handle stdout redirection to file
      const stdout = ctx.getStdout();
      if (!this.shell.isPipe(stdout)) {
        stdoutPipe = await this.shell.pipeOpen();
        pipes.push(stdoutPipe);
        const stdoutAppend = ctx.getStdoutAppend();
        // Start writing to file in background (will complete when pipe is closed)
        bridges.push(handled(this.shell.pipeToFile(ctx, stdoutPipe, stdout, stdoutAppend)));
        ctx.redirectStdout(stdoutPipe);
      }

      // Handle stderr redirection to file
      const stderr = ctx.getStderr();
      if (!this.shell.isPipe(stderr)) {
        stderrPipe = await this.shell.pipeOpen();
        pipes.push(stderrPipe);
        const stderrAppend = ctx.getStderrAppend();
        bridges.push(handled(this.shell.pipeToFile(ctx, stderrPipe, stderr, stderrAppend)));
        ctx.redirectStderr(stderrPipe);
      }

      // Execute the function
      const code = await fn();

      // Close output pipes to signal EOF to pipeToFile
      if (stdoutPipe) {
        await this.shell.pipeClose(stdoutPipe);
      }
      if (stderrPipe) {
        await this.shell.pipeClose(stderrPipe);
      }

      // Wait for bridges to complete
      await Promise.all(bridges);

      return code;
    } finally {
      for (const pipe of pipes) {
        await this.shell.pipeRemove(pipe).catch(() => {});
      }
    }
  }

  protected async executePipeline(node: AstNodePipeline, ctx: ExecContextIf): Promise<number> {
    const pipes: string[] = [];
    const executions: Promise<number>[] = [];
    const fileBridges: Promise<void>[] = [];
    let lastCtx: ExecContextIf | null = null;
    let lastStdoutPipe: string | null = null;

    try {
      for (let n = 0; n < node.commands.length; n++) {
        // Each pipeline stage is a subshell — isolate env/cwd so a stage can't leak
        // into the parent (or race the other concurrently-running stages).
        const cmdCtx = ctx.subContext();
        const isFirstCommand = n === 0;
        const isLastCommand = n === node.commands.length - 1;

        // If not the first command, redirect stdin from the last command's stdout
        if (lastCtx) {
          cmdCtx.redirectStdin(lastCtx.getStdout());
        } else if (isFirstCommand) {
          // First command: check if stdin needs file bridging
          const stdin = cmdCtx.getStdin();
          if (!this.shell.isPipe(stdin)) {
            const pipe = await this.shell.pipeOpen();
            pipes.push(pipe);
            // Start reading from file in background
            this.shell.pipeFromFile(ctx, stdin, pipe).catch((err) => console.error('Failed to read from file:', err));
            cmdCtx.redirectStdin(pipe);
          }
        }

        // If not the last command, create a pipe for stdout
        let stdoutRedirected = false;
        if (!isLastCommand) {
          const pipe = await this.shell.pipeOpen();
          pipes.push(pipe);

          cmdCtx.setLocalEnv({ TERM: '0' });
          cmdCtx.redirectStdout(pipe);
          stdoutRedirected = true;
        } else {
          // Last command: check if stdout needs file bridging
          const stdout = cmdCtx.getStdout();
          if (!this.shell.isPipe(stdout)) {
            lastStdoutPipe = await this.shell.pipeOpen();
            pipes.push(lastStdoutPipe);
            const stdoutAppend = ctx.getStdoutAppend();
            // Start writing to file in background
            fileBridges.push(handled(this.shell.pipeToFile(ctx, lastStdoutPipe, stdout, stdoutAppend)));
            cmdCtx.redirectStdout(lastStdoutPipe);
            stdoutRedirected = true;
          }
        }

        executions.push(
          handled(
            this.executeNode(node.commands[n], cmdCtx).finally(() => {
              if (stdoutRedirected) {
                this.shell.pipeClose(cmdCtx.getStdout()).catch((err) => console.error('Failed to close pipe: ', err));
              }
            }),
          ),
        );

        lastCtx = cmdCtx;
      }

      const codes = await Promise.all(executions);

      // Wait for file bridges to complete
      await Promise.all(fileBridges);

      return codes[codes.length - 1];
    } finally {
      for (const pipe of pipes) {
        this.shell.pipeRemove(pipe).catch((err) => console.error('Failed to remove pipe: ', err));
      }
    }
  }

  protected async executeCompondList(node: AstNodeCompoundList, parentCtx: ExecContextIf): Promise<number> {
    const ctx = parentCtx.spawnContext();
    await this.applyRedirections(ctx, node.redirections);

    let lastCode = 0;

    for (const command of node.commands) {
      lastCode = await this.executeNode(command, ctx);

      // Propagate exit, return, break, and continue signals immediately
      if (isExitSignal(lastCode) || isReturnSignal(lastCode) || lastCode === CONTINUE_CODE || lastCode === BREAK_CODE) {
        return lastCode;
      }

      // $? is updated after every command, not just at script level. Without this a
      // compound body (if/while/for/{}/function) sees the *enclosing* $? — so the
      // `cmd; STATUS=$?; if [ $STATUS -ne 0 ]` retry idiom silently reads 0 and every
      // failure inside an if looks like a success.
      ctx.setParams({ '?': String(lastCode) });
    }

    return lastCode;
  }

  protected async registerFunction(node: AstNodeFunction, parentCtx: ExecContextIf): Promise<number> {
    const ctx = parentCtx.spawnContext();
    await this.applyRedirections(ctx, node.redirections);
    parentCtx.setFunction(node.name.text, node.body, ctx);

    return 0;
  }

  protected async executeIf(node: AstNodeIf, ctx: ExecContextIf): Promise<number> {
    if (await this.executeNode(node.clause, ctx) === 0) {
      return await this.executeNode(node.then, ctx);
    } else if (node.else) {
      return await this.executeNode(node.else, ctx);
    }

    return 0;
  }

  /**
   * Run one loop iteration and decide what the loop does next.
   *
   * A failing body does *not* end a loop — `for f in *; do grep x $f; done`
   * keeps going past the files without a match, and the loop's own status is
   * the status of the last iteration. Only break, continue, exit and return
   * change the flow.
   */
  private async runLoopBody(body: AstNode, ctx: ExecContextIf): Promise<{ stop: boolean; code: number }> {
    const code = await this.executeNode(body, ctx);

    if (code === BREAK_CODE) {
      return { stop: true, code: 0 };
    }

    if (code === CONTINUE_CODE) {
      return { stop: false, code: 0 };
    }

    // Propagate exit and return signals
    if (isExitSignal(code) || isReturnSignal(code)) {
      return { stop: true, code };
    }

    return { stop: false, code };
  }

  protected async executeWhile(node: AstNodeWhile, ctx: ExecContextIf): Promise<number> {
    let last = 0;

    while (await this.executeNode(node.clause, ctx) === 0) {
      const { stop, code } = await this.runLoopBody(node.do, ctx);
      last = code;

      if (stop) {
        return code;
      }
    }

    return last;
  }

  protected async executeUntil(node: AstNodeUntil, ctx: ExecContextIf): Promise<number> {
    let last = 0;

    while (await this.executeNode(node.clause, ctx) !== 0) {
      const { stop, code } = await this.runLoopBody(node.do, ctx);
      last = code;

      if (stop) {
        return code;
      }
    }

    return last;
  }

  protected async executeFor(node: AstNodeFor, ctx: ExecContextIf): Promise<number> {
    // The whole word list is expanded once, before the first iteration, so the
    // body cannot change what is still to be iterated over.
    const values: string[] = [];

    for (const word of node.wordlist || []) {
      const expanded = await this.resolveExpansions(word, ctx);

      values.push(...expanded.values);
    }

    let last = 0;

    for (const value of values) {
      ctx.setParams({ [node.name.text]: value });

      const { stop, code } = await this.runLoopBody(node.do, ctx);
      last = code;

      if (stop) {
        return code;
      }
    }

    return last;
  }

  protected async executeCase(node: AstNodeCase, ctx: ExecContextIf): Promise<number> {
    // Expand the clause value
    const clauseExpanded = await this.resolveExpansions(node.clause, ctx);
    const clauseValue = clauseExpanded.values[0] || '';

    for (const caseItem of node.cases || []) {
      // Check if any pattern matches (patterns undergo expansion and quote
      // removal: quoted characters match literally, unquoted globs are active)
      let matched = false;
      for (const pattern of caseItem.pattern) {
        const regex = await this.expandCasePattern(pattern, ctx);
        if (regex.test(clauseValue)) {
          matched = true;
          break;
        }
      }

      if (matched) {
        if (!caseItem.body) {
          return 0;
        }
        return await this.executeNode(caseItem.body, ctx);
      }
    }

    return 0;
  }

  /**
   * Resolve a case pattern word to a matcher regex.
   *
   * The parser leaves pattern words raw (quotes still in `text`, globs marked
   * as PathExpansion), so this walks the raw text tracking quote state:
   * quoted characters and backslash-escaped characters match literally, while
   * unquoted `*`, `?` and `[...]` become glob wildcards. Parameter, command
   * and arithmetic expansions are evaluated in place — their results are
   * glob-active when unquoted, literal when inside double quotes (as in bash);
   * no filename expansion or field splitting is applied.
   */
  protected async expandCasePattern(word: AstNodeWord, ctx: ExecContextIf): Promise<RegExp> {
    const text = word.text;

    const escapeRegexChar = (c: string): string => /[\\^$.*+?()[\]{}|]/.test(c) ? `\\${c}` : c;

    // Glob translation for expansion results (quote chars in values are data)
    const globToRegex = (s: string): string => {
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '*') {
          out += '.*';
        } else if (c === '?') {
          out += '.';
        } else if (c === '[') {
          const end = s.indexOf(']', i + 1);
          if (end !== -1) {
            out += s.slice(i, end + 1);
            i = end;
          } else {
            out += '\\[';
          }
        } else {
          out += escapeRegexChar(c);
        }
      }
      return out;
    };

    // Pre-evaluate non-glob expansions by their location in the raw text,
    // each via a synthetic single-expansion word so resolveExpansions'
    // parameter-op/command/arithmetic handling is reused as-is
    const evaluated = new Map<number, { end: number; value: string }>();
    for (const xp of word.expansion ?? []) {
      if (xp.type === 'PathExpansion' || xp.resolved || !xp.loc) {
        continue;
      }
      const synthetic = {
        type: 'Word',
        text: text.slice(xp.loc.start, xp.loc.end + 1),
        expansion: [{ ...xp, loc: { start: 0, end: xp.loc.end - xp.loc.start } }],
      } as AstNodeWord;
      const { values } = await this.resolveExpansions(synthetic, ctx);
      evaluated.set(xp.loc.start, { end: xp.loc.end, value: values.join(' ') });
    }

    let regex = '^';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < text.length; i++) {
      const expansion = !inSingle ? evaluated.get(i) : undefined;
      if (expansion) {
        regex += inDouble ? [...expansion.value].map(escapeRegexChar).join('') : globToRegex(expansion.value);
        i = expansion.end;
        continue;
      }

      const c = text[i];

      if (!inSingle && !inDouble && c === '\\' && i + 1 < text.length) {
        regex += escapeRegexChar(text[++i]);
        continue;
      }
      if (!inDouble && c === "'") {
        inSingle = !inSingle;
        continue;
      }
      if (!inSingle && c === '"') {
        inDouble = !inDouble;
        continue;
      }
      if (inSingle || inDouble) {
        regex += escapeRegexChar(c);
        continue;
      }

      if (c === '*') {
        regex += '.*';
      } else if (c === '?') {
        regex += '.';
      } else if (c === '[') {
        const end = text.indexOf(']', i + 1);
        if (end !== -1) {
          regex += text.slice(i, end + 1);
          i = end;
        } else {
          regex += '\\[';
        }
      } else {
        regex += escapeRegexChar(c);
      }
    }
    regex += '$';

    try {
      return new RegExp(regex);
    } catch {
      // invalid regex (e.g. malformed character class): fall back to exact match
      const literal = [...text].map(escapeRegexChar).join('');
      return new RegExp(`^${literal}$`);
    }
  }

  /**
   * Matches a glob pattern against a value.
   * Supports *, ?, and character classes.
   */
  protected matchGlobPattern(pattern: string, value: string): boolean {
    // Convert glob pattern to regex
    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      switch (c) {
        case '*':
          regex += '.*';
          break;
        case '?':
          regex += '.';
          break;
        case '[': {
          // Find the closing bracket
          const end = pattern.indexOf(']', i + 1);
          if (end !== -1) {
            regex += pattern.slice(i, end + 1);
            i = end;
          } else {
            regex += '\\[';
          }
          break;
        }
        case '\\':
        case '^':
        case '$':
        case '.':
        case '+':
        case '(':
        case ')':
        case '{':
        case '}':
        case '|':
          regex += '\\' + c;
          break;
        default:
          regex += c;
      }
    }
    regex += '$';

    try {
      return new RegExp(regex).test(value);
    } catch {
      // If regex is invalid, fall back to exact match
      return pattern === value;
    }
  }

  protected async executeLogicalExpression(node: AstNodeLogicalExpression, ctx: ExecContextIf): Promise<number> {
    const left = await this.executeNode(node.left, ctx);

    if (node.op === 'and') {
      if (left !== 0) {
        return left;
      }
    } else if (node.op === 'or') {
      if (left === 0) {
        return left;
      }
    } else {
      throw new UnsupportedOperatorError(node.op, 'logical', this.getSourceLocation(node), this.currentSource);
    }

    return await this.executeNode(node.right, ctx);
  }

  protected async executeArithmeticCommand(node: AstNodeArithmeticCommand, ctx: ExecContextIf): Promise<number> {
    const result = await this.evaluateArithmetic(node.arithmeticAST, ctx);
    // In bash, (( expr )) returns 0 (success) if expr is non-zero, 1 (failure) if expr is zero
    return result !== 0 ? 0 : 1;
  }

  /**
   * Executes a [[ conditional ]] command.
   * Returns 0 if the condition is true, 1 if false.
   */
  protected async executeConditionalCommand(node: AstNodeConditionalCommand, ctx: ExecContextIf): Promise<number> {
    const result = await this.evaluateConditionalExpression(node.conditionAST, ctx);
    return result ? 0 : 1;
  }

  /**
   * Recursively evaluates a conditional expression AST node.
   */
  protected async evaluateConditionalExpression(
    node: AstConditionalExpression,
    ctx: ExecContextIf,
  ): Promise<boolean> {
    switch (node.type) {
      case 'ConditionalWord':
        // A standalone word is true if non-empty after expansion
        return (await this.expandConditionalWord(node, ctx)).length > 0;

      case 'ConditionalNegation':
        return !(await this.evaluateConditionalExpression(node.argument, ctx));

      case 'ConditionalLogicalExpression':
        return this.evaluateConditionalLogical(node, ctx);

      case 'ConditionalUnaryExpression':
        return this.evaluateConditionalUnary(node, ctx);

      case 'ConditionalBinaryExpression':
        return this.evaluateConditionalBinary(node, ctx);

      default:
        throw new UnknownNodeTypeError(
          (node as { type: string }).type,
          this.getSourceLocation(node),
          this.currentSource,
        );
    }
  }

  /**
   * Evaluates logical conditional expressions (&& and ||) with short-circuit evaluation.
   */
  protected async evaluateConditionalLogical(
    node: AstConditionalLogicalExpression,
    ctx: ExecContextIf,
  ): Promise<boolean> {
    const left = await this.evaluateConditionalExpression(node.left, ctx);

    if (node.operator === '&&') {
      // Short-circuit: if left is false, return false without evaluating right
      return left && (await this.evaluateConditionalExpression(node.right, ctx));
    } else {
      // ||: Short-circuit: if left is true, return true without evaluating right
      return left || (await this.evaluateConditionalExpression(node.right, ctx));
    }
  }

  /**
   * Evaluates unary conditional expressions (-f, -d, -z, -n, etc.).
   */
  protected async evaluateConditionalUnary(
    node: AstConditionalUnaryExpression,
    ctx: ExecContextIf,
  ): Promise<boolean> {
    const arg = await this.expandConditionalWord(node.argument, ctx);
    const op = node.operator;

    // String tests
    if (op === '-z') return arg.length === 0;
    if (op === '-n') return arg.length > 0;

    // Variable tests
    if (op === '-v') {
      // -v varname: true if variable is set
      const params = { ...ctx.getEnv(), ...ctx.getParams() };
      return arg in params;
    }

    // File tests - delegate to shell.execCommand('test', ...)
    const fileTestOps = new Set([
      '-e',
      '-f',
      '-d',
      '-r',
      '-w',
      '-x',
      '-s',
      '-L',
      '-h',
      '-b',
      '-c',
      '-p',
      '-S',
      '-g',
      '-u',
      '-k',
      '-O',
      '-G',
      '-N',
      '-t',
      '-a', // -a FILE is file test (different from -a in [ ] logical context)
    ]);

    if (fileTestOps.has(op)) {
      const code = await this.shell.execute(ctx, 'test', [op, arg], {});
      return code === 0;
    }

    throw new UnsupportedOperatorError(op, 'unary', this.getSourceLocation(node), this.currentSource);
  }

  /**
   * Evaluates binary conditional expressions (==, !=, -eq, =~, etc.).
   */
  protected async evaluateConditionalBinary(
    node: AstConditionalBinaryExpression,
    ctx: ExecContextIf,
  ): Promise<boolean> {
    const op = node.operator;
    const left = await this.expandConditionalWord(node.left, ctx);

    // String comparison operators
    if (op === '==' || op === '=') {
      // Pattern matching: right side is a pattern
      const right = await this.expandConditionalWord(node.right, ctx);
      return this.matchGlobPattern(right, left);
    }
    if (op === '!=') {
      const right = await this.expandConditionalWord(node.right, ctx);
      return !this.matchGlobPattern(right, left);
    }
    if (op === '<') {
      const right = await this.expandConditionalWord(node.right, ctx);
      return left < right; // Lexicographic comparison
    }
    if (op === '>') {
      const right = await this.expandConditionalWord(node.right, ctx);
      return left > right; // Lexicographic comparison
    }

    // Regex matching
    if (op === '=~') {
      // For =~, use the raw text with only variable expansion (no unquoting)
      // since shell metacharacters like () | are valid regex syntax
      const rightText = await this.expandConditionalRegex(node.right, ctx);
      try {
        const regex = new RegExp(rightText);
        const match = left.match(regex);
        if (match) {
          // The whole match first, then one element per capture group
          ctx.setArray('BASH_REMATCH', Array.from(match, (group) => group ?? ''));
          return true;
        }
        return false;
      } catch {
        // Invalid regex - return false
        return false;
      }
    }

    // Numeric comparison operators
    if (op === '-eq' || op === '-ne' || op === '-lt' || op === '-le' || op === '-gt' || op === '-ge') {
      const right = await this.expandConditionalWord(node.right, ctx);
      const leftNum = Number.parseInt(left, 10) || 0;
      const rightNum = Number.parseInt(right, 10) || 0;

      switch (op) {
        case '-eq':
          return leftNum === rightNum;
        case '-ne':
          return leftNum !== rightNum;
        case '-lt':
          return leftNum < rightNum;
        case '-le':
          return leftNum <= rightNum;
        case '-gt':
          return leftNum > rightNum;
        case '-ge':
          return leftNum >= rightNum;
      }
    }

    // File comparison operators - delegate to shell
    if (op === '-nt' || op === '-ot' || op === '-ef') {
      const right = await this.expandConditionalWord(node.right, ctx);
      const code = await this.shell.execute(ctx, 'test', [left, op, right], {});
      return code === 0;
    }

    throw new UnsupportedOperatorError(op, 'binary', this.getSourceLocation(node), this.currentSource);
  }

  /**
   * Expands a ConditionalWord node, resolving variable expansions.
   * Unlike regular word expansion, [[ ]] does NOT do word splitting or glob expansion.
   */
  protected async expandConditionalWord(
    word: AstConditionalWord,
    ctx: ExecContextIf,
  ): Promise<string> {
    if (!word.expansion || word.expansion.length === 0) {
      // No expansions - process quotes and escapes
      const unquoted = utils.unquoteWord(word.text);
      return utils.unescape(unquoted.values[0] ?? word.text);
    }

    const rValue = new utils.ReplaceString(word.text);

    for (const xp of word.expansion) {
      if (xp.resolved) continue;

      if (xp.type === 'ParameterExpansion') {
        const params = { ...ctx.getEnv(), ...ctx.getParams() };
        rValue.replace(
          xp.loc!.start,
          xp.loc!.end + 1,
          params[xp.parameter!] || '',
        );
      } else if (xp.type === 'CommandExpansion') {
        // Handle command substitution
        // Command substitution runs in a subshell — isolate env/cwd so it can't
        // leak (e.g. `$(export X=1)` must not set X in the calling shell).
        const cmdCtx = ctx.subContext();
        cmdCtx.setLocalEnv({ TERM: '0' });
        cmdCtx.redirectStdout(await this.shell.pipeOpen());

        try {
          await this.executeNode(xp.commandAST, cmdCtx);
          await this.shell.pipeClose(cmdCtx.getStdout());
          const output = await this.shell.pipeRead(cmdCtx.getStdout());
          rValue.replace(xp.loc!.start, xp.loc!.end + 1, output.trimEnd());
        } finally {
          this.shell.pipeRemove(cmdCtx.getStdout()).catch(() => {});
        }
      } else if (xp.type === 'ArithmeticExpansion') {
        const result = await this.evaluateArithmetic(xp.arithmeticAST, ctx);
        rValue.replace(xp.loc!.start, xp.loc!.end + 1, String(result));
      }
      // Note: PathExpansion is NOT applied in [[ ]] - patterns are used literally
    }

    // Process quotes but NOT word splitting (key difference from [ ])
    const unquoted = utils.unquoteWord(rValue.text);
    return utils.unescape(unquoted.values[0] ?? rValue.text);
  }

  /**
   * Expands the right-hand side of =~ without unquoting (preserves regex metacharacters).
   */
  protected async expandConditionalRegex(
    word: AstConditionalWord,
    ctx: ExecContextIf,
  ): Promise<string> {
    if (!word.expansion || word.expansion.length === 0) {
      return word.text;
    }

    const rValue = new utils.ReplaceString(word.text);

    for (const xp of word.expansion) {
      if (xp.resolved) continue;

      if (xp.type === 'ParameterExpansion') {
        const params = { ...ctx.getEnv(), ...ctx.getParams() };
        rValue.replace(
          xp.loc!.start,
          xp.loc!.end + 1,
          params[xp.parameter!] || '',
        );
      }
    }

    return rValue.text;
  }

  /**
   * The current field separators.
   *
   * Assignments land in params, not env, so `IFS=:` and `IFS= read …` are only
   * visible if both are consulted. An IFS that is set but empty disables field
   * splitting and is not the same as an unset one.
   */
  protected getIfs(ctx: ExecContextIf): string {
    const params = ctx.getParams();
    const env = ctx.getEnv();

    return params['IFS'] ?? env['IFS'] ?? utils.DEFAULT_IFS;
  }

  /**
   * Work out what an assignment word assigns, expansions included.
   *
   * `x=1`, `x+=1`, `x[2]=1`, `x=(a b)` and `x+=(c)` all end up here; the element
   * list of an array literal is split on the boundaries the tokenizer recorded,
   * so `IFS=:` does not merge `a=(x y)` into one element while `a=($V)` with V
   * holding `x:y` still becomes two.
   */
  protected async resolveAssignment(node: AstNodeAssignmentWord, ctx: ExecContextIf): Promise<Assignment | null> {
    const parts = utils.parseAssignmentWord(node.text);

    if (!parts) {
      return null;
    }

    if (parts.list) {
      const { values, status } = await this.resolveArrayElements(node, ctx, parts);

      return { name: parts.name, subscript: parts.subscript, append: parts.append, values, list: true, status };
    }

    const { values, status } = await this.resolveExpansions(node, ctx);
    const text = values[0] ?? '';
    const equals = text.indexOf('=');

    return {
      name: parts.name,
      subscript: parts.subscript,
      append: parts.append,
      values: [equals === -1 ? '' : text.slice(equals + 1)],
      list: false,
      status,
    };
  }

  /**
   * Expand one argument of a declaration command, keeping it a single word.
   *
   * The builtin is handed text, so an element list is handed back with its
   * boundaries still marked and split again on the other side.
   */
  protected async resolveDeclarationArg(node: AstNodeWord, ctx: ExecContextIf, parts: utils.AssignmentParts): Promise<string> {
    if (parts.list) {
      const { values } = await this.resolveArrayElements(node as unknown as AstNodeAssignmentWord, ctx, parts);

      return `${node.text.slice(0, parts.valueStart)}${values.join(utils.ARRAY_ELEMENT_SEPARATOR)})`;
    }

    // An assignment word is quote removed without field splitting
    const { values } = await this.resolveExpansions({ ...node, type: 'AssignmentWord' } as AstNodeAssignmentWord, ctx);

    return values[0] ?? '';
  }

  /**
   * The elements of an array literal, `a=(x "b c" $rest)`.
   */
  protected async resolveArrayElements(
    node: AstNodeAssignmentWord,
    ctx: ExecContextIf,
    parts: utils.AssignmentParts,
  ): Promise<{ values: string[]; status: number }> {
    if (!node.expansion || node.expansion.length === 0) {
      // Quote removal already ran at parse time, gaps and all
      return { values: parts.value === '' ? [] : parts.value.split(utils.ARRAY_ELEMENT_SEPARATOR), status: 0 };
    }

    const { text, protectedRanges, status } = await this.substituteExpansions(node, ctx);
    const inner = text.slice(parts.valueStart, text.length - 1);
    const ifs = this.getIfs(ctx);

    const values: string[] = [];
    let offset = parts.valueStart;

    for (const element of inner.split(utils.ARRAY_ELEMENT_SEPARATOR)) {
      // Runs of blanks in the literal leave empty pieces behind; a genuinely
      // empty element was written as '' or "" and survives quote removal instead
      if (element !== '') {
        const ranges = utils.sliceRanges(protectedRanges, offset, offset + element.length);

        values.push(...utils.unquoteWordWithProtectedRanges(element, ranges, ifs).values);
      }

      offset += element.length + utils.ARRAY_ELEMENT_SEPARATOR.length;
    }

    return { values, status };
  }

  /**
   * Store what resolveAssignment() worked out.
   *
   * @param local - True for a prefix assignment, which only the command it
   *                precedes can see; a bare assignment goes to the shell.
   */
  protected async applyAssignment(assignment: Assignment, ctx: ExecContextIf, local: boolean): Promise<void> {
    const { name, subscript, append, values, list } = assignment;

    if (list) {
      const existing = append ? ctx.getArray(name) ?? [] : [];
      const combined = existing.concat(values);

      if (local) {
        ctx.setLocalArray(name, combined);
        ctx.setLocalParams({ [name]: null });
      } else {
        ctx.setArray(name, combined);
        ctx.setParams({ [name]: null });
      }

      return;
    }

    const value = values[0] ?? '';

    if (subscript !== undefined) {
      const array = ctx.getArray(name);
      const index = await this.resolveIndex(subscript, array?.length ?? 0, ctx);

      ctx.setArrayElement(name, index, append ? (array?.[index] ?? '') + value : value);

      return;
    }

    // A plain assignment to an array name writes element 0 and leaves the rest
    if (ctx.getArray(name)) {
      const previous = append ? ctx.getArray(name)?.[0] ?? '' : '';

      ctx.setArrayElement(name, 0, previous + value);

      return;
    }

    const previous = append ? ctx.getParams()[name] ?? ctx.getEnv()[name] ?? '' : '';

    if (local) {
      ctx.setLocalParams({ [name]: previous + value });
    } else {
      ctx.setParams({ [name]: previous + value });
    }
  }

  /**
   * Split `a[0]` into its name and subscript. A parameter without a subscript
   * keeps its name and gets none — `a` and `a[@]` are different lookups.
   */
  protected splitSubscript(parameter: string | number): { name: string; subscript?: string } {
    // A positional parameter arrives as a number
    const text = String(parameter ?? '');
    const match = text.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.*)\]$/);

    return match ? { name: match[1], subscript: match[2] } : { name: text };
  }

  /**
   * Evaluate an array subscript. It is an arithmetic expression, so `${a[i+1]}`
   * and `a[$i]=x` both work; a negative index counts back from the end.
   */
  protected async resolveIndex(subscript: string, length: number, ctx: ExecContextIf): Promise<number> {
    let index = 0;

    if (/^\s*-?\d+\s*$/.test(subscript)) {
      index = Number(subscript.trim());
    } else {
      try {
        index = await this.evaluateArithmetic(parseArithmetic(subscript.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, '$1')), ctx);
      } catch {
        index = 0;
      }
    }

    return index < 0 ? length + index : index;
  }

  /**
   * The elements of an array, holes skipped. A scalar counts as a single
   * element, which is what makes `${x[@]}` work on an ordinary variable.
   */
  protected arrayElements(name: string, ctx: ExecContextIf, params: Record<string, string>): string[] {
    const array = ctx.getArray(name);

    if (array) {
      return Object.values(array);
    }

    return params[name] !== undefined ? [params[name]] : [];
  }

  /**
   * The value of a parameter, which may name one array element (`a[0]`) or a
   * whole array (`a[@]`, joined for use as a single string).
   */
  protected async parameterValue(parameter: string | number, ctx: ExecContextIf, params: Record<string, string>): Promise<string> {
    const { name, subscript } = this.splitSubscript(parameter);

    if (subscript === undefined) {
      // `$a` on an array is its first element, as in bash
      return params[name] ?? ctx.getArray(name)?.[0] ?? '';
    }

    if (subscript === '@' || subscript === '*') {
      const separator = subscript === '*' ? (this.getIfs(ctx)[0] ?? '') : ' ';

      return this.arrayElements(name, ctx, params).join(separator);
    }

    const array = ctx.getArray(name);
    const index = await this.resolveIndex(subscript, array?.length ?? 1, ctx);

    if (!array) {
      // `${x[0]}` on a scalar is the scalar itself
      return index === 0 ? params[name] ?? '' : '';
    }

    return array[index] ?? '';
  }

  /**
   * Whether a parameter is set, for the `${x-word}` family of operators.
   */
  protected async isParameterSet(parameter: string | number, ctx: ExecContextIf, params: Record<string, string>): Promise<boolean> {
    const { name, subscript } = this.splitSubscript(parameter);

    if (subscript === undefined) {
      return params[name] !== undefined || ctx.getArray(name) !== undefined;
    }

    if (subscript === '@' || subscript === '*') {
      return this.arrayElements(name, ctx, params).length > 0;
    }

    const array = ctx.getArray(name);
    const index = await this.resolveIndex(subscript, array?.length ?? 1, ctx);

    return array ? array[index] !== undefined : index === 0 && params[name] !== undefined;
  }

  /**
   * The positional parameters, in order.
   */
  protected positionalParams(params: Record<string, string>): string[] {
    const count = parseInt(params['#'] || '0', 10);
    const values: string[] = [];

    for (let i = 1; i <= count; i++) {
      if (params[String(i)] !== undefined) {
        values.push(params[String(i)]);
      }
    }

    return values;
  }

  /**
   * Expand a parameter that stands for a list of values, or return null when it
   * is an ordinary scalar.
   *
   * `join: 'field'` means every element becomes its own field, whatever the
   * quoting ($@, ${arr[@]}); `join: 'ifs'` means they are joined on the first
   * character of IFS into one value ($*, ${arr[*]}).
   */
  protected expandListParameter(
    xp: { parameter?: string | number; op?: string; expandWords?: boolean },
    ctx: ExecContextIf,
    params: Record<string, string>,
  ): { values: string[]; join: 'field' | 'ifs' } | null {
    // ${!a[@]} — the indices that are set, not the values
    if (xp.op === 'arrayIndices') {
      const array = ctx.getArray(String(xp.parameter));
      const keys = array ? Object.keys(array) : params[String(xp.parameter)] !== undefined ? ['0'] : [];

      return { values: keys, join: xp.expandWords ? 'field' : 'ifs' };
    }

    if (xp.op) {
      return null;
    }

    if (xp.parameter === '@') {
      return { values: this.positionalParams(params), join: 'field' };
    }

    if (xp.parameter === '*') {
      return { values: this.positionalParams(params), join: 'ifs' };
    }

    const { name, subscript } = this.splitSubscript(xp.parameter ?? '');

    if (subscript === '@' || subscript === '*') {
      return { values: this.arrayElements(name, ctx, params), join: subscript === '@' ? 'field' : 'ifs' };
    }

    return null;
  }

  /**
   * Run every expansion in a word and substitute the results into its text.
   *
   * The regions that came from an expansion are reported as protected ranges:
   * quote removal must not touch them, and field splitting applies to them and
   * nowhere else. Splitting the word into fields is left to the caller, which is
   * what lets an array literal keep its own element boundaries.
   */
  protected async substituteExpansions(
    node: AstNodeWord | AstNodeAssignmentWord,
    ctx: ExecContextIf,
  ): Promise<{ text: string; protectedRanges: ProtectedRange[]; status: number; emptyList: boolean }> {
    const rValue = new utils.ReplaceString(node.text);

    // Exit status of the last command substitution in this word. It is *not* an
    // error channel: an expansion never aborts the word it appears in, it only
    // reports a status the caller may adopt (only a bare assignment does).
    let status = 0;

    // Set when the whole word is a list expansion that turned out to be empty
    let emptyList = false;

    for (const xp of node.expansion) {
      if (xp.resolved) {
        continue;
      }

      if (xp.type === 'ParameterExpansion') {
        const params = {
          ...ctx.getEnv(),
          ...ctx.getParams(),
        };

        // $@ and ${arr[@]} produce one field per element even inside quotes,
        // which a single substituted string cannot express — so the elements go
        // in joined by a marker that the field splitter always breaks on. $* and
        // ${arr[*]} instead join on the first character of IFS.
        const list = this.expandListParameter(xp, ctx, params);

        if (list) {
          const separator = list.join === 'field' ? utils.FIELD_MARKER : (this.getIfs(ctx)[0] ?? '');

          // An empty list in a word of its own expands to no word at all, not to
          // one empty word: `f "$@"` with no arguments passes nothing.
          if (list.values.length === 0 && list.join === 'field') {
            const rest = node.text.slice(0, xp.loc!.start) + node.text.slice(xp.loc!.end + 1);
            if (rest.replace(/"/g, '') === '') {
              emptyList = true;
            }
          }

          rValue.replace(xp.loc!.start, xp.loc!.end + 1, list.values.join(separator));
        } else {
          const xpAny = xp as Record<string, unknown>;
          const paramValue = await this.parameterValue(xp.parameter!, ctx, params);
          const isSet = await this.isParameterSet(xp.parameter!, ctx, params);

          let resolved: string;

          if (xpAny.op === 'stringReplace') {
            const pattern = String(xpAny.substitute ?? '');
            const replacement = String(xpAny.replace ?? '');
            if (xpAny.globally) {
              resolved = paramValue.split(pattern).join(replacement);
            } else {
              const idx = paramValue.indexOf(pattern);
              if (idx === -1) {
                resolved = paramValue;
              } else {
                resolved = paramValue.slice(0, idx) + replacement + paramValue.slice(idx + pattern.length);
              }
            }
          } else if (xpAny.op === 'useDefaultValue') {
            // ${var:-word} — use word if var is unset or empty
            resolved = paramValue || await this.resolveWordValue(xpAny.word, ctx);
          } else if (xpAny.op === 'useDefaultValueIfUnset') {
            // ${var-word} — use word if var is unset
            resolved = isSet ? paramValue : await this.resolveWordValue(xpAny.word, ctx);
          } else if (xpAny.op === 'useAlternativeValue') {
            // ${var:+word} — use word if var is set and non-empty
            resolved = paramValue ? await this.resolveWordValue(xpAny.word, ctx) : '';
          } else if (xpAny.op === 'useAlternativeValueIfUnset') {
            // ${var+word} — use word if var is set
            resolved = isSet ? await this.resolveWordValue(xpAny.word, ctx) : '';
          } else if (xpAny.op === 'stringLength') {
            // ${#var}, and ${#a[@]} for the number of elements
            const { name, subscript } = this.splitSubscript(xp.parameter!);

            resolved = subscript === '@' || subscript === '*' ? String(this.arrayElements(name, ctx, params).length) : String(paramValue.length);
          } else if (xpAny.op === 'removeSmallestSuffixPattern') {
            // ${var%pattern}
            const pattern = await this.resolveWordValue(xpAny.word, ctx);
            resolved = this.removeSuffix(paramValue, pattern, false);
          } else if (xpAny.op === 'removeLargestSuffixPattern') {
            // ${var%%pattern}
            const pattern = await this.resolveWordValue(xpAny.word, ctx);
            resolved = this.removeSuffix(paramValue, pattern, true);
          } else if (xpAny.op === 'removeSmallestPrefixPattern') {
            // ${var#pattern}
            const pattern = await this.resolveWordValue(xpAny.word, ctx);
            resolved = this.removePrefix(paramValue, pattern, false);
          } else if (xpAny.op === 'removeLargestPrefixPattern') {
            // ${var##pattern}
            const pattern = await this.resolveWordValue(xpAny.word, ctx);
            resolved = this.removePrefix(paramValue, pattern, true);
          } else if (xpAny.op === 'substring') {
            // ${var:offset:length}
            const offset = Number(xpAny.offset) || 0;
            const len = xpAny.length != null ? Number(xpAny.length) : undefined;
            resolved = len != null ? paramValue.slice(offset, offset + len) : paramValue.slice(offset);
          } else {
            resolved = paramValue;
          }

          rValue.replace(
            xp.loc!.start,
            xp.loc!.end + 1,
            resolved,
          );
        }
      } else if (xp.type === 'CommandExpansion') {
        // Command substitution runs in a subshell — isolate env/cwd so it can't
        // leak (e.g. `$(export X=1)` must not set X in the calling shell).
        const cmdCtx = ctx.subContext();
        cmdCtx.setLocalEnv({ TERM: '0' });
        cmdCtx.redirectStdout(await this.shell.pipeOpen());

        try {
          const code = await this.executeNode(xp.commandAST, cmdCtx);

          // Send EOF so reads do not block
          await this.shell.pipeClose(cmdCtx.getStdout());

          // A failing substitution still substitutes what it wrote. Bailing out
          // here instead made `for e in $(ls maybe-missing)` abort the enclosing
          // command — and with it the loop around it — instead of iterating over
          // nothing. `exit`/`return` inside `$( )` ends that subshell only, so
          // both are reduced to a plain status as well.
          status = isExitSignal(code) ? getExitCode(code) : isReturnSignal(code) ? getReturnCode(code) : code;

          const output = await this.shell.pipeRead(cmdCtx.getStdout());

          rValue.replace(
            xp.loc!.start,
            xp.loc!.end + 1,
            output.replace(/\n+$/, ''), // Strip trailing newlines for command expansion (POSIX)
          );
        } finally {
          this.shell.pipeRemove(cmdCtx.getStdout()).catch((err) => console.error('Failed to remove pipe from command expansion: ', err));
        }
      } else if (xp.type === 'ArithmeticExpansion') {
        const result = await this.evaluateArithmetic(xp.arithmeticAST, ctx);

        rValue.replace(
          xp.loc!.start,
          xp.loc!.end + 1,
          String(result),
        );
      }
    }

    return { text: rValue.text, protectedRanges: rValue.protectedRanges, status, emptyList };
  }

  protected async resolveExpansions(node: AstNodeWord | AstNodeAssignmentWord, ctx: ExecContextIf): Promise<{ values: string[]; status: number }> {
    if (!node.expansion || node.expansion.length === 0) {
      // Quotes AND escapes are already processed by the parser's quote-removal
      // phase, so node.text is final here. Re-running unescape would wrongly
      // transform literal backslash sequences (e.g. single-quoted '\1' -> 0x01).
      return { values: [node.text], status: 0 };
    }

    const { text: value, protectedRanges, status, emptyList } = await this.substituteExpansions(node, ctx);

    if (emptyList) {
      return { values: [], status };
    }

    const hasPathExpansion = node.expansion.some((xp) => xp.type === 'PathExpansion' && !xp.resolved);

    // POSIX: Assignment values do not undergo field splitting
    if (node.type === 'AssignmentWord') {
      const unquoted = utils.unquoteAssignmentWithProtectedRanges(value, protectedRanges);
      return { values: [unquoted], status };
    }

    // Use unquoteWordWithProtectedRanges to preserve quotes that came from expansions
    // (e.g., JSON content like {"key":"value"} should keep its quotes)
    // This also applies IFS field splitting, to unquoted expansion results only
    const unquotedResult = utils.unquoteWordWithProtectedRanges(value, protectedRanges, this.getIfs(ctx));
    const result = { values: unquotedResult.values, status };

    // Path globbing expansion must be done last
    if (hasPathExpansion && this.shell.resolvePath) {
      const newValues: string[] = [];

      for (const path of result.values) {
        newValues.push(...(await this.shell.resolvePath(ctx, path)));
      }

      result.values = newValues;
    }

    return result;
  }

  private async resolveWordValue(word: unknown, ctx: ExecContextIf): Promise<string> {
    if (!word || typeof word !== 'object') return '';
    const w = word as AstNodeWord;
    if (w.expansion && w.expansion.length > 0) {
      const result = await this.resolveExpansions(w, ctx);
      return result.values.join(' ');
    }
    return w.text ?? '';
  }

  private globToRegexStr(pattern: string): string {
    let regex = '';
    for (const ch of pattern) {
      if (ch === '*') regex += '.*';
      else if (ch === '?') regex += '.';
      else regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return regex;
  }

  private removePrefix(value: string, pattern: string, greedy: boolean): string {
    const re = new RegExp('^' + this.globToRegexStr(pattern) + '$');
    if (greedy) {
      for (let i = value.length; i >= 0; i--) {
        if (re.test(value.slice(0, i))) return value.slice(i);
      }
    } else {
      for (let i = 0; i <= value.length; i++) {
        if (re.test(value.slice(0, i))) return value.slice(i);
      }
    }
    return value;
  }

  private removeSuffix(value: string, pattern: string, greedy: boolean): string {
    const re = new RegExp('^' + this.globToRegexStr(pattern) + '$');
    if (greedy) {
      for (let i = 0; i <= value.length; i++) {
        if (re.test(value.slice(i))) return value.slice(0, i);
      }
    } else {
      for (let i = value.length; i >= 0; i--) {
        if (re.test(value.slice(i))) return value.slice(0, i);
      }
    }
    return value;
  }

  /**
   * Evaluates a arithmetic AST node.
   * @param node - The AST node to evaluate
   * @param ctx - The execution context for variable resolution
   * @returns The numeric result of the arithmetic expression
   */
  protected async evaluateArithmetic(node: AstArithmeticExpression | { type: 'CommandSubstitution'; commandAST: AstNode }, ctx: ExecContextIf): Promise<number> {
    if (!node) {
      return 0;
    }

    switch (node.type) {
      case 'NumericLiteral':
        return node.value;

      case 'Identifier': {
        const params = {
          ...await ctx.getEnv(),
          ...await ctx.getParams(),
        };
        const value = params[node.name] || '0';
        return Number.parseInt(value, 10) || 0;
      }

      case 'UnaryExpression': {
        const arg = await this.evaluateArithmetic(node.argument, ctx);
        switch (node.operator) {
          case '-':
            return -arg;
          case '+':
            return +arg;
          case '!':
            return arg === 0 ? 1 : 0;
          case '~':
            return ~arg;
          default:
            throw new UnsupportedOperatorError((node as unknown as { operator: string }).operator, 'unary', this.getSourceLocation(node), this.currentSource);
        }
      }

      case 'BinaryExpression': {
        const left = await this.evaluateArithmetic(node.left, ctx);
        const right = await this.evaluateArithmetic(node.right, ctx);
        switch (node.operator) {
          case '+':
            return left + right;
          case '-':
            return left - right;
          case '*':
            return left * right;
          case '/':
            return right === 0 ? 0 : Math.trunc(left / right);
          case '%':
            return right === 0 ? 0 : left % right;
          case '**':
            return Math.pow(left, right);
          case '&':
            return left & right;
          case '|':
            return left | right;
          case '^':
            return left ^ right;
          case '<<':
            return left << right;
          case '>>':
            return left >> right;
          case '<':
            return left < right ? 1 : 0;
          case '>':
            return left > right ? 1 : 0;
          case '<=':
            return left <= right ? 1 : 0;
          case '>=':
            return left >= right ? 1 : 0;
          case '==':
            return left === right ? 1 : 0;
          case '!=':
            return left !== right ? 1 : 0;
          default:
            throw new UnsupportedOperatorError((node as unknown as { operator: string }).operator, 'binary', this.getSourceLocation(node), this.currentSource);
        }
      }

      case 'LogicalExpression': {
        const left = await this.evaluateArithmetic(node.left, ctx);
        if (node.operator === '&&') {
          return left === 0 ? 0 : (await this.evaluateArithmetic(node.right, ctx)) === 0 ? 0 : 1;
        } else if (node.operator === '||') {
          return left !== 0 ? 1 : (await this.evaluateArithmetic(node.right, ctx)) !== 0 ? 1 : 0;
        }
        throw new UnsupportedOperatorError(node.operator, 'logical', this.getSourceLocation(node), this.currentSource);
      }

      case 'ConditionalExpression': {
        const test = await this.evaluateArithmetic(node.test, ctx);
        return test !== 0 ? await this.evaluateArithmetic(node.consequent, ctx) : await this.evaluateArithmetic(node.alternate, ctx);
      }

      case 'SequenceExpression': {
        let result = 0;
        for (const expr of node.expressions) {
          result = await this.evaluateArithmetic(expr, ctx);
        }
        return result;
      }

      case 'AssignmentExpression': {
        const varName = node.left.name;
        let value: number;

        if (node.operator === '=') {
          value = await this.evaluateArithmetic(node.right, ctx);
        } else {
          const currentValue = await this.evaluateArithmetic(node.left, ctx);
          const rightValue = await this.evaluateArithmetic(node.right, ctx);
          switch (node.operator) {
            case '+=':
              value = currentValue + rightValue;
              break;
            case '-=':
              value = currentValue - rightValue;
              break;
            case '*=':
              value = currentValue * rightValue;
              break;
            case '/=':
              value = rightValue === 0 ? 0 : Math.trunc(currentValue / rightValue);
              break;
            case '%=':
              value = rightValue === 0 ? 0 : currentValue % rightValue;
              break;
            case '&=':
              value = currentValue & rightValue;
              break;
            case '|=':
              value = currentValue | rightValue;
              break;
            case '^=':
              value = currentValue ^ rightValue;
              break;
            case '<<=':
              value = currentValue << rightValue;
              break;
            case '>>=':
              value = currentValue >> rightValue;
              break;
            default:
              throw new UnsupportedOperatorError((node as unknown as { operator: string }).operator, 'assignment', this.getSourceLocation(node), this.currentSource);
          }
        }

        ctx.setParams({ [varName]: String(value) });
        return value;
      }

      case 'UpdateExpression': {
        const varName = node.argument.name;
        const currentValue = await this.evaluateArithmetic(node.argument, ctx);
        const newValue = node.operator === '++' ? currentValue + 1 : currentValue - 1;
        ctx.setParams({ [varName]: String(newValue) });
        return node.prefix ? newValue : currentValue;
      }

      case 'CommandSubstitution': {
        const cmdNode = node as { type: 'CommandSubstitution'; commandAST: AstNode };
        if (!cmdNode.commandAST) {
          return 0;
        }
        // Command substitution runs in a subshell — isolate env/cwd so it can't
        // leak (e.g. `$(export X=1)` must not set X in the calling shell).
        const cmdCtx = ctx.subContext();
        cmdCtx.setLocalEnv({ TERM: '0' });
        cmdCtx.redirectStdout(await this.shell.pipeOpen());

        try {
          await this.executeNode(cmdNode.commandAST, cmdCtx);
          await this.shell.pipeClose(cmdCtx.getStdout());
          const output = await this.shell.pipeRead(cmdCtx.getStdout());
          const trimmed = output.trim();
          return trimmed === '' ? 0 : Number.parseInt(trimmed, 10) || 0;
        } finally {
          this.shell.pipeRemove(cmdCtx.getStdout()).catch((err) => console.error('Failed to remove pipe from command substitution: ', err));
        }
      }

      default:
        throw new UnsupportedArithmeticNodeError((node as unknown as { type: string }).type, this.getSourceLocation(node), this.currentSource);
    }
  }
}
