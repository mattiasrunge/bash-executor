/**
 * Implementation of the umask builtin, after bash's umask.def.
 *
 * The mask is the shell's (see ExecContextIf.getUmask); the host applies it
 * to the files it creates.
 */

import type { ExecContextIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

const USAGE = 'umask: usage: umask [-p] [-S] [mode]\n';

/** `u=rwx,g=rx,o=rx`: the permissions a mask leaves. */
function symbolic(mask: number): string {
  const bits = (shift: number) => ['r', 'w', 'x'].filter((_, i) => (mask & (0o4 >> i << shift)) === 0).join('');

  return `u=${bits(6)},g=${bits(3)},o=${bits(0)}`;
}

/**
 * bash's parse_symbolic_mode: the permission bits `u+w,go-x` makes of `bits`,
 * or an error.
 */
function parseSymbolic(mode: string, bits: number): number | string {
  const WHO: Record<string, number> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 };
  const PERM: Record<string, number> = { r: 0o444, w: 0o222, x: 0o111 };
  let i = 0;

  for (;;) {
    let who = 0;
    let perm = 0;

    while (mode[i] in WHO) who |= WHO[mode[i++]];

    const op = mode[i++] ?? '';

    if (!'+-='.includes(op) || op === '') return `\`${op}': invalid symbolic mode operator`;

    while (mode[i] in PERM) perm |= PERM[mode[i++]];

    if (i < mode.length && mode[i] !== ',') return `\`${mode[i]}': invalid symbolic mode character`;

    if (who) perm &= who;

    if (op === '+') {
      bits |= perm;
    } else if (op === '-') {
      bits &= ~perm;
    } else {
      bits = (bits & ~(who || 0o777)) | perm;
    }

    if (i >= mode.length) return bits;

    i++;
  }
}

/**
 * The umask builtin command.
 *
 * @example
 * umask            -> 0022
 * umask -S         -> u=rwx,g=rx,o=rx
 * umask 077
 * umask g-w,o-rwx
 */
export const umaskBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[]): Promise<BuiltinResult> => {
  let printSymbolic = false;
  let reusable = false;
  let i = 0;

  for (; i < args.length && args[i].startsWith('-') && args[i].length > 1; i++) {
    if (args[i] === '--') {
      i++;
      break;
    }

    for (const flag of args[i].slice(1)) {
      if (flag === 'S') printSymbolic = true;
      else if (flag === 'p') reusable = true;
      else return { code: 2, stderr: `umask: -${flag}: invalid option\n${USAGE}` };
    }
  }

  const mode = args[i];

  if (mode === undefined) {
    const mask = ctx.getUmask();
    const shown = printSymbolic ? symbolic(mask) : mask.toString(8).padStart(4, '0');

    return { code: 0, stdout: `${reusable ? `umask${printSymbolic ? ' -S' : ''} ` : ''}${shown}\n` };
  }

  let mask: number;

  if (/^\d/.test(mode)) {
    if (!/^[0-7]+$/.test(mode) || Number.parseInt(mode, 8) > 0o7777) {
      return { code: 1, stderr: `umask: ${mode}: octal number out of range\n` };
    }

    mask = Number.parseInt(mode, 8);
  } else {
    // Worked on as the permissions the mask leaves, as chmod would
    const bits = parseSymbolic(mode, ~ctx.getUmask() & 0o777);

    if (typeof bits === 'string') return { code: 1, stderr: `umask: ${bits}\n` };

    mask = ~bits & 0o777;
  }

  ctx.setUmask(mask);

  return { code: 0, stdout: printSymbolic ? `${symbolic(mask)}\n` : '' };
};
