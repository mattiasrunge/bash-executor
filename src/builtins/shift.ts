/**
 * Implementation of the shift builtin.
 *
 * Shifts positional parameters to the left.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * The shift builtin command.
 *
 * Shifts the positional parameters ($1, $2, ...) to the left by n positions.
 * By default, n is 1. After shifting:
 * - $1 becomes what was $2
 * - $2 becomes what was $3
 * - etc.
 *
 * If n is greater than the number of positional parameters, shift fails
 * with exit code 1.
 *
 * @example
 * shift      -> shifts by 1 position
 * shift 2    -> shifts by 2 positions
 */
export const shiftBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  // Parse shift count (default is 1)
  let n = 1;
  if (args.length > 0) {
    const parsed = Number.parseInt(args[0], 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return {
        code: 1,
        stderr: `shift: ${args[0]}: numeric argument required\n`,
      };
    }
    n = parsed;
  }

  // Get current positional parameters
  const params = ctx.getParams();

  // Find all numeric positional parameters
  const positional: { index: number; value: string }[] = [];
  for (const [key, value] of Object.entries(params)) {
    const num = Number.parseInt(key, 10);
    if (!Number.isNaN(num) && num > 0 && String(num) === key) {
      positional.push({ index: num, value });
    }
  }

  // Sort by index
  positional.sort((a, b) => a.index - b.index);

  // Count positional parameters (highest index)
  const count = positional.length;

  // Check if we can shift
  if (n > count) {
    return {
      code: 1,
      stderr: `shift: can't shift that many\n`,
    };
  }

  // If n is 0, do nothing
  if (n === 0) {
    return { code: 0 };
  }

  // Build new params: clear old positional params and set shifted ones
  const updates: Record<string, string | null> = {};

  // First, null out all existing positional params
  for (const { index } of positional) {
    updates[String(index)] = null;
  }

  // Then set the shifted values
  for (let i = n; i < positional.length; i++) {
    const newIndex = positional[i].index - n;
    updates[String(newIndex)] = positional[i].value;
  }

  // Update the special parameter # (count)
  updates['#'] = String(count - n);

  ctx.setParams(updates);

  return { code: 0 };
};
