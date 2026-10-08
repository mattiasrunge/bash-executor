import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Empty and Minimal Scripts', async (t) => {
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

Deno.test('Subshell isolation', async (t) => {
  await t.step('export in a subshell does not leak to the parent', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('(export LEAK=1); echo "[${LEAK}]"');
    assertEquals(result.stdout, '[]\n');
    assertEquals(shell.getEnv().LEAK, undefined);
  });

  await t.step('cd in a subshell does not change the parent cwd', async () => {
    const shell = new TestShell();
    shell.setCwd('/start');
    const result = await shell.runAndCapture('(cd /elsewhere); pwd');
    assertEquals(result.stdout, '/start\n');
    assertEquals(shell.getCwd(), '/start');
  });

  await t.step('export in command substitution does not leak', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $(export SUB=1; echo hi); echo "[${SUB}]"');
    assertEquals(result.stdout, 'hi\n[]\n');
    assertEquals(shell.getEnv().SUB, undefined);
  });

  await t.step('export in a pipeline stage does not leak', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('true | export PIPE=1; echo "[${PIPE}]"');
    assertEquals(result.stdout, '[]\n');
    assertEquals(shell.getEnv().PIPE, undefined);
  });

  await t.step('executeAndCapture does not leak env into the calling shell', async () => {
    // A captured command exporting PATH leaves the persistent shell's
    // executable search path alone
    const shell = new TestShell();
    shell.setEnv({ PATH: '/bin' });
    const result = await shell.executeAndCapture('export PATH=/tmp/node-path; echo done');
    assertEquals(result.code, 0);
    assertEquals(result.stdout, 'done\n');
    assertEquals(shell.getEnv().PATH, '/bin');
  });

  await t.step('executeAndCapture is not a terminal', async () => {
    // Capturing redirects stdout to a pipe, so the captured command sees TERM=0
    // as a pipeline stage or `$( )` does, and writes no escapes for a human
    const shell = new TestShell();
    shell.setEnv({ TERM: '1' });
    const result = await shell.executeAndCapture('echo "[$TERM]"');
    assertEquals(result.code, 0);
    assertEquals(result.stdout, '[0]\n');
    // ...and the interactive shell it was captured from is still a terminal.
    assertEquals(shell.getEnv().TERM, '1');
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

  // Standard bash behavior: non-zero exit code does NOT stop script execution
  // (unless set -e is enabled). The script continues to the next command.
  await t.step('non-zero exit code does not stop script', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('false; echo "continues"; exit 5');
    assertEquals(result.exitCode, 5);
    assertEquals(result.stdout, 'continues\n');
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
