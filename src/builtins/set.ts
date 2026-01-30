/**
 * Implementation of the set builtin.
 *
 * Sets or unsets shell options and positional parameters.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

// Shell options (shared state - in a real shell this would be per-shell)
const shellOptions: Record<string, boolean> = {
  errexit: false, // -e: Exit on error
  nounset: false, // -u: Error on unset variables
  xtrace: false, // -x: Print commands before execution
  verbose: false, // -v: Print input lines
  noclobber: false, // -C: Prevent > from overwriting files
  noglob: false, // -f: Disable pathname expansion
  allexport: false, // -a: Export all variables
  notify: false, // -b: Notify of job termination immediately
  ignoreeof: false, // Require 'exit' to leave shell
  monitor: false, // -m: Job control
  noexec: false, // -n: Don't execute commands
  pipefail: false, // Fail pipeline if any command fails
};

// Map short options to long names
const optionMap: Record<string, string> = {
  e: 'errexit',
  u: 'nounset',
  x: 'xtrace',
  v: 'verbose',
  C: 'noclobber',
  f: 'noglob',
  a: 'allexport',
  b: 'notify',
  m: 'monitor',
  n: 'noexec',
};

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
    const env = ctx.getEnv();
    const params = ctx.getParams();
    let output = '';

    // Merge env and params, sorted
    const all = { ...env, ...params };
    const keys = Object.keys(all).sort();

    for (const key of keys) {
      const value = all[key];
      // Quote the value
      const quotedValue = value.replace(/'/g, "'\\''");
      output += `${key}='${quotedValue}'\n`;
    }

    return { code: 0, stdout: output };
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
      shellOptions.xtrace = false;
      shellOptions.verbose = false;
      i++;
      continue;
    }

    // -o or +o with option name
    if (arg === '-o' || arg === '+o') {
      const enable = arg === '-o';
      i++;
      if (i >= args.length) {
        // Display all options
        let output = '';
        for (const [name, value] of Object.entries(shellOptions)) {
          output += `set ${value ? '-o' : '+o'} ${name}\n`;
        }
        return { code: 0, stdout: output };
      }

      const optName = args[i];
      if (optName in shellOptions) {
        shellOptions[optName] = enable;
      } else if (optName === 'pipefail') {
        shellOptions.pipefail = enable;
      } else {
        return {
          code: 1,
          stderr: `set: ${optName}: invalid option name\n`,
        };
      }
      i++;
      continue;
    }

    // Short options -abc or +abc
    if (arg.startsWith('-') || arg.startsWith('+')) {
      const enable = arg.startsWith('-');
      const flags = arg.slice(1);

      for (const flag of flags) {
        if (flag in optionMap) {
          shellOptions[optionMap[flag]] = enable;
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

/**
 * Get the current value of a shell option.
 *
 * @param name - The option name
 * @returns The option value, or undefined if not found
 */
export function getShellOption(name: string): boolean | undefined {
  return shellOptions[name];
}

/**
 * Set a shell option.
 *
 * @param name - The option name
 * @param value - The option value
 */
export function setShellOption(name: string, value: boolean): void {
  if (name in shellOptions) {
    shellOptions[name] = value;
  }
}

/**
 * Reset all shell options to defaults (useful for testing).
 */
export function resetShellOptions(): void {
  for (const key of Object.keys(shellOptions)) {
    shellOptions[key] = false;
  }
}
