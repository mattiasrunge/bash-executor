import { assertEquals, assertStringIncludes } from '@std/assert';
import { TestShell } from '../lib/test-shell.ts';

const run = async (script: string) => await new TestShell().runAndCapture(script);

Deno.test('trap builtin', async (t) => {
  await t.step('-p lists as bash does: EXIT, signals by number, then the events', async () => {
    const result = await run(`trap 'echo "a b"' EXIT; trap x USR1 int; trap '' TERM; trap e ERR; trap -p`);
    assertEquals(result.stdout, `trap -- 'echo "a b"' EXIT\ntrap -- 'x' SIGINT\ntrap -- 'x' SIGUSR1\ntrap -- '' SIGTERM\ntrap -- 'e' ERR\n`);
  });

  await t.step('- and a lone signal reset; a number first makes them all signals', async () => {
    const result = await run(`trap x INT TERM 0; trap - INT; trap TERM; trap 0; trap -p`);
    assertEquals(result.stdout, '');
  });

  await t.step('quotes in the command come back quoted', async () => {
    const result = await run(`trap "echo 'q'" EXIT; trap -p EXIT; trap - EXIT`);
    assertEquals(result.stdout, `trap -- 'echo '\\''q'\\''' EXIT\n`);
  });

  await t.step('an unknown signal is an error', async () => {
    const result = await run('trap x FOO');
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.stderr, 'FOO: invalid signal specification');
  });

  await t.step('-l lists the signals', async () => {
    const result = await run('trap -l');
    assertEquals(result.stdout.split('\n')[0], ' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP');
    assertStringIncludes(result.stdout, '64) SIGRTMAX\t\n');
  });
});

Deno.test('traps run', async (t) => {
  await t.step('ERR after a failing command, with its status, not in a condition', async () => {
    const result = await run('trap "echo err \\$?" ERR; false; if false; then :; fi; echo done');
    assertEquals(result.stdout, 'err 1\ndone\n');
  });

  await t.step('functions inherit ERR only under set -E', async () => {
    const result = await run('f() { false; }; trap "echo err \\$?" ERR; f; set -E; f');
    assertEquals(result.stdout, 'err 1\nerr 1\nerr 1\n');
  });

  await t.step('EXIT at the end of a subshell and of a $( )', async () => {
    const result = await run('(trap "echo sub" EXIT; echo in); x=$(trap "echo cs" EXIT; echo v); echo "[$x]"');
    assertEquals(result.stdout, 'in\nsub\n[v\ncs]\n');
  });

  await t.step('RETURN only for a function that set it, or under set -T; DEBUG before commands', async () => {
    const result = await run(
      'f() { :; }; trap "echo no" RETURN; f; trap - RETURN; g() { trap "echo gret" RETURN; :; }; g; trap - RETURN; trap "echo D" DEBUG; echo a; trap - DEBUG',
    );
    assertEquals(result.stdout, 'gret\nD\na\nD\n');
  });
});
