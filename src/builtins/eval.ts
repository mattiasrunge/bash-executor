/**
 * Implementation of the eval builtin.
 *
 * Concatenates arguments and executes them as a shell command.
 */

import { BashSyntaxError } from '../errors.ts';
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
  // eval takes no options, but says so of one
  if (args[0] === '--') {
    args = args.slice(1);
  } else if (/^-./.test(args[0] ?? '')) {
    return { code: 2, stderr: `eval: ${args[0].slice(0, 2)}: invalid option\neval: usage: eval [arg ...]\n` };
  }

  // If no arguments, return success
  if (args.length === 0) {
    return { code: 0 };
  }

  // Concatenate all arguments with spaces
  const script = args.join(' ');

  // A syntax error fails the eval with 2, after what came before it ran; the
  // shell around it carries on, as in bash
  try {
    return { code: await execute(script) };
  } catch (err) {
    if (err instanceof BashSyntaxError) {
      return { code: 2, stderr: `eval: syntax error: ${err.message.split('\n')[0]}\n` };
    }

    throw err;
  }
};
