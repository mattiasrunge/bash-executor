/**
 * Implementation of the shopt builtin.
 *
 * bash's second set of options, beside `set -o`. They live with the `set`
 * options on the execution context — no name is in both — so a subshell
 * inherits them the same way. The executor acts on `lastpipe`; the others are
 * recorded for scripts to set and test.
 */

import { DEFAULT_SHELL_OPTIONS, DEFAULT_SHOPT_OPTIONS, type ExecContextIf, type ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * The shopt builtin command.
 *
 * @example
 * shopt -s lastpipe extglob   # turn on
 * shopt -u nullglob           # turn off
 * shopt -q extglob            # status only: 0 when all named are on
 * shopt -p lastpipe           # as a command that restores it
 * shopt -o -s pipefail        # the `set -o` options instead
 */
export const shoptBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  let mode: 's' | 'u' | undefined;
  let quiet = false;
  let print = false;
  let setOptions = false;
  let i = 0;

  for (; i < args.length && args[i].startsWith('-') && args[i] !== '-'; i++) {
    if (args[i] === '--') {
      i++;
      break;
    }

    for (const flag of args[i].slice(1)) {
      if (flag === 's' || flag === 'u') {
        if (mode !== undefined && mode !== flag) {
          return { code: 1, stderr: 'shopt: cannot set and unset shell options simultaneously\n' };
        }

        mode = flag;
      } else if (flag === 'q') {
        quiet = true;
      } else if (flag === 'p') {
        print = true;
      } else if (flag === 'o') {
        setOptions = true;
      } else {
        return { code: 2, stderr: `shopt: -${flag}: invalid option\nshopt: usage: shopt [-pqsu] [-o] [optname ...]\n` };
      }
    }
  }

  const known = setOptions ? DEFAULT_SHELL_OPTIONS : DEFAULT_SHOPT_OPTIONS;
  const names = args.slice(i);
  const current = ctx.getShellOptions();
  const value = (name: string) => current[name] ?? known[name];

  for (const name of names) {
    if (!(name in known)) {
      return { code: 1, stderr: `shopt: ${name}: invalid ${setOptions ? 'option' : 'shell option'} name\n` };
    }
  }

  if (mode && names.length > 0) {
    for (const name of names) {
      ctx.setShellOption(name, mode === 's');
    }

    return { code: 0 };
  }

  // Listing: the named options, or all of them (the set ones sorted, the shopt ones in bash's order) — only those on or off with -s or -u
  const all = setOptions ? Object.keys(known).sort() : Object.keys(known);
  const listed = (names.length > 0 ? names : all).filter((name) => mode === undefined || value(name) === (mode === 's'));
  const status = listed.every((name) => value(name)) ? 0 : 1;

  if (quiet) {
    return { code: status };
  }

  // -p lists the commands that restore the options, otherwise a name/on-off table
  const command = (name: string) => setOptions ? `set ${value(name) ? '-o' : '+o'} ${name}\n` : `shopt ${value(name) ? '-s' : '-u'} ${name}\n`;
  const line = (name: string) => print ? command(name) : `${name.padEnd(15)}\t${value(name) ? 'on' : 'off'}\n`;

  return { code: names.length > 0 ? status : 0, stdout: listed.map(line).join('') };
};
