import { assertEquals } from '@std/assert';
import { createBuiltinRegistry } from '../../src/builtins/mod.ts';
import { ExecContext } from '../../src/context.ts';
import { AstExecutor } from '../../src/executor.ts';
import type { ExecContextIf, ShellIf } from '../../src/types.ts';

/**
 * Minimal shell implementation for testing builtin integration.
 * Only implements the required methods.
 */
class MinimalTestShell implements ShellIf {
  private pipes: Map<string, string> = new Map();
  private pipeCounter = 0;
  public capturedOutput: string[] = [];

  async execute(
    _ctx: ExecContextIf,
    name: string,
    _args: string[],
    _opts: { async?: boolean },
  ): Promise<number> {
    // For testing, unknown commands fail
    return name === 'external_command' ? 0 : 127;
  }

  async pipeOpen(): Promise<string> {
    const name = `pipe_${this.pipeCounter++}`;
    this.pipes.set(name, '');
    return name;
  }

  async pipeClose(_name: string): Promise<void> {}

  async pipeRemove(name: string): Promise<void> {
    this.pipes.delete(name);
  }

  async pipeRead(name: string): Promise<string> {
    return this.pipes.get(name) ?? '';
  }

  async pipeWrite(name: string, data: string): Promise<void> {
    if (name === '1' || name === 'stdout') {
      this.capturedOutput.push(data);
    }
    const current = this.pipes.get(name) ?? '';
    this.pipes.set(name, current + data);
  }

  isPipe(name: string): boolean {
    return name === '0' || name === '1' || name === '2' || this.pipes.has(name);
  }

  async pipeFromFile(_ctx: ExecContextIf, _path: string, _pipe: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async pipeToFile(_ctx: ExecContextIf, _pipe: string, _path: string, _append: boolean): Promise<void> {
    throw new Error('Not implemented');
  }

  async run(_script: string): Promise<number> {
    return 0;
  }
}

Deno.test('Builtin Integration', async (t) => {
  await t.step('executor uses builtins from registry', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();

    // Test that echo builtin is used (outputs to captured)
    const code = await executor.execute('echo hello world', ctx);
    assertEquals(code, 0);
    assertEquals(shell.capturedOutput.includes('hello world\n'), true);
  });

  await t.step('pwd builtin returns cwd', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();
    ctx.setCwd('/test/dir');

    const code = await executor.execute('pwd', ctx);
    assertEquals(code, 0);
    assertEquals(shell.capturedOutput.includes('/test/dir\n'), true);
  });

  await t.step('true builtin returns 0', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();

    const code = await executor.execute('true', ctx);
    assertEquals(code, 0);
  });

  await t.step('false builtin returns 1', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();

    const code = await executor.execute('false', ctx);
    assertEquals(code, 1);
  });

  await t.step('colon builtin returns 0', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();

    const code = await executor.execute(':', ctx);
    assertEquals(code, 0);
  });

  await t.step('cd builtin changes directory', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();
    ctx.setCwd('/home/user');

    const code = await executor.execute('cd /tmp', ctx);
    assertEquals(code, 0);
    assertEquals(ctx.getCwd(), '/tmp');
  });

  await t.step('export builtin sets env variable', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();

    const code = await executor.execute('export FOO=bar', ctx);
    assertEquals(code, 0);
    assertEquals(ctx.getEnv()['FOO'], 'bar');
  });

  await t.step('alias builtin sets alias', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();

    const code = await executor.execute('alias ll="ls -l"', ctx);
    assertEquals(code, 0);
    assertEquals(ctx.getAlias('ll'), 'ls -l');
  });

  await t.step('non-builtin falls through to shell', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();

    // unknown_command should fail (127) because it's not a builtin
    const code = await executor.execute('unknown_command', ctx);
    assertEquals(code, 127);
  });

  await t.step('builtins work in if conditions', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();

    const code = await executor.execute('if true; then echo yes; fi', ctx);
    assertEquals(code, 0);
    assertEquals(shell.capturedOutput.includes('yes\n'), true);
  });

  await t.step('builtins work in while loops', async () => {
    const shell = new MinimalTestShell();
    const builtins = createBuiltinRegistry();
    const executor = new AstExecutor(shell, { builtins });
    const ctx = new ExecContext();

    // This should not loop because false returns 1
    const code = await executor.execute('while false; do echo loop; done', ctx);
    assertEquals(code, 0);
    assertEquals(shell.capturedOutput.includes('loop\n'), false);
  });
});
