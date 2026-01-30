/**
 * Implementation of the source and . builtins.
 *
 * Reads and executes commands from a file in the current shell environment.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * The source builtin command.
 *
 * Reads and executes commands from a file in the current shell environment.
 * Unlike executing a script as a subshell, source runs commands in the
 * current shell context, so variable assignments persist.
 *
 * Usage: source filename [arguments]
 *        . filename [arguments]
 *
 * If arguments are provided, they become the positional parameters when
 * executing the file. The previous positional parameters are restored
 * after the file is executed.
 *
 * @example
 * source ./config.sh       -> executes config.sh in current shell
 * . ~/.bashrc             -> executes .bashrc in current shell
 * source script.sh arg1 arg2 -> $1=arg1, $2=arg2 during execution
 */
export const sourceBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
  execute: (script: string) => Promise<number>,
): Promise<BuiltinResult> => {
  if (args.length === 0) {
    return {
      code: 2,
      stderr: 'source: filename argument required\n',
    };
  }

  const filename = args[0];
  // Additional arguments would become positional parameters
  // but execute doesn't support passing them currently

  try {
    if (!shell.readFile) {
      throw new Error(`'could not read file, readFile is not defined in shell`);
    }

    // Use readFile callback if available
    const content = await shell.readFile(ctx, filename);

    // Execute the file content in the current shell context
    const code = await execute(content);

    return { code };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      stderr: `source: ${filename}: ${message}\n`,
    };
  }
};

/**
 * The . builtin command.
 *
 * This is an alias for the source builtin.
 */
export const dotBuiltin: BuiltinHandler = sourceBuiltin;
