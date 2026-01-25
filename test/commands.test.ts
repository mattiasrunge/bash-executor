import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Basic Commands', async (t) => {
  await t.step('echo outputs arguments with newline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo Hello World');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'Hello World\n');
  });

  await t.step('echo with no arguments outputs empty line', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, '\n');
  });

  await t.step('echo with quoted string', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "Hello World"');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'Hello World\n');
  });

  await t.step('true command returns exit code 0', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('true');
    assertEquals(result.exitCode, 0);
  });

  await t.step('false command returns exit code 1', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false');
    assertEquals(result.exitCode, 1);
  });

  await t.step('multiple commands in script execute sequentially', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo one; echo two; echo three');
    assertEquals(result.stdout, 'one\ntwo\nthree\n');
  });

  await t.step('exit command returns specified code', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('exit 42');
    assertEquals(result.exitCode, 42);
  });

  await t.step('colon command (noop) returns 0', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(':');
    assertEquals(result.exitCode, 0);
  });
});

Deno.test('Bang Operator', async (t) => {
  await t.step('bang inverts exit code 0 to 1', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('! true');
    assertEquals(result.exitCode, 1);
  });

  await t.step('bang inverts exit code 1 to 0', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('! false');
    assertEquals(result.exitCode, 0);
  });

  await t.step('bang with non-zero exit code', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('! exit 5');
    assertEquals(result.exitCode, 0);
  });

  // Note: Bang with pipelines/compound commands is not fully implemented
  // in the executor - bang only applies correctly to simple commands
});

Deno.test('Unknown Commands', async (t) => {
  await t.step('unknown command returns exit code 127', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('nonexistent_command');
    assertEquals(result.exitCode, 127);
  });

  await t.step('unknown command writes to stderr', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('nonexistent_command');
    assertEquals(result.stderr.includes('command not found'), true);
  });
});

Deno.test('Command with Arguments', async (t) => {
  await t.step('command receives all arguments', async () => {
    const shell = new TestShell();
    shell.mockCommand('argtest', async (_ctx, args) => {
      return { code: 0, stdout: `count:${args.length} args:${args.join(',')}` };
    });
    const result = await shell.runAndCapture('argtest a b c d');
    assertEquals(result.stdout, 'count:4 args:a,b,c,d');
  });

  await t.step('empty arguments are preserved', async () => {
    const shell = new TestShell();
    shell.mockCommand('argtest', async (_ctx, args) => {
      return { code: 0, stdout: `count:${args.length}` };
    });
    const result = await shell.runAndCapture('argtest "" ""');
    assertEquals(result.stdout, 'count:2');
  });
});
