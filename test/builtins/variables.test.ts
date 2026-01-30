import { assertEquals } from 'jsr:@std/assert';
import { exportBuiltin, localBuiltin, unsetBuiltin } from '../../src/builtins/variables.ts';
import { ExecContext } from '../../src/context.ts';

// Mock shell for testing
const mockShell = {} as Parameters<typeof exportBuiltin>[2];

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

Deno.test('export builtin', async (t) => {
  await t.step('exports variable with value', async () => {
    const ctx = new ExecContext();
    const result = await exportBuiltin(ctx, ['FOO=bar'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['FOO'], 'bar');
    assertEquals(ctx.getParams()['FOO'], 'bar');
  });

  await t.step('exports multiple variables', async () => {
    const ctx = new ExecContext();
    const result = await exportBuiltin(ctx, ['FOO=bar', 'BAZ=qux'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['FOO'], 'bar');
    assertEquals(ctx.getEnv()['BAZ'], 'qux');
  });

  await t.step('exports existing param to env', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ FOO: 'bar' });
    const result = await exportBuiltin(ctx, ['FOO'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['FOO'], 'bar');
  });

  await t.step('exports empty value when param not set', async () => {
    const ctx = new ExecContext();
    const result = await exportBuiltin(ctx, ['FOO'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['FOO'], '');
  });

  await t.step('-n removes export', async () => {
    const ctx = new ExecContext();
    ctx.setEnv({ FOO: 'bar' });
    const result = await exportBuiltin(ctx, ['-n', 'FOO=newvalue'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['FOO'], undefined);
    assertEquals(ctx.getParams()['FOO'], 'newvalue');
  });

  await t.step('handles empty value', async () => {
    const ctx = new ExecContext();
    const result = await exportBuiltin(ctx, ['FOO='], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['FOO'], '');
  });

  await t.step('handles value with equals sign', async () => {
    const ctx = new ExecContext();
    const result = await exportBuiltin(ctx, ['FOO=bar=baz'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['FOO'], 'bar=baz');
  });

  await t.step('returns success with no arguments', async () => {
    const ctx = new ExecContext();
    const result = await exportBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
  });
});

Deno.test('unset builtin', async (t) => {
  await t.step('unsets variable', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ FOO: 'bar' });
    ctx.setEnv({ FOO: 'bar' });
    const result = await unsetBuiltin(ctx, ['FOO'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['FOO'], undefined);
    assertEquals(ctx.getEnv()['FOO'], undefined);
  });

  await t.step('unsets multiple variables', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ FOO: 'bar', BAZ: 'qux' });
    const result = await unsetBuiltin(ctx, ['FOO', 'BAZ'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['FOO'], undefined);
    assertEquals(ctx.getParams()['BAZ'], undefined);
  });

  await t.step('-v flag unsets variable (default)', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ FOO: 'bar' });
    const result = await unsetBuiltin(ctx, ['-v', 'FOO'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['FOO'], undefined);
  });

  await t.step('-f flag unsets function', async () => {
    const ctx = new ExecContext();
    // Set up a mock function
    ctx.setFunction('myfunc', { type: 'CompoundList', commands: [] } as any, ctx);
    assertEquals(ctx.getFunction('myfunc') != null, true);

    const result = await unsetBuiltin(ctx, ['-f', 'myfunc'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    // getFunction returns undefined/falsy for non-existent functions
    assertEquals(ctx.getFunction('myfunc') == null, true);
  });

  await t.step('unsets non-existent variable silently', async () => {
    const ctx = new ExecContext();
    const result = await unsetBuiltin(ctx, ['NONEXISTENT'], mockShell, noopExecute);
    assertEquals(result.code, 0);
  });
});

Deno.test('local builtin', async (t) => {
  await t.step('creates local variable with value', async () => {
    const ctx = new ExecContext();
    const result = await localBuiltin(ctx, ['FOO=bar'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['FOO'], 'bar');
  });

  await t.step('creates local variable without value', async () => {
    const ctx = new ExecContext();
    const result = await localBuiltin(ctx, ['FOO'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['FOO'], '');
  });

  await t.step('creates multiple local variables', async () => {
    const ctx = new ExecContext();
    const result = await localBuiltin(ctx, ['FOO=bar', 'BAZ=qux'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['FOO'], 'bar');
    assertEquals(ctx.getParams()['BAZ'], 'qux');
  });

  await t.step('local variable shadows parent in child context', async () => {
    const parent = new ExecContext();
    parent.setParams({ FOO: 'parent' });

    const child = parent.spawnContext();
    await localBuiltin(child, ['FOO=child'], mockShell, noopExecute);

    assertEquals(child.getParams()['FOO'], 'child');
    assertEquals(parent.getParams()['FOO'], 'parent');
  });
});
