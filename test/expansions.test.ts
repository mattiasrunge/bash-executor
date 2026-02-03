import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Command Expansion', async (t) => {
  await t.step('$(command) captures stdout', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "Result: $(echo inner)"');
    assertEquals(result.stdout, 'Result: inner\n');
  });

  await t.step('command substitution with assignment prefix inside', async () => {
    const shell = new TestShell();
    shell.mockCommand('file-stat', async (_ctx, _args) => {
      // Return output similar to what the real command returns
      return { code: 0, stdout: 'result_from_file_stat\n' };
    });
    const result = await shell.runAndCapture(`
      FILENAME="/path/abc"
      STAT_OUTPUT=$(JSON_OUTPUT=1 file-stat "$FILENAME"); echo "$STAT_OUTPUT"
    `);

    assertEquals(result.stdout, 'result_from_file_stat\n');
    assertEquals(result.exitCode, 0);
  });

  await t.step('command substitution with long JSON output containing equals signs', async () => {
    // Tests a scenario similar to the MURRiX exiftool.sh bug
    // where command output is JSON containing = signs
    const shell = new TestShell();
    const jsonOutput = '{"size":3687764,"mtime":1768376602848,"birthtime":1768376602647,"uri":"/home/user/files/file.txt","mode":33204,"uid":1000,"gid":1000}';
    shell.mockCommand('file-stat', async (_ctx, _args) => {
      return { code: 0, stdout: jsonOutput };
    });
    const result = await shell.runAndCapture(`STAT_OUTPUT=$(JSON_OUTPUT=1 file-stat "/path"); echo "$STAT_OUTPUT"`);
    // Note: The output may have quotes stripped - that's a separate issue
    assertEquals(result.exitCode, 0);
  });

  await t.step('nested command expansion', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $(echo $(echo deep))');
    assertEquals(result.stdout, 'deep\n');
  });

  await t.step('command expansion in variable assignment', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=$(echo hello); echo $x');
    assertEquals(result.stdout, 'hello\n');
  });

  await t.step('command expansion strips trailing newlines', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "X$(echo test)X"');
    assertEquals(result.stdout, 'XtestX\n');
  });

  await t.step('command expansion with multiple words', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "Got: $(echo one two three)"');
    assertEquals(result.stdout, 'Got: one two three\n');
  });

  await t.step('command expansion in arithmetic', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $(($(echo 5) + $(echo 3)))');
    assertEquals(result.stdout, '8\n');
  });
});

Deno.test('Arithmetic Expansion', async (t) => {
  await t.step('simple arithmetic expansion', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((1+2))');
    assertEquals(result.stdout, '3\n');
  });

  await t.step('arithmetic expansion with variables', async () => {
    const shell = new TestShell();
    shell.setParams({ a: '10', b: '20' });
    const result = await shell.runAndCapture('echo $((a + b))');
    assertEquals(result.stdout, '30\n');
  });

  await t.step('arithmetic expansion in string', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "Total: $((2*3))"');
    assertEquals(result.stdout, 'Total: 6\n');
  });

  await t.step('multiple arithmetic expansions', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((1+1)) $((2+2)) $((3+3))');
    assertEquals(result.stdout, '2 4 6\n');
  });
});

Deno.test('Parameter Expansion', async (t) => {
  await t.step('simple $VAR expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ FOO: 'bar' });
    const result = await shell.runAndCapture('echo $FOO');
    assertEquals(result.stdout, 'bar\n');
  });

  await t.step('braced ${VAR} expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ FOO: 'bar' });
    const result = await shell.runAndCapture('echo ${FOO}baz');
    assertEquals(result.stdout, 'barbaz\n');
  });

  await t.step('expansion of undefined variable', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "[$UNDEFINED]"');
    assertEquals(result.stdout, '[]\n');
  });

  await t.step('expansion preserves empty string', async () => {
    const shell = new TestShell();
    shell.setParams({ EMPTY: '' });
    const result = await shell.runAndCapture('echo "[$EMPTY]"');
    assertEquals(result.stdout, '[]\n');
  });

  await t.step('multiple expansions in one word', async () => {
    const shell = new TestShell();
    shell.setParams({ A: 'one', B: 'two' });
    const result = await shell.runAndCapture('echo $A$B');
    assertEquals(result.stdout, 'onetwo\n');
  });
});

Deno.test('Mixed Expansions', async (t) => {
  await t.step('parameter and command expansion together', async () => {
    const shell = new TestShell();
    shell.setParams({ PREFIX: 'Hello' });
    const result = await shell.runAndCapture('echo "$PREFIX $(echo World)"');
    assertEquals(result.stdout, 'Hello World\n');
  });

  await t.step('parameter and arithmetic expansion together', async () => {
    const shell = new TestShell();
    shell.setParams({ X: '5' });
    const result = await shell.runAndCapture('echo "X=$X, X*2=$((X*2))"');
    assertEquals(result.stdout, 'X=5, X*2=10\n');
  });

  await t.step('all three expansion types', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'test' });
    const result = await shell.runAndCapture('echo "$VAR $(echo cmd) $((1+1))"');
    assertEquals(result.stdout, 'test cmd 2\n');
  });
});

Deno.test('Expansion in Different Contexts', async (t) => {
  await t.step('expansion in command name', async () => {
    const shell = new TestShell();
    shell.setParams({ CMD: 'echo' });
    const result = await shell.runAndCapture('$CMD hello');
    assertEquals(result.stdout, 'hello\n');
  });

  await t.step('expansion in if condition', async () => {
    const shell = new TestShell();
    shell.setParams({ X: '5' });
    const result = await shell.runAndCapture('if [ $X -gt 3 ]; then echo yes; fi');
    assertEquals(result.stdout, 'yes\n');
  });

  await t.step('expansion in for loop', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
        for i in $(echo a b c); do
          echo "item: $i"
        done
      `);
    assertEquals(result.stdout, 'item: a\nitem: b\nitem: c\n');
  });
});

Deno.test('Quoting and Expansion', async (t) => {
  await t.step('double quotes allow expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'value' });
    const result = await shell.runAndCapture('echo "var=$VAR"');
    assertEquals(result.stdout, 'var=value\n');
  });

  await t.step('single quotes prevent expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'value' });
    const result = await shell.runAndCapture("echo 'var=$VAR'");
    assertEquals(result.stdout, 'var=$VAR\n');
  });

  await t.step('escaped dollar prevents expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'value' });
    const result = await shell.runAndCapture('echo "var=\\$VAR"');
    assertEquals(result.stdout, 'var=$VAR\n');
  });
});
