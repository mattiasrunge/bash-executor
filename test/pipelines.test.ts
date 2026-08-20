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

Deno.test('Pipefail', async (t) => {
  await t.step('off by default: only the last stage counts', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false | true; echo "code=$?"');
    assertEquals(result.stdout, 'code=0\n');
  });

  await t.step('on: a failing stage fails the pipeline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('set -o pipefail; false | true; echo "code=$?"');
    assertEquals(result.stdout, 'code=1\n');
  });

  await t.step('on: the rightmost non-zero status wins', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('three() { return 3; }; four() { return 4; }; set -o pipefail; three | four | true; echo "code=$?"');
    assertEquals(result.stdout, 'code=4\n');
  });

  await t.step('on: all stages succeeding is still success', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('set -o pipefail; echo hi | cat | cat; echo "code=$?"');
    assertEquals(result.stdout, 'hi\ncode=0\n');
  });

  await t.step('+o turns it back off', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('set -o pipefail; set +o pipefail; false | true; echo "code=$?"');
    assertEquals(result.stdout, 'code=0\n');
  });

  await t.step('set in a function it applies to the whole shell', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('f() { set -o pipefail; }; f; false | true; echo "code=$?"');
    assertEquals(result.stdout, 'code=1\n');
  });

  await t.step('set in a subshell it does not leak out', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('( set -o pipefail; false | true; echo "in=$?" ); false | true; echo "out=$?"');
    assertEquals(result.stdout, 'in=1\nout=0\n');
  });

  await t.step('two shells do not share the option', async () => {
    const one = new TestShell();
    const two = new TestShell();
    await one.runAndCapture('set -o pipefail');
    const result = await two.runAndCapture('false | true; echo "code=$?"');
    assertEquals(result.stdout, 'code=0\n');
  });
});

Deno.test('Pipeline negation', async (t) => {
  await t.step('! inverts a failing pipeline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('! echo hi | grep zz; echo "code=$?"');
    assertEquals(result.stdout, 'code=0\n');
  });

  await t.step('! inverts a succeeding pipeline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('! echo hi | grep hi; echo "code=$?"');
    assertEquals(result.stdout, 'hi\ncode=1\n');
  });

  await t.step('! applies after pipefail', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('set -o pipefail; ! false | true; echo "code=$?"');
    assertEquals(result.stdout, 'code=0\n');
  });
});

Deno.test('PIPESTATUS', async (t) => {
  await t.step('holds every stage of the last pipeline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo hi | grep zz | cat; echo "ps=${PIPESTATUS[@]}"');
    assertEquals(result.stdout, 'ps=0 1 0\n');
  });

  await t.step('is indexable and countable', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo hi | grep hi; echo "first=${PIPESTATUS[0]} count=${#PIPESTATUS[@]}"');
    assertEquals(result.stdout, 'hi\nfirst=0 count=2\n');
  });

  await t.step('a plain command sets it to one element', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false; echo "ps=${PIPESTATUS[@]}"');
    assertEquals(result.stdout, 'ps=1\n');
  });

  await t.step('the next command replaces it', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo a | false; true; echo "ps=${PIPESTATUS[@]}"');
    assertEquals(result.stdout, 'ps=0\n');
  });

  await t.step('holds the raw status, before ! inverts it', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('! echo hi | grep zz; echo "code=$? ps=${PIPESTATUS[@]}"');
    assertEquals(result.stdout, 'code=0 ps=0 1\n');
  });

  await t.step('a subshell leaves one status, not its own pipeline', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo a | true; ( echo b | false ); echo "ps=${PIPESTATUS[@]}"');
    assertEquals(result.stdout, 'ps=1\n');
  });
});

Deno.test('Pipeline loop control', async (t) => {
  await t.step('break in a stage does not fail the pipeline under pipefail', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('set -o pipefail; for i in 1 2; do break | true; echo "$i"; done');
    assertEquals(result.stdout, '1\n2\n');
  });
});
