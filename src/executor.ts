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
  utils,
} from '@ein/bash-parser';
import { getExitCode, getReturnCode, isExitSignal, isReturnSignal } from './builtins/exit.ts';
import type { BuiltinRegistry } from './builtins/types.ts';
import type { ErrorPosition } from './errors.ts';
import { UnknownNodeTypeError, UnsupportedArithmeticNodeError, UnsupportedOperatorError } from './errors.ts';
import type { ExecContextIf, ExecSyncResult, ShellIf } from './types.ts';

const CONTINUE_CODE = -10 as const;
const BREAK_CODE = -11 as const;

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

    try {
      // Create temporary pipes for capturing output
      stdoutFd = await this.shell.pipeOpen();
      stderrFd = await this.shell.pipeOpen();

      // Setup piped context — a subshell, so env/cwd changes (e.g. `export`) the
      // captured command makes stay local and don't leak into the calling shell.
      const cmdCtx = ctx.subContext();
      cmdCtx.redirectStdout(stdoutFd);
      cmdCtx.redirectStderr(stderrFd);

      // Execute
      const code = await this.execute(source, cmdCtx);

      // Send EOF so reads do not block
      await this.shell.pipeClose(stdoutFd);
      await this.shell.pipeClose(stderrFd);

      // Read all output
      const stdout = await this.shell.pipeRead(stdoutFd);
      const stderr = await this.shell.pipeRead(stderrFd);

      return { code, stdout, stderr };
    } catch (err) {
      return {
        code: 1,
        stdout: '',
        stderr: `Error: ${(err as Error).message}\n`,
      };
    } finally {
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
      const { code, values } = await this.resolveExpansions(r.file, ctx);
      const target = code === 0 ? values[0] || r.file.text : r.file.text;

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
    // Handle exec: apply redirections to parent context, ignore args
    if (node.name) {
      const earlyName = await this.resolveExpansions(node.name, parentCtx);
      if (earlyName.code === 0 && earlyName.values[0] === 'exec') {
        const redirects = node.suffix?.filter((arg) => arg.type === 'Redirect') as AstNodeRedirect[] | undefined;
        await this.applyRedirections(parentCtx, redirects);
        return 0;
      }
    }

    // Create an execution context
    const ctx = parentCtx.spawnContext();

    // Update context with prefix assignments
    const params: Record<string, string> = {};

    for (const arg of node.prefix?.filter((arg) => arg.type === 'AssignmentWord') || []) {
      const { values, code } = await this.resolveExpansions(arg, ctx);

      if (code !== 0) {
        // TODO: Print error to stderr?
        return code;
      }

      for (const value of values) {
        const eqIdx = value.indexOf('=');
        if (eqIdx !== -1) {
          params[value.slice(0, eqIdx)] = value.slice(eqIdx + 1);
        }
      }
    }
    // Bare assignments (no command) persist in shell, prefix assignments are scoped to the command
    if (node?.name) {
      ctx.setLocalParams(params);
    } else {
      ctx.setParams(params);
      return 0;
    }

    // Create an args list
    const args: string[] = [];

    for (const arg of node.suffix?.filter((arg) => arg.type === 'Word') || []) {
      const { values, code } = await this.resolveExpansions(arg, ctx);

      if (code !== 0) {
        // TODO: Print error to stderr?
        return code;
      }

      args.push(...values);
    }

    // Apply IO redirections
    await this.applyRedirections(ctx, node.suffix?.filter((arg) => arg.type === 'Redirect'));

    // Expand command
    const expandedName = await this.resolveExpansions(node.name, ctx);

    if (expandedName.code !== 0) {
      return expandedName.code;
    }

    // TODO: We can fail for any number of things above, should we apply the bang inversion to those as well?

    const cmdName = expandedName.values[0]; // TODO: Can we expand to more than one value here?
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
        bridges.push(this.shell.pipeToFile(ctx, stdoutPipe, stdout, stdoutAppend));
        ctx.redirectStdout(stdoutPipe);
      }

      // Handle stderr redirection to file
      const stderr = ctx.getStderr();
      if (!this.shell.isPipe(stderr)) {
        stderrPipe = await this.shell.pipeOpen();
        pipes.push(stderrPipe);
        const stderrAppend = ctx.getStderrAppend();
        bridges.push(this.shell.pipeToFile(ctx, stderrPipe, stderr, stderrAppend));
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
            fileBridges.push(this.shell.pipeToFile(ctx, lastStdoutPipe, stdout, stdoutAppend));
            cmdCtx.redirectStdout(lastStdoutPipe);
            stdoutRedirected = true;
          }
        }

        executions.push(
          this.executeNode(node.commands[n], cmdCtx).finally(() => {
            if (stdoutRedirected) {
              this.shell.pipeClose(cmdCtx.getStdout()).catch((err) => console.error('Failed to close pipe: ', err));
            }
          }),
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

  protected async executeWhile(node: AstNodeWhile, ctx: ExecContextIf): Promise<number> {
    while (await this.executeNode(node.clause, ctx) === 0) {
      const code = await this.executeNode(node.do, ctx);

      if (code === BREAK_CODE) {
        return 0;
      }

      if (code === CONTINUE_CODE) {
        continue;
      }

      // Propagate exit and return signals
      if (isExitSignal(code) || isReturnSignal(code)) {
        return code;
      }

      if (code !== 0) {
        return code;
      }
    }

    return 0;
  }

  protected async executeUntil(node: AstNodeUntil, ctx: ExecContextIf): Promise<number> {
    while (await this.executeNode(node.clause, ctx) !== 0) {
      const code = await this.executeNode(node.do, ctx);

      if (code === BREAK_CODE) {
        return 0;
      }

      if (code === CONTINUE_CODE) {
        continue;
      }

      // Propagate exit and return signals
      if (isExitSignal(code) || isReturnSignal(code)) {
        return code;
      }

      if (code !== 0) {
        return code;
      }
    }

    return 0;
  }

  protected async executeFor(node: AstNodeFor, ctx: ExecContextIf): Promise<number> {
    for (const word of node.wordlist || []) {
      const expanded = await this.resolveExpansions(word, ctx);

      if (expanded.code !== 0) {
        return expanded.code;
      }

      for (const value of expanded.values) {
        ctx.setParams({ [node.name.text]: value });

        const code = await this.executeNode(node.do, ctx);

        if (code === BREAK_CODE) {
          return 0;
        }

        if (code === CONTINUE_CODE) {
          continue;
        }

        // Propagate exit and return signals
        if (isExitSignal(code) || isReturnSignal(code)) {
          return code;
        }

        if (code !== 0) {
          return code;
        }
      }
    }

    return 0;
  }

  protected async executeCase(node: AstNodeCase, ctx: ExecContextIf): Promise<number> {
    // Expand the clause value
    const clauseExpanded = await this.resolveExpansions(node.clause, ctx);
    if (clauseExpanded.code !== 0) {
      return clauseExpanded.code;
    }
    const clauseValue = clauseExpanded.values[0] || '';

    for (const caseItem of node.cases || []) {
      // Check if any pattern matches (patterns undergo expansion and quote
      // removal: quoted characters match literally, unquoted globs are active)
      let matched = false;
      for (const pattern of caseItem.pattern) {
        const { regex, code } = await this.expandCasePattern(pattern, ctx);
        if (code !== 0) {
          return code;
        }
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
  protected async expandCasePattern(word: AstNodeWord, ctx: ExecContextIf): Promise<{ regex: RegExp; code: number }> {
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
      const { values, code } = await this.resolveExpansions(synthetic, ctx);
      if (code !== 0) {
        return { regex: /(?!)/, code };
      }
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
      return { regex: new RegExp(regex), code: 0 };
    } catch {
      // invalid regex (e.g. malformed character class): fall back to exact match
      const literal = [...text].map(escapeRegexChar).join('');
      return { regex: new RegExp(`^${literal}$`), code: 0 };
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
          const rematch: Record<string, string> = {};
          for (let i = 0; i < match.length; i++) {
            rematch[`BASH_REMATCH[${i}]`] = match[i] ?? '';
          }
          ctx.setParams(rematch);
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

  protected async resolveExpansions(node: AstNodeWord | AstNodeAssignmentWord, ctx: ExecContextIf): Promise<{ values: string[]; code: number }> {
    if (!node.expansion || node.expansion.length === 0) {
      let code = 0;
      if (node.type === 'Word') {
        if (node.text === 'continue') {
          code = CONTINUE_CODE;
        } else if (node.text === 'break') {
          code = BREAK_CODE;
        }
      }

      // Process escape sequences even when there are no expansions
      // Note: Don't use unquoteWord here - quotes are already processed by the parser
      return { values: [utils.unescape(node.text)], code };
    }

    const rValue = new utils.ReplaceString(node.text);

    for (const xp of node.expansion) {
      if (xp.resolved) {
        continue;
      }

      if (xp.type === 'ParameterExpansion') {
        const params = {
          ...ctx.getEnv(),
          ...ctx.getParams(),
        };

        // Special handling for $@ - expand to individual positional parameters
        // In bash, "$@" expands to "$1" "$2" ... "$n" (each as a separate word)
        if (xp.parameter === '@' && node.expansion!.length === 1) {
          const count = parseInt(params['#'] || '0', 10);
          const positionalArgs: string[] = [];
          for (let i = 1; i <= count; i++) {
            if (params[String(i)] !== undefined) {
              positionalArgs.push(params[String(i)]);
            }
          }

          // If the word is just "$@" or $@, return args as separate values
          const textWithoutExpansion = node.text.slice(0, xp.loc!.start) + node.text.slice(xp.loc!.end + 1);
          const stripped = textWithoutExpansion.replace(/"/g, '');
          if (stripped === '') {
            return { values: positionalArgs, code: 0 };
          }

          // $@ is part of a larger string, join with space
          rValue.replace(xp.loc!.start, xp.loc!.end + 1, positionalArgs.join(' '));
        } else {
          const xpAny = xp as Record<string, unknown>;
          const paramValue = params[xp.parameter!] ?? '';

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
            resolved = params[xp.parameter!] !== undefined ? paramValue : await this.resolveWordValue(xpAny.word, ctx);
          } else if (xpAny.op === 'useAlternativeValue') {
            // ${var:+word} — use word if var is set and non-empty
            resolved = paramValue ? await this.resolveWordValue(xpAny.word, ctx) : '';
          } else if (xpAny.op === 'useAlternativeValueIfUnset') {
            // ${var+word} — use word if var is set
            resolved = params[xp.parameter!] !== undefined ? await this.resolveWordValue(xpAny.word, ctx) : '';
          } else if (xpAny.op === 'stringLength') {
            // ${#var}
            resolved = String(paramValue.length);
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

          if (code !== 0) {
            return { values: [rValue.text], code };
          }

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

    const hasPathExpansion = node.expansion.some((xp) => xp.type === 'PathExpansion' && !xp.resolved);
    const value = rValue.text;
    const protectedRanges = rValue.protectedRanges;

    // POSIX: Assignment values do not undergo field splitting
    if (node.type === 'AssignmentWord') {
      const unquoted = utils.unquoteAssignmentWithProtectedRanges(value, protectedRanges);
      return { values: [unquoted], code: 0 };
    }

    // Use unquoteWordWithProtectedRanges to preserve quotes that came from expansions
    // (e.g., JSON content like {"key":"value"} should keep its quotes)
    // This also preserves word splitting behavior for unquoted expansions
    const unquotedResult = utils.unquoteWordWithProtectedRanges(value, protectedRanges);
    const result = { values: unquotedResult.values, code: 0 };

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
