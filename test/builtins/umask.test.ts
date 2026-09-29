import { assertEquals } from '@std/assert';
import { TestShell } from '../lib/test-shell.ts';

Deno.test('umask builtin', async (t) => {
  await t.step('prints the mask in octal, symbolically, and to be read back', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('umask; umask -S; umask -p; umask -p -S');

    assertEquals(result.stdout, '0022\nu=rwx,g=rx,o=rx\numask 0022\numask -S u=rwx,g=rx,o=rx\n');
  });

  await t.step('sets it from octal or from a symbolic mode', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('umask 077; umask; umask g+rx,o=r; umask; umask -S a-w; umask');

    assertEquals(result.stdout, '0077\n0023\nu=rx,g=rx,o=r\n0223\n');
  });

  await t.step('refuses a bad mode and keeps the mask', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('umask 8; umask u+q; umask');

    assertEquals(result.stdout, '0022\n');
    assertEquals(result.stderr, "umask: 8: octal number out of range\numask: `q': invalid symbolic mode character\n");
  });

  await t.step('a subshell has its own', async () => {
    const shell = new TestShell();

    assertEquals((await shell.runAndCapture('(umask 077; umask); umask')).stdout, '0077\n0022\n');
  });
});
