import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Case Statement Glob Patterns - Wildcards', async (t) => {
  await t.step('* matches any string', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'anything' });
    const result = await shell.runAndCapture(`
      case $x in
        *) echo "matched" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('prefix* matches prefix', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'prefix_suffix' });
    const result = await shell.runAndCapture(`
      case $x in
        prefix*) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('*suffix matches suffix', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'some_suffix' });
    const result = await shell.runAndCapture(`
      case $x in
        *suffix) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('*middle* matches substring', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'has_middle_here' });
    const result = await shell.runAndCapture(`
      case $x in
        *middle*) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('? matches single character', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'abc' });
    const result = await shell.runAndCapture(`
      case $x in
        a?c) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('? does not match empty', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'ac' });
    const result = await shell.runAndCapture(`
      case $x in
        a?c) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'no match\n');
  });

  await t.step('multiple ? characters', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'abcd' });
    const result = await shell.runAndCapture(`
      case $x in
        a??d) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('mixed * and ?', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'prefix_X_suffix' });
    const result = await shell.runAndCapture(`
      case $x in
        prefix_?_*) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });
});

Deno.test('Case Statement Glob Patterns - Character Classes', async (t) => {
  await t.step('[abc] matches single character from set', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'b' });
    const result = await shell.runAndCapture(`
      case $x in
        [abc]) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('[abc] does not match character outside set', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'd' });
    const result = await shell.runAndCapture(`
      case $x in
        [abc]) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'no match\n');
  });

  await t.step('[a-z] matches character range', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'm' });
    const result = await shell.runAndCapture(`
      case $x in
        [a-z]) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('[0-9] matches digit', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '5' });
    const result = await shell.runAndCapture(`
      case $x in
        [0-9]) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('[a-zA-Z] matches letter', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'Z' });
    const result = await shell.runAndCapture(`
      case $x in
        [a-zA-Z]) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('character class with other patterns', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'file1.txt' });
    const result = await shell.runAndCapture(`
      case $x in
        file[0-9].txt) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('character class with wildcards', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'test_A_end' });
    const result = await shell.runAndCapture(`
      case $x in
        *_[A-Z]_*) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('unclosed bracket treated as literal', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '[test' });
    const result = await shell.runAndCapture(`
      case $x in
        "[test") echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });
});

Deno.test('Case Statement Glob Patterns - Special Characters', async (t) => {
  await t.step('pattern with dot', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'test.txt' });
    const result = await shell.runAndCapture(`
      case $x in
        *.txt) echo "txt file" ;;
        *) echo "other" ;;
      esac
    `);
    assertEquals(result.stdout, 'txt file\n');
  });

  await t.step('pattern with plus', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'a+b' });
    const result = await shell.runAndCapture(`
      case $x in
        a+b) echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('pattern with caret', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '^test' });
    const result = await shell.runAndCapture(`
      case $x in
        "^test") echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('pattern with dollar in single quotes', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'test$' });
    const result = await shell.runAndCapture(`
      case $x in
        'test$') echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });

  await t.step('pattern with braces', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '{test}' });
    const result = await shell.runAndCapture(`
      case $x in
        "{test}") echo "matched" ;;
        *) echo "no match" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });
});

Deno.test('Case Statement - File Extension Patterns', async (t) => {
  await t.step('match .sh extension', async () => {
    const shell = new TestShell();
    shell.setParams({ file: 'script.sh' });
    const result = await shell.runAndCapture(`
      case $file in
        *.sh) echo "shell script" ;;
        *.py) echo "python" ;;
        *) echo "unknown" ;;
      esac
    `);
    assertEquals(result.stdout, 'shell script\n');
  });

  await t.step('match .tar.gz extension', async () => {
    const shell = new TestShell();
    shell.setParams({ file: 'archive.tar.gz' });
    const result = await shell.runAndCapture(`
      case $file in
        *.tar.gz) echo "gzipped tarball" ;;
        *.tar) echo "tarball" ;;
        *) echo "unknown" ;;
      esac
    `);
    assertEquals(result.stdout, 'gzipped tarball\n');
  });

  await t.step('match image extensions', async () => {
    const shell = new TestShell();
    shell.setParams({ file: 'photo.jpg' });
    const result = await shell.runAndCapture(`
      case $file in
        *.jpg|*.jpeg|*.png|*.gif) echo "image" ;;
        *) echo "other" ;;
      esac
    `);
    assertEquals(result.stdout, 'image\n');
  });
});

Deno.test('Case Statement - Edge Cases', async (t) => {
  await t.step('empty string matches *', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '' });
    const result = await shell.runAndCapture(`
      case $x in
        "") echo "empty" ;;
        *) echo "not empty" ;;
      esac
    `);
    assertEquals(result.stdout, 'empty\n');
  });

  await t.step('whitespace matching', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '   ' });
    const result = await shell.runAndCapture(`
      case "$x" in
        "   ") echo "spaces" ;;
        *) echo "other" ;;
      esac
    `);
    assertEquals(result.stdout, 'spaces\n');
  });

  await t.step('case with numeric values', async () => {
    const shell = new TestShell();
    shell.setParams({ n: '42' });
    const result = await shell.runAndCapture(`
      case $n in
        [0-9]) echo "single digit" ;;
        [0-9][0-9]) echo "two digits" ;;
        *) echo "other" ;;
      esac
    `);
    assertEquals(result.stdout, 'two digits\n');
  });

  await t.step('case with first matching pattern wins', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'abc' });
    const result = await shell.runAndCapture(`
      case $x in
        a*) echo "first" ;;
        abc) echo "second" ;;
        *) echo "default" ;;
      esac
    `);
    assertEquals(result.stdout, 'first\n');
  });
});
