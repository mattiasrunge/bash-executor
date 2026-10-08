import { assertEquals } from '@std/assert';
import { ExecContext } from '../src/context.ts';
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
      // A prefix assignment is in the command's environment
      const params = ctx.getEnv();
      return { code: 0, stdout: params['VAR'] || 'undefined' };
    });
    const result = await shell.runAndCapture('VAR=123 printvar');
    assertEquals(result.stdout, '123');
  });

  await t.step('multiple prefix assignments', async () => {
    const shell = new TestShell();
    shell.mockCommand('printvars', async (ctx) => {
      const params = ctx.getEnv();
      return { code: 0, stdout: `A=${params['A']},B=${params['B']}` };
    });
    const result = await shell.runAndCapture('A=1 B=2 printvars');
    assertEquals(result.stdout, 'A=1,B=2');
  });

  await t.step('prefix assignment does not leak to subsequent commands', async () => {
    const shell = new TestShell();
    shell.mockCommand('noop', async () => {
      return { code: 0 };
    });
    const result = await shell.runAndCapture('VAR=123 noop; echo $VAR');
    assertEquals(result.stdout, '\n');
  });

  await t.step('bare assignment persists in shell', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('VAR=123; echo $VAR');
    assertEquals(result.stdout, '123\n');
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

Deno.test('assigning to a declare -i variable evaluates the value', async () => {
  const shell = new TestShell();
  const result = await shell.runAndCapture('declare -i x; x=1+2; echo $x; x+=4; echo $x; b=5; x=b*2; echo $x');
  assertEquals(result.stdout, '3\n7\n10\n');
});

// Each case is what bash does
Deno.test('Variables as bash scopes and exports them', async (t) => {
  const run = async (script: string) => (await new TestShell().runAndCapture(script)).stdout;

  await t.step('the operators work on positional and special parameters', async () => {
    assertEquals(
      await run('set -- hello; echo "${1:1:3}|${1:-d}|${2:-d}|${1#h}|${1%o}|${1/l/L}|${1^}|${#1}|${?:-x}|${#@}"'),
      'ell|hello|d|ello|hell|heLlo|Hello|5|0|1\n',
    );
  });

  await t.step('the @ transformations', async () => {
    assertEquals(await run(`x="it's"; y=hello; echo \${x@Q} \${y@U} \${y@u} \${y@A}`), `'it'\\''s' HELLO Hello y='hello'\n`);
  });

  await t.step('declare in a function is local, and exports nothing', async () => {
    const shell = new TestShell();
    const result = await shell.runAndCapture('f() { declare y=2; declare -g G=g; echo "in=$y"; }; f; echo "out=$y G=$G"; declare x=1');
    assertEquals(result.stdout, 'in=2\nout= G=g\n');
    assertEquals(shell.getEnv()['x'], undefined);
    assertEquals(shell.getParams()['x'], '1');
  });

  await t.step('declare -i evaluates arithmetic', async () => {
    assertEquals(await run('declare -i n=5+3; echo $n; n+=2; echo $n'), '8\n10\n');
  });

  await t.step("local inside a block of a function is still the function's", async () => {
    assertEquals(await run('f() { if true; then local a=1; fi; echo "a=$a"; }; f; echo "out=$a"'), 'a=1\nout=\n');
  });

  await t.step('declare in a block at the top is global', async () => {
    assertEquals(await run('if true; then declare q=1; fi; { declare w=2; }; echo "$q $w"'), '1 2\n');
  });

  await t.step('assigning an exported variable changes what a command sees', async () => {
    const shell = new TestShell();
    await shell.runAndCapture('export X=1; X=2');
    assertEquals(shell.getEnv()['X'], '2');
  });

  await t.step("prefix assignments: left to right, after the words, in the command's environment", async () => {
    const shell = new TestShell();
    let seen: string | undefined;
    shell.mockCommand('show', async (ctx) => {
      seen = ctx.getEnv()['Z'];
      return { code: 0 };
    });
    const result = await shell.runAndCapture('x=old; x=new echo $x; Y=1 Z=$Y show; echo "Z=$Z"');
    assertEquals(result.stdout, 'old\nZ=\n');
    assertEquals(seen, '1');
  });

  await t.step('in POSIX mode an assignment before a special builtin persists', async () => {
    assertEquals(await run('Y=1 :; echo "Y=$Y"; set -o posix; Z=1 :; echo "Z=$Z"'), 'Y=\nZ=1\n');
  });
});

Deno.test('readonly variables stay as they are', async (t) => {
  const run = async (script: string) => {
    const result = await new TestShell().runAndCapture(script);
    return [result.stdout, result.stderr];
  };

  await t.step('assigning one ends the line, and the next one runs', async () => {
    assertEquals(await run('readonly r=1\nr=2; echo same line\necho "r=$r $?"'), ['r=1 1\n', 'r: readonly variable\n']);
  });

  await t.step('before a command it is said, and the command runs without it', async () => {
    assertEquals(await run('readonly r=1; r=3 echo hi; echo "r=$r $?"'), ['hi\nr=1 0\n', 'r: readonly variable\n']);
  });

  await t.step('for, read, let, (( )), unset and declare fail on it', async () => {
    const [stdout] = await run(
      'readonly r=1; for r in a; do :; done; echo "for $?"; read r <<< x; echo "read $?"; let r=2; echo "let $?"; ((r++)); echo "(( $?"; unset r; echo "unset $?"; declare r=5; echo "declare $? $r"',
    );
    assertEquals(stdout, 'for 1\nread 1\nlet 1\n(( 1\nunset 1\ndeclare 1 1\n');
  });

  await t.step('readonly arrays too, and readonly in a function is global', async () => {
    assertEquals(await run('f() { readonly a=(1); }; f\na[0]=2\necho "${a[0]}"; declare -p a'), ['1\ndeclare -ar a=([0]="1")\n', 'a: readonly variable\n']);
  });
});

Deno.test('BASHPID is $$ in the shell, another number in a subshell, and not to be assigned', async () => {
  const shell = new TestShell();

  shell.setParams({ '$': '4242' });

  const result = await shell.runAndCapture('echo $BASHPID; [ "$(echo $BASHPID)" != 4242 ] && echo other; BASHPID=1; echo $BASHPID');

  assertEquals(result.stdout, '4242\nother\n4242\n');
});

Deno.test("a host's own subcontext is still the shell, as far as BASHPID tells", async () => {
  const ctx = new ExecContext();

  ctx.setParams({ '$': '4242' });

  assertEquals([ctx.subContext().getParams().BASHPID, ctx.subContext(true).getParams().BASHPID !== '4242'], ['4242', true]);
});
