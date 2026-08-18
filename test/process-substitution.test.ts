import { assertEquals, assertRejects } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

/** A shell whose `readfile` command prints the contents of the path it is given */
const shellWithReader = () => {
  const shell = new TestShell();

  shell.mockCommand('readfile', async (_ctx, args) => ({ code: 0, stdout: `READ:${shell.getFile(args[0])}` }));

  return shell;
};

Deno.test('Process substitution', async (t) => {
  await t.step('<(cmd) becomes a path the command can read', async () => {
    const shell = shellWithReader();
    const result = await shell.runAndCapture('readfile <(printf "hi\\n")');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'READ:hi\n');
  });

  await t.step('it can be redirected from', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('read x < <(echo yo); echo "[$x]"');
    assertEquals(result.stdout, '[yo]\n');
  });

  await t.step('mapfile reads it, which is what it is for', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('mapfile -t L < <(printf "a b\\nc d\\n"); echo "${#L[@]} [${L[1]}]"');
    assertEquals(result.stdout, '2 [c d]\n');
  });

  await t.step('a loop reads it line by line', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('while read l; do echo "[$l]"; done < <(printf "1\\n2\\n")');
    assertEquals(result.stdout, '[1]\n[2]\n');
  });

  await t.step('two of them are two different files', async () => {
    const shell = shellWithReader();
    const result = await shell.runAndCapture('readfile <(echo one) <(echo two)');
    assertEquals(result.stdout, 'READ:one\n');
  });

  await t.step('the scratch file is gone once the command is done', async () => {
    const shell = shellWithReader();

    await shell.runAndCapture('readfile <(echo x)');

    assertEquals(shell.getFile('/tmp/psub-0'), '');
  });

  await t.step('a shell without the callback says so', async () => {
    const shell = new TestShell();
    // deno-lint-ignore no-explicit-any
    (shell as any).tempFile = undefined;

    // Better an error than a path that does not work
    await assertRejects(() => shell.runAndCapture('cat <(echo x)'), Error, 'process substitution is not supported');
  });
});
