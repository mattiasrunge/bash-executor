import {
  type AstArithmeticExpression,
  type AstArithmeticIdentifier,
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
  type AstNodeSelect,
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
import { JOB_BUILTINS } from './builtins/jobs.ts';
import type { BuiltinRegistry } from './builtins/types.ts';
import type { ErrorPosition } from './errors.ts';
import { bracketExpression, globToRegExp, globToRegexSource, posixRegexToSource, quoteGlob, quoteRegex } from './pattern.ts';
import { ArithmeticSyntaxError, NoClobberError, UnboundVariableError, UnknownNodeTypeError, UnsupportedArithmeticNodeError, UnsupportedOperatorError } from './errors.ts';
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
   * A builtin by name. The job builtins need the host's job control; without it
   * those names stay the host's own commands, if it has any. Asked each time,
   * since a host may set up `jobs` after it has made its executor.
   */
  private builtin(name: string) {
    if (!this.shell.jobs && JOB_BUILTINS.includes(name)) {
      return undefined;
    }

    return this.builtins?.get(name);
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
   * @param opts.exited - Set when the script ended in `exit` — in it, or in an
   *                      `eval`, `source` or trap it ran — which the status alone
   *                      does not tell. A host whose shell reads its input a line
   *                      at a time ends the shell on it.
   * @returns {Promise<number>} - The exit code of the executed script.
   */
  public async execute(source: string, ctx: ExecContextIf, opts: { exited?: { value: boolean } } = {}): Promise<number> {
    const code = await this.executeSource(source, ctx);

    if (isExitSignal(code)) {
      if (opts.exited) {
        opts.exited.value = true;
      }

      return getExitCode(code);
    }

    return code;
  }

  /**
   * `execute`, with an `exit` still an exit: what `eval`, `source` and a trap
   * run goes through here, so that an `exit` in it ends the shell around it.
   */
  protected async executeSource(source: string, ctx: ExecContextIf): Promise<number> {
    // Without the host's job control the job builtins are not there at all —
    // not for `type` and `command` either. Done here rather than in the
    // constructor, since a host may set up `jobs` after making its executor.
    if (!this.shell.jobs) {
      for (const name of JOB_BUILTINS) {
        this.builtins?.delete(name);
      }
    }

    // Saved rather than cleared: `eval`/`source` run through here too, and
    // dropping the source on the way out left the script around them with none —
    // no snippet in an error, and nothing for `set -v` to echo
    const previous = this.currentSource;

    this.currentSource = source;

    // Resolvers given here will be evaluated at parse time.
    // Most things we want to evaluate at execution time and
    // that is instead done during execution with resolveExpansions.
    const options = {
      insertLOC: true,
      resolveAlias: async (name: string) => ctx.getAlias(name),

      resolveHomeUser: this.shell.resolveHomeUser ? (async (username: string | null) => this.shell.resolveHomeUser!(ctx, username)) : undefined,
    };

    try {
      let ast: AstNode;

      try {
        ast = await parse(source, options);
      } catch (err) {
        if (!(err instanceof BashSyntaxError)) {
          throw err;
        }

        // bash reads a script, `eval` and `source` a line at a time: the complete
        // commands before a syntax error run, and only then does the error stop
        // it — unless they `exit` first. Nothing runs from the error's own line.
        const prefix = await this.completeCommandsBefore(source, options);

        if (prefix.trim()) {
          const code = await this.executeScript(await parse(prefix, options), ctx);

          if (isExitSignal(code) || isReturnSignal(code)) {
            return code;
          }
        }

        throw err;
      }

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
   * The lines of `source` that hold complete commands before its first syntax
   * error. Lines are added to a chunk until it parses; a chunk that is merely
   * unfinished — an open `if`, a here-document still to come — takes more, and
   * the first that fails for good is where the error is.
   */
  private async completeCommandsBefore(source: string, options: Parameters<typeof parse>[1]): Promise<string> {
    const lines = source.split('\n');
    let start = 0;

    for (let end = 0; end < lines.length; end++) {
      try {
        await parse(lines.slice(start, end + 1).join('\n'), options);
        start = end + 1;
      } catch (err) {
        if (!(err instanceof BashSyntaxError)) {
          throw err;
        }

        const unfinished = /Unclosed|'EOF'|CONTINUE|end of/i.test(err.message);

        if (!unfinished || end === lines.length - 1) {
          break;
        }
      }
    }

    return lines.slice(0, start).join('\n');
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
    if (node.async && this.shell.jobs) {
      return this.startJob(node, ctx);
    }

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
      case 'Select':
        return this.executeSelect(node as AstNodeSelect, ctx);
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
   * `&` with the host's job control: the host starts the node as a job of its
   * own, a subshell whose EXIT trap runs as it ends, and it goes in the job
   * table, with its pid in `$!`. With job control on (`set -m`) the shell says
   * `[1] pid`, as an interactive bash does.
   */
  private async startJob(node: AstNode, ctx: ExecContextIf): Promise<number> {
    const foreground = { ...node, async: false };
    const command = this.nodeSource(node);

    const handle = await this.shell.jobs!.start(ctx, async (jobCtx) => {
      const code = await this.executeNode(foreground, jobCtx);
      const status = isExitSignal(code) ? getExitCode(code) : isReturnSignal(code) ? getReturnCode(code) : code;

      return await this.runExitTrap(jobCtx, status);
    }, command);

    const job = ctx.getJobTable().add(handle, command);

    ctx.setParams({ '!': handle.pid });

    if (ctx.getShellOption('monitor')) {
      await this.shell.pipeWrite(ctx.getStderr(), `[${job.id}] ${handle.pid}\n`).catch(() => {});
    }

    return 0;
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
    return Boolean(this.builtin(name) || ctx.getFunction(name));
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

  /** Descriptors handed out by `exec {fd}>file`, so the next one takes another number. */
  private namedFds = new Set<number>();

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

  /**
   * A script's commands in turn. An `exit` stops them, and comes back as the
   * exit signal rather than its status, for the caller to end its shell by.
   */
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

      // `exit` stops the script, and the signal goes up to whatever ends the shell
      if (isExitSignal(lastCode)) {
        ctx.setParams({ '?': String(getExitCode(lastCode)) });

        return lastCode;
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
    // The DEBUG trap runs before every simple command; in a function only
    // under `set -T`, since functions do not inherit it otherwise
    if (parentCtx.getTrap('DEBUG') && (this.functionDepth === 0 || parentCtx.getShellOption('functrace'))) {
      const trapped = await this.runTrap('DEBUG', parentCtx, Number(parentCtx.getParams()['?'] ?? 0));

      if (isExitSignal(trapped)) {
        return trapped;
      }
    }

    try {
      return await this.runCommand(node, parentCtx);
    } catch (err) {
      // An arithmetic expansion that is no expression fails this command the same way
      if (err instanceof ArithmeticSyntaxError) {
        await this.shell.pipeWrite(parentCtx.getStderr(), `${err.message}\n`).catch(() => {});

        return this.applyErrexit(1, parentCtx);
      }

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
      // `exec >file &` runs in a background subshell: it opens the file there,
      // and the shell's own descriptors stay as they were
      if (node.async) {
        const code = await this.runCommand({ ...node, async: false }, parentCtx.subContext());

        return isExitSignal(code) ? getExitCode(code) : code;
      }

      const redirects = node.suffix?.filter((arg) => arg.type === 'Redirect') as AstNodeRedirect[] | undefined;
      const words = (node.suffix?.filter((arg) => arg.type === 'Word') ?? []) as AstNodeWord[];

      // `exec {fd}>file`: the word before the redirection names a variable for
      // the shell to put a free descriptor in, 10 or above. `{fd}>&-` closes it.
      for (const [i, item] of (node.suffix ?? []).entries()) {
        const name = item.type === 'Word' ? (item as AstNodeWord).text.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] : undefined;
        const redirect = node.suffix?.[i + 1] as AstNodeRedirect | undefined;

        if (!name || redirect?.type !== 'Redirect' || redirect.numberIo) {
          continue;
        }

        words.splice(words.indexOf(item as AstNodeWord), 1);
        redirects!.splice(redirects!.indexOf(redirect), 1);

        let fd: string;

        if (redirect.file.text === '-') {
          fd = parentCtx.getParams()[name] ?? '';
        } else {
          let n = 10;

          while (this.namedFds.has(n) || parentCtx.getFd(String(n)) !== undefined) n++;

          this.namedFds.add(n);
          fd = String(n);
          parentCtx.setParams({ [name]: fd });
        }

        const numbered = { ...redirect, numberIo: { type: 'io_number', text: fd } } as AstNodeRedirect;

        if (!(await this.openExecRedirection(parentCtx, numbered))) {
          await this.applyRedirections(parentCtx, [numbered]);
        }

        if (redirect.file.text === '-') {
          this.namedFds.delete(Number(fd));
        }
      }

      if (words[0]?.text === '--') {
        words.shift();
      }

      // `exec cmd args`: the command takes the shell's place, so the shell ends
      // with its status. The redirections are the command's own.
      if (words.length > 0) {
        const code = await this.runCommand({ ...node, name: words[0], suffix: [...words.slice(1), ...(redirects ?? [])] }, parentCtx);

        // A command that could not be run leaves the shell standing only under `shopt -s execfail`
        if ((code === 126 || code === 127) && parentCtx.getShellOption('execfail')) {
          return code;
        }

        return isExitSignal(code) ? code : makeExitSignal(code);
      }

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

    // Redirections may stand before the name as well as after it: `>out echo hi`,
    // `2>/dev/null cmd`, or on their own, `> file`, which creates the file
    const redirects = [...(node.prefix ?? []), ...(node.suffix ?? [])].filter((arg) => arg.type === 'Redirect') as AstNodeRedirect[];

    if (!node?.name) {
      // `!` on its own negates an empty command: 1
      const status = node.bang ? (assignStatus === 0 ? 1 : 0) : assignStatus;

      if (redirects.length === 0) {
        return this.applyErrexit(status, ctx);
      }

      const pipes = await this.applyRedirections(ctx, redirects);

      return this.withFileBridging(ctx, async () => await this.applyErrexit(status, ctx), pipes);
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

    // Words expand left to right, the name first: `$(a) $(b)` runs a before b
    const expandedName = await this.resolveExpansions(node.name, ctx, subs);

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
    const redirectPipes = await this.applyRedirections(ctx, redirects, subs);

    // A name that expands to nothing leaves the next word to be the command, and
    // one that expands to several makes the rest arguments: `$empty echo hi` runs
    // echo, `$cmd` with cmd='ls -l' runs ls. When every word is gone there is no
    // command at all, only the redirections, and the status is that of the last
    // command substitution.
    const words = [...expandedName.values, ...args];

    if (words.length === 0) {
      return this.withFileBridging(ctx, async () => await this.applyErrexit(expandedName.status ?? 0, ctx), redirectPipes)
        .finally(() => this.finishProcessSubstitutions(subs, ctx));
    }

    const cmdName = words[0];

    args.splice(0, args.length, ...words.slice(1));

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
      const builtin = this.builtin(cmdName);
      if (builtin) {
        const execute = (script: string) => this.executeSource(script, ctx);
        const result = await builtin(ctx, args || [], this.shell, execute);

        code = result.code;

        // Write stdout/stderr if present. Output that cannot be written — stdout
        // closed with `>&-`, or a descriptor open only for reading — fails the
        // builtin, as bash's "write error", and not the script.
        try {
          if (result.stdout) {
            await this.shell.pipeWrite(ctx.getStdout(), result.stdout);
          }
        } catch (err) {
          await this.shell.pipeWrite(ctx.getStderr(), `${cmdName}: write error: ${err instanceof Error ? err.message : err}\n`).catch(() => {});
          code = 1;
        }

        if (result.stderr) {
          await this.shell.pipeWrite(ctx.getStderr(), result.stderr).catch(() => {});
        }
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

      // `!` inverts a status; an `exit` or `return` is no status yet: `( ! exit 42 )` is 42
      const signal = isExitSignal(code) || isReturnSignal(code);

      return this.applyErrexit(node.bang && !signal ? (code === 0 ? 1 : 0) : code, ctx);
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
    // bash scopes dynamically: the frame hangs off the caller, so a function
    // sees and assigns its caller's locals, and one called in a subshell or a
    // pipeline stage stays inside it. Hanging it off the context the function
    // was defined in let `g` miss `f`'s locals and wrote a stage's assignments
    // back into the shell.
    const fnCtx = ctx.spawnContext();

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

    const returnTrap = ctx.getTrap('RETURN');

    this.functionDepth++;

    let result: number;

    try {
      result = await this.executeNode(fn.body, fnCtx);
    } finally {
      this.functionDepth--;
    }

    // Convert return signal to actual return code
    const code = isReturnSignal(result) ? getReturnCode(result) : result;

    // The RETURN trap runs as the function returns — one the function set itself,
    // or the caller's under `set -T`: functions do not inherit it otherwise
    const inherited = ctx.getShellOption('functrace') || ctx.getTrap('RETURN') !== returnTrap;

    if (!isExitSignal(code) && inherited) {
      const trapped = await this.runTrap('RETURN', fnCtx, code);

      if (isExitSignal(trapped)) {
        return trapped;
      }
    }

    return code;
  }

  protected async executeSubshell(node: AstNodeSubshell, parentCtx: ExecContextIf): Promise<number> {
    // `( … )` is a subshell: env/cwd changes inside must not escape to the parent.
    const ctx = parentCtx.subContext();
    const result = await this.withFileBridging(ctx, () => {
      return this.executeNode(node.list, ctx);
    });

    // `(exit 3)` ends the subshell, not the shell: to the caller it is status 3.
    // Its EXIT trap runs as it ends.
    const code = await this.runExitTrap(ctx, isExitSignal(result) ? getExitCode(result) : isReturnSignal(result) ? getReturnCode(result) : result);

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
      // A `$( )` is a shell of its own, and its EXIT trap writes into it
      const result = await this.executeNode(commandAST, cmdCtx);
      const code = await this.runExitTrap(cmdCtx, isExitSignal(result) ? getExitCode(result) : result);

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
    // bash runs the last stage in the shell only without job control
    const lastpipe = ctx.getShellOption('lastpipe') && !ctx.getShellOption('monitor');

    try {
      for (let n = 0; n < node.commands.length; n++) {
        const isFirstCommand = n === 0;
        const isLastCommand = n === node.commands.length - 1;

        // Each pipeline stage is a subshell — isolate env/cwd so a stage can't leak
        // into the parent (or race the other concurrently-running stages). Under
        // `shopt -s lastpipe` the last one runs in the shell itself, so
        // `echo x | read v` sets v, as bash does without job control.
        const cmdCtx = isLastCommand && lastpipe ? ctx.spawnContext() : ctx.subContext();

        // A stage failing is the pipeline's business, not the shell's: errexit
        // looks at what finishPipeline makes of them all
        cmdCtx.setErrexitSuppressed(true);

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

      return this.finishPipeline(node, codes, ctx, lastpipe);
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
  protected async finishPipeline(node: AstNodePipeline, codes: number[], ctx: ExecContextIf, lastpipe = false): Promise<number> {
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

    // Every stage is a subshell, the last one too: `echo x | exit 5` ends that
    // stage, not the shell, and leaves 5 behind. Under lastpipe the last stage is
    // the shell, and an `exit` or `return` there is the shell's.
    const lastCode = codes[codes.length - 1];

    if (lastpipe && (isExitSignal(lastCode) || isReturnSignal(lastCode) || lastCode === BREAK_CODE || lastCode === CONTINUE_CODE)) {
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
  protected async applyErrexit(code: number, ctx: ExecContextIf): Promise<number> {
    if (code === 0 || isExitSignal(code) || isReturnSignal(code) || code === BREAK_CODE || code === CONTINUE_CODE) {
      return code;
    }

    // The ERR trap runs where errexit would end the shell, set -e or not; in a
    // function only under `set -E`, since functions do not inherit it otherwise
    if (!ctx.getErrexitSuppressed() && (this.functionDepth === 0 || ctx.getShellOption('errtrace'))) {
      const trapped = await this.runTrap('ERR', ctx, code);

      if (isExitSignal(trapped)) {
        return trapped;
      }
    }

    if (!ctx.getShellOption('errexit') || ctx.getErrexitSuppressed()) {
      return code;
    }

    return makeExitSignal(code);
  }

  /** How deep in function calls the executor is, for the traps functions do not inherit. */
  private functionDepth = 0;

  /** Which traps are running now, so one does not set itself off again. */
  private runningTraps = new Set<string>();

  /**
   * Run a trap's command, if one is set and not ignored. `$?` is what it was
   * when the trap went off, inside the trap and after it — unless the trap
   * runs `exit`, whose signal comes back to the caller.
   */
  protected async runTrap(name: string, ctx: ExecContextIf, status: number): Promise<number> {
    const action = ctx.getTrap(name);

    if (!action || this.runningTraps.has(name)) {
      return status;
    }

    this.runningTraps.add(name);
    ctx.setParams({ '?': String(status) });

    try {
      const code = await this.executeSource(action, ctx);

      if (isExitSignal(code)) {
        return code;
      }
    } catch (err) {
      if (!(err instanceof BashSyntaxError)) throw err;

      await this.shell.pipeWrite(ctx.getStderr(), `trap: syntax error: ${err.message.split('\n')[0]}\n`).catch(() => {});
    } finally {
      this.runningTraps.delete(name);
      ctx.setParams({ '?': String(status) });
    }

    return status;
  }

  /**
   * A signal the shell itself received, by name without `SIG`: its trap runs,
   * or is ignored when it was set to ''. False when there is no trap, and the
   * host does what the signal does by default — for most, end the shell.
   */
  public async trapSignal(ctx: ExecContextIf, signal: string): Promise<boolean> {
    const name = `SIG${signal}`;
    const action = ctx.getTrap(name);

    if (action === undefined) {
      return false;
    }

    await this.runTrap(name, ctx, Number(ctx.getParams()['?'] ?? 0));

    return true;
  }

  /**
   * The end of a shell: its EXIT trap runs, once, with `$?` the status the shell
   * ends with, and an `exit` in it changes that status. Subshells and `$( )` are
   * ended here by the executor; a host calls this when its own shell ends.
   *
   * @returns The status the shell ends with.
   */
  public async runExitTrap(ctx: ExecContextIf, status: number): Promise<number> {
    const code = await this.runTrap('EXIT', ctx, status);

    ctx.setTrap('EXIT', null);

    return isExitSignal(code) ? getExitCode(code) : status;
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
      if (!(await this.loopNameIsValid(node, ctx))) {
        return this.applyErrexit(1, ctx);
      }

      // The whole word list is expanded once, before the first iteration, so the
      // body cannot change what is still to be iterated over.
      const values = await this.loopWords(node, ctx);

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

  /** `for 1 in …` parses, and fails when it runs, as in bash. */
  private async loopNameIsValid(node: AstNodeFor | AstNodeSelect, ctx: ExecContextIf): Promise<boolean> {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.name.text)) {
      return true;
    }

    await this.shell.pipeWrite(ctx.getStderr(), `\`${node.name.text}': not a valid identifier\n`).catch(() => {});

    return false;
  }

  /**
   * The words a `for` or `select` goes over: its list, expanded, or without
   * `in` the positional parameters, as `for i; do` has them.
   */
  private async loopWords(node: AstNodeFor | AstNodeSelect, ctx: ExecContextIf): Promise<string[]> {
    if (!node.wordlist) {
      const params = ctx.getParams();

      return Array.from({ length: Number(params['#'] ?? 0) }, (_, i) => params[String(i + 1)] ?? '');
    }

    const values: string[] = [];

    for (const word of node.wordlist) {
      values.push(...(await this.resolveExpansions(word, ctx)).values);
    }

    return values;
  }

  /**
   * `select name in words`: the words as a numbered menu on stderr, then the
   * `PS3` prompt and a line from stdin for each pass. The line goes in `REPLY`
   * and the word it numbers in `name` — empty for anything else — and the body
   * runs; an empty line shows the menu again. The loop ends at `break` or at
   * the end of the input, which leaves 1.
   */
  protected async executeSelect(node: AstNodeSelect, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
      if (!(await this.loopNameIsValid(node, ctx))) {
        return this.applyErrexit(1, ctx);
      }

      const values = await this.loopWords(node, ctx);
      const width = String(values.length).length;
      const menu = values.map((value, i) => `${String(i + 1).padStart(width)}) ${value}\n`).join('');
      let showMenu = true;

      if (values.length === 0) {
        return 0;
      }

      while (true) {
        const ps3 = ctx.getParams().PS3 ?? ctx.getEnv().PS3 ?? '#? ';

        await this.shell.pipeWrite(ctx.getStderr(), (showMenu ? menu : '') + ps3).catch(() => {});
        showMenu = false;

        const line = this.shell.pipeReadLine ? await this.shell.pipeReadLine(ctx.getStdin()) : null;

        if (line === null) {
          await this.shell.pipeWrite(ctx.getStderr(), '\n').catch(() => {});
          return 1;
        }

        if (line.trim() === '') {
          showMenu = true;
          continue;
        }

        const choice = /^\s*\d+\s*$/.test(line) ? Number(line) : 0;

        ctx.setParams({ REPLY: line, [node.name.text]: choice >= 1 && choice <= values.length ? values[choice - 1] : '' });

        const { stop, code } = await this.runLoopBody(node.do, ctx);

        if (stop) {
          return code;
        }
      }
    });
  }

  /**
   * `for (( init; test; update ))`: `init` once, then the body while `test` is non-zero, `update`
   * after each pass — `continue` included. A missing `test` is true, as in bash, so `for ((;;))`
   * runs until something breaks out of it.
   */
  protected async executeArithmeticFor(node: AstNodeArithmeticFor, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
      if (node.init) await this.arithmeticValue(node.init, ctx);

      let last = 0;

      while (!node.test || await this.arithmeticValue(node.test, ctx) !== 0) {
        const { stop, code } = await this.runLoopBody(node.do, ctx);
        last = code;

        if (stop) {
          return code;
        }

        if (node.update) await this.arithmeticValue(node.update, ctx);
      }

      return last;
    }).catch((err) => this.arithmeticCommandStatus(err, parentCtx));
  }

  protected async executeCase(node: AstNodeCase, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
      // The subject is one word, neither split nor globbed: `case $x in` with
      // IFS=: and x=a:b matches against a:b, `case * in` against *
      const clauseExpanded = await this.resolveExpansions(node.clause, ctx, undefined, { split: false, glob: false });
      const clauseValue = clauseExpanded.values.join(' ');

      let status = 0;
      // After `;&`, the next item's commands run without its patterns being tested
      let fallThrough = false;

      for (const caseItem of node.cases || []) {
        // Check if any pattern matches (patterns undergo expansion and quote
        // removal: quoted characters match literally, unquoted globs are active)
        let matched = fallThrough;
        for (const pattern of matched ? [] : caseItem.pattern) {
          const regex = await this.expandCasePattern(pattern, ctx);
          if (regex.test(clauseValue)) {
            matched = true;
            break;
          }
        }

        if (!matched) {
          continue;
        }

        status = caseItem.body ? await this.executeNode(caseItem.body, ctx) : 0;

        // exit, return, break and continue leave the case as they are
        if (isExitSignal(status) || isReturnSignal(status) || status === BREAK_CODE || status === CONTINUE_CODE) {
          return status;
        }

        fallThrough = caseItem.terminator === ';&';

        // `;;` ends the case; `;;&` goes on testing the items after this one
        if (!fallThrough && caseItem.terminator !== ';;&') {
          return status;
        }
      }

      return status;
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

    // The pattern as bash sees it once quotes are gone: what was quoted is
    // quoted with a backslash, so it matches itself
    let glob = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < text.length; i++) {
      const expansion = !inSingle ? evaluated.get(i) : undefined;
      if (expansion) {
        glob += inDouble ? quoteGlob(expansion.value) : expansion.value;
        i = expansion.end;
        continue;
      }

      const c = text[i];
      const ansi = !inSingle && !inDouble && c === '$' ? this.ansiCString(text, i) : undefined;

      if (ansi) {
        glob += quoteGlob(ansi.value);
        i = ansi.end;
      } else if (!inSingle && !inDouble && c === '$' && text[i + 1] === '"') {
        // $"…" is a string to translate; untranslated it is "…"
      } else if (!inSingle && !inDouble && c === '\\' && i + 1 < text.length) {
        glob += quoteGlob(text[++i]);
      } else if (!inDouble && c === "'") {
        inSingle = !inSingle;
      } else if (!inSingle && c === '"') {
        inDouble = !inDouble;
      } else {
        glob += inSingle || inDouble ? quoteGlob(c) : c;
      }
    }

    return globToRegExp(glob);
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
    return bracketExpression(pattern, open);
  }

  /**
   * Matches a glob pattern against a value.
   * Supports *, ?, and character classes.
   */
  protected matchGlobPattern(pattern: string, value: string): boolean {
    return globToRegExp(pattern).test(value);
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
    try {
      const result = await this.arithmeticValue(node, ctx);
      // In bash, (( expr )) returns 0 (success) if expr is non-zero, 1 (failure) if expr is zero
      return this.applyErrexit(result !== 0 ? 0 : 1, ctx);
    } catch (err) {
      return await this.arithmeticCommandStatus(err, ctx);
    }
  }

  /** `((` and `for ((` report a bad expression as bash does, `((: 1 + : syntax error: …`, and fail with 1. */
  private async arithmeticCommandStatus(err: unknown, ctx: ExecContextIf): Promise<number> {
    if (!(err instanceof ArithmeticSyntaxError)) {
      throw err;
    }

    await this.shell.pipeWrite(ctx.getStderr(), `((: ${err.message}\n`).catch(() => {});

    return this.applyErrexit(1, ctx);
  }

  /**
   * The value of an arithmetic expression. The parser hands over an AST when
   * the text was arithmetic as written; otherwise — `a[i]`, `16#ff`, `$#`, or
   * something that is not arithmetic at all — the text is expanded, as bash
   * always does first, and parsed now.
   */
  protected async arithmeticValue(part: { expression: string; arithmeticAST?: AstArithmeticExpression }, ctx: ExecContextIf): Promise<number> {
    if (part.arithmeticAST) {
      return await this.evaluateArithmetic(part.arithmeticAST, ctx);
    }

    // Parameters, command substitutions and quote removal, as in double quotes
    const expanded = (await this.expandHereDocument(part.expression, ctx)).replace(/(?<!\\)"/g, '');

    // An empty expression is 0: `(( ))` fails quietly, `$(( ))` is 0
    if (expanded.trim() === '') {
      return 0;
    }

    let ast: AstArithmeticExpression;

    try {
      ast = parseArithmetic(expanded);
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);

      throw new ArithmeticSyntaxError(expanded, detail);
    }

    return await this.evaluateArithmetic(ast, ctx);
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
    // Pattern matching: the right side is a pattern as in `case`, its quoted
    // parts matching themselves, extended patterns included
    if (op === '==' || op === '=' || op === '!=') {
      const matches = (await this.expandCasePattern(node.right as unknown as AstNodeWord, ctx)).test(left);

      return op === '!=' ? !matches : matches;
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
    // Quote removal only: no field splitting in [[ ]], so `$'a\tb'` stays one word
    if (!word.expansion || word.expansion.length === 0) {
      return utils.unquoteSingleWord(word.text);
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
        const result = await this.arithmeticValue({ expression: xp.expression ?? '', arithmeticAST: xp.arithmeticAST }, ctx);
        rValue.replace(xp.loc!.start, xp.loc!.end + 1, String(result));
      }
      // Note: PathExpansion is NOT applied in [[ ]] - patterns are used literally
    }

    return utils.unquoteSingleWord(rValue.text);
  }

  /**
   * Expands the right-hand side of =~ without unquoting (preserves regex metacharacters).
   */
  /**
   * An ANSI-C quoted string, `$'\t…'`, starting at `start`: its value and the
   * index of its closing quote, or undefined when there is none.
   */
  private ansiCString(text: string, start: number): { value: string; end: number } | undefined {
    if (text[start] !== '$' || text[start + 1] !== "'") {
      return undefined;
    }

    for (let i = start + 2; i < text.length; i++) {
      if (text[i] === '\\') {
        i++;
      } else if (text[i] === "'") {
        return { value: utils.unquoteWord(text.slice(start, i + 1)).values[0] ?? '', end: i };
      }
    }

    return undefined;
  }

  protected async expandConditionalRegex(
    word: AstConditionalWord,
    ctx: ExecContextIf,
  ): Promise<string> {
    // The parser keeps the regular expression as written; its expansions happen
    // here, where bash's quoting rules for it apply: what is quoted matches
    // itself (`=~ "a.c"` is no pattern), what is not is part of the expression
    // (`=~ $re`).
    const text = word.text;
    let regex = '';
    let i = 0;

    while (i < text.length) {
      const c = text[i];
      const ansi = c === '$' ? this.ansiCString(text, i) : undefined;

      if (ansi) {
        regex += quoteRegex(ansi.value);
        i = ansi.end + 1;
      } else if (c === '$' && text[i + 1] === '"') {
        // $"…" is a string to translate; untranslated it is "…"
        i++;
      } else if (c === "'") {
        const close = text.indexOf("'", i + 1);
        const end = close === -1 ? text.length : close;

        regex += quoteRegex(text.slice(i + 1, end));
        i = end + 1;
      } else if (c === '"') {
        let close = i + 1;

        while (close < text.length && text[close] !== '"') {
          close += text[close] === '\\' ? 2 : 1;
        }

        regex += quoteRegex(await this.expandHereDocument(text.slice(i + 1, close), ctx));
        i = close + 1;
      } else {
        let end = i;

        // Up to the next quote, `$'` and `$"` included
        while (end < text.length && text[end] !== "'" && text[end] !== '"' && !(text[end] === '$' && `'"`.includes(text[end + 1]))) {
          end += text[end] === '\\' ? 2 : 1;
        }

        regex += await this.expandHereDocument(text.slice(i, end), ctx);
        i = end;
      }
    }

    return posixRegexToSource(regex);
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
    let assigned = previous + value;

    // `declare -i` makes the value arithmetic, evaluated now: x=1+2 is 3, x+=4 adds
    if (ctx.isIntegerVar(name)) {
      const number = await this.arithmeticValue({ expression: value || '0' }, ctx);
      const base = append ? await this.arithmeticValue({ expression: previous || '0' }, ctx) : 0;

      assigned = String(base + number);
    }

    if (local) {
      ctx.setLocalParams({ [name]: assigned });
    } else if (ctx.getShellOption('allexport')) {
      // `set -a` makes a plain assignment an exported one, so a child sees it
      ctx.setEnv({ [name]: assigned });
    } else {
      ctx.setParams({ [name]: assigned });
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
        const result = await this.arithmeticValue({ expression: xp.expression ?? '', arithmeticAST: xp.arithmeticAST }, ctx);

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

  /**
   * @param opts - `split: false` and `glob: false` leave out field splitting
   *               and pathname expansion, for the places bash does: a `case`
   *               subject is expanded like a word in double quotes, less the quotes.
   */
  protected async resolveExpansions(
    node: AstNodeWord | AstNodeAssignmentWord,
    ctx: ExecContextIf,
    subs?: ProcessSubstitutions,
    opts: { split?: boolean; glob?: boolean } = {},
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
    const unquotedResult = utils.unquoteWordWithProtectedRanges(value, protectedRanges, opts.split === false ? '' : this.getIfs(ctx));
    const result = { values: unquotedResult.values, status };

    // Path globbing expansion must be done last, and `set -f` turns it off — the
    // pattern is then just a word, which is also what an unmatched one becomes
    if (hasPathExpansion && opts.glob !== false && this.shell.resolvePath && !ctx.getShellOption('noglob')) {
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
    return globToRegexSource(pattern);
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
  /** How deep variables that hold expressions have sent the evaluation; bash stops at 1024. */
  private arithmeticDepth = 0;

  /**
   * An arithmetic variable's value. A value that is not a plain number is an
   * expression in its own right, as in bash: with `b='1+2'`, `$(( b * 2 ))` is
   * 6, and `x=010` is 8. Unset or empty is 0.
   */
  private async readArithmeticVariable(node: AstArithmeticIdentifier, ctx: ExecContextIf): Promise<number> {
    const text = (await this.arithmeticVariableText(node, ctx)).trim();

    if (text === '') {
      return 0;
    }

    if (/^[+-]?(0|[1-9]\d*)$/.test(text)) {
      return Number.parseInt(text, 10);
    }

    if (++this.arithmeticDepth > 1024) {
      this.arithmeticDepth = 0;
      throw new ArithmeticSyntaxError(text, 'expression recursion level exceeded');
    }

    try {
      let ast: AstArithmeticExpression;

      try {
        ast = parseArithmetic(text);
      } catch (err) {
        throw new ArithmeticSyntaxError(text, err instanceof Error ? err.message.split('\n')[0] : String(err));
      }

      return await this.evaluateArithmetic(ast, ctx);
    } finally {
      this.arithmeticDepth = Math.max(0, this.arithmeticDepth - 1);
    }
  }

  /** The text of a scalar, or of one element of an indexed or associative array. */
  private async arithmeticVariableText(node: AstArithmeticIdentifier, ctx: ExecContextIf): Promise<string> {
    if (node.subscript === undefined) {
      return ctx.getParams()[node.name] ?? ctx.getEnv()[node.name] ?? '';
    }

    const assoc = ctx.getAssoc(node.name);

    if (assoc) {
      return assoc[await this.arithmeticKey(node, ctx)] ?? '';
    }

    const array = ctx.getArray(node.name);
    const index = await this.arithmeticIndex(node, array?.length ?? 1, ctx);

    // A scalar is element 0 of itself
    return array ? array[index] ?? '' : index === 0 ? ctx.getParams()[node.name] ?? ctx.getEnv()[node.name] ?? '' : '';
  }

  private async writeArithmeticVariable(node: AstArithmeticIdentifier, value: number, ctx: ExecContextIf): Promise<void> {
    if (node.subscript === undefined) {
      ctx.setParams({ [node.name]: String(value) });
      return;
    }

    if (ctx.getAssoc(node.name)) {
      ctx.setAssocElement(node.name, await this.arithmeticKey(node, ctx), String(value));
      return;
    }

    const array = ctx.getArray(node.name);

    ctx.setArrayElement(node.name, await this.arithmeticIndex(node, array?.length ?? 0, ctx), String(value));
  }

  /** An associative subscript is a key: expanded, not evaluated. */
  private async arithmeticKey(node: AstArithmeticIdentifier, ctx: ExecContextIf): Promise<string> {
    return (await this.expandHereDocument(node.subscript ?? '', ctx)).replace(/(?<!\\)"/g, '');
  }

  /** An indexed subscript is arithmetic; a negative one counts from the end. */
  private async arithmeticIndex(node: AstArithmeticIdentifier, length: number, ctx: ExecContextIf): Promise<number> {
    const index = await this.arithmeticValue({ expression: node.subscript ?? '', arithmeticAST: node.index }, ctx);

    return index < 0 ? length + index : index;
  }

  protected async evaluateArithmetic(node: AstArithmeticExpression | { type: 'CommandSubstitution'; commandAST: AstNode }, ctx: ExecContextIf): Promise<number> {
    if (!node) {
      return 0;
    }

    switch (node.type) {
      case 'NumericLiteral':
        return node.value;

      case 'Identifier':
        return await this.readArithmeticVariable(node, ctx);

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

        await this.writeArithmeticVariable(node.left, value, ctx);
        return value;
      }

      case 'UpdateExpression': {
        const currentValue = await this.evaluateArithmetic(node.argument, ctx);
        const newValue = node.operator === '++' ? currentValue + 1 : currentValue - 1;
        await this.writeArithmeticVariable(node.argument, newValue, ctx);
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
