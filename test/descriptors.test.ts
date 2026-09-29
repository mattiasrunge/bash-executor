import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script, bar the `bash: line N: ` before each message
const run = async (script: string, files: Record<string, string> = {}) => {
  const shell = new TestShell();

  for (const [path, content] of Object.entries(files)) shell.setFile(path, content);

  return { shell, ...(await shell.runAndCapture(script)) };
};

Deno.test('descriptors above 2', async (t) => {
  await t.step('N<file is descriptor N, for the command alone', async () => {
    const result = await run(
      [
        'while read -u 3 l; do echo "got $l"; done 3</in.txt',
        '{ read a <&3; echo "a=$a"; } 3</in.txt',
        'read -u 3 z; echo "after $?"',
      ].join('\n'),
      { '/in.txt': 'one\ntwo\n' },
    );

    assertEquals(result.stdout, 'got one\ngot two\na=one\nafter 1\n');
    assertEquals(result.stderr, 'read: 3: invalid file descriptor: Bad file descriptor\n');
  });

  await t.step('N>file is opened once for the command, and every write goes on from the last', async () => {
    const result = await run('{ echo a >&4; echo b >&4; } 4>/out.txt');

    assertEquals(result.shell.getFile('/out.txt'), 'a\nb\n');
  });

  await t.step("one command's closing leaves the shell's descriptor open", async () => {
    const result = await run('exec 5>/ex.txt; echo one >&5; echo two 5>&-; echo three >&5; exec 5>&-');

    assertEquals(result.stdout, 'two\n');
    assertEquals(result.shell.getFile('/ex.txt'), 'one\nthree\n');
  });

  await t.step('{name}<file picks one from 10 up, puts it in name, and keeps it open', async () => {
    const result = await run(
      [
        'while read -r -u ${fd}; do echo "R $REPLY"; done {fd}</in.txt',
        'echo fd=$fd',
        '{ :; } {g}</in.txt; echo g=$g; read -u $g x; echo x=$x',
        'exec {g}<&-; read -u $g x; echo $?',
        'cat {h}<<<here <&$h',
      ].join('\n'),
      { '/in.txt': 'one\ntwo\n' },
    );

    assertEquals(result.stdout, 'R one\nR two\nfd=10\ng=11\nx=one\n1\nhere\n');
    assertEquals(result.stderr, 'read: 11: invalid file descriptor: Bad file descriptor\n');
  });

  await t.step('a readonly name takes no descriptor, and the command does not run', async () => {
    const result = await run('readonly r; echo ran {r}</in.txt; echo $?', { '/in.txt': '' });

    assertEquals(result.stdout, '1\n');
    assertEquals(result.stderr, 'r: readonly variable\nr: cannot assign fd to variable\n');
  });
});
