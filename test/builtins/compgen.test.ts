import { assertEquals } from '@std/assert';
import { TestShell } from '../lib/test-shell.ts';

Deno.test('compgen builtin', async (t) => {
  await t.step('completes functions, variables and a word list', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(
      'f2() { :; }; f1() { :; }; xa=1; xb=2; compgen -A function; compgen -v x; compgen -W "start stop status" -- sta',
    );

    assertEquals(result.stdout, 'f1\nf2\nxa\nxb\nstart\nstatus\n');
  });

  await t.step('adds a prefix and a suffix, and filters with -X', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('compgen -P "<" -S ">" -X "b*" -W "a b c"; compgen -X "!b*" -W "a b c"');

    assertEquals(result.stdout, '<a>\n<c>\nb\n');
  });

  await t.step('fails when nothing matches', async () => {
    const shell = new TestShell();

    assertEquals((await shell.runAndCapture('compgen -W "a b" zz')).exitCode, 1);
  });
});
