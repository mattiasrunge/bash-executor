import type { AstNode, AstNodeCompoundList } from '@ein/bash-parser';

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
  stderr: string;
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
 * Interface for the shell operations.
 * @interface ShellIf
 */
export interface ShellIf {
  /**
   * Executes a synchronous command.
   * @param {ExecContextIf} ctx - The execution context.
   * @param {string} name - The name of the command.
   * @param {string[]} args - The arguments for the command.
   * @returns {Promise<{ stdout: string; stderr: string }>} The output of the command.
   */
  execSyncCommand: (
    ctx: ExecContextIf,
    name: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;

  /**
   * Executes a command.
   * @param {ExecContextIf} ctx - The execution context.
   * @param {string} name - The name of the command.
   * @param {string[]} args - The arguments for the command.
   * @param {ExecCommandOptions} opts - The options for the command execution.
   * @returns {Promise<number>} The exit code of the command.
   */
  execCommand: (
    ctx: ExecContextIf,
    name: string,
    args: string[],
    opts: ExecCommandOptions,
  ) => Promise<number>;

  /**
   * Executes a subshell command.
   * @param {ExecContextIf} ctx - The execution context.
   * @param {AstNode} cmd - The AST node representing the command.
   * @param {ExecCommandOptions} opts - The options for the command execution.
   * @returns {Promise<number>} The exit code of the command.
   */
  execSubshell: (
    ctx: ExecContextIf,
    cmd: AstNode,
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
   * Runs a script.
   * @param {string} script - The script to run.
   * @returns {Promise<number>} The exit code of the script.
   */
  run: (script: string) => Promise<number>;
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
   * Redirects the standard input.
   * @param {string} name - The name of the input source.
   * @returns {string} The redirected input source.
   */
  redirectStdin: (name: string) => string;

  /**
   * Redirects the standard output.
   * @param {string} name - The name of the output destination.
   * @returns {string} The redirected output destination.
   */
  redirectStdout: (name: string) => string;

  /**
   * Redirects the standard error.
   * @param {string} name - The name of the error destination.
   * @returns {string} The redirected error destination.
   */
  redirectStderr: (name: string) => string;

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
}
