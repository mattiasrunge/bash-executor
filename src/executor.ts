import {
  type AstArithmeticExpression,
  type AstConditionalBinaryExpression,
  type AstConditionalExpression,
  type AstConditionalLogicalExpression,
  type AstConditionalUnaryExpression,
  type AstConditionalWord,
  type AstNode,
  type AstNodeArithmeticCommand,
  type AstNodeArithmeticFor,
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
import { getExitCode, getReturnCode, isExitSignal, isReturnSignal, makeExitSignal } from './builtins/exit.ts';
import type { BuiltinRegistry } from './builtins/types.ts';
import type { ErrorPosition } from './errors.ts';
import { NoClobberError, UnboundVariableError, UnknownNodeTypeError, UnsupportedArithmeticNodeError, UnsupportedOperatorError } from './errors.ts';
import type { ExecContextIf, ExecSyncResult, ExecuteAndCaptureOptions, ShellIf } from './types.ts';

// The special parameters, which are set even when nothing has assigned to them
const ALWAYS_SET_PARAMS = new Set(['?', '#', '$', '!', '0', '-', '_', '@', '*']);

// What bash exits with when an expansion fails in a non-interactive shell
const UNBOUND_VARIABLE_CODE = 127 as const;

const CONTINUE_CODE = -10 as const;
const BREAK_CODE = -11 as const;

/**
 * Operators that apply to every element of `${a[@]}` rather than to the elements
 * joined together, and that therefore keep the expansion a list.
 */
const DISTRIBUTING_OPS = new Set([
  'stringReplace',
  'removeSmallestSuffixPattern',
  'removeLargestSuffixPattern',
  'removeSmallestPrefixPattern',
  'removeLargestPrefixPattern',
  'caseChange',
  'substring',
]);

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
 * The process substitutions made while expanding one command's words.
 *
 * `<(cmd)` runs as the word is expanded and its output goes in the file the word
 * became; `>(cmd)` reads that file, so it can only run once the command that
 * writes it has finished. Either way the file is removed afterwards.
 */
type ProcessSubstitutions = {
  paths: string[];
  deferred: { path: string; ast: AstNode }[];
};

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
    // Saved rather than cleared: `eval`/`source` run through here too, and
    // dropping the source on the way out left the script around them with none —
    // no snippet in an error, and nothing for `set -v` to echo
    const previous = this.currentSource;

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
      this.currentSource = previous;
    }
  }

  /**
   * Executes a shell script and captures stdout/stderr.
   * @param {string} source - The shell script source code.
   * @param {ExecContextIf} ctx - The execution context.
   * @returns {Promise<ExecSyncResult>} - The result including exit code, stdout, and stderr.
   */
  public async executeAndCapture(
    source: string,
    ctx: ExecContextIf,
    opts: ExecuteAndCaptureOptions = {},
  ): Promise<ExecSyncResult> {
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
      stdoutRead = handled(this.shell.pipeRead(stdoutFd, opts));
      stderrRead = handled(this.shell.pipeRead(stderrFd, opts));

      // Setup piped context — a subshell, so env/cwd changes (e.g. `export`) the
      // captured command makes stay local and don't leak into the calling shell.
      const cmdCtx = ctx.subContext();
      cmdCtx.setAbortSignal(opts.signal);
      // Capturing is not a terminal: stdout is a pipe here exactly as it is for a
      // pipeline stage or `$( )`, both of which already set this. Without it a
      // command that decorates for a human (colour, syntax highlighting, column
      // layout) does so into the captured string, and the caller parses the escapes.
      cmdCtx.setLocalEnv({ TERM: '0' });
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
      // What the command wrote before it was stopped is the only record of what
      // it was doing — a step killed at its deadline is described by nothing else.
      // Close the pipes so the drains see EOF and hand it over, then append the
      // failure after it the way the command's own last line would have come.
      if (stdoutFd) await this.shell.pipeClose(stdoutFd).catch(() => {});
      if (stderrFd) await this.shell.pipeClose(stderrFd).catch(() => {});
      const stdout = await stdoutRead?.catch(() => '') ?? '';
      const stderr = await stderrRead?.catch(() => '') ?? '';
      return {
        code: 1,
        stdout,
        stderr: `${stderr}Error: ${(err as Error).message}\n`,
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
    const signal = ctx.getAbortSignal();
    if (signal?.aborted) {
      throw signal.reason ?? new Error('execution aborted');
    }

    // `&` on anything but a single command. A single command reaches the shell
    // through `execute`, which takes an `async` option; a list, a group, a
    // subshell or a loop has no such call, and used to run in the foreground
    // instead — silently, with no job to bring back or disown. That is what made
    // a multi-step sweep impossible to detach from the session that started it.
    if (node.async && node.type !== 'Command' && this.shell.executeBackground) {
      return this.executeInBackground(node, ctx);
    }

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
      case 'ArithmeticFor':
        return this.executeArithmeticFor(node as AstNodeArithmeticFor, ctx);
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

  /**
   * Hand a node to the shell to run in the background. The copy clears `async`
   * so that re-entering does the work rather than backgrounding it again.
   */
  private executeInBackground(node: AstNode, ctx: ExecContextIf): Promise<number> {
    const foreground = { ...node, async: false };

    const run = async (bgCtx: ExecContextIf): Promise<number> => {
      const code = await this.executeNode(foreground, bgCtx);

      // A background job is a script in its own right, so an `exit` inside it —
      // or an errexit trip, which is spelled the same way — ends the job and
      // becomes its status. Left encoded, it surfaces as a nonsense exit code
      // like -1001 in whatever records the job's result. This is the same
      // resolution `executeScript` does at the top of a script.
      return isExitSignal(code) ? getExitCode(code) : isReturnSignal(code) ? getReturnCode(code) : code;
    };

    return this.shell.executeBackground!(ctx, run, this.nodeSource(node));
  }

  /** Whether a name runs in this process — a builtin or a shell function — rather than as a command of its own. */
  private isInProcessCommand(name: string, ctx: ExecContextIf): boolean {
    return Boolean(this.builtins?.get(name) || ctx.getFunction(name));
  }

  /**
   * A node's own source text, for the job table to show. Falls back to the node
   * type when the parse carried no location.
   */
  private nodeSource(node: AstNode): string {
    const { start, end } = (node.loc ?? {}) as { start?: { char?: number }; end?: { char?: number } };

    if (!this.currentSource || start?.char === undefined || end?.char === undefined) {
      return node.type;
    }

    return this.currentSource.slice(start.char, end.char + 1).trim();
  }

  /**
   * Apply a command's redirections to its context.
   *
   * @param subs - Collects the process substitutions in the redirection targets,
   *               `cmd > >(other)`
   * @returns The pipes opened on the command's behalf — a here-string has no
   *          file behind it, so the caller has to remove them when the command
   *          is done.
   */
  protected async applyRedirections(ctx: ExecContextIf, redirects?: AstNodeRedirect[], subs?: ProcessSubstitutions): Promise<string[]> {
    const temporary: string[] = [];

    for (const r of (redirects || [])) {
      const { values } = await this.resolveExpansions(r.file, ctx, subs);
      const target = values[0] || r.file.text;

      if (r.heredoc) {
        // A here-document: its text, expanded unless the delimiter was quoted, fed in as stdin the
        // way a here-string is.
        const text = r.heredoc.quoted ? r.heredoc.body : await this.expandHereDocument(r.heredoc.body, ctx);
        const pipe = await this.shell.pipeOpen();

        temporary.push(pipe);
        handled(this.shell.pipeWrite(pipe, text).then(() => this.shell.pipeClose(pipe)));
        ctx.redirectStdin(pipe);
      } else if (r.op.text === '<') {
        ctx.redirectStdin(target);
      } else if (r.op.text === '<<<') {
        // A here-string is the word plus a newline, fed in as stdin. The write
        // is detached: a string larger than the pipe holds only completes once
        // the command starts reading, which it cannot do until this returns.
        const pipe = await this.shell.pipeOpen();

        temporary.push(pipe);
        handled(this.shell.pipeWrite(pipe, `${target}\n`).then(() => this.shell.pipeClose(pipe)));
        ctx.redirectStdin(pipe);
      } else if (r.op.text === '>' || r.op.text === '>|') {
        // `set -C` refuses to truncate a file that exists; `>|` says do it anyway
        if (r.op.text === '>') {
          await this.assertClobberable(ctx, target);
        }

        this.redirectOutput(ctx, r.numberIo?.text, target, false);
      } else if (r.op.text === '>>') {
        this.redirectOutput(ctx, r.numberIo?.text, target, true);
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

    return temporary;
  }

  /**
   * `exec N>file`, `exec >>file`, `exec <file`: the file is opened once and
   * stays open for everything after, so each command appends where the last one
   * stopped — the path itself would be reopened, and truncated, by every
   * command. A descriptor above 2 is opened under its own number, which is what
   * `>&3` and `read -u 3` look up; 0–1–2 are the host's own, so those point at a
   * handle the host names.
   *
   * @returns false when this is not such a redirection, or the host cannot open
   *          files, so the caller applies it the ordinary way
   */
  private async openExecRedirection(ctx: ExecContextIf, r: AstNodeRedirect): Promise<boolean> {
    const modes: Record<string, string> = { '>': 'w+', '>|': 'w+', '>>': 'a+', '<': 'r' };
    const mode = modes[r.op.text];

    if (!this.shell.fdOpen || !mode || r.heredoc) {
      return false;
    }

    const fd = r.numberIo?.text ?? (r.op.text === '<' ? '0' : '1');
    const { values } = await this.resolveExpansions(r.file, ctx);
    const target = values[0] || r.file.text;

    if (r.op.text === '>') {
      await this.assertClobberable(ctx, target);
    }

    if (Number(fd) > 2) {
      await this.shell.fdClose?.(fd);
      await this.shell.fdOpen(ctx, target, mode, fd);
      ctx.closeFd(fd);
    } else {
      ctx.redirectFd(fd, await this.shell.fdOpen(ctx, target, mode));
    }

    return true;
  }

  /**
   * `N>file` for one command. Descriptors above 2 are kept on the shell's root
   * context, so this one outlives the command — later `>&N` still reaches the
   * file where bash would call it a bad descriptor — which is the lesser fault
   * next to writing the command's stdout there instead.
   */
  private redirectOutput(ctx: ExecContextIf, fd: string | undefined, target: string, append: boolean): void {
    if (fd === '2') {
      ctx.redirectStderr(target, append);
    } else if (fd === undefined || fd === '1') {
      ctx.redirectStdout(target, append);
    } else {
      ctx.redirectFd(fd, target);
    }
  }

  /**
   * `set -C`: `>` must not truncate a file that is already there.
   *
   * Whether it is there is the host's to answer, through the optional `testPath`
   * callback — a shell that does not provide one cannot refuse, and the redirect
   * goes through rather than failing on a question nobody could answer.
   */
  protected async assertClobberable(ctx: ExecContextIf, target: string): Promise<void> {
    if (!ctx.getShellOption('noclobber') || !this.shell.testPath) {
      return;
    }

    if (await this.shell.testPath(ctx, target, 'EXISTS').catch(() => false)) {
      throw new NoClobberError(target);
    }
  }

  protected async executeScript(node: AstNodeScript, ctx: ExecContextIf): Promise<number> {
    try {
      return await this.runScriptCommands(node, ctx);
    } catch (err) {
      // An unset parameter under `set -u` ends this shell, and a command
      // substitution is a shell of its own — it parses to its own Script, so
      // catching here is what lets `$(echo "$NOPE")` die while the shell around
      // it carries on, which is what bash does.
      if (!(err instanceof UnboundVariableError)) {
        throw err;
      }

      await this.shell.pipeWrite(ctx.getStderr(), `${err.message}\n`).catch(() => {});

      // Measured: bash leaves 127 behind for an expansion error, but under
      // `set -e` the shell goes out through errexit with the command's own 1
      const code = ctx.getShellOption('errexit') ? 1 : UNBOUND_VARIABLE_CODE;

      ctx.setParams({ '?': String(code) });

      return code;
    }
  }

  private async runScriptCommands(node: AstNodeScript, ctx: ExecContextIf): Promise<number> {
    let lastCode = 0;

    for (const command of node.commands) {
      await this.echoSource(command, ctx);

      // `set -n` reads the rest without running it. There is no turning it back
      // off from inside the script — bash cannot either, for the same reason.
      if (ctx.getShellOption('noexec')) {
        return lastCode;
      }

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
    try {
      return await this.runCommand(node, parentCtx);
    } catch (err) {
      // `set -C` refusing a redirection fails this command and nothing else —
      // the shell carries on, and errexit gets its say like any other failure
      return await this.noClobberStatus(err, parentCtx);
    }
  }

  private async runCommand(node: AstNodeCommand, parentCtx: ExecContextIf): Promise<number> {
    // Handle exec: apply redirections to parent context, ignore args.
    // Only a literal `exec` counts. Expanding the name here as well as below ran
    // every command substitution in it twice — `$(pick-a-command) arg` executed
    // `pick-a-command` two times, side effects included.
    if (node.name && !node.name.expansion?.length && node.name.text === 'exec') {
      const redirects = node.suffix?.filter((arg) => arg.type === 'Redirect') as AstNodeRedirect[] | undefined;

      for (const redirect of redirects ?? []) {
        if (!(await this.openExecRedirection(parentCtx, redirect))) {
          await this.applyRedirections(parentCtx, [redirect]);
        }
      }

      return 0;
    }

    // `&` on a builtin or a function. Only the external branch below hands
    // `async` to the shell; a builtin and a function run in this process and
    // ignored it, so `source sweep.sh &` ran in the foreground and left no job
    // behind to disown. Caught here, before any expansion, so the work is done
    // once and in the background context. A name that has to be expanded before
    // we know what it is (`$cmd &`) still takes the old path, for the same
    // reason `exec` above only matches a literal: expanding it twice would run
    // its command substitutions twice.
    if (node.async && this.shell.executeBackground && node.name && !node.name.expansion?.length && this.isInProcessCommand(node.name.text, parentCtx)) {
      return this.executeInBackground(node, parentCtx);
    }

    // Create an execution context
    const ctx = parentCtx.spawnContext();

    // `! cmd` is exempt from errexit, and so is anything cmd calls
    if (node.bang) {
      ctx.setErrexitSuppressed(true);
    }

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
      await this.trace(parentCtx, this.traceAssignment(assignment));
      await this.applyAssignment(assignment, ctx, Boolean(node?.name));
    }

    if (!node?.name) {
      return this.applyErrexit(assignStatus, ctx);
    }

    // Create an args list
    const args: string[] = [];

    // `cat <(cmd)` — the substituted commands and the files standing in for them
    const subs: ProcessSubstitutions = { paths: [], deferred: [] };

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

      const { values } = await this.resolveExpansions(arg, ctx, subs);

      args.push(...values);
    }

    // Apply IO redirections
    const redirectPipes = await this.applyRedirections(ctx, node.suffix?.filter((arg) => arg.type === 'Redirect'), subs);

    // Expand command
    const expandedName = await this.resolveExpansions(node.name, ctx);

    // TODO: We can fail for any number of things above, should we apply the bang inversion to those as well?

    const cmdName = expandedName.values[0]; // TODO: Can we expand to more than one value here?

    await this.trace(parentCtx, [cmdName, ...(args || [])].map((word) => this.quoteForTrace(word)).join(' '));

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

      // A one-command pipeline is unwrapped by the parser and never reaches
      // executePipeline, so a plain command records its own PIPESTATUS here. It
      // holds the raw status: bash gives `! false` a PIPESTATUS of (1) and a $? of 0.
      if (!isExitSignal(code) && !isReturnSignal(code)) {
        ctx.setArray('PIPESTATUS', [String(code)]);
      }

      return this.applyErrexit(node.bang ? (code === 0 ? 1 : 0) : code, ctx);
    }, redirectPipes).finally(() => this.finishProcessSubstitutions(subs, ctx));
  }

  /**
   * Run the `>(cmd)` substitutions of a finished command and drop their files.
   */
  protected async finishProcessSubstitutions(subs: ProcessSubstitutions, ctx: ExecContextIf): Promise<void> {
    for (const { path, ast } of subs.deferred) {
      const cmdCtx = ctx.subContext();

      cmdCtx.redirectStdin(path);

      await this.withFileBridging(cmdCtx, () => this.executeNode(ast, cmdCtx)).catch(() => {});
    }

    for (const path of subs.paths) {
      await this.shell.removeTempFile?.(ctx, path).catch(() => {});
    }
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

    // Where a function was *defined* says nothing about errexit; where it is
    // called says everything. `if f; then` has to exempt what f runs, and a
    // function that happened to be defined inside an `if` clause must not be
    // exempt for ever after — so the call site's answer is set either way.
    fnCtx.setErrexitSuppressed(ctx.getErrexitSuppressed());

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
    const code = await this.withFileBridging(ctx, () => {
      return this.executeNode(node.list, ctx);
    });

    // To the caller the subshell is one command, so it leaves one status behind —
    // the array its own pipelines built lives and dies with the subshell's context.
    if (!isExitSignal(code) && !isReturnSignal(code)) {
      parentCtx.setArray('PIPESTATUS', [String(code)]);
    }

    return this.applyErrexit(code, parentCtx);
  }

  /**
   * Wraps command execution with file-to-pipe bridging.
   * If stdin/stdout/stderr in the context are file paths (not pipes),
   * this creates bridging pipes and handles streaming data between files and pipes.
   * @param ctx - The execution context with possible file redirections
   * @param fn - The function to execute with bridged I/O
   * @param extraPipes - Pipes the caller opened for this command (here-strings),
   *                     removed together with the bridging ones
   * @returns The exit code from the function
   */
  private async withFileBridging(ctx: ExecContextIf, fn: () => Promise<number>, extraPipes: string[] = []): Promise<number> {
    const pipes: string[] = [...extraPipes];
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

  /**
   * Run a `$( )` and hand back what it printed.
   *
   * The substitution runs in a subshell — env/cwd are isolated so
   * `$(export X=1)` cannot set X in the calling shell — and as its own shell:
   * bash runs `$(false; echo hi)` to the end under `set -e` and hands back what
   * it printed.
   *
   * The pipe is drained *while* the command runs, not after it. A pipe has a
   * fixed capacity, and a writer that fills it blocks until someone reads;
   * reading only once the command had returned meant the command never
   * returned, so any substitution larger than the capacity — a `find` over a
   * corpus, say — hung the shell for good.
   */
  private async substitute(commandAST: AstNode, ctx: ExecContextIf): Promise<{ code: number; output: string }> {
    const cmdCtx = ctx.subContext();
    cmdCtx.setLocalEnv({ TERM: '0' });
    cmdCtx.setErrexitSuppressed(true);
    const pipe = await this.shell.pipeOpen();
    cmdCtx.redirectStdout(pipe);

    const read = handled(this.shell.pipeRead(pipe));

    try {
      const code = await this.executeNode(commandAST, cmdCtx);

      // EOF, so the drain finishes
      await this.shell.pipeClose(pipe);

      return { code, output: await read };
    } finally {
      // Settle the drain before removing the pipe, on the error path too
      await this.shell.pipeClose(pipe).catch(() => {});
      await read.catch(() => {});
      await this.shell.pipeRemove(pipe).catch((err) => console.error('Failed to remove pipe from command substitution: ', err));
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

        // A stage failing is the pipeline's business, not the shell's: errexit
        // looks at what finishPipeline makes of them all
        cmdCtx.setErrexitSuppressed(true);

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

      return this.finishPipeline(node, codes, ctx);
    } finally {
      for (const pipe of pipes) {
        this.shell.pipeRemove(pipe).catch((err) => console.error('Failed to remove pipe: ', err));
      }
    }
  }

  /**
   * Turn the stage codes of a finished pipeline into `PIPESTATUS` and the
   * pipeline's own exit status.
   *
   * Without `pipefail` the status is the last stage's, with it the rightmost
   * non-zero one — and `!` inverts whatever comes out. An exit or return signal
   * from the last stage is control flow rather than a status, so it propagates
   * untouched; one from an earlier stage stays swallowed, because in bash that
   * stage is a subshell of its own and its `exit` never reaches the caller.
   */
  protected finishPipeline(node: AstNodePipeline, codes: number[], ctx: ExecContextIf): number {
    // `break`/`continue` are not statuses at all, and in bash a stage is a subshell
    // the loop control cannot reach out of — so they count as 0 rather than as a
    // failure pipefail would pick up.
    const statuses = codes.map((code) => {
      if (isExitSignal(code)) {
        return getExitCode(code);
      }

      if (isReturnSignal(code)) {
        return getReturnCode(code);
      }

      return code === BREAK_CODE || code === CONTINUE_CODE ? 0 : code;
    });

    ctx.setArray('PIPESTATUS', statuses.map((status) => String(status)));

    const lastCode = codes[codes.length - 1];

    if (isExitSignal(lastCode) || isReturnSignal(lastCode) || lastCode === BREAK_CODE || lastCode === CONTINUE_CODE) {
      return lastCode;
    }

    let code = statuses[statuses.length - 1];

    if (ctx.getShellOption('pipefail')) {
      const failed = statuses.findLast((status) => status !== 0);

      code = failed ?? 0;
    }

    return this.applyErrexit(node.bang ? (code === 0 ? 1 : 0) : code, ctx);
  }

  /**
   * Apply `errexit` to a command's status.
   *
   * `set -e` is decided per command, where the command runs — never on an
   * assembled status further up. `false && echo t` fails and does not end the
   * shell because nothing after the final `&&` ever ran, and the same status
   * reaching `executeScript` says nothing about which command produced it. So
   * every place that runs one thing and gets a status back asks this, and a
   * context that is exempt (an `if` clause, `!`, the left of `&&`, a pipeline
   * stage) answers for everything it called, functions included.
   */
  protected applyErrexit(code: number, ctx: ExecContextIf): number {
    if (code === 0 || isExitSignal(code) || isReturnSignal(code) || code === BREAK_CODE || code === CONTINUE_CODE) {
      return code;
    }

    if (!ctx.getShellOption('errexit') || ctx.getErrexitSuppressed()) {
      return code;
    }

    return makeExitSignal(code);
  }

  /**
   * `set -x`: write what is about to run to the shell's stderr.
   *
   * The trace goes to the stderr the *shell* has, not the one the command is
   * about to be given — `echo hi 2>/dev/null` still traces in bash, while
   * `exec 2>/dev/null` silences it, and passing the pre-redirection context here
   * is what reproduces that. A target that is a file rather than a pipe is
   * skipped rather than made to work: the trace is a diagnostic, not output.
   */
  protected async trace(ctx: ExecContextIf, line: string): Promise<void> {
    if (!ctx.getShellOption('xtrace')) {
      return;
    }

    const params = ctx.getParams();
    const ps4 = params.PS4 ?? ctx.getEnv().PS4 ?? '+ ';

    await this.shell.pipeWrite(ctx.getStderr(), `${ps4}${line}\n`).catch(() => {});
  }

  /**
   * `set -v`: echo the source of what is about to run to stderr.
   *
   * bash prints input lines as its parser reads them, which a parse-then-execute
   * model cannot reproduce — by the time anything runs here the whole script has
   * been read. So this prints each command's own source instead, which is the
   * same text in the same order, just at a different moment. A node without a
   * location (nothing to quote) prints nothing.
   */
  protected async echoSource(node: AstNode, ctx: ExecContextIf): Promise<void> {
    if (!ctx.getShellOption('verbose') || !this.currentSource) {
      return;
    }

    const { start, end } = (node.loc ?? {}) as { start?: { char?: number }; end?: { char?: number } };

    if (start?.char === undefined || end?.char === undefined) {
      return;
    }

    await this.shell.pipeWrite(ctx.getStderr(), `${this.currentSource.slice(start.char, end.char + 1)}\n`).catch(() => {});
  }

  /**
   * Quote a word the way bash quotes it in a trace: only when it needs it.
   */
  protected quoteForTrace(value: string): string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  }

  /**
   * The `name=value` a trace shows for an assignment, array literals included.
   */
  protected traceAssignment(assignment: Assignment): string {
    const { name, subscript, append, values, list } = assignment;
    const target = subscript === undefined ? name : `${name}[${subscript}]`;
    const operator = append ? '+=' : '=';
    const value = list ? `(${values.map((v) => this.quoteForTrace(v)).join(' ')})` : this.quoteForTrace(values[0] ?? '');

    return `${target}${operator}${value}`;
  }

  /**
   * The status a command takes when `set -C` refused one of its redirections:
   * 1, with the reason on stderr, and the shell carries on. Rethrows anything
   * else.
   */
  protected async noClobberStatus(err: unknown, ctx: ExecContextIf): Promise<number> {
    if (!(err instanceof NoClobberError)) {
      throw err;
    }

    await this.shell.pipeWrite(ctx.getStderr(), `${err.message}\n`).catch(() => {});

    return this.applyErrexit(1, ctx);
  }

  /**
   * A child context that `errexit` does not end the shell from — for the parts
   * of a command bash exempts.
   */
  protected exemptContext(ctx: ExecContextIf): ExecContextIf {
    const exempt = ctx.spawnContext();

    exempt.setErrexitSuppressed(true);

    return exempt;
  }

  protected async executeCompondList(node: AstNodeCompoundList, parentCtx: ExecContextIf): Promise<number> {
    const ctx = parentCtx.spawnContext();
    const subs: ProcessSubstitutions = { paths: [], deferred: [] };
    let redirectPipes: string[];

    try {
      redirectPipes = await this.applyRedirections(ctx, node.redirections, subs);
    } catch (err) {
      return await this.noClobberStatus(err, parentCtx);
    }

    let lastCode = 0;

    try {
      for (const command of node.commands) {
        await this.echoSource(command, ctx);

        if (ctx.getShellOption('noexec')) {
          return lastCode;
        }

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
    } finally {
      await this.finishProcessSubstitutions(subs, ctx);

      for (const pipe of redirectPipes) {
        await this.shell.pipeRemove(pipe).catch(() => {});
      }
    }
  }

  protected async registerFunction(node: AstNodeFunction, parentCtx: ExecContextIf): Promise<number> {
    const ctx = parentCtx.spawnContext();
    await this.applyRedirections(ctx, node.redirections);
    parentCtx.setFunction(node.name.text, node.body, ctx);

    return 0;
  }

  /**
   * Run a compound command with its own redirections applied.
   *
   * `while read l; do …; done < file` redirects the whole loop, not the command
   * inside it, so stdin has to be in place for every iteration and the pipes
   * only go away once the loop is done.
   */
  private async withCompoundRedirections<T extends { redirections?: AstNodeRedirect[] }>(
    node: T,
    parentCtx: ExecContextIf,
    fn: (ctx: ExecContextIf) => Promise<number>,
  ): Promise<number> {
    if (!node.redirections || node.redirections.length === 0) {
      return fn(parentCtx);
    }

    const ctx = parentCtx.spawnContext();
    const subs: ProcessSubstitutions = { paths: [], deferred: [] };
    let redirectPipes: string[];

    try {
      redirectPipes = await this.applyRedirections(ctx, node.redirections, subs);
    } catch (err) {
      return await this.noClobberStatus(err, parentCtx);
    }

    try {
      return await this.withFileBridging(ctx, () => fn(ctx), redirectPipes);
    } finally {
      await this.finishProcessSubstitutions(subs, ctx);

      for (const pipe of redirectPipes) {
        await this.shell.pipeRemove(pipe).catch(() => {});
      }
    }
  }

  protected async executeIf(node: AstNodeIf, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
      if (await this.executeNode(node.clause, this.exemptContext(ctx)) === 0) {
        return await this.executeNode(node.then, ctx);
      } else if (node.else) {
        return await this.executeNode(node.else, ctx);
      }

      return 0;
    });
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

  protected async executeWhile(node: AstNodeWhile, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
      let last = 0;

      while (await this.executeNode(node.clause, this.exemptContext(ctx)) === 0) {
        const { stop, code } = await this.runLoopBody(node.do, ctx);
        last = code;

        if (stop) {
          return code;
        }
      }

      return last;
    });
  }

  protected async executeUntil(node: AstNodeUntil, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
      let last = 0;

      while (await this.executeNode(node.clause, this.exemptContext(ctx)) !== 0) {
        const { stop, code } = await this.runLoopBody(node.do, ctx);
        last = code;

        if (stop) {
          return code;
        }
      }

      return last;
    });
  }

  protected async executeFor(node: AstNodeFor, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
      // The whole word list is expanded once, before the first iteration, so the
      // body cannot change what is still to be iterated over.
      const values: string[] = [];

      for (const word of node.wordlist || []) {
        const expanded = await this.resolveExpansions(word, ctx);

        values.push(...expanded.values);
      }

      const traceLine = `for ${node.name.text} in ${values.map((v) => this.quoteForTrace(v)).join(' ')}`;

      let last = 0;

      for (const value of values) {
        // bash repeats the `for` line once per iteration, not once per loop
        await this.trace(ctx, traceLine);

        ctx.setParams({ [node.name.text]: value });

        const { stop, code } = await this.runLoopBody(node.do, ctx);
        last = code;

        if (stop) {
          return code;
        }
      }

      return last;
    });
  }

  /**
   * `for (( init; test; update ))`: `init` once, then the body while `test` is non-zero, `update`
   * after each pass — `continue` included. A missing `test` is true, as in bash, so `for ((;;))`
   * runs until something breaks out of it.
   */
  protected async executeArithmeticFor(node: AstNodeArithmeticFor, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
      if (node.init) await this.evaluateArithmetic(node.init.arithmeticAST, ctx);

      let last = 0;

      while (!node.test || await this.evaluateArithmetic(node.test.arithmeticAST, ctx) !== 0) {
        const { stop, code } = await this.runLoopBody(node.do, ctx);
        last = code;

        if (stop) {
          return code;
        }

        if (node.update) await this.evaluateArithmetic(node.update.arithmeticAST, ctx);
      }

      return last;
    });
  }

  protected async executeCase(node: AstNodeCase, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
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
    });
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
          const bracket = this.translateBracketExpression(s, i);
          if (bracket) {
            out += bracket.source;
            i = bracket.end;
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
        const bracket = this.translateBracketExpression(text, i);
        if (bracket) {
          regex += bracket.source;
          i = bracket.end;
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
   * Translate a shell bracket expression to a JavaScript character class.
   *
   * `pattern[open]` must be the `[`. Returns the emitted regex source and the index of
   * the closing `]`, or `undefined` when the bracket is unterminated — the caller then
   * treats the `[` as a literal, which is what bash does.
   *
   * The reason this exists rather than copying `[...]` through verbatim: shell and
   * JavaScript spell negation differently. POSIX globs negate with `[!...]`, JS regex only
   * understands `[^...]`, so a copied `[!0-9]` becomes "a `!` or a digit" — the exact
   * inverse of what was written, silently. `[^...]` happened to work because bash accepts
   * that spelling too, which is what kept the bug hidden.
   *
   * Also handled here: a `]` immediately after the `[` (or after the negation) is a literal
   * `]` and does not close the expression, so the naive `indexOf(']')` search terminated
   * `[]]` at the wrong place and produced an empty, invalid class.
   */
  protected translateBracketExpression(pattern: string, open: number): { source: string; end: number } | undefined {
    let i = open + 1;
    let out = '[';

    if (pattern[i] === '!' || pattern[i] === '^') {
      out += '^';
      i++;
    }

    // A leading `]` is data, not the terminator.
    if (pattern[i] === ']') {
      out += '\\]';
      i++;
    }

    for (; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === ']') {
        return { source: out + ']', end: i };
      }
      // `\` and `[` are the two characters that change meaning inside a JS class.
      out += c === '\\' || c === '[' ? `\\${c}` : c;
    }

    return undefined;
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
          const bracket = this.translateBracketExpression(pattern, i);
          if (bracket) {
            regex += bracket.source;
            i = bracket.end;
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
    // Only the command following the final && or || is subject to errexit, so
    // the left side is exempt however deep it goes; the right side runs as-is
    const left = await this.executeNode(node.left, this.exemptContext(ctx));

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
    return this.applyErrexit(result !== 0 ? 0 : 1, ctx);
  }

  /**
   * Executes a [[ conditional ]] command.
   * Returns 0 if the condition is true, 1 if false.
   */
  protected async executeConditionalCommand(node: AstNodeConditionalCommand, ctx: ExecContextIf): Promise<number> {
    const result = await this.evaluateConditionalExpression(node.conditionAST, ctx);
    return this.applyErrexit(result ? 0 : 1, ctx);
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
        const { output } = await this.substitute(xp.commandAST, ctx);
        rValue.replace(xp.loc!.start, xp.loc!.end + 1, output.trimEnd());
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
   * Split an element written as `[key]=value`, or return null for a plain one.
   */
  protected keyedElement(element: string): { key: string; value: string } | null {
    const match = element.match(/^\[([^\]]*)\]=(.*)$/s);

    return match ? { key: match[1], value: match[2] } : null;
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
      // `a=([k]=v …)` on an associative array, and `a=([2]=x)` on an indexed one
      if (ctx.getAssoc(name)) {
        const entries = append ? { ...ctx.getAssoc(name) } : {};

        for (const element of values) {
          const keyed = this.keyedElement(element);

          if (keyed) {
            entries[keyed.key] = keyed.value;
          }
        }

        if (local) {
          ctx.setLocalAssoc(name, entries);
        } else {
          ctx.setAssoc(name, entries);
        }

        return;
      }

      const existing = append ? (ctx.getArray(name) ?? []).slice() : [];

      for (const element of values) {
        const keyed = this.keyedElement(element);

        if (keyed) {
          existing[await this.resolveIndex(keyed.key, existing.length, ctx)] = keyed.value;
        } else {
          existing.push(element);
        }
      }

      if (local) {
        ctx.setLocalArray(name, existing);
        ctx.setLocalParams({ [name]: null });
      } else {
        ctx.setArray(name, existing);
        ctx.setParams({ [name]: null });
      }

      return;
    }

    const value = values[0] ?? '';

    if (subscript !== undefined && ctx.getAssoc(name)) {
      const assoc = ctx.getAssoc(name)!;
      const key = await this.expandSubscript(subscript, ctx);
      const element = append ? (assoc[key] ?? '') + value : value;

      if (local) {
        ctx.setLocalAssoc(name, { ...assoc, [key]: element });
      } else {
        ctx.setAssocElement(name, key, element);
      }

      return;
    }

    if (subscript !== undefined) {
      const array = ctx.getArray(name);
      const index = await this.resolveIndex(subscript, array?.length ?? 0, ctx);
      const element = append ? (array?.[index] ?? '') + value : value;

      if (local) {
        // A prefix assignment is scoped to the command it precedes, so the array
        // is copied rather than written through to wherever it lives
        const copy = (array ?? []).slice();

        copy[index] = element;
        ctx.setLocalArray(name, copy);

        return;
      }

      ctx.setArrayElement(name, index, element);

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
    } else if (ctx.getShellOption('allexport')) {
      // `set -a` makes a plain assignment an exported one, so a child sees it
      ctx.setEnv({ [name]: previous + value });
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
   * Run one process substitution and return the path standing in for it.
   *
   * The shell decides what that path is; without the callback there is no way to
   * hand a command something it can open, so `<(…)` is an error rather than a
   * path that will not work.
   */
  protected async substituteProcess(
    xp: { direction?: 'in' | 'out'; commandAST?: AstNode; command?: string },
    ctx: ExecContextIf,
    subs?: ProcessSubstitutions,
  ): Promise<string> {
    if (!this.shell.tempFile) {
      throw new Error(`process substitution is not supported by this shell: ${xp.direction === 'out' ? '>' : '<'}(${xp.command ?? ''})`);
    }

    const path = await this.shell.tempFile(ctx);

    subs?.paths.push(path);

    if (xp.direction === 'out') {
      // The command reads what the word's own command writes, so it runs after it
      subs?.deferred.push({ path, ast: xp.commandAST! });

      return path;
    }

    // A subshell: what it writes goes to the file, and nothing it sets leaks out
    const cmdCtx = ctx.subContext();

    cmdCtx.setErrexitSuppressed(true);
    cmdCtx.redirectStdout(path);

    await this.withFileBridging(cmdCtx, () => this.executeNode(xp.commandAST!, cmdCtx));

    return path;
  }

  /**
   * The text of an unquoted here-document, expanded: `$name`, `${…}`, `$(…)`, `` `…` `` and
   * `$((…))` apply, and a backslash escapes only `$`, `` ` ``, `\` and a newline — which is
   * double-quote expansion, except that a `"` in the body is an ordinary character. So the body is
   * put in double quotes with its own `"` escaped (outside command substitutions, whose quotes
   * are their own) and expanded as one word, without field splitting or globbing.
   */
  protected async expandHereDocument(body: string, ctx: ExecContextIf): Promise<string> {
    if (!/[$`\\]/.test(body)) {
      return body;
    }

    let quoted = '"';
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      const char = body[i];
      const next = body[i + 1];
      if (depth === 0 && char === '\\' && next === '"') {
        // A literal backslash and quote, which in double quotes are written \\\"
        quoted += '\\\\\\"';
        i++;
      } else if (char === '\\' && next !== undefined) {
        quoted += char + next;
        i++;
      } else if (char === '$' && next === '(') {
        depth++;
        quoted += '$(';
        i++;
      } else if (depth > 0 && char === '(') {
        depth++;
        quoted += char;
      } else if (depth > 0 && char === ')') {
        depth--;
        quoted += char;
      } else if (depth === 0 && char === '"') {
        quoted += '\\"';
      } else {
        quoted += char;
      }
    }
    quoted += '"';

    const ast = await parse(quoted, { mode: 'word-expansion' });
    const word = (ast.commands[0] as AstNodeCommand).name;

    if (!word) {
      return body;
    }

    const { values } = await this.resolveExpansions({ ...word, type: 'AssignmentWord' } as AstNodeAssignmentWord, ctx);

    return values[0] ?? '';
  }

  /**
   * Expand a subscript used as a key, `${m[$k]}`.
   *
   * An index goes through the arithmetic evaluator, which resolves `$k` on its
   * own; a key does not, so the expansions in it are resolved here. Quote
   * removal without field splitting, since a key is one word however many blanks
   * it holds.
   */
  protected async expandSubscript(subscript: string, ctx: ExecContextIf): Promise<string> {
    if (!subscript.includes('$') && !subscript.includes('`')) {
      return subscript;
    }

    try {
      const ast = await parse(subscript, { mode: 'word-expansion' });
      const word = (ast.commands[0] as AstNodeCommand).name;

      if (!word) {
        return subscript;
      }

      const { values } = await this.resolveExpansions({ ...word, type: 'AssignmentWord' } as AstNodeAssignmentWord, ctx);

      return values[0] ?? '';
    } catch {
      return subscript;
    }
  }

  /**
   * The elements of an array, holes skipped. A scalar counts as a single
   * element, which is what makes `${x[@]}` work on an ordinary variable.
   */
  protected arrayElements(name: string, ctx: ExecContextIf, params: Record<string, string>): string[] {
    const assoc = ctx.getAssoc(name);

    if (assoc) {
      return Object.values(assoc);
    }

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

    const assoc = ctx.getAssoc(name);

    if (assoc) {
      // On an associative array the subscript is a key, not an expression
      return assoc[await this.expandSubscript(subscript, ctx)] ?? '';
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
      return params[name] !== undefined || ctx.getArray(name) !== undefined || ctx.getAssoc(name) !== undefined;
    }

    if (subscript === '@' || subscript === '*') {
      return this.arrayElements(name, ctx, params).length > 0;
    }

    const assoc = ctx.getAssoc(name);

    if (assoc) {
      return assoc[await this.expandSubscript(subscript, ctx)] !== undefined;
    }

    const array = ctx.getArray(name);
    const index = await this.resolveIndex(subscript, array?.length ?? 1, ctx);

    return array ? array[index] !== undefined : index === 0 && params[name] !== undefined;
  }

  /**
   * `set -u`: expanding a parameter that was never set is an error rather than
   * an empty string.
   *
   * Only for the plain expansions — the whole point of `${x:-d}` and friends is
   * to ask about a parameter that may not be there, and bash leaves `$@`, `$*`
   * and `${a[@]}` alone as well (those never reach here). The special parameters
   * are always set, whether or not this executor has got round to writing one.
   */
  protected assertParameterSet(parameter: string | number, isSet: boolean, ctx: ExecContextIf): void {
    if (isSet || !ctx.getShellOption('nounset')) {
      return;
    }

    const name = String(parameter);

    if (ALWAYS_SET_PARAMS.has(name)) {
      return;
    }

    throw new UnboundVariableError(name);
  }

  /**
   * Apply an operator that transforms a value, or return null when the operator
   * is not one of those (the `${x-word}` family needs to know whether the
   * parameter is set, and `${#x}` is about the parameter, not its value).
   *
   * These are the operators that distribute over `${a[@]}`: bash applies them to
   * each element in turn and the expansion is the resulting list.
   */
  protected async applyValueOperator(xp: Record<string, unknown>, value: string, ctx: ExecContextIf): Promise<string | null> {
    switch (xp.op) {
      case 'stringReplace': {
        // ${var/pattern/string}
        const pattern = String(xp.substitute ?? '');
        const replacement = String(xp.replace ?? '');

        if (xp.globally) {
          return value.split(pattern).join(replacement);
        }

        const idx = value.indexOf(pattern);

        return idx === -1 ? value : value.slice(0, idx) + replacement + value.slice(idx + pattern.length);
      }

      case 'removeSmallestSuffixPattern':
        return this.removeSuffix(value, await this.resolveWordValue(xp.word, ctx), false);

      case 'removeLargestSuffixPattern':
        return this.removeSuffix(value, await this.resolveWordValue(xp.word, ctx), true);

      case 'removeSmallestPrefixPattern':
        return this.removePrefix(value, await this.resolveWordValue(xp.word, ctx), false);

      case 'removeLargestPrefixPattern':
        return this.removePrefix(value, await this.resolveWordValue(xp.word, ctx), true);

      case 'caseChange':
        return this.changeCase(value, String(xp.pattern ?? '?'), xp.case === 'upper', Boolean(xp.globally));

      case 'substring': {
        // ${var:offset:length}
        const offset = Number(xp.offset) || 0;
        const length = xp.length != null ? Number(xp.length) : undefined;

        return length != null ? value.slice(offset, offset + length) : value.slice(offset);
      }

      default:
        return null;
    }
  }

  /**
   * `${v^pattern}` / `${v,,pattern}` — convert the characters matching pattern.
   * Without the doubled operator only the first character is considered.
   */
  protected changeCase(value: string, pattern: string, upper: boolean, globally: boolean): string {
    const matches = new RegExp(`^${this.globToRegexStr(pattern)}$`);
    const convert = (char: string) => upper ? char.toUpperCase() : char.toLowerCase();

    if (!globally) {
      return value.length > 0 && matches.test(value[0]) ? convert(value[0]) + value.slice(1) : value;
    }

    return [...value].map((char) => matches.test(char) ? convert(char) : char).join('');
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
      const name = String(xp.parameter);
      const assoc = ctx.getAssoc(name);
      const array = ctx.getArray(name);
      const keys = assoc ? Object.keys(assoc) : array ? Object.keys(array) : params[name] !== undefined ? ['0'] : [];

      return { values: keys, join: xp.expandWords ? 'field' : 'ifs' };
    }

    if (xp.op && !DISTRIBUTING_OPS.has(xp.op)) {
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
    subs?: ProcessSubstitutions,
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

          // An operator on a list applies to each element in turn, except
          // ${a[@]:x:y}, which slices the list itself
          if (xp.op === 'substring') {
            const xpAny = xp as Record<string, unknown>;
            const length = xpAny.length != null ? Number(xpAny.length) : undefined;

            // `${a[@]:1}` counts from the first element, `${@:1}` from the first
            // positional parameter — offset 0 there is $0, which is not in the list
            const positional = xp.parameter === '@' || xp.parameter === '*';
            const offset = Math.max(0, (Number(xpAny.offset) || 0) - (positional ? 1 : 0));

            list.values = length != null ? list.values.slice(offset, offset + length) : list.values.slice(offset);
          } else if (xp.op) {
            const xpAny = xp as Record<string, unknown>;

            list.values = await Promise.all(list.values.map(async (value) => await this.applyValueOperator(xpAny, value, ctx) ?? value));
          }

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

          const transformed = await this.applyValueOperator(xpAny, paramValue, ctx);

          if (transformed !== null) {
            resolved = transformed;
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
          } else if (xpAny.op === 'indicateErrorIfUnset' || xpAny.op === 'indicateErrorIfNull') {
            // ${var?word} / ${var:?word} — complain and leave, with word as the
            // message. This is the same diagnostic `set -u` raises, so it takes
            // the same route out.
            const missing = xpAny.op === 'indicateErrorIfNull' ? !paramValue : !isSet;

            if (missing) {
              const message = await this.resolveWordValue(xpAny.word, ctx);

              throw new UnboundVariableError(String(xp.parameter), message || 'parameter null or not set');
            }

            resolved = paramValue;
          } else if (xpAny.op === 'stringLength') {
            // ${#var}, and ${#a[@]} for the number of elements
            const { name, subscript } = this.splitSubscript(xp.parameter!);

            this.assertParameterSet(xp.parameter!, isSet, ctx);

            resolved = subscript === '@' || subscript === '*' ? String(this.arrayElements(name, ctx, params).length) : String(paramValue.length);
          } else {
            this.assertParameterSet(xp.parameter!, isSet, ctx);

            resolved = paramValue;
          }

          rValue.replace(
            xp.loc!.start,
            xp.loc!.end + 1,
            resolved,
          );
        }
      } else if (xp.type === 'CommandExpansion') {
        const { code, output } = await this.substitute(xp.commandAST, ctx);

        // A failing substitution still substitutes what it wrote. Bailing out
        // here instead made `for e in $(ls maybe-missing)` abort the enclosing
        // command — and with it the loop around it — instead of iterating over
        // nothing. `exit`/`return` inside `$( )` ends that subshell only, so
        // both are reduced to a plain status as well.
        status = isExitSignal(code) ? getExitCode(code) : isReturnSignal(code) ? getReturnCode(code) : code;

        rValue.replace(
          xp.loc!.start,
          xp.loc!.end + 1,
          output.replace(/\n+$/, ''), // Strip trailing newlines for command expansion (POSIX)
        );
      } else if (xp.type === 'ArithmeticExpansion') {
        const result = await this.evaluateArithmetic(xp.arithmeticAST, ctx);

        rValue.replace(
          xp.loc!.start,
          xp.loc!.end + 1,
          String(result),
        );
      } else if (xp.type === 'ProcessSubstitution') {
        const path = await this.substituteProcess(xp, ctx, subs);

        rValue.replace(xp.loc!.start, xp.loc!.end + 1, path);
      }
    }

    return { text: rValue.text, protectedRanges: rValue.protectedRanges, status, emptyList };
  }

  protected async resolveExpansions(
    node: AstNodeWord | AstNodeAssignmentWord,
    ctx: ExecContextIf,
    subs?: ProcessSubstitutions,
  ): Promise<{ values: string[]; status: number }> {
    if (!node.expansion || node.expansion.length === 0) {
      // Quotes AND escapes are already processed by the parser's quote-removal
      // phase, so node.text is final here. Re-running unescape would wrongly
      // transform literal backslash sequences (e.g. single-quoted '\1' -> 0x01).
      return { values: [node.text], status: 0 };
    }

    const { text: value, protectedRanges, status, emptyList } = await this.substituteExpansions(node, ctx, subs);

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

    // Path globbing expansion must be done last, and `set -f` turns it off — the
    // pattern is then just a word, which is also what an unmatched one becomes
    if (hasPathExpansion && this.shell.resolvePath && !ctx.getShellOption('noglob')) {
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

      case 'ParameterExpansion': {
        // `${…}` inside arithmetic: expanded as the shell word it is, then read as a number — or,
        // when it expands to an expression (`x="1+2"`), evaluated as one. bash substitutes the text
        // before parsing, so `$(( ${x} * 3 ))` is 7 there and 9 here; for a number the two agree.
        const paramNode = node as { type: 'ParameterExpansion'; text: string; word?: AstNodeWord };
        if (!paramNode.word) return 0;
        const { values } = await this.resolveExpansions(paramNode.word, ctx);
        const text = values.join(' ').trim();
        if (text === '') return 0;
        if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
        return await this.evaluateArithmetic(parseArithmetic(text), ctx);
      }

      case 'CommandSubstitution': {
        const cmdNode = node as { type: 'CommandSubstitution'; commandAST: AstNode };
        if (!cmdNode.commandAST) {
          return 0;
        }
        const { output } = await this.substitute(cmdNode.commandAST, ctx);
        const trimmed = output.trim();
        return trimmed === '' ? 0 : Number.parseInt(trimmed, 10) || 0;
      }

      default:
        throw new UnsupportedArithmeticNodeError((node as unknown as { type: string }).type, this.getSourceLocation(node), this.currentSource);
    }
  }
}
