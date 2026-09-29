import { assertEquals, assertStringIncludes } from '@std/assert';
import { TestShell } from '../lib/test-shell.ts';

Deno.test('shopt builtin', async (t) => {
  await t.step('-s and -u set, -q answers, with bash defaults', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(
      'shopt -q extglob; echo "a=$?"; shopt -s extglob; shopt -q extglob; echo "b=$?"; shopt -u extglob; shopt -q extglob; echo "c=$?"; shopt -q sourcepath; echo "d=$?"',
    );
    assertEquals(result.stdout, 'a=1\nb=0\nc=1\nd=0\n');
  });

  await t.step('a name alone prints its state, and its status says it', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('shopt lastpipe; echo "s=$?"');
    assertEquals(result.stdout, 'lastpipe       \toff\ns=1\n');
  });

  await t.step('-p prints the command that restores it', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('shopt -s nullglob; shopt -p nullglob dotglob');
    assertEquals(result.stdout, 'shopt -s nullglob\nshopt -u dotglob\n');
  });

  await t.step('an unknown name is an error', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('shopt -s nosuch');
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.stderr, 'nosuch: invalid shell option name');
  });

  await t.step('-o works on the set options', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('shopt -o -s pipefail; shopt -o -p pipefail');
    assertEquals(result.stdout, 'set -o pipefail\n');
  });

  await t.step('set -o does not list the shopt options', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('set -o');
    assertEquals(result.stdout.includes('lastpipe'), false);
  });
});
