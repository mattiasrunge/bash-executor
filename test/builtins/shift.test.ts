import { assertEquals } from 'jsr:@std/assert';
import { shiftBuiltin } from '../../src/builtins/shift.ts';
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

Deno.test('shift builtin', async (t) => {
  await t.step('shifts by 1 by default', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '1': 'a', '2': 'b', '3': 'c', '#': '3' });

    const result = await shiftBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);

    const params = ctx.getParams();
    assertEquals(params['1'], 'b');
    assertEquals(params['2'], 'c');
    assertEquals(params['3'], undefined);
    assertEquals(params['#'], '2');
  });

  await t.step('shifts by specified amount', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '1': 'a', '2': 'b', '3': 'c', '4': 'd', '#': '4' });

    const result = await shiftBuiltin(ctx, ['2'], mockShell, noopExecute);
    assertEquals(result.code, 0);

    const params = ctx.getParams();
    assertEquals(params['1'], 'c');
    assertEquals(params['2'], 'd');
    assertEquals(params['3'], undefined);
    assertEquals(params['4'], undefined);
    assertEquals(params['#'], '2');
  });

  await t.step('shift 0 does nothing', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '1': 'a', '2': 'b', '#': '2' });

    const result = await shiftBuiltin(ctx, ['0'], mockShell, noopExecute);
    assertEquals(result.code, 0);

    const params = ctx.getParams();
    assertEquals(params['1'], 'a');
    assertEquals(params['2'], 'b');
    assertEquals(params['#'], '2');
  });

  await t.step('fails if shift count exceeds parameters', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '1': 'a', '2': 'b', '#': '2' });

    const result = await shiftBuiltin(ctx, ['3'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, "shift: can't shift that many\n");
  });

  await t.step('fails with non-numeric argument', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '1': 'a', '#': '1' });

    const result = await shiftBuiltin(ctx, ['abc'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, 'shift: abc: numeric argument required\n');
  });

  await t.step('fails with negative argument', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '1': 'a', '#': '1' });

    const result = await shiftBuiltin(ctx, ['-1'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, 'shift: -1: numeric argument required\n');
  });

  await t.step('handles empty positional parameters', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '#': '0' });

    const result = await shiftBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, "shift: can't shift that many\n");
  });

  await t.step('shifts all parameters', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '1': 'a', '2': 'b', '#': '2' });

    const result = await shiftBuiltin(ctx, ['2'], mockShell, noopExecute);
    assertEquals(result.code, 0);

    const params = ctx.getParams();
    assertEquals(params['1'], undefined);
    assertEquals(params['2'], undefined);
    assertEquals(params['#'], '0');
  });
});
