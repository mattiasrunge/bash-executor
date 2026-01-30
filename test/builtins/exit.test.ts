import { assertEquals } from 'jsr:@std/assert';
import { ExecContext } from '../../src/context.ts';
import {
  exitBuiltin,
  returnBuiltin,
  isExitSignal,
  isReturnSignal,
  getExitCode,
  getReturnCode,
  makeExitSignal,
  makeReturnSignal,
  EXIT_SIGNAL_BASE,
  RETURN_SIGNAL_BASE,
} from '../../src/builtins/exit.ts';

// Mock shell for testing
const mockShell = {} as Parameters<typeof exitBuiltin>[2];

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

Deno.test('exit builtin', async (t) => {
  await t.step('exits with code 0 by default', async () => {
    const ctx = new ExecContext();
    const result = await exitBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(isExitSignal(result.code), true);
    assertEquals(getExitCode(result.code), 0);
  });

  await t.step('exits with specified code', async () => {
    const ctx = new ExecContext();
    const result = await exitBuiltin(ctx, ['42'], mockShell, noopExecute);
    assertEquals(isExitSignal(result.code), true);
    assertEquals(getExitCode(result.code), 42);
  });

  await t.step('exits with code 0 for "0"', async () => {
    const ctx = new ExecContext();
    const result = await exitBuiltin(ctx, ['0'], mockShell, noopExecute);
    assertEquals(isExitSignal(result.code), true);
    assertEquals(getExitCode(result.code), 0);
  });

  await t.step('exits with code 1 for "1"', async () => {
    const ctx = new ExecContext();
    const result = await exitBuiltin(ctx, ['1'], mockShell, noopExecute);
    assertEquals(isExitSignal(result.code), true);
    assertEquals(getExitCode(result.code), 1);
  });

  await t.step('wraps exit codes > 255 with modulo 256', async () => {
    const ctx = new ExecContext();
    const result = await exitBuiltin(ctx, ['256'], mockShell, noopExecute);
    assertEquals(getExitCode(result.code), 0);

    const result2 = await exitBuiltin(ctx, ['257'], mockShell, noopExecute);
    assertEquals(getExitCode(result2.code), 1);
  });

  await t.step('handles negative exit codes', async () => {
    const ctx = new ExecContext();
    const result = await exitBuiltin(ctx, ['-1'], mockShell, noopExecute);
    assertEquals(getExitCode(result.code), 255);
  });

  await t.step('returns error for non-numeric argument', async () => {
    const ctx = new ExecContext();
    const result = await exitBuiltin(ctx, ['abc'], mockShell, noopExecute);
    assertEquals(result.code, 2);
    assertEquals(result.stderr, 'exit: abc: numeric argument required\n');
  });

  await t.step('uses last exit code from context when no argument', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '?': '5' });
    const result = await exitBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(getExitCode(result.code), 5);
  });
});

Deno.test('return builtin', async (t) => {
  await t.step('returns with code 0 by default', async () => {
    const ctx = new ExecContext();
    const result = await returnBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(isReturnSignal(result.code), true);
    assertEquals(getReturnCode(result.code), 0);
  });

  await t.step('returns with specified code', async () => {
    const ctx = new ExecContext();
    const result = await returnBuiltin(ctx, ['42'], mockShell, noopExecute);
    assertEquals(isReturnSignal(result.code), true);
    assertEquals(getReturnCode(result.code), 42);
  });

  await t.step('wraps return codes > 255 with modulo 256', async () => {
    const ctx = new ExecContext();
    const result = await returnBuiltin(ctx, ['256'], mockShell, noopExecute);
    assertEquals(getReturnCode(result.code), 0);
  });

  await t.step('returns error for non-numeric argument', async () => {
    const ctx = new ExecContext();
    const result = await returnBuiltin(ctx, ['abc'], mockShell, noopExecute);
    assertEquals(result.code, 2);
    assertEquals(result.stderr, 'return: abc: numeric argument required\n');
  });

  await t.step('uses last exit code from context when no argument', async () => {
    const ctx = new ExecContext();
    ctx.setParams({ '?': '7' });
    const result = await returnBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(getReturnCode(result.code), 7);
  });
});

Deno.test('signal helper functions', async (t) => {
  await t.step('isExitSignal correctly identifies exit signals', () => {
    assertEquals(isExitSignal(makeExitSignal(0)), true);
    assertEquals(isExitSignal(makeExitSignal(1)), true);
    assertEquals(isExitSignal(makeExitSignal(255)), true);
    assertEquals(isExitSignal(0), false);
    assertEquals(isExitSignal(1), false);
    assertEquals(isExitSignal(-1), false);
  });

  await t.step('isReturnSignal correctly identifies return signals', () => {
    assertEquals(isReturnSignal(makeReturnSignal(0)), true);
    assertEquals(isReturnSignal(makeReturnSignal(1)), true);
    assertEquals(isReturnSignal(makeReturnSignal(255)), true);
    assertEquals(isReturnSignal(0), false);
    assertEquals(isReturnSignal(1), false);
    assertEquals(isReturnSignal(makeExitSignal(0)), false); // exit signal is not return signal
  });

  await t.step('getExitCode extracts correct code from exit signal', () => {
    assertEquals(getExitCode(makeExitSignal(0)), 0);
    assertEquals(getExitCode(makeExitSignal(1)), 1);
    assertEquals(getExitCode(makeExitSignal(42)), 42);
    assertEquals(getExitCode(makeExitSignal(255)), 255);
  });

  await t.step('getReturnCode extracts correct code from return signal', () => {
    assertEquals(getReturnCode(makeReturnSignal(0)), 0);
    assertEquals(getReturnCode(makeReturnSignal(1)), 1);
    assertEquals(getReturnCode(makeReturnSignal(42)), 42);
    assertEquals(getReturnCode(makeReturnSignal(255)), 255);
  });

  await t.step('exit and return signals are distinct', () => {
    const exitSig = makeExitSignal(5);
    const returnSig = makeReturnSignal(5);
    assertEquals(exitSig !== returnSig, true);
    assertEquals(isExitSignal(exitSig), true);
    assertEquals(isReturnSignal(exitSig), false);
    assertEquals(isExitSignal(returnSig), false);
    assertEquals(isReturnSignal(returnSig), true);
  });
});
