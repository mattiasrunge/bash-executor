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

      // Setup piped context
      const cmdCtx = ctx.spawnContext();
      cmdCtx.redirectStdout(stdoutFd);
      cmdCtx.redirectStderr(stderrFd);

      // Execute
      const code = await this.execute(source, cmdCtx);

      // Send EOF so reads do not block
      await this.shell.pipeWrite(stdoutFd, '');
      await this.shell.pipeWrite(stderrFd, '');

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

  protected applyRedirections(ctx: ExecContextIf, redirects?: AstNodeRedirect[]) {
    for (const r of (redirects || [])) {
      if (r.op.text === '<') {
        ctx.redirectStdin(r.file.text);
      } else if (r.op.text === '>') {
        if (r.numberIo?.text === '2') {
          ctx.redirectStderr(r.file.text);
        } else {
          ctx.redirectStdout(r.file.text);
        }
      } else if (r.op.text === '>>') {
        // TODO: Implement append redirection
        if (r.numberIo?.text === '2') {
          ctx.redirectStderr(r.file.text, true);
        } else {
          ctx.redirectStdout(r.file.text, true);
        }
      } else if (r.op.text === '>&') {
        const target = r.file.text;
        const sourceFd = r.numberIo?.text;

        // Check if target is a numeric file descriptor (fd duplication)
        if (/^\d+$/.test(target)) {
          // Get current destination of target fd
          let targetDest: string;
          if (target === '0') {
            targetDest = ctx.getStdin();
          } else if (target === '1') {
            targetDest = ctx.getStdout();
          } else if (target === '2') {
            targetDest = ctx.getStderr();
          } else {
            targetDest = target; // Fallback for unknown fds
          }

          // Redirect source fd to target's destination
          if (sourceFd === '2') {
            ctx.redirectStderr(targetDest);
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
        const [k, v] = value.split('=');
        params[k] = v;
      }
    }
    ctx.setParams(params);

    // There is no command name, nothing to execute
    if (!node?.name) {
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
    this.applyRedirections(ctx, node.suffix?.filter((arg) => arg.type === 'Redirect'));

    // Expand command
    const expandedName = await this.resolveExpansions(node.name, ctx);

    if (expandedName.code !== 0) {
      return expandedName.code;
    }

    // TODO: We can fail for any number of things above, should we apply the bang inversion to those as well?

    const cmdName = expandedName.values[0]; // TODO: Can we expand to more than one value here?
    let code: number;

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
    const ctx = parentCtx.spawnContext();
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
        // Create a new context for the command
        const cmdCtx = ctx.spawnContext();
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
    this.applyRedirections(ctx, node.redirections);

    for (const command of node.commands) {
      const code = await this.executeNode(command, ctx);

      // Propagate exit and return signals immediately
      if (isExitSignal(code) || isReturnSignal(code)) {
        return code;
      }

      if (code !== 0) {
        return code;
      }
    }

    return 0;
  }

  protected async registerFunction(node: AstNodeFunction, parentCtx: ExecContextIf): Promise<number> {
    const ctx = parentCtx.spawnContext();
    this.applyRedirections(ctx, node.redirections);
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
      // Check if any pattern matches
      const matched = caseItem.pattern.some((pattern) => {
        // Expand the pattern
        const patternText = pattern.text;
        // Convert glob pattern to regex
        return this.matchGlobPattern(patternText, clauseValue);
      });

      if (matched) {
        return await this.executeNode(caseItem.body, ctx);
      }
    }

    return 0;
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
      const rightText = await this.expandConditionalWord(node.right, ctx);
      try {
        const regex = new RegExp(rightText);
        return regex.test(left);
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
        const cmdCtx = ctx.spawnContext();
        cmdCtx.setLocalEnv({ TERM: '0' });
        cmdCtx.redirectStdout(await this.shell.pipeOpen());

        try {
          await this.executeNode(xp.commandAST, cmdCtx);
          await this.shell.pipeWrite(cmdCtx.getStdout(), '');
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
        // TODO: Handle kind and op word if needed
        const params = {
          ...ctx.getEnv(),
          ...ctx.getParams(),
        };

        rValue.replace(
          xp.loc!.start,
          xp.loc!.end + 1,
          params[xp.parameter!] || '',
        );
      } else if (xp.type === 'CommandExpansion') {
        const cmdCtx = ctx.spawnContext();
        cmdCtx.setLocalEnv({ TERM: '0' });
        cmdCtx.redirectStdout(await this.shell.pipeOpen());

        try {
          const code = await this.executeNode(xp.commandAST, cmdCtx);

          // Send EOF so reads does not block
          await this.shell.pipeWrite(cmdCtx.getStdout(), '');
          // await this.shell.pipeClose(cmdCtx.getStdout());

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
    const unquotedResult = utils.unquoteWord(value);
    let result = { values: [value], code: 0 };

    if (unquotedResult.values.length > 0) {
      result = { values: unquotedResult.values.map(utils.unescape), code: 0 };
    }

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
        const cmdCtx = ctx.spawnContext();
        cmdCtx.setLocalEnv({ TERM: '0' });
        cmdCtx.redirectStdout(await this.shell.pipeOpen());

        try {
          await this.executeNode(cmdNode.commandAST, cmdCtx);
          await this.shell.pipeWrite(cmdCtx.getStdout(), '');
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
