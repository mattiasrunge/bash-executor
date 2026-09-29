/**
 * The times builtin: the CPU time the shell has used, then its finished
 * commands', user and system, as bash writes them.
 */

import { cpuTime, timeValue } from '../timing.ts';
import type { BuiltinHandler } from './types.ts';

export const timesBuiltin: BuiltinHandler = async (_ctx, args, shell) => {
  if (args[0] === '--') args = args.slice(1);

  if (args[0]?.startsWith('-') && args[0].length > 1) {
    return { code: 2, stderr: `times: ${args[0].slice(0, 2)}: invalid option\ntimes: usage: times\n` };
  }

  const cpu = await cpuTime(shell);
  const pair = (user: number, system: number) => `${timeValue(user, 3, true)} ${timeValue(system, 3, true)}\n`;

  return { code: 0, stdout: pair(cpu.user, cpu.system) + pair(cpu.childrenUser, cpu.childrenSystem) };
};
