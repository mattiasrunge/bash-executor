import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('executor', async (t) => {
  await t.step('execute a simple bash script', async () => {
    const shell = new TestShell();
    const bashScript = `echo "Hello, World!"`;
    const result = await shell.runAndCapture(bashScript);

    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'Hello, World!\n');
  });

  await t.step('execute an advanced bash script with pipe', async () => {
    const shell = new TestShell();
    const bashScript = `echo "Hello, World!" | grep "Hello"`;
    const result = await shell.runAndCapture(bashScript);

    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'Hello, World!\n');
  });

  await t.step('execute a bash function', async () => {
    const shell = new TestShell();
    const bashScript = `
    hello() {
      echo "Hello, World!"
    }

    hello
  `;
    const result = await shell.runAndCapture(bashScript);

    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'Hello, World!\n');
  });

  await t.step('execute a bash arithmetic operation', async () => {
    const shell = new TestShell();
    const bashScript = `echo $((1+2))`;
    const result = await shell.runAndCapture(bashScript);

    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, '3\n');
  });

  await t.step('execute a piped command', async () => {
    const shell = new TestShell();
    const bashScript = `echo "Hello, World!" | grep "Hello" | wc -l`;
    const result = await shell.runAndCapture(bashScript);

    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout.trim(), '1');
  });

  await t.step('execute a bash script with if', async () => {
    const shell = new TestShell();
    const bashScript = `#!/bin/bash

# Define a variable
value=15

# Check the value using if, elif, and else
if [ $value -lt 5 ]; then
  echo "The value is less than 5."
elif [ $value -eq 10 ]; then
  echo "The value is equal to 10."
else
  echo "The value is greater than 5 but not equal to 10."
fi
  `;
    const result = await shell.runAndCapture(bashScript);

    assertEquals(result.exitCode, 0);
    assertEquals(
      result.stdout,
      'The value is greater than 5 but not equal to 10.\n',
    );
  });
});
