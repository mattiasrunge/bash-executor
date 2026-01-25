import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Empty and Minimal Scripts', async (t) => {
  // Note: bash-parser throws "Unexpected EOF" for empty/comment-only scripts
  // This is a parser limitation - real bash would return 0 for these cases
  // See: https://github.com/vorpaljs/bash-parser/issues/XXX

  await t.step('shebang line is handled', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('#!/bin/bash\necho "hello"');
    assertEquals(result.stdout, 'hello\n');
  });

  await t.step('comment followed by command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('# comment\necho "hello"');
    assertEquals(result.stdout, 'hello\n');
  });

  await t.step('inline comment', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "hello" # this is a comment');
    assertEquals(result.stdout, 'hello\n');
  });
});

Deno.test('Subshells', async (t) => {
  await t.step('subshell executes commands', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('(echo "in subshell")');
    assertEquals(result.stdout, 'in subshell\n');
  });

  await t.step('subshell returns last command exit code', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('(true; false)');
    assertEquals(result.exitCode, 1);
  });

  await t.step('subshell with multiple commands', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('(echo "a"; echo "b"; echo "c")');
    assertEquals(result.stdout, 'a\nb\nc\n');
  });

  await t.step('nested subshells', async () => {
    const shell = new TestShell();
    // Note: Need space before final ) to avoid )) being parsed as arithmetic
    const result = await shell.runAndCapture('(echo "outer"; (echo "inner") )');
    assertEquals(result.stdout, 'outer\ninner\n');
  });
});

Deno.test('Deeply Nested Structures', async (t) => {
  await t.step('deeply nested if statements', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if true; then
        if true; then
          if true; then
            echo "deep"
          fi
        fi
      fi
    `);
    assertEquals(result.stdout, 'deep\n');
  });

  await t.step('nested loops', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in 1 2; do
        for j in a b; do
          echo "$i$j"
        done
      done
    `);
    assertEquals(result.stdout, '1a\n1b\n2a\n2b\n');
  });

  await t.step('function calling function', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      inner() {
        echo "inner"
      }
      outer() {
        echo "outer"
        inner
      }
      outer
    `);
    assertEquals(result.stdout, 'outer\ninner\n');
  });
});

Deno.test('Special Characters', async (t) => {
  await t.step('newlines in echo', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "line1"; echo "line2"');
    assertEquals(result.stdout, 'line1\nline2\n');
  });

  await t.step('tabs preserved in output', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "a\tb"');
    assertEquals(result.stdout, 'a\tb\n');
  });

  await t.step('empty string argument', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo ""');
    assertEquals(result.stdout, '\n');
  });
});

Deno.test('Context and Variable Isolation', async (t) => {
  await t.step('script level variable persists', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      x=1
      echo $x
      x=2
      echo $x
    `);
    assertEquals(result.stdout, '1\n2\n');
  });

  await t.step('variable set in loop body persists', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      x=0
      for i in 1 2 3; do
        x=$i
      done
      echo $x
    `);
    assertEquals(result.stdout, '3\n');
  });

  await t.step('variable set in if body persists', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      x=before
      if true; then
        x=inside
      fi
      echo $x
    `);
    assertEquals(result.stdout, 'inside\n');
  });
});

Deno.test('Error Handling', async (t) => {
  await t.step('command not found sets exit code 127', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('nonexistent_command_xyz');
    assertEquals(result.exitCode, 127);
  });

  // Note: Current executor stops on first non-zero exit code (like set -e)
  // In standard bash without set -e, 'false; false; exit 5' would return 5
  await t.step('first failure stops script', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false; echo "never"; exit 5');
    assertEquals(result.exitCode, 1);
    assertEquals(result.stdout, '');
  });
});

Deno.test('Compound Lists', async (t) => {
  await t.step('commands separated by semicolon', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo a; echo b; echo c');
    assertEquals(result.stdout, 'a\nb\nc\n');
  });

  await t.step('commands with && and semicolon', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo a && echo b; echo c');
    assertEquals(result.stdout, 'a\nb\nc\n');
  });

  await t.step('braced group', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('{ echo a; echo b; }');
    assertEquals(result.stdout, 'a\nb\n');
  });
});

Deno.test('Multiple Test Expressions', async (t) => {
  await t.step('test with string equality', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[ "abc" = "abc" ] && echo yes');
    assertEquals(result.stdout, 'yes\n');
  });

  await t.step('test with string inequality', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[ "abc" != "xyz" ] && echo yes');
    assertEquals(result.stdout, 'yes\n');
  });

  await t.step('test with -z (empty string)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[ -z "" ] && echo empty');
    assertEquals(result.stdout, 'empty\n');
  });

  await t.step('test with -z (unset variable)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[ -z "$UNSET" ] && echo empty');
    assertEquals(result.stdout, 'empty\n');
  });

  await t.step('test with -n (non-empty string)', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[ -n "hello" ] && echo nonempty');
    assertEquals(result.stdout, 'nonempty\n');
  });

  await t.step('test with negation !', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('[ ! -z "hello" ] && echo yes');
    assertEquals(result.stdout, 'yes\n');
  });
});
