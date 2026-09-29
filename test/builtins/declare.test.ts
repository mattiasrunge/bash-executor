import { assertEquals, assertStringIncludes } from '@std/assert';
import { declareBuiltin, typesetBuiltin } from '../../src/builtins/declare.ts';
import { ExecContext } from '../../src/context.ts';
import type { ShellIf } from '../../src/types.ts';

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

// Mock shell
const mockShell: ShellIf = {
  execute: async () => 0,
  pipeOpen: async () => 'pipe',
  pipeClose: async () => {},
  pipeRemove: async () => {},
  pipeRead: async () => '',
  pipeWrite: async () => {},
  isPipe: () => true,
  pipeFromFile: async () => {},
  pipeToFile: async () => {},
};

// Create a fresh context for each test (attributes are now per-context)
function setup() {
  return new ExecContext();
}

Deno.test('declare builtin', async (t) => {
  await t.step('no arguments returns success', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('declares variable with value', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['x=5'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['x'], '5');
    // Declared, not exported
    assertEquals(ctx.getEnv()['x'], undefined);
  });

  await t.step('declares multiple variables', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['a=1', 'b=2', 'c=3'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['a'], '1');
    assertEquals(ctx.getParams()['b'], '2');
    assertEquals(ctx.getParams()['c'], '3');
  });

  await t.step('invalid identifier returns error', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['123invalid'], mockShell, noopExecute);
    assertEquals(result.code, 1);
  });

  await t.step('-p prints variable', async () => {
    const ctx = setup();
    ctx.setEnv({ foo: 'bar' });
    const result = await declareBuiltin(ctx, ['-p', 'foo'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout || '', 'foo="bar"');
  });

  await t.step('-p for non-existent variable returns error', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['-p', 'nonexistent'], mockShell, noopExecute);
    assertEquals(result.code, 1);
  });

  await t.step('-x exports variable', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['-x', 'MYVAR=hello'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['MYVAR'], 'hello');
  });

  await t.step('-r makes variable readonly', async () => {
    const ctx = setup();
    // First declare the variable
    let result = await declareBuiltin(ctx, ['-r', 'CONST=10'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['CONST'], '10');

    // Try to modify it
    result = await declareBuiltin(ctx, ['CONST=20'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr || '', 'readonly');
  });

  await t.step('-i declares integer variable', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['-i', 'num=42'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['num'], '42');
  });

  await t.step('-i with non-numeric value defaults to 0', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['-i', 'num=abc'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['num'], '0');
  });

  await t.step('-f shows functions', async () => {
    const ctx = setup();
    // Note: Functions need to be defined in context for this to show anything
    const result = await declareBuiltin(ctx, ['-f'], mockShell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('-F shows function names', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['-F'], mockShell, noopExecute);
    assertEquals(result.code, 0);
  });
});

Deno.test('typeset builtin', async (t) => {
  await t.step('is alias for declare', async () => {
    const ctx = setup();
    const result = await typesetBuiltin(ctx, ['x=5'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['x'], '5');
  });
});

Deno.test('declare as bash does it', async (t) => {
  // Each expected text is bash 5.2's for the same script
  const { TestShell } = await import('../lib/test-shell.ts');
  const run = async (script: string) => await new TestShell().runAndCapture(script);

  await t.step('declared without a value is set by nothing, and -p shows just the name', async () => {
    assertEquals((await run('declare -a b; declare -p b; declare -A h=([k]=v); declare -p h')).stdout, 'declare -a b\ndeclare -A h=([k]="v" )\n');
  });

  await t.step('a subscripted name makes an array, and += appends', async () => {
    assertEquals((await run('declare c[3]=x; declare -p c; x=1; declare x+=2; declare -p x')).stdout, 'declare -a c=([3]="x")\ndeclare -- x="12"\n');
  });

  await t.step('-i makes assignments arithmetic, arrays too; -l and -u change the case', async () => {
    const result = await run('declare -i n=2+3; n+=4; declare -ai ia=(1+1 2); ia[1]+=5; declare -l lo=MiXed; declare -u up=MiXed; declare -p n ia lo up');

    assertEquals(result.stdout, 'declare -i n="9"\ndeclare -ai ia=([0]="2" [1]="7")\ndeclare -l lo="mixed"\ndeclare -u up="MIXED"\n');
  });

  await t.step('assigning a readonly array a list abandons the line', async () => {
    const result = await run('readonly r=(1); readonly r=(2); declare -p r\ndeclare -p r');

    assertEquals(result.stdout, 'declare -ar r=([0]="1")\n');
    assertStringIncludes(result.stderr, 'r: readonly variable');
  });

  await t.step('a local is declared unset, and stays local when unset', async () => {
    const result = await run('f() { local v; echo "[${v-unset}]"; v=in; unset v; v=again; declare -p v; }; f; echo "out:${v-unset}"');

    assertEquals(result.stdout, '[unset]\ndeclare -- v="again"\nout:unset\n');
  });

  await t.step('declare in a function is local, with -g global', async () => {
    assertEquals((await run('g() { declare d=1; declare -g gl=2; }; g; echo "${d-unset} $gl"')).stdout, 'unset 2\n');
  });

  await t.step('what bash refuses', async () => {
    const result = await run('declare -a b; declare +a b; echo $?; declare -p nosuch; echo $?');

    assertEquals(result.stdout, '1\n1\n');
    assertEquals(result.stderr, 'declare: b: cannot destroy array variables in this way\ndeclare: nosuch: not found\n');
  });

  await t.step('export -n takes the attribute, and readonly assigns a quoted list as a string', async () => {
    const result = await run("export ex=1; declare -p ex; export -n ex; declare -p ex; e=(outside); f2() { readonly 'e=(3)'; }; f2; declare -p e");

    assertEquals(result.stdout, 'declare -x ex="1"\ndeclare -- ex="1"\ndeclare -ar e=([0]="(3)")\n');
  });
});
