import { assertEquals } from 'jsr:@std/assert';
import { ExecContext } from '../../src/context.ts';
import { colonBuiltin, trueBuiltin, falseBuiltin } from '../../src/builtins/trivial.ts';

// Mock shell for testing
const mockShell = {} as Parameters<typeof colonBuiltin>[2];

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

Deno.test('Trivial Builtins', async (t) => {
  await t.step('colon (:) builtin', async (t) => {
    await t.step('returns exit code 0', async () => {
      const ctx = new ExecContext();
      const result = await colonBuiltin(ctx, [], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('ignores all arguments', async () => {
      const ctx = new ExecContext();
      const result = await colonBuiltin(ctx, ['arg1', 'arg2', 'arg3'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('produces no output', async () => {
      const ctx = new ExecContext();
      const result = await colonBuiltin(ctx, [], mockShell, noopExecute);
      assertEquals(result.stdout, undefined);
      assertEquals(result.stderr, undefined);
    });
  });

  await t.step('true builtin', async (t) => {
    await t.step('returns exit code 0', async () => {
      const ctx = new ExecContext();
      const result = await trueBuiltin(ctx, [], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('ignores all arguments', async () => {
      const ctx = new ExecContext();
      const result = await trueBuiltin(ctx, ['--help', 'foo'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });
  });

  await t.step('false builtin', async (t) => {
    await t.step('returns exit code 1', async () => {
      const ctx = new ExecContext();
      const result = await falseBuiltin(ctx, [], mockShell, noopExecute);
      assertEquals(result.code, 1);
    });

    await t.step('ignores all arguments', async () => {
      const ctx = new ExecContext();
      const result = await falseBuiltin(ctx, ['--help', 'foo'], mockShell, noopExecute);
      assertEquals(result.code, 1);
    });
  });
});
