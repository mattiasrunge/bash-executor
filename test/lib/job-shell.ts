import type { ExecContextIf, JobHostIf } from '../../mod.ts';
import { TestShell } from './test-shell.ts';

/** A TestShell with job control: jobs run in the same process, signals end them with 128+n. */
export class JobShell extends TestShell {
  private next = 1000;
  private running = new Map<string, (status: number) => void>();
  signals: string[] = [];
  /** Every job started, ended or not */
  started: Promise<number>[] = [];

  jobs: JobHostIf = {
    start: async (ctx: ExecContextIf, run: (jobCtx: ExecContextIf) => Promise<number>) => {
      const pid = String(this.next++);
      const abort = new AbortController();
      const jobCtx = ctx.subContext();
      let killedWith: number | undefined;

      // A signal stops the job between commands, and it ends with 128 + n
      jobCtx.setAbortSignal(abort.signal);
      this.running.set(pid, (status) => {
        killedWith = status;
        abort.abort();
      });

      const done = run(jobCtx).catch(() => 1).then((code) => killedWith ?? code).finally(() => this.running.delete(pid));

      this.started.push(done);

      return await { pid, done };
    },
    signal: async (pid: string, signal: string) => {
      this.signals.push(`${signal} ${pid}`);

      const kill = this.running.get(pid);

      if (!kill) return false;
      if (signal !== '0') kill(signal === 'TERM' ? 143 : 137);

      return await true;
    },
    disown: async (pid: string) => {
      this.signals.push(`disown ${pid}`);
      return await Promise.resolve();
    },
  };
}
