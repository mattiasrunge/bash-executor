import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script
const run = async (script: string) => await new TestShell().runAndCapture(script);

Deno.test('an unset parameter ends a subshell with 1', async (t) => {
  await t.step('a subshell, a $( ) and a compound pipeline stage leave 1', async () => {
    const result = await run(
      '(echo ${y?}) 2>/dev/null; echo "sub=$?"; x=$(echo ${y?} 2>/dev/null); echo "cs=$?"; { set -u; echo $y; } 2>/dev/null | cat; echo "p=${PIPESTATUS[*]}"',
    );

    assertEquals(result.stdout, 'sub=1\ncs=1\np=1 0\n');
    assertEquals(result.stderr, 'y: parameter not set\n');
  });

  await t.step('set -u holds for an operator on the value', async () => {
    const result = await run(`set -u; for w in '\${foo#?}' '\${foo/x/y}' '\${foo^^}' '\${foo@Q}'; do (eval "echo $w") 2>&1; done`);

    assertEquals(result.stdout, 'foo: unbound variable\n'.repeat(4));
  });

  await t.step('an unbraced special parameter is named as written', async () => {
    const result = await run('set -u; echo $1');

    assertEquals(result.stderr, '$1: unbound variable\n');
    assertEquals(result.exitCode, 1);
  });

  await t.step('${!*} with no positional parameters is unset, not invalid', async () => {
    const result = await run('x=${!*}; echo "[$x][${!*-d}]"');

    assertEquals(result.stdout, '[][d]\n');
  });
});

Deno.test('a word with an empty "$@" in it', async (t) => {
  await t.step('goes when nothing else in it is quoted', async () => {
    const result = await run('n() { echo -n "$# "; }; n ""$@; n "$(true)$@"; n $xxx"$@"; n "$xxx""$@"; n ${foo-"$@"}; n ${foo-""$@}; n "$@"""; echo');

    assertEquals(result.stdout, '1 0 0 1 0 1 1 \n');
  });

  await t.step('"$@" in the word of ${x+word} keeps its fields', async () => {
    const result = await run(`set -- "a b" c; printf '<%s>' "\${1+ $@ }" "x\${u-$@}y"; echo`);

    assertEquals(result.stdout, '< a b><c ><xa b><cy>\n');
  });
});

Deno.test('the word of ${x-word} and its kin', async (t) => {
  await t.step('${c=$*} assigns $* joined as an assignment joins it', async () => {
    const result = await run('set -- 1 2; IFS=; echo "[${c=$*}][$c]"');

    assertEquals(result.stdout, '[12][12]\n');
  });

  await t.step('its unquoted text is split by IFS, as what an expansion gives is', async () => {
    const result = await run(`IFS=; X=X; printf '<%s>' \${X+ $X }; echo; IFS=' '; x=x; printf '<%s>' \${x:+ ""} y; echo`);

    assertEquals(result.stdout, '< X >\n<><y>\n');
  });

  await t.step('a tilde prefix is expanded', async () => {
    const shell = new TestShell();

    Object.assign(shell, { resolveHomeUser: (_ctx: unknown, user: string | null) => Promise.resolve(user ? `/home/${user}` : '/home/u') });

    const result = await shell.runAndCapture(`printf '<%s>' \${u-~} \${u-~/x}; echo`);

    assertEquals(result.stdout, '</home/u></home/u/x>\n');
  });
});

Deno.test('fields and quoted nulls', async (t) => {
  await t.step('an empty pair of quotes beside a split is an empty field', async () => {
    const result = await run(`sp=" "; printf '<%s>' \${sp}"" x; echo`);

    assertEquals(result.stdout, '<><x>\n');
  });

  await t.step('( "" ) is one empty element', async () => {
    const result = await run('A=( "" ); echo ${#A[@]}');

    assertEquals(result.stdout, '1\n');
  });

  await t.step('${f[@]:0:1} of a plain variable is a substring', async () => {
    const result = await run(`f=abcd; printf '<%s>' \${f[@]:0:1} \${f[@]:1:2}; echo`);

    assertEquals(result.stdout, '<a><bc>\n');
  });
});
