/**
 * Implementation of the set builtin.
 *
 * Sets or unsets shell options and positional parameters.
 */

import { DEFAULT_SHELL_OPTIONS, type ExecContextIf, SHELL_OPTION_FLAG_MAP, type ShellIf } from '../types.ts';
import { functionText } from '../print-command.ts';
import { doubleQuoted, quotedIfNeeded } from '../quote.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * The set builtin command.
 *
 * With no arguments, displays all shell variables. With arguments,
 * sets shell options or positional parameters.
 *
 * Options:
 * -e    Exit immediately if a command exits with non-zero status
 * -u    Treat unset variables as an error
 * -x    Print commands and their arguments as they are executed
 * -v    Print shell input lines as they are read
 * -o option  Set option by name
 * +o option  Unset option by name
 * --    End of options; remaining args become positional parameters
 *
 * @example
 * set -e           -> enable errexit
 * set +e           -> disable errexit
 * set -o errexit   -> enable errexit by name
 * set -- a b c     -> set $1=a, $2=b, $3=c
 * set -             -> clear options
 */
export const setBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  // No arguments: display all variables
  if (args.length === 0) {
    // The shell's variables, not its special parameters, as bash lists them:
    // values quoted only when they need it, arrays as `a=([0]="x")`
    const lines: Record<string, string> = {};

    for (const [name, value] of Object.entries({ ...ctx.getEnv(), ...ctx.getParams() })) {
      lines[name] = `${name}=${quotedIfNeeded(value)}`;
    }

    for (const [name, values] of Object.entries(ctx.getArrays())) {
      lines[name] = `${name}=(${Object.entries(values).map(([index, value]) => `[${index}]=${doubleQuoted(value)}`).join(' ')})`;
    }

    for (const [name, values] of Object.entries(ctx.getAssocs())) {
      const elements = Object.entries(values).map(([key, value]) => `[${quotedIfNeeded(key).replace(/^'.*'$/s, () => doubleQuoted(key))}]=${doubleQuoted(value)} `);

      lines[name] = `${name}=(${elements.join('')})`;
    }

    const names = Object.keys(lines).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort();
    let stdout = names.map((name) => `${lines[name]}\n`).join('');

    // Then the functions, as declare -f prints them; posix mode leaves them out
    if (!ctx.getShellOption('posix')) {
      const functions = ctx.getFunctions();

      for (const name of Object.keys(functions).sort()) stdout += `${await functionText(functions[name])}\n`;
    }

    return { code: 0, stdout };
  }

  let i = 0;
  let setPositional = false;
  const positionalArgs: string[] = [];

  while (i < args.length) {
    const arg = args[i];

    // -- marks end of options
    if (arg === '--') {
      setPositional = true;
      positionalArgs.push(...args.slice(i + 1));
      break;
    }

    // - with no other characters: turn off -x and -v
    if (arg === '-') {
      ctx.setShellOption('xtrace', false);
      ctx.setShellOption('verbose', false);
      i++;
      continue;
    }

    // -o or +o with option name
    if (arg === '-o' || arg === '+o') {
      const enable = arg === '-o';
      i++;
      if (i >= args.length) {
        // `set -o` lists the options as a table, `set +o` as the commands that restore them
        const options = Object.entries(ctx.getShellOptions()).filter(([name]) => name in DEFAULT_SHELL_OPTIONS).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        const output = options.map(([name, value]) => enable ? `${name.padEnd(15)}\t${value ? 'on' : 'off'}\n` : `set ${value ? '-o' : '+o'} ${name}\n`);

        return { code: 0, stdout: output.join('') };
      }

      const optName = args[i];
      if (!(optName in DEFAULT_SHELL_OPTIONS)) {
        return {
          code: 1,
          stderr: `set: ${optName}: invalid option name\n`,
        };
      }

      ctx.setShellOption(optName, enable);
      i++;
      continue;
    }

    // Short options -abc or +abc
    if (arg.startsWith('-') || arg.startsWith('+')) {
      const enable = arg.startsWith('-');
      const flags = arg.slice(1);

      for (const flag of flags) {
        // `set -eo pipefail` — an `o` inside a flag group still takes the option
        // name that follows, so -e is set and then pipefail by name
        if (flag === 'o') {
          i++;

          const optName = args[i];

          if (!optName || !(optName in DEFAULT_SHELL_OPTIONS)) {
            return {
              code: 1,
              stderr: `set: ${optName ?? ''}: invalid option name\n`,
            };
          }

          ctx.setShellOption(optName, enable);
          continue;
        }

        if (flag in SHELL_OPTION_FLAG_MAP) {
          ctx.setShellOption(SHELL_OPTION_FLAG_MAP[flag], enable);
        } else {
          return {
            code: 1,
            stderr: `set: -${flag}: invalid option\n`,
          };
        }
      }
      i++;
      continue;
    }

    // Non-option argument: start of positional parameters
    setPositional = true;
    positionalArgs.push(...args.slice(i));
    break;
  }

  // Set positional parameters
  if (setPositional) {
    const updates: Record<string, string | null> = {};

    // Clear existing positional parameters
    const params = ctx.getParams();
    for (const key of Object.keys(params)) {
      const num = Number.parseInt(key, 10);
      if (!Number.isNaN(num) && num > 0 && String(num) === key) {
        updates[key] = null;
      }
    }

    // Set new positional parameters
    for (let j = 0; j < positionalArgs.length; j++) {
      updates[String(j + 1)] = positionalArgs[j];
    }

    // Update count
    updates['#'] = String(positionalArgs.length);

    ctx.setParams(updates);
  }

  return { code: 0 };
};
