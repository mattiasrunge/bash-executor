import { assertEquals } from '@std/assert';
import { letBuiltin } from '../../src/builtins/let.ts';
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

Deno.test('let builtin', async (t) => {
  await t.step('no arguments returns error', async () => {
    const ctx = new ExecContext();
    const result = await letBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, 'let: expression expected\n');
  });

  await t.step('basic assignment', async () => {
    const ctx = new ExecContext();
    const result = await letBuiltin(ctx, ['x = 5'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['x'], '5');
  });

  await t.step('returns 1 when result is 0', async () => {
    const ctx = new ExecContext();
    const result = await letBuiltin(ctx, ['x = 0'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertEquals(ctx.getParams()['x'], '0');
  });

  await t.step('arithmetic operations', async (t) => {
    await t.step('addition', async () => {
      const ctx = new ExecContext();
      const result = await letBuiltin(ctx, ['x = 2 + 3'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '5');
    });

    await t.step('subtraction', async () => {
      const ctx = new ExecContext();
      const result = await letBuiltin(ctx, ['x = 10 - 3'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '7');
    });

    await t.step('multiplication', async () => {
      const ctx = new ExecContext();
      const result = await letBuiltin(ctx, ['x = 4 * 5'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '20');
    });

    await t.step('division (truncates)', async () => {
      const ctx = new ExecContext();
      const result = await letBuiltin(ctx, ['x = 17 / 5'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '3');
    });

    await t.step('modulo', async () => {
      const ctx = new ExecContext();
      const result = await letBuiltin(ctx, ['x = 17 % 5'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '2');
    });
  });

  await t.step('increment and decrement', async (t) => {
    await t.step('post-increment', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ x: '5' });
      const result = await letBuiltin(ctx, ['y = x++'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '6');
      assertEquals(ctx.getParams()['y'], '5'); // Old value
    });

    await t.step('pre-increment', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ x: '5' });
      const result = await letBuiltin(ctx, ['y = ++x'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '6');
      assertEquals(ctx.getParams()['y'], '6'); // New value
    });

    await t.step('post-decrement', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ x: '5' });
      const result = await letBuiltin(ctx, ['y = x--'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '4');
      assertEquals(ctx.getParams()['y'], '5'); // Old value
    });

    await t.step('standalone increment', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ x: '5' });
      const result = await letBuiltin(ctx, ['x++'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '6');
    });
  });

  await t.step('compound assignment', async (t) => {
    await t.step('+=', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ x: '10' });
      const result = await letBuiltin(ctx, ['x += 5'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '15');
    });

    await t.step('-=', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ x: '10' });
      const result = await letBuiltin(ctx, ['x -= 3'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '7');
    });

    await t.step('*=', async () => {
      const ctx = new ExecContext();
      ctx.setParams({ x: '4' });
      const result = await letBuiltin(ctx, ['x *= 3'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '12');
    });
  });

  await t.step('comparison operators', async (t) => {
    await t.step('equality', async () => {
      const ctx = new ExecContext();
      const result = await letBuiltin(ctx, ['x = 5 == 5'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '1');
    });

    await t.step('inequality', async () => {
      const ctx = new ExecContext();
      const result = await letBuiltin(ctx, ['x = 5 != 3'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '1');
    });

    await t.step('less than', async () => {
      const ctx = new ExecContext();
      const result = await letBuiltin(ctx, ['x = 3 < 5'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '1');
    });

    await t.step('greater than', async () => {
      const ctx = new ExecContext();
      const result = await letBuiltin(ctx, ['x = 5 > 3'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getParams()['x'], '1');
    });
  });

  await t.step('logical operators', async (t) => {
    await t.step('logical AND (&&)', async () => {
      const ctx = new ExecContext();
      await letBuiltin(ctx, ['x = 1 && 1'], mockShell, noopExecute);
      assertEquals(ctx.getParams()['x'], '1');
      await letBuiltin(ctx, ['x = 1 && 0'], mockShell, noopExecute);
      assertEquals(ctx.getParams()['x'], '0');
    });

    await t.step('logical OR (||)', async () => {
      const ctx = new ExecContext();
      await letBuiltin(ctx, ['x = 0 || 1'], mockShell, noopExecute);
      assertEquals(ctx.getParams()['x'], '1');
      await letBuiltin(ctx, ['x = 0 || 0'], mockShell, noopExecute);
      assertEquals(ctx.getParams()['x'], '0');
    });

    await t.step('logical NOT (!)', async () => {
      const ctx = new ExecContext();
      await letBuiltin(ctx, ['x = !0'], mockShell, noopExecute);
      assertEquals(ctx.getParams()['x'], '1');
      await letBuiltin(ctx, ['x = !5'], mockShell, noopExecute);
      assertEquals(ctx.getParams()['x'], '0');
    });
  });

  await t.step('bitwise operators', async (t) => {
    await t.step('bitwise AND', async () => {
      const ctx = new ExecContext();
      await letBuiltin(ctx, ['x = 12 & 10'], mockShell, noopExecute); // 1100 & 1010 = 1000
      assertEquals(ctx.getParams()['x'], '8');
    });

    await t.step('bitwise OR', async () => {
      const ctx = new ExecContext();
      await letBuiltin(ctx, ['x = 12 | 10'], mockShell, noopExecute); // 1100 | 1010 = 1110
      assertEquals(ctx.getParams()['x'], '14');
    });

    await t.step('bitwise XOR', async () => {
      const ctx = new ExecContext();
      await letBuiltin(ctx, ['x = 12 ^ 10'], mockShell, noopExecute); // 1100 ^ 1010 = 0110
      assertEquals(ctx.getParams()['x'], '6');
    });

    await t.step('left shift', async () => {
      const ctx = new ExecContext();
      await letBuiltin(ctx, ['x = 1 << 4'], mockShell, noopExecute);
      assertEquals(ctx.getParams()['x'], '16');
    });

    await t.step('right shift', async () => {
      const ctx = new ExecContext();
      await letBuiltin(ctx, ['x = 16 >> 2'], mockShell, noopExecute);
      assertEquals(ctx.getParams()['x'], '4');
    });
  });

  await t.step('ternary operator', async () => {
    const ctx = new ExecContext();
    await letBuiltin(ctx, ['x = 1 ? 10 : 20'], mockShell, noopExecute);
    assertEquals(ctx.getParams()['x'], '10');
    await letBuiltin(ctx, ['x = 0 ? 10 : 20'], mockShell, noopExecute);
    assertEquals(ctx.getParams()['x'], '20');
  });

  await t.step('parentheses for grouping', async () => {
    const ctx = new ExecContext();
    await letBuiltin(ctx, ['x = (2 + 3) * 4'], mockShell, noopExecute);
    assertEquals(ctx.getParams()['x'], '20');
  });

  await t.step('comma operator', async () => {
    const ctx = new ExecContext();
    const result = await letBuiltin(ctx, ['a = 1, b = 2, c = 3'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['a'], '1');
    assertEquals(ctx.getParams()['b'], '2');
    assertEquals(ctx.getParams()['c'], '3');
  });

  await t.step('multiple arguments', async () => {
    const ctx = new ExecContext();
    const result = await letBuiltin(ctx, ['x = 5', 'y = 10'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['x'], '5');
    assertEquals(ctx.getParams()['y'], '10');
  });

  await t.step('uses existing variables', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ a: '5', b: '3' });
    const result = await letBuiltin(ctx, ['x = a + b'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['x'], '8');
  });

  await t.step('undefined variable defaults to 0', async () => {
    const ctx = new ExecContext();
    const result = await letBuiltin(ctx, ['x = undefined_var + 5'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getParams()['x'], '5');
  });
});

Deno.test('let as bash has it', async (t) => {
  await t.step('it sets shell variables, and exports only what was exported', async () => {
    const ctx = new ExecContext();
    ctx.setEnv({ E: '1' });
    await letBuiltin(ctx, ['x = 5', 'E += 1'], mockShell, noopExecute);
    assertEquals([ctx.getEnv()['x'], ctx.getParams()['x'], ctx.getEnv()['E']], [undefined, '5', '2']);
  });

  await t.step('a readonly variable is not assigned', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ r: '1' });
    ctx.setReadonlyVar('r', true);
    const result = await letBuiltin(ctx, ['r = 2'], mockShell, noopExecute);
    assertEquals([result.code, result.stderr, ctx.getParams()['r']], [1, 'r: readonly variable\n', '1']);
  });

  await t.step('division by zero is an error', async () => {
    const result = await letBuiltin(new ExecContext(), ['1/0'], mockShell, noopExecute);
    assertEquals([result.code, result.stderr], [1, 'let: 1/0: division by 0 (error token is "0")\n']);
  });
});
