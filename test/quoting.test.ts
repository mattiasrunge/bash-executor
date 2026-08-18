import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

const run = async (script: string) => {
  const shell = new TestShell();

  return (await shell.runAndCapture(script)).stdout;
};

Deno.test('Backslashes and quoting', async (t) => {
  await t.step('a backslash inside double quotes is literal', async () => {
    assertEquals(await run('echo "a\\nb"'), 'a\\nb\n');
    assertEquals(await run('echo "col1\\tcol2"'), 'col1\\tcol2\n');
  });

  await t.step('it still escapes the four characters bash gives it meaning for', async () => {
    assertEquals(await run('echo "a\\$b"'), 'a$b\n');
    assertEquals(await run('echo "a\\"b"'), 'a"b\n');
    assertEquals(await run('echo "a\\\\b"'), 'a\\b\n');
  });

  await t.step('single quotes are fully literal', async () => {
    assertEquals(await run("echo 'a\\nb'"), 'a\\nb\n');
    assertEquals(await run("echo '\\1'"), '\\1\n');
  });

  await t.step('an unquoted backslash escapes the next character', async () => {
    assertEquals(await run('echo a\\nb'), 'anb\n');
  });

  await t.step("$'…' is what decodes escapes", async () => {
    assertEquals(await run("echo $'a\\nb'"), 'a\nb\n');
    assertEquals(await run("echo $'\\x41'"), 'A\n');
  });

  await t.step('an expansion result is never re-escaped', async () => {
    assertEquals(await run('V="x\\ty"; echo "$V"'), 'x\\ty\n');
  });
});
