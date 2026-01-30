import { assertEquals } from 'jsr:@std/assert';
import { readBuiltin } from '../../src/builtins/read.ts';
import { ExecContext } from '../../src/context.ts';
import type { ShellIf } from '../../src/types.ts';

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

// Mock shell that provides input via pipeRead
function createMockShell(input: string): ShellIf & { writtenOutput: string } {
  const shell = {
    writtenOutput: '',
    pipeRead: async (_name: string): Promise<string> => {
      return input;
    },
    pipeWrite: async (_name: string, data: string): Promise<void> => {
      shell.writtenOutput += data;
    },
    execute: async () => 0,
    pipeOpen: async () => 'pipe',
    pipeClose: async () => {},
    pipeRemove: async () => {},
    isPipe: () => true,
    pipeFromFile: async () => {},
    pipeToFile: async () => {},
  };
  return shell;
}

Deno.test('read builtin', async (t) => {
  await t.step('reads into REPLY by default', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('hello world\n');
    const result = await readBuiltin(ctx, [], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['REPLY'], 'hello world');
  });

  await t.step('reads into named variable', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('hello\n');
    const result = await readBuiltin(ctx, ['name'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['name'], 'hello');
  });

  await t.step('splits input into multiple variables', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('John 25 Engineer\n');
    const result = await readBuiltin(ctx, ['name', 'age', 'job'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['name'], 'John');
    assertEquals(ctx.getEnv()['age'], '25');
    assertEquals(ctx.getEnv()['job'], 'Engineer');
  });

  await t.step('last variable gets remaining words', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('a b c d e\n');
    const result = await readBuiltin(ctx, ['first', 'rest'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['first'], 'a');
    assertEquals(ctx.getEnv()['rest'], 'b c d e');
  });

  await t.step('handles fewer words than variables', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('one\n');
    const result = await readBuiltin(ctx, ['a', 'b', 'c'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['a'], 'one');
    assertEquals(ctx.getEnv()['b'], '');
    assertEquals(ctx.getEnv()['c'], '');
  });

  await t.step('returns 1 on empty input', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('');
    const result = await readBuiltin(ctx, ['name'], shell, noopExecute);
    assertEquals(result.code, 1);
  });

  await t.step('prompt option', async (t) => {
    await t.step('-p outputs prompt', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell('John\n');
      const result = await readBuiltin(ctx, ['-p', 'Name: ', 'name'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(shell.writtenOutput, 'Name: ');
      assertEquals(ctx.getEnv()['name'], 'John');
    });
  });

  await t.step('raw mode option', async (t) => {
    await t.step('-r preserves backslashes', async () => {
      const ctx = new ExecContext();
      const shell = createMockShell('path\\file\n');
      const result = await readBuiltin(ctx, ['-r', 'path'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getEnv()['path'], 'path\\file');
    });

    await t.step('without -r processes backslashes', async () => {
      const ctx = new ExecContext();
      // Input: hello\nworld (backslash-n), which becomes hello<newline>world
      // Then IFS splits on newline, giving ["hello", "world"]
      // Single variable gets words joined with space: "hello world"
      const shell = createMockShell('hello\\nworld\n');
      const result = await readBuiltin(ctx, ['text'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getEnv()['text'], 'hello world');
    });
  });

  await t.step('respects IFS', async (t) => {
    await t.step('custom IFS', async () => {
      const ctx = new ExecContext();
      ctx.setEnv({ IFS: ':' });
      const shell = createMockShell('a:b:c\n');
      const result = await readBuiltin(ctx, ['x', 'y', 'z'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getEnv()['x'], 'a');
      assertEquals(ctx.getEnv()['y'], 'b');
      assertEquals(ctx.getEnv()['z'], 'c');
    });

    await t.step('empty IFS means no splitting', async () => {
      const ctx = new ExecContext();
      ctx.setEnv({ IFS: '' });
      const shell = createMockShell('a b c\n');
      const result = await readBuiltin(ctx, ['line'], shell, noopExecute);
      assertEquals(result.code, 0);
      assertEquals(ctx.getEnv()['line'], 'a b c');
    });
  });

  await t.step('handles multiple whitespace', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('  a   b   c  \n');
    const result = await readBuiltin(ctx, ['x', 'y', 'z'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['x'], 'a');
    assertEquals(ctx.getEnv()['y'], 'b');
    assertEquals(ctx.getEnv()['z'], 'c');
  });

  await t.step('-n reads limited characters', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell('hello world\n');
    const result = await readBuiltin(ctx, ['-n', '5', 'chars'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getEnv()['chars'], 'hello');
  });
});
