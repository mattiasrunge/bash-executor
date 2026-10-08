import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Command Expansion', async (t) => {
  await t.step('$(command) captures stdout', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "Result: $(echo inner)"');
    assertEquals(result.stdout, 'Result: inner\n');
  });

  await t.step('command substitution with assignment prefix inside', async () => {
    const shell = new TestShell();
    shell.mockCommand('file-stat', async (_ctx, _args) => {
      // Return output similar to what the real command returns
      return { code: 0, stdout: 'result_from_file_stat\n' };
    });
    const result = await shell.runAndCapture(`
      FILENAME="/path/abc"
      STAT_OUTPUT=$(JSON_OUTPUT=1 file-stat "$FILENAME"); echo "$STAT_OUTPUT"
    `);

    assertEquals(result.stdout, 'result_from_file_stat\n');
    assertEquals(result.exitCode, 0);
  });

  await t.step('command substitution larger than the pipe capacity', async () => {
    // A pipe holds 64 KiB and a writer that fills it blocks until someone
    // reads: the substitution is drained while it runs
    const shell = new TestShell();
    const line = 'x'.repeat(99) + '\n';
    const lines = 2000; // 200 000 bytes
    shell.mockCommand('big', async () => ({ code: 0, stdout: line.repeat(lines) }));

    const result = await Promise.race([
      shell.runAndCapture('X=$(big); echo ${#X}'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('substitution deadlocked')), 5000)),
    ]);

    assertEquals(result.stdout, `${line.length * lines - 1}\n`);
  });

  await t.step('command substitution with long JSON output containing equals signs', async () => {
    // Command output that is JSON containing = signs, as exiftool's is
    const shell = new TestShell();
    const jsonOutput = '{"size":3687764,"mtime":1768376602848,"birthtime":1768376602647,"uri":"/home/user/files/file.txt","mode":33204,"uid":1000,"gid":1000}';
    shell.mockCommand('file-stat', async (_ctx, _args) => {
      return { code: 0, stdout: jsonOutput };
    });
    const result = await shell.runAndCapture(`STAT_OUTPUT=$(JSON_OUTPUT=1 file-stat "/path"); echo "$STAT_OUTPUT"`);
    assertEquals(result.exitCode, 0);
  });

  await t.step('nested command expansion', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $(echo $(echo deep))');
    assertEquals(result.stdout, 'deep\n');
  });

  await t.step('command expansion in variable assignment', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=$(echo hello); echo $x');
    assertEquals(result.stdout, 'hello\n');
  });

  await t.step('command expansion strips trailing newlines', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "X$(echo test)X"');
    assertEquals(result.stdout, 'XtestX\n');
  });

  await t.step('command expansion with multiple words', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "Got: $(echo one two three)"');
    assertEquals(result.stdout, 'Got: one two three\n');
  });

  await t.step('command expansion in arithmetic', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $(($(echo 5) + $(echo 3)))');
    assertEquals(result.stdout, '8\n');
  });

  await t.step('a failing command still substitutes what it wrote', async () => {
    const shell = new TestShell();
    shell.mockCommand('partial', async () => ({ code: 1, stdout: 'one\ntwo\n' }));
    const result = await shell.runAndCapture(`echo "[$(partial)]"`);
    assertEquals(result.stdout, '[one\ntwo]\n');
  });

  await t.step('a failing command expansion does not abort the command around it', async () => {
    const shell = new TestShell();
    shell.mockCommand('fails', async () => ({ code: 1 }));
    const result = await shell.runAndCapture(`echo "[$(fails)]"; echo "after=$?"`);
    assertEquals(result.stdout, '[]\nafter=0\n');
  });

  await t.step('a bare assignment takes the status of its command expansion', async () => {
    const shell = new TestShell();
    shell.mockCommand('partial', async () => ({ code: 1, stdout: 'one\n' }));
    const result = await shell.runAndCapture(`x=$(partial); echo "x=$x status=$?"`);
    assertEquals(result.stdout, 'x=one status=1\n');
  });

  await t.step('exit inside a command expansion ends that subshell only', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`echo "[$(echo out; exit 3)]"; echo "alive=$?"`);
    assertEquals(result.stdout, '[out]\nalive=0\n');
  });

  await t.step('a command expansion in the command name runs once', async () => {
    const shell = new TestShell();
    let calls = 0;
    shell.mockCommand('namer', async () => {
      calls++;
      return { code: 0, stdout: 'echo\n' };
    });
    const result = await shell.runAndCapture('$(namer) hello');
    assertEquals(result.stdout, 'hello\n');
    assertEquals(calls, 1);
  });

  await t.step('case matches on a failing command expansion', async () => {
    const shell = new TestShell();
    shell.mockCommand('partial', async () => ({ code: 1, stdout: 'one\n' }));
    const result = await shell.runAndCapture(`
      case $(partial) in
        one) echo "matched" ;;
        *) echo "nomatch" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });
});

Deno.test('Arithmetic Expansion', async (t) => {
  await t.step('simple arithmetic expansion', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((1+2))');
    assertEquals(result.stdout, '3\n');
  });

  await t.step('arithmetic expansion with variables', async () => {
    const shell = new TestShell();
    shell.setParams({ a: '10', b: '20' });
    const result = await shell.runAndCapture('echo $((a + b))');
    assertEquals(result.stdout, '30\n');
  });

  await t.step('arithmetic expansion in string', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "Total: $((2*3))"');
    assertEquals(result.stdout, 'Total: 6\n');
  });

  await t.step('multiple arithmetic expansions', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo $((1+1)) $((2+2)) $((3+3))');
    assertEquals(result.stdout, '2 4 6\n');
  });
});

Deno.test('Parameter Expansion', async (t) => {
  await t.step('simple $VAR expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ FOO: 'bar' });
    const result = await shell.runAndCapture('echo $FOO');
    assertEquals(result.stdout, 'bar\n');
  });

  await t.step('braced ${VAR} expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ FOO: 'bar' });
    const result = await shell.runAndCapture('echo ${FOO}baz');
    assertEquals(result.stdout, 'barbaz\n');
  });

  await t.step('expansion of undefined variable', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "[$UNDEFINED]"');
    assertEquals(result.stdout, '[]\n');
  });

  await t.step('expansion preserves empty string', async () => {
    const shell = new TestShell();
    shell.setParams({ EMPTY: '' });
    const result = await shell.runAndCapture('echo "[$EMPTY]"');
    assertEquals(result.stdout, '[]\n');
  });

  await t.step('multiple expansions in one word', async () => {
    const shell = new TestShell();
    shell.setParams({ A: 'one', B: 'two' });
    const result = await shell.runAndCapture('echo $A$B');
    assertEquals(result.stdout, 'onetwo\n');
  });
});

Deno.test('Parameter Expansion Operations', async (t) => {
  await t.step('${var//pattern/replacement} global replace', async () => {
    const shell = new TestShell();
    shell.setParams({ TEXT: 'hello world' });
    const result = await shell.runAndCapture('echo "${TEXT// /_}"');
    assertEquals(result.stdout, 'hello_world\n');
  });

  await t.step('${var/pattern/replacement} single replace', async () => {
    const shell = new TestShell();
    shell.setParams({ TEXT: 'aabaa' });
    const result = await shell.runAndCapture('echo "${TEXT/a/x}"');
    assertEquals(result.stdout, 'xabaa\n');
  });

  await t.step('${var// /} remove all spaces', async () => {
    const shell = new TestShell();
    shell.setParams({ TEXT: 'a b c' });
    const result = await shell.runAndCapture('echo "${TEXT// /}"');
    assertEquals(result.stdout, 'abc\n');
  });

  await t.step('${var:-default} use default when empty', async () => {
    const shell = new TestShell();
    shell.setParams({ EMPTY: '' });
    const result = await shell.runAndCapture('echo "${EMPTY:-fallback}"');
    assertEquals(result.stdout, 'fallback\n');
  });

  await t.step('${var:-default} use value when set', async () => {
    const shell = new TestShell();
    shell.setParams({ SET: 'original' });
    const result = await shell.runAndCapture('echo "${SET:-fallback}"');
    assertEquals(result.stdout, 'original\n');
  });

  await t.step('${var:-default} use default when unset', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "${UNSET:-fallback}"');
    assertEquals(result.stdout, 'fallback\n');
  });

  await t.step('${#var} string length', async () => {
    const shell = new TestShell();
    shell.setParams({ TEXT: 'hello' });
    const result = await shell.runAndCapture('echo "${#TEXT}"');
    assertEquals(result.stdout, '5\n');
  });

  await t.step('${var:offset:length} substring', async () => {
    const shell = new TestShell();
    shell.setParams({ TEXT: 'hello world' });
    const result = await shell.runAndCapture('echo "${TEXT:6:5}"');
    assertEquals(result.stdout, 'world\n');
  });

  await t.step('${var:offset} substring to end', async () => {
    const shell = new TestShell();
    shell.setParams({ TEXT: 'hello world' });
    const result = await shell.runAndCapture('echo "${TEXT:6}"');
    assertEquals(result.stdout, 'world\n');
  });

  await t.step('nested ${a:-${b}} defaults', async () => {
    const shell = new TestShell();
    shell.setParams({ B: 'from_b' });
    const result = await shell.runAndCapture('echo "${A:-${B}}"');
    assertEquals(result.stdout, 'from_b\n');
  });

  await t.step('${var%pattern} remove shortest suffix', async () => {
    const shell = new TestShell();
    shell.setParams({ FILE: 'test.tar.gz' });
    const result = await shell.runAndCapture('echo "${FILE%.*}"');
    assertEquals(result.stdout, 'test.tar\n');
  });

  await t.step('${var%%pattern} remove longest suffix', async () => {
    const shell = new TestShell();
    shell.setParams({ FILE: 'test.tar.gz' });
    const result = await shell.runAndCapture('echo "${FILE%%.*}"');
    assertEquals(result.stdout, 'test\n');
  });

  await t.step('${var#pattern} remove shortest prefix', async () => {
    const shell = new TestShell();
    shell.setParams({ PATH_VAR: '/home/user/file.txt' });
    const result = await shell.runAndCapture('echo "${PATH_VAR#*/}"');
    assertEquals(result.stdout, 'home/user/file.txt\n');
  });

  await t.step('${var##pattern} remove longest prefix', async () => {
    const shell = new TestShell();
    shell.setParams({ PATH_VAR: '/home/user/file.txt' });
    const result = await shell.runAndCapture('echo "${PATH_VAR##*/}"');
    assertEquals(result.stdout, 'file.txt\n');
  });
});

Deno.test('Mixed Expansions', async (t) => {
  await t.step('parameter and command expansion together', async () => {
    const shell = new TestShell();
    shell.setParams({ PREFIX: 'Hello' });
    const result = await shell.runAndCapture('echo "$PREFIX $(echo World)"');
    assertEquals(result.stdout, 'Hello World\n');
  });

  await t.step('parameter and arithmetic expansion together', async () => {
    const shell = new TestShell();
    shell.setParams({ X: '5' });
    const result = await shell.runAndCapture('echo "X=$X, X*2=$((X*2))"');
    assertEquals(result.stdout, 'X=5, X*2=10\n');
  });

  await t.step('all three expansion types', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'test' });
    const result = await shell.runAndCapture('echo "$VAR $(echo cmd) $((1+1))"');
    assertEquals(result.stdout, 'test cmd 2\n');
  });
});

Deno.test('Expansion in Different Contexts', async (t) => {
  await t.step('expansion in command name', async () => {
    const shell = new TestShell();
    shell.setParams({ CMD: 'echo' });
    const result = await shell.runAndCapture('$CMD hello');
    assertEquals(result.stdout, 'hello\n');
  });

  await t.step('expansion in if condition', async () => {
    const shell = new TestShell();
    shell.setParams({ X: '5' });
    const result = await shell.runAndCapture('if [ $X -gt 3 ]; then echo yes; fi');
    assertEquals(result.stdout, 'yes\n');
  });

  await t.step('expansion in for loop', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
        for i in $(echo a b c); do
          echo "item: $i"
        done
      `);
    assertEquals(result.stdout, 'item: a\nitem: b\nitem: c\n');
  });
});

Deno.test('Quoting and Expansion', async (t) => {
  await t.step('double quotes allow expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'value' });
    const result = await shell.runAndCapture('echo "var=$VAR"');
    assertEquals(result.stdout, 'var=value\n');
  });

  await t.step('single quotes prevent expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'value' });
    const result = await shell.runAndCapture("echo 'var=$VAR'");
    assertEquals(result.stdout, 'var=$VAR\n');
  });

  await t.step('escaped dollar prevents expansion', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'value' });
    const result = await shell.runAndCapture('echo "var=\\$VAR"');
    assertEquals(result.stdout, 'var=$VAR\n');
  });
});

// Each case is what bash does
Deno.test('Expansions as bash has them', async (t) => {
  const run = async (script: string) => (await new TestShell().runAndCapture(script)).stdout;

  await t.step('substring offsets and lengths are arithmetic, and may count from the end', async () => {
    assertEquals(
      await run('x=abcdef; i=2; n=3; echo "${x:0:0}|${x:i:n}|${x:$i:$n}|${x: -2}|${x:1+1:2*1}|${x:(-3):2}|${x:2:-1}|${x:7}|"'),
      '|cde|cde|ef|cd|de|cde||\n',
    );
    assertEquals(await run('set -- a b c d; echo "${@:2}|${@: -1}|${*:2:2}|${@:1:0}"; arr=(p q r s); echo "${arr[@]:1:2}|${arr[@]: -1}"'), 'b c d|d|b c|\nq r|s\n');
  });

  await t.step('a quoted word in ${x-word} stays quoted', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('for w in ${u-"a b"} ${u-""} ${u-a b}; do echo "[$w]"; done');
    assertEquals(result.stdout, '[a b]\n[]\n[a]\n[b]\n');
  });
});

Deno.test('${x/pattern/string}', async (t) => {
  // The expected text is bash 5.2's for the same lines
  const run = async (script: string) => (await new TestShell().runAndCapture(script)).stdout;

  await t.step('the pattern is a glob; the longest match goes, the first or every one', async () => {
    assertEquals(await run('v=abcabc; echo ${v//b*/X} ${v/b/X} ${v//[ab]/_}'), 'aX aXcabc __c__c\n');
  });

  await t.step('# and % anchor it, and with an empty pattern add to either end', async () => {
    assertEquals(await run('v=abcabc; echo ${v/#a/X} ${v/%c/X} ${v/#/P} ${v/%/S}'), 'Xbcabc abcabX Pabcabc abcabcS\n');
  });

  await t.step('an escaped or quoted / is part of the pattern, and quoted characters match themselves', async () => {
    assertEquals(await run('p=x/y/z; echo ${p//\\//^} ${p//"/"/-}; v=abcabc; echo ${v/"b*"/Q}'), 'x^y^z x-y-z\nabcabc\n');
  });

  await t.step('an unquoted & in the string is what matched', async () => {
    assertEquals(await run('v=abc; x="&"; echo ${v//?/<&>} ${v//b/\\&} ${v//b/"&"} ${v//b/$x}'), '<a><b><c> a&c a&c abc\n');
  });

  await t.step('an array has it done to each element', async () => {
    assertEquals(await run('a=(x/y z/w); echo ${a[@]//\\//^} ${a[@]/#/-}'), 'x^y z^w -x/y -z/w\n');
  });

  await t.step('a quoted pattern in # and % matches itself', async () => {
    assertEquals(await run(`v='a*b*c'; echo "\${v%"*"*}" "\${v##*"*"}" \${v#'a*'}`), 'a*b c b*c\n');
  });
});
