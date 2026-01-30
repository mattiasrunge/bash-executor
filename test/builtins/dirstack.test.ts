import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { dirsBuiltin, popdBuiltin, pushdBuiltin } from '../../src/builtins/dirstack.ts';
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

// Setup function to create context (dirstack is now per-context)
function setup(cwd: string = '/home/user'): ExecContext {
  const ctx = new ExecContext();
  ctx.setCwd(cwd);
  return ctx;
}

Deno.test('dirs builtin', async (t) => {
  await t.step('shows current directory when stack is empty', async () => {
    const ctx = setup('/home/user');
    const result = await dirsBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(result.stdout?.trim(), '/home/user');
  });

  await t.step('-c clears the stack', async () => {
    const ctx = setup('/home/user');
    // First push something
    await pushdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    // Then clear
    const result = await dirsBuiltin(ctx, ['-c'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    // Stack should be empty now
    const dirsResult = await dirsBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(dirsResult.stdout?.trim(), '/tmp');
  });

  await t.step('-v shows verbose output', async () => {
    const ctx = setup('/home/user');
    await pushdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    const result = await dirsBuiltin(ctx, ['-v'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout || '', '0  /tmp');
    assertStringIncludes(result.stdout || '', '1  /home/user');
  });

  await t.step('-p shows one per line', async () => {
    const ctx = setup('/home/user');
    await pushdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    const result = await dirsBuiltin(ctx, ['-p'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    const lines = (result.stdout || '').trim().split('\n');
    assertEquals(lines.length, 2);
    assertEquals(lines[0], '/tmp');
    assertEquals(lines[1], '/home/user');
  });
});

Deno.test('pushd builtin', async (t) => {
  await t.step('pushes directory and changes to it', async () => {
    const ctx = setup('/home/user');
    const result = await pushdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/tmp');
    assertStringIncludes(result.stdout || '', '/tmp');
    assertStringIncludes(result.stdout || '', '/home/user');
  });

  await t.step('no args exchanges top two directories', async () => {
    const ctx = setup('/home/user');
    await pushdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    // Now at /tmp with /home/user in stack
    const result = await pushdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user');
  });

  await t.step('no args with empty stack returns error', async () => {
    const ctx = setup('/home/user');
    const result = await pushdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr || '', 'no other directory');
  });

  await t.step('-n suppresses directory change', async () => {
    const ctx = setup('/home/user');
    const result = await pushdBuiltin(ctx, ['-n', '/tmp'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user'); // Didn't change
  });

  await t.step('handles relative paths', async () => {
    const ctx = setup('/home/user');
    const result = await pushdBuiltin(ctx, ['documents'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user/documents');
  });

  await t.step('handles .. in paths', async () => {
    const ctx = setup('/home/user/documents');
    const result = await pushdBuiltin(ctx, ['../downloads'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user/downloads');
  });
});

Deno.test('popd builtin', async (t) => {
  await t.step('pops directory and changes to it', async () => {
    const ctx = setup('/home/user');
    await pushdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    // Now at /tmp
    const result = await popdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/home/user');
  });

  await t.step('empty stack returns error', async () => {
    const ctx = setup('/home/user');
    const result = await popdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr || '', 'directory stack empty');
  });

  await t.step('-n suppresses directory change', async () => {
    const ctx = setup('/home/user');
    await pushdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    // Now at /tmp with /home/user in stack
    const result = await popdBuiltin(ctx, ['-n'], mockShell, noopExecute);
    assertEquals(result.code, 0);
    assertEquals(ctx.getCwd(), '/tmp'); // Didn't change
  });

  await t.step('multiple pushd and popd', async () => {
    const ctx = setup('/home/user');
    await pushdBuiltin(ctx, ['/tmp'], mockShell, noopExecute);
    await pushdBuiltin(ctx, ['/var'], mockShell, noopExecute);
    // Stack: /var (current), /tmp, /home/user
    assertEquals(ctx.getCwd(), '/var');

    await popdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(ctx.getCwd(), '/tmp');

    await popdBuiltin(ctx, [], mockShell, noopExecute);
    assertEquals(ctx.getCwd(), '/home/user');
  });
});
