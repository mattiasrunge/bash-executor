import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script
const run = async (script: string) => await new TestShell().runAndCapture(script);

Deno.test("bash's own variables", async (t) => {
  await t.step('SHELLOPTS lists the set -o options on, and is readonly', async () => {
    const result = await run('echo $SHELLOPTS; set -o noglob; echo $SHELLOPTS; SHELLOPTS=x');

    assertEquals(result.stdout, 'braceexpand:hashall:interactive-comments\nbraceexpand:hashall:interactive-comments:noglob\n');
    assertEquals(result.stderr, 'SHELLOPTS: readonly variable\n');
  });

  await t.step('BASH_SUBSHELL counts subshells; a simple command in a pipeline is none', async () => {
    const result = await run('echo $BASH_SUBSHELL $(echo $BASH_SUBSHELL); (echo $BASH_SUBSHELL); { echo $BASH_SUBSHELL; } | cat; echo $BASH_SUBSHELL | cat');

    assertEquals(result.stdout, '0 1\n1\n1\n0\n');
  });
});

Deno.test('functions and their variables', async (t) => {
  await t.step('local - keeps set options to the function', async () => {
    const result = await run('f() { local -; set -f; echo "in $-"; }; f; echo "out $-"');

    assertEquals(result.stdout, 'in fhB\nout hB\n');
  });

  await t.step('no local stands in for a readonly variable', async () => {
    const result = await run('readonly q=1; f() { local q=2; echo "in=$q"; }; f');

    assertEquals(result.stdout, 'in=1\n');
    assertEquals(result.stderr, 'local: q: readonly variable\n');
  });

  await t.step("unset of a caller's local removes it, and what it hid shows", async () => {
    const result = await run('inner() { unset res; res=X; }; outer() { local res=L; inner; echo "outer[$res]"; }; outer; echo "main[$res]"');

    assertEquals(result.stdout, 'outer[X]\nmain[X]\n');
  });

  await t.step('an exit in a function runs the EXIT trap there', async () => {
    const result = await run('trap "echo trap:\\$FUNCNAME" EXIT; f() { exit 3; }; f');

    assertEquals(result.stdout, 'trap:f\n');
    assertEquals(result.exitCode, 3);
  });

  await t.step("a subshell's trap lists the shell's traps", async () => {
    const result = await run('trap "echo t" USR1; (trap)');

    assertEquals(result.stdout, "trap -- 'echo t' SIGUSR1\n");
  });
});

Deno.test('parameter expansion', async (t) => {
  await t.step('${#:-x} is $# with a default', async () => {
    const result = await run('set -- a b; echo "${#:-x} ${#%2}|"');

    assertEquals(result.stdout, '2 |\n');
  });

  await t.step('a negative length on a list is an error that ends the line', async () => {
    const result = await run('set a b c; echo ${@:1:-1}\necho next');

    assertEquals(result.stdout, 'next\n');
    assertEquals(result.stderr, '-1: substring expression < 0\n');
  });

  await t.step('nocasematch makes ${x//pat/rep} ignore case', async () => {
    const result = await run('s=abcd; shopt -s nocasematch; echo ${s//[bC]/x}');

    assertEquals(result.stdout, 'axxd\n');
  });

  await t.step('a transformation of an unset variable is nothing', async () => {
    const result = await run(`printf "<%s>" "\${u@Q}" "\${u@A}"; echo`);

    assertEquals(result.stdout, '<><>\n');
  });

  await t.step('$(< file) is the file', async () => {
    const shell = new TestShell();

    shell.setFile('/tmp/f.txt', 'line1\nline2\n');

    const result = await shell.runAndCapture('x=$(< /tmp/f.txt); echo "[$x]"');

    assertEquals(result.stdout, '[line1\nline2]\n');
  });
});
