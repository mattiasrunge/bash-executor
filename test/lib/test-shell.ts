import {
  AstExecutor,
  createBuiltinRegistry,
  type DirectoryEntry,
  type ExecCommandOptions,
  ExecContext,
  type ExecContextIf,
  type ExecSyncResult,
  type ExecuteAndCaptureOptions,
  type ShellIf,
} from '../../mod.ts';
import { PipeBuffer } from './pipe-buffer.ts';

/**
 * Result of a test execution containing captured outputs
 */
export interface TestRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  params: Record<string, string>;
  env: Record<string, string>;
}

/**
 * Mock command handler type
 */
export type MockCommandHandler = (
  ctx: ExecContextIf,
  args: string[],
) => Promise<{ code: number; stdout?: string; stderr?: string }>;

/**
 * TestShell - A mock shell implementation for testing the AstExecutor
 */
export class TestShell implements ShellIf {
  private executor: AstExecutor;
  private ctx: ExecContext;
  private pipes: Map<string, PipeBuffer>;
  private pipeCounter: number;
  private mockCommands: Map<string, MockCommandHandler>;
  private capturedStdout: string[];
  private capturedStderr: string[];
  private files: Map<string, string>;
  private fdReadBuffers: Map<string, string>;
  /** Descriptors opened for writing (`exec 3>f`, `exec >>f`): the file they write through to. */
  private fdFiles = new Map<string, string>();
  private decoder = new TextDecoder();

  constructor() {
    this.executor = new AstExecutor(this, { builtins: createBuiltinRegistry() });
    this.ctx = new ExecContext();
    this.pipes = new Map();
    this.pipeCounter = 0;
    this.mockCommands = new Map();
    this.capturedStdout = [];
    this.capturedStderr = [];
    this.files = new Map();
    this.fdReadBuffers = new Map();

    this.registerBuiltins();
  }

  /**
   * Register mock commands for external utilities used in tests.
   * Note: Builtins like echo, printf, true, false, exit, test, [, export, unset, read, return, :
   * are now handled by the real builtin registry passed to AstExecutor.
   * This method only registers mock versions of external commands like cat, grep, wc.
   */
  private registerBuiltins(): void {
    // cat - read from stdin or echo args (outputs content as-is, no extra newline)
    this.mockCommands.set('cat', async (ctx, args) => {
      const stdin = ctx.getStdin();
      if (stdin !== '0' && this.pipes.has(stdin)) {
        const content = await this.pipeRead(stdin);
        return { code: 0, stdout: content };
      }
      return { code: 0, stdout: args.length > 0 ? args.join('\n') + '\n' : '' };
    });

    // grep - simple pattern matching
    this.mockCommands.set('grep', async (ctx, args) => {
      const pattern = args[0] || '';
      const stdin = ctx.getStdin();
      if (stdin !== '0' && this.pipes.has(stdin)) {
        const content = await this.pipeRead(stdin);
        const lines = content.split('\n').filter((line) => line.includes(pattern));
        if (lines.length > 0) {
          return { code: 0, stdout: lines.join('\n') + '\n' };
        }
        return { code: 1 };
      }
      return { code: 1 };
    });

    // wc - word/line count
    this.mockCommands.set('wc', async (ctx, args) => {
      const stdin = ctx.getStdin();
      if (stdin !== '0' && this.pipes.has(stdin)) {
        const content = await this.pipeRead(stdin);
        if (args.includes('-l')) {
          const lines = content.split('\n').filter((l) => l.length > 0).length;
          return { code: 0, stdout: `${lines}\n` };
        }
        if (args.includes('-w')) {
          const words = content.split(/\s+/).filter((w) => w.length > 0).length;
          return { code: 0, stdout: `${words}\n` };
        }
        if (args.includes('-c')) {
          return { code: 0, stdout: `${content.length}\n` };
        }
        // Default: lines words chars
        const lines = content.split('\n').filter((l) => l.length > 0).length;
        const words = content.split(/\s+/).filter((w) => w.length > 0).length;
        return { code: 0, stdout: `${lines} ${words} ${content.length}\n` };
      }
      return { code: 0, stdout: '0\n' };
    });
  }

  /**
   * Write to the appropriate output stream
   */
  private async writeToStream(stream: string, content: string): Promise<void> {
    if (this.fdFiles.has(stream)) {
      await this.pipeWrite(stream, content);
    } else if (stream === '1') {
      this.capturedStdout.push(content);
    } else if (stream === '2') {
      this.capturedStderr.push(content);
    } else if (this.pipes.has(stream)) {
      const pipe = this.pipes.get(stream)!;
      if (!pipe.isClosed) {
        await pipe.writeString(content);
      }
    }
  }

  // ShellIf implementation

  async execute(
    ctx: ExecContextIf,
    name: string,
    args: string[],
    _opts: ExecCommandOptions,
  ): Promise<number> {
    // Check for mock command (external commands only - functions are handled by executor)
    const handler = this.mockCommands.get(name);
    if (handler) {
      const result = await handler(ctx, args);
      if (result.stdout) await this.writeToStream(ctx.getStdout(), result.stdout);
      if (result.stderr) await this.writeToStream(ctx.getStderr(), result.stderr);
      return result.code;
    }

    // Unknown command
    await this.writeToStream(ctx.getStderr(), `${name}: command not found\n`);
    return 127;
  }

  async pipeOpen(): Promise<string> {
    const pipeName = `pipe_${++this.pipeCounter}`;
    this.pipes.set(pipeName, new PipeBuffer());
    return pipeName;
  }

  async pipeClose(name: string): Promise<void> {
    const pipe = this.pipes.get(name);
    if (pipe) pipe.close();
  }

  async pipeRemove(name: string): Promise<void> {
    const pipe = this.pipes.get(name);
    if (pipe && !pipe.isClosed) {
      pipe.close();
    }
    this.pipes.delete(name);
  }

  async pipeRead(name: string): Promise<string> {
    const pipe = this.pipes.get(name);
    if (!pipe) return '';

    return await pipe.readAll();
  }

  async pipeWrite(name: string, data: string): Promise<void> {
    const file = this.fdFiles.get(name);

    if (file !== undefined) {
      this.files.set(file, (this.files.get(file) ?? '') + data);
      return;
    }

    // Handle standard streams (stdout and stderr)
    if (name === '1') {
      this.capturedStdout.push(data);
      return;
    }
    if (name === '2') {
      this.capturedStderr.push(data);
      return;
    }

    const pipe = this.pipes.get(name);
    if (pipe && !pipe.isClosed) {
      if (data === '') {
        // Empty write signals EOF - close the pipe
        pipe.close();
      } else {
        await pipe.writeString(data);
      }
    }
  }

  isPipe(name: string): boolean {
    // Standard streams are always considered "pipes" (managed FDs)
    if (name === '0' || name === '1' || name === '2') {
      return true;
    }
    return this.pipes.has(name);
  }

  async pipeFromFile(_ctx: ExecContextIf, path: string, pipe: string): Promise<void> {
    const content = this.files.get(path) || '';
    if (content) {
      await this.pipeWrite(pipe, content);
    }
    await this.pipeClose(pipe);
  }

  async pipeToFile(_ctx: ExecContextIf, pipe: string, path: string, append: boolean): Promise<void> {
    const content = await this.pipeRead(pipe);
    if (append) {
      const existing = this.files.get(path) || '';
      this.files.set(path, existing + content);
    } else {
      this.files.set(path, content);
    }
  }

  async fdOpen(_ctx: ExecContextIf, path: string, mode: string, fd?: string): Promise<string> {
    fd = fd ?? `pipe_${++this.pipeCounter}`;

    // Opened only for writing: writes go to the file, from where it stands
    if (mode.startsWith('w') || mode.startsWith('a')) {
      if (mode.startsWith('w') || !this.files.has(path)) {
        this.files.set(path, '');
      }

      this.fdFiles.set(fd, path);
      this.pipes.set(fd, new PipeBuffer());

      return fd;
    }

    const pipe = new PipeBuffer();
    // Pre-load file content if it exists, then close to signal EOF for reads
    const content = this.files.get(path);
    if (content !== undefined) {
      if (content.length > 0) {
        await pipe.write(content);
      }
      pipe.close();
    }
    this.pipes.set(fd, pipe);
    return fd;
  }

  async fdClose(fd: string): Promise<void> {
    this.fdFiles.delete(fd);
    const pipe = this.pipes.get(fd);
    if (pipe && !pipe.isClosed) {
      pipe.close();
    }
    this.pipes.delete(fd);
    this.fdReadBuffers.delete(fd);
  }

  async pipeReadLine(fd: string, delimiter = '\n'): Promise<string | null> {
    return (await this.pipeReadRecord(fd, delimiter))?.text ?? null;
  }

  async pipeReadRecord(fd: string, delimiter = '\n'): Promise<{ text: string; delimited: boolean } | null> {
    const pipe = this.pipes.get(fd);
    if (!pipe) return null;

    let buffer = this.fdReadBuffers.get(fd) || '';

    while (true) {
      const idx = buffer.indexOf(delimiter);
      if (idx !== -1) {
        this.fdReadBuffers.set(fd, buffer.substring(idx + delimiter.length));
        return { text: buffer.substring(0, idx), delimited: true };
      }

      const chunk = await pipe.read(4096);
      if (chunk.length === 0) {
        this.fdReadBuffers.delete(fd);
        return buffer.length > 0 ? { text: buffer, delimited: false } : null;
      }

      buffer += this.decoder.decode(chunk);
    }
  }

  // Test utilities

  /**
   * Run a script and return just the exit code
   */
  async run(script: string): Promise<number> {
    this.capturedStdout = [];
    this.capturedStderr = [];
    return this.executor.execute(script, this.ctx);
  }

  /** Whether text stops inside a command, as a prompt asks. */
  async isUnfinished(text: string): Promise<boolean> {
    return await this.executor.isUnfinished(text, this.ctx);
  }

  /**
   * Run a script and capture all output for assertions
   */
  async runAndCapture(script: string, opts: { exited?: { value: boolean }; file?: string; command?: boolean; history?: boolean } = {}): Promise<TestRunResult> {
    this.capturedStdout = [];
    this.capturedStderr = [];

    const exitCode = await this.executor.execute(script, this.ctx, opts);

    return {
      exitCode,
      stdout: this.capturedStdout.join(''),
      stderr: this.capturedStderr.join(''),
      params: { ...this.ctx.getParams() },
      env: { ...this.ctx.getEnv() },
    };
  }

  /** Define the functions exported in the environment, as a shell does when it starts. */
  async importFunctions(): Promise<void> {
    await this.executor.importFunctions(this.ctx);
  }

  /**
   * Run a script using executeAndCapture (captures via pipes)
   */
  async executeAndCapture(script: string, opts?: ExecuteAndCaptureOptions): Promise<ExecSyncResult> {
    return this.executor.executeAndCapture(script, this.ctx, opts);
  }

  /**
   * Get captured stdout
   */
  getStdout(): string {
    return this.capturedStdout.join('');
  }

  /**
   * Get captured stderr
   */
  getStderr(): string {
    return this.capturedStderr.join('');
  }

  /**
   * Get current parameters
   */
  getParams(): Record<string, string> {
    return this.ctx.getParams();
  }

  /**
   * Get current environment
   */
  getEnv(): Record<string, string> {
    return this.ctx.getEnv();
  }

  /**
   * Set parameters before running a script
   */
  setParams(values: Record<string, string>): void {
    this.ctx.setParams(values);
  }

  /**
   * Set environment variables before running a script
   */
  setEnv(values: Record<string, string>): void {
    this.ctx.setEnv(values);
  }

  /**
   * Set the current working directory
   */
  setCwd(cwd: string): void {
    this.ctx.setCwd(cwd);
  }

  /**
   * Get the current working directory
   */
  getCwd(): string {
    return this.ctx.getCwd();
  }

  /**
   * Get the content of a virtual file
   */
  getFile(path: string): string {
    return this.files.get(path) || '';
  }

  /**
   * Set the content of a virtual file
   */
  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  /** `source` reads the virtual files. */
  async readFile(_ctx: ExecContextIf, path: string): Promise<string> {
    const content = this.files.get(path);

    if (content === undefined) {
      throw new Error('No such file or directory');
    }

    return await content;
  }

  /**
   * Only EXISTS is answered, which is all `set -C` asks about.
   */
  async testPath(_ctx: ExecContextIf, path: string, op: string): Promise<boolean> {
    // A directory is one a file is in, or one every system has
    const directory = path === '/' || path === '/tmp' || path === '/dev' || [...this.files.keys()].some((file) => file.startsWith(`${path}/`));

    if (op === 'DIRECTORY') return await directory;

    // Every virtual file and directory may be read and written
    if (op === 'READABLE' || op === 'WRITABLE') return await (this.files.has(path) || directory || path === '.' || !path.includes('/'));

    return await (op === 'EXISTS' ? this.files.has(path) || directory : false);
  }

  /** The virtual files as a directory tree: a directory is one a file is in. */
  async readDirectory(ctx: ExecContextIf, path: string): Promise<DirectoryEntry[] | null> {
    const dir = (path.startsWith('/') ? path : `${ctx.getCwd().replace(/\/$/, '')}/${path === '.' ? '' : path}`).replace(/\/+$/, '') + '/';
    const entries = new Map<string, boolean>();

    for (const file of this.files.keys()) {
      if (!file.startsWith(dir)) continue;

      const [name, ...rest] = file.slice(dir.length).split('/');

      if (name) entries.set(name, (entries.get(name) ?? false) || rest.length > 0);
    }

    return await (entries.size > 0 || dir === '/' ? [...entries].map(([name, directory]) => ({ name, directory })) : null);
  }

  /**
   * A scratch file for process substitution, `cat <(cmd)`.
   */
  async tempFile(_ctx: ExecContextIf): Promise<string> {
    const path = `/tmp/psub-${this.pipeCounter++}`;

    this.files.set(path, '');

    return await path;
  }

  async removeTempFile(_ctx: ExecContextIf, path: string): Promise<void> {
    this.files.delete(path);

    await undefined;
  }

  /**
   * Register a mock command for testing
   */
  mockCommand(name: string, handler: MockCommandHandler): void {
    this.mockCommands.set(name, handler);
  }

  /**
   * Clear all mock commands and re-register builtins
   */
  clearMocks(): void {
    this.mockCommands.clear();
    this.registerBuiltins();
  }

  /**
   * Reset the shell state for a fresh test
   */
  reset(): void {
    this.ctx = new ExecContext();
    this.pipes.clear();
    this.pipeCounter = 0;
    this.capturedStdout = [];
    this.capturedStderr = [];
    this.files.clear();
    this.fdReadBuffers.clear();
    this.fdFiles.clear();
    this.clearMocks();
  }
}
