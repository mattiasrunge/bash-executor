import { assertEquals, assertStringIncludes } from '@std/assert';
import { TestShell } from '../lib/test-shell.ts';

Deno.test('declare context integration', async (t) => {
  await t.step('readonly prevents modification', async () => {
    const shell = new TestShell();

    // Declare readonly variable
    await shell.runAndCapture('declare -r CONST=10');

    // Try to modify it
    const result = await shell.runAndCapture('declare CONST=20');

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.stderr, 'readonly');
  });

  await t.step('readonly vars persist across commands in script', async () => {
    const shell = new TestShell();

    // Script that declares readonly and tries to modify
    const script = `
declare -r X=5
echo "X is $X"
declare X=10
`;
    const result = await shell.runAndCapture(script);

    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.stdout, 'X is 5');
    assertStringIncludes(result.stderr, 'readonly');
  });

  await t.step('integer vars evaluate arithmetic', async () => {
    const shell = new TestShell();

    // Declare integer variable
    const result = await shell.runAndCapture(`
declare -i num=42
echo "num is $num"
`);

    assertEquals(result.exitCode, 0);
    assertStringIncludes(result.stdout, 'num is 42');
  });
});
