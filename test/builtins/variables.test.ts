import { assertEquals } from '@std/assert';
import { exportBuiltin, localBuiltin, unsetBuiltin } from '../../src/builtins/variables.ts';
import { ExecContext } from '../../src/context.ts';
import type { ExecContextIf } from '../../src/types.ts';

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
    // Exported variables live in the environment alone
    assertEquals(ctx.getParams()['FOO'], undefined);
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

  await t.step('exporting an unset name marks it, and puts nothing in the environment yet', async () => {
    const ctx = new ExecContext();
    const result = await exportBuiltin(ctx, ['FOO'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['FOO'], undefined);

    ctx.setParams({ FOO: 'later' });
    assertEquals(ctx.getEnv()['FOO'], 'later');
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

/** A function's frame, as the executor makes one, and the context a command in it runs in. */
function inFunction(): { frame: ExecContextIf; cmd: ExecContextIf } {
  const frame = new ExecContext().spawnContext();

  frame.setLocalParams({ '#': '0' });

  return { frame, cmd: frame.spawnContext() };
}

Deno.test('local builtin', async (t) => {
  await t.step('creates local variable with value', async () => {
    const { frame, cmd } = inFunction();
    const result = await localBuiltin(cmd, ['FOO=bar'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(frame.getParams()['FOO'], 'bar');
  });

  await t.step('a local without a value is declared, and unset', async () => {
    const { frame, cmd } = inFunction();
    const result = await localBuiltin(cmd, ['FOO'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(frame.getParams()['FOO'], undefined);
    assertEquals(frame.getOwnVariables()['FOO']?.kind, 'scalar');
  });

  await t.step('creates multiple local variables', async () => {
    const { frame, cmd } = inFunction();
    const result = await localBuiltin(cmd, ['FOO=bar', 'BAZ=qux'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(frame.getParams()['FOO'], 'bar');
    assertEquals(frame.getParams()['BAZ'], 'qux');
  });

  await t.step("local assigns in the function, not in the command context, and hides the caller's", async () => {
    const root = new ExecContext();
    root.setParams({ FOO: 'parent' });

    const frame = root.spawnContext();
    frame.setLocalParams({ '#': '0' });
    await localBuiltin(frame.spawnContext(), ['FOO=child'], mockShell, noopExecute);

    assertEquals(frame.getParams()['FOO'], 'child');
    assertEquals(root.getParams()['FOO'], 'parent');
  });

  await t.step('outside a function it refuses', async () => {
    const result = await localBuiltin(new ExecContext(), ['FOO=bar'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, 'local: can only be used in a function\n');
  });
});
