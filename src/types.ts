import type { AstNodeCompoundList } from '@ein/bash-parser';

/**
 * Represents a function definition in the execution context.
 * @typedef {Object} FunctionDef
 * @property {string} name - The name of the function.
 * @property {AstNodeCompoundList} body - The body of the function.
 * @property {ExecContextIf} ctx - The execution context of the function.
 */
export type FunctionDef = {
  name: string;
  body: AstNodeCompoundList;
  ctx: ExecContextIf;
};

/**
 * Represents the input/output streams.
 * @typedef {Object} IO
 * @property {string} stdin - The standard input stream.
 * @property {string} stdout - The standard output stream.
 * @property {string} stderr - The standard error stream.
 */
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
  pipeRead: (name: string) => Promise<string>;

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
   * Sets a function in the execution context.
   * @param {string} name - The name of the function.
   * @param {AstNodeCompoundList} body - The body of the function.
   * @param {ExecContextIf} ctx - The execution context of the function.
   */
  setFunction: (
    name: string,
    body: AstNodeCompoundList,
    ctx: ExecContextIf,
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
   * Gets all aliases from the execution context.
   * @returns {Record<string, string>} All alias definitions.
   */
  getAliases: () => Record<string, string>;

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
}
