/**
 * Implementation of the eval builtin.
 *
 * Concatenates arguments and executes them as a shell command.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * The eval builtin command.
 *
 * Concatenates all arguments with spaces and executes the resulting string
 * as a shell command.
 *
 * @example
 * eval "echo hello" -> executes: echo hello
 * eval echo hello   -> executes: echo hello
 * eval 'x=5; echo $x' -> executes: x=5; echo $x
 */
export const evalBuiltin: BuiltinHandler = async (
  _ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
  execute: (script: string) => Promise<number>,
): Promise<BuiltinResult> => {
  // If no arguments, return success
  if (args.length === 0) {
    return { code: 0 };
  }

  // Concatenate all arguments with spaces
  const script = args.join(' ');

  // Execute the script
  const code = await execute(script);

  return { code };
};
