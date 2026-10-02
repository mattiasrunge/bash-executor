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

    assertEquals(await shell.completeLine('ls; svc st'), { word: 'st', start: 8, end: 10, matches: ['start', 'stop', 'status'], options: [] });
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
