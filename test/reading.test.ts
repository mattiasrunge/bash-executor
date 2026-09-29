import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script, bar the `bash: line N: ` before each message
const run = async (script: string) => await new TestShell().runAndCapture(script);

Deno.test('a script is read a command at a time', async (t) => {
  await t.step('an alias applies from the next line, not to the rest of its own', async () => {
    const result = await run([
      'shopt -s expand_aliases',
      "alias foo='echo foo-alias'",
      'foo',
      "alias bar='echo bar'; bar",
      'bar',
      'f() { foo; }',
      'f',
    ].join('\n'));

    assertEquals(result.stdout, 'foo-alias\nbar\nfoo-alias\n');
    assertEquals(result.stderr, 'bar: command not found\n');
  });

  await t.step('an alias expands in a command substitution, and only where a command name stands', async () => {
    const result = await run([
      'shopt -s expand_aliases',
      "alias m='echo more'",
      'x=$(m); echo "[$x]"',
      'alias m',
      "alias e='echo '",
      'e m',
    ].join('\n'));

    assertEquals(result.stdout, "[more]\nalias m='echo more'\necho more\n");
  });

  await t.step('after a here-document, the lines after its body are read again', async () => {
    const result = await run(['shopt -s expand_aliases', "alias hi='echo hi'", 'cat <<EOF', 'body', 'EOF', 'hi', 'echo $LINENO'].join('\n'));

    assertEquals(result.stdout, 'body\nhi\n7\n');
  });

  await t.step('set -o posix changes how the lines after it read', async () => {
    // In POSIX mode a ' in a double-quoted ${x+…} is a character: the first } ends it
    const result = await run(['x=1; echo "${x+\'y}\'}"', 'set -o posix', 'echo "${x+\'y}"'].join('\n'));

    assertEquals(result.stdout, "'y}'\n'y\n");
  });

  await t.step('the complete commands before a syntax error run, and may change what follows', async () => {
    const shell = new TestShell();

    shell.setFile('/s.sh', ['echo a', 'set -o posix', 'x=1; echo "${x+\'}"', 'echo "${x:-"a}"'].join('\n'));

    const result = await shell.runAndCapture('source /s.sh; echo "after $?"');

    assertEquals(result.stdout, "a\n'\nafter 2\n");
    assertEquals(result.stderr, "/s.sh: unexpected EOF while looking for matching `}'\n");
  });
});

Deno.test('a word inside double-quoted ${x+word} is double-quoted text', async () => {
  const result = await run([
    'x=1',
    'echo "${x+\'y}\'}" "${x:+\'a b\'}" "${u-\'n\'}" "${u:=\'q\'}" "$u"',
    'echo "${x+a\\b\\}\\$\\"}" "${v-a"b c"d}" ${x+\'y z\'}',
    'echo "${x+b\\',
    'ar}" "b\\',
    'ar"',
  ].join('\n'));

  assertEquals(result.stdout, "'y}' 'a b' 'n' 'q' 'q'\na\\b}$\" ab cd y z\nbar bar\n");
});

Deno.test("a $( left open in a here-document is the substitution's error, and the command does not run", async () => {
  const result = await run(['read foo <<EOF', '$(seq 10', 'EOF', 'echo "$? [$foo]"'].join('\n'));

  assertEquals(result.stdout, '1 []\n');
  assertEquals(result.stderr, "unexpected EOF while looking for matching `)'\n");
});
