import { assertEquals, assertStringIncludes } from '@std/assert';
import { argBuiltin } from '../../src/builtins/arg.ts';
import { getExitCode, isExitSignal } from '../../src/builtins/exit.ts';
import { ExecContext } from '../../src/context.ts';

// Mock shell for testing
const mockShell = {} as Parameters<typeof argBuiltin>[2];

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

Deno.test('arg builtin', async (t) => {
  await t.step('declaration parsing', async (t) => {
    await t.step('--desc sets command description', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['--desc', 'Test command'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('required positional arg', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('optional positional arg with default', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['[<title>]', 'string', '=', 'Mr', 'Title prefix'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('long option', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('short and long option', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['-p', '--port', 'number', 'Port number'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('option with default', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['--port', 'number', '=', '8080', 'Port number'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('flag (boolean)', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['-v', '--verbose', 'Enable verbose mode'], mockShell, noopExecute);
      assertEquals(result.code, 0);
    });

    await t.step('error on missing arguments', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, [], mockShell, noopExecute);
      assertEquals(result.code, 1);
      assertStringIncludes(result.stderr!, 'missing arguments');
    });

    await t.step('error on invalid type', async () => {
      const ctx = new ExecContext();
      const result = await argBuiltin(ctx, ['<name>', 'invalid', 'Description'], mockShell, noopExecute);
      assertEquals(result.code, 1);
      assertStringIncludes(result.stderr!, 'invalid type');
    });
  });

  await t.step('--export parsing', async (t) => {
    await t.step('exports positional argument', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': 'alice',
        '#': '1',
      });

      await argBuiltin(ctx, ['<username>', 'string', 'User name'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['USERNAME'], 'alice');
    });

    await t.step('exports optional positional with default', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': 'alice',
        '#': '1',
      });

      await argBuiltin(ctx, ['<username>', 'string', 'User name'], mockShell, noopExecute);
      await argBuiltin(ctx, ['[<title>]', 'string', '=', 'User', 'Title'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['USERNAME'], 'alice');
      assertEquals(ctx.getEnv()['TITLE'], 'User');
    });

    await t.step('exports flag as 1 when set', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--verbose',
        '#': '1',
      });

      await argBuiltin(ctx, ['-v', '--verbose', 'Verbose mode'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['VERBOSE'], '1');
    });

    await t.step('exports flag as empty when not set', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '#': '0',
      });

      await argBuiltin(ctx, ['-v', '--verbose', 'Verbose mode'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['VERBOSE'], '');
    });

    await t.step('exports option with value', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--port',
        '2': '3000',
        '#': '2',
      });

      await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['PORT'], '3000');
    });

    await t.step('exports option with = syntax', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--port=3000',
        '#': '1',
      });

      await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['PORT'], '3000');
    });

    await t.step('handles mixed positionals and options', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': 'alice',
        '2': '--verbose',
        '3': '--port',
        '4': '8080',
        '#': '4',
      });

      await argBuiltin(ctx, ['<username>', 'string', 'User name'], mockShell, noopExecute);
      await argBuiltin(ctx, ['-v', '--verbose', 'Verbose mode'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['USERNAME'], 'alice');
      assertEquals(ctx.getEnv()['VERBOSE'], '1');
      assertEquals(ctx.getEnv()['PORT'], '8080');
    });

    await t.step('applies option default when not provided', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '#': '0',
      });

      await argBuiltin(ctx, ['--port', 'number', '=', '8080', 'Port number'], mockShell, noopExecute);
      await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(ctx.getEnv()['PORT'], '8080');
    });
  });

  await t.step('--help handling', async (t) => {
    await t.step('exits with signal 0 on --help', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--help',
        '#': '1',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 0);
    });

    await t.step('exits with signal 0 on -h', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '-h',
        '#': '1',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 0);
    });

    await t.step('generates help text with usage', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--help',
        '#': '1',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['--desc', 'Test command'], mockShell, noopExecute);
      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      await argBuiltin(ctx, ['-v', '--verbose', 'Verbose mode'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertStringIncludes(result.stdout!, 'Usage: myscript');
      assertStringIncludes(result.stdout!, '<name>');
      assertStringIncludes(result.stdout!, 'Test command');
      assertStringIncludes(result.stdout!, '--verbose');
      assertStringIncludes(result.stdout!, '-h, --help');
    });
  });

  await t.step('error handling', async (t) => {
    await t.step('exits with error on missing required arg', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '#': '0',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 1);
      assertStringIncludes(result.stderr!, 'Missing required argument');
    });

    await t.step('exits with error on unknown option', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--unknown',
        '#': '1',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 1);
      assertStringIncludes(result.stderr!, 'Unknown option');
    });

    await t.step('validates number type', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '1': '--port',
        '2': 'abc',
        '#': '2',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['--port', 'number', 'Port number'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertEquals(isExitSignal(result.code), true);
      assertEquals(getExitCode(result.code), 1);
      assertStringIncludes(result.stderr!, 'numeric value');
    });

    await t.step('suggests --help on error', async () => {
      const ctx = new ExecContext();
      ctx.setParams({
        '#': '0',
        '0': 'myscript',
      });

      await argBuiltin(ctx, ['<name>', 'string', 'User name'], mockShell, noopExecute);
      const result = await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

      assertStringIncludes(result.stderr!, '--help');
    });
  });

  await t.step('-- separator', async () => {
    const ctx = new ExecContext();
    ctx.setParams({
      '1': '--',
      '2': '--name',
      '#': '2',
    });

    await argBuiltin(ctx, ['<arg>', 'string', 'Argument'], mockShell, noopExecute);
    await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

    // --name should be treated as a positional after --
    assertEquals(ctx.getEnv()['ARG'], '--name');
  });

  await t.step('short option -x with value', async () => {
    const ctx = new ExecContext();
    ctx.setParams({
      '1': '-p',
      '2': '3000',
      '#': '2',
    });

    await argBuiltin(ctx, ['-p', '--port', 'number', 'Port number'], mockShell, noopExecute);
    await argBuiltin(ctx, ['--export'], mockShell, noopExecute);

    assertEquals(ctx.getEnv()['PORT'], '3000');
  });

  await t.step('context isolation', async () => {
    // Registry should be per-context
    const ctx1 = new ExecContext();
    const ctx2 = new ExecContext();

    await argBuiltin(ctx1, ['<name>', 'string', 'Name'], mockShell, noopExecute);

    // ctx2 should have no registry
    ctx2.setParams({ '#': '0' });
    const result = await argBuiltin(ctx2, ['--export'], mockShell, noopExecute);

    // Should succeed with no error (no args defined means nothing to do)
    assertEquals(result.code, 0);
  });
});
