import { assertEquals } from 'jsr:@std/assert';
import { dotBuiltin, sourceBuiltin } from '../../src/builtins/source.ts';
import { ExecContext } from '../../src/context.ts';
import type { ShellIf } from '../../src/types.ts';

// Mock shell that simulates file reading
function createMockShell(
  fileContents: Record<string, string> = {},
): ShellIf {
  return {
    execute: async () => 0,
    pipeOpen: async () => 'pipe',
    pipeClose: async () => {},
    pipeRemove: async () => {},
    pipeRead: async () => '',
    pipeWrite: async () => {},
    isPipe: () => true,
    pipeFromFile: async () => {},
    pipeToFile: async () => {},
    readFile: async (_ctx, filename) => {
      if (filename in fileContents) {
        return fileContents[filename];
      }

      throw new Error(`No such file or directory`);
    },
  };
}

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

Deno.test('source builtin', async (t) => {
  await t.step('no arguments returns error', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const mock = createMockExecute();
    const result = await sourceBuiltin(ctx, [], shell, mock.execute);
    assertEquals(result.code, 2);
    assertEquals(result.stderr, 'source: filename argument required\n');
  });

  await t.step('sources file content', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell({
      '/tmp/test.sh': 'echo hello',
    });
    const mock = createMockExecute();
    const result = await sourceBuiltin(ctx, ['/tmp/test.sh'], shell, mock.execute);
    assertEquals(result.code, 0);
    assertEquals(mock.lastScript, 'echo hello');
  });

  await t.step('returns error for non-existent file', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const mock = createMockExecute();
    const result = await sourceBuiltin(ctx, ['/nonexistent.sh'], shell, mock.execute);
    assertEquals(result.code, 1);
    assertEquals(result.stderr?.includes('/nonexistent.sh'), true);
  });

  await t.step('returns exit code from script execution', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell(
      { '/tmp/test.sh': 'exit 42' },
    );
    const mock = createMockExecute(42);
    const result = await sourceBuiltin(ctx, ['/tmp/test.sh'], shell, mock.execute);
    assertEquals(result.code, 42);
  });

  await t.step('handles multi-line scripts', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell({
      '/tmp/multi.sh': 'x=1\ny=2\necho $x $y',
    });
    const mock = createMockExecute();
    const result = await sourceBuiltin(ctx, ['/tmp/multi.sh'], shell, mock.execute);
    assertEquals(result.code, 0);
    assertEquals(mock.lastScript, 'x=1\ny=2\necho $x $y');
  });
});

Deno.test('. builtin', async (t) => {
  await t.step('is an alias for source', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell({
      '/tmp/test.sh': 'echo dot',
    });
    const mock = createMockExecute();
    const result = await dotBuiltin(ctx, ['/tmp/test.sh'], shell, mock.execute);
    assertEquals(result.code, 0);
    assertEquals(mock.lastScript, 'echo dot');
  });

  await t.step('returns same errors as source', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const mock = createMockExecute();
    const result = await dotBuiltin(ctx, [], shell, mock.execute);
    assertEquals(result.code, 2);
    assertEquals(result.stderr, 'source: filename argument required\n');
  });
});
