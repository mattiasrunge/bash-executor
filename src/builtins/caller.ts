/**
 * Implementation of the caller builtin, after bash's caller.def: it reads the
 * call stack the executor keeps in FUNCNAME, BASH_SOURCE and BASH_LINENO.
 */

import type { ExecContextIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * The caller builtin command.
 *
 * @example
 * caller      -> "12 ./script.sh": the line and file the function was called from
 * caller 0    -> "12 main ./script.sh": and the function that called it
 */
export const callerBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[]): Promise<BuiltinResult> => {
  const names = ctx.getArray('FUNCNAME') ?? [];
  const sources = ctx.getArray('BASH_SOURCE') ?? [];
  const lines = ctx.getArray('BASH_LINENO') ?? [];

  if (lines.length === 0 || sources.length === 0) return { code: 1 };

  if (args[0] === '--') args = args.slice(1);

  if (args[0]?.startsWith('-') && args[0].length > 1 && !/^-\d+$/.test(args[0])) {
    return { code: 2, stderr: `caller: ${args[0].slice(0, 2)}: invalid option\ncaller: usage: caller [expr]\n` };
  }

  // Without an argument, the line and file the current call came from
  if (args.length === 0) {
    return { code: 0, stdout: `${lines[0] ?? 'NULL'} ${sources[1] ?? 'NULL'}\n` };
  }

  if (names.length === 0) return { code: 1 };

  if (!/^\s*[+-]?\d+\s*$/.test(args[0])) {
    return { code: 2, stderr: `caller: ${args[0]}: invalid number\ncaller: usage: caller [expr]\n` };
  }

  const n = Number(args[0]);
  const [line, name, source] = [lines[n], names[n + 1], sources[n + 1]];

  if (line === undefined || name === undefined || source === undefined) return { code: 1 };

  return { code: 0, stdout: `${line} ${name} ${source}\n` };
};
