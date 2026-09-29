/**
 * What `time` reports, in bash's formats: `TIMEFORMAT` when it is set, its
 * default when not, and POSIX's fixed one after `time -p`.
 */

import type { CpuTimes, ExecContextIf, ShellIf } from './types.ts';

/** Bash's format while `TIMEFORMAT` is unset. */
export const DEFAULT_TIMEFORMAT = '\nreal\t%3lR\nuser\t%3lU\nsys\t%3lS';

/** The format `time -p` uses, whatever `TIMEFORMAT` says. */
export const POSIX_TIMEFORMAT = 'real %2R\nuser %2U\nsys %2S';

/** Seconds of elapsed, user and system time. */
export type Times = { real: number; user: number; system: number };

/** CPU time so far, the shell's and its finished commands' together; zero where the host cannot tell. */
export async function cpuTime(shell: ShellIf): Promise<CpuTimes> {
  return await shell.cpuTimes?.().catch(() => undefined) ?? { user: 0, system: 0, childrenUser: 0, childrenSystem: 0 };
}

/**
 * Seconds as bash's mkfmt writes them: `prec` digits of the fraction, cut and
 * not rounded, and `1m2.500s` in the long form.
 */
export function timeValue(seconds: number, prec: number, long: boolean): string {
  const millis = Math.max(0, Math.floor(seconds * 1000));
  let whole = Math.floor(millis / 1000);
  let out = '';

  if (long) {
    out = `${Math.floor(whole / 60)}m`;
    whole %= 60;
  }

  out += String(whole);

  if (prec > 0) {
    out += `.${String(millis % 1000).padStart(3, '0').slice(0, prec)}`;
  }

  return long ? `${out}s` : out;
}

/**
 * A format's text with its `%` escapes filled in: `%[p][l]R`, `U` and `S` are
 * the times with p digits (3 at most) after the point, `%P` the share of the
 * elapsed time the CPU was busy, `%%` a percent sign. An escape bash does not
 * know is complained about in `warnings`, and then there is no report at all.
 */
export function formatTimes(format: string, times: Times): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let text = '';

  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%' || i + 1 >= format.length) {
      text += format[i];
      continue;
    }

    i++;

    if (format[i] === '%') {
      text += '%';
      continue;
    }

    if (format[i] === 'P') {
      const busy = times.real > 0 ? Math.min(100, (times.user + times.system) * 100 / times.real) : 0;

      text += timeValue(busy, 2, false);
      continue;
    }

    let prec = 3;
    let long = false;

    if (/\d/.test(format[i])) {
      prec = Math.min(3, Number(format[i++]));
    }
    if (format[i] === 'l') {
      long = true;
      i++;
    }

    const value = format[i] === 'R' ? times.real : format[i] === 'U' ? times.user : format[i] === 'S' ? times.system : undefined;

    if (value === undefined) {
      warnings.push(`TIMEFORMAT: \`${format[i] ?? ''}': invalid format character`);
      return { text: '', warnings };
    }

    text += timeValue(value, prec, long);
  }

  return { text, warnings };
}

/** The report of one timed command, as bash writes it to the shell's stderr: nothing at all when `TIMEFORMAT` is empty. */
export function timeReport(ctx: ExecContextIf, posix: boolean, times: Times): { text: string; warnings: string[] } {
  const format = posix ? POSIX_TIMEFORMAT : ctx.getVariable('TIMEFORMAT')?.value as string | undefined ?? DEFAULT_TIMEFORMAT;

  if (format === '') {
    return { text: '', warnings: [] };
  }

  const { text, warnings } = formatTimes(format, times);

  return { text: warnings.length ? '' : `${text}\n`, warnings };
}
