import { assertEquals } from '@std/assert';
import { TestShell } from '../lib/test-shell.ts';

Deno.test('call stack', async (t) => {
  await t.step('FUNCNAME, BASH_SOURCE and BASH_LINENO follow the calls', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(
      'f() {\n  echo "${FUNCNAME[*]} / ${BASH_SOURCE[*]} / ${BASH_LINENO[*]}"\n  g\n}\ng() { echo "${FUNCNAME[*]} / ${BASH_LINENO[*]}"; }\nf\necho "${#FUNCNAME[@]}"',
      { file: 'script.sh' },
    );

    assertEquals(result.stdout, 'f main / script.sh script.sh / 6 0\ng f main / 3 6 0\n0\n');
  });

  await t.step('a sourced file is a frame of its own', async () => {
    const shell = new TestShell();

    shell.setFile('lib.sh', 'echo "${FUNCNAME[*]} ${BASH_SOURCE[0]}"\nlibf() { echo "${BASH_SOURCE[0]}"; }\n');

    const result = await shell.runAndCapture('source lib.sh\nlibf', { file: 'main.sh' });

    assertEquals(result.stdout, 'source main lib.sh\nlib.sh\n');
  });

  await t.step('caller says where the function was called from', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('f() {\n  caller\n  caller 0\n  caller 1 || echo none\n}\nf', { file: 'x.sh' });

    assertEquals(result.stdout, '6 x.sh\n6 main x.sh\nnone\n');
  });

  await t.step('a string run as it is has no main frame', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('f() { echo "${FUNCNAME[*]} ${BASH_SOURCE[*]}"; }; f; caller || echo top');

    assertEquals(result.stdout, 'f environment\ntop\n');
  });
});
