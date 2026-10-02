import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script, run from a file
const run = async (script: string) => await new TestShell().runAndCapture(script, { history: true });

Deno.test('history keeps the lines the shell reads', async (t) => {
  await t.step('a command over several lines is one entry under cmdhist', async () => {
    const result = await run('set -o history\necho a\nfor x in 1 2\ndo\n  echo $x\ndone\nhistory\n');

    assertEquals(result.stdout, 'a\n1\n2\n    1  echo a\n    2  for x in 1 2; do   echo $x; done\n    3  history\n');
  });

  await t.step('HISTCONTROL and HISTIGNORE leave lines out', async () => {
    const result = await run('set -o history\nHISTCONTROL=ignoreboth HISTIGNORE="ls*"\necho a\necho a\n echo hidden\nls >/dev/null\nhistory\n');

    assertEquals(result.stdout, 'a\na\nhidden\n    1  HISTCONTROL=ignoreboth HISTIGNORE="ls*"\n    2  echo a\n    3  history\n');
  });

  await t.step('nothing is kept without set -o history, nor from a -c string', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo a\nhistory\n', { history: true });
    const command = await shell.runAndCapture('set -o history; echo b; history', { command: true });

    assertEquals(result.stdout, 'a\n');
    assertEquals(command.stdout, 'b\n');
  });
});

Deno.test('history expansion under set -H', async (t) => {
  await t.step('events, words and quick substitution, each expansion said on stderr', async () => {
    const result = await run('set -o history; set -H\necho one two three\necho !$ !:1\necho !?two?:0 !-2:2-\n^one^1\nhistory\n');

    assertEquals(result.stdout, 'one two three\nthree one\necho two\n    1  echo one two three\n    2  echo three one\n    3  echo echo two\n    4  history\n');
    assertEquals(result.stderr, 'echo three one\necho echo two\n:s^one^1: substitution failed\n');
  });

  await t.step('quotes, $! and ${!name} are left alone', async () => {
    const result = await run(`set -o history; set -H\nv=x; r=v\necho '!!' "\${!r}" \\!\n`);

    assertEquals(result.stdout, '!! x !\n');
    assertEquals(result.stderr, '');
  });
});

Deno.test('the history and fc builtins', async (t) => {
  await t.step('fc -s replaces and reruns, history -d deletes, history -s adds in its own place', async () => {
    const result = await run('set -o history\necho aa ab\nfc -s a=x\nfc -l\nhistory -d 2\nhistory -s added\nhistory\nfc -nl -2 -1\n');

    assertEquals(
      result.stdout,
      'aa ab\nxx xb\n1\t echo aa ab\n2\t echo xx xb\n    1  echo aa ab\n    2  fc -l\n    3  history -d 2\n    4  added\n    5  history\n\t added\n\t history\n',
    );
    assertEquals(result.stderr, 'echo xx xb\n');
  });

  await t.step('history -w writes the list and -r adds it after what is there', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('set -o history\necho a\nhistory -w /tmp/h\nhistory -c\nhistory -r /tmp/h\nhistory\n', { history: true });

    assertEquals(shell.getFile('/tmp/h'), 'echo a\nhistory -w /tmp/h\n');
    assertEquals(result.stdout, 'a\n    1  history -r /tmp/h\n    2  echo a\n    3  history -w /tmp/h\n    4  history\n');
  });

  await t.step('HISTSIZE keeps the last entries, numbered on', async () => {
    const result = await run('set -o history\nHISTSIZE=2\necho a\necho b\nhistory\n');

    assertEquals(result.stdout, 'a\nb\n    3  echo b\n    4  history\n');
  });
});

Deno.test('what a prompt reads before it runs', async (t) => {
  await t.step('an open case, quote or here-document is unfinished', async () => {
    const shell = new TestShell();

    assertEquals(await shell.isUnfinished('case p in\n'), true);
    assertEquals(await shell.isUnfinished('echo "a\n'), true);
    assertEquals(await shell.isUnfinished('cat <<!\none\n'), true);
    assertEquals(await shell.isUnfinished('cat <<!\none\n!\n'), false);
    assertEquals(await shell.isUnfinished('echo a; fi\n'), false);
  });

  await t.step('an aliased command is on the line its alias was', async () => {
    const result = await run('shopt -s expand_aliases\nalias l="echo \\$LINENO"\n\nl\n');

    assertEquals(result.stdout, '4\n');
  });
});

Deno.test('an interactive shell reads its history file as it starts and writes it as it ends', async (t) => {
  await t.step('HISTFILE is ~/.bash_history, the file cut to HISTFILESIZE first', async () => {
    const shell = new TestShell();

    shell.setFile('/home/u/.bash_history', 'one\ntwo\nthree\n');
    await shell.runAndCapture('HOME=/home/u HISTSIZE=2');
    await shell.startHistory();

    assertEquals(shell.getFile('/home/u/.bash_history'), 'two\nthree\n');
    assertEquals((await shell.runAndCapture('history; echo $HISTFILE $HISTFILESIZE')).stdout, '    1  two\n    2  three\n/home/u/.bash_history 2\n');
  });

  await t.step('the list written at the end, or the new lines added under histappend', async () => {
    const shell = new TestShell();

    shell.setFile('/h/.bash_history', 'old\n');
    await shell.runAndCapture('HOME=/h');
    await shell.startHistory();
    await shell.runAndCapture('echo new >/dev/null', { history: true });
    await shell.saveHistory();
    assertEquals(shell.getFile('/h/.bash_history'), 'old\necho new >/dev/null\n');

    // Appended: what is in the file stays, the list cleared or not
    await shell.runAndCapture('shopt -s histappend; history -c');
    await shell.runAndCapture('echo more >/dev/null', { history: true });
    await shell.saveHistory();
    assertEquals(shell.getFile('/h/.bash_history'), 'old\necho new >/dev/null\necho more >/dev/null\n');
  });

  await t.step('a shell that is not interactive writes nothing unasked', async () => {
    const shell = new TestShell();

    await shell.runAndCapture('HOME=/h HISTFILE=/h/.bash_history; set -o history');
    await shell.runAndCapture('echo x >/dev/null', { history: true });
    await shell.saveHistory();
    assertEquals(shell.getFile('/h/.bash_history'), '');
  });

  await t.step("no file of the user's own when the host says so", async () => {
    const shell = new TestShell();

    await shell.runAndCapture('HOME=/h');
    await shell.startHistory(null);
    assertEquals((await shell.runAndCapture('echo "[${HISTFILE-unset}]"')).stdout, '[unset]\n');
  });
});
