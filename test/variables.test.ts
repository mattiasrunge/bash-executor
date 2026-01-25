import { assertEquals } from '@std/assert';
import { TestShell } from './lib/test-shell.ts';

Deno.test('Variable Assignment', async (t) => {
  await t.step('simple variable assignment', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=hello; echo $x');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'hello\n');
  });

  await t.step('variable assignment with quotes', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x="hello world"; echo $x');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'hello world\n');
  });

  await t.step('multiple variable assignments', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('a=1; b=2; c=3; echo $a $b $c');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, '1 2 3\n');
  });

  await t.step('variable reassignment', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('x=old; x=new; echo $x');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'new\n');
  });
});

Deno.test('Prefix Variable Assignment', async (t) => {
  await t.step('prefix assignment sets variable for command', async () => {
    const shell = new TestShell();
    shell.mockCommand('printvar', async (ctx) => {
      const params = ctx.getParams();
      return { code: 0, stdout: params['VAR'] || 'undefined' };
    });
    const result = await shell.runAndCapture('VAR=123 printvar');
    assertEquals(result.stdout, '123');
  });

  await t.step('multiple prefix assignments', async () => {
    const shell = new TestShell();
    shell.mockCommand('printvars', async (ctx) => {
      const params = ctx.getParams();
      return { code: 0, stdout: `A=${params['A']},B=${params['B']}` };
    });
    const result = await shell.runAndCapture('A=1 B=2 printvars');
    assertEquals(result.stdout, 'A=1,B=2');
  });
});

Deno.test('Parameter Expansion', async (t) => {
  await t.step('simple parameter expansion $VAR', async () => {
    const shell = new TestShell();
    shell.setParams({ NAME: 'World' });
    const result = await shell.runAndCapture('echo "Hello $NAME"');
    assertEquals(result.stdout, 'Hello World\n');
  });

  await t.step('braced parameter expansion ${VAR}', async () => {
    const shell = new TestShell();
    shell.setParams({ VAR: 'value' });
    const result = await shell.runAndCapture('echo "${VAR}suffix"');
    assertEquals(result.stdout, 'valuesuffix\n');
  });

  await t.step('undefined parameter expands to empty string', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('echo "Value: $UNDEFINED"');
    assertEquals(result.stdout, 'Value: \n');
  });

  await t.step('parameter in unquoted context', async () => {
    const shell = new TestShell();
    shell.setParams({ X: 'test' });
    const result = await shell.runAndCapture('echo $X');
    assertEquals(result.stdout, 'test\n');
  });

  await t.step('multiple parameters in one string', async () => {
    const shell = new TestShell();
    shell.setParams({ A: 'one', B: 'two' });
    const result = await shell.runAndCapture('echo "$A and $B"');
    assertEquals(result.stdout, 'one and two\n');
  });
});

Deno.test('Environment Variables', async (t) => {
  await t.step('environment variable access', async () => {
    const shell = new TestShell();
    shell.setEnv({ HOME: '/home/user' });
    const result = await shell.runAndCapture('echo $HOME');
    assertEquals(result.stdout, '/home/user\n');
  });

  await t.step('export sets environment variable', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('export FOO=bar; echo $FOO');
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, 'bar\n');
  });

  await t.step('PWD is set when changing directory', async () => {
    const shell = new TestShell();
    shell.setCwd('/some/path');
    const result = await shell.runAndCapture('echo $PWD');
    assertEquals(result.stdout, '/some/path\n');
  });
});

Deno.test('Variable Unset', async (t) => {
  await t.step('unset removes variable', async () => {
    const shell = new TestShell();
    shell.setParams({ X: 'value' });
    const result = await shell.runAndCapture('unset X; echo "X=$X"');
    assertEquals(result.stdout, 'X=\n');
  });
});
