import { assertEquals } from '@std/assert';
import { TestShell } from '../lib/test-shell.ts';

const loop = `while getopts ab:c opt; do echo "$opt\${OPTARG+=$OPTARG}"; done; echo "OPTIND=$OPTIND"`;

Deno.test('getopts builtin', async (t) => {
  await t.step('takes options one at a time, grouped or not', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`set -- -ac -b val -bval2 rest; ${loop}; shift $((OPTIND - 1)); echo "$@"`);

    assertEquals(result.stdout, 'a\nc\nb=val\nb=val2\nOPTIND=5\nrest\n');
  });

  await t.step('stops at -- and at the first word that is not an option', async () => {
    const shell = new TestShell();

    assertEquals((await shell.runAndCapture(`set -- -a -- -c; ${loop}`)).stdout, 'a\nOPTIND=3\n');
    assertEquals((await shell.runAndCapture(`OPTIND=1; set -- -a x -c; ${loop}`)).stdout, 'a\nOPTIND=2\n');
  });

  await t.step('complains about an unknown option and a missing argument', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`set -- -x -b; ${loop}`);

    assertEquals(result.stdout, '?\n?\nOPTIND=3\n');
    assertEquals(result.stderr.split('\n').filter(Boolean).map((line) => line.replace(/^.*: (illegal|option)/, '$1')), [
      'illegal option -- x',
      'option requires an argument -- b',
    ]);
  });

  await t.step('with a leading colon it is silent and says which option in OPTARG', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`set -- -x -b; while getopts :ab: opt; do echo "$opt $OPTARG"; done`);

    assertEquals(result.stdout, '? x\n: b\n');
    assertEquals(result.stderr, '');
  });

  await t.step('parses the words after the name instead of the positional parameters', async () => {
    const shell = new TestShell();

    assertEquals((await shell.runAndCapture(`while getopts b: opt -b one; do echo "$OPTARG"; done`)).stdout, 'one\n');
  });

  await t.step('assigning OPTIND starts over, and a local OPTIND gives the caller its place back', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      inner() { local OPTIND=1 o; while getopts xy o "$@"; do echo "inner $o"; done; }
      set -- -abc
      while getopts abc opt; do echo "$opt"; [ $opt = b ] && inner -xy; done
    `);

    assertEquals(result.stdout, 'a\nb\ninner x\ninner y\nc\n');
  });

  await t.step('needs an option string and a name', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('getopts ab');

    assertEquals(result.exitCode, 2);
    assertEquals(result.stderr, 'getopts: usage: getopts optstring name [arg ...]\n');
  });
});
