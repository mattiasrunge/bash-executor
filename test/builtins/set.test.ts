import { assertEquals, assertStringIncludes } from '@std/assert';
import { getShellOption, resetShellOptions, setBuiltin } from '../../src/builtins/set.ts';
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

// Setup function
function setup(): ExecContext {
  resetShellOptions();
  return new ExecContext();
}

Deno.test('set builtin', async (t) => {
  await t.step('no arguments displays variables', async () => {
    const ctx = setup();
    ctx.setEnv({ FOO: 'bar', BAZ: 'qux' });
    const result = await setBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout || '', "FOO='bar'");
    assertStringIncludes(result.stdout || '', "BAZ='qux'");
  });

  await t.step('sets positional parameters with --', async () => {
    const ctx = setup();
    const result = await setBuiltin(ctx, ['--', 'a', 'b', 'c'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    const params = ctx.getParams();
    assertEquals(params['1'], 'a');
    assertEquals(params['2'], 'b');
    assertEquals(params['3'], 'c');
    assertEquals(params['#'], '3');
  });

  await t.step('clears positional parameters with --', async () => {
    const ctx = setup();
    ctx.setParams({ '1': 'old1', '2': 'old2', '#': '2' });

    const result = await setBuiltin(ctx, ['--', 'new1'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    const params = ctx.getParams();
    assertEquals(params['1'], 'new1');
    assertEquals(params['2'], undefined);
    assertEquals(params['#'], '1');
  });

  await t.step('empty -- clears all positional parameters', async () => {
    const ctx = setup();
    ctx.setParams({ '1': 'a', '2': 'b', '#': '2' });

    const result = await setBuiltin(ctx, ['--'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    const params = ctx.getParams();
    assertEquals(params['1'], undefined);
    assertEquals(params['2'], undefined);
    assertEquals(params['#'], '0');
  });

  await t.step('enables options with -', async (t) => {
    await t.step('-e enables errexit', async () => {
      setup();
      const ctx = new ExecContext();
      const result = await setBuiltin(ctx, ['-e'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(getShellOption('errexit'), true);
    });

    await t.step('-x enables xtrace', async () => {
      setup();
      const ctx = new ExecContext();
      const result = await setBuiltin(ctx, ['-x'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(getShellOption('xtrace'), true);
    });

    await t.step('-u enables nounset', async () => {
      setup();
      const ctx = new ExecContext();
      const result = await setBuiltin(ctx, ['-u'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(getShellOption('nounset'), true);
    });

    await t.step('multiple flags -eu', async () => {
      setup();
      const ctx = new ExecContext();
      const result = await setBuiltin(ctx, ['-eu'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(getShellOption('errexit'), true);
      assertEquals(getShellOption('nounset'), true);
    });
  });

  await t.step('disables options with +', async (t) => {
    await t.step('+e disables errexit', async () => {
      setup();
      const ctx = new ExecContext();
      await setBuiltin(ctx, ['-e'], mockShell, noopExecute);
      assertEquals(getShellOption('errexit'), true);

      await setBuiltin(ctx, ['+e'], mockShell, noopExecute);
      assertEquals(getShellOption('errexit'), false);
    });
  });

  await t.step('-o sets option by name', async () => {
    setup();
    const ctx = new ExecContext();
    const result = await setBuiltin(ctx, ['-o', 'errexit'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(getShellOption('errexit'), true);
  });

  await t.step('+o unsets option by name', async () => {
    setup();
    const ctx = new ExecContext();
    await setBuiltin(ctx, ['-o', 'errexit'], mockShell, noopExecute);
    const result = await setBuiltin(ctx, ['+o', 'errexit'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(getShellOption('errexit'), false);
  });

  await t.step('-o without name shows options', async () => {
    setup();
    const ctx = new ExecContext();
    const result = await setBuiltin(ctx, ['-o'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout || '', 'errexit');
  });

  await t.step('invalid option returns error', async () => {
    setup();
    const ctx = new ExecContext();
    const result = await setBuiltin(ctx, ['-o', 'invalid_option'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr || '', 'invalid option name');
  });

  await t.step('invalid short option returns error', async () => {
    setup();
    const ctx = new ExecContext();
    const result = await setBuiltin(ctx, ['-z'], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr || '', 'invalid option');
  });

  await t.step('- alone turns off xtrace and verbose', async () => {
    setup();
    const ctx = new ExecContext();
    await setBuiltin(ctx, ['-xv'], mockShell, noopExecute);
    assertEquals(getShellOption('xtrace'), true);
    assertEquals(getShellOption('verbose'), true);

    await setBuiltin(ctx, ['-'], mockShell, noopExecute);
    assertEquals(getShellOption('xtrace'), false);
    assertEquals(getShellOption('verbose'), false);
  });
});
