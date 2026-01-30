import { assertEquals } from '@std/assert';
import { evalBuiltin } from '../../src/builtins/eval.ts';
import { ExecContext } from '../../src/context.ts';
import type { ShellIf } from '../../src/types.ts';

// Mock shell (minimal implementation)
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

// Create a mock execute function that records the script
function createMockExecute(
  result: number = 0,
): { execute: (script: string) => Promise<number>; lastScript: string | null } {
  const mock = {
    lastScript: null as string | null,
    execute: async (script: string): Promise<number> => {
      mock.lastScript = script;
      return result;
    },
  };
  return mock;
}

Deno.test('eval builtin', async (t) => {
  await t.step('no arguments returns success', async () => {
    const ctx = new ExecContext();
    const mock = createMockExecute();
    const result = await evalBuiltin(ctx, [], mockShell, mock.execute);
    assertEquals(result.code, 0);
    assertEquals(mock.lastScript, null);
  });

  await t.step('single argument executes script', async () => {
    const ctx = new ExecContext();
    const mock = createMockExecute();
    const result = await evalBuiltin(ctx, ['echo hello'], mockShell, mock.execute);
    assertEquals(result.code, 0);
    assertEquals(mock.lastScript, 'echo hello');
  });

  await t.step('multiple arguments are joined with spaces', async () => {
    const ctx = new ExecContext();
    const mock = createMockExecute();
    const result = await evalBuiltin(ctx, ['echo', 'hello', 'world'], mockShell, mock.execute);
    assertEquals(result.code, 0);
    assertEquals(mock.lastScript, 'echo hello world');
  });

  await t.step('returns exit code from execute', async () => {
    const ctx = new ExecContext();
    const mock = createMockExecute(42);
    const result = await evalBuiltin(ctx, ['exit 42'], mockShell, mock.execute);
    assertEquals(result.code, 42);
  });

  await t.step('passes complex script to execute', async () => {
    const ctx = new ExecContext();
    const mock = createMockExecute();
    const result = await evalBuiltin(ctx, ['x=5; echo $x'], mockShell, mock.execute);
    assertEquals(result.code, 0);
    assertEquals(mock.lastScript, 'x=5; echo $x');
  });

  await t.step('handles quoted arguments', async () => {
    const ctx = new ExecContext();
    const mock = createMockExecute();
    // When eval receives arguments, they've already been parsed
    // So 'echo "hello world"' arrives as a single arg
    const result = await evalBuiltin(ctx, ['echo "hello world"'], mockShell, mock.execute);
    assertEquals(result.code, 0);
    assertEquals(mock.lastScript, 'echo "hello world"');
  });
});
