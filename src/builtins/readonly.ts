/**
 * Implementation of the readonly builtin.
 *
 * Marks variables as readonly (cannot be modified or unset).
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';
import { declareBuiltin } from './declare.ts';

/**
 * The readonly builtin command.
 *
 * Marks variables as readonly. Once marked readonly, a variable cannot
 * be modified or unset. This is equivalent to `declare -r`.
 *
 * Options:
 * -p    Display all readonly variables
 * -f    Mark functions as readonly (limited support)
 * -a    Apply to indexed array variables
 * -A    Apply to associative array variables
 *
 * @example
 * readonly CONST=42    -> CONST cannot be changed
 * readonly PATH        -> mark existing PATH as readonly
 * readonly -p          -> list all readonly variables
 */
export const readonlyBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
  execute: (script: string) => Promise<number>,
): Promise<BuiltinResult> => {
  // If -p is specified, just pass through to declare
  if (args.includes('-p')) {
    return declareBuiltin(ctx, ['-r', '-p', ...args.filter((a) => a !== '-p')], shell, execute);
  }

  // Otherwise, prepend -r to all arguments and delegate to declare
  return declareBuiltin(ctx, ['-r', ...args], shell, execute);
};
