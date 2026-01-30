import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
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
    assertEquals(ctx.getEnv()['x'], '5');
  });

  await t.step('declares multiple variables', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['a=1', 'b=2', 'c=3'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['a'], '1');
    assertEquals(ctx.getEnv()['b'], '2');
    assertEquals(ctx.getEnv()['c'], '3');
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
    assertEquals(ctx.getEnv()['CONST'], '10');

    // Try to modify it
    result = await declareBuiltin(ctx, ['CONST=20'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr || '', 'readonly');
  });

  await t.step('-i declares integer variable', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['-i', 'num=42'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['num'], '42');
  });

  await t.step('-i with non-numeric value defaults to 0', async () => {
    const ctx = setup();
    const result = await declareBuiltin(ctx, ['-i', 'num=abc'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['num'], '0');
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
    assertEquals(ctx.getEnv()['x'], '5');
  });
});
