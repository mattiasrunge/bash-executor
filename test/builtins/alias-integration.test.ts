import { assertEquals } from '@std/assert';
import { TestShell } from '../lib/test-shell.ts';

Deno.test('alias integration', async (t) => {
  await t.step('alias with no args lists all aliases', async () => {
    const shell = new TestShell();

    // Define some aliases
    await shell.runAndCapture("alias ll='ls -la'");
    await shell.runAndCapture("alias la='ls -A'");

    // List all aliases
    const result = await shell.runAndCapture('alias');

    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout.includes("alias la='ls -A'"), true);
    assertEquals(result.stdout.includes("alias ll='ls -la'"), true);
  });

  await t.step('unalias -a clears all aliases', async () => {
    const shell = new TestShell();

    // Define some aliases
    await shell.runAndCapture("alias foo='bar'");
    await shell.runAndCapture("alias baz='qux'");

    // Clear all aliases
    await shell.runAndCapture('unalias -a');

    // List should be empty
    const result = await shell.runAndCapture('alias');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, '');
  });
});
