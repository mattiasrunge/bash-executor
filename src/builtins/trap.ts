/**
 * Implementation of the trap builtin.
 *
 * Sets, resets and lists the commands the shell runs on a signal or on one of
 * its own events: EXIT when the shell ends, ERR after a command fails, DEBUG
 * before each simple command, RETURN after a function or `source`. The
 * executor runs the events' traps; delivering signals is the host's business.
 */

import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/** Linux's signals by number, as `trap -l` and `kill -l` list them. */
export const SIGNALS: [number, string][] = [
  ...'HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH IO PWR SYS'
    .split(' ')
    .map((name, i): [number, string] => [i + 1, name]),
  [34, 'RTMIN'],
  ...Array.from({ length: 15 }, (_, i): [number, string] => [35 + i, `RTMIN+${i + 1}`]),
  ...Array.from({ length: 14 }, (_, i): [number, string] => [50 + i, `RTMAX-${14 - i}`]),
  [64, 'RTMAX'],
];

/** The shell's own events, after the signals in `trap -p`'s order. */
const EVENTS = ['DEBUG', 'ERR', 'RETURN'];

/**
 * A signal or event as `trap` stores and prints it — `EXIT`, `SIGINT`,
 * `DEBUG` — from any way of writing it: `0`, `2`, `int`, `SIGINT`. Undefined
 * for anything else.
 */
export function trapName(spec: string): string | undefined {
  const upper = spec.toUpperCase();

  if (upper === '0' || upper === 'EXIT' || upper === 'SIGEXIT') return 'EXIT';
  if (EVENTS.includes(upper)) return upper;

  if (/^\d+$/.test(spec)) {
    const found = SIGNALS.find(([number]) => number === Number(spec));
    return found && `SIG${found[1]}`;
  }

  const name = upper.startsWith('SIG') ? upper.slice(3) : upper;

  return SIGNALS.some(([, signal]) => signal === name) ? `SIG${name}` : undefined;
}

/** The position of a trap in `trap -p`: EXIT, the signals by number, then the events. */
function order(name: string): number {
  if (name === 'EXIT') return 0;
  if (EVENTS.includes(name)) return 100 + EVENTS.indexOf(name);

  return SIGNALS.find(([, signal]) => `SIG${signal}` === name)?.[0] ?? 99;
}

/** A command as a single-quoted word, `'` written `'\''`. */
function quote(action: string): string {
  return `'${action.replaceAll("'", "'\\''")}'`;
}

function listing(traps: Record<string, string>, names?: string[]): string {
  return (names ?? Object.keys(traps).sort((a, b) => order(a) - order(b)))
    .filter((name) => name in traps)
    .map((name) => `trap -- ${quote(traps[name])} ${name}\n`)
    .join('');
}

/** `trap -l`: five to a line, each followed by a tab but the fifth, the last line ending in a tab too. */
function signalTable(): string {
  return SIGNALS.map(([number, name], i) => `${String(number).padStart(2)}) SIG${name}${(i + 1) % 5 === 0 ? '\n' : '\t'}`).join('') + '\n';
}

/**
 * The trap builtin command.
 *
 * @example
 * trap 'rm -f "$tmp"' EXIT     # run at the end of the shell
 * trap '' INT                  # ignore
 * trap - INT                   # back to the default
 * trap -p EXIT                 # as a command that sets it again
 * trap -l                      # the signals
 */
export const trapBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  let print = false;
  let i = 0;

  for (; i < args.length && /^-[lp]+$/.test(args[i]); i++) {
    if (args[i].includes('l')) {
      return { code: 0, stdout: signalTable() };
    }

    print = true;
  }

  if (args[i] === '--') {
    i++;
  }

  const operands = args.slice(i);

  if (operands.length === 0) {
    return { code: 0, stdout: listing(ctx.getTraps()) };
  }

  let stderr = '';
  const valid = (specs: string[]) =>
    specs.flatMap((spec) => {
      const name = trapName(spec);

      if (!name) {
        stderr += `trap: ${spec}: invalid signal specification\n`;
        return [];
      }

      return [name];
    });

  if (print) {
    const names = valid(operands);

    return { code: stderr ? 1 : 0, stdout: listing(ctx.getTraps(), names), stderr: stderr || undefined };
  }

  // `trap - SIG…` and `trap SIG` reset; so does a first operand that is a
  // number, which makes them all signals
  const reset = operands[0] === '-' || operands.length === 1 || /^\d+$/.test(operands[0]);
  const action = reset ? null : operands[0];
  const specs = operands[0] === '-' || !reset ? operands.slice(1) : operands;

  for (const name of valid(specs)) {
    ctx.setTrap(name, action);
  }

  return stderr ? { code: 1, stderr } : { code: 0 };
};
