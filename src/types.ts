import type { JobHostIf, JobTable } from './jobs.ts';
import type { AstNodeCompoundList } from '@ein/bash-parser';
import type { FunctionDefinition } from './print-command.ts';

/**
 * Represents a function definition in the execution context.
 * @typedef {Object} FunctionDef
 * @property {string} name - The name of the function.
 * @property {AstNodeCompoundList} body - The body of the function.
 * @property {ExecContextIf} ctx - The execution context of the function.
 * @property {FunctionDefinition} [definition] - Where it was defined, for printing it back.
 */
export type FunctionDef = {
  name: string;
  body: AstNodeCompoundList;
  ctx: ExecContextIf;
  definition?: FunctionDefinition;
};

/**
 * Represents the input/output streams.
 * @typedef {Object} IO
 * @property {string} stdin - The standard input stream.
 * @property {string} stdout - The standard output stream.
 * @property {string} stderr - The standard error stream.
 */
/**
 * Where getopts stands inside a group of options such as `-abc` between two
 * calls: the argument, and the index of its next option character. bash's
 * sh_curopt and sh_charindex.
 */
export type GetoptsState = { curopt: number; charindex: number };

/**
 * Put after the `=` of a declaration builtin's argument whose value only looks
 * like an element list: `declare c='(3)'` was quoted, so it is the string
 * `(3)` — unless it lands in an array, where bash reads it as a list after all.
 * A Unicode noncharacter, which no text holds.
 */
export const QUOTED_LIST_MARK = '\uFDD2';

/** What a variable holds: a string, an indexed array or an associative one. */
export type VariableKind = 'scalar' | 'array' | 'assoc';

/**
 * A variable as `declare -p` sees it. `value` is absent while it is only
 * declared (`declare x`, `local -a y`); `attributes` are declare's letters in
 * bash's order — i integer, l lower case, n name reference, r readonly,
 * t trace, u upper case, x exported — and `local` says a function holds it.
 */
export type VariableInfo = {
  kind: VariableKind;
  value?: string | string[] | Record<string, string>;
  attributes: string;
  local: boolean;
};

/** What `declareVariable` makes of a name. */
export type DeclareOptions = {
  /** Make it this kind, converting a scalar's value to element 0 */
  kind?: VariableKind;
  /** Attribute letters to give it */
  add?: string;
  /** Attribute letters to take away */
  remove?: string;
  /** Declare it in this context — a function's own, as `local` does — rather than where it is */
  local?: boolean;
};

export type IO = {
  stdin: string;
  stdout: string;
  stdoutAppend?: boolean;
  stderr: string;
  stderrAppend?: boolean;
};

/**
 * Options for executing a command.
 * @typedef {Object} ExecCommandOptions
 * @property {boolean} [async] - Whether the command should be executed asynchronously.
 */
export type ExecCommandOptions = {
  async?: boolean;
  /** The name to run the command as, its argv[0], when it is not the name: `exec -a`, `exec -l` */
  argv0?: string;
  /** Run the command with an empty environment: `exec -c` */
  clearEnv?: boolean;
};

/**
 * Result of a synchronous execution
 * @typedef {Object} ExecSyncResult
 * @property {string} stdout - The standard output stream.
 * @property {string} stderr - The standard error stream.
 * @property {number} code - The exit code of the command
 */
export type ExecSyncResult = {
  stdout: string;
  stderr: string;
  code: number;
};

/** Shared byte budget for concurrent stdout/stderr capture drains. */
export type CaptureBudgetIf = {
  consume(bytes: number): void;
};

/** Options a host shell may honor while draining a pipe. */
export type PipeReadOptions = {
  signal?: AbortSignal;
  captureBudget?: CaptureBudgetIf;
};

/** Guardrails for a captured execution. */
export type ExecuteAndCaptureOptions = PipeReadOptions;

/**
 * The shell options `set` knows, and their default values. Options are per-shell
 * state and live on the context, not in a module global — MURRiX runs every
 * session's shell in one process, so a global would let one session's
 * `set -o pipefail` change another session's pipeline exit codes.
 */
export const DEFAULT_SHELL_OPTIONS: Record<string, boolean> = {
  errexit: false, // -e: Exit on error
  nounset: false, // -u: Error on unset variables
  xtrace: false, // -x: Print commands before execution
  verbose: false, // -v: Print input lines
  noclobber: false, // -C: Prevent > from overwriting files
  noglob: false, // -f: Disable pathname expansion
  allexport: false, // -a: Export all variables
  notify: false, // -b: Notify of job termination immediately
  ignoreeof: false, // Require 'exit' to leave shell
  monitor: false, // -m: Job control
  noexec: false, // -n: Don't execute commands
  pipefail: false, // A pipeline fails if any stage fails, not just the last
  // Recorded so scripts can set and test them; the executor does not act on them
  braceexpand: true, // -B
  emacs: false,
  errtrace: false, // -E
  functrace: false, // -T
  hashall: true, // -h
  histexpand: false, // -H
  history: false,
  'interactive-comments': true,
  keyword: false, // -k
  nolog: false,
  onecmd: false, // -t
  physical: false, // -P
  posix: false,
  privileged: false, // -p
  vi: false,
};

/**
 * `shopt`'s options with bash 5.2's defaults. They share the context's option
 * store with `set -o`'s, since no name is in both. The executor acts on
 * `lastpipe`; the rest are recorded for scripts to set and test.
 */
export const DEFAULT_SHOPT_OPTIONS: Record<string, boolean> = Object.fromEntries(
  ('autocd:0 assoc_expand_once:0 cdable_vars:0 cdspell:0 checkhash:0 checkjobs:0 checkwinsize:1 cmdhist:1 compat31:0 compat32:0 ' +
    'compat40:0 compat41:0 compat42:0 compat43:0 compat44:0 complete_fullquote:1 direxpand:0 dirspell:0 dotglob:0 execfail:0 ' +
    'expand_aliases:0 extdebug:0 extglob:0 extquote:1 failglob:0 force_fignore:1 globasciiranges:1 globskipdots:1 globstar:0 ' +
    'gnu_errfmt:0 histappend:0 histreedit:0 histverify:0 hostcomplete:1 huponexit:0 inherit_errexit:0 interactive_comments:1 ' +
    'lastpipe:0 lithist:0 localvar_inherit:0 localvar_unset:0 login_shell:0 mailwarn:0 no_empty_cmd_completion:0 nocaseglob:0 ' +
    'nocasematch:0 noexpand_translation:0 nullglob:0 patsub_replacement:1 progcomp:1 progcomp_alias:0 promptvars:1 ' +
    'restricted_shell:0 shift_verbose:0 sourcepath:1 varredir_close:0 xpg_echo:0').split(' ').map((entry) => {
      const [name, on] = entry.split(':');

      return [name, on === '1'];
    }),
);

/**
 * Short `set` flags mapped to the option they name. `pipefail` has no short
 * flag, in bash either.
 */
export const SHELL_OPTION_FLAG_MAP: Record<string, string> = {
  e: 'errexit',
  u: 'nounset',
  x: 'xtrace',
  v: 'verbose',
  C: 'noclobber',
  f: 'noglob',
  a: 'allexport',
  b: 'notify',
  m: 'monitor',
  n: 'noexec',
  B: 'braceexpand',
  E: 'errtrace',
  T: 'functrace',
  h: 'hashall',
  H: 'histexpand',
  k: 'keyword',
  t: 'onecmd',
  P: 'physical',
  p: 'privileged',
};

export const PATH_TEST_OPERATOR_MAP: Record<string, string> = {
  '-e': 'EXISTS',
  '-f': 'REGULAR_FILE',
  '-d': 'DIRECTORY',
  '-r': 'READABLE',
  '-w': 'WRITABLE',
  '-x': 'EXECUTABLE',
  '-s': 'NON_EMPTY',
  '-L': 'SYMLINK',
  '-h': 'SYMLINK',
  '-b': 'BLOCK_DEVICE',
  '-c': 'CHAR_DEVICE',
  '-p': 'NAMED_PIPE',
  '-S': 'SOCKET',
  '-g': 'SETGID',
  '-u': 'SETUID',
  '-k': 'STICKY',
  '-O': 'OWNED_BY_EUID',
  '-G': 'OWNED_BY_EGID',
  '-N': 'MODIFIED_SINCE_LAST_READ',
  '-t': 'FD_IS_TERMINAL',
  '-nt': 'NEWER_THAN',
  '-ot': 'OLDER_THAN',
  '-ef': 'SAME_DEVICE_AND_INODE',
} as const;
type PathTestOperator = keyof typeof PATH_TEST_OPERATOR_MAP;
export type PathTestOperation = typeof PATH_TEST_OPERATOR_MAP[PathTestOperator];

/**
 * Interface for the shell operations.
 * @interface ShellIf
 */
export interface ShellIf {
  /**
   * Executes an external command (not a builtin or function - those are handled by the executor).
   * @param {ExecContextIf} ctx - The execution context.
   * @param {string} name - The name of the command.
   * @param {string[]} args - The arguments for the command.
   * @param {ExecCommandOptions} opts - The options for the command execution.
   * @returns {Promise<number>} The exit code of the command.
   */
  execute: (
    ctx: ExecContextIf,
    name: string,
    args: string[],
    opts: ExecCommandOptions,
  ) => Promise<number>;

  /**
   * Job control, when the host has it: with this the executor runs every `&`
   * as a job in its table and provides `jobs`, `wait`, `kill`, `disown`, `fg`
   * and `bg`. Without it `&` goes to `execute` and `executeBackground` as
   * before, and those names are left to the host's own commands.
   */
  jobs?: JobHostIf;

  /**
   * Runs a piece of the parse tree in the background, for the `&` cases that
   * `execute` cannot reach: a list, a group, a subshell, a loop, a builtin or a
   * function. Only the shell can give such a command a process of its own — a
   * pid, private output, a place in the job table — so the executor hands over
   * a thunk to run instead of a name and arguments.
   *
   * `run` is called with the context the job should use; it re-enters the
   * executor on the same node with the `&` cleared. `command` is the node's own
   * source text, for the job table to show.
   *
   * Optional: where a shell does not implement it, such a command runs in the
   * foreground, which is what every shell did before.
   * @param {ExecContextIf} ctx - The execution context the command was reached from.
   * @param {Function} run - Runs the command, in the context it is given.
   * @param {string} command - The command's source text.
   * @returns {Promise<number>} The exit code of starting it (not of the job).
   */
  executeBackground?: (
    ctx: ExecContextIf,
    run: (ctx: ExecContextIf) => Promise<number>,
    command: string,
  ) => Promise<number>;

  /**
   * Opens a pipe.
   * @returns {Promise<string>} The name of the pipe.
   */
  pipeOpen: () => Promise<string>;

  /**
   * Closes a pipe.
   * @param {string} name - The name of the pipe.
   * @returns {Promise<void>}
   */
  pipeClose: (name: string) => Promise<void>;

  /**
   * Removes a pipe.
   * @param {string} name - The name of the pipe.
   * @returns {Promise<void>}
   */
  pipeRemove: (name: string) => Promise<void>;

  /**
   * Reads from a pipe.
   * @param {string} name - The name of the pipe.
   * @returns {Promise<string>} The content read from the pipe.
   */
  pipeRead: (name: string, opts?: PipeReadOptions) => Promise<string>;

  /**
   * Write to a pipe.
   * @param {string} name - The name of the pipe.
   * @param {string} data - The content to write to the pipe.
   * @returns {Promise<void>}
   */
  pipeWrite: (name: string, data: string) => Promise<void>;

  /**
   * Checks if a name refers to a managed pipe (as opposed to a file path).
   * @param {string} name - The name to check.
   * @returns {boolean} True if the name is a managed pipe.
   */
  isPipe: (name: string) => boolean;

  /**
   * Streams data from a file to a pipe. The shell reads from the file and writes to the pipe.
   * When done reading, the pipe should be closed to signal EOF.
   * @param {ExecContextIf} ctx - The execution context.
   * @param {string} path - The file path to read from.
   * @param {string} pipe - The pipe name to write to.
   * @returns {Promise<void>}
   */
  pipeFromFile: (ctx: ExecContextIf, path: string, pipe: string) => Promise<void>;

  /**
   * Streams data from a pipe to a file. The shell reads from the pipe and writes to the file.
   * @param {ExecContextIf} ctx - The execution context.
   * @param {string} pipe - The pipe name to read from.
   * @param {string} path - The file path to write to.
   * @param {boolean} append - Whether to append to the file or overwrite.
   * @returns {Promise<void>}
   */
  pipeToFile: (ctx: ExecContextIf, pipe: string, path: string, append: boolean) => Promise<void>;

  /**
   * Opens an existing path as a file descriptor with the given mode.
   * Unlike pipeOpen which creates a new ephemeral pipe, this opens an existing resource.
   * @param {ExecContextIf} ctx - The execution context.
   * @param {string} path - The path to open.
   * @param {string} mode - The open mode (e.g. 'r', 'r+', 'w+').
   * @param {string} [fd] - Optional FD number to assign. If not given, next free FD is used.
   * @returns {Promise<string>} The assigned FD number.
   */
  fdOpen?: (ctx: ExecContextIf, path: string, mode: string, fd?: string) => Promise<string>;

  /**
   * Closes a file descriptor opened with fdOpen. Closes the handle without unlinking the resource.
   * @param {string} fd - The file descriptor to close.
   * @returns {Promise<void>}
   */
  fdClose?: (fd: string) => Promise<void>;

  /**
   * Reads one line (up to delimiter) from a file descriptor. Keeps the handle open between calls.
   * Returns null on EOF.
   * @param {string} fd - The file descriptor to read from.
   * @param {string} [delimiter] - Line delimiter, defaults to '\n'.
   * @returns {Promise<string | null>} The line without the delimiter, or null on EOF.
   */
  pipeReadLine?: (fd: string, delimiter?: string) => Promise<string | null>;

  /**
   * Creates a scratch file and returns its path, for process substitution.
   *
   * `cat <(cmd)` has to hand the reading command something it can open. A shell
   * without this callback rejects `<(…)` rather than passing on a path that does
   * not work.
   *
   * @param ctx - The execution context.
   * @returns The path of a new, empty file.
   */
  tempFile?: (ctx: ExecContextIf) => Promise<string>;

  /**
   * Removes a file made by tempFile.
   *
   * @param ctx - The execution context.
   * @param path - The path to remove.
   */
  removeTempFile?: (ctx: ExecContextIf, path: string) => Promise<void>;

  /**
   * The files a command name could run, found on `path` (by default PATH) as
   * the host finds commands, in the order it looks: the first is the one that
   * runs, and none means there is no such command. A name with a slash is a
   * path, found when the file is there. `type`, `command -v` and `hash` ask
   * this, and ask `which -a` when the host has no answer of its own.
   */
  lookupCommand?: (ctx: ExecContextIf, name: string, path?: string) => Promise<string[]>;

  /**
   * A callback to resolve path globbing. If specified, the parser calls it whenever it needs to resolve path globbing. It should return the expanded path. If the option is not specified, the parser won't try to resolve any path globbing.
   *
   * @param ctx - The execution context.
   * @param text - The text to resolve.
   * @returns The expanded path.
   */
  resolvePath?: (ctx: ExecContextIf, text: string) => Promise<string[]>;

  /**
   * A callback to resolve users' home directories. If specified, the parser calls it whenever it needs to resolve a tilde expansion. If the option is not specified, the parser won't try to resolve any tilde expansion. When the callback is called with a null value for `username`, the callback should return the current user's home directory.
   *
   * @param ctx - The execution context.
   * @param username - The username whose home directory to resolve, or `null` for the current user.
   * @returns The home directory of the specified user, or the current user's home directory if `username` is `null`.
   */
  resolveHomeUser?: (ctx: ExecContextIf, username: string | null) => Promise<string>;

  /**
   * A callback to read file contents directly. If specified, the source builtin will use this.
   *
   * @param ctx - The execution context.
   * @param path - The file path to read.
   * @returns The file contents.
   * @throws If the file cannot be read.
   */
  readFile?: (ctx: ExecContextIf, path: string) => Promise<string>;

  /**
   * A callback to test a path and see if it passes the operation
   *
   * @param ctx - The execution context.
   * @param path - The path to check.
   * @param op - The test operation to check.
   * @param path - Optional second path which is needed for some test operations.
   * @returns If the path passed the operation test or not.
   */
  testPath?: (ctx: ExecContextIf, path: string, op: PathTestOperation, path2?: string) => Promise<boolean>;
}

/**
 * Interface for the execution context.
 * @interface ExecContextIf
 */
export interface ExecContextIf {
  /**
   * Spawns a new execution context.
   * @returns {ExecContextIf} The new execution context.
   */
  spawnContext: () => ExecContextIf;

  /**
   * Spawns a new execution context for sub shells.
   * @returns {ExecContextIf} The new execution context.
   */
  subContext(): ExecContextIf;

  /** Gets the cancellation signal inherited by work in this context. */
  getAbortSignal(): AbortSignal | undefined;

  /** Sets the cancellation signal for work in this context and its children. */
  setAbortSignal(signal: AbortSignal | undefined): void;

  /**
   * Gets the current working directory.
   * @returns {string} The current working directory.
   */
  getCwd: () => string;

  /**
   * Sets the current working directory.
   * @param {string} cwd - The new working directory.
   * @returns {string} The updated working directory.
   */
  setCwd: (cwd: string) => string;

  /**
   * Gets the environment variables.
   * @returns {Record<string, string>} The environment variables.
   */
  getEnv: () => Record<string, string>;

  /**
   * Sets the environment variables.
   * @param {Record<string, string | null>} values - The environment variables to set.
   * @returns {Record<string, string>} The updated environment variables.
   */
  setEnv: (values: Record<string, string | null>) => Record<string, string>;

  /**
   * Sets the local environment variables.
   * @param {Record<string, string | null>} values - The local environment variables to set.
   * @returns {Record<string, string>} The updated local environment variables.
   */
  setLocalEnv: (
    values: Record<string, string | null>,
  ) => Record<string, string>;

  /**
   * Gets the parameters.
   * @returns {Record<string, string>} The parameters.
   */
  getParams: () => Record<string, string>;

  /**
   * Sets the parameters.
   * @param {Record<string, string | null>} values - The parameters to set.
   * @returns {Record<string, string>} The updated parameters.
   */
  setParams: (values: Record<string, string | null>) => Record<string, string>;

  /**
   * Sets the local parameters.
   * @param {Record<string, string | null>} values - The local parameters to set.
   * @returns {Record<string, string>} The updated local parameters.
   */
  setLocalParams: (
    values: Record<string, string | null>,
  ) => Record<string, string>;

  /**
   * Gets a shell option's value, as set by `set -o <name>`.
   * Options are per-shell: a spawned context reads the shell's, a subshell gets
   * a copy it cannot write back through.
   * @param {string} name - The option name.
   * @returns {boolean} The option value, false when the option is unknown.
   */
  getShellOption: (name: string) => boolean;

  /**
   * Gets every shell option and its value.
   * @returns {Record<string, boolean>} The options.
   */
  getShellOptions: () => Record<string, boolean>;

  /**
   * Sets a shell option on the shell this context belongs to.
   * @param {string} name - The option name.
   * @param {boolean} value - The option value.
   */
  setShellOption: (name: string, value: boolean) => void;

  /**
   * Whether `errexit` is suppressed for what runs in this context.
   * Bash exempts a command from `set -e` by where it sits — the clause of an
   * `if`, anything under `!`, the left of `&&`/`||`, a pipeline stage — and the
   * exemption covers whatever that command calls, functions included.
   * @returns {boolean} True when a failure here must not end the shell.
   */
  getErrexitSuppressed: () => boolean;

  /**
   * Suppresses (or restores) `errexit` for this context and its children.
   * @param {boolean} value - True to exempt.
   */
  setErrexitSuppressed: (value: boolean) => void;

  /**
   * Gets an indexed array, or undefined when the name is not an array.
   * Arrays live beside the params, are never exported, and can be sparse.
   * @param {string} name - The variable name.
   * @returns {string[] | undefined} The array values.
   */
  getArray: (name: string) => string[] | undefined;

  /**
   * Gets all arrays, including those of parent contexts.
   * @returns {Record<string, string[]>} All arrays.
   */
  getArrays: () => Record<string, string[]>;

  /**
   * Sets an array in the shell context.
   * @param {string} name - The variable name.
   * @param {string[]} values - The array values.
   */
  setArray: (name: string, values: string[]) => void;

  /**
   * Sets an array in this context only, for prefix assignments and `local`.
   * @param {string} name - The variable name.
   * @param {string[]} values - The array values.
   */
  setLocalArray: (name: string, values: string[]) => void;

  /**
   * Sets one element, creating the array if needed.
   * @param {string} name - The variable name.
   * @param {number} index - The index to assign.
   * @param {string} value - The value.
   */
  setArrayElement: (name: string, index: number, value: string) => void;

  /**
   * Removes an array.
   * @param {string} name - The variable name.
   */
  unsetArray: (name: string) => void;

  /**
   * Removes one element, leaving a hole.
   * @param {string} name - The variable name.
   * @param {number} index - The index to remove.
   */
  unsetArrayElement: (name: string, index: number) => void;

  /**
   * Gets an associative array, or undefined when the name is not one.
   * A name is associative because it was declared with `declare -A`, which is
   * what makes its subscripts keys rather than arithmetic expressions.
   * @param {string} name - The variable name.
   * @returns {Record<string, string> | undefined} The keys and values.
   */
  getAssoc: (name: string) => Record<string, string> | undefined;

  /**
   * Gets all associative arrays, including those of parent contexts.
   * @returns {Record<string, Record<string, string>>} All associative arrays.
   */
  getAssocs: () => Record<string, Record<string, string>>;

  /**
   * Sets an associative array in the shell context.
   * @param {string} name - The variable name.
   * @param {Record<string, string>} values - The keys and values.
   */
  setAssoc: (name: string, values: Record<string, string>) => void;

  /**
   * Sets an associative array in this context only.
   * @param {string} name - The variable name.
   * @param {Record<string, string>} values - The keys and values.
   */
  setLocalAssoc: (name: string, values: Record<string, string>) => void;

  /**
   * Sets one key, creating the array if needed.
   * @param {string} name - The variable name.
   * @param {string} key - The key to assign.
   * @param {string} value - The value.
   */
  setAssocElement: (name: string, key: string, value: string) => void;

  /**
   * Removes an associative array.
   * @param {string} name - The variable name.
   */
  unsetAssoc: (name: string) => void;

  /**
   * Removes one key.
   * @param {string} name - The variable name.
   * @param {string} key - The key to remove.
   */
  unsetAssocElement: (name: string, key: string) => void;

  /**
   * Sets a function in the execution context.
   * @param {string} name - The name of the function.
   * @param {AstNodeCompoundList} body - The body of the function.
   * @param {ExecContextIf} ctx - The execution context of the function.
   * @param {FunctionDefinition} [definition] - The definition as parsed, which `type` and `declare -f` print.
   */
  setFunction: (
    name: string,
    body: AstNodeCompoundList,
    ctx: ExecContextIf,
    definition?: FunctionDefinition,
  ) => void;

  /**
   * Unsets a function in the execution context.
   * @param {string} name - The name of the function.
   */
  unsetFunction: (name: string) => void;

  /**
   * Gets a function from the execution context.
   * @param {string} name - The name of the function.
   * @returns {FunctionDef | null} The function definition or null if not found.
   */
  getFunction: (name: string) => FunctionDef | null;

  /**
   * Gets all functions from the execution context including parent contexts.
   * @returns {Record<string, FunctionDef>} All function definitions.
   */
  getFunctions: () => Record<string, FunctionDef>;

  /**
   * Sets an alias in the execution context.
   * @param {string} name - The name of the alias.
   * @param {string} args - The arguments of the alias.
   */
  setAlias: (name: string, alias: string) => void;

  /**
   * Unsets an alias in the execution context.
   * @param {string} name - The name of the alias.
   */
  unsetAlias: (name: string) => void;

  /**
   * Gets an alias from the execution context.
   * @param {string} name - The name of the alias.
   * @returns {string | undefined} The alias arguments or undefined if not found.
   */
  getAlias: (name: string) => string | undefined;

  /**
   * The command a trap runs, by its name as `trap -p` prints it (`EXIT`,
   * `SIGINT`, `ERR`, …): undefined when none is set, '' when it is ignored.
   * Traps are the shell's, so a function or a spawned context shares them.
   */
  getTrap(name: string): string | undefined;

  /** Set a trap, or with null reset it. */
  setTrap(name: string, action: string | null): void;

  getTraps(): Record<string, string>;

  /** The shell's job table: a subshell has one of its own, empty. */
  getJobTable(): JobTable;

  /**
   * Where getopts left off inside an argument, or undefined at the start of
   * one. Assigning or unsetting OPTIND clears it, as it does in bash.
   */
  getGetoptsState(): GetoptsState | undefined;

  setGetoptsState(state: GetoptsState | undefined): void;

  /**
   * The shell's file creation mask, as `umask` sets it: 022 until then. The
   * executor only keeps it; a host that creates files applies it.
   */
  getUmask(): number;

  setUmask(mask: number): void;

  /**
   * Gets all aliases from the execution context.
   * @returns {Record<string, string>} All alias definitions.
   */
  getAliases: () => Record<string, string>;

  /**
   * The nearest variable of that name, set or only declared, or undefined.
   * @param {string} name - The variable's name.
   * @returns {VariableInfo | undefined} Its kind, value and attributes.
   */
  getVariable: (name: string) => VariableInfo | undefined;

  /**
   * Every variable this context sees, each the nearest of its name.
   * @returns {Record<string, VariableInfo>} By name.
   */
  getVariables: () => Record<string, VariableInfo>;

  /**
   * The variables this context holds itself: a function's locals, in its frame.
   * @returns {Record<string, VariableInfo>} By name.
   */
  getOwnVariables: () => Record<string, VariableInfo>;

  /**
   * Declare a variable, `declare -ai x` without a value: made unset where it
   * does not exist, converted to another kind, attributes given or taken.
   * @param {string} name - The variable's name.
   * @param {DeclareOptions} opts - The kind, the attributes, and whether it is local.
   */
  declareVariable: (name: string, opts?: DeclareOptions) => void;

  /**
   * Unset a variable, whatever its kind. A function's local stays local, unset,
   * so assigning it again sets the function's own, as in bash.
   * @param {string} name - The variable's name.
   */
  unsetVariable: (name: string) => void;

  /**
   * Checks if a variable is marked as readonly.
   * @param {string} name - The variable name.
   * @returns {boolean} True if the variable is readonly.
   */
  isReadonlyVar: (name: string) => boolean;

  /**
   * Sets or unsets the readonly flag for a variable.
   * @param {string} name - The variable name.
   * @param {boolean} readonly - Whether the variable should be readonly.
   */
  setReadonlyVar: (name: string, readonly: boolean) => void;

  /**
   * Checks if a variable is marked as integer.
   * @param {string} name - The variable name.
   * @returns {boolean} True if the variable is an integer variable.
   */
  isIntegerVar: (name: string) => boolean;

  /**
   * Sets or unsets the integer flag for a variable.
   * @param {string} name - The variable name.
   * @param {boolean} integer - Whether the variable should be an integer.
   */
  setIntegerVar: (name: string, integer: boolean) => void;

  /**
   * Gets the directory stack.
   * @returns {string[]} The directory stack (top of stack is index 0).
   */
  getDirStack: () => string[];

  /**
   * Pushes a directory onto the stack.
   * @param {string} dir - The directory to push.
   */
  pushDirStack: (dir: string) => void;

  /**
   * Pops a directory from the stack.
   * @returns {string | undefined} The popped directory, or undefined if stack is empty.
   */
  popDirStack: () => string | undefined;

  /**
   * Clears the directory stack.
   */
  clearDirStack: () => void;

  /**
   * Removes a directory from the stack at a specific index.
   * @param {number} index - The index to remove (0-based from top).
   * @returns {string | undefined} The removed directory, or undefined if index is invalid.
   */
  removeDirStackAt: (index: number) => string | undefined;

  /**
   * Redirects the standard input.
   * @param {string} name - The name of the input source.
   * @returns {string} The redirected input source.
   */
  redirectStdin: (name: string) => string;

  /**
   * Redirects the standard output.
   * @param {string} name - The name of the output destination.
   * @param {boolean} append - Optional if we should append destination
   * @returns {string} The redirected output destination.
   */
  redirectStdout: (name: string, append?: boolean) => string;

  /**
   * Redirects the standard error.
   * @param {string} name - The name of the error destination.
   * * @param {boolean} append - Optional if we should append destination
   * @returns {string} The redirected error destination.
   */
  redirectStderr: (name: string, append?: boolean) => string;

  /**
   * Gets the standard input.
   * @returns {string} The standard input.
   */
  getStdin: () => string;

  /**
   * Gets the standard output.
   * @returns {string} The standard output.
   */
  getStdout: () => string;

  /**
   * Gets the standard error.
   * @returns {string} The standard error.
   */
  getStderr: () => string;

  /**
   * Gets the append flag for standard output.
   * @returns {boolean} The standard output append flag.
   */
  getStdoutAppend: () => boolean;

  /**
   * Gets the appen flag for standard error.
   * @returns {boolean} The standard error append flag.
   */
  getStderrAppend: () => boolean;

  /**
   * Gets the parent context, if any.
   * @returns {ExecContextIf | undefined} The parent context or undefined if root.
   */
  getParent: () => ExecContextIf | undefined;

  /**
   * The context of the function this one runs in — where `local` and `declare`
   * put a variable — or undefined outside any function.
   */
  getFunctionScope: () => ExecContextIf | undefined;

  /**
   * Set a variable as a plain `name=value` does: in the environment when it is
   * exported there, as a shell variable otherwise. Readonly is the caller's to check.
   */
  assignVariable: (name: string, value: string) => void;

  /**
   * Gets the target for an arbitrary file descriptor (0-2 map to stdin/stdout/stderr).
   * @param {string} fd - The file descriptor number.
   * @returns {string | undefined} The target pipe/file name or undefined if not set.
   */
  getFd: (fd: string) => string | undefined;

  /**
   * Redirects an arbitrary file descriptor. For 0-2 delegates to redirectStdin/Stdout/Stderr.
   * FDs 3+ propagate to parent context (shell-level persistence for exec).
   * @param {string} fd - The file descriptor number.
   * @param {string} target - The target pipe/file name.
   */
  redirectFd: (fd: string, target: string) => void;

  /**
   * Closes an arbitrary file descriptor by removing it from the context.
   * @param {string} fd - The file descriptor number.
   */
  closeFd: (fd: string) => void;
}
