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
 * Test shell that supports resolvePath and resolveHomeUser callbacks
 */
class CallbackTestShell implements ShellIf {
  private executor: AstExecutor;
  private pipes = new Map<string, { data: string[]; closed: boolean }>();
  private pipeCounter = 0;
  private defaultCtx = new ExecContext();
  public capturedOutput: string[] = [];
  public pathResolutions: string[] = [];
  public homeResolutions: string[] = [];

  // Configurable path resolution
  public pathMap: Record<string, string[]> = {};
  public homeMap: Record<string, string> = {};

  constructor() {
    this.executor = new AstExecutor(this);
  }

  async run(script: string): Promise<number> {
    return this.executor.execute(script, this.defaultCtx);
  }

  async runWithContext(script: string, ctx: ExecContextIf): Promise<number> {
    return this.executor.execute(script, ctx);
  }

  // Implement resolvePath callback for glob expansion
  async resolvePath(pattern: string, _ctx: ExecContextIf): Promise<string[]> {
    this.pathResolutions.push(pattern);
    if (this.pathMap[pattern]) {
      return this.pathMap[pattern];
    }
    // Return the pattern as-is if no matches configured
    return [pattern];
  }

  // Implement resolveHomeUser callback for tilde expansion
  // Returns empty string when not found to preserve original
  async resolveHomeUser(
    username: string | null,
    _ctx: ExecContextIf,
  ): Promise<string> {
    this.homeResolutions.push(username ?? '');
    if (username === null && this.homeMap['']) {
      return this.homeMap[''];
    }
    if (username && this.homeMap[username]) {
      return this.homeMap[username];
    }
    // Return empty string which tells executor to preserve original
    return '';
  }

  async execCommand(
    ctx: ExecContextIf,
    name: string,
    args: string[],
    _opts: ExecCommandOptions,
  ): Promise<number> {
    if (name === 'echo') {
      const output = args.join(' ') + '\n';
      const stdout = ctx.getStdout();
      if (stdout === '1') {
        this.capturedOutput.push(output);
      } else if (this.pipes.has(stdout)) {
        const pipe = this.pipes.get(stdout)!;
        pipe.data.push(output);
      }
      return 0;
    }
    if (name === 'true') return 0;
    if (name === 'false') return 1;
    return 127;
  }

  async execSyncCommand(
    ctx: ExecContextIf,
    name: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    if (name === 'echo') {
      return { stdout: args.join(' '), stderr: '' };
    }
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
    this.pipes.set(name, { data: [], closed: false });
    return name;
  }

  async pipeClose(name: string): Promise<void> {
    const pipe = this.pipes.get(name);
    if (pipe) pipe.closed = true;
  }

  async pipeRemove(name: string): Promise<void> {
    this.pipes.delete(name);
  }

  async pipeRead(name: string): Promise<string> {
    const pipe = this.pipes.get(name);
    if (!pipe) return '';
    return pipe.data.join('').replace(/\n$/, '');
  }

  async pipeWrite(name: string, data: string): Promise<void> {
    const pipe = this.pipes.get(name);
    if (pipe && !pipe.closed) {
      if (data === '') {
        pipe.closed = true;
      } else {
        pipe.data.push(data);
      }
    }
  }

  getOutput(): string {
    return this.capturedOutput.join('');
  }

  reset(): void {
    this.capturedOutput = [];
    this.pathResolutions = [];
    this.homeResolutions = [];
    this.pipes.clear();
    this.pipeCounter = 0;
  }
}

Deno.test('resolvePath - Glob Expansion', async (t) => {
  await t.step('glob pattern is resolved via callback', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.pathMap['*.txt'] = ['a.txt', 'b.txt', 'c.txt'];

    await shell.runWithContext('echo *.txt', ctx);

    assertEquals(shell.pathResolutions, ['*.txt']);
    assertEquals(shell.getOutput(), 'a.txt b.txt c.txt\n');
  });

  await t.step('multiple glob patterns', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.pathMap['*.txt'] = ['file.txt'];
    shell.pathMap['*.md'] = ['readme.md'];

    await shell.runWithContext('echo *.txt *.md', ctx);

    assertEquals(shell.pathResolutions.includes('*.txt'), true);
    assertEquals(shell.pathResolutions.includes('*.md'), true);
    assertEquals(shell.getOutput(), 'file.txt readme.md\n');
  });

  await t.step('glob with no matches returns pattern', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    // No pathMap entry - pattern returns as-is
    await shell.runWithContext('echo *.nomatch', ctx);

    assertEquals(shell.pathResolutions, ['*.nomatch']);
    assertEquals(shell.getOutput(), '*.nomatch\n');
  });

  await t.step('glob in for loop word list', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.pathMap['*.sh'] = ['a.sh', 'b.sh'];

    await shell.runWithContext('for f in *.sh; do echo "$f"; done', ctx);

    assertEquals(shell.pathResolutions.includes('*.sh'), true);
    assertEquals(shell.getOutput(), 'a.sh\nb.sh\n');
  });

  await t.step('glob expansion with path prefix', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.pathMap['src/*.ts'] = ['src/main.ts', 'src/util.ts'];

    await shell.runWithContext('echo src/*.ts', ctx);

    assertEquals(shell.getOutput(), 'src/main.ts src/util.ts\n');
  });

  await t.step('quoted glob is not expanded', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    await shell.runWithContext('echo "*.txt"', ctx);

    // Path resolution not called for quoted strings
    assertEquals(shell.getOutput(), '*.txt\n');
  });
});

Deno.test('resolveHomeUser - Tilde Expansion', async (t) => {
  await t.step('~ expands to home directory', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.homeMap[''] = '/home/user';

    await shell.runWithContext('echo ~', ctx);

    assertEquals(shell.homeResolutions, ['']);
    assertEquals(shell.getOutput(), '/home/user\n');
  });

  await t.step('~username expands to user home', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.homeMap['alice'] = '/home/alice';

    await shell.runWithContext('echo ~alice', ctx);

    assertEquals(shell.homeResolutions, ['alice']);
    assertEquals(shell.getOutput(), '/home/alice\n');
  });

  await t.step('~/path expands correctly', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.homeMap[''] = '/home/user';

    await shell.runWithContext('echo ~/documents', ctx);

    assertEquals(shell.getOutput(), '/home/user/documents\n');
  });

  await t.step('~user/path expands correctly', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.homeMap['bob'] = '/home/bob';

    await shell.runWithContext('echo ~bob/projects', ctx);

    assertEquals(shell.getOutput(), '/home/bob/projects\n');
  });

  await t.step('quoted tilde is not expanded', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.homeMap[''] = '/home/user';

    await shell.runWithContext('echo "~"', ctx);

    assertEquals(shell.getOutput(), '~\n');
  });

  await t.step('unknown user with fallback home', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    // When a user is not found, provide a fallback
    shell.homeMap['unknownuser'] = '/home/unknownuser';

    await shell.runWithContext('echo ~unknownuser', ctx);

    assertEquals(shell.homeResolutions, ['unknownuser']);
    assertEquals(shell.getOutput(), '/home/unknownuser\n');
  });
});

Deno.test('Combined Path and Home Resolution', async (t) => {
  await t.step('tilde and glob together', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.homeMap[''] = '/home/user';
    shell.pathMap['/home/user/*.txt'] = [
      '/home/user/a.txt',
      '/home/user/b.txt',
    ];

    await shell.runWithContext('echo ~/*.txt', ctx);

    // First tilde expansion, then glob expansion
    assertEquals(shell.homeResolutions, ['']);
    assertEquals(shell.pathResolutions.includes('/home/user/*.txt'), true);
  });

  await t.step('multiple arguments with different expansions', async () => {
    const shell = new CallbackTestShell();
    const ctx = new ExecContext();

    shell.homeMap[''] = '/home/user';
    shell.pathMap['*.sh'] = ['script.sh'];

    await shell.runWithContext('echo ~ *.sh', ctx);

    assertEquals(shell.getOutput(), '/home/user script.sh\n');
  });
});
