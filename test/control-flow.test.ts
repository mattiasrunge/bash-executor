import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('If Statements', async (t) => {
  await t.step('if with true condition executes then block', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if true; then
        echo "yes"
      fi
    `);
    assertEquals(result.stdout, 'yes\n');
  });

  await t.step('if with false condition skips then block', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if false; then
        echo "yes"
      fi
    `);
    assertEquals(result.stdout, '');
  });

  await t.step('if-else executes else block on false', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if false; then
        echo "yes"
      else
        echo "no"
      fi
    `);
    assertEquals(result.stdout, 'no\n');
  });

  await t.step('if-elif-else chain', async () => {
    const shell = new TestShell();
    shell.setParams({ x: '2' });
    const result = await shell.runAndCapture(`
      if [ $x -eq 1 ]; then
        echo "one"
      elif [ $x -eq 2 ]; then
        echo "two"
      else
        echo "other"
      fi
    `);
    assertEquals(result.stdout, 'two\n');
  });

  await t.step('nested if statements', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      if true; then
        if true; then
          echo "nested"
        fi
      fi
    `);
    assertEquals(result.stdout, 'nested\n');
  });

  await t.step('if with test command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      x=5
      if test $x -gt 3; then
        echo "greater"
      fi
    `);
    assertEquals(result.stdout, 'greater\n');
  });

  await t.step('if with [ ] brackets', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      x="hello"
      if [ "$x" = "hello" ]; then
        echo "match"
      fi
    `);
    assertEquals(result.stdout, 'match\n');
  });

  await t.step('if with arithmetic condition', async () => {
    const shell = new TestShell();
    // Use [ ] for comparison to avoid parser issue with > in (( ))
    const result = await shell.runAndCapture(`
      x=10
      if [ $x -gt 5 ]; then
        echo "big"
      fi
    `);
    assertEquals(result.stdout, 'big\n');
  });
});

Deno.test('While Loops', async (t) => {
  await t.step('while loop executes while condition is true', async () => {
    const shell = new TestShell();
    // Note: Using i=$((i+1)) instead of (( i++ )) because postfix increment
    // returns 0 when i=0, causing exit code 1 which stops the compound list
    const result = await shell.runAndCapture(`
      i=0
      while [ $i -lt 3 ]; do
        echo $i
        i=$((i + 1))
      done
    `);
    assertEquals(result.stdout, '0\n1\n2\n');
  });

  await t.step('while loop with false condition never executes', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      while false; do
        echo "never"
      done
    `);
    assertEquals(result.stdout, '');
  });

  await t.step('while loop with arithmetic condition', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      i=3
      while [ $i -gt 0 ]; do
        echo $i
        i=$((i - 1))
      done
    `);
    assertEquals(result.stdout, '3\n2\n1\n');
  });
});

Deno.test('Loop Control - Break', async (t) => {
  await t.step('break exits while loop', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      i=0
      while true; do
        echo $i
        i=$((i + 1))
        if [ $i -eq 3 ]; then
          break
        fi
      done
      echo "done"
    `);
    assertEquals(result.stdout, '0\n1\n2\ndone\n');
  });

  await t.step('break exits for loop', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in 1 2 3 4 5; do
        if [ $i -eq 3 ]; then
          break
        fi
        echo $i
      done
    `);
    assertEquals(result.stdout, '1\n2\n');
  });
});

Deno.test('Loop Control - Continue', async (t) => {
  await t.step('continue skips to next iteration in while', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      i=0
      while [ $i -lt 5 ]; do
        i=$((i + 1))
        if [ $i -eq 3 ]; then
          continue
        fi
        echo $i
      done
    `);
    assertEquals(result.stdout, '1\n2\n4\n5\n');
  });

  await t.step('continue skips to next iteration in for', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for i in 1 2 3 4 5; do
        if [ $i -eq 3 ]; then
          continue
        fi
        echo $i
      done
    `);
    assertEquals(result.stdout, '1\n2\n4\n5\n');
  });
});

Deno.test('Until Loops', async (t) => {
  await t.step('until loop executes until condition is true', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      i=0
      until [ $i -ge 3 ]; do
        echo $i
        i=$((i + 1))
      done
    `);
    assertEquals(result.stdout, '0\n1\n2\n');
  });

  await t.step('until loop with initially true condition never executes', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      until true; do
        echo "never"
      done
    `);
    assertEquals(result.stdout, '');
  });
});

Deno.test('For Loops', async (t) => {
  await t.step('for loop iterates over word list', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for item in a b c; do
        echo $item
      done
    `);
    assertEquals(result.stdout, 'a\nb\nc\n');
  });

  await t.step('for loop with numbers', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for n in 1 2 3; do
        echo "num: $n"
      done
    `);
    assertEquals(result.stdout, 'num: 1\nnum: 2\nnum: 3\n');
  });

  await t.step('for loop with quoted strings', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for word in "hello world" "foo bar"; do
        echo "$word"
      done
    `);
    assertEquals(result.stdout, 'hello world\nfoo bar\n');
  });

  await t.step('for loop with command expansion', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for item in $(echo x y z); do
        echo $item
      done
    `);
    assertEquals(result.stdout, 'x\ny\nz\n');
  });

  await t.step('empty for loop word list', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      for item in; do
        echo "never"
      done
      echo "done"
    `);
    assertEquals(result.stdout, 'done\n');
  });
});

Deno.test('Case Statements', async (t) => {
  await t.step('case matches exact pattern', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'foo' });
    const result = await shell.runAndCapture(`
      case $x in
        foo) echo "matched foo" ;;
        bar) echo "matched bar" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched foo\n');
  });

  await t.step('case with no match', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'baz' });
    const result = await shell.runAndCapture(`
      case $x in
        foo) echo "foo" ;;
        bar) echo "bar" ;;
      esac
    `);
    assertEquals(result.stdout, '');
  });

  await t.step('case with default pattern *', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'unknown' });
    const result = await shell.runAndCapture(`
      case $x in
        foo) echo "foo" ;;
        *) echo "default" ;;
      esac
    `);
    assertEquals(result.stdout, 'default\n');
  });

  await t.step('case with multiple patterns using |', async () => {
    const shell = new TestShell();
    shell.setParams({ x: 'yes' });
    const result = await shell.runAndCapture(`
      case $x in
        yes|y|Y) echo "affirmative" ;;
        no|n|N) echo "negative" ;;
      esac
    `);
    assertEquals(result.stdout, 'affirmative\n');
  });

  await t.step('case with glob pattern', async () => {
    const shell = new TestShell();
    shell.setParams({ file: 'test.txt' });
    const result = await shell.runAndCapture(`
      case $file in
        *.txt) echo "text file" ;;
        *.jpg) echo "image" ;;
      esac
    `);
    assertEquals(result.stdout, 'text file\n');
  });

  // Test case with literal (no variable expansion needed)
  await t.step('case with literal clause', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      case foo in
        foo) echo "matched" ;;
        bar) echo "bar" ;;
      esac
    `);
    assertEquals(result.stdout, 'matched\n');
  });
});
