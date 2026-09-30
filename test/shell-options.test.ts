/**
 * The `set` options, other than pipefail (which `pipelines.test.ts` covers).
 *
 * Every expectation here was measured against real bash before it was written
 * down — the exemption rules for `set -e` in particular are easy to state wrong
 * from memory, and `false && echo t` not ending the shell is the case that shows
 * errexit is decided per command rather than on an assembled status.
 */

import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

const out = async (script: string): Promise<string> => (await new TestShell().runAndCapture(script)).stdout;

Deno.test('errexit', async (t) => {
  await t.step('a failing command ends the shell', async () => {
    const result = await new TestShell().runAndCapture('set -e; false; echo after');
    assertEquals(result.stdout, '');
    assertEquals(result.exitCode, 1);
  });

  await t.step('off, the shell carries on', async () => {
    assertEquals(await out('set +e; false; echo after'), 'after\n');
  });

  await t.step('an if clause is exempt', async () => {
    assertEquals(await out('set -e; if false; then echo t; fi; echo after'), 'after\n');
  });

  await t.step('a while clause is exempt', async () => {
    assertEquals(await out('set -e; while false; do :; done; echo after'), 'after\n');
  });

  await t.step('the left of && and || is exempt, the right is not', async () => {
    assertEquals(await out('set -e; false || echo ok; echo after'), 'ok\nafter\n');
    assertEquals(await out('set -e; false && echo t; echo after'), 'after\n');
    assertEquals(await out('set -e; true && false; echo after'), '');
  });

  await t.step('a command under ! is exempt', async () => {
    assertEquals(await out('set -e; ! false; echo after'), 'after\n');
    assertEquals(await out('set -e; ! true; echo after'), 'after\n');
  });

  await t.step('a failure inside a function ends the shell', async () => {
    assertEquals(await out('set -e; f() { false; echo in-f; }; f; echo after'), '');
  });

  await t.step('the exemption reaches into a function the exempt command calls', async () => {
    assertEquals(await out('set -e; f() { false; echo in-f; }; if f; then :; fi; echo after'), 'in-f\nafter\n');
    assertEquals(await out('set -e; f() { false; }; f || echo caught; echo after'), 'caught\nafter\n');
  });

  await t.step('where a function was defined does not exempt it', async () => {
    // Only the call site decides: defining f inside an `if` clause used to leave
    // it exempt for ever after, because the body inherits the definition context
    assertEquals(await out('set -e; if f() { false; echo in-f; }; then :; fi; f; echo after'), '');
  });

  await t.step('a subshell ends the shell it failed in, and the one around it', async () => {
    assertEquals(await out('set -e; ( false ); echo after'), '');
    assertEquals(await out('set -e; if ( false; echo in-sub ); then :; fi; echo after'), 'in-sub\nafter\n');
  });

  await t.step('a pipeline is judged by its own status, not by a stage', async () => {
    assertEquals(await out('set -e; false | true; echo after'), 'after\n');
    assertEquals(await out('set -e; echo a | false; echo after'), '');
    assertEquals(await out('set -eo pipefail; false | true; echo after'), '');
  });

  await t.step('a loop body, a group and a case body are not exempt', async () => {
    assertEquals(await out('set -e; for i in 1 2; do false; echo body; done; echo after'), '');
    assertEquals(await out('set -e; { false; echo in-group; }; echo after'), '');
    assertEquals(await out('set -e; case x in x) false;; esac; echo after'), '');
  });

  await t.step('[ ], [[ ]] and (( )) end the shell too', async () => {
    assertEquals(await out('set -e; [ 1 -eq 2 ]; echo after'), '');
    assertEquals(await out('set -e; [[ 1 -eq 2 ]]; echo after'), '');
    assertEquals(await out('set -e; (( 0 )); echo after'), '');
  });

  await t.step('a command substitution runs to the end', async () => {
    assertEquals(await out('set -e; x=$(false; echo hi); echo "x=$x after"'), 'x=hi after\n');
  });

  await t.step('a failing assignment ends the shell', async () => {
    assertEquals(await out('set -e; f() { return 1; }; x=$(f) ; echo after'), '');
  });
});

Deno.test('nounset', async (t) => {
  await t.step('an unset parameter is an error, with status 127', async () => {
    const result = await new TestShell().runAndCapture('set -u; echo "$NOPE"; echo after');
    assertEquals(result.stdout, '');
    assertEquals(result.stderr, 'NOPE: unbound variable\n');
    assertEquals(result.exitCode, 127);
  });

  await t.step('so is ${#x} and an unset positional', async () => {
    assertEquals((await new TestShell().runAndCapture('set -u; echo "${#NOPE}"')).exitCode, 127);
    assertEquals((await new TestShell().runAndCapture('set -u; echo "${1}"')).exitCode, 127);
  });

  await t.step('the operators that ask about unset are not errors', async () => {
    assertEquals(await out('set -u; echo "${NOPE:-d}${NOPE-d}[${NOPE+s}][${NOPE:+s}]"; echo after'), 'dd[][]\nafter\n');
  });

  await t.step('$@, $* and an unset array are not errors', async () => {
    assertEquals(await out('set -u; echo "[$@][${arr[@]}]"; echo after'), '[][]\nafter\n');
  });

  await t.step('the special parameters are always set', async () => {
    assertEquals(await out('set -u; echo "[$#][$?]"; echo after'), '[0][0]\nafter\n');
  });

  await t.step('a set parameter expands as usual', async () => {
    assertEquals(await out('set -u; V=1; echo "$V"; echo after'), '1\nafter\n');
  });

  await t.step('it ends the substitution it happened in, not the shell', async () => {
    const result = await new TestShell().runAndCapture('set -u; x=$(echo "$NOPE"); echo "after"');
    assertEquals(result.stdout, 'after\n');
    assertEquals(result.stderr, 'NOPE: unbound variable\n');
    assertEquals(result.exitCode, 0);
  });

  await t.step('under errexit the shell leaves with 1 rather than 127', async () => {
    assertEquals((await new TestShell().runAndCapture('set -eu; echo "${NOPE}"; echo after')).exitCode, 1);
  });
});

Deno.test('the ${x:?message} family', async (t) => {
  await t.step('an unset parameter complains with the message', async () => {
    const result = await new TestShell().runAndCapture('echo "${NOPE:?must be set}"; echo after');
    assertEquals(result.stderr, 'NOPE: must be set\n');
    assertEquals(result.exitCode, 127);
  });

  await t.step('an empty one complains for :? but not for ?', async () => {
    assertEquals((await new TestShell().runAndCapture('Q=; echo "${Q:?was empty}"')).exitCode, 127);
    assertEquals((await new TestShell().runAndCapture('Q=; echo "${Q?only if unset}"')).exitCode, 0);
  });

  await t.step('a set parameter expands and says nothing', async () => {
    assertEquals(await out('Q=x; echo "${Q:?unused}"'), 'x\n');
  });

  await t.step('a message with blanks in it survives', async () => {
    // The word used to be parsed as a command line and only its first word kept,
    // so `${x:-a b}` came back as "a"
    assertEquals(await out('echo "[${NOPE:-a b}][${NOPE:-}][${NOPE:-a  b}]"'), '[a b][][a  b]\n');
  });
});

Deno.test('xtrace', async (t) => {
  const traceOf = async (script: string): Promise<string> => (await new TestShell().runAndCapture(script)).stderr;

  await t.step('the command is traced after expansion', async () => {
    assertEquals(await traceOf('set -x; V=hi; echo "$V"'), '+ V=hi\n+ echo hi\n');
  });

  await t.step('a word that needs quoting gets it', async () => {
    assertEquals(await traceOf('set -x; echo "a b" ""'), "+ echo 'a b' ''\n");
  });

  await t.step('prefix assignments come first, one per line', async () => {
    assertEquals(await traceOf('set -x; x=1 y=2 echo hi'), '+ x=1\n+ y=2\n+ echo hi\n');
  });

  await t.step('a function call is traced, and so is its body', async () => {
    assertEquals(await traceOf('set -x; f() { echo in; }; f a b'), '+ f a b\n+ echo in\n');
  });

  await t.step('a for loop traces its list once per iteration', async () => {
    assertEquals(await traceOf('set -x; for i in 1 2; do echo "$i"; done'), '+ for i in 1 2\n+ echo 1\n+ for i in 1 2\n+ echo 2\n');
  });

  await t.step('PS4 is the prefix', async () => {
    assertEquals(await traceOf('PS4="# "; set -x; echo hi'), '# echo hi\n');
  });

  await t.step('+x stops it, and the stopping command is the last traced', async () => {
    assertEquals(await traceOf('set -x; set +x; echo done'), '+ set +x\n');
  });
});

Deno.test('noglob, allexport, noclobber, noexec, verbose', async (t) => {
  await t.step('noglob leaves a pattern as a word', async () => {
    const shell = new TestShell();
    shell.setFile('/dir/a.txt', '');

    assertEquals((await shell.runAndCapture('set -f; echo /dir/*.txt')).stdout, '/dir/*.txt\n');
  });

  await t.step('allexport puts a plain assignment in the environment', async () => {
    const result = await new TestShell().runAndCapture('set -a; V=1');

    assertEquals(result.env.V, '1');
    assertEquals(result.params.V, undefined);
  });

  await t.step('without it the assignment is not exported', async () => {
    const result = await new TestShell().runAndCapture('V=1');

    assertEquals(result.env.V, undefined);
    assertEquals(result.params.V, '1');
  });

  await t.step('noclobber refuses to truncate a file that is there', async () => {
    const shell = new TestShell();
    shell.setFile('/existing', 'keep');

    const result = await shell.runAndCapture('set -C; echo hi > /existing; echo after');

    assertEquals(result.stderr, '/existing: cannot overwrite existing file\n');
    assertEquals(result.stdout, 'after\n');
    assertEquals(shell.getFile('/existing'), 'keep');
  });

  await t.step('a file that is not there is written as usual', async () => {
    const shell = new TestShell();

    await shell.runAndCapture('set -C; echo hi > /fresh');

    assertEquals(shell.getFile('/fresh'), 'hi\n');
  });

  await t.step('a redirected group is refused the same way', async () => {
    const shell = new TestShell();
    shell.setFile('/existing', 'keep');

    const result = await shell.runAndCapture('set -C; { echo hi; } > /existing; echo after');

    assertEquals(result.stderr, '/existing: cannot overwrite existing file\n');
    assertEquals(result.stdout, 'after\n');
    assertEquals(shell.getFile('/existing'), 'keep');
  });

  await t.step('>| overrides it', async () => {
    const shell = new TestShell();
    shell.setFile('/existing', 'keep');

    const result = await shell.runAndCapture('set -C; echo hi >| /existing; echo after');

    assertEquals(result.stderr, '');
    assertEquals(shell.getFile('/existing'), 'hi\n');
  });

  await t.step('noexec reads the rest without running it', async () => {
    assertEquals(await out('echo one; set -n; echo two; echo three'), 'one\n');
  });

  await t.step('verbose echoes each command before it runs', async () => {
    const result = await new TestShell().runAndCapture('set -v; echo one; echo two');

    assertEquals(result.stdout, 'one\ntwo\n');
    assertEquals(result.stderr, 'echo one\necho two\n');
  });

  await t.step('verbose keeps going after an eval, and echoes what it ran', async () => {
    const result = await new TestShell().runAndCapture('set -v; echo one; eval "echo two"; echo three');

    assertEquals(result.stderr, 'echo one\neval "echo two"\necho two\necho three\n');
  });
});

// Found running bash's own test suite: each case is what bash does
Deno.test('set -e and $? as bash has them', async (t) => {
  const run = async (script: string) => {
    const result = await new TestShell().runAndCapture(script);
    return `${result.stdout}st ${result.exitCode}\n`;
  };

  await t.step("$? is 0 at first, and the right side of && or || sees the left's", async () => {
    assertEquals(await run('echo "$?"; (exit 3) || echo "or $?"'), '0\nor 3\nst 0\n');
  });

  await t.step('$- lists the options that are on', async () => {
    assertEquals(await run('set -eu; echo $-'), 'ehuB\nst 0\n');
  });

  await t.step('$( ) does not inherit set -e, but may set it', async () => {
    // The bare assignment takes the substitution's status, 1, and set -e ends the shell there
    assertEquals(await run('set -e; y=$(false; echo ok); echo "$y"; x=$(set -e; false; echo bad); echo "not reached"'), 'ok\nst 1\n');
  });

  await t.step('in POSIX mode $( ) inherits set -e', async () => {
    assertEquals(await run('set -o posix; set -e; z=$(false; echo foo); echo "[$z]"'), 'st 1\n');
  });

  await t.step('a pipeline stage is a subshell set -e ends', async () => {
    assertEquals(await run('set -e; { false; echo A; } | cat; echo B'), 'B\nst 0\n');
  });

  await t.step('nothing in a ! pipeline is subject to set -e', async () => {
    assertEquals(await run('set -e; ! { false; echo A $?; } | cat; echo "B $?"'), 'A 1\nB 1\nst 0\n');
  });
});

Deno.test('set -x shows what bash shows', async (t) => {
  // Each expected trace is bash 5.2's for the same script
  await t.step('PS4 expanded, and once more of its first character in a $( )', async () => {
    const result = await new TestShell().runAndCapture('PS4="+[\\${FUNCNAME[0]:-main}] "; set -x; f() { echo a; }; f; x=$(echo b)');

    assertEquals(result.stderr, '+[main] f\n+[f] echo a\n++[main] echo b\n+[main] x=b\n');
  });

  await t.step('(( )), each part of for (( )), case, and each [[ ]] term reached', async () => {
    const result = await new TestShell().runAndCapture(
      'x=5; y="a b"; set -x; (( x + $x )); for (( i = $x; i < 6; i++ )); do :; done; case "$y" in *) ;; esac; [[ $x -eq 5 && -n $y ]]; [[ ! -z $y || $x == 4* ]]',
    );

    assertEquals(
      result.stderr,
      [
        '((  x + 5  ))',
        '(( i = 5 ))',
        '(( i < 6 ))',
        ':',
        '(( i++  ))',
        '(( i < 6 ))',
        'case "$y" in',
        '[[ 5 -eq 5 ]]',
        '[[ -n a b ]]',
        '[[ ! -z a b ]]',
      ].map((line) => `+ ${line}\n`).join(''),
    );
  });
});

Deno.test('$LINENO in a trap is the line that set it off', async () => {
  const result = await new TestShell().runAndCapture('trap \'echo "err $LINENO"\' ERR\necho one\nfalse\ng() { false; }\n\ng');

  assertEquals(result.stdout, 'one\nerr 3\nerr 6\n');
});
