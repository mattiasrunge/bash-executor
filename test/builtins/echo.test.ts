import { assertEquals } from 'jsr:@std/assert';
import { ExecContext } from '../../src/context.ts';
import { echoBuiltin } from '../../src/builtins/echo.ts';

// Mock shell for testing
const mockShell = {} as Parameters<typeof echoBuiltin>[2];

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

Deno.test('echo builtin', async (t) => {
  await t.step('basic output', async (t) => {
    await t.step('outputs arguments with trailing newline', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['hello', 'world'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello world\n');
    });

    await t.step('outputs empty line with no arguments', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, [], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '\n');
    });

    await t.step('outputs single argument', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['hello'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\n');
    });
  });

  await t.step('-n flag (no newline)', async (t) => {
    await t.step('suppresses trailing newline', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-n', 'hello'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello');
    });

    await t.step('outputs nothing with no arguments', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-n'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '');
    });
  });

  await t.step('-e flag (escape sequences)', async (t) => {
    await t.step('interprets \\n as newline', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-e', 'hello\\nworld'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\nworld\n');
    });

    await t.step('interprets \\t as tab', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-e', 'hello\\tworld'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\tworld\n');
    });

    await t.step('interprets \\\\ as backslash', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-e', 'hello\\\\world'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\\world\n');
    });

    await t.step('interprets \\r as carriage return', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-e', 'hello\\rworld'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\rworld\n');
    });

    await t.step('\\c stops output', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-e', 'hello\\cworld'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\n');
    });

    await t.step('interprets \\0nnn as octal', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-e', '\\0101'], mockShell, noopExecute); // 'A' in octal
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'A\n');
    });

    await t.step('interprets \\xHH as hex', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-e', '\\x41'], mockShell, noopExecute); // 'A' in hex
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'A\n');
    });
  });

  await t.step('-E flag (no escape interpretation)', async (t) => {
    await t.step('treats backslash literally', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-E', 'hello\\nworld'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\\nworld\n');
    });
  });

  await t.step('combined flags', async (t) => {
    await t.step('-ne combines no newline and escapes', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-ne', 'hello\\nworld'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\nworld');
    });

    await t.step('-en combines no newline and escapes', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-en', 'hello\\nworld'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\nworld');
    });

    await t.step('-n -e as separate flags', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-n', '-e', 'hello\\tworld'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, 'hello\tworld');
    });
  });

  await t.step('-- ends option parsing', async (t) => {
    await t.step('treats -n as argument after --', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['--', '-n'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '-n\n');
    });
  });

  await t.step('unknown flags treated as arguments', async (t) => {
    await t.step('-x is printed as argument', async () => {
      const ctx = new ExecContext();
      const result = await echoBuiltin(ctx, ['-x', 'hello'], mockShell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, '-x hello\n');
    });
  });
});
