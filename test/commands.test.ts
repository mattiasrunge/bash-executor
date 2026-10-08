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

  await t.step('bang does not invert an exit: the shell ends with its status', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('! exit 5');
    assertEquals(result.exitCode, 5);
  });
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

Deno.test('command names that expand to zero or several words', async (t) => {
  await t.step('an empty name leaves the next word as the command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('empty=; $empty echo hi');
    assertEquals(result.stdout, 'hi\n');
  });

  await t.step('a name that splits runs the first word with the rest as arguments', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('cmd="echo a b"; $cmd c');
    assertEquals(result.stdout, 'a b c\n');
  });

  await t.step('nothing left is no command, and takes the substitution status', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('$(false); echo "s=$?"; $unset; echo "s=$?"');
    assertEquals(result.stdout, 's=1\ns=0\n');
  });

  await t.step('the redirections of an empty command still happen', async () => {
    const shell = new TestShell();
    await shell.runAndCapture('$unset > /tmp/made');
    assertEquals(shell.getFile('/tmp/made'), '');
  });
});
