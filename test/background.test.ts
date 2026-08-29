/**
 * `&` on something that is not a single external command.
 *
 * The executor can only hand a command *name* to `ShellIf.execute`, so that is
 * the only `&` it ever acted on. A list, a group, a subshell, a loop, a builtin
 * and a function all ignored the `&` and ran in the foreground — which is why a
 * multi-step sweep could not be backgrounded, let alone detached. They go
 * through the optional `executeBackground` hook instead: the shell is handed a
 * thunk, because only it can give such a command a process of its own.
 */

import { assert, assertEquals } from '@std/assert';
import type { ExecContextIf } from '../mod.ts';
import { TestShell } from './lib/test-shell.ts';

type Backgrounded = { command: string; code: number };

/**
 * A shell that records what it was asked to background, and — like a real one —
 * runs it rather than dropping it.
 */
class BackgroundingShell extends TestShell {
  public backgrounded: Backgrounded[] = [];

  async executeBackground(
    _ctx: ExecContextIf,
    run: (ctx: ExecContextIf) => Promise<number>,
    command: string,
  ): Promise<number> {
    const entry: Backgrounded = { command, code: -1 };
    this.backgrounded.push(entry);
    entry.code = await run(_ctx);
    return 0;
  }
}

Deno.test('`&` on a compound command', async (t) => {
  await t.step('a && list, a group, a subshell and a loop all reach the shell', async () => {
    const cases: [string, string][] = [
      ['echo one && echo two &', 'echo one && echo two'],
      ['{ echo one; echo two; } &', '{ echo one; echo two; }'],
      ['( echo one ) &', '( echo one )'],
      ['for i in 1 2; do echo $i; done &', 'for i in 1 2; do echo $i; done'],
      ['while false; do echo no; done &', 'while false; do echo no; done'],
      ['if true; then echo yes; fi &', 'if true; then echo yes; fi'],
    ];

    for (const [script, source] of cases) {
      const shell = new BackgroundingShell();
      await shell.runAndCapture(script);
      assertEquals(shell.backgrounded.map((entry) => entry.command), [source], script);
    }
  });

  await t.step('the job actually runs, and its output is its own', async () => {
    const shell = new BackgroundingShell();
    const result = await shell.runAndCapture('{ echo one; echo two; } &');
    assertEquals(result.stdout, 'one\ntwo\n');
    assertEquals(shell.backgrounded[0].code, 0);
  });

  await t.step('a builtin is backgrounded, and its arguments are expanded once', async () => {
    const shell = new BackgroundingShell();
    let calls = 0;
    shell.mockCommand('pick', async () => {
      calls++;
      return { code: 0, stdout: 'chosen\n' };
    });

    const result = await shell.runAndCapture('echo $(pick) &');
    assertEquals(shell.backgrounded.map((entry) => entry.command), ['echo $(pick)']);
    assertEquals(result.stdout, 'chosen\n');
    assertEquals(calls, 1, 'the substitution inside a backgrounded builtin must run once');
  });

  await t.step('a shell function is backgrounded', async () => {
    const shell = new BackgroundingShell();
    const result = await shell.runAndCapture('greet() { echo hello; }\ngreet &');
    assertEquals(shell.backgrounded.map((entry) => entry.command), ['greet']);
    assertEquals(result.stdout, 'hello\n');
  });

  // The single-command path predates the hook and still owns it: the shell gets
  // a name and an `async` option, which is what lets it spawn a real process.
  await t.step('a single external command still goes through `execute`', async () => {
    const shell = new BackgroundingShell();
    shell.mockCommand('worker', async () => ({ code: 0 }));

    await shell.runAndCapture('worker &');
    assertEquals(shell.backgrounded, []);
  });

  // An `exit` in a background job ends the job, not whatever started it, so the
  // encoded signal has to be resolved before the shell records the status.
  await t.step('`exit` inside a background job becomes its status', async () => {
    const shell = new BackgroundingShell();
    await shell.runAndCapture('{ exit 3; } &');
    assertEquals(shell.backgrounded[0].code, 3);
  });

  await t.step('an errexit trip becomes a status too, not a sentinel', async () => {
    const shell = new BackgroundingShell();
    await shell.runAndCapture('{ set -e; false; echo unreachable; } &');
    assertEquals(shell.backgrounded[0].code, 1);
    assert(!(await shell.runAndCapture('{ set -e; false; echo unreachable; } &')).stdout.includes('unreachable'));
  });

  // A host that does not implement the hook has to keep working, which for the
  // executor means running the command where it stands.
  await t.step('a shell without the hook runs it in the foreground', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('{ echo one; echo two; } &');
    assertEquals(result.stdout, 'one\ntwo\n');
  });
});
