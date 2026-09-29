import { assertEquals, assertStringIncludes } from '@std/assert';
import type { ExecContextIf, JobHostIf } from '../mod.ts';
import { TestShell } from './lib/test-shell.ts';

/** A TestShell with job control: jobs run in the same process, signals end them with 128+n. */
class JobShell extends TestShell {
  private next = 1000;
  private running = new Map<string, (status: number) => void>();
  signals: string[] = [];

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

const run = async (script: string) => {
  const shell = new JobShell();
  const result = await shell.runAndCapture(script);

  return { ...result, signals: shell.signals };
};

Deno.test('job control through the host', async (t) => {
  await t.step('& starts a job, $! is its pid, wait gives its status', async () => {
    const result = await run('(exit 3) & echo "pid=$!"; wait $!; echo "st=$?"');
    assertEquals(result.stdout, 'pid=1000\nst=3\n');
  });

  await t.step('jobs lists them with + and -', async () => {
    const result = await run('while :; do :; done & while :; do :; done & jobs; kill %1 %2; wait');
    assertEquals(result.stdout, '[1]-  Running                 while :; do :; done &\n[2]+  Running                 while :; do :; done &\n');
  });

  await t.step('kill takes job specs and signal names, and wait sees the signal', async () => {
    const result = await run('while :; do :; done & kill -KILL %%; wait %1; echo "st=$?"');
    assertEquals(result.stdout, 'st=137\n');
    assertEquals(result.signals, ['KILL 1000']);
  });

  await t.step('unknown jobs and pids', async () => {
    const result = await run('kill %9; echo "k=$?"; wait 42; echo "w=$?"; kill 42; echo "k2=$?"');
    assertEquals(result.stdout, 'k=1\nw=127\nk2=1\n');
    assertStringIncludes(result.stderr, 'kill: %9: no such job');
    assertStringIncludes(result.stderr, 'wait: pid 42 is not a child of this shell');
    assertStringIncludes(result.stderr, 'kill: (42) - No such process');
  });

  await t.step('kill -l', async () => {
    const result = await run('kill -l 15 TERM 143');
    assertEquals(result.stdout, 'TERM\n15\nTERM\n');
  });

  await t.step('fg without job control', async () => {
    const result = await run('fg; echo "st=$?"');
    assertEquals(result.stdout, 'st=1\n');
    assertStringIncludes(result.stderr, 'fg: no job control');
  });

  await t.step('disown takes a job out of the table', async () => {
    const result = await run('while :; do :; done & disown; jobs; kill $!');
    assertEquals(result.stdout, '');
    assertEquals(result.signals, ['disown 1000', 'TERM 1000']);
  });

  await t.step('disown -h keeps the job in the table, and still tells the host', async () => {
    const result = await run('while :; do :; done & disown -h %1; jobs -p; kill %1');
    assertEquals(result.stdout, '1000\n');
    assertEquals(result.signals, ['disown 1000', 'TERM 1000']);
  });
});

Deno.test('without job control in the host, the job builtins are not there', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('wait; echo "st=$?"');
  assertEquals(result.stdout, 'st=127\n');
});

Deno.test('without job control, type and command do not find the job builtins', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('type -t wait; echo "st=$?"');
  assertEquals(result.stdout, 'st=1\n');
});
