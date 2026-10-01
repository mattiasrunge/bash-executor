import { hashedCommand } from './command-hash.ts';
import {
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
  type AstNodeCoproc,
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
  type ProtectedRange,
  utils,
} from '@ein/bash-parser';
import { getExitCode, getReturnCode, isExitSignal, isReturnSignal, makeExitSignal } from './builtins/exit.ts';
import { JOB_BUILTINS } from './builtins/jobs.ts';
import { type BuiltinRegistry, SPECIAL_BUILTINS } from './builtins/types.ts';
import { assocKeys, attributeLetters, compoundValue, keyQuoted, valueQuoted } from './builtins/variable-listing.ts';
import { assocEntries, keyedElement, keyedText } from './assoc-list.ts';
import type { ErrorPosition } from './errors.ts';
import { exportedFunctionName, exportedFunctionText, type FunctionDefinition, functionEnvName } from './print-command.ts';
import { singleQuoted } from './quote.ts';
import { expandPattern, type GlobOptions, globPatterns, isGlobPattern, patternOf } from './glob.ts';
import { syntaxErrorLines } from './syntax-error.ts';
import { cpuTime, timeReport } from './timing.ts';
import { closingBracket, closingQuote, contextVariables, evaluateArithmeticText, subscriptEnd } from './arith.ts';
import { bracketExpression, globToRegExp, globToRegexSource, posixRegexToSource, quoteGlob, quoteRegex, unquoteGlob } from './pattern.ts';
import {
  ArithmeticError,
  ArithmeticSyntaxError,
  CommandAbortError,
  GlobNoMatchError,
  NoClobberError,
  ReadonlyVariableError,
  RedirectionError,
  UnboundVariableError,
  UnknownNodeTypeError,
  UnsupportedOperatorError,
} from './errors.ts';
import {
  type ExecCommandOptions,
  type ExecContextIf,
  type ExecSyncResult,
  type ExecuteAndCaptureOptions,
  QUOTED_LIST_MARK,
  SHELL_OPTION_FLAG_MAP,
  type ShellIf,
} from './types.ts';

// The special parameters, which are set even when nothing has assigned to them
/** POSIX's special builtins: in POSIX mode an assignment before one outlasts it. */

const ALWAYS_SET_PARAMS = new Set(['?', '#', '$', '0', '-', '_', '@', '*']);

// What bash running a -c string exits with when an expansion fails
const UNBOUND_VARIABLE_CODE = 127 as const;

/**
 * `break N` and `continue N` are carried out of a loop's body as reserved
 * codes, one per number of loops still to leave: each loop they pass through
 * takes one off, and the last one breaks or continues.
 */
const BREAK_BASE = -3000;
const CONTINUE_BASE = -4000;

function loopControl(kind: 'break' | 'continue', levels: number): number {
  return (kind === 'break' ? BREAK_BASE : CONTINUE_BASE) - levels;
}

function isLoopControl(code: number): boolean {
  return code < BREAK_BASE && code > CONTINUE_BASE - 1000 && code !== CONTINUE_BASE;
}

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
  'transformation',
]);

/** Where what matched goes in the replacement of `${x/p/s}`: an unquoted `&`. A noncharacter, which no text holds. */
const MATCH_MARK = '\uFDD3';

/** Builtins that take `name[sub]` arguments, bash's ARRAYREF_BUILTIN ones */
const ARRAYREF_BUILTINS = new Set(['declare', 'let', 'local', 'printf', 'read', 'test', '[', 'typeset', 'unset', 'wait']);

/** Whether a word, as written, is `name[sub]` and nothing more: bash's valid_array_reference. */
function isArrayReference(text: string): boolean {
  const open = text.indexOf('[');

  if (open < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text.slice(0, open))) return false;

  const close = subscriptEnd(text, open);

  return close > open + 1 && close === text.length - 1;
}

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
/** Private-use characters that stand for quoted characters in a `=~` expression while it is read. */
const REGEX_LITERAL_BASE = 0xe000;
const REGEX_LITERALS = /[\ue000-\uf8ff]/g;

/** Whether a word, after quote removal, could still be a pattern. */
function hasGlobCharacters(text: string): boolean {
  return /[*?[]|[@+!?*]\(/.test(text);
}

function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * Whether `pos` in a word's text is inside double quotes: what `"$*"` and `$*`
 * differ by. Single quotes and backslashes are stepped over; an expansion's own
 * quotes, `${x:-"a"}`, open and close within it.
 */
function isDoubleQuotedAt(text: string, pos: number): boolean {
  let inDouble = false;

  for (let i = 0; i < pos && i < text.length; i++) {
    const c = text[i];

    if (c === '\\') {
      i++;
    } else if (c === "'" && !inDouble) {
      const close = text.indexOf("'", i + 1);

      i = close === -1 ? text.length : close;
    } else if (c === '"') {
      inDouble = !inDouble;
    }
  }

  return inDouble;
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
  /**
   * Begin each diagnostic the way a non-interactive bash does, with the
   * script's name and the line: `./x.sh: line 3: x: readonly variable`.
   * Without it a diagnostic is the message alone.
   */
  lineNumbers?: boolean;
  /**
   * A here-document the input ends inside: refused as unclosed (the default),
   * which lets an interactive host ask for more, or — `'end'` — taken to the
   * end of the input with bash's warning, as a script runs it.
   */
  unterminatedHereDocuments?: 'error' | 'end';
};

/**
 * Class responsible for executing AST nodes parsed from shell scripts.
 */
export class AstExecutor {
  private shell: ShellIf;
  private currentSource?: string;
  private builtins?: BuiltinRegistry;

  /** See `AstExecutorOptions.lineNumbers` */
  private lineNumbers: boolean;

  /** See `AstExecutorOptions.unterminatedHereDocuments` */
  private unterminatedHereDocuments: 'error' | 'end';

  /**
   * Where the source being run starts, for `$LINENO`: 0 in a script and in a
   * sourced file, the line before its own in an `eval`. The name is the file's
   * a diagnostic from it begins with, when it is not the script's.
   */
  private sourceFrame: { base: number; name?: string } = { base: 0 };

  constructor(shell: ShellIf, options?: AstExecutorOptions) {
    this.shell = shell;
    this.builtins = options?.builtins;
    this.lineNumbers = options?.lineNumbers ?? false;
    this.unterminatedHereDocuments = options?.unterminatedHereDocuments ?? 'error';
  }

  /**
   * Say something went wrong, on the shell's stderr: with `lineNumbers`, as
   * `$0: line N: message`, each line of it.
   */
  protected async diagnose(ctx: ExecContextIf, message: string): Promise<void> {
    // Said already, where it happened: an abort that carries no message
    if (!message) return;

    const prefix = this.lineNumbers ? `${this.sourceFrame.name ?? ctx.getParam('0') ?? 'bash'}: line ${ctx.getParam('LINENO') ?? 0}: ` : '';
    const text = message.endsWith('\n') ? message : `${message}\n`;

    // A usage message is said without the place, as bash does
    await this.shell.pipeWrite(ctx.getStderr(), prefix ? text.replace(/^(?=.)(?![\w.-]+: usage: )/gm, prefix) : text).catch(() => {});
  }

  /** The file each function was defined in, for its BASH_SOURCE. */
  private functionSources = new WeakMap<object, string>();

  /** The source frame each function was defined in, which its line numbers count from. */
  private functionFrames = new WeakMap<object, { base: number; name?: string }>();

  /** The file running now, as BASH_SOURCE names it: `environment` for a string run as it is. */
  private currentFile(ctx: ExecContextIf): string {
    return ctx.getArray('BASH_SOURCE')?.[0] ?? 'environment';
  }

  /**
   * Run a function or a sourced file as a frame of the call stack bash keeps
   * in FUNCNAME, BASH_SOURCE and BASH_LINENO: its name, the file it is from,
   * and the line it was called on. The arrays are the stack, so a subshell
   * has its own copy of it.
   */
  private async inCallFrame<T>(ctx: ExecContextIf, name: string, source: string, run: () => Promise<T>): Promise<T> {
    const names = ctx.getArray('FUNCNAME');
    const sources = ctx.getArray('BASH_SOURCE');
    const lines = ctx.getArray('BASH_LINENO');

    // `main` is the script itself, shown only once something is above it
    ctx.setArray('FUNCNAME', [name, ...(names?.length ? names : sources?.length ? ['main'] : [])]);
    ctx.setArray('BASH_SOURCE', [source, ...(sources ?? [])]);
    ctx.setArray('BASH_LINENO', [ctx.getParam('LINENO') ?? '0', ...(lines ?? [])]);

    try {
      return await run();
    } finally {
      for (const [array, values] of [['FUNCNAME', names], ['BASH_SOURCE', sources], ['BASH_LINENO', lines]] as const) {
        if (values) ctx.setArray(array, values);
        else ctx.unsetArray(array);
      }
    }
  }

  /**
   * Run source that is not the script — an `eval`'s string, a sourced file —
   * with `$LINENO` counted from where it stands.
   */
  private async inSourceFrame<T>(frame: { base: number; name?: string }, run: () => Promise<T>): Promise<T> {
    const previous = this.sourceFrame;

    this.sourceFrame = frame;

    try {
      return await run();
    } finally {
      this.sourceFrame = previous;
    }
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

    const enhanced = new BashSyntaxError(err.message, fullSource, location, err.cause);

    // What went wrong, for the message bash would give
    enhanced.detail = err.detail;

    return enhanced;
  }

  /**
   * Executes a shell script source code.
   * @param {string} source - The shell script source code.
   * @param {ExecContextIf} ctx - The execution context.
   * @param opts.exited - Set when the script ended in `exit` — in it, or in an
   *                      `eval`, `source` or trap it ran — which the status alone
   *                      does not tell. A host whose shell reads its input a line
   *                      at a time ends the shell on it.
   * @param opts.command - The script is a `bash -c` string: an unset parameter
   *                       ends it with 127, where a script read from a file or
   *                       a prompt leaves 1, as bash does
   * @param opts.line - The line of the script the source starts on, for a
   *                    script run a piece at a time: LINENO goes on from it
   * @returns {Promise<number>} - The exit code of the executed script.
   */
  public async execute(
    source: string,
    ctx: ExecContextIf,
    opts: { exited?: { value: boolean }; file?: string; command?: boolean; line?: number } = {},
  ): Promise<number> {
    this.commandString = opts.command ?? false;

    // A script read from a file is `main` at the bottom of the call stack, and
    // the file its BASH_SOURCE; a string run as it is has no such frame
    if (opts.file !== undefined && !ctx.getArray('BASH_SOURCE')?.length) {
      ctx.setArray('FUNCNAME', []);
      ctx.setArray('BASH_SOURCE', [opts.file]);
      ctx.setArray('BASH_LINENO', ['0']);
    }

    // A script run a piece at a time goes on counting its lines from where it is
    const code = opts.line !== undefined && opts.line > 1
      ? await this.inSourceFrame({ base: opts.line - 1, name: this.sourceFrame.name }, () => this.executeSource(source, ctx))
      : await this.executeSource(source, ctx);

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
      unterminatedHereDocuments: this.unterminatedHereDocuments,
      // Aliases expand only under `shopt -s expand_aliases`, which an
      // interactive bash turns on and a script has to ask for
      resolveAlias: async (name: string) => ctx.getShellOption('expand_aliases') ? ctx.getAlias(name) : undefined,

      // Tildes are expanded as each word runs, with HOME as it is then
      deferTildeExpansion: true,
    };

    try {
      return await this.readAndRun(source, ctx, options);
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
   * What the parser takes from the shell as it reads: the aliases, while
   * `expand_aliases` is on, and POSIX mode, which changes what a `'` inside a
   * double-quoted `${…}` is.
   */
  private parseState(ctx: ExecContextIf): string {
    return JSON.stringify([ctx.getShellOption('posix'), ctx.getShellOption('expand_aliases') && ctx.getAliases()]);
  }

  /**
   * Run `source` as bash reads a script: a command at a time, each parsed with
   * the shell as the commands before it left it. An `alias` or `set -o posix`
   * applies from the next line on — the rest of its own line was read with it.
   * Parsing is done once, and again from the line after a command that changed
   * the aliases or POSIX mode; the text already run is blanked out, not cut
   * off, so that lines and offsets stay those of `source`.
   *
   * A syntax error stops it only once the complete commands before it have
   * run, and nothing runs from the error's own line; those commands may change
   * how the rest parses, so it is parsed again after them.
   */
  private async readAndRun(source: string, ctx: ExecContextIf, options: Parameters<typeof parse>[1]): Promise<number> {
    const lines = source.split('\n');
    // The line to read from next, 0-based
    let from = 0;
    let code = 0;

    while (from < lines.length) {
      const text = lines.map((line, i) => i < from ? ' '.repeat(line.length) : line).join('\n');
      const reparse: { state: string; resume?: number } = { state: this.parseState(ctx) };

      options = { ...options, posix: ctx.getShellOption('posix') };

      let ast: AstNodeScript;
      let end = lines.length;

      try {
        ast = await parse(text, options) as AstNodeScript;
      } catch (err) {
        if (!(err instanceof BashSyntaxError)) {
          throw err;
        }

        const complete = await this.completeCommandsBefore(lines, from, options);
        const prefix = (to: number) => lines.map((line, i) => i < from ? ' '.repeat(line.length) : line).slice(0, to).join('\n');

        if (complete.end === from) {
          throw err;
        }

        // Each chunk parses on its own; together they may not, where a quote in
        // one pairs with one in the next. Then the first runs alone, and what it
        // does to the shell — `set -o posix` — may make the rest parse.
        try {
          ast = await parse(prefix(complete.end), options) as AstNodeScript;
          end = complete.end;
        } catch (inner) {
          if (!(inner instanceof BashSyntaxError)) {
            throw inner;
          }

          ast = await parse(prefix(complete.first), options) as AstNodeScript;
          end = complete.first;
        }
      }

      code = await this.executeScript(ast, ctx, reparse);

      if (isExitSignal(code) || isReturnSignal(code)) {
        return code;
      }

      // Parsed again from where the shell changed, or on past a syntax error
      from = reparse.resume !== undefined ? reparse.resume - 1 : end;
    }

    return code;
  }

  /**
   * The line index before which `lines`, from `from` on, hold complete commands
   * ahead of the first syntax error (`end`), and where the first of those ends
   * (`first`). Lines are added to a chunk until it
   * parses; a chunk that is merely unfinished — an open `if`, a here-document
   * still to come — takes more, and the first that fails for good is where the
   * error is.
   */
  private async completeCommandsBefore(lines: string[], from: number, options: Parameters<typeof parse>[1]): Promise<{ end: number; first: number }> {
    let start = from;
    // Where the first complete chunk ends
    let first = from;

    // A here-document still open is a chunk to take more lines for, not one to take to the end
    const strict = { ...options, unterminatedHereDocuments: 'error' as const };

    for (let end = from; end < lines.length; end++) {
      try {
        await parse(lines.slice(start, end + 1).join('\n'), strict);
        start = end + 1;
        if (first === from) first = start;
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

    return { end: start, first };
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
   * The line a simple command is on, as bash counts it: the line it ends on,
   * `echo "a<newline>b" $LINENO` being on the second, though a line it goes
   * on to after a backslash, or inside a `$( )`, is still the first. The
   * source tells which, when it is the one the command came from.
   */
  private commandRow(node: AstNode): number | undefined {
    const loc = (node as { loc?: { start?: { row?: number; char?: number }; end?: { row?: number; char?: number } } }).loc;
    const start = loc?.start;
    const end = loc?.end;

    if (start?.row === undefined || end?.row === undefined || end.row === start.row) return start?.row;

    const text = start.char !== undefined && end.char !== undefined ? this.currentSource?.slice(start.char, end.char + 1) : undefined;

    // Not this command's text after all: its first line, as before
    if (text === undefined || (text.match(/\n/g)?.length ?? 0) !== end.row - start.row) return start.row;

    // Newlines in quotes count, those after a backslash or inside `$( )` do not
    let row = start.row;
    let depth = 0;
    let quote = '';

    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (c === '\\') {
        i++;
      } else if (quote === "'") {
        if (c === "'") quote = '';
      } else if (c === '$' && text[i + 1] === '(') {
        depth++;
        i++;
      } else if (depth > 0 && c === ')') {
        depth--;
      } else if (depth === 0 && (c === '"' || c === "'")) {
        quote = quote === c ? '' : quote || c;
      } else if (c === '\n' && depth === 0) {
        row++;
      }
    }

    return row;
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

    // `$LINENO` is the line of what runs now; a `$( )`, parsed without
    // locations, keeps the line of the command it is in
    const row = node.type === 'Command' ? this.commandRow(node) : (node as { loc?: { start?: { row?: number } } }).loc?.start?.row;

    if (row !== undefined && node.type !== 'Script') {
      ctx.setParams({ LINENO: String(this.sourceFrame.base + row) });
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

    // `time pipeline`, reported as it ends; `time ! cmd` times the negation
    if (node.time) {
      return this.executeTimed(node, ctx);
    }

    // `! ( … )`, `! { …; }`, `! if …`: a command and a pipeline negate their
    // own status; any other command is negated here. `set -e` does not act on
    // a negated command, so it runs with errexit held off
    if ((node as { bang?: boolean }).bang && node.type !== 'Command' && node.type !== 'Pipeline') {
      const inner = ctx.spawnContext();

      inner.setErrexitSuppressed(true);

      const code = await this.executeNode({ ...node, bang: false } as AstNode, inner);

      if (isExitSignal(code) || isReturnSignal(code) || isLoopControl(code)) {
        return code;
      }

      return code === 0 ? 1 : 0;
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
      case 'Coproc':
        return this.executeCoproc(node as AstNodeCoproc, ctx);
      default:
        throw new UnknownNodeTypeError(node.type, this.getSourceLocation(node), this.currentSource);
    }
  }

  /**
   * `time`: the elapsed time and the CPU time the pipeline used, the host's
   * commands' included, written to the shell's stderr in `TIMEFORMAT` (POSIX's
   * format after `-p`) once it ends. The status is the pipeline's own.
   */
  private async executeTimed(node: AstNode, ctx: ExecContextIf): Promise<number> {
    const started = performance.now();
    const before = await cpuTime(this.shell);
    const code = await this.executeNode({ ...node, time: undefined }, ctx);
    const after = await cpuTime(this.shell);

    const { text, warnings } = timeReport(ctx, node.time!.posix, {
      real: (performance.now() - started) / 1000,
      user: after.user + after.childrenUser - before.user - before.childrenUser,
      system: after.system + after.childrenSystem - before.system - before.childrenSystem,
    });

    for (const warning of warnings) {
      await this.diagnose(ctx, warning);
    }

    if (text) {
      await this.shell.pipeWrite(ctx.getStderr(), text).catch(() => {});
    }

    return code;
  }

  /** The coprocesses started, by the shell's descriptor for each end: `NAME[0]` reads its output, `NAME[1]` writes its input. */
  private coprocFds = new Map<string, { name: string; index: 0 | 1; pipe: string }>();

  /** The coprocesses still to be cleaned up after, with the job each runs as. */
  private coprocs: { name: string; fds: string[]; done: boolean }[] = [];

  /**
   * `coproc [NAME] command`: the command runs as a job with a pipe to its stdin
   * and one from its stdout. The shell holds the other ends under high
   * descriptors, picked as bash picks them (63 and 60 while nothing else has
   * those), in `NAME[0]` (to read) and `NAME[1]` (to write), with the job's pid
   * in `NAME_PID` and `$!`. The command sees end of input once the shell closes
   * `NAME[1]`, or ends.
   */
  protected async executeCoproc(node: AstNodeCoproc, ctx: ExecContextIf): Promise<number> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.name)) {
      await this.diagnose(ctx, `\`${node.name}': not a valid identifier`);
      return 1;
    }

    // A coprocess that has ended gives its descriptors back before the next takes some
    for (const done of this.coprocs.filter((coproc) => coproc.done)) {
      for (const fd of done.fds.filter((fd) => this.coprocFds.has(fd))) {
        this.coprocFds.delete(fd);
        ctx.closeFd(fd);
      }
    }
    this.coprocs = this.coprocs.filter((coproc) => !coproc.done);

    const input = await this.shell.pipeOpen();
    const output = await this.shell.pipeOpen();
    const free = this.freeHighFds(ctx, 4);
    const [readFd, writeFd] = [free[0], free[3]];
    const record = { name: node.name, fds: [readFd, writeFd], done: false };
    const command = this.nodeSource(node);

    const run = async (jobCtx: ExecContextIf): Promise<number> => {
      jobCtx.redirectStdin(input);
      jobCtx.redirectStdout(output);

      try {
        const code = await this.executeNode(node.body, jobCtx);

        return isExitSignal(code) ? getExitCode(code) : isReturnSignal(code) ? getReturnCode(code) : code;
      } finally {
        record.done = true;
        await this.shell.pipeClose(output).catch(() => {});
      }
    };

    let pid = '';

    if (this.shell.jobs) {
      const handle = await this.shell.jobs.start(ctx, run, command);

      ctx.getJobTable().add(handle, command);
      pid = handle.pid;
    } else if (this.shell.executeBackground) {
      await this.shell.executeBackground(ctx, run, command);
    } else {
      handled(run(this.subshellOf(ctx)));
    }

    this.coprocs.push(record);
    this.coprocFds.set(readFd, { name: node.name, index: 0, pipe: output });
    this.coprocFds.set(writeFd, { name: node.name, index: 1, pipe: input });
    ctx.redirectFd(readFd, output);
    ctx.redirectFd(writeFd, input);
    ctx.setArray(node.name, [readFd, writeFd]);
    ctx.setParams({ [`${node.name}_PID`]: pid, '!': pid });

    return 0;
  }

  /** `count` descriptors below 64 that are not in use, highest first, as bash moves a new pipe's ends up out of the way. */
  private freeHighFds(ctx: ExecContextIf, count: number): string[] {
    const free: string[] = [];

    for (let fd = 63; fd > 2 && free.length < count; fd--) {
      if (ctx.getFd(String(fd)) === undefined) free.push(String(fd));
    }

    return free;
  }

  /**
   * A descriptor the shell closed or moved away. When it was a coprocess's end,
   * its element of `NAME` becomes -1, as in bash; and when nothing else holds
   * the pipe to the coprocess's input, it sees the input end.
   */
  private async descriptorClosed(ctx: ExecContextIf, fd: string): Promise<void> {
    const end = this.coprocFds.get(fd);

    if (!end) return;

    this.coprocFds.delete(fd);

    if (ctx.getArray(end.name)?.[end.index] === fd) {
      ctx.setArrayElement(end.name, end.index, '-1');
    }

    if (end.index === 1) {
      for (let n = 0; n < 256; n++) {
        if (ctx.getFd(String(n)) === end.pipe) return;
      }

      await this.shell.pipeClose(end.pipe).catch(() => {});
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
   * A descriptor above 2 is the command's own, `cmd 3<file`, and gone with its
   * context — unless `exec` makes it (`opts.exec`), or the redirection names a
   * variable for it, `{fd}<file`: those are the shell's, and stay open.
   *
   * @param subs - Collects the process substitutions in the redirection targets,
   *               `cmd > >(other)`
   * @returns The pipes and descriptors opened on the command's behalf — a
   *          here-string has no file behind it — which the caller releases with
   *          `releaseTemporary` when the command is done.
   */
  protected async applyRedirections(
    ctx: ExecContextIf,
    redirects?: AstNodeRedirect[],
    subs?: ProcessSubstitutions,
    opts: { exec?: boolean } = {},
  ): Promise<string[]> {
    const temporary: string[] = [];

    for (let r of (redirects || [])) {
      const named = r.numberIo?.text.match(/^\{(.+)\}$/)?.[1];

      if (named) {
        r = await this.namedDescriptor(ctx, r, named);
      }

      // The shell's own, or this command's
      const local = !opts.exec && !named;
      const fd = r.numberIo?.text;
      const opensFile = fd !== undefined && Number(fd) > 2 && !r.heredoc && ['<', '>', '>|', '>>', '<>'].includes(r.op.text);

      // `{fd}<file`: opened as `exec` opens one, to stay
      if (opensFile && !local && await this.openExecRedirection(ctx, r)) {
        continue;
      }

      const target = await this.redirectTarget(r, ctx, subs);

      // `N<file`, `N>file` and the like, N above 2: a descriptor of its own, not a path
      // to reopen at every write, closed with the command
      if (opensFile && local) {
        if (this.shell.fdOpen) {
          if (r.op.text === '>') await this.assertClobberable(ctx, target);
          await this.assertOpenable(ctx, target, r.op.text === '<' ? 'read' : 'write');

          const modes: Record<string, string> = { '<': 'r', '>': 'w+', '>|': 'w+', '>>': 'a+', '<>': 'r+' };
          const handle = await this.shell.fdOpen(ctx, target, modes[r.op.text]);

          this.redirectHandles.add(handle);
          temporary.push(handle);
          ctx.redirectFd(fd, handle, local);
          continue;
        }
      }

      if (r.heredoc) {
        // One the input ended in: bash warns, on the input's last line, and takes it as it is
        const unterminated = r.heredoc.unterminated;

        if (unterminated) {
          const line = ctx.getParam('LINENO');

          ctx.setParams({ LINENO: String(this.sourceFrame.base + unterminated.endLine) });
          await this.diagnose(
            ctx,
            `warning: here-document at line ${this.sourceFrame.base + unterminated.line} delimited by end-of-file (wanted \`${unterminated.delimiter}')`,
          );
          if (line !== undefined) ctx.setParams({ LINENO: line });
        }

        // A here-document: its text, expanded unless the delimiter was quoted, fed in as stdin the
        // way a here-string is.
        const text = r.heredoc.quoted ? r.heredoc.body : await this.expandHereDocument(r.heredoc.body, ctx);
        const pipe = await this.shell.pipeOpen();

        // The shell's own stays for what comes after
        if (local) temporary.push(pipe);
        handled(this.shell.pipeWrite(pipe, text).then(() => this.shell.pipeClose(pipe)));
        // `3<<EOF`: another descriptor than stdin
        if (fd) ctx.redirectFd(fd, pipe, local);
        else ctx.redirectStdin(pipe);
      } else if (r.op.text === '<') {
        await this.assertOpenable(ctx, target, 'read');
        if (fd) ctx.redirectFd(fd, target, local);
        else ctx.redirectStdin(target);
      } else if (r.op.text === '<<<') {
        // A here-string is the word plus a newline, fed in as stdin. The write
        // is detached: a string larger than the pipe holds only completes once
        // the command starts reading, which it cannot do until this returns.
        const pipe = await this.shell.pipeOpen();

        if (local) temporary.push(pipe);
        handled(this.shell.pipeWrite(pipe, `${target}\n`).then(() => this.shell.pipeClose(pipe)));
        if (fd) ctx.redirectFd(fd, pipe, local);
        else ctx.redirectStdin(pipe);
      } else if (r.op.text === '>' || r.op.text === '>|') {
        // `set -C` refuses to truncate a file that exists; `>|` says do it anyway
        if (r.op.text === '>') {
          await this.assertClobberable(ctx, target);
        }

        await this.assertOpenable(ctx, target, 'write');
        this.redirectOutput(ctx, fd, target, false, local);
      } else if (r.op.text === '>>') {
        await this.assertOpenable(ctx, target, 'write');
        this.redirectOutput(ctx, fd, target, true, local);
      } else if (r.op.text === '>&' || r.op.text === '<&') {
        const sourceFd = fd || (r.op.text === '>&' ? '1' : '0');

        // Close FD: N>&- or >&-. A command's closing hides the descriptor from
        // it alone; the shell's closes it for good.
        if (target === '-') {
          if (local && Number(sourceFd) > 2) {
            ctx.closeFd(sourceFd, true);
            continue;
          }

          await this.shell.fdClose?.(sourceFd);
          ctx.closeFd(sourceFd);
          await this.descriptorClosed(ctx, sourceFd);
          continue;
        }

        // Move FD: N>&M- is N>&M and then M>&-
        if (/^\d+-$/.test(target)) {
          await this.moveDescriptor(ctx, sourceFd, target.slice(0, -1), local);
          continue;
        }

        if (/^\d+$/.test(target)) {
          // Duplicate: the source becomes whatever the target is now
          ctx.redirectFd(sourceFd, ctx.getFd(target) ?? target, local);
        } else if (r.op.text === '<&') {
          ctx.redirectStdin(target);
        } else if (sourceFd === '2') {
          // `>&file`, a file name rather than a descriptor: stdout and stderr both, as `&>`
          ctx.redirectStderr(target);
        } else {
          ctx.redirectStdout(target);
        }
      } else if (r.op.text === '<>') {
        if (this.shell.fdOpen) {
          await this.shell.fdOpen(ctx, target, 'r+', fd || '0');
        }
      }
    }

    return temporary;
  }

  /**
   * The word of a redirection, expanded as bash expands it: to one word, or
   * the redirection is ambiguous — `> $f` with f='a b', or f empty, writes
   * nowhere rather than to `a`. Pathname expansion takes part, except in
   * POSIX mode, and must find one file too. A here-string's word is one word
   * whatever it holds, neither split nor globbed.
   */
  private async redirectTarget(r: AstNodeRedirect, ctx: ExecContextIf, subs?: ProcessSubstitutions): Promise<string> {
    // A here-document's word is its delimiter, not a file
    if (r.heredoc) return r.file.text;

    if (r.op.text === '<<<') {
      const { values } = await this.resolveExpansions(r.file, ctx, subs, { split: false, glob: false });

      return values.join(' ');
    }

    const { values } = await this.resolveExpansions(r.file, ctx, subs, { glob: !ctx.getShellOption('posix') });

    if (values.length !== 1) {
      throw new RedirectionError(`${r.file.text}: ambiguous redirect`);
    }

    return values[0];
  }

  /** Descriptors `applyRedirections` opened for one command, closed rather than removed when it is done. */
  private redirectHandles = new Set<string>();

  /** Let go of a pipe or descriptor `applyRedirections` opened for a command that is done. */
  protected async releaseTemporary(name: string): Promise<void> {
    if (this.redirectHandles.delete(name)) {
      await this.shell.fdClose?.(name).catch(() => {});
    } else {
      await this.shell.pipeRemove(name).catch(() => {});
    }
  }

  /**
   * `{name}>file`: the descriptor the shell picks for it, 10 or above and not in
   * use, put in `name` — or, for `{name}>&-`, the one `name` holds, to close.
   * The redirection comes back with that number in place of the name.
   */
  private async namedDescriptor(ctx: ExecContextIf, r: AstNodeRedirect, name: string): Promise<AstNodeRedirect> {
    const numbered = (fd: string) => ({ ...r, numberIo: { ...r.numberIo!, text: fd } }) as AstNodeRedirect;

    if ((r.op.text === '>&' || r.op.text === '<&') && r.file.text === '-') {
      const fd = ctx.getParam(name) ?? '';

      if (!/^\d+$/.test(fd)) {
        throw new RedirectionError(`${name}: ambiguous redirect`);
      }

      this.namedFds.delete(Number(fd));

      return numbered(fd);
    }

    if (ctx.getVariable(name)?.attributes.includes('r')) {
      throw new RedirectionError(`${name}: readonly variable\n${name}: cannot assign fd to variable`);
    }

    let n = 10;

    while (this.namedFds.has(n) || ctx.getFd(String(n)) !== undefined) n++;

    this.namedFds.add(n);
    ctx.setParams({ [name]: String(n) });

    return numbered(String(n));
  }

  /** `N<&M-`, `N>&M-`: N becomes what M was, and M is closed — for the command alone when `local`. */
  private async moveDescriptor(ctx: ExecContextIf, fd: string, from: string, local = false): Promise<void> {
    const target = ctx.getFd(from);

    if (target === undefined) {
      throw new CommandAbortError(`${from}: Bad file descriptor`, { code: 'E_BAD_FD' });
    }

    ctx.redirectFd(fd, target, local);

    if (Number(from) > 2) {
      ctx.closeFd(from, local);
    }

    if (!local) {
      await this.descriptorClosed(ctx, from);
    }
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

    // `{fd}>file` is left to applyRedirections, which picks the number first
    if (!this.shell.fdOpen || !mode || r.heredoc || r.numberIo?.text.startsWith('{')) {
      return false;
    }

    const fd = r.numberIo?.text ?? (r.op.text === '<' ? '0' : '1');
    const target = await this.redirectTarget(r, ctx);

    if (r.op.text === '>') {
      await this.assertClobberable(ctx, target);
    }

    await this.assertOpenable(ctx, target, r.op.text === '<' ? 'read' : 'write');

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
   * `N>file`, for one command when `local`. A descriptor above 2 lands here only
   * when the host cannot open files, and so points at the path itself.
   */
  private redirectOutput(ctx: ExecContextIf, fd: string | undefined, target: string, append: boolean, local = false): void {
    if (fd === '2') {
      ctx.redirectStderr(target, append);
    } else if (fd === undefined || fd === '1') {
      ctx.redirectStdout(target, append);
    } else {
      ctx.redirectFd(fd, target, local);
    }
  }

  /**
   * Whether a redirection's file can be opened, as bash finds out by opening
   * it before the command runs: a file to read must be there, and one to
   * write must have somewhere to go. The host answers through `testPath`, with
   * no more asked of it than whether a path exists — a host's tree need not
   * tell directories from files, nor hold /dev — and without it nothing is
   * refused. What else a host cannot open it reports as it opens it.
   */
  protected async assertOpenable(ctx: ExecContextIf, target: string, mode: 'read' | 'write'): Promise<void> {
    // No name is no file, `> ""`, whatever the host would make of it
    if (target === '') throw new RedirectionError(': No such file or directory');

    if (!this.shell.testPath || this.shell.isPipe(target) || /^\d+$/.test(target) || target.startsWith('/dev/')) return;

    const exists = (path: string) => this.shell.testPath!(ctx, path, 'EXISTS').catch(() => true);

    if (mode === 'read') {
      if (!(await exists(target))) throw new RedirectionError(`${target}: No such file or directory`);
      return;
    }

    const slash = target.lastIndexOf('/');

    if (slash > 0 && !(await exists(target.slice(0, slash)))) throw new RedirectionError(`${target}: No such file or directory`);
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
  /**
   * @param reparse - For a script read from its source: stop at the first line
   *                  after the shell changed from `state` in a way that parses
   *                  differently, and say in `resume` which one it is (1-based)
   */
  protected async executeScript(node: AstNodeScript, ctx: ExecContextIf, reparse?: { state: string; resume?: number }): Promise<number> {
    try {
      return await this.runScriptCommands(node, ctx, reparse);
    } catch (err) {
      // An unset parameter under `set -u` ends this shell, and a command
      // substitution is a shell of its own — it parses to its own Script, so
      // catching here is what lets `$(echo "$NOPE")` die while the shell around
      // it carries on, which is what bash does.
      if (!(err instanceof UnboundVariableError)) {
        throw err;
      }

      if (!err.reported) await this.diagnose(ctx, err.message);

      // Measured: bash leaves 1 behind for an expansion error, 127 when it
      // runs a -c string; under `set -e` the shell goes out through errexit
      // with the command's own 1, and a `$( )` that dies of one leaves 1
      const code = this.commandString && !ctx.getShellOption('errexit') && !this.inSubshell(ctx) ? UNBOUND_VARIABLE_CODE : 1;

      ctx.setParams({ '?': String(code) });

      return code;
    }
  }

  private async runScriptCommands(node: AstNodeScript, ctx: ExecContextIf, reparse?: { state: string; resume?: number }): Promise<number> {
    let lastCode = 0;
    // The line a command that was aborted stood on: the rest of it does not run
    let skipRow: number | undefined;
    // The last line read with the shell as it now is not: the one the command that changed it ended on
    let staleAfter: number | undefined;

    for (const command of node.commands) {
      const row = command.loc?.start?.row;

      if (staleAfter !== undefined && row !== undefined && row > staleAfter) {
        reparse!.resume = row;
        return lastCode;
      }

      // A script with no locations — a `$( )` is parsed without — is one line
      if (skipRow !== undefined && (command.loc?.start?.row ?? -1) === skipRow) {
        continue;
      }

      skipRow = undefined;

      await this.echoSource(command, ctx);

      // `set -n` reads the rest without running it. There is no turning it back
      // off from inside the script — bash cannot either, for the same reason.
      if (ctx.getShellOption('noexec')) {
        return lastCode;
      }

      try {
        lastCode = await this.executeNode(command, ctx);
      } catch (err) {
        if (!(err instanceof CommandAbortError)) {
          throw err;
        }

        // What is left of the line goes too, as in bash
        lastCode = await this.abortStatus(err, ctx);
        skipRow = command.loc?.start?.row ?? -1;

        // A POSIX shell that fails an assignment, or an expansion, ends there
        if (ctx.getShellOption('posix')) {
          if (err instanceof ReadonlyVariableError) lastCode = makeExitSignal(1);
          if (err.code === 'E_BAD_SUBSTITUTION') lastCode = makeExitSignal(UNBOUND_VARIABLE_CODE);
        }
      }

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

      if (reparse && command.loc?.end?.row !== undefined && (staleAfter !== undefined || this.parseState(ctx) !== reparse.state)) {
        staleAfter = command.loc.end.row;
      }

      // Note: Non-zero exit codes do NOT stop script execution
      // (unless set -e is enabled, which we'd need to check here)
    }

    return lastCode;
  }

  /**
   * A command that was aborted — an arithmetic error, an assignment to a
   * readonly variable — says why, and leaves 1 behind; `set -e` gets its say.
   */
  protected async abortStatus(err: CommandAbortError, ctx: ExecContextIf): Promise<number> {
    await this.diagnose(ctx, err.message);

    return this.applyErrexit(1, ctx);
  }

  /**
   * Before a simple command, `[[`, `((` and each expression of `for ((`: set
   * `$BASH_COMMAND` to it and run the DEBUG trap — in a function only under
   * `set -T`, since functions do not inherit it otherwise.
   * @returns The exit signal when the trap ended the shell, else undefined
   */
  private async debugTrap(node: AstNode, ctx: ExecContextIf): Promise<number | undefined> {
    if (node.loc) {
      ctx.setParams({ BASH_COMMAND: this.nodeSource(node) });
    }

    if (ctx.getTrap('DEBUG') && (this.functionDepth === 0 || ctx.getShellOption('functrace'))) {
      // The trap's own lines are its own: what runs after it is still on this one
      const line = ctx.getParam('LINENO');
      const trapped = await this.runTrap('DEBUG', ctx, Number(ctx.getParam('?') ?? 0));

      if (line !== undefined) ctx.setParams({ LINENO: line });
      if (isExitSignal(trapped)) return trapped;
    }

    return undefined;
  }

  protected async executeCommand(node: AstNodeCommand, parentCtx: ExecContextIf): Promise<number> {
    const trapped = await this.debugTrap(node, parentCtx);

    if (trapped !== undefined) return trapped;

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
      // `exec >file &` runs in a background subshell: it opens the file there,
      // and the shell's own descriptors stay as they were
      if (node.async) {
        const code = await this.runCommand({ ...node, async: false }, this.subshellOf(parentCtx));

        return isExitSignal(code) ? getExitCode(code) : code;
      }

      const redirects = node.suffix?.filter((arg) => arg.type === 'Redirect') as AstNodeRedirect[] | undefined;
      const words = (node.suffix?.filter((arg) => arg.type === 'Word') ?? []) as AstNodeWord[];

      // `-a name` runs the command as `name`, `-l` as a login shell's `-name`, `-c` with no environment
      const options: ExecCommandOptions = {};
      let login = false;

      while (words[0] && /^-[acl]+$/.test(words[0].text) && !words[0].expansion?.length) {
        const flags = words.shift()!.text.slice(1);

        if (flags.includes('c')) options.clearEnv = true;
        if (flags.includes('l')) login = true;

        if (flags.includes('a')) {
          if (!words[0]) {
            await this.diagnose(parentCtx, 'exec: -a: option requires an argument');
            return 2;
          }

          options.argv0 = await this.resolveWordValue(words.shift(), parentCtx);
        }
      }

      if (words[0]?.text === '--') {
        words.shift();
      } else if (words[0] && /^-./.test(words[0].text) && !words[0].expansion?.length) {
        // An option exec does not know leaves the shell standing, with a usage message
        const bad = words[0].text.slice(0, 2);

        await this.diagnose(parentCtx, `exec: ${bad}: invalid option\nexec: usage: exec [-cl] [-a name] [command [argument ...]] [redirection ...]`);
        return 2;
      }

      // `exec cmd args`: the command takes the shell's place, so the shell ends
      // with its status. The redirections are the command's own.
      if (words.length > 0) {
        if (login) options.argv0 = `-${options.argv0 ?? words[0].text}`;

        const command = { ...node, name: words[0], suffix: [...words.slice(1), ...(redirects ?? [])], execOptions: options };
        const code = await this.runCommand(command, parentCtx);

        // A command that could not be run leaves the shell standing only under `shopt -s execfail`
        if ((code === 126 || code === 127) && parentCtx.getShellOption('execfail')) {
          return code;
        }

        return isExitSignal(code) ? code : makeExitSignal(code);
      }

      try {
        for (const redirect of redirects ?? []) {
          if (!(await this.openExecRedirection(parentCtx, redirect))) {
            await this.applyRedirections(parentCtx, [redirect], undefined, { exec: true });
          }
        }
      } catch (err) {
        if (!(err instanceof RedirectionError)) throw err;

        // A POSIX shell that cannot make exec's redirections ends, as for any special builtin
        await this.diagnose(parentCtx, err.message);

        return parentCtx.getShellOption('posix') ? makeExitSignal(1) : 1;
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

    // Assignments are made left to right, each expanded with the ones before it
    // in effect: `a=1 b=$a` gives b 1. Before a command they come after its
    // words and redirections are expanded — `x=new echo $x` prints the old x —
    // and last only the command sees them, except, in POSIX mode, before a
    // special builtin, where they persist
    const special = ctx.getShellOption('posix') && node.name && !node.name.expansion?.length && SPECIAL_BUILTINS.has(node.name.text);
    // Whether an assignment before the command was refused, a readonly variable
    let refused = false;
    // `asCommand`: they stand before a command, which is the only one to see them;
    // before nothing — `x=1`, or `x=1 $empty` — they are the shell's
    const assign = async (asCommand: boolean) => {
      for (const arg of node.prefix?.filter((arg) => arg.type === 'AssignmentWord') || []) {
        const assignment = await this.resolveAssignment(arg, ctx);

        if (!assignment) {
          continue;
        }

        assignStatus = assignment.status;
        await this.trace(parentCtx, this.traceAssignment(assignment));
        refused = !(await this.applyAssignment(assignment, special ? parentCtx : ctx, asCommand && !special)) || refused;
      }
    };

    if (!node.name) {
      await assign(false);
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
    const arrayRefs = new Set<string>();

    // Words expand left to right, the name first: `$(a) $(b)` runs a before b
    const expandedName = await this.resolveExpansions(node.name, ctx, subs);

    for (const arg of node.suffix?.filter((arg) => arg.type === 'Word') || []) {
      const assignment = declaration ? utils.parseAssignmentWord(arg.text) : null;

      if (assignment) {
        // `declare -A h=(k v)`: an associative array before the builtin has made it one
        const assoc = args.some((option) => /^-[A-Za-z]*A/.test(option));

        args.push(await this.resolveDeclarationArg(arg, ctx, assignment, assoc));
        continue;
      }

      const { values } = await this.resolveExpansions(arg, ctx, subs);

      args.push(...values);

      // Written as `name[sub]`, bash's W_ARRAYREF: unset expands the subscript no more
      if (ARRAYREF_BUILTINS.has(literalName) && isArrayReference(this.writtenText(arg) ?? arg.text)) {
        for (const value of values) arrayRefs.add(value);
      }
    }

    // Apply IO redirections
    const redirectPipes = await this.applyRedirections(ctx, redirects, subs);

    // A name that expands to nothing leaves the next word to be the command, and
    // one that expands to several makes the rest arguments: `$empty echo hi` runs
    // echo, `$cmd` with cmd='ls -l' runs ls. When every word is gone there is no
    // command at all, only the redirections, and the status is that of the last
    // command substitution.
    const words = [...expandedName.values, ...args];

    await assign(words.length > 0);

    // POSIX: a command whose assignment was refused does not run; before a special builtin the shell ends
    if (refused && ctx.getShellOption('posix') && words.length > 0) {
      await this.finishProcessSubstitutions(subs, ctx);
      return special ? makeExitSignal(1) : this.applyErrexit(1, ctx);
    }

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
    if (cmdName === 'break' || cmdName === 'continue') {
      return this.loopControl(cmdName, args, ctx);
    }
    let code: number;

    return this.withFileBridging(ctx, async () => {
      // Check for builtin first
      const builtin = this.builtin(cmdName);
      if (builtin) {
        // A sourced file counts its own lines; an eval's string goes on from its line
        const execute = (script: string, opts: { file?: string } = {}) =>
          opts.file !== undefined
            ? this.inCallFrame(ctx, 'source', opts.file, () => this.inSourceFrame({ base: 0, name: opts.file }, () => this.executeSource(script, ctx)))
            : this.inSourceFrame({ base: Number(ctx.getParam('LINENO') ?? 1) - 1, name: this.sourceFrame.name }, () => this.executeSource(script, ctx));
        const result = await builtin(ctx, args || [], this.shell, execute, {
          expandSubscript: (subscript, keyed) => this.arithmeticSubscript(subscript, keyed, ctx),
          arrayRefs,
          reportSyntaxError: (err, where, source) => this.reportSyntaxError(ctx, err, where, source),
        });

        code = result.code;

        // Write stdout/stderr if present. Output that cannot be written — stdout
        // closed with `>&-`, or a descriptor open only for reading — fails the
        // builtin, as bash's "write error", and not the script.
        try {
          for (const chunk of result.output ?? []) {
            if (chunk.stderr) await this.diagnose(ctx, chunk.stderr);
            if (chunk.stdout) await this.shell.pipeWrite(ctx.getStdout(), chunk.stdout);
          }

          if (result.stdout) {
            await this.shell.pipeWrite(ctx.getStdout(), result.stdout);
          }
        } catch (err) {
          await this.diagnose(ctx, `${cmdName}: write error: ${err instanceof Error ? err.message : err}`);
          code = 1;
        }

        if (result.stderr) {
          await this.diagnose(ctx, result.stderr);
        }
      } else {
        // Check for function
        const fn = ctx.getFunction(cmdName);
        if (fn) {
          code = await this.executeFunction(ctx, fn, args || []);
        } else {
          // Execute external command: a hashed one from the file it was hashed to
          const hashed = cmdName.includes('/') ? undefined : hashedCommand(ctx, cmdName);

          code = await this.shell.execute(
            ctx,
            hashed ?? cmdName,
            args || [],
            {
              async: node.async,
              ...(node as { execOptions?: ExecCommandOptions }).execOptions,
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
      const cmdCtx = this.subshellOf(ctx, true);

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
    fn: { name: string; body: AstNodeCompoundList; ctx: ExecContextIf; definition?: FunctionDefinition },
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

    // FUNCNEST caps how deep functions may call: going deeper aborts the whole command
    const funcnest = Number.parseInt(ctx.getParam('FUNCNEST') ?? '', 10);

    if (funcnest > 0 && this.functionDepth >= funcnest) {
      throw new CommandAbortError(`${fn.name}: maximum function nesting level exceeded (${funcnest})`, { code: 'E_FUNCNEST' });
    }

    const returnTrap = ctx.getTrap('RETURN');
    const getopts = ctx.getGetoptsState();
    // A function is in no loop of its own, whatever loop it was called from
    const loopDepth = this.loopDepth;

    this.functionDepth++;
    this.loopDepth = 0;

    // Back from the function, $LINENO is the line it was called on again: an
    // ERR trap for a failing call says that line, not the body's last
    const callLine = ctx.getParam('LINENO');
    let result: number;

    // The function's own redirections, `f() { …; } > log`, are expanded and opened each time it runs
    const redirections = fn.definition?.node.redirections;
    const run = async () => {
      if (!redirections?.length) return await this.executeNode(fn.body, fnCtx);

      const pipes = await this.applyRedirections(fnCtx, redirections);

      return await this.withFileBridging(fnCtx, () => this.executeNode(fn.body, fnCtx), pipes);
    };

    try {
      // Its lines are counted as where it was defined counted them: a function
      // from an eval, or from an earlier piece of a script read from stdin
      const frame = this.functionFrames.get(fn.body);
      const counted = frame ? () => this.inSourceFrame(frame, run) : run;

      result = await this.inCallFrame(fnCtx, fn.name, this.functionSources.get(fn.body) ?? 'environment', counted);
    } finally {
      this.functionDepth--;
      this.loopDepth = loopDepth;

      // A function with a `local OPTIND` hands the caller's getopts back as it
      // found it, so a getopts loop can call one that has a loop of its own
      if ('OPTIND' in fnCtx.getOwnVariables()) ctx.setGetoptsState(getopts);
    }

    // An error that ends the function is said where it happened; a return is back on the call's line
    if (callLine !== undefined) ctx.setParams({ LINENO: callLine });

    // Convert return signal to actual return code
    const code = isReturnSignal(result) ? getReturnCode(result) : result;

    // The RETURN trap runs as the function returns — one the function set itself,
    // or the caller's under `set -T`: functions do not inherit it otherwise
    const inherited = ctx.getShellOption('functrace') || ctx.getTrap('RETURN') !== returnTrap;

    // Not while a trap runs, though: a function the DEBUG trap calls sets off no RETURN trap
    if (!isExitSignal(code) && inherited && this.runningTraps.size === 0) {
      const trapped = await this.runTrap('RETURN', fnCtx, code);

      if (isExitSignal(trapped)) {
        return trapped;
      }
    }

    return code;
  }

  protected async executeSubshell(node: AstNodeSubshell, parentCtx: ExecContextIf): Promise<number> {
    // `( … ) 2>&1`: its own redirections are in place for all of it, the
    // complaints it ends with included
    const code = await this.withCompoundRedirections(node, parentCtx, async (redirected) => {
      // `( … )` is a subshell: env/cwd changes inside must not escape to the parent.
      const ctx = this.subshellOf(redirected);
      // A subshell is a top level of its own: an aborted command ends it, not the
      // shell, and so does an unset parameter under `set -u`
      const result = await this.withFileBridging(ctx, () => {
        return this.executeNode(node.list, ctx);
      }).catch(async (err) => {
        if (err instanceof CommandAbortError) return this.abortStatus(err, ctx);
        if (!(err instanceof UnboundVariableError)) return Promise.reject(err);

        // A subshell that dies of an unset parameter leaves 1, as bash's does
        if (!err.reported) await this.diagnose(ctx, err.message);

        return 1;
      });

      // `(exit 3)` ends the subshell, not the shell: to the caller it is status 3.
      // Its EXIT trap runs as it ends.
      return await this.runExitTrap(ctx, isExitSignal(result) ? getExitCode(result) : isReturnSignal(result) ? getReturnCode(result) : result);
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
        await this.releaseTemporary(pipe);
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
    const cmdCtx = this.subshellOf(ctx, true);
    cmdCtx.setLocalEnv({ TERM: '0' });

    // `$( )` does not inherit `set -e`, unless in POSIX mode or under
    // `shopt -s inherit_errexit`; a `set -e` inside it applies as anywhere
    if (!ctx.getShellOption('posix') && !ctx.getShellOption('inherit_errexit')) {
      cmdCtx.setShellOption('errexit', false);
    }

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
        const cmdCtx = isLastCommand && lastpipe ? ctx.spawnContext() : this.subshellOf(ctx);

        // A stage is a subshell, and `set -e` ends it as it would any — the
        // last one under lastpipe is the shell, and ends the shell; the shell
        // otherwise looks only at what finishPipeline makes of them all. Under
        // `!` nothing in the pipeline is subject to it
        if (node.bang) {
          cmdCtx.setErrexitSuppressed(true);
        }

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
            this.executeNode(node.commands[n], cmdCtx).catch(async (err) => {
              // A stage is a subshell, and an aborted command ends only it — unless lastpipe made it the shell
              if (isLastCommand && lastpipe) return Promise.reject(err);
              if (err instanceof CommandAbortError) return this.abortStatus(err, cmdCtx);
              if (!(err instanceof UnboundVariableError)) return Promise.reject(err);

              // Measured: 1, or under -c 127 for a simple command, as bash's stages leave
              if (!err.reported) await this.diagnose(cmdCtx, err.message);

              return this.commandString && node.commands[n].type === 'Command' ? UNBOUND_VARIABLE_CODE : 1;
            }).finally(() => {
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

      return isLoopControl(code) ? 0 : code;
    });

    ctx.setArray('PIPESTATUS', statuses.map((status) => String(status)));

    // Every stage is a subshell, the last one too: `echo x | exit 5` ends that
    // stage, not the shell, and leaves 5 behind. Under lastpipe the last stage is
    // the shell, and an `exit` or `return` there is the shell's.
    const lastCode = codes[codes.length - 1];

    if (lastpipe && (isExitSignal(lastCode) || isReturnSignal(lastCode) || isLoopControl(lastCode))) {
      return lastCode;
    }

    let code = statuses[statuses.length - 1];

    if (ctx.getShellOption('pipefail')) {
      const failed = statuses.findLast((status) => status !== 0);

      code = failed ?? 0;
    }

    // `! pipeline` is not subject to `set -e`, whatever its status
    return node.bang ? (code === 0 ? 1 : 0) : this.applyErrexit(code, ctx);
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
    if (code === 0 || isExitSignal(code) || isReturnSignal(code) || isLoopControl(code)) {
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

  /**
   * A syntax error in eval's string or a sourced file, said as bash says it:
   * `$0: eval: line N:`, counting from the eval's own line, or `file: line N:`.
   */
  private async reportSyntaxError(
    ctx: ExecContextIf,
    err: BashSyntaxError,
    where: { eval: true } | { file: string } | { substitution: true },
    source: string,
  ): Promise<void> {
    const { line, lines } = syntaxErrorLines(err, err.source ?? source);
    const params = ctx.getParams();
    const name = this.sourceFrame.name ?? params['0'] ?? 'bash';
    const at = (n: number) => this.lineNumbers ? `line ${n}: ` : '';
    // Without line numbers a diagnostic has no place before it, and this one just who said it
    const shell = this.lineNumbers ? `${name}: ` : '';
    const prefix = 'eval' in where
      ? `${shell}eval: ${at(Number(params.LINENO ?? 1) + line - 1)}`
      : 'substitution' in where
      ? `${shell}command substitution: ${at(Number(params.LINENO ?? 1) + line)}`
      : `${where.file}: ${at(line)}`;

    await this.shell.pipeWrite(ctx.getStderr(), lines.map((text) => `${prefix}${text}\n`).join('')).catch(() => {});
  }

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

    // Its lines count on from the line that set it off, as an eval's do —
    // `trap 'echo "failed on $LINENO"' ERR` — bar the EXIT trap's, which bash
    // counts from 1
    const line = ctx.getParam('LINENO');
    const base = name === 'EXIT' ? 0 : Number(line ?? 1) - 1;

    try {
      const code = await this.inSourceFrame({ base, name: this.sourceFrame.name }, () => this.executeSource(action, ctx));

      if (isExitSignal(code)) {
        return code;
      }
    } catch (err) {
      if (!(err instanceof BashSyntaxError)) throw err;

      await this.diagnose(ctx, `trap: syntax error: ${err.message.split('\n')[0]}`);
    } finally {
      this.runningTraps.delete(name);
      ctx.setParams({ '?': String(status) });
      if (line !== undefined) ctx.setParams({ LINENO: line });
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

    await this.runTrap(name, ctx, Number(ctx.getParam('?') ?? 0));

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

  /** How deep in substitutions each subshell the executor started is, by its context. */
  private substitutionDepths = new WeakMap<ExecContextIf, number>();

  /** A subshell of `ctx`, and one level deeper in substitutions when it is one — `$( )`, `<( )` or `>( )`. */
  private subshellOf(ctx: ExecContextIf, substitution = false): ExecContextIf {
    const sub = ctx.subContext(true);

    this.substitutionDepths.set(sub, this.substitutionDepth(ctx) + (substitution ? 1 : 0));

    return sub;
  }

  /**
   * What a tilde prefix stands for, or undefined to leave it as written: `~`
   * is HOME, `~+` PWD, `~-` OLDPWD, `~2`/`~-1` an entry of the directory
   * stack (`dirs`), `~user` that user's home, as the host knows it.
   */
  private async tildeValue(prefix: string, ctx: ExecContextIf): Promise<string | undefined> {
    if (prefix === '') {
      return ctx.getParam('HOME') ?? await this.shell.resolveHomeUser?.(ctx, null).catch(() => undefined);
    }

    if (prefix === '+') return ctx.getParam('PWD') ?? ctx.getCwd();
    if (prefix === '-') return ctx.getParam('OLDPWD');

    const index = /^([+-]?)(\d+)$/.exec(prefix);

    if (index) {
      const stack = [ctx.getCwd(), ...ctx.getDirStack()];

      return stack[index[1] === '-' ? stack.length - 1 - Number(index[2]) : Number(index[2])];
    }

    const home = await this.shell.resolveHomeUser?.(ctx, prefix).catch(() => undefined);

    return home && home !== `~${prefix}` ? home : undefined;
  }

  /** Whether the script running is a `bash -c` string, which an unset parameter ends with 127. */
  private commandString = false;

  /** Whether `ctx` runs in a subshell, `( … )` or `$( … )`, rather than the shell itself. */
  private inSubshell(ctx: ExecContextIf): boolean {
    for (let at: ExecContextIf | undefined = ctx; at; at = at.getParent()) {
      if (this.substitutionDepths.has(at)) return true;
    }

    return false;
  }

  /** How many command substitutions `ctx` runs inside, found on the subshell it belongs to. */
  private substitutionDepth(ctx: ExecContextIf): number {
    for (let at: ExecContextIf | undefined = ctx; at; at = at.getParent()) {
      const depth = this.substitutionDepths.get(at);

      if (depth !== undefined) return depth;
    }

    return 0;
  }

  /** Set while PS4 is expanded, so that what it runs is not traced in turn. */
  private expandingPs4 = false;

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
    if (!ctx.getShellOption('xtrace') || this.expandingPs4) {
      return;
    }

    const params = this.paramView(ctx);
    let ps4 = params.PS4 ?? '+ ';

    // PS4 is expanded, `PS4='+${LINENO}: '`, and its first character said once
    // more for each command substitution the command runs in
    if (/[$`\\]/.test(ps4)) {
      this.expandingPs4 = true;

      try {
        ps4 = await this.expandHereDocument(ps4, ctx);
      } catch {
        // A PS4 that does not expand is used as it is
      } finally {
        this.expandingPs4 = false;
      }
    }

    ps4 = ps4.charAt(0).repeat(this.substitutionDepth(ctx)) + ps4;

    // BASH_XTRACEFD names another descriptor for it, `exec 4>trace; BASH_XTRACEFD=4`
    const fd = params.BASH_XTRACEFD;
    const target = fd && /^\d+$/.test(fd) ? (ctx.getFd(fd) ?? fd) : ctx.getStderr();

    await this.shell.pipeWrite(target, `${ps4}${line}\n`).catch(() => {});
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
    if (!(err instanceof RedirectionError)) {
      throw err;
    }

    await this.diagnose(ctx, err.message);

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
        if (isExitSignal(lastCode) || isReturnSignal(lastCode) || isLoopControl(lastCode)) {
          return lastCode;
        }

        // $? is updated after every command, not just at script level. Without this a
        // compound body (if/while/for/{}/function) sees the *enclosing* $? — so the
        // `cmd; STATUS=$?; if [ $STATUS -ne 0 ]` retry idiom silently reads 0 and every
        // failure inside an if looks like a success.
        ctx.setParams({ '?': String(lastCode) });
      }

      return lastCode;
    } catch (err) {
      throw node.redirections?.length ? await this.reportedWithin(err, ctx) : err;
    } finally {
      await this.finishProcessSubstitutions(subs, ctx);

      for (const pipe of redirectPipes) {
        await this.releaseTemporary(pipe);
      }
    }
  }

  /**
   * An unset parameter is said where it happened, inside the redirections of
   * the compound command around it — `{ echo ${u?}; } 2>/dev/null` says
   * nothing — and not again by whatever it ends.
   */
  private async reportedWithin(err: unknown, ctx: ExecContextIf): Promise<unknown> {
    if (err instanceof UnboundVariableError && !err.reported) {
      await this.diagnose(ctx, err.message);
      err.reported = true;
    }

    return err;
  }

  /**
   * The functions a parent bash exported, `BASH_FUNC_name%%='() { … }'` in the
   * environment, defined in `ctx` as bash does when it starts.
   *
   * The value has to be one function definition and nothing else, or it is
   * ignored: bash 4.3's fix for Shellshock, which ran what followed it.
   */
  async importFunctions(ctx: ExecContextIf): Promise<void> {
    for (const [variable, value] of Object.entries(ctx.getEnv())) {
      const name = exportedFunctionName(variable);

      if (!name || !value.startsWith('() {') || /[\s/=$`'"\\]/.test(name)) continue;

      const source = `${name} ${value}`;

      try {
        const ast = await parse(source, { insertLOC: true });
        const [node, ...rest] = ast.commands;

        if (rest.length || node?.type !== 'Function' || (node as AstNodeFunction).name.text !== name) continue;

        const previous = this.currentSource;
        this.currentSource = source;

        try {
          await this.registerFunction(node as AstNodeFunction, ctx);
        } finally {
          this.currentSource = previous;
        }
      } catch {
        // Not a function definition: left alone, as bash does
      }
    }
  }

  protected async registerFunction(node: AstNodeFunction, parentCtx: ExecContextIf): Promise<number> {
    // POSIX allows only a name for a function, and a shell that is given another ends
    if (parentCtx.getShellOption('posix') && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.name.text)) {
      await this.diagnose(parentCtx, `\`${node.name.text}': not a valid identifier`);
      return makeExitSignal(2);
    }

    if (parentCtx.getFunction(node.name.text)?.readonly) {
      // bash has read the whole definition by then, and names its last line
      const end = node.loc?.end?.row;

      if (end !== undefined) parentCtx.setParams({ LINENO: String(this.sourceFrame.base + end) });
      await this.diagnose(parentCtx, `${node.name.text}: readonly function`);
      return 1;
    }

    // bash expands and opens a function's redirections each time it runs it, not when it is defined
    const ctx = parentCtx.spawnContext();

    parentCtx.setFunction(node.name.text, node.body, ctx, { node, source: this.currentSource });

    // An exported function stays exported when it is defined again, as the new definition
    const variable = functionEnvName(node.name.text);
    const fn = parentCtx.getFunction(node.name.text);

    if (variable in parentCtx.getEnv() && fn) parentCtx.setEnv({ [variable]: await exportedFunctionText(fn) });
    this.functionSources.set(node.body, this.currentFile(parentCtx));
    this.functionFrames.set(node.body, this.sourceFrame);

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
    } catch (err) {
      throw await this.reportedWithin(err, ctx);
    } finally {
      await this.finishProcessSubstitutions(subs, ctx);

      for (const pipe of redirectPipes) {
        await this.releaseTemporary(pipe);
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

  /** How many loops the command running now is inside, in this function: bash's loop_level. */
  private loopDepth = 0;

  /**
   * `break [n]` and `continue [n]`: the code that carries them out of the
   * body, or, outside a loop, a complaint and status 0, as in bash.
   */
  private async loopControl(name: 'break' | 'continue', args: string[], ctx: ExecContextIf): Promise<number> {
    if (this.loopDepth === 0) {
      await this.diagnose(ctx, `${name}: only meaningful in a \`for', \`while', or \`until' loop`);
      return 0;
    }

    const arg = args[0];

    // A count that is no number ends the shell, with 128, as bash's throw to the top level does
    if (arg !== undefined && !/^\s*[+-]?\d+\s*$/.test(arg)) {
      await this.diagnose(ctx, `${name}: ${arg}: numeric argument required`);
      return makeExitSignal(128);
    }

    const levels = arg === undefined ? 1 : Number(arg);

    // bash leaves every loop after complaining about a count below one
    if (levels <= 0) {
      await this.diagnose(ctx, `${name}: ${arg}: loop count out of range`);
      return loopControl('break', this.loopDepth);
    }

    return loopControl(name, Math.min(levels, this.loopDepth));
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
    this.loopDepth++;

    let code: number;

    try {
      code = await this.executeNode(body, ctx);
    } finally {
      this.loopDepth--;
    }

    if (isLoopControl(code)) {
      const breaking = code > CONTINUE_BASE;
      const levels = breaking ? BREAK_BASE - code : CONTINUE_BASE - code;

      // `break 2` leaves this loop as the one around it still has to
      if (levels > 1) {
        return { stop: true, code: loopControl(breaking ? 'break' : 'continue', levels - 1) };
      }

      return { stop: breaking, code: 0 };
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

      // A nameref loop variable is pointed at each word, so what it refers to being readonly is no matter
      const nameref = ctx.getVariable(node.name.text)?.attributes.includes('n');

      if (!nameref && ctx.isReadonlyVar(node.name.text)) {
        await this.diagnose(ctx, `${node.name.text}: readonly variable`);

        return this.applyErrexit(1, ctx);
      }

      for (const value of values) {
        // bash repeats the `for` line once per iteration, not once per loop
        await this.trace(ctx, traceLine);

        // A nameref as the loop variable refers to each word in turn, as bash does
        if (ctx.getVariable(node.name.text)?.attributes.includes('n')) {
          ctx.declareVariable(node.name.text, { value, noref: true });
        } else {
          ctx.assignVariable(node.name.text, value);
        }

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

    await this.diagnose(ctx, `\`${node.name.text}': not a valid identifier`);

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
        const ps3 = ctx.getParam('PS3') ?? '#? ';

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
      // Each of the three is preceded by the DEBUG trap, as each is a command of its own to bash
      const evaluate = async (part: { expression: string } | undefined, empty: number): Promise<number> => {
        const trapped = await this.debugTrap(node, ctx);

        if (trapped !== undefined) throw new LoopExit(trapped);

        return part ? await this.arithmeticValue(part, ctx, (text) => `(( ${text.trimStart()} ))`) : empty;
      };

      try {
        await evaluate(node.init, 0);

        let last = 0;

        while (await evaluate(node.test, 1) !== 0) {
          const { stop, code } = await this.runLoopBody(node.do, ctx);
          last = code;

          if (stop) {
            return code;
          }

          await evaluate(node.update, 0);
        }

        return last;
      } catch (err) {
        if (err instanceof LoopExit) return err.code;
        throw err;
      }
    }).catch((err) => this.arithmeticCommandStatus(err, parentCtx));
  }

  protected async executeCase(node: AstNodeCase, parentCtx: ExecContextIf): Promise<number> {
    return this.withCompoundRedirections(node, parentCtx, async (ctx) => {
      // The subject is one word, neither split nor globbed: `case $x in` with
      // IFS=: and x=a:b matches against a:b, `case * in` against *
      const clauseExpanded = await this.resolveExpansions(node.clause, ctx, undefined, { split: false, glob: false });
      const clauseValue = clauseExpanded.values.join(' ');

      // `set -x` shows the subject as written
      await this.trace(ctx, `case ${node.clause.loc ? this.nodeSource(node.clause) : node.clause.text} in`);

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
        if (isExitSignal(status) || isReturnSignal(status) || isLoopControl(status)) {
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
    return globToRegExp(await this.patternGlob(word, ctx));
  }

  /**
   * The glob a pattern word stands for, written raw (quotes still in its text):
   * quoted and escaped characters are quoted in it, so they match themselves.
   * With `ampersand`, an unquoted `&` becomes MATCH_MARK instead — the
   * replacement of `${x/p/s}`, where it stands for what matched.
   */
  protected async patternGlob(word: AstNodeWord, ctx: ExecContextIf, ampersand = false): Promise<string> {
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
      // A pattern is one word: no splitting, no globbing — `"$x"` keeps its blanks
      const { values } = await this.resolveExpansions(synthetic, ctx, undefined, { split: false, glob: false });
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
        // In a replacement, an `&` an unquoted expansion brings is the match too, as in bash
        glob += inDouble ? quoteGlob(expansion.value) : ampersand ? expansion.value.replaceAll('&', MATCH_MARK) : expansion.value;
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
      } else if (ampersand && c === '&' && !inSingle && !inDouble) {
        glob += MATCH_MARK;
      } else {
        glob += inSingle || inDouble ? quoteGlob(c) : c;
      }
    }

    return glob;
  }

  /**
   * An operator's word as written: parsed, a word with no expansions has lost
   * its quotes, and whether a character was quoted decides what it matches.
   */
  protected writtenWord(word: unknown, source: unknown): AstNodeWord {
    const parsed = word as AstNodeWord | undefined;

    return parsed?.expansion?.length ? parsed : { type: 'Word', text: String(source ?? parsed?.text ?? ''), expansion: [] } as unknown as AstNodeWord;
  }

  /**
   * `${x/pattern/string}`, as bash's pat_subst: the longest match, the first
   * or every one; `#` and `%` anchor it at the start or the end. An unquoted
   * `&` in the string is what matched (patsub_replacement, on by default).
   */
  protected async replacePattern(xp: Record<string, unknown>, value: string, ctx: ExecContextIf): Promise<string> {
    const glob = await this.patternGlob(this.writtenWord(xp.pattern, xp.patternSource), ctx);
    const anchor = xp.anchor as '#' | '%' | undefined;

    // An empty pattern replaces nothing, unless anchored: `${x/#/p}` prefixes
    if (glob === '' && !anchor) return value;

    const template = xp.replacement === undefined
      ? ''
      : await this.patternGlob(this.writtenWord(xp.replacement, xp.replacementSource), ctx, ctx.getShellOption('patsub_replacement'));
    // The glob-quoting the walk added is for patterns; a replacement is text
    const replacement = (match: string) => unquoteGlob(template).split(MATCH_MARK).join(match);
    const matches = globToRegExp(glob);
    const full = (text: string) => matches.test(text);

    if (anchor === '#') {
      for (let end = value.length; end >= 0; end--) {
        if (full(value.slice(0, end))) return replacement(value.slice(0, end)) + value.slice(end);
      }

      return value;
    }

    if (anchor === '%') {
      for (let start = 0; start <= value.length; start++) {
        if (full(value.slice(start))) return value.slice(0, start) + replacement(value.slice(start));
      }

      return value;
    }

    // An empty value is matched as it is, `${x/*/y}` with x empty is y
    if (value === '') return full('') ? replacement('') : value;

    // Text that is no pattern at all, `${s//a/b}`: found as text
    if (!isGlobPattern(glob, true)) {
      const text = unquoteGlob(glob);

      return xp.globally ? value.split(text).join(replacement(text)) : value.replace(text, () => replacement(text));
    }

    // Without an extended pattern's alternatives, the longest match at a place
    // is the one a greedy regular expression finds there: one try per place
    if (!/(^|[^\\])[@*+?!]\(/.test(glob)) {
      const sticky = new RegExp(globToRegexSource(glob), 'y');
      let out = '';
      let at = 0;

      while (at < value.length) {
        sticky.lastIndex = at;

        const found = sticky.exec(value)?.[0];

        if (found) {
          out += replacement(found);
          at += found.length;

          if (!xp.globally) return out + value.slice(at);
        } else {
          out += value[at++];
        }
      }

      return out;
    }

    let out = '';
    let at = 0;

    while (at < value.length) {
      let end = value.length;

      while (end > at && !full(value.slice(at, end))) end--;

      if (end > at) {
        out += replacement(value.slice(at, end));
        at = end;

        if (!xp.globally) return out + value.slice(at);
      } else {
        out += value[at++];
      }
    }

    return out;
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

    // `exit 3 || echo not` ends the shell, as `return`, `break` and `continue` leave what they leave
    if (isExitSignal(left) || isReturnSignal(left) || isLoopControl(left)) {
      return left;
    }

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

    // The right side sees the left's status: `false || echo $?` prints 1
    if (!isExitSignal(left) && !isReturnSignal(left)) {
      ctx.setParams({ '?': String(left) });
    }

    return await this.executeNode(node.right, ctx);
  }

  protected async executeArithmeticCommand(node: AstNodeArithmeticCommand, ctx: ExecContextIf): Promise<number> {
    const trapped = await this.debugTrap(node, ctx);

    if (trapped !== undefined) return trapped;

    try {
      const result = await this.arithmeticValue(node, ctx, (text) => `(( ${text} ))`);
      // In bash, (( expr )) returns 0 (success) if expr is non-zero, 1 (failure) if expr is zero
      return this.applyErrexit(result !== 0 ? 0 : 1, ctx);
    } catch (err) {
      return await this.arithmeticCommandStatus(err, ctx);
    }
  }

  /** `((` and `for ((` report a bad expression as bash does, `((: 1 + : syntax error: …`, and fail with 1. */
  private async arithmeticCommandStatus(err: unknown, ctx: ExecContextIf): Promise<number> {
    // So is one in a subscript, and it ends the rest of the line as an expansion error does
    if (!(err instanceof CommandAbortError) || (err instanceof ArithmeticError && err.nameless)) {
      throw err;
    }

    // A readonly variable is said as any assignment to one says it
    const prefix = err instanceof ReadonlyVariableError ? '' : '((: ';

    await this.diagnose(ctx, `${prefix}${err.message}`);

    return this.applyErrexit(1, ctx);
  }

  /**
   * The value of an arithmetic expression. The parser hands over an AST when
   * the text was arithmetic as written; otherwise — `a[i]`, `16#ff`, `$#`, or
   * something that is not arithmetic at all — the text is expanded, as bash
   * always does first, and parsed now.
   */
  /**
   * An arithmetic expression's value: expanded first — parameters, command
   * substitutions, quote removal, as in double quotes — then evaluated as bash
   * does, on 64-bit integers.
   */
  protected async arithmeticBig(part: { expression: string }, ctx: ExecContextIf, traced?: (expanded: string) => string): Promise<bigint> {
    const expanded = await this.expandArithmetic(part.expression, ctx);

    // `set -x` shows it expanded, `((  x + 5  ))`, before it is evaluated
    if (traced) await this.trace(ctx, traced(expanded));

    const text = expanded.replace(/(?<!\\)"/g, '');

    return await evaluateArithmeticText(text, contextVariables(ctx, (subscript, keyed) => this.arithmeticSubscript(subscript, keyed, ctx)));
  }

  /**
   * An arithmetic expression expanded as bash 5.2 expands one: as in double
   * quotes, except that each subscript, `a[…]`, is expanded on its own, as a
   * word, and what comes out is backslash-quoted. What a variable holds then
   * stays the key it is: `a[$k]` with k='x],b[$(cmd)' neither ends the
   * subscript early nor runs cmd, since the evaluator expands the subscript
   * once more and takes the quoting off.
   */
  protected async expandArithmetic(text: string, ctx: ExecContextIf): Promise<string> {
    let out = '';
    let from = 0;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === '\\') {
        i++;
      } else if (char === '`') {
        i = closingQuote(text, i);
      } else if (char === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) {
        i = closingBracket(text, i + 1);
      } else if (char === '[') {
        const close = subscriptEnd(text, i);

        // No subscript, `[` on its own or `[]`: a character like any
        if (close <= i + 1) continue;

        out += await this.expandHereDocument(text.slice(from, i), ctx);
        out += `[${(await this.subscriptWord(text.slice(i + 1, close), ctx)).replace(/[[\]$`~\\'"]/g, '\\$&')}]`;
        from = close + 1;
        i = close;
      }

      if (i === -1) break;
    }

    return out + await this.expandHereDocument(text.slice(from), ctx);
  }

  /** A subscript as the arithmetic evaluator expands it: a key as a word, an index as in double quotes. */
  private async arithmeticSubscript(subscript: string, keyed: boolean, ctx: ExecContextIf): Promise<string> {
    if (keyed) return await this.subscriptWord(subscript, ctx);

    return (await this.expandHereDocument(subscript, ctx)).replace(/(?<!\\)"/g, '');
  }

  /** A subscript expanded as one word: parameters, substitutions, quote removal, no splitting. */
  private async subscriptWord(subscript: string, ctx: ExecContextIf): Promise<string> {
    if (!/[$`\\'"]/.test(subscript)) return subscript;

    const ast = await parse(subscript, { mode: 'word-expansion' });
    const word = (ast.commands[0] as AstNodeCommand).name;

    if (!word) return subscript;

    const { values } = await this.resolveExpansions({ ...word, type: 'AssignmentWord' } as AstNodeAssignmentWord, ctx);

    return values[0] ?? '';
  }

  /** `arithmeticBig` as a number, for a count, an index or a test. */
  protected async arithmeticValue(part: { expression: string }, ctx: ExecContextIf, traced?: (expanded: string) => string): Promise<number> {
    return Number(await this.arithmeticBig(part, ctx, traced));
  }

  /**
   * Executes a [[ conditional ]] command.
   * Returns 0 if the condition is true, 1 if false.
   */
  protected async executeConditionalCommand(node: AstNodeConditionalCommand, ctx: ExecContextIf): Promise<number> {
    let result: boolean;

    const trapped = await this.debugTrap(node, ctx);

    if (trapped !== undefined) return trapped;

    try {
      result = await this.evaluateConditionalExpression(node.conditionAST, ctx);
    } catch (err) {
      // An arithmetic operand that is no expression fails the test, and says so
      if (!(err instanceof ArithmeticSyntaxError || err instanceof ArithmeticError)) throw err;

      // One in a subscript ends the rest of the line, as an expansion error does
      if (err instanceof ArithmeticError && err.nameless) throw err;

      await this.diagnose(ctx, `[[: ${err.message}`);

      return this.applyErrexit(1, ctx);
    }

    return this.applyErrexit(result ? 0 : 1, ctx);
  }

  /**
   * Recursively evaluates a conditional expression AST node.
   */
  /**
   * @param negated - The term is under a `!`, which `set -x` shows before it
   */
  protected async evaluateConditionalExpression(
    node: AstConditionalExpression,
    ctx: ExecContextIf,
    negated = false,
  ): Promise<boolean> {
    switch (node.type) {
      case 'ConditionalWord': {
        // A standalone word is true if non-empty after expansion
        const word = await this.expandConditionalWord(node, ctx);

        await this.traceCondition(ctx, negated, [word]);

        return word.length > 0;
      }

      case 'ConditionalNegation':
        return !(await this.evaluateConditionalExpression(node.argument, ctx, true));

      case 'ConditionalLogicalExpression':
        return this.evaluateConditionalLogical(node, ctx);

      case 'ConditionalUnaryExpression':
        return this.evaluateConditionalUnary(node, ctx, negated);

      case 'ConditionalBinaryExpression':
        return this.evaluateConditionalBinary(node, ctx, negated);

      default:
        throw new UnknownNodeTypeError(
          (node as { type: string }).type,
          this.getSourceLocation(node),
          this.currentSource,
        );
    }
  }

  /**
   * `set -x` for one term of a `[[ ]]`, as bash shows it when it evaluates the
   * term: its words expanded, a pattern as written — `[[ 5 -eq 5 ]]`, then
   * `[[ -n a b ]]` for the one after `&&`, and nothing for one never reached.
   */
  private async traceCondition(ctx: ExecContextIf, negated: boolean, words: string[]): Promise<void> {
    if (!ctx.getShellOption('xtrace')) return;

    await this.trace(ctx, `[[ ${negated ? '! ' : ''}${words.join(' ')} ]]`);
  }

  /** An arithmetic operand of `[[ ]]` as `set -x` shows it: expanded, unless that would run a `$( )` a second time. */
  private async tracedOperand(word: AstConditionalWord, ctx: ExecContextIf): Promise<string> {
    if (!ctx.getShellOption('xtrace')) return '';

    return word.expansion?.some((xp) => xp.type === 'CommandExpansion' || xp.type === 'ProcessSubstitution') ? word.text : await this.expandConditionalWord(word, ctx);
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
   * `[[ -v a[sub] ]]` as bash 5.2 has it: the subscript is expanded once, as a
   * word, and what it expands to is the key, or an index evaluated as it is —
   * `a[$k]` with k='x],b[$(cmd)' is that key, and cmd does not run.
   * @returns undefined for anything but one element of an array
   */
  private async conditionalElement(word: AstConditionalWord, ctx: ExecContextIf): Promise<{ set: boolean } | undefined> {
    const text = word.written ?? word.text;
    const name = text.match(/^[A-Za-z_][A-Za-z0-9_]*(?=\[)/)?.[0];

    if (!name || subscriptEnd(text, name.length) !== text.length - 1) return undefined;

    const written = text.slice(name.length + 1, -1);

    // An associative array's `@` and `*` are keys like any other, as bash 5.2 has them
    if (written === '@' || written === '*') return ctx.getAssoc(name) ? { set: written in ctx.getAssoc(name)! } : undefined;

    const subscript = await this.subscriptWord(written, ctx);
    const assoc = ctx.getAssoc(name);

    if (assoc) return { set: subscript in assoc };

    const scalar = ctx.getParam(name);
    const array = ctx.getArray(name) ?? (scalar !== undefined ? [scalar] : undefined);
    const index = Number(await evaluateArithmeticText(subscript, contextVariables(ctx)));
    const at = index < 0 ? (array?.length ?? 0) + index : index;

    return { set: array?.[at] !== undefined };
  }

  /**
   * Evaluates unary conditional expressions (-f, -d, -z, -n, etc.).
   */
  protected async evaluateConditionalUnary(
    node: AstConditionalUnaryExpression,
    ctx: ExecContextIf,
    negated = false,
  ): Promise<boolean> {
    const op = node.operator;

    // `-v name[subscript]`: the subscript as written, expanded once, as a word
    if (op === '-v') {
      const element = await this.conditionalElement(node.argument, ctx);

      if (element) {
        await this.traceCondition(ctx, negated, [op, node.argument.written ?? node.argument.text]);
        return element.set;
      }
    }

    const arg = await this.expandConditionalWord(node.argument, ctx);

    await this.traceCondition(ctx, negated, [op, arg]);

    // String tests
    if (op === '-z') return arg.length === 0;
    if (op === '-n') return arg.length > 0;

    // Variable tests
    if (op === '-v') {
      // -v name: whether it is set — an array by its element 0, `a[k]` by that element, `a[@]` by having any
      const params = this.paramView(ctx);
      return await this.isParameterSet(arg, ctx, params);
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
    negated = false,
  ): Promise<boolean> {
    const op = node.operator;
    const arithmetic = ['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(op);
    // An arithmetic operand is expanded as arithmetic is, below, and only there
    const left = arithmetic ? '' : await this.expandConditionalWord(node.left, ctx);
    // A pattern shows as written; any other word as it expands
    const pattern = op === '==' || op === '=' || op === '!=' || op === '=~';

    if (ctx.getShellOption('xtrace')) {
      const right = pattern ? node.right.written ?? node.right.text : await this.tracedOperand(node.right, ctx);

      await this.traceCondition(ctx, negated, [arithmetic ? await this.tracedOperand(node.left, ctx) : left, op, right]);
    }

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
        // A failed match leaves none behind
        ctx.setArray('BASH_REMATCH', []);
        return false;
      } catch {
        // Invalid regex - return false
        return false;
      }
    }

    // Numeric comparison operators
    if (op === '-eq' || op === '-ne' || op === '-lt' || op === '-le' || op === '-gt' || op === '-ge') {
      // Both are arithmetic expressions in [[ ]]: `4+3`, a variable's name,
      // expanded as $(( )) expands one — a subscript on its own and kept whole,
      // so `a[$k]` with k='$(cmd)' does not run cmd, and m[$k] finds that key
      // even when it holds `]`. A `'` quotes in a word, though, and not in
      // arithmetic: such an operand is expanded as a word, and then evaluated
      // with nothing in it expanded again.
      const evaluate = async (word: unknown) => {
        const text = (word as { written?: string; text?: string }).written ?? (word as { text?: string }).text ?? '';

        if (!/'/.test(text.replace(/\[[^\]]*\]/g, ''))) {
          return await this.arithmeticValue({ expression: text }, ctx);
        }

        return Number(await evaluateArithmeticText(await this.expandConditionalWord(word as never, ctx), contextVariables(ctx)));
      };
      const leftNum = await evaluate(node.left);
      const rightNum = await evaluate(node.right);

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
    // A word without expansions comes from the parser with its quotes removed
    // already: `"\\"` is one backslash, and taking quotes off again would lose it
    if (!word.expansion || word.expansion.length === 0) {
      return word.text;
    }

    // Every expansion a word can have, `${x:-y}`, `${a[1]}` and `${#s}` too; no
    // splitting and no globbing, so what comes out is one string
    const { values } = await this.resolveExpansions(word as unknown as AstNodeWord, ctx, undefined, { split: false, glob: false });

    return values.join(' ');
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
    //
    // A quoted character stands in the expression as a placeholder until it has
    // been read, so that it is itself wherever it lands — in a bracket
    // expression too, where a backslash would be a member of its own: `[']']`
    // is a class holding `]`, `[^]"."]` one without `]` and `.`.
    const text = word.text;
    const literals: string[] = [];
    const literal = (chars: string) =>
      [...chars].map((char) => {
        literals.push(char);
        return String.fromCharCode(REGEX_LITERAL_BASE + literals.length - 1);
      }).join('');
    let regex = '';
    let i = 0;

    while (i < text.length) {
      const c = text[i];
      const ansi = c === '$' ? this.ansiCString(text, i) : undefined;

      if (ansi) {
        regex += literal(ansi.value);
        i = ansi.end + 1;
      } else if (c === '$' && text[i + 1] === '"') {
        // $"…" is a string to translate; untranslated it is "…"
        i++;
      } else if (c === "'") {
        const close = text.indexOf("'", i + 1);
        const end = close === -1 ? text.length : close;

        regex += literal(text.slice(i + 1, end));
        i = end + 1;
      } else if (c === '"') {
        let close = i + 1;

        while (close < text.length && text[close] !== '"') {
          close += text[close] === '\\' ? 2 : 1;
        }

        regex += literal(await this.expandHereDocument(text.slice(i + 1, close), ctx));
        i = close + 1;
      } else if (c === '\\' && i + 1 < text.length) {
        // A backslash quotes the character after it, as anywhere in the shell
        regex += literal(text[i + 1]);
        i += 2;
      } else {
        let end = i;

        // Up to the next quote or backslash, `$'` and `$"` included
        while (end < text.length && !`'"\\`.includes(text[end]) && !(text[end] === '$' && `'"`.includes(text[end + 1]))) {
          end++;
        }

        regex += await this.expandHereDocument(text.slice(i, end), ctx);
        i = end;
      }
    }

    const source = posixRegexToSource(regex);

    // Each placeholder is its character, escaped for wherever it is — `\-` too, for inside a class
    return source.replace(REGEX_LITERALS, (placeholder) => {
      const char = literals[placeholder.charCodeAt(0) - REGEX_LITERAL_BASE];

      return char === '-' ? '\\-' : quoteRegex(char);
    });
  }

  /**
   * The current field separators.
   *
   * Assignments land in params, not env, so `IFS=:` and `IFS= read …` are only
   * visible if both are consulted. An IFS that is set but empty disables field
   * splitting and is not the same as an unset one.
   */
  protected getIfs(ctx: ExecContextIf): string {
    return ctx.getParam('IFS') ?? utils.DEFAULT_IFS;
  }

  /**
   * The parameters and the environment as one record, as `{ ...getEnv(),
   * ...getParams() }` would be, but read a name at a time: expanding `$x` made
   * every variable of every scope, which was most of what a simple command cost.
   * Listing it — `${!prefix*}` — still makes them all.
   */
  protected paramView(ctx: ExecContextIf): Record<string, string> {
    const all = () => ({ ...ctx.getEnv(), ...ctx.getParams() });

    return new Proxy({} as Record<string, string>, {
      get: (_, key) => typeof key === 'string' ? ctx.getParam(key) : undefined,
      has: (_, key) => typeof key === 'string' && ctx.getParam(key) !== undefined,
      ownKeys: () => Reflect.ownKeys(all()),
      getOwnPropertyDescriptor: (_, key) => {
        const value = typeof key === 'string' ? ctx.getParam(key) : undefined;

        return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
      },
    });
  }

  /** A word as the source spells it, quotes and all, when the source is at hand. */
  protected writtenText(node: AstNodeWord | AstNodeAssignmentWord): string | undefined {
    return this.currentSource !== undefined && node.loc?.start?.char !== undefined && node.loc.end?.char !== undefined
      ? this.currentSource.slice(node.loc.start.char, node.loc.end.char + 1)
      : undefined;
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

    // `T='([a]=1)'` reads as a list once quotes are gone; the source says it was a string
    const written = parts.list ? this.writtenText(node) : undefined;
    const writtenParts = written !== undefined ? utils.parseAssignmentWord(written) : null;

    if (writtenParts && writtenParts.name === parts.name && !writtenParts.list) {
      Object.assign(parts, { list: false, valueStart: parts.valueStart - 1, value: node.text.slice(parts.valueStart - 1) });
    }

    if (parts.list) {
      const { values, status } = await this.resolveArrayElements(node, ctx, parts);

      return { name: parts.name, subscript: parts.subscript, append: parts.append, values, list: true, status };
    }

    // The value alone, as `x=value`: the subscript is expanded on its own, and
    // what it expands to may hold a `=` or a `]` of its own, `h[$path]=1`
    const { values, status } = await this.resolveExpansions(this.wordFrom(node, parts.valueStart, 'x='), ctx);

    return {
      name: parts.name,
      subscript: parts.subscript,
      append: parts.append,
      values: [(values[0] ?? 'x=').slice(2)],
      list: false,
      status,
    };
  }

  /** A word from `from` on, `prefix` put before it, its expansions moved along. */
  private wordFrom<T extends { text: string; expansion?: Array<{ loc?: { start: number; end: number } }> }>(node: T, from: number, prefix = ''): T {
    const shift = prefix.length - from;

    return {
      ...node,
      text: prefix + node.text.slice(from),
      expansion: (node.expansion ?? [])
        .filter((xp) => !xp.loc || xp.loc.start >= from)
        .map((xp) => xp.loc ? { ...xp, loc: { start: xp.loc.start + shift, end: xp.loc.end + shift } } : xp),
    };
  }

  /**
   * Expand one argument of a declaration command, keeping it a single word.
   *
   * The builtin is handed text, so an element list is handed back with its
   * boundaries still marked and split again on the other side.
   */
  protected async resolveDeclarationArg(node: AstNodeWord, ctx: ExecContextIf, parts: utils.AssignmentParts, assoc = false): Promise<string> {
    // `c='(3)'` reads as `c=(3)` once quotes are gone; the source says which it was
    const written = this.writtenText(node);
    // Written as a list only when the word itself starts `name=(`, unquoted
    const quotedList = parts.list && written !== undefined && !(utils.isAssignmentPrefix(written) && written[written.indexOf('=') + 1] === '(');

    if (quotedList) {
      const { values } = await this.resolveExpansions({ ...node, type: 'AssignmentWord' } as AstNodeAssignmentWord, ctx);
      const text = values[0] ?? '';
      const eq = text.indexOf('=');

      return `${text.slice(0, eq + 1)}${QUOTED_LIST_MARK}${text.slice(eq + 1)}`;
    }

    if (parts.list) {
      const { values } = await this.resolveArrayElements(node as unknown as AstNodeAssignmentWord, ctx, parts, assoc);

      return `${node.text.slice(0, parts.valueStart)}${values.join(utils.ARRAY_ELEMENT_SEPARATOR)})`;
    }

    // An assignment word is quote removed without field splitting
    const { values } = await this.resolveExpansions({ ...node, type: 'AssignmentWord' } as AstNodeAssignmentWord, ctx);

    return values[0] ?? '';
  }

  /**
   * The elements of an array literal, `a=(x "b c" $rest)`.
   *
   * A `[key]=value` element is one assignment, neither side split, and is
   * handed on as `keyedText` gives it, so a key holding `]` stays the key. On
   * an associative array (`assoc`, or the name is one already) whose first
   * element is no `[key]=value`, the elements are keys and values in turn,
   * each one word as written, and come back keyed the same way.
   */
  protected async resolveArrayElements(
    node: AstNodeAssignmentWord,
    ctx: ExecContextIf,
    parts: utils.AssignmentParts,
    assoc = false,
  ): Promise<{ values: string[]; status: number }> {
    if (!node.expansion || node.expansion.length === 0) {
      // `( "" )` is one empty element, which quote removal left no trace of
      if (parts.value === '') {
        const written = this.writtenText(node) ?? '';
        const inner = written.slice(written.indexOf('(') + 1, written.lastIndexOf(')'));

        return { values: /^\s*(""|'')\s*$/.test(inner) ? [''] : [], status: 0 };
      }

      // Quote removal already ran at parse time, gaps and all
      return { values: parts.value.split(utils.ARRAY_ELEMENT_SEPARATOR), status: 0 };
    }

    const { text, protectedRanges, status } = await this.substituteExpansions(node, ctx);
    const inner = text.slice(parts.valueStart, text.length - 1);
    const ifs = this.getIfs(ctx);
    const written: { element: string; ranges: ProtectedRange[] }[] = [];
    let offset = parts.valueStart;

    for (const element of inner.split(utils.ARRAY_ELEMENT_SEPARATOR)) {
      // Runs of blanks in the literal leave empty pieces behind; a genuinely
      // empty element was written as '' or "" and survives quote removal instead
      if (element !== '') written.push({ element, ranges: utils.sliceRanges(protectedRanges, offset, offset + element.length) });

      offset += element.length + utils.ARRAY_ELEMENT_SEPARATOR.length;
    }

    const unquoted = (element: string, ranges: ProtectedRange[], split: string): string[] => utils.unquoteWordWithProtectedRanges(element, ranges, split).values;
    const one = (element: string, ranges: ProtectedRange[]): string => unquoted(element, ranges, '').join(' ');
    const keyed = written.map(({ element, ranges }) => keyEnd(element, ranges));
    const values: string[] = [];

    if ((assoc || ctx.getAssoc(parts.name)) && written.length > 0 && keyed[0] === -1) {
      for (let i = 0; i < written.length; i += 2) {
        const key = one(written[i].element, written[i].ranges);
        const value = written[i + 1] ? one(written[i + 1].element, written[i + 1].ranges) : '';

        if (key === '') await this.diagnose(ctx, `${written[i].element}: bad array subscript`);
        else values.push(keyedText(key, value, false));
      }

      return { values, status };
    }

    for (const [i, { element, ranges }] of written.entries()) {
      const close = keyed[i];

      if (close === -1) {
        values.push(...unquoted(element, ranges, ifs));
        continue;
      }

      const append = element[close + 1] === '+';
      const valueStart = close + (append ? 3 : 2);

      values.push(keyedText(
        one(element.slice(1, close), utils.sliceRanges(ranges, 1, close)),
        one(element.slice(valueStart), utils.sliceRanges(ranges, valueStart, element.length)),
        append,
      ));
    }

    return { values, status };
  }

  /**
   * A value as the variable takes it: arithmetic for one declared -i, where
   * `+=` adds; otherwise the text, `+=` appending it.
   */
  protected async assignedValue(ctx: ExecContextIf, name: string, previous: string | undefined, text: string, append: boolean): Promise<string> {
    if (!ctx.isIntegerVar(name)) return append ? (previous ?? '') + text : text;

    const number = await this.arithmeticBig({ expression: text || '0' }, ctx);
    const base = append ? await this.arithmeticBig({ expression: previous || '0' }, ctx) : 0n;

    return String(BigInt.asIntN(64, base + number));
  }

  /**
   * Store what resolveAssignment() worked out.
   *
   * @param local - True for a prefix assignment, which only the command it
   *                precedes can see; a bare assignment goes to the shell.
   */
  protected async applyAssignment(assignment: Assignment, ctx: ExecContextIf, local: boolean): Promise<boolean> {
    let { name, subscript } = assignment;
    const { append, values, list } = assignment;

    // An assignment bash refuses ends the command line, as a readonly one does,
    // except before a command, where only that command goes without it
    const refuse = async (message: string): Promise<boolean> => {
      if (local) {
        await this.diagnose(ctx, message);
        return false;
      }

      throw new CommandAbortError(message, { code: 'E_ASSIGNMENT' });
    };

    // A reference round in a circle: a function's own assigns the shell's
    // variable of that name, one of the shell's refuses
    if (subscript === undefined && ctx.namerefLoops(name)) {
      const message = `warning: ${name}: circular name reference`;

      if (!ctx.getVariable(name)?.local) return await refuse(message);

      await this.diagnose(ctx, message);
    }

    // Through a name reference to an element, `declare -n r='a[2]'; r=x` assigns a[2]
    if (subscript === undefined && !list) {
      const element = ctx.resolveNameref(name).match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s);

      if (element) [, name, subscript] = element;

      // `declare -n r='a[@]'; r=x` names no one element
      if (element && (subscript === '@' || subscript === '*')) {
        return await refuse(`${name}[${subscript}]: bad array subscript`);
      }

      // An element of an array that is itself a reference: in a function, `local -n a='a[0]'`,
      // bash gives up; the shell's own reference stops being one and becomes the array
      const base = element ? ctx.getVariable(name) : undefined;

      if (base?.attributes.includes('n')) {
        if (base.local) {
          return await refuse(`\`${name}[${subscript}]': not a valid identifier`);
        }

        await this.diagnose(ctx, `warning: ${name}: removing nameref attribute`);
        ctx.unsetVariable(name, { noref: true });
      }
    }

    // The call stack is the shell's to keep: assigning FUNCNAME does nothing, as in bash
    if (name === 'FUNCNAME') return true;

    // A readonly variable cannot be assigned. Before a command that is said and
    // the command runs without it, as in bash; anywhere else the command ends.
    // Through a name reference, the one it refers to is the one named.
    if (ctx.isReadonlyVar(name)) {
      const refused = ctx.resolveNameref(name);

      if (local) {
        await this.diagnose(ctx, `${refused}: readonly variable`);

        return false;
      }

      throw new ReadonlyVariableError(refused);
    }

    // A nameref that refers to nothing yet is given what it refers to: that has to be a name
    const nameref = ctx.getVariable(name);

    if (nameref?.attributes.includes('n') && !nameref.value && subscript === undefined && !list && !/^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?$/s.test(values[0] ?? '')) {
      await this.diagnose(ctx, `\`${values[0] ?? ''}': not a valid identifier`);

      return false;
    }

    if (list) {
      // `a=([k]=v …)` on an associative array, and `a=([2]=x)` on an indexed one
      if (ctx.getAssoc(name)) {
        // `[k]+=v` adds to what k held before the list, as bash looks it up in the table being replaced
        const before = ctx.getAssoc(name) ?? {};
        const entries = append ? { ...before } : {};
        const { entries: assigned, errors } = assocEntries(name, values);

        for (const error of errors) await this.diagnose(ctx, error);

        for (const keyed of assigned) {
          entries[keyed.key] = await this.assignedValue(ctx, name, append ? entries[keyed.key] : before[keyed.key], keyed.value, keyed.append);
        }

        if (local) {
          ctx.setLocalAssoc(name, entries);
        } else {
          ctx.setAssoc(name, entries);
        }

        return true;
      }

      const existing = append ? (ctx.getArray(name) ?? []).slice() : [];

      // `[2]+=x` appends to what that element holds so far — nothing, unless the list is itself appended
      let next = existing.length;

      for (const element of values) {
        const keyed = keyedElement(element);
        const index = keyed ? await this.resolveIndex(keyed.key, existing.length, ctx) : next;
        const previous = keyed?.append ? existing[index] : undefined;

        existing[index] = await this.assignedValue(ctx, name, previous, keyed ? keyed.value : element, keyed?.append ?? false);
        next = index + 1;
      }

      if (local) {
        ctx.setLocalArray(name, existing);
        ctx.setLocalParams({ [name]: null });
      } else {
        ctx.setArray(name, existing);
        ctx.setParams({ [name]: null });
      }

      return true;
    }

    const value = values[0] ?? '';

    if (subscript !== undefined && ctx.getAssoc(name)) {
      const assoc = ctx.getAssoc(name)!;
      const key = await this.expandSubscript(subscript, ctx);
      const element = await this.assignedValue(ctx, name, assoc[key], value, append);

      if (local) {
        ctx.setLocalAssoc(name, { ...assoc, [key]: element });
      } else {
        ctx.setAssocElement(name, key, element);
      }

      return true;
    }

    if (subscript !== undefined) {
      const array = ctx.getArray(name);

      // `@` and `*` name every element, which no assignment can
      if (subscript === '@' || subscript === '*') {
        const error = new ArithmeticError(`${name}[${subscript}]: bad array subscript`);

        error.nameless = true;
        throw error;
      }

      // A subscript that is no expression ends the line, as bash's does
      const index = await this.resolveIndex(subscript, array?.length ?? 0, ctx, true);
      const element = await this.assignedValue(ctx, name, array?.[index], value, append);

      if (local) {
        // A prefix assignment is scoped to the command it precedes, so the array
        // is copied rather than written through to wherever it lives
        const copy = (array ?? []).slice();

        copy[index] = element;
        ctx.setLocalArray(name, copy);

        return true;
      }

      ctx.setArrayElement(name, index, element);

      return true;
    }

    // A plain assignment to an array name writes element 0 and leaves the rest
    if (ctx.getArray(name)) {
      ctx.setArrayElement(name, 0, await this.assignedValue(ctx, name, ctx.getArray(name)?.[0], value, append));

      return true;
    }

    const previous = append ? ctx.getParam(name) ?? '' : '';
    let assigned = previous + value;

    // `declare -i` makes the value arithmetic, evaluated now: x=1+2 is 3, x+=4 adds
    if (ctx.isIntegerVar(name)) {
      const number = await this.arithmeticBig({ expression: value || '0' }, ctx);
      const base = append ? await this.arithmeticBig({ expression: previous || '0' }, ctx) : 0n;

      assigned = String(BigInt.asIntN(64, base + number));
    }

    if (local) {
      // Before a command it is in that command's environment too, exported for it alone
      ctx.setLocalParams({ [name]: assigned });
      ctx.setLocalEnv({ [name]: assigned });
    } else if (ctx.getShellOption('allexport') || ctx.getVariable(name)?.attributes.includes('x')) {
      // `set -a` makes a plain assignment an exported one, so a child sees it;
      // so does assigning a variable that is exported already
      ctx.setEnv({ [name]: assigned });
    } else {
      ctx.setParams({ [name]: assigned });
    }

    return true;
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
  protected async resolveIndex(subscript: string, length: number, ctx: ExecContextIf, strict = false): Promise<number> {
    let index = 0;

    if (/^\s*-?\d+\s*$/.test(subscript)) {
      index = Number(subscript.trim());
    } else {
      try {
        index = await this.arithmeticValue({ expression: subscript }, ctx);
      } catch (err) {
        // bash names no command for an error in a subscript
        if (!strict || !(err instanceof ArithmeticError)) {
          index = 0;
        } else {
          err.nameless = true;
          throw err;
        }
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
    const cmdCtx = this.subshellOf(ctx, true);

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
    // Inside `${ }` quotes are the expansion's, and quote in its word as they would anywhere
    let braces = 0;
    for (let i = 0; i < body.length; i++) {
      const char = body[i];
      const next = body[i + 1];
      if (depth === 0 && char === '$' && next === '{') {
        braces++;
        quoted += '${';
        i++;
      } else if (depth === 0 && braces > 0 && char === '}') {
        braces--;
        quoted += char;
      } else if (depth === 0 && braces > 0 && (char === '"' || char === "'")) {
        quoted += char;
      } else if (depth === 0 && char === '\\' && next === '"') {
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

    // A `$(` the body leaves open: the substitution's syntax error, said on the delimiter's line
    if (depth > 0) {
      const params = ctx.getParams();
      const line = Number(params.LINENO ?? 1) + (body.match(/\n/g)?.length ?? 0) + 1;
      const where = this.lineNumbers ? `${this.sourceFrame.name ?? params['0'] ?? 'bash'}: command substitution: line ${line}: ` : '';

      await this.shell.pipeWrite(ctx.getStderr(), `${where}unexpected EOF while looking for matching \`)'\n`).catch(() => {});
      throw new CommandAbortError('', { code: 'E_SUBSTITUTION_SYNTAX' });
    }

    let ast: AstNode;

    try {
      ast = await parse(quoted, { mode: 'word-expansion' });
    } catch (err) {
      if (!(err instanceof BashSyntaxError)) throw err;

      // `$(` left open in the body: the substitution's own syntax error, and the command does not run
      await this.reportSyntaxError(ctx, err, { substitution: true }, quoted);
      throw new CommandAbortError('', { code: 'E_SUBSTITUTION_SYNTAX' });
    }

    const word = ((ast as AstNodeScript).commands[0] as AstNodeCommand).name;

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
    if (!/[$`\\'"]/.test(subscript)) {
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
      // In the order bash walks its hash table, as ${!a[@]} lists the keys
      return assocKeys(assoc, name).map((key) => assoc[key]);
    }

    const array = ctx.getArray(name);

    if (array) {
      return Object.values(array);
    }

    return params[name] !== undefined ? [params[name]] : [];
  }

  /** `$-`: the letters of the options that are on, in bash's order. */
  private optionFlags(ctx: ExecContextIf): string {
    return 'abefhikmnptuvxBCEHPT'
      .split('')
      .filter((letter) => SHELL_OPTION_FLAG_MAP[letter] && ctx.getShellOption(SHELL_OPTION_FLAG_MAP[letter]))
      .join('');
  }

  /**
   * The value of a parameter, which may name one array element (`a[0]`) or a
   * whole array (`a[@]`, joined for use as a single string).
   */
  protected async parameterValue(parameter: string | number, ctx: ExecContextIf, params: Record<string, string>): Promise<string> {
    return (await this.lookupParameter(parameter, ctx, params)).value;
  }

  /**
   * A parameter's value, and whether it is set, with its subscript expanded
   * once for both: `${A[$(cmd)]%x}` runs cmd once.
   */
  protected async lookupParameter(parameter: string | number, ctx: ExecContextIf, params: Record<string, string>): Promise<{ value: string; set: boolean }> {
    const { name, subscript } = this.splitSubscript(parameter);

    if (name === '-') {
      return { value: this.optionFlags(ctx), set: true };
    }

    // $* and $@ joined, set when there is a positional parameter
    if (name === '*' || name === '@') {
      const values = this.positionalParams(params);

      return { value: values.join(name === '*' ? (this.getIfs(ctx)[0] ?? '') : ' '), set: values.length > 0 };
    }

    if (subscript === undefined) {
      if (ctx.namerefLoops(name)) {
        await this.diagnose(ctx, `warning: ${name}: circular name reference`);
      }

      // `$a` on an array is its first element, as in bash; on an associative
      // array, the one whose key is 0
      const value = params[name] ?? ctx.getArray(name)?.[0] ?? ctx.getAssoc(name)?.['0'];

      return { value: value ?? '', set: value !== undefined };
    }

    if (subscript === '@' || subscript === '*') {
      const separator = subscript === '*' ? (this.getIfs(ctx)[0] ?? '') : ' ';
      const elements = this.arrayElements(name, ctx, params);

      return { value: elements.join(separator), set: elements.length > 0 };
    }

    const assoc = ctx.getAssoc(name);

    if (assoc) {
      // On an associative array the subscript is a key, not an expression
      const value = assoc[await this.expandSubscript(subscript, ctx)];

      return { value: value ?? '', set: value !== undefined };
    }

    const array = ctx.getArray(name);
    const index = await this.resolveIndex(subscript, array?.length ?? 1, ctx);

    if (!array) {
      // `${x[0]}` on a scalar is the scalar itself
      const value = index === 0 ? params[name] : undefined;

      return { value: value ?? '', set: value !== undefined };
    }

    return { value: array[index] ?? '', set: array[index] !== undefined };
  }

  /**
   * Whether a parameter is set, for the `${x-word}` family of operators.
   */
  protected async isParameterSet(parameter: string | number, ctx: ExecContextIf, params: Record<string, string>): Promise<boolean> {
    const { name, subscript } = this.splitSubscript(parameter);

    // An array's name alone is its element 0, set or not
    if (subscript === undefined) {
      return params[name] !== undefined || ctx.getArray(name)?.[0] !== undefined || ctx.getAssoc(name)?.['0'] !== undefined;
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
  protected assertParameterSet(parameter: string | number, isSet: boolean, ctx: ExecContextIf, shown = String(parameter)): void {
    if (isSet || !ctx.getShellOption('nounset')) {
      return;
    }

    const name = String(parameter);

    if (ALWAYS_SET_PARAMS.has(name)) {
      return;
    }

    throw new UnboundVariableError(shown);
  }

  /**
   * `${x@Q}` and the rest of the `@` operators: the value quoted to be read
   * back in (Q), its backslash escapes expanded (E), as a prompt (P), the
   * assignment that recreates it (A), its attributes (a), in upper case (U),
   * with the first letter upper (u), in lower case (L), as keys and values (K, k).
   */
  private transformValue(letter: string, parameter: string, value: string, ctx: ExecContextIf): string {
    const name = this.splitSubscript(parameter).name;
    const attributes = () =>
      (ctx.getAssoc(name) ? 'A' : ctx.getArray(name) ? 'a' : '') +
      (ctx.isIntegerVar(name) ? 'i' : '') +
      (ctx.isReadonlyVar(name) ? 'r' : '') +
      (name in ctx.getEnv() && ctx.getParam(name) === undefined ? 'x' : '');

    switch (letter) {
      case 'Q':
      case 'K':
      case 'k':
        return singleQuoted(value);
      case 'E':
        return utils.unquoteWord(`$'${value.replaceAll("'", "\\'")}'`).values[0] ?? '';
      case 'P':
        return value;
      case 'A': {
        const flags = attributes();

        return flags ? `declare -${flags} ${name}=${singleQuoted(value)}` : `${name}=${singleQuoted(value)}`;
      }
      case 'a':
        return attributes();
      case 'U':
        return value.toUpperCase();
      case 'u':
        return value.charAt(0).toUpperCase() + value.slice(1);
      case 'L':
        return value.toLowerCase();
      default:
        return value;
    }
  }

  /**
   * `${a[@]@K}`, `${a[@]@k}` and `${a[@]@A}`, which are about the array, not
   * each element: its keys and values as one string to read back in (K), as
   * words of their own (k), or the `declare` that makes it again (A), as
   * `${@@A}` is the `set` that makes the positional parameters again. Null
   * for any other transformation, and for a variable that is no array.
   */
  protected arrayTransform(xp: { parameter?: string | number; transform?: unknown }, ctx: ExecContextIf): string[] | null {
    const letter = String(xp.transform ?? '');

    // `${@@A}`: the `set` that makes the positional parameters again
    if (letter === 'A' && (xp.parameter === '@' || xp.parameter === '*')) {
      const values = this.positionalParams(this.paramView(ctx));

      return values.length === 0 ? [] : ['set', '--', ...values.map(singleQuoted)];
    }

    const { name, subscript } = this.splitSubscript(xp.parameter ?? '');
    const info = ctx.getVariable(name);

    if (!'KkA'.includes(letter) || letter === '' || (subscript !== '@' && subscript !== '*') || (info?.kind !== 'array' && info?.kind !== 'assoc')) {
      return null;
    }

    const assoc = info.kind === 'assoc' ? ctx.getAssoc(name) ?? {} : undefined;
    const array = info.kind === 'array' ? ctx.getArray(name) ?? [] : undefined;
    const keys = assoc ? assocKeys(assoc, name) : Object.keys(array!);
    const valueOf = (key: string): string => assoc ? assoc[key] : array![Number(key)];

    switch (letter) {
      case 'k':
        return keys.flatMap((key) => [key, valueOf(key)]);
      case 'K':
        return keys.length === 0 ? [] : [keys.map((key) => `${assoc ? keyQuoted(key) : key} ${valueQuoted(valueOf(key))}`).join(' ')];
      default:
        return [info.value === undefined ? `declare -${attributeLetters(info)} ${name}` : `declare -${attributeLetters(info)} ${name}=${compoundValue(info, name)}`];
    }
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
      case 'transformation':
        return this.transformValue(String(xp.transform ?? ''), String(xp.parameter ?? ''), value, ctx);

      case 'stringReplace':
        return this.replacePattern(xp, value, ctx);

      case 'referencedName':
        return String(xp.value ?? '');

      case 'removeSmallestSuffixPattern':
        return this.removeSuffix(value, await this.patternGlob(this.writtenWord(xp.word, xp.wordSource), ctx), false);

      case 'removeLargestSuffixPattern':
        return this.removeSuffix(value, await this.patternGlob(this.writtenWord(xp.word, xp.wordSource), ctx), true);

      case 'removeSmallestPrefixPattern':
        return this.removePrefix(value, await this.patternGlob(this.writtenWord(xp.word, xp.wordSource), ctx), false);

      case 'removeLargestPrefixPattern':
        return this.removePrefix(value, await this.patternGlob(this.writtenWord(xp.word, xp.wordSource), ctx), true);

      case 'caseChange':
        return this.changeCase(value, String(xp.pattern ?? '?'), xp.case === 'upper', Boolean(xp.globally));

      case 'substring': {
        // ${var:offset:length}, counted in characters
        const chars = [...value];
        const bounds = await this.substringBounds(xp, chars.length, ctx);

        return bounds ? chars.slice(bounds.start, bounds.end).join('') : '';
      }

      default:
        return null;
    }
  }

  /**
   * Where `${x:offset:length}` starts and ends in something `size` long. Both
   * are arithmetic; a negative offset counts from the end, and so does a
   * negative length, which then says where to stop. Undefined when the offset
   * is past either end, which leaves nothing.
   */
  private async substringBounds(
    xp: Record<string, unknown>,
    size: number,
    ctx: ExecContextIf,
    positional = false,
  ): Promise<{ start: number; end: number } | undefined> {
    const evaluate = async (expression: unknown, number: unknown) =>
      typeof expression === 'string' && expression.trim() !== '' && !/^\s*-?\d+\s*$/.test(expression)
        ? await this.arithmeticValue({ expression }, ctx)
        : Number(expression ?? number) || 0;

    let start = await evaluate(xp.offsetExpression, xp.offset);

    // `${@: -1}` counts back from the last parameter, not from $0
    if (start < 0) {
      start += size;

      if (start < (positional ? 1 : 0)) return undefined;
    }

    if (start > size) return undefined;

    if (xp.lengthExpression === undefined && xp.length == null) {
      return { start, end: size };
    }

    const length = await evaluate(xp.lengthExpression, xp.length);
    const end = length < 0 ? size + length : start + length;

    return { start, end: Math.max(start, end) };
  }

  /**
   * `${v^pattern}` / `${v,,pattern}` — convert the characters matching pattern.
   * Without the doubled operator only the first character is considered.
   */
  protected changeCase(value: string, pattern: string, upper: boolean, globally: boolean): string {
    const matches = globToRegExp(pattern);
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
      const keys = assoc ? assocKeys(assoc, name) : array ? Object.keys(array) : params[name] !== undefined ? ['0'] : [];

      return { values: keys, join: xp.expandWords ? 'field' : 'ifs' };
    }

    // ${!prefix*} and ${!prefix@} — the names of the variables that begin with it
    if (xp.op === 'prefix') {
      const prefix = String((xp as { prefix?: string }).prefix ?? '');
      const names = Object.entries(ctx.getVariables())
        .filter(([name, info]) => name.startsWith(prefix) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && info.value !== undefined)
        .map(([name]) => name)
        .sort();

      return { values: names, join: xp.expandWords ? 'field' : 'ifs' };
    }

    if (xp.op && !DISTRIBUTING_OPS.has(xp.op)) {
      return null;
    }

    // A name reference to `a[@]` expands as `${a[@]}` does
    if (typeof xp.parameter === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(xp.parameter) && ctx.getVariable(xp.parameter)?.attributes.includes('n')) {
      const all = ctx.resolveNameref(xp.parameter).match(/^([A-Za-z_][A-Za-z0-9_]*)\[([@*])\]$/);

      if (all) return { values: this.arrayElements(all[1], ctx, params), join: all[2] === '@' ? 'field' : 'ifs' };
    }

    if (xp.parameter === '@') {
      return { values: this.positionalParams(params), join: 'field' };
    }

    if (xp.parameter === '*') {
      return { values: this.positionalParams(params), join: 'ifs' };
    }

    const { name, subscript } = this.splitSubscript(xp.parameter ?? '');

    // `${f[@]:0:1}` of a plain variable is a substring of its value, as bash has it
    if (xp.op === 'substring' && params[name] !== undefined && !ctx.getArray(name) && !ctx.getAssoc(name)) {
      return null;
    }

    if (subscript === '@' || subscript === '*') {
      return { values: this.arrayElements(name, ctx, params), join: subscript === '@' ? 'field' : 'ifs' };
    }

    return null;
  }

  /**
   * `${!name…}`: the value of `name` is the parameter the expansion is really
   * about, `${!x//c/y}` with x=v being `${v//c/y}`. Each such expansion is
   * replaced by the one it leads to, parsed from that text, where it stands. A
   * name reference instead gives the name it refers to, as bash does.
   */
  protected async resolveIndirections<T extends { type: string; loc?: unknown }>(expansions: T[], ctx: ExecContextIf): Promise<T[]> {
    if (!expansions.some((xp) => (xp as { op?: string }).op === 'indirection')) return expansions;

    const resolved: T[] = [];

    for (const xp of expansions) {
      const word = (xp as { op?: string; word?: unknown }).op === 'indirection' ? String((xp as { word?: unknown }).word ?? '') : undefined;

      if (word === undefined || (xp as { resolved?: boolean }).resolved) {
        resolved.push(xp);
        continue;
      }

      const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?|\d+|[@*#?$!-])(.*)$/s);

      if (!match) throw new CommandAbortError(`${word}: bad substitution`, { code: 'E_BAD_SUBSTITUTION' });

      const [, name, rest] = match;
      const nameref = ctx.getVariable(name);

      // `${!ref}` of a nameref is the name it refers to
      if (nameref?.attributes.includes('n') && rest === '') {
        resolved.push({ ...xp, op: 'referencedName', parameter: name, value: typeof nameref.value === 'string' ? nameref.value : '' });
        continue;
      }

      const params = this.paramView(ctx);

      let { value: target, set } = await this.lookupParameter(name, ctx, params);

      // `${!*}` with no positional parameters leads to nothing: unset, not invalid
      if (!set && (name === '@' || name === '*')) {
        if (ctx.getShellOption('nounset') && !/^:?[-=+?]/.test(rest)) throw new UnboundVariableError(`!${name}`);

        target = name;
        set = true;
      }

      // `set -u` or not, as bash says it
      if (!set) {
        throw new CommandAbortError(`${name}: invalid indirect expansion`, { code: 'E_BAD_SUBSTITUTION' });
      }

      if (!/^([A-Za-z_][A-Za-z0-9_]*(\[.*\])?|\d+|[@*#?$!-])$/s.test(target)) {
        throw new CommandAbortError(`${target}: invalid variable name`, { code: 'E_BAD_SUBSTITUTION' });
      }

      // `set -u` and what it leads to is unset: bash names the indirection, `!x`
      if (ctx.getShellOption('nounset') && !/^:?[-=+?]/.test(rest) && !/^[@*]$|\[[@*]\]$/.test(target) && !(await this.isParameterSet(target, ctx, params))) {
        throw new UnboundVariableError(`!${name}`);
      }

      const ast = await parse(`\${${target}${rest}}`, { mode: 'word-expansion' });
      const inner = (ast.commands[0] as AstNodeCommand | undefined)?.name?.expansion?.[0];

      if (!inner) throw new CommandAbortError(`\${!${word}}: bad substitution`, { code: 'E_BAD_SUBSTITUTION' });

      resolved.push({ ...inner, loc: xp.loc } as unknown as T);
    }

    return resolved;
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
    opts: { noSplit?: boolean } = {},
  ): Promise<{ text: string; protectedRanges: ProtectedRange[]; status: number; emptyList: boolean }> {
    const rValue = new utils.ReplaceString(node.text);

    // Exit status of the last command substitution in this word. It is *not* an
    // error channel: an expansion never aborts the word it appears in, it only
    // reports a status the caller may adopt (only a bare assignment does).
    let status = 0;

    // Set when the whole word is a list expansion that turned out to be empty
    // Where a `"$@"` expanded to nothing
    const emptyAt: number[] = [];

    for (const xp of await this.resolveIndirections(node.expansion, ctx)) {
      if (xp.resolved) {
        continue;
      }

      if (xp.type === 'ParameterExpansion') {
        // `${$x}`: no parameter has that name, and bash refuses the whole expansion. A name
        // with a quote in it is the parser's misreading instead — in POSIX mode a `'` inside
        // "${x+'y}" is a character, which it cannot know when it parses — and is left as it was.
        if (typeof xp.parameter === 'string' && !/['"]/.test(xp.parameter) && !/^([A-Za-z_][A-Za-z0-9_]*(\[.*\])?|\d+|[@*#?$!0-])$/s.test(xp.parameter)) {
          const written = xp.loc ? node.text.slice(xp.loc.start, xp.loc.end + 1) : `\${${xp.parameter}}`;

          throw new CommandAbortError(`${written}: bad substitution`, { code: 'E_BAD_SUBSTITUTION' });
        }

        const params = this.paramView(ctx);

        // $@ and ${arr[@]} produce one field per element even inside quotes,
        // which a single substituted string cannot express — so the elements go
        // in joined by a marker that the field splitter always breaks on. "$*"
        // and "${arr[*]}" instead join on the first character of IFS; unquoted,
        // they are fields as $@ is, whatever IFS holds. Where no splitting
        // follows — an assignment, `[[ ]]`, `case` — both are one string, $@
        // joined with spaces.
        const list = this.expandListParameter(xp, ctx, params);

        if (list) {
          const ifsFirst = this.getIfs(ctx)[0] ?? '';
          const separator = opts.noSplit
            ? (list.join === 'field' ? ' ' : ifsFirst)
            : list.join === 'field' || !isDoubleQuotedAt(node.text, xp.loc!.start)
            ? utils.FIELD_MARKER
            : ifsFirst;

          // An operator on a list applies to each element in turn, except
          // ${a[@]:x:y}, which slices the list itself
          if (xp.op === 'substring') {
            // `${a[@]:1}` counts from the first element, `${@:1}` from the first
            // positional parameter — offset 0 there is $0
            const positional = xp.parameter === '@' || xp.parameter === '*';
            const values = positional ? [params['0'] ?? '', ...list.values] : list.values;
            const bounds = await this.substringBounds(xp as Record<string, unknown>, values.length, ctx, positional);

            list.values = bounds ? values.slice(bounds.start, bounds.end) : [];
          } else if (xp.op === 'transformation' && this.arrayTransform(xp, ctx) !== null) {
            list.values = this.arrayTransform(xp, ctx)!;
          } else if (xp.op) {
            const xpAny = xp as Record<string, unknown>;

            list.values = await Promise.all(list.values.map(async (value) => await this.applyValueOperator(xpAny, value, ctx) ?? value));
          }

          // Unquoted, an empty element is no word at all — except at either end,
          // where it may be joined to the rest of the word: `x$@` with "" first
          if (separator === utils.FIELD_MARKER && !isDoubleQuotedAt(node.text, xp.loc!.start)) {
            // …that is, joined to text on its own side: `x$@` with '' '' is the one word `x`
            const before = node.text.slice(0, xp.loc!.start) !== '';
            const after = node.text.slice(xp.loc!.end + 1) !== '';

            list.values = list.values.filter((value, i) => value !== '' || (i === 0 && before) || (i === list.values.length - 1 && after));
          }

          // An empty list leaves nothing, not even its quotes: `f "$@"` with no
          // arguments passes no word. Whether the word goes is decided at the end
          if (list.values.length === 0 && separator === utils.FIELD_MARKER) {
            emptyAt.push(xp.loc!.start);
          }

          rValue.replace(xp.loc!.start, xp.loc!.end + 1, list.values.join(separator));
        } else {
          const xpAny = xp as Record<string, unknown>;
          const { value: paramValue, set: isSet } = await this.lookupParameter(xp.parameter!, ctx, params);

          let resolved: string;

          // ${x-word} and its kin, taking the word, outside double quotes: its
          // quotes still quote — `${u-"a b"}` is one field, `${u-""}` an empty
          // one — so it goes in as written, with only its expansions protected
          const takesWord = xpAny.op === 'useDefaultValue'
            ? !paramValue
            : xpAny.op === 'useDefaultValueIfUnset'
            ? !isSet
            : xpAny.op === 'useAlternativeValue'
            ? Boolean(paramValue)
            : xpAny.op === 'useAlternativeValueIfUnset'
            ? isSet
            : false;

          if (takesWord && xpAny.word && !isDoubleQuotedAt(node.text, xp.loc!.start)) {
            const word = xpAny.word as AstNodeWord;
            const inner = word.expansion?.length
              ? await this.substituteExpansions(word, ctx, subs, opts)
              : { text: String(xpAny.wordSource ?? word.text), protectedRanges: [], status: 0, emptyList: false };

            status = inner.status || status;

            // `${u-"$@"}` with no parameters: nothing, as an empty "$@" is
            if (inner.emptyList) {
              emptyAt.push(xp.loc!.start);
              rValue.replace(xp.loc!.start, xp.loc!.end + 1, '');
              continue;
            }

            // A tilde prefix is expanded, `${u-~}` as `~` is; the parser saw no word there
            let { text, protectedRanges: ranges } = inner;
            const tilde = /^~([+-]?\d+|[+-]|[A-Za-z0-9._][A-Za-z0-9._@-]*)?(?=\/|$)/.exec(text);

            if (tilde && !ranges.some((range) => range.start === 0)) {
              const home = await this.tildeValue(tilde[1] ?? '', ctx);

              if (home !== undefined) {
                const prefix = singleQuoted(home);
                const shift = prefix.length - tilde[0].length;

                text = prefix + text.slice(tilde[0].length);
                ranges = ranges.map((range) => ({ start: range.start + shift, end: range.end + shift }));
              }
            }

            // Its own unquoted text is what the expansion gave, split by IFS as that
            // is: with IFS null, `${0+ $X }` keeps its blanks
            rValue.replaceWithRanges(xp.loc!.start, xp.loc!.end + 1, text, [...ranges, ...unquotedLiterals(text, ranges)]);
            continue;
          }

          // `set -u` holds for an operator on the value, `${u#x}` and `${u@Q}` alike
          if (DISTRIBUTING_OPS.has(String(xpAny.op))) this.assertParameterSet(xp.parameter!, isSet, ctx);

          const transformed = await this.applyValueOperator(xpAny, paramValue, ctx);
          const dquoted = isDoubleQuotedAt(node.text, xp.loc!.start);

          if (transformed !== null) {
            resolved = transformed;
          } else if (xpAny.op === 'useDefaultValue') {
            // ${var:-word} — use word if var is unset or empty
            resolved = paramValue || await this.operatorWordValue(xpAny, ctx, dquoted, !opts.noSplit);
          } else if (xpAny.op === 'useDefaultValueIfUnset') {
            // ${var-word} — use word if var is unset
            resolved = isSet ? paramValue : await this.operatorWordValue(xpAny, ctx, dquoted, !opts.noSplit);
          } else if (xpAny.op === 'useAlternativeValue') {
            // ${var:+word} — use word if var is set and non-empty
            resolved = paramValue ? await this.operatorWordValue(xpAny, ctx, dquoted, !opts.noSplit) : '';
          } else if (xpAny.op === 'useAlternativeValueIfUnset') {
            // ${var+word} — use word if var is set
            resolved = isSet ? await this.operatorWordValue(xpAny, ctx, dquoted, !opts.noSplit) : '';
          } else if (xpAny.op === 'assignDefaultValue' || xpAny.op === 'assignDefaultValueIfUnset') {
            // ${var:=word} / ${var=word} — when var is empty (or unset), it is assigned word, and
            // expands to it. Only a variable can be: `${1:=x}` is refused.
            const missing = xpAny.op === 'assignDefaultValue' ? !paramValue : !isSet;

            if (missing) {
              const { name, subscript } = this.splitSubscript(xp.parameter!);

              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                throw new CommandAbortError(`$${xp.parameter}: cannot assign in this way`, { code: 'E_BAD_ASSIGNMENT' });
              }

              // What it assigns is not split, as no assignment is; a tilde prefix
              // at its start is expanded, `${p:=~/bin}`
              resolved = await this.operatorWordValue(xpAny, ctx, dquoted, false, true);

              const tilde = dquoted ? null : /^~([+-]?\d+|[+-]|[A-Za-z0-9._][A-Za-z0-9._@-]*)?(?=[/:]|$)/.exec(String(xpAny.wordSource ?? ''));
              const home = tilde && resolved.startsWith(tilde[0]) ? await this.tildeValue(tilde[1] ?? '', ctx) : undefined;

              if (home !== undefined) resolved = home + resolved.slice(tilde![0].length);
              await this.applyAssignment({ name, subscript, append: false, values: [resolved], list: false, status: 0 }, ctx, false);
            } else {
              resolved = paramValue;
            }
          } else if (xpAny.op === 'indicateErrorIfUnset' || xpAny.op === 'indicateErrorIfNull') {
            // ${var?word} / ${var:?word} — complain and leave, with word as the
            // message. This is the same diagnostic `set -u` raises, so it takes
            // the same route out.
            const missing = xpAny.op === 'indicateErrorIfNull' ? !paramValue : !isSet;

            if (missing) {
              const message = await this.operatorWordValue(xpAny, ctx, dquoted);

              const said = xpAny.op === 'indicateErrorIfNull' ? 'parameter null or not set' : 'parameter not set';

              throw new UnboundVariableError(String(xp.parameter), message || said);
            }

            resolved = paramValue;
          } else if (xpAny.op === 'stringLength') {
            // ${#var}, and ${#a[@]} for the number of elements
            const { name, subscript } = this.splitSubscript(xp.parameter!);

            // `${#a[4]}` of an unset one names the array, as bash does
            this.assertParameterSet(name, isSet, ctx);

            if (name === '@' || name === '*') {
              // ${#@} and ${#*}: the number of positional parameters, as $#
              resolved = params['#'] ?? '0';
            } else {
              resolved = subscript === '@' || subscript === '*' ? String(this.arrayElements(name, ctx, params).length) : String(paramValue.length);
            }
          } else {
            // bash names an unbraced special or positional parameter as written, `$1`
            const braced = node.text[xp.loc!.start + 1] === '{';
            const shown = braced || /^[A-Za-z_]/.test(String(xp.parameter)) ? String(xp.parameter) : `$${xp.parameter}`;

            this.assertParameterSet(xp.parameter!, isSet, ctx, shown);

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
        const result = await this.arithmeticBig({ expression: xp.expression ?? '' }, ctx);

        rValue.replace(
          xp.loc!.start,
          xp.loc!.end + 1,
          String(result),
        );
      } else if (xp.type === 'ProcessSubstitution') {
        const path = await this.substituteProcess(xp, ctx, subs);

        rValue.replace(xp.loc!.start, xp.loc!.end + 1, path);
      } else if (xp.type === 'TildeExpansion') {
        const home = await this.tildeValue(xp.value, ctx);

        // What it gives is quoted: neither split nor globbed. One that leads
        // nowhere, `~nobody-here`, stays as written
        if (home !== undefined) rValue.replaceWithRanges(xp.loc!.start, xp.loc!.end + 1, `"${home}"`, [{ start: 1, end: home.length + 1 }]);
      }
    }

    // The word may go when an empty "$@" was in it and no other quotes are: those
    // keep it, `""$@` is one empty word, while `"$xxx$@"` is none
    const emptyList = emptyAt.length > 0 && !hasOtherQuotes(node.text, (node.expansion ?? []).map((xp) => xp.loc!), emptyAt);

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

    const { text: value, protectedRanges, status, emptyList } = await this.substituteExpansions(node, ctx, subs, {
      noSplit: opts.split === false || node.type === 'AssignmentWord',
    });

    const hasPathExpansion = node.expansion.some((xp) => xp.type === 'PathExpansion' && !xp.resolved);

    // POSIX: Assignment values do not undergo field splitting
    if (node.type === 'AssignmentWord') {
      const unquoted = utils.unquoteAssignmentWithProtectedRanges(value, protectedRanges);
      return { values: [unquoted], status };
    }

    // Use unquoteWordWithProtectedRanges to preserve quotes that came from expansions
    // (e.g., JSON content like {"key":"value"} should keep its quotes)
    // This also applies IFS field splitting, to unquoted expansion results only
    const ifs = opts.split === false ? '' : this.getIfs(ctx);
    const unquotedResult = utils.unquoteWordWithProtectedRanges(value, protectedRanges, ifs);
    const result = { values: unquotedResult.values, status };

    // Nothing but an empty "$@" and what expanded to nothing: no word at all
    if (emptyList && result.values.every((field) => field === '')) {
      return { values: [], status };
    }

    // Pathname expansion done here, from the directories the host lists: each
    // field a pattern in which what the word quoted matches itself
    if (opts.glob !== false && this.shell.readDirectory && !ctx.getShellOption('noglob')) {
      const patterns = globPatterns(value, protectedRanges, ifs);

      if (patterns && patterns.length === result.values.length) {
        result.values = await this.expandPathnames(ctx, result.values, patterns.map(patternOf));

        return result;
      }
    }

    // Path globbing expansion must be done last, and `set -f` turns it off — the
    // pattern is then just a word, which is also what an unmatched one becomes
    if (hasPathExpansion && opts.glob !== false && this.shell.resolvePath && !ctx.getShellOption('noglob')) {
      const newValues: string[] = [];

      for (const path of result.values) {
        const matches = await this.shell.resolvePath(ctx, path);

        // A host gives an unmatched pattern back as it was: that is the word,
        // unless `nullglob` drops it or `failglob` makes it an error
        if (matches.length === 1 && matches[0] === path && hasGlobCharacters(path)) {
          if (ctx.getShellOption('failglob')) throw new GlobNoMatchError(path);
          if (ctx.getShellOption('nullglob')) continue;
        }

        newValues.push(...matches);
      }

      result.values = newValues;
    }

    return result;
  }

  /**
   * Each field that is a pattern, `*.txt`, as the paths it matches, or itself
   * when none does — unless `nullglob` drops it or `failglob` makes that an
   * error.
   */
  private async expandPathnames(ctx: ExecContextIf, values: string[], patterns: string[]): Promise<string[]> {
    const params = this.paramView(ctx);
    const locale = params.LC_ALL || params.LC_COLLATE || params.LANG || 'C';
    const globignore = params.GLOBIGNORE ?? '';
    const options: GlobOptions = {
      dotglob: ctx.getShellOption('dotglob'),
      nocaseglob: ctx.getShellOption('nocaseglob'),
      globstar: ctx.getShellOption('globstar'),
      extglob: ctx.getShellOption('extglob'),
      ignore: globignore.split(':').filter((glob) => glob !== ''),
      // bash's default locale is C, which sorts by bytes, as does POSIX
      bytewise: /^(C|POSIX)([._@]|$)/.test(locale),
    };
    const out: string[] = [];

    for (const [i, pattern] of patterns.entries()) {
      if (!isGlobPattern(pattern, options.extglob)) {
        out.push(values[i]);
        continue;
      }

      const matches = await expandPattern(pattern, (dir) => this.shell.readDirectory!(ctx, dir), options);

      if (matches.length > 0) {
        out.push(...matches);
      } else if (ctx.getShellOption('failglob')) {
        throw new GlobNoMatchError(values[i]);
      } else if (!ctx.getShellOption('nullglob')) {
        out.push(values[i]);
      }
    }

    return out;
  }

  /**
   * The word of `${x-word}`, `${x+word}`, `${x=word}` or `${x?word}` standing
   * inside double quotes, which bash reads as double-quoted text: a `'` is a
   * character like any other, `"${x+'y'}"` gives 'y', a `\` escapes only what
   * it would between double quotes (and the `}`), and a nested `"…"` only
   * groups. Outside double quotes the word is read as a word anywhere is.
   */
  /**
   * The word of `${x-word}` and its kin, in double quotes as the expansion is.
   * With `fields`, a `"$@"` in it stays one field per parameter, as bash keeps
   * them in `"${1+ $@ }"`: they come back joined by the field marker.
   */
  private async operatorWordValue(xp: Record<string, unknown>, ctx: ExecContextIf, dquoted: boolean, fields = false, assigned = false): Promise<string> {
    const source = xp.wordSource;

    // In double quotes the word is too: `"${u-$*}"` joins on IFS as "$*" does
    if (!dquoted || typeof source !== 'string' || !/['"\\$`]/.test(source)) {
      return this.resolveWordValue(xp.word, ctx, assigned);
    }

    let text = '"';
    // Inside `$( )`, `${ }` and backquotes the word's own text stays as it is
    let depth = 0;
    let backquoted = false;

    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      const next = source[i + 1];

      if (char === '\\' && next !== undefined) {
        // `\}` is a `}`; any other escape is the double quotes'
        text += depth === 0 && !backquoted && next === '}' ? '}' : char + next;
        i++;
      } else if (char === '`') {
        backquoted = !backquoted;
        text += char;
      } else if (char === '$' && (next === '(' || next === '{')) {
        depth++;
        text += char + next;
        i++;
      } else if (depth > 0 && (char === '(' || char === '{')) {
        depth++;
        text += char;
      } else if (depth > 0 && (char === ')' || char === '}')) {
        depth--;
        text += char;
      } else if (depth === 0 && !backquoted && char === '"') {
        // A nested pair only groups: its text is double-quoted either way
      } else {
        text += char;
      }
    }

    text += '"';

    const ast = await parse(text, { mode: 'word-expansion' });
    const word = (ast.commands[0] as AstNodeCommand | undefined)?.name;

    if (!word) {
      return this.resolveWordValue(xp.word, ctx);
    }

    if (fields && /\$@|\$\{@|\[@\]/.test(source)) {
      const { values } = await this.resolveExpansions(word, ctx);

      return values.join(utils.FIELD_MARKER);
    }

    const { values } = await this.resolveExpansions({ ...word, type: 'AssignmentWord' } as AstNodeAssignmentWord, ctx);

    return values[0] ?? '';
  }

  /** A word's value; `noSplit` takes it as an assignment does, `$*` joined on IFS and nothing split. */
  private async resolveWordValue(word: unknown, ctx: ExecContextIf, noSplit = false): Promise<string> {
    if (!word || typeof word !== 'object') return '';
    const w = word as AstNodeWord;
    if (w.expansion && w.expansion.length > 0) {
      if (noSplit) return (await this.resolveExpansions({ ...w, type: 'AssignmentWord' } as AstNodeAssignmentWord, ctx)).values[0] ?? '';

      const result = await this.resolveExpansions(w, ctx);
      return result.values.join(' ');
    }
    return w.text ?? '';
  }

  private globToRegexStr(pattern: string): string {
    return globToRegexSource(pattern);
  }

  private removePrefix(value: string, pattern: string, greedy: boolean): string {
    const re = globToRegExp(pattern);
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
    const re = globToRegExp(pattern);
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
}

/** A DEBUG trap that ended the shell in the middle of a `for ((`: carries the exit signal out. */
class LoopExit {
  constructor(readonly code: number) {}
}

/**
 * Where the key of a `[key]=value` element ends, the `]` before its `=` or
 * `+=`, or -1 for a plain element. What an expansion put in it (`ranges`) is
 * the key's, `]` and quotes included.
 */
function keyEnd(element: string, ranges: ProtectedRange[]): number {
  const rangeAt = new Map(ranges.filter((range) => range.end > range.start).map((range) => [range.start, range.end]));

  if (element[0] !== '[' || rangeAt.has(0)) return -1;

  let depth = 0;
  let quote = '';

  for (let i = 0; i < element.length; i++) {
    const end = rangeAt.get(i);

    if (end !== undefined) {
      i = end - 1;
      continue;
    }

    const c = element[i];

    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"') i++;
    } else if (c === '\\') {
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '[') {
      depth++;
    } else if (c === ']' && --depth === 0) {
      return element[i + 1] === '=' || (element[i + 1] === '+' && element[i + 2] === '=') ? i : -1;
    }
  }

  return -1;
}

/**
 * Whether a word has quotes that hold no empty `"$@"` (at `emptyAt`): `""`,
 * `''` or `"$x"` beside it, which make an empty word of it. The expansions'
 * own text (`locs`) is stepped over.
 */
function hasOtherQuotes(text: string, locs: { start: number; end: number }[], emptyAt: number[]): boolean {
  const ends = new Map(locs.filter(Boolean).map((loc) => [loc.start, loc.end]));
  let open = -1;
  let quote = '';

  for (let i = 0; i < text.length; i++) {
    const end = ends.get(i);

    if (end !== undefined) {
      i = end;
      continue;
    }

    const c = text[i];

    if (quote) {
      if (c === '\\' && quote === '"') {
        i++;
      } else if (c === quote) {
        if (!emptyAt.some((at) => at > open && at < i)) return true;
        quote = '';
      }
    } else if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
      open = i;
    }
  }

  return false;
}

/** The runs of a word's text that no quotes hold, no backslash escapes and no expansion put there (`ranges`). */
function unquotedLiterals(text: string, ranges: ProtectedRange[]): ProtectedRange[] {
  const ends = new Map(ranges.filter((range) => range.end > range.start).map((range) => [range.start, range.end]));
  const literals: ProtectedRange[] = [];
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const end = ends.get(i);

    if (end !== undefined) {
      i = end - 1;
      continue;
    }

    const c = text[i];

    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else {
      const last = literals[literals.length - 1];

      if (last && last.end === i) last.end = i + 1;
      else literals.push({ start: i, end: i + 1 });
    }
  }

  return literals;
}
