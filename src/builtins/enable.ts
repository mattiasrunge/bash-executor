/**
 * Implementation of the enable builtin, after bash's enable.def: builtins are
 * turned off and on again, so that `test` finds /usr/bin/test.
 */

import type { ExecContextIf } from '../types.ts';
import { type BuiltinHandler, type BuiltinRegistry, type BuiltinResult, EXECUTOR_BUILTINS, SPECIAL_BUILTINS } from './types.ts';

const USAGE = 'enable: usage: enable [-a] [-dnps] [-f filename] [name ...]\n';

/** Byte order, which is the order bash keeps its builtins in. */
const byteOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Creates the enable builtin. A builtin it turns off leaves the registry, and
 * comes back from here.
 *
 * @example
 * enable -n test   -> `test` runs /usr/bin/test
 * enable test      -> the builtin again
 * enable -ps       -> the special builtins
 */
export function createEnableBuiltin(registry: BuiltinRegistry): BuiltinHandler {
  const disabled = new Map<string, BuiltinHandler>();

  return async (_ctx: ExecContextIf, args: string[]): Promise<BuiltinResult> => {
    let all = false;
    let disable = false;
    let special = false;
    let i = 0;

    for (; i < args.length && args[i].startsWith('-') && args[i].length > 1; i++) {
      if (args[i] === '--') {
        i++;
        break;
      }

      for (const flag of args[i].slice(1)) {
        if (flag === 'a') all = true;
        else if (flag === 'n') disable = true;
        else if (flag === 's') special = true;
        else if (flag === 'p') continue;
        else if (flag === 'f' || flag === 'd') return { code: 1, stderr: `enable: -${flag}: dynamic loading not available\n` };
        else return { code: 2, stderr: `enable: -${flag}: invalid option\n${USAGE}` };
      }
    }

    const names = args.slice(i);

    if (names.length === 0) {
      // -a lists both kinds, -n the builtins that are off, neither those that are on
      const on = disable && !all ? [] : [...registry.keys(), ...EXECUTOR_BUILTINS];
      const off = all || disable ? [...disabled.keys()] : [];
      const lines = [...on.map((name) => ({ name, on: true })), ...off.map((name) => ({ name, on: false }))]
        .filter(({ name }) => !special || SPECIAL_BUILTINS.has(name))
        .sort((a, b) => byteOrder(a.name, b.name));

      return { code: 0, stdout: lines.map(({ name, on }) => `enable ${on ? '' : '-n '}${name}\n`).join('') };
    }

    let stderr = '';

    for (const name of names) {
      if (disable) {
        const handler = registry.get(name);

        if (handler) {
          registry.delete(name);
          disabled.set(name, handler);
        } else if (!disabled.has(name)) {
          stderr += `enable: ${name}: not a shell builtin\n`;
        }
      } else {
        const handler = disabled.get(name);

        if (handler) {
          disabled.delete(name);
          registry.set(name, handler);
        } else if (!registry.has(name) && !EXECUTOR_BUILTINS.has(name)) {
          stderr += `enable: ${name}: not a shell builtin\n`;
        }
      }
    }

    return { code: stderr ? 1 : 0, stderr };
  };
}
