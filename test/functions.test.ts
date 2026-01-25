import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Function Definition and Invocation', async (t) => {
  await t.step('define and call simple function', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      hello() {
        echo "Hello, World!"
      }
      hello
    `);
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'Hello, World!\n');
  });

  await t.step('function with multiple commands', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      greet() {
        echo "Hello"
        echo "World"
      }
      greet
    `);
    assertEquals(result.stdout, 'Hello\nWorld\n');
  });

  await t.step('function can be called multiple times', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      say() {
        echo "hi"
      }
      say
      say
      say
    `);
    assertEquals(result.stdout, 'hi\nhi\nhi\n');
  });

  await t.step('function returns exit code of last command', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      fail() {
        false
      }
      fail
    `);
    assertEquals(result.exitCode, 1);
  });

  await t.step('function returns success', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      succeed() {
        true
      }
      succeed
    `);
    assertEquals(result.exitCode, 0);
  });
});

Deno.test('Function Arguments', async (t) => {
  await t.step('function receives positional arguments', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      greet() {
        echo "Hello, $1!"
      }
      greet Alice
    `);
    assertEquals(result.stdout, 'Hello, Alice!\n');
  });

  await t.step('function with multiple arguments', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      add_greeting() {
        echo "$1 says hello to $2"
      }
      add_greeting Alice Bob
    `);
    assertEquals(result.stdout, 'Alice says hello to Bob\n');
  });

  await t.step('function with argument in arithmetic', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      double() {
        echo $(($1 * 2))
      }
      double 5
    `);
    assertEquals(result.stdout, '10\n');
  });
});

Deno.test('Function Scope', async (t) => {
  await t.step('function can access outer variables', async () => {
    const shell = new TestShell();
    shell.setParams({ OUTER: 'outer_value' });
    const result = await shell.runAndCapture(`
      show() {
        echo $OUTER
      }
      show
    `);
    assertEquals(result.stdout, 'outer_value\n');
  });

  await t.step('function can modify variables', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      x=1
      increment() {
        (( x++ ))
      }
      increment
      echo $x
    `);
    assertEquals(result.stdout, '2\n');
  });

  await t.step('function defined variable accessible outside', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      setvar() {
        MYVAR=fromfunc
      }
      setvar
      echo $MYVAR
    `);
    assertEquals(result.stdout, 'fromfunc\n');
  });
});

Deno.test('Function Return Values', async (t) => {
  await t.step('return exits function with code', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      check() {
        return 42
      }
      check
    `);
    assertEquals(result.exitCode, 42);
  });

  await t.step('return 0 indicates success', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      ok() {
        return 0
      }
      ok
    `);
    assertEquals(result.exitCode, 0);
  });

  await t.step('return 1 indicates failure', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      notok() {
        return 1
      }
      notok
    `);
    assertEquals(result.exitCode, 1);
  });
});

Deno.test('Function with Control Flow', async (t) => {
  await t.step('function with if statement', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      check_positive() {
        if [ $1 -gt 0 ]; then
          echo "positive"
        else
          echo "not positive"
        fi
      }
      check_positive 5
      check_positive -3
    `);
    assertEquals(result.stdout, 'positive\nnot positive\n');
  });

  await t.step('function with loop', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      countdown() {
        n=$1
        while [ $n -gt 0 ]; do
          echo $n
          (( n-- ))
        done
      }
      countdown 3
    `);
    assertEquals(result.stdout, '3\n2\n1\n');
  });
});

Deno.test('Function in Pipeline', async (t) => {
  await t.step('function output can be piped', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      produce() {
        echo "hello world"
      }
      produce | grep hello
    `);
    assertEquals(result.stdout, 'hello world\n');
  });

  await t.step('function in command substitution', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture(`
      getvalue() {
        echo "42"
      }
      result=$(getvalue)
      echo "got: $result"
    `);
    assertEquals(result.stdout, 'got: 42\n');
  });
});
