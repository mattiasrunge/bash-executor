import { assertEquals } from '@std/assert';
import type { AstNode } from '@ein/bash-parser';
import {
  AstExecutor,
  ExecContext,
  type ExecCommandOptions,
  type ExecContextIf,
  type ShellIf,
} from '../mod.ts';

/**
 * Simple test shell that tracks alias resolution
 */
class AliasTestShell implements ShellIf {
  private executor: AstExecutor;
  private pipes = new Map<string, string[]>();
  private pipeCounter = 0;
  private defaultCtx = new ExecContext();
  public executedCommands: { name: string; args: string[] }[] = [];

  constructor() {
    this.executor = new AstExecutor(this);
  }

  async run(script: string): Promise<number> {
    return this.executor.execute(script, this.defaultCtx);
  }

  async runWithContext(script: string, ctx: ExecContextIf): Promise<number> {
    return this.executor.execute(script, ctx);
  }

  async execCommand(
    _ctx: ExecContextIf,
    name: string,
    args: string[],
    _opts: ExecCommandOptions,
  ): Promise<number> {
    this.executedCommands.push({ name, args });
    if (name === 'true') return 0;
    if (name === 'false') return 1;
    if (name === 'echo') return 0;
    return 0;
  }

  async execSyncCommand(
    ctx: ExecContextIf,
    name: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    await this.execCommand(ctx, name, args, {});
    return { stdout: '', stderr: '' };
  }

  async execSubshell(
    ctx: ExecContextIf,
    cmd: AstNode,
    _opts: ExecCommandOptions,
  ): Promise<number> {
    return this.executor.executeNode(cmd, ctx);
  }

  async pipeOpen(): Promise<string> {
    const name = `pipe_${++this.pipeCounter}`;
    this.pipes.set(name, []);
    return name;
  }

  async pipeClose(_name: string): Promise<void> {}
  async pipeRemove(_name: string): Promise<void> {}
  async pipeRead(_name: string): Promise<string> {
    return '';
  }
  async pipeWrite(_name: string, _data: string): Promise<void> {}

  reset(): void {
    this.executedCommands = [];
  }
}

Deno.test('Alias Resolution', async (t) => {
  await t.step('alias resolves simple command', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -la');

    await shell.runWithContext('ll', ctx);

    assertEquals(shell.executedCommands.length, 1);
    assertEquals(shell.executedCommands[0].name, 'ls');
    assertEquals(shell.executedCommands[0].args, ['-la']);
  });

  await t.step('alias with additional arguments', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -la');

    await shell.runWithContext('ll /tmp', ctx);

    assertEquals(shell.executedCommands.length, 1);
    assertEquals(shell.executedCommands[0].name, 'ls');
    assertEquals(shell.executedCommands[0].args, ['-la', '/tmp']);
  });

  await t.step('alias resolves to different command', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('dir', 'ls');

    await shell.runWithContext('dir', ctx);

    assertEquals(shell.executedCommands.length, 1);
    assertEquals(shell.executedCommands[0].name, 'ls');
  });

  await t.step('alias resolves with multiple flags', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('la', 'ls -la --color=auto');

    await shell.runWithContext('la', ctx);

    assertEquals(shell.executedCommands.length, 1);
    assertEquals(shell.executedCommands[0].name, 'ls');
    assertEquals(shell.executedCommands[0].args, ['-la', '--color=auto']);
  });

  await t.step('unaliased command runs normally', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();

    await shell.runWithContext('ls -l', ctx);

    assertEquals(shell.executedCommands.length, 1);
    assertEquals(shell.executedCommands[0].name, 'ls');
    assertEquals(shell.executedCommands[0].args, ['-l']);
  });

  await t.step('alias in script context', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('hi', 'echo hello');

    await shell.runWithContext('hi; hi', ctx);

    assertEquals(shell.executedCommands.length, 2);
    assertEquals(shell.executedCommands[0].name, 'echo');
    assertEquals(shell.executedCommands[0].args, ['hello']);
    assertEquals(shell.executedCommands[1].name, 'echo');
  });

  await t.step('alias in if statement', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('ok', 'true');

    await shell.runWithContext('if ok; then echo yes; fi', ctx);

    assertEquals(shell.executedCommands[0].name, 'true');
    assertEquals(shell.executedCommands[1].name, 'echo');
  });

  await t.step('alias in while condition', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('fail', 'false');

    await shell.runWithContext('while fail; do echo never; done', ctx);

    assertEquals(shell.executedCommands.length, 1);
    assertEquals(shell.executedCommands[0].name, 'false');
  });

  await t.step('alias in for loop body', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('hi', 'echo hello');

    await shell.runWithContext('for i in 1 2; do hi; done', ctx);

    assertEquals(shell.executedCommands.length, 2);
    assertEquals(shell.executedCommands[0].name, 'echo');
    assertEquals(shell.executedCommands[1].name, 'echo');
  });

  await t.step('alias in pipeline', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('hi', 'echo hello');

    await shell.runWithContext('hi | cat', ctx);

    const echoCmd = shell.executedCommands.find((c) => c.name === 'echo');
    assertEquals(echoCmd?.name, 'echo');
    assertEquals(echoCmd?.args, ['hello']);
  });

  await t.step('alias in subshell', async () => {
    const shell = new AliasTestShell();
    const ctx = new ExecContext();
    ctx.setAlias('hi', 'echo hello');

    await shell.runWithContext('(hi)', ctx);

    assertEquals(shell.executedCommands[0].name, 'echo');
    assertEquals(shell.executedCommands[0].args, ['hello']);
  });
});

Deno.test('Alias Context Inheritance', async (t) => {
  await t.step('child context inherits aliases', () => {
    const parent = new ExecContext();
    parent.setAlias('ll', 'ls -la');

    const child = parent.spawnContext();
    assertEquals(child.getAlias('ll'), 'ls -la');
  });

  await t.step('subContext copies aliases', () => {
    const original = new ExecContext();
    original.setAlias('ll', 'ls -la');

    const copy = original.subContext();
    assertEquals(copy.getAlias('ll'), 'ls -la');
  });

  await t.step('child alias changes affect parent', () => {
    const parent = new ExecContext();
    const child = parent.spawnContext();

    child.setAlias('new', 'command');
    assertEquals(parent.getAlias('new'), 'command');
  });

  await t.step('unsetAlias removes alias', () => {
    const ctx = new ExecContext();
    ctx.setAlias('ll', 'ls -la');
    ctx.unsetAlias('ll');
    assertEquals(ctx.getAlias('ll'), undefined);
  });

  await t.step('child unsetAlias affects parent', () => {
    const parent = new ExecContext();
    parent.setAlias('ll', 'ls -la');

    const child = parent.spawnContext();
    child.unsetAlias('ll');

    assertEquals(parent.getAlias('ll'), undefined);
  });
});
