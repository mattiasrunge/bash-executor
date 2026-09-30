import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

/** A shell in a tree like the one each expected text came from, bash 5.2's in the C locale — the one a shell with no LANG has. */
const run = async (script: string) => {
  const shell = new TestShell();

  for (const file of ['/w/a/f.c', '/w/a/b/g.c', '/w/a/b/c/h.c', '/w/d/i.txt', '/w/.dot', '/w/top.c', '/w/Top.C', '/w/a*b', '/w/ab', '/w/.hid/x']) {
    shell.setFile(file, '');
  }

  return (await shell.runAndCapture(`cd /w; p() { printf '<%s>' "$@"; echo; }; ${script}`)).stdout;
};

Deno.test('pathname expansion is done as bash does it', async (t) => {
  const cases: Array<[string, string]> = [
    ['p *', '<Top.C><a><a*b><ab><d><top.c>'],
    ['p .*', '<.dot><.hid>'],
    ['p */', '<a/><d/>'],
    ['p */*.c a/*/g.c', '<a/f.c><a/b/g.c>'],
    ['p a/nope/* */i.txt', '<a/nope/*><d/i.txt>'],
    // What the word quoted matches itself; what an unquoted expansion gives is a pattern
    ['p "a*"* a"*"b', '<a*b><a*b>'],
    ['x=\'t*\'; p $x "$x"', '<top.c><t*>'],
    ['d=\'a\'; p "$d"/*', '<a/b><a/f.c>'],
    ['shopt -s nocaseglob; p t*', '<Top.C><top.c>'],
    ['shopt -s dotglob; p *', '<.dot><.hid><Top.C><a><a*b><ab><d><top.c>'],
    ['shopt -s globstar; p **/*.c', '<a/b/c/h.c><a/b/g.c><a/f.c><top.c>'],
    ['shopt -s globstar; p a/**', '<a/><a/b><a/b/c><a/b/c/h.c><a/b/g.c><a/f.c>'],
    // bash's own quirks: a run of ** is one, and a/ loses its slash after one
    ['shopt -s globstar; p a/**/**', '<a><a/b><a/b/c><a/b/c/h.c><a/b/g.c><a/f.c>'],
    ['shopt -s globstar; p **/b/**', '<a/b><a/b/c><a/b/c/h.c><a/b/g.c>'],
    ['p !(*.c)', '<Top.C><a><a*b><ab><d>'],
    ["GLOBIGNORE='*.c:d'; p *", '<.dot><.hid><Top.C><a><a*b><ab>'],
    ['shopt -s nullglob; p nothere* x', '<x>'],
    ['set -f; p *', '<*>'],
  ];

  for (const [script, expected] of cases) {
    await t.step(script, async () => {
      assertEquals(await run(`shopt -s extglob\n${script}`), `${expected}\n`);
    });
  }
});
