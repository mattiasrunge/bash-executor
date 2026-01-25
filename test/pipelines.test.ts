import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Simple Pipelines', async (t) => {
  await t.step('two-command pipeline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "hello world" | grep hello');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'hello world\n');
  });

  await t.step('pipeline with no match returns failure', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "hello" | grep xyz');
    assertEquals(result.exitCode, 1);
  });

  await t.step('three-command pipeline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "hello world" | grep hello | wc -l');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout.trim(), '1');
  });

  await t.step('pipeline with cat', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "test" | cat');
    assertEquals(result.stdout, 'test\n');
  });

  await t.step('pipeline with wc -w', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "one two three" | wc -w');
    assertEquals(result.stdout.trim(), '3');
  });
});

Deno.test('Pipeline Exit Codes', async (t) => {
  await t.step('pipeline returns last command exit code - success', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "test" | true');
    assertEquals(result.exitCode, 0);
  });

  await t.step('pipeline returns last command exit code - failure', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "test" | false');
    assertEquals(result.exitCode, 1);
  });

  await t.step('first command failure does not affect exit code', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false | echo "still runs"');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'still runs\n');
  });
});

Deno.test('Pipeline with Variables', async (t) => {
  await t.step('pipeline with variable in first command', async () => {
    const shell = new TestShell();
    shell.setParams({ MSG: 'hello' });
    const result = await shell.runAndCapture('echo $MSG | cat');
    assertEquals(result.stdout, 'hello\n');
  });

  await t.step('pipeline with arithmetic', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((2+2)) | cat');
    assertEquals(result.stdout, '4\n');
  });
});

Deno.test('I/O Redirections', async (t) => {
  await t.step('stdout redirection sets output file', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo test > output.txt');
    assertEquals(result.exitCode, 0);
  });

  await t.step('stderr redirection', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo test 2> error.txt');
    assertEquals(result.exitCode, 0);
  });

  await t.step('append redirection >>', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo test >> output.txt');
    assertEquals(result.exitCode, 0);
  });

  await t.step('stderr append redirection 2>>', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo test 2>> error.txt');
    assertEquals(result.exitCode, 0);
  });

  await t.step('stdin redirection <', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('cat < input.txt');
    assertEquals(result.exitCode, 0);
  });
});

Deno.test('Complex Pipelines', async (t) => {
  await t.step('multiple grep in pipeline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "hello world" | grep hello | grep world');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'hello world\n');
  });

  await t.step('pipeline with functions', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      greet() {
        echo "Hello there"
      }
      greet | grep Hello
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'Hello there\n');
  });

  await t.step('pipeline in if condition', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if echo "test" | grep test; then
        echo "found"
      fi
    `);
    assertEquals(result.stdout, 'test\nfound\n');
  });
});
