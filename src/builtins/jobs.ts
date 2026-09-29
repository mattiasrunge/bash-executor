/**
 * The job control builtins: jobs, wait, kill, disown, fg and bg.
 *
 * They work on the shell's job table and reach processes through the host's
 * `JobHostIf`. The executor drops them from its registry when the host has no
 * job control, so a host with commands of its own by these names keeps them.
 */

import type { Job, JobTable } from '../jobs.ts';
import type { ExecContextIf, ShellIf } from '../types.ts';
import { SIGNALS, trapName } from './trap.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/** The names the executor leaves to the host when the host has no job control. */
export const JOB_BUILTINS = ['jobs', 'wait', 'kill', 'disown', 'fg', 'bg'];

/**
 * Finished jobs leave the table when the shell next looks: silently without
 * job control, as a non-interactive bash does, and listed once as Done with it.
 */
function reap(table: JobTable, ctx: ExecContextIf): Job[] {
  const done = table.list().filter((job) => job.state === 'Done');

  if (!ctx.getShellOption('monitor')) {
    done.forEach((job) => table.remove(job));
    return [];
  }

  return done;
}

/** A job by spec, or an error message for the builtin to print. */
function lookup(table: JobTable, name: string, spec: string): Job | string {
  return table.find(spec) ?? `${name}: ${spec}: no such job\n`;
}

/**
 * jobs [-lprs] [jobspec …]: the job table, `[1]+  Running    cmd &`.
 */
export const jobsBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[]): Promise<BuiltinResult> => {
  const table = ctx.getJobTable();
  const flags = new Set(args.filter((arg) => /^-[lnprs]+$/.test(arg)).flatMap((arg) => [...arg.slice(1)]));
  const specs = args.filter((arg) => !/^-[lnprs]+$/.test(arg));
  const done = reap(table, ctx);
  let stderr = '';
  let jobs = table.list();

  if (specs.length > 0) {
    jobs = specs.flatMap((spec) => {
      const job = lookup(table, 'jobs', spec);

      if (typeof job === 'string') {
        stderr += job;
        return [];
      }

      return [job];
    });
  }

  if (flags.has('r')) jobs = jobs.filter((job) => job.state === 'Running');
  if (flags.has('s')) jobs = jobs.filter((job) => job.state === 'Stopped');

  const stdout = jobs.map((job) => flags.has('p') ? `${job.pid}\n` : table.describe(job, flags.has('l'))).join('');

  // Reported once
  done.forEach((job) => table.remove(job));

  return { code: stderr ? 1 : 0, stdout: stdout || undefined, stderr: stderr || undefined };
};

/**
 * wait [-n] [-p var] [id …]: for the jobs given, by pid or spec, or for all;
 * the status of the last, or 0 for all. `-n` waits for whichever ends first.
 */
export const waitBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[]): Promise<BuiltinResult> => {
  const table = ctx.getJobTable();
  let next = false;
  let variable: string | undefined;
  const ids: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') next = true;
    else if (args[i] === '-f') continue;
    else if (args[i] === '-p') variable = args[++i];
    else if (args[i] === '--') ids.push(...args.slice(i + 1)), i = args.length;
    else ids.push(args[i]);
  }

  let stderr = '';
  const jobs: Job[] = [];

  for (const id of ids) {
    const job = table.find(id);

    if (job) {
      jobs.push(job);
    } else {
      stderr += id.startsWith('%') ? `wait: ${id}: no such job\n` : `wait: pid ${id} is not a child of this shell\n`;
    }
  }

  if (ids.length > 0 && jobs.length === 0) {
    return { code: 127, stderr };
  }

  const waiting = ids.length > 0 ? jobs : table.list();

  if (next) {
    if (waiting.length === 0) {
      return { code: 127, stderr: stderr || undefined };
    }

    const [job, status] = await Promise.race(waiting.map((job) => job.done.then((status): [Job, number] => [job, status])));

    table.remove(job);

    if (variable) ctx.setParams({ [variable]: job.pid });

    return { code: status, stderr: stderr || undefined };
  }

  let status = 0;

  for (const job of waiting) {
    status = await job.done.catch(() => 1);
    table.remove(job);

    if (variable) ctx.setParams({ [variable]: job.pid });
  }

  // `wait` alone is 0 whatever the jobs ended with
  return { code: ids.length > 0 ? status : 0, stderr: stderr || undefined };
};

/** A signal as the host wants it: the name without SIG, or 0. */
function signalName(spec: string): string | undefined {
  if (spec === '0') return '0';

  const name = trapName(spec);

  return name?.startsWith('SIG') ? name.slice(3) : undefined;
}

const KILL_USAGE = 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n';

/**
 * kill [-s sig | -n num | -sig] pid|jobspec …, and kill -l [sig|status …].
 */
export const killBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[], shell: ShellIf): Promise<BuiltinResult> => {
  if (args[0] === '-l' || args[0] === '-L') {
    if (args.length === 1) {
      const table = SIGNALS.map(([number, name], i) => `${String(number).padStart(2)}) SIG${name}${(i + 1) % 5 === 0 ? '\n' : '\t'}`).join('');

      return { code: 0, stdout: table + '\n' };
    }

    // A number, or an exit status above 128, gives its name; a name its number
    let stdout = '';

    for (const spec of args.slice(1)) {
      if (/^\d+$/.test(spec)) {
        const number = Number(spec) > 128 ? Number(spec) - 128 : Number(spec);
        const found = SIGNALS.find(([n]) => n === number);

        if (!found) return { code: 1, stderr: `kill: ${spec}: invalid signal specification\n` };
        stdout += `${found[1]}\n`;
      } else {
        const name = signalName(spec);
        const found = SIGNALS.find(([, n]) => n === name);

        if (!found) return { code: 1, stderr: `kill: ${spec}: invalid signal specification\n` };
        stdout += `${found[0]}\n`;
      }
    }

    return { code: 0, stdout };
  }

  let signal = 'TERM';
  let i = 0;

  if ((args[0] === '-s' || args[0] === '-n') && args.length === 1) {
    return { code: 2, stderr: `kill: ${args[0]}: option requires an argument\n` };
  }

  if (args[0] === '-s' || args[0] === '-n') {
    const spec = args[1] ?? '';
    const name = signalName(spec);

    if (!name) return { code: 1, stderr: `kill: ${spec}: invalid signal specification\n` };
    signal = name;
    i = 2;
  } else if (/^-[A-Za-z0-9+-]+$/.test(args[0] ?? '') && args[0] !== '--') {
    // `-TERM`, `-9`: the signal; a negative pid needs `--` before it, as in bash
    const name = signalName(args[0].slice(1));

    if (!name) return { code: 1, stderr: `kill: ${args[0].slice(1)}: invalid signal specification\n` };
    signal = name;
    i = 1;
  }

  if (args[i] === '--') i++;

  const targets = args.slice(i);

  if (targets.length === 0) {
    return { code: 2, stderr: KILL_USAGE };
  }

  const table = ctx.getJobTable();
  let stderr = '';

  for (const target of targets) {
    let pid = target;

    if (target.startsWith('%')) {
      const job = lookup(table, 'kill', target);

      if (typeof job === 'string') {
        stderr += job;
        continue;
      }

      pid = job.pid;
    } else if (!/^-?\d+$/.test(target)) {
      // Never handed on: `kill ''` would reach the host as pid 0, every process in the group
      stderr += target === '' ? "kill: `': not a pid or valid job spec\n" : `kill: ${target}: arguments must be process or job IDs\n`;
      continue;
    }

    // What a pid looks like is the host's to say; bash's are numbers
    if (!(await shell.jobs!.signal(pid, signal))) {
      stderr += /^-?\d+$/.test(pid) ? `kill: (${pid}) - No such process\n` : `kill: ${target}: arguments must be process or job IDs\n`;
    }
  }

  return { code: stderr ? 1 : 0, stderr: stderr || undefined };
};

/**
 * disown [-ahr] [jobspec …]: the current job, or those given — every one with
 * -a, every running one with -r — is no longer the shell's. It leaves the
 * table, or with -h stays there only not to be hung up; the host is told
 * either way, to let it outlive the shell.
 */
export const disownBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[], shell: ShellIf): Promise<BuiltinResult> => {
  const table = ctx.getJobTable();
  const flags = new Set(args.filter((arg) => /^-[ahr]+$/.test(arg)).flatMap((arg) => [...arg.slice(1)]));
  const specs = args.filter((arg) => !/^-[ahr]+$/.test(arg));
  let stderr = '';
  let jobs: Job[] = [];

  if (flags.has('a') || flags.has('r')) {
    jobs = table.list().filter((job) => flags.has('a') || job.state === 'Running');
  } else {
    for (const spec of specs.length > 0 ? specs : ['%+']) {
      const job = lookup(table, 'disown', spec);

      if (typeof job === 'string') {
        stderr += specs.length > 0 ? job : 'disown: current: no such job\n';
      } else {
        jobs.push(job);
      }
    }
  }

  for (const job of jobs) {
    await shell.jobs?.disown?.(job.pid);

    if (!flags.has('h')) {
      table.remove(job);
    }
  }

  return { code: stderr ? 1 : 0, stderr: stderr || undefined };
};

/** The job fg or bg means: the spec given, or the current one; or the message. */
function jobFor(ctx: ExecContextIf, name: string, args: string[]): Job | string {
  if (!ctx.getShellOption('monitor')) {
    return `${name}: no job control\n`;
  }

  const table = ctx.getJobTable();
  const spec = args[0] ?? '%+';

  return table.find(spec) ?? `${name}: ${args[0] ?? 'current'}: no such job\n`;
}

/** fg [jobspec]: the job in the foreground, waited for; its status. */
export const fgBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[], shell: ShellIf): Promise<BuiltinResult> => {
  const job = jobFor(ctx, 'fg', args);

  if (typeof job === 'string') {
    return { code: 1, stderr: job };
  }

  await shell.pipeWrite(ctx.getStdout(), `${job.command}\n`);

  const status = shell.jobs!.foreground ? await shell.jobs!.foreground(job.pid, ctx) : await job.done;

  ctx.getJobTable().remove(job);

  return { code: status };
};

/** bg [jobspec]: a stopped job continued in the background. */
export const bgBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[], shell: ShellIf): Promise<BuiltinResult> => {
  const job = jobFor(ctx, 'bg', args);

  if (typeof job === 'string') {
    return { code: 1, stderr: job };
  }

  await shell.jobs!.background?.(job.pid);
  job.state = job.state === 'Stopped' ? 'Running' : job.state;

  return { code: 0, stdout: `[${job.id}]${ctx.getJobTable().mark(job)} ${job.command} &\n` };
};
