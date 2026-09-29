/**
 * Implementation of the readonly builtin.
 *
 * Marks variables as readonly (cannot be modified or unset).
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';
import { declareCommand } from './declare.ts';

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
export const readonlyBuiltin: BuiltinHandler = (ctx: ExecContextIf, args: string[], _shell: ShellIf): Promise<BuiltinResult> => declareCommand('readonly', ctx, args);
