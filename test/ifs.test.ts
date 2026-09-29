import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

const run = async (script: string) => {
  const shell = new TestShell();

  return await shell.runAndCapture(script);
};

/** The argument list a command was called with */
const argsOf = async (script: string) => {
  const shell = new TestShell();
  let seen: string[] = [];

  shell.mockCommand('args', async (_ctx, args) => {
    seen = args;
    return { code: 0 };
  });

  await shell.runAndCapture(script);

  return seen;
};

Deno.test('IFS field splitting', async (t) => {
  await t.step('an unquoted expansion splits on whitespace by default', async () => {
    assertEquals(await argsOf('V="a b  c"; args $V'), ['a', 'b', 'c']);
  });

  await t.step('a quoted expansion is one field', async () => {
    assertEquals(await argsOf('V="a b"; args "$V"'), ['a b']);
  });

  await t.step('IFS decides what splits', async () => {
    assertEquals(await argsOf('IFS=:; V="a:b c"; args $V'), ['a', 'b c']);
  });

  await t.step('literal text is never split, whatever IFS says', async () => {
    assertEquals(await argsOf('IFS=:; args a:b'), ['a:b']);
  });

  await t.step('an empty IFS disables splitting', async () => {
    assertEquals(await argsOf('IFS=; V="a b"; args $V'), ['a b']);
  });

  await t.step('adjacent separators that are not whitespace make empty fields', async () => {
    assertEquals(await argsOf('IFS=:; V="a::b"; args $V'), ['a', '', 'b']);
  });

  await t.step('a newline IFS keeps blanks inside the field', async () => {
    const result = await run("IFS=$'\\n'; V=$(printf 'one file\\ntwo file\\n'); for e in $V; do echo \"[$e]\"; done");
    assertEquals(result.stdout, '[one file]\n[two file]\n');
  });

  await t.step('IFS applies to command substitution output', async () => {
    assertEquals(await argsOf('IFS=:; args $(echo "a:b")'), ['a', 'b']);
  });

  await t.step('a value of only separators produces no argument', async () => {
    assertEquals(await argsOf('V="   "; args $V'), []);
  });

  await t.step('IFS is scoped when set as a prefix assignment', async () => {
    const result = await run('IFS=:; V="a:b"; echo "${IFS}x"');
    assertEquals(result.stdout, ':x\n');
  });

  await t.step('$* joins on the first character of IFS', async () => {
    const result = await run('set -- a b; echo "$*"; IFS=:; echo "$*"');
    assertEquals(result.stdout, 'a b\na:b\n');
  });

  await t.step('"$@" keeps one field per parameter', async () => {
    assertEquals(await argsOf('f() { args "$@"; }; f "a b" c'), ['a b', 'c']);
  });

  await t.step('read honours IFS', async () => {
    const result = await run('echo "a:b c" | { IFS=: read x y; echo "[$x][$y]"; }');
    assertEquals(result.stdout, '[a][b c]\n');
  });

  await t.step('IFS= read keeps the whole line', async () => {
    const result = await run('echo "  spaced  " | { IFS= read -r line; echo "[$line]"; }');
    assertEquals(result.stdout, '[  spaced  ]\n');
  });
});

Deno.test('$* and $@ as bash splits and joins them', async (t) => {
  const run = async (script: string) => (await new TestShell().runAndCapture(script)).stdout;

  await t.step('unquoted $* is one field per parameter, whatever IFS holds', async () => {
    assertEquals(await run('set -- a "b c" d; IFS=""; for w in $*; do echo "[$w]"; done; echo "[$*]"'), '[a]\n[b c]\n[d]\n[ab cd]\n');
  });

  await t.step('where no splitting follows, $@ joins with spaces and $* with IFS', async () => {
    assertEquals(await run('set -- a b; IFS=:; x=$@; y=$*; echo "$x|$y"; [[ $@ == "a b" ]] && echo c'), 'a b|a:b\nc\n');
  });

  await t.step('an unquoted empty parameter is no word', async () => {
    assertEquals(await run('set -- a "" b; for w in $@; do echo "[$w]"; done'), '[a]\n[b]\n');
  });
});
