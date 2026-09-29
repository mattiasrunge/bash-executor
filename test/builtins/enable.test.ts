import { assertEquals } from '@std/assert';
import { TestShell } from '../lib/test-shell.ts';

Deno.test('enable builtin', async (t) => {
  await t.step('turns a builtin off and on again', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('enable -n test; type -t test; enable -n; enable test; type -t test; enable -n');

    assertEquals(result.stdout, 'enable -n test\nbuiltin\n');
    // `type -t` says nothing about a name that is nothing
    assertEquals(result.stderr, '');
  });

  await t.step('lists the special builtins', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('enable -ps');

    assertEquals(result.stdout.split('\n').slice(0, 4), ['enable .', 'enable :', 'enable break', 'enable continue']);
  });

  await t.step('knows no builtin by a name it does not have', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('enable nothere');

    assertEquals(result.exitCode, 1);
    assertEquals(result.stderr, 'enable: nothere: not a shell builtin\n');
  });
});
