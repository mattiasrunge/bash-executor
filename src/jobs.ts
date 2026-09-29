/**
 * The shell's job table: what `&` started, as `jobs`, `wait`, `kill`,
 * `disown`, `fg` and `bg` see it.
 *
 * This is the part of job control that is bash's and the same for every
 * host — numbering, the current and previous job, job specs, states, `$!`.
 * Starting a job, signalling it and giving it the terminal are the host's,
 * through `JobHostIf`.
 */

import type { ExecContextIf } from './types.ts';

/** A job's process as the host started it. */
export type JobHandle = {
  /** The id `$!`, `jobs -l`, `kill` and `wait` use for it */
  pid: string;
  /** Resolves with the job's exit status when it has finished */
  done: Promise<number>;
};

/**
 * What only the host can do for job control. A shell that provides it gets
 * the job builtins from the executor; one that does not keeps `&` as it was,
 * and whatever job commands it has of its own.
 */
export interface JobHostIf {
  /**
   * Start a job. The host gives `run` a context of the job's own — a
   * `ctx.subContext()`, with the job's I/O — and runs it without waiting.
   */
  start(ctx: ExecContextIf, run: (jobCtx: ExecContextIf) => Promise<number>, command: string): Promise<JobHandle>;

  /**
   * Send a signal, by name without `SIG` (`TERM`, `USR1`, `0` to test), to a
   * process: a job's or any other. False when there is no such process.
   */
  signal(pid: string, signal: string): Promise<boolean>;

  /** `fg`: give the job the terminal and wait for it. Without this, `fg` has no job control. */
  foreground?(pid: string, ctx: ExecContextIf): Promise<number>;

  /** `bg`: continue a stopped job in the background. */
  background?(pid: string): Promise<void>;

  /**
   * `disown`: the job is no longer the shell's — it is not hung up when the
   * shell ends, and whatever the host does to let it outlive the shell (move
   * its output somewhere that stays) belongs here.
   */
  disown?(pid: string): Promise<void>;
}

export type Job = {
  id: number;
  pid: string;
  command: string;
  state: 'Running' | 'Stopped' | 'Done';
  /** Set once the job has finished */
  status?: number;
  done: Promise<number>;
};

export class JobTable {
  private jobs: Job[] = [];
  private current?: Job;
  private previous?: Job;
  /** `$!`: the pid of the job started last */
  lastPid?: string;

  add(handle: JobHandle, command: string): Job {
    const id = Math.max(0, ...this.jobs.map((job) => job.id)) + 1;
    const job: Job = { id, pid: handle.pid, command, state: 'Running', done: handle.done };

    handle.done.then((status) => {
      job.status = status;
      job.state = 'Done';
    }, () => {
      job.status = 1;
      job.state = 'Done';
    });

    this.jobs.push(job);
    this.previous = this.current;
    this.current = job;
    this.lastPid = handle.pid;

    return job;
  }

  list(): Job[] {
    return [...this.jobs];
  }

  /**
   * The table as a subshell sees it: the same jobs, to list — `jobs | wc -l`
   * works in bash — in a table of its own, so it cannot take them away.
   */
  copy(): JobTable {
    const table = new JobTable();

    table.jobs = [...this.jobs];
    table.current = this.current;
    table.previous = this.previous;
    table.lastPid = this.lastPid;

    return table;
  }

  remove(job: Job): void {
    this.jobs = this.jobs.filter((other) => other !== job);

    if (this.current === job) {
      this.current = this.previous;
      this.previous = undefined;
    } else if (this.previous === job) {
      this.previous = undefined;
    }

    // The two most recent that remain, when either went
    const rest = this.jobs.filter((other) => other !== this.current);

    this.current ??= rest.pop();
    this.previous ??= this.jobs.filter((other) => other !== this.current).pop();
  }

  /** `+` for the current job, `-` for the previous, else a blank. */
  mark(job: Job): string {
    return job === this.current ? '+' : job === this.previous ? '-' : ' ';
  }

  /**
   * A job by its spec: `%n`, `%+` or `%%` (current), `%-` (previous), `%str`
   * (command starts with str), `%?str` (command contains it), or a pid.
   */
  find(spec: string): Job | undefined {
    if (!spec.startsWith('%')) {
      return this.jobs.find((job) => job.pid === spec);
    }

    const rest = spec.slice(1);

    if (rest === '' || rest === '+' || rest === '%') return this.current;
    if (rest === '-') return this.previous;
    if (/^\d+$/.test(rest)) return this.jobs.find((job) => job.id === Number(rest));
    if (rest.startsWith('?')) return this.jobs.find((job) => job.command.includes(rest.slice(1)));

    return this.jobs.find((job) => job.command.startsWith(rest));
  }

  /** A line of `jobs`: `[1]+  Running                 sleep 5 &`, with the pid under `-l`. */
  describe(job: Job, long = false): string {
    const state = job.state === 'Done' && job.status ? `Exit ${job.status}` : job.state;
    const pid = long ? `${job.pid} ` : ' ';

    return `[${job.id}]${this.mark(job)} ${pid}${state.padEnd(24)}${job.command}${job.state === 'Running' ? ' &' : ''}\n`;
  }
}
