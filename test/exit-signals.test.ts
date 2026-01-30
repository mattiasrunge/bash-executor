import { assertEquals, assertStringIncludes } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('exit signal handling', async (t) => {
  await t.step('exit in script stops execution', async () => {
    const shell = new TestShell();

    const script = `
echo "line 1"
exit 5
echo "line 2"
`;
    const result = await shell.runAndCapture(script);

    assertEquals(result.exitCode, 5);
    assertStringIncludes(result.stdout, 'line 1');
    assertEquals(result.stdout.includes('line 2'), false);
  });

  await t.step('exit with zero code', async () => {
    const shell = new TestShell();

    const result = await shell.runAndCapture('exit 0');
    assertEquals(result.exitCode, 0);
  });

  await t.step('exit with no argument uses last exit code', async () => {
    const shell = new TestShell();

    // false sets $? to 1, then exit uses it
    const result = await shell.runAndCapture(`
false
exit
`);
    assertEquals(result.exitCode, 1);
  });

  await t.step('return in function returns to caller', async () => {
    const shell = new TestShell();

    const script = `
myfunc() {
  echo "in func"
  return 42
  echo "after return"
}
myfunc
echo "exit code was $?"
`;
    const result = await shell.runAndCapture(script);

    assertStringIncludes(result.stdout, 'in func');
    assertEquals(result.stdout.includes('after return'), false);
    assertStringIncludes(result.stdout, 'exit code was 42');
  });

  await t.step('exit in while loop stops script', async () => {
    const shell = new TestShell();

    const script = `
i=0
while [ $i -lt 5 ]; do
  echo "iteration $i"
  if [ $i -eq 2 ]; then
    exit 99
  fi
  i=$((i + 1))
done
echo "after loop"
`;
    const result = await shell.runAndCapture(script);

    assertEquals(result.exitCode, 99);
    // Should have iterations 0, 1, 2 but not after loop
    assertStringIncludes(result.stdout, 'iteration 0');
    assertStringIncludes(result.stdout, 'iteration 1');
    assertStringIncludes(result.stdout, 'iteration 2');
    assertEquals(result.stdout.includes('iteration 3'), false);
    assertEquals(result.stdout.includes('after loop'), false);
  });
});
