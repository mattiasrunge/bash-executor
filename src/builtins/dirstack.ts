/**
 * The pushd, popd and dirs builtins, as bash's pushd.def has them.
 *
 * The stack is the context's (`getDirStack()`, its top first); `dirs` shows
 * the working directory and then the stack, and counts `+N` from the left of
 * that list, `-N` from the right. Changing directory goes through `cd`, so
 * PWD, OLDPWD and its errors are cd's.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import { cdBuiltin } from './cd.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

const USAGE: Record<string, string> = {
  pushd: 'pushd: usage: pushd [-n] [+N | -N | dir]\n',
  popd: 'popd: usage: popd [-n] [+N | -N]\n',
  dirs: 'dirs: usage: dirs [-clpv] [+N] [-N]\n',
};

/** bash's legal_number: an integer, a sign and blanks around it allowed. */
const legalNumber = (text: string): number | undefined => /^[ \t\n]*[-+]?\d+[ \t\n]*$/.test(text) ? Number(text.trim()) : undefined;

const usage = (name: string, message: string): BuiltinResult => ({ code: 2, stderr: `${name}: ${message}\n${USAGE[name]}` });

/** The stack in bash's order: index 0 the bottom, the last one the top. */
const stackOf = (ctx: ExecContextIf): string[] => [...ctx.getDirStack()].reverse();

/** Make `list` (bash's order) the stack. */
function setStack(ctx: ExecContextIf, list: string[]): void {
  ctx.clearDirStack();

  for (const dir of list) ctx.pushDirStack(dir);
}

/** pushd_error: an empty stack, or an index past it. */
const stackError = (name: string, size: number, arg: string): BuiltinResult => ({
  code: 1,
  stderr: size === 0 ? `${name}: directory stack empty\n` : `${name}: ${arg}: directory stack index out of range\n`,
});

/** `~` for HOME at the start of a directory, unless HOME is `/`: polite_directory_format. */
function polite(ctx: ExecContextIf, dir: string): string {
  const home = ctx.getParam('HOME') ?? '';

  return home.length > 1 && dir.startsWith(home) && (dir.length === home.length || dir[home.length] === '/') ? `~${dir.slice(home.length)}` : dir;
}

/** Change directory with cd, its complaints said as the builtin's own. */
async function changeTo(name: string, ctx: ExecContextIf, shell: ShellIf, args: string[]): Promise<BuiltinResult> {
  // cd runs no script text of its own
  const result = await cdBuiltin(ctx, args, shell, () => Promise.resolve(0));

  return result.stderr ? { ...result, stderr: result.stderr.replace(/^cd: /gm, `${name}: `) } : result;
}

/** The stack as `dirs` with no arguments shows it. */
function listing(ctx: ExecContextIf): string {
  return [ctx.getCwd(), ...ctx.getDirStack()].map((dir) => polite(ctx, dir)).join(' ') + '\n';
}

/** cd, then the stack shown, as change_to_temp does. */
async function changeAndShow(name: string, ctx: ExecContextIf, shell: ShellIf, dir: string): Promise<BuiltinResult> {
  const result = await changeTo(name, ctx, shell, ['--', dir]);

  return result.code === 0 ? { code: 0, stdout: (result.stdout ?? '') + listing(ctx) } : result;
}

/** get_dirstack_index: bash's index for `+N`/`-N`, and which of the two kinds it was. */
function dirstackIndex(ind: number, sign: 1 | -1, size: number): { index: number; flag: 1 | 2 } {
  if (ind === 0 && sign > 0) return { index: 0, flag: 1 };
  if (ind === size) return { index: 0, flag: sign > 0 ? 2 : 1 };
  if (ind >= 0 && ind <= size) return { index: sign > 0 ? size - ind : ind, flag: sign > 0 ? 1 : 2 };

  return { index: -1, flag: sign > 0 ? 1 : 2 };
}

/**
 * dirs [-clpv] [+N] [-N]: the working directory and the stack, `~` for HOME
 * unless -l; one per line with -p, numbered with -v; -c empties the stack.
 */
export const dirsBuiltin: BuiltinHandler = (ctx: ExecContextIf, args: string[]): Promise<BuiltinResult> => {
  let long = false;
  let clear = false;
  let vflag = 0;
  let index = -1;
  let flag = 0;
  let word = '';
  const size = ctx.getDirStack().length;

  for (const arg of args) {
    if (arg === '-l') long = true;
    else if (arg === '-c') clear = true;
    else if (arg === '-v') vflag |= 2;
    else if (arg === '-p') vflag |= 1;
    else if (arg === '--') break;
    else if (arg.startsWith('+') || arg.startsWith('-')) {
      const n = legalNumber(word = arg.slice(1));

      if (n === undefined) return Promise.resolve(usage('dirs', `${arg}: invalid number`));

      ({ index, flag } = dirstackIndex(n, arg[0] === '+' ? 1 : -1, size));
    } else {
      return Promise.resolve(usage('dirs', `${arg}: invalid option`));
    }
  }

  if (clear) {
    ctx.clearDirStack();
    return Promise.resolve({ code: 0 });
  }

  if (flag && (index < 0 || index > size)) return Promise.resolve(stackError('dirs', size, word));

  const show = (dir: string) => long ? dir : polite(ctx, dir);
  const list = stackOf(ctx);
  let out = '';

  // The working directory first, always
  if (flag === 0 || (flag === 1 && index === 0)) {
    out += vflag & 2 ? ` 0  ${show(ctx.getCwd())}` : show(ctx.getCwd());

    if (flag) return Promise.resolve({ code: 0, stdout: `${out}\n` });
  }

  if (flag) {
    out += vflag & 2 ? `${String(size - index).padStart(2)}  ${show(list[index])}` : show(list[index]);
  } else {
    for (let i = size - 1; i >= 0; i--) {
      out += vflag >= 2 ? `\n${String(size - i).padStart(2)}  ${show(list[i])}` : `${vflag & 1 ? '\n' : ' '}${show(list[i])}`;
    }
  }

  return Promise.resolve({ code: 0, stdout: `${out}\n` });
};

/**
 * pushd [-n] [+N | -N | dir]: push dir and go there; rotate the stack so
 * its Nth entry is the working directory; with nothing, swap the top two.
 */
export const pushdBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[], shell: ShellIf): Promise<BuiltinResult> => {
  let rest = args;
  const skipopt = rest[0] === '--';

  if (skipopt) rest = rest.slice(1);

  const list = stackOf(ctx);
  const size = list.length;

  // No argument: the working directory and the top of the stack change places
  if (rest.length === 0) {
    if (size === 0) return { code: 1, stderr: 'pushd: no other directory\n' };

    const top = list[size - 1];

    list[size - 1] = ctx.getCwd();
    setStack(ctx, list);

    return await changeAndShow('pushd', ctx, shell, top);
  }

  let nocd = false;
  let rotate: number | undefined;
  let i = 0;

  for (; !skipopt && i < rest.length; i++) {
    const arg = rest[i];

    if (arg === '-n') {
      nocd = true;
    } else if (arg === '--') {
      i++;
      break;
    } else if (arg === '-') {
      // `pushd -` is OLDPWD, as cd has it
      break;
    } else if (arg[0] === '+' || arg[0] === '-') {
      const n = legalNumber(arg.slice(1));

      if (n === undefined) return usage('pushd', `${arg}: invalid number`);

      const num = arg[0] === '-' ? size - n : n;

      if (num > size || num < 0) return stackError('pushd', size, arg);

      rotate = num;
    } else {
      break;
    }
  }

  // Rotate, the working directory part of the ring: its Nth entry is the new working directory
  if (rotate !== undefined) {
    let temp = ctx.getCwd();

    for (let n = rotate; n > 0; n--) {
      const top = list.pop()!;

      list.unshift(temp);
      temp = top;
    }

    setStack(ctx, list);

    return nocd ? { code: 0 } : await changeAndShow('pushd', ctx, shell, temp);
  }

  const words = rest.slice(i);

  if (words.length === 0) return { code: 0 };

  const current = ctx.getCwd();

  if (!nocd) {
    const result = await changeTo('pushd', ctx, shell, skipopt ? args : words);

    if (result.code !== 0) return result;
  }

  setStack(ctx, [...list, nocd ? words[0] : current]);

  return { code: 0, stdout: listing(ctx) };
};

/**
 * popd [-n] [+N | -N]: take the top off the stack and go there; or remove
 * the Nth entry of what dirs shows.
 */
export const popdBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[], shell: ShellIf): Promise<BuiltinResult> => {
  let nocd = false;
  let which = 0;
  let direction: '+' | '-' = '+';
  let word: string | undefined;

  for (const arg of args) {
    if (arg === '-n') {
      nocd = true;
    } else if (arg === '--') {
      break;
    } else if (arg[0] === '+' || arg[0] === '-') {
      const n = legalNumber(arg.slice(1));

      if (n === undefined) return usage('popd', `${arg}: invalid number`);

      direction = arg[0];
      which = n;
      word = arg;
    } else if (arg !== '') {
      return usage('popd', `${arg}: invalid argument`);
    } else {
      break;
    }
  }

  const list = stackOf(ctx);
  const size = list.length;

  if (which > size || which < -size || (size === 0 && which === 0)) return stackError('popd', size, word ?? '');

  let stdout = '';

  if ((direction === '+' && which === 0) || (direction === '-' && which === size)) {
    if (!nocd) {
      const result = await changeTo('popd', ctx, shell, ['--', list[size - 1]]);

      if (result.code !== 0) return result;
      stdout += result.stdout ?? '';
    }

    list.pop();
  } else {
    const i = direction === '+' ? size - which : which;

    if (i < 0 || i > size) return stackError('popd', size, word ?? '');

    list.splice(i, 1);
  }

  setStack(ctx, list);

  return { code: 0, stdout: stdout + listing(ctx) };
};
