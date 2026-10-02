import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

// Each expected text is bash 5.2's for the same script; the COMP_* values were
// read from an interactive bash given the same line and a Tab
const run = async (script: string) => await new TestShell().runAndCapture(script);

/** A completion function that answers with what it was shown. */
const SHOW =
  `_show() { COMPREPLY=("1=$1 2=$2 3=$3 cw=$COMP_CWORD words=\${COMP_WORDS[*]} n=\${#COMP_WORDS[@]} line=[$COMP_LINE] point=$COMP_POINT"); }; complete -F _show cmd`;

Deno.test('complete defines, lists and removes specifications', async (t) => {
  await t.step('one specification for several names, compopt changing it for all of them', async () => {
    const result = await run(`complete -o nospace -W "a b" -P p c1 c2; complete -p; compopt -o filenames c1; compopt c2; complete -D -F f; complete -p -D; compopt -D`);

    assertEquals(
      result.stdout,
      "complete -o nospace -W 'a b' -P 'p' c1\ncomplete -o nospace -W 'a b' -P 'p' c2\n" +
        'compopt +o bashdefault +o default +o dirnames -o filenames +o noquote +o nosort -o nospace +o plusdirs c2\n' +
        'complete -F f -D\ncompopt +o bashdefault +o default +o dirnames +o filenames +o noquote +o nosort +o nospace +o plusdirs -D\n',
    );
  });

  await t.step('-r of a name with none is an error', async () => {
    const result = await run('complete -W x a; complete -r a nothere; echo rc=$?; complete -p');

    assertEquals(result.stdout, 'rc=1\n');
    assertEquals(result.stderr, 'complete: nothere: no completion specification\n');
  });
});

Deno.test('compgen generates as a specification would', async (t) => {
  await t.step('-W is expanded and split, then matched', async () => {
    const result = await run('v=x; compgen -W "$(echo aa ab) \\"$v y\\" b|c" -- a');

    assertEquals(result.stdout, 'aa\nab\n');
  });

  await t.step('-X filters, ! keeps, -P and -S wrap', async () => {
    const result = await run('compgen -W "aa.txt ab.log b.txt" -X "*.log" -P "<" -S ">" -- a; compgen -W "aa ab" -X "!*b" -- ""');

    assertEquals(result.stdout, '<aa.txt>\nab\n');
  });
});

Deno.test('completing a line', async (t) => {
  await t.step('a function is shown the command, the words and the cursor', async () => {
    const shell = new TestShell();

    await shell.runAndCapture(SHOW);

    assertEquals((await shell.completeLine('echo x;  cmd a --fl=va'))?.matches, ['1=cmd 2=va 3== cw=4 words=cmd a --fl = va n=5 line=[cmd a --fl=va] point=13']);
    assertEquals((await shell.completeLine('cmd a  b', 6))?.matches, ['1=cmd 2= 3=a cw=2 words=cmd a b n=3 line=[cmd a  b] point=6']);
    assertEquals((await shell.completeLine('cmd a "b c'))?.matches, ['1=cmd 2=b c 3=a cw=2 words=cmd a "b c n=3 line=[cmd a "b c] point=10']);
    assertEquals((await shell.completeLine('cmd '))?.matches, ['1=cmd 2= 3=cmd cw=1 words=cmd  n=2 line=[cmd ] point=4']);
  });

  await t.step('the word and where it starts, for the edit', async () => {
    const shell = new TestShell();

    await shell.runAndCapture('complete -W "start stop status" svc');

    assertEquals(await shell.completeLine('ls; svc st'), { word: 'st', start: 8, end: 10, matches: ['start', 'stop', 'status'], options: [], filenames: false });
  });

  await t.step('-D for any command, a path by its basename first', async () => {
    const shell = new TestShell();

    await shell.runAndCapture('complete -W "dflt" -D; complete -W "base" tool');

    assertEquals((await shell.completeLine('/usr/bin/tool '))?.matches, ['base']);
    assertEquals((await shell.completeLine('other '))?.matches, ['dflt']);
  });

  await t.step('nothing applies to a command name without -E or -I, nor without specifications', async () => {
    const shell = new TestShell();

    assertEquals(await shell.completeLine('ls '), undefined);
    await shell.runAndCapture('complete -W x -D');
    assertEquals(await shell.completeLine('l'), undefined);
    await shell.runAndCapture('complete -W "ls lsblk" -I');
    assertEquals((await shell.completeLine('l'))?.matches, ['ls', 'lsblk']);
  });

  await t.step('compopt in the function changes the options of this completion only', async () => {
    const shell = new TestShell();

    await shell.runAndCapture('_f() { compopt -o nospace; COMPREPLY=(x); }; complete -F _f f');

    assertEquals((await shell.completeLine('f '))?.options, ['nospace']);
    assertEquals((await shell.runAndCapture('complete -p f')).stdout, 'complete -F _f f\n');
  });

  await t.step('a function that returns 124 has the specifications looked up again', async () => {
    const shell = new TestShell();

    await shell.runAndCapture('_load() { complete -W "loaded" "$1"; return 124; }; complete -D -F _load');

    assertEquals((await shell.completeLine('git '))?.matches, ['loaded']);
  });

  await t.step('the variables a function saw are gone afterwards', async () => {
    const shell = new TestShell();

    await shell.runAndCapture(SHOW);
    await shell.completeLine('cmd x');

    assertEquals((await shell.runAndCapture('echo "${COMP_WORDS[*]}${COMP_LINE}${COMPREPLY[*]}|"')).stdout, '|\n');
  });
});

/** A shell in /w, among files a Tab completes. */
const filesShell = () => {
  const shell = new TestShell();

  for (const file of ['alpha.txt', 'src/a.ts', 'src/b.ts', 'srv/x', 'my dir/f', 'my file', "it's", 'x=y']) shell.setFile(`/w/${file}`, '');
  shell.setCwd('/w');
  shell.setParams({ HOME: '/w', LANG: 'C' });

  return shell;
};

/** The line and the cursor as a Tab leaves them, the cursor shown as `|`. */
const tab = async (shell: TestShell, line: string, point?: number) => {
  const result = await shell.completeTab(line, point);

  return `${result.line.slice(0, result.point)}|${result.line.slice(result.point)}`;
};

// What each Tab leaves was read from an interactive bash 5.2 given the same files and keys
Deno.test('a Tab, as readline does it', async (t) => {
  await t.step('one file goes in with a space after it, a directory with a slash', async () => {
    const shell = filesShell();

    assertEquals(await tab(shell, 'ls al'), 'ls alpha.txt |');
    assertEquals(await tab(shell, 'ls src'), 'ls src/|');
  });

  await t.step('of several, the prefix they share, and the bell', async () => {
    const result = await filesShell().completeTab('ls s');

    assertEquals(result, { line: 'ls sr', point: 5, bell: true });
  });

  await t.step('a file name is quoted after backslashes, or in the quote it was begun in', async () => {
    const shell = filesShell();

    assertEquals(await tab(shell, 'ls my\\ f'), 'ls my\\ file |');
    assertEquals(await tab(shell, 'ls "my f'), 'ls "my file" |');
    assertEquals(await tab(shell, "ls 'my d"), "ls 'my dir'/|");
    assertEquals(await tab(shell, 'ls x'), 'ls x\\=y |');
    assertEquals(await tab(shell, 'ls it'), "ls it\\'s |");
  });

  await t.step('the Tab that lists shows each file by its last part, a directory with its slash', async () => {
    const shell = filesShell();

    assertEquals(await shell.completeTab('ls s', undefined, true), { line: 'ls s', point: 4, list: ['src/', 'srv/'], widest: 3, bell: false });
    assertEquals((await shell.completeTab('ls src/', undefined, true)).list, ['a.ts', 'b.ts']);
  });

  await t.step('in the middle of the line nothing goes after the match', async () => {
    const shell = filesShell();

    await shell.runAndCapture('complete -W "alpha beta" foo');

    assertEquals(await tab(shell, 'foo al', 5), 'foo alpha|l');
  });

  await t.step('a variable name after $, a slash after one naming a directory', async () => {
    assertEquals(await tab(filesShell(), 'echo "$HOM'), 'echo "$HOME"/|');
  });

  await t.step('a command name where a command goes, a directory where none matches', async () => {
    const shell = filesShell();

    await shell.runAndCapture('pet() { :; }');

    assertEquals(await tab(shell, 'pe'), 'pet |');
    assertEquals(await tab(shell, 'x; ech'), 'x; echo |');
    assertEquals(await tab(shell, 'my'), 'my\\ dir/|');
  });

  await t.step('a glob that names one file is replaced by it', async () => {
    assertEquals(await tab(filesShell(), 'ls *.txt'), 'ls alpha.txt |');
  });

  await t.step('a specification: its words, -o nospace, -o filenames, -o default when it has none', async () => {
    const shell = filesShell();

    await shell.runAndCapture('complete -o nospace -W "alpha beta" ns; complete -o filenames -W "src my\\ dir" fn; complete -o default -W "alpha" df; complete -W "alpha" nd');

    assertEquals(await tab(shell, 'ns a'), 'ns alpha|');
    assertEquals(await tab(shell, 'fn s'), 'fn src/|');
    assertEquals(await tab(shell, 'df m'), 'df my\\ |');
    assertEquals(await shell.completeTab('nd m'), { line: 'nd m', point: 4, bell: true });
  });
});
