import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { createBuiltinBuiltin, createCommandBuiltin, createTypeBuiltin } from '../../src/builtins/introspection.ts';
import { createBuiltinRegistry } from '../../src/builtins/mod.ts';
import { ExecContext } from '../../src/context.ts';
import type { ExecContextIf, ShellIf } from '../../src/types.ts';

// No-op execute function for tests
const noopExecute = async (_script: string) => 0;

// Mock shell that simulates which command
function createMockShell(
  whichResults: Record<string, string> = {},
  execResults: Record<string, number> = {},
): ShellIf {
  const pipes = new Map<string, string>();
  return {
    execute: async (
      ctx: ExecContextIf,
      name: string,
      args: string[],
    ): Promise<number> => {
      // Simulate 'which' command
      if (name === 'which' && args.length > 0) {
        const cmd = args[0];
        if (cmd in whichResults) {
          // Write result to stdout pipe
          const stdout = ctx.getStdout();
          if (pipes.has(stdout)) {
            pipes.set(stdout, (pipes.get(stdout) || '') + whichResults[cmd]);
          }
          return 0;
        }
        return 1;
      }
      return execResults[name] ?? 0;
    },
    pipeOpen: async () => {
      const name = `pipe_${pipes.size}`;
      pipes.set(name, '');
      return name;
    },
    pipeClose: async () => {},
    pipeRemove: async (name: string) => {
      pipes.delete(name);
    },
    pipeRead: async (name: string) => pipes.get(name) || '',
    pipeWrite: async (name: string, data: string) => {
      if (data === '') {
        // EOF signal - do nothing
        return;
      }
      pipes.set(name, (pipes.get(name) || '') + data);
    },
    isPipe: (name: string) => name === '0' || name === '1' || name === '2' || pipes.has(name),
    pipeFromFile: async () => {
      throw new Error('Not implemented');
    },
    pipeToFile: async () => {
      throw new Error('Not implemented');
    },
  };
}

Deno.test('type builtin', async (t) => {
  const registry = createBuiltinRegistry();
  const typeBuiltin = createTypeBuiltin(registry);

  await t.step('no arguments returns error', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await typeBuiltin(ctx, [], shell, noopExecute);
    assertEquals(result.code, 1);
  });

  await t.step('identifies builtin', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await typeBuiltin(ctx, ['echo'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout || '', 'echo is a shell builtin');
  });

  await t.step('identifies external command', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell({ ls: '/bin/ls' });
    const result = await typeBuiltin(ctx, ['ls'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout || '', 'ls is /bin/ls');
  });

  await t.step('identifies alias', async () => {
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -la');
    const shell = createMockShell();
    const result = await typeBuiltin(ctx, ['ll'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout || '', "ll is aliased to `ls -la'");
  });

  await t.step('-t returns type only', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await typeBuiltin(ctx, ['-t', 'echo'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout?.trim(), 'builtin');
  });

  await t.step('-t file for external command', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell({ ls: '/bin/ls' });
    const result = await typeBuiltin(ctx, ['-t', 'ls'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout?.trim(), 'file');
  });

  await t.step('returns error for unknown command', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await typeBuiltin(ctx, ['nonexistent'], shell, noopExecute);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stdout || '', 'not found');
  });
});

Deno.test('command builtin', async (t) => {
  const registry = createBuiltinRegistry();
  const commandBuiltin = createCommandBuiltin(registry);

  await t.step('no arguments returns success', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await commandBuiltin(ctx, [], shell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('executes builtin', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await commandBuiltin(ctx, ['true'], shell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('executes external command', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell({}, { ls: 0 });
    const result = await commandBuiltin(ctx, ['ls'], shell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('-v prints builtin name', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await commandBuiltin(ctx, ['-v', 'echo'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout?.trim(), 'echo');
  });

  await t.step('-v prints path for external command', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell({ ls: '/bin/ls' });
    const result = await commandBuiltin(ctx, ['-v', 'ls'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout?.trim(), '/bin/ls');
  });

  await t.step('-v returns error for unknown command', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await commandBuiltin(ctx, ['-v', 'nonexistent'], shell, noopExecute);
    assertEquals(result.code, 1);
  });

  await t.step('-V prints verbose info for builtin', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await commandBuiltin(ctx, ['-V', 'echo'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout || '', 'echo is a shell builtin');
  });
});

Deno.test('builtin builtin', async (t) => {
  const registry = createBuiltinRegistry();
  const builtinBuiltin = createBuiltinBuiltin(registry);

  await t.step('no arguments returns success', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await builtinBuiltin(ctx, [], shell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('executes builtin', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await builtinBuiltin(ctx, ['true'], shell, noopExecute);
    assertEquals(result.code, 0);
  });

  await t.step('returns error for non-builtin', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await builtinBuiltin(ctx, ['ls'], shell, noopExecute);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr || '', 'ls: not a shell builtin');
  });

  await t.step('passes arguments to builtin', async () => {
    const ctx = new ExecContext();
    const shell = createMockShell();
    const result = await builtinBuiltin(ctx, ['echo', '-n', 'hello'], shell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, 'hello');
  });
});
