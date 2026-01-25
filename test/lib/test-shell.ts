import type { AstNode } from '@ein/bash-parser';
import {
  AstExecutor,
  ExecContext,
  type ExecCommandOptions,
  type ExecContextIf,
  type ShellIf,
} from '../../mod.ts';

/**
 * PipeBuffer - Async pipe with proper backpressure and EOF signaling
 * Based on MURRiX implementation
 */
class PipeBuffer {
  private buffer: Uint8Array;
  private readPos = 0;
  private writePos = 0;
  private size = 0;
  private _closed = false;

  private writeWaiters: Array<() => void> = [];
  private readWaiters: Array<() => void> = [];

  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(private capacity: number = 64 * 1024) {
    this.buffer = capacity > 0 ? new Uint8Array(capacity) : new Uint8Array(0);
  }

  get isClosed(): boolean {
    return this._closed;
  }

  close(): void {
    this._closed = true;
    // Wake all waiting readers so they can see EOF
    this.readWaiters.forEach((w) => w());
    this.readWaiters = [];
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (this._closed) {
      throw new Error('Cannot write to closed pipe');
    }

    if (this.capacity === 0) return;

    const input: Uint8Array = typeof data === 'string' ? this.encoder.encode(data) : data;

    let offset = 0;

    while (offset < input.length) {
      if (this._closed) {
        throw new Error('Cannot write to closed pipe');
      }

      if (this.size === this.capacity) {
        await new Promise<void>((res) => this.writeWaiters.push(res));
        continue;
      }

      const space = this.capacity - this.size;
      const toWrite = Math.min(space, input.length - offset);

      const end = this.writePos + toWrite;

      if (end <= this.capacity) {
        this.buffer.set(input.subarray(offset, offset + toWrite), this.writePos);
      } else {
        const firstPart = this.capacity - this.writePos;
        this.buffer.set(input.subarray(offset, offset + firstPart), this.writePos);
        const remaining = toWrite - firstPart;
        this.buffer.set(input.subarray(offset + firstPart, offset + firstPart + remaining), 0);
      }

      this.writePos = (this.writePos + toWrite) % this.capacity;
      this.size += toWrite;
      offset += toWrite;

      // Wake any waiting readers
      this.readWaiters.forEach((w) => w());
      this.readWaiters = [];
    }
  }

  async read(maxBytes: number): Promise<Uint8Array> {
    if (this.capacity === 0) {
      return new Uint8Array(0);
    }

    while (this.size === 0) {
      if (this._closed) {
        return new Uint8Array(0);
      }

      await new Promise<void>((res) => this.readWaiters.push(res));
    }

    const toRead = Math.min(maxBytes, this.size);
    const out = new Uint8Array(toRead);

    const end = this.readPos + toRead;

    if (end <= this.capacity) {
      out.set(this.buffer.subarray(this.readPos, this.readPos + toRead));
    } else {
      const firstPart = this.capacity - this.readPos;
      out.set(this.buffer.subarray(this.readPos, this.readPos + firstPart));
      const remaining = toRead - firstPart;
      out.set(this.buffer.subarray(0, remaining), firstPart);
    }

    this.readPos = (this.readPos + toRead) % this.capacity;
    this.size -= toRead;

    // Wake any writers waiting for space
    this.writeWaiters.forEach((w) => w());
    this.writeWaiters = [];

    return out;
  }

  async readAll(): Promise<string> {
    const chunks: Uint8Array[] = [];

    while (true) {
      const chunk = await this.read(16384);
      if (chunk.length === 0) {
        break;
      }
      chunks.push(chunk);
    }

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return this.decoder.decode(result);
  }

  writeString(data: string): Promise<void> {
    return this.write(data);
  }
}

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

  constructor() {
    this.executor = new AstExecutor(this);
    this.ctx = new ExecContext();
    this.pipes = new Map();
    this.pipeCounter = 0;
    this.mockCommands = new Map();
    this.capturedStdout = [];
    this.capturedStderr = [];

    this.registerBuiltins();
  }

  /**
   * Register built-in test commands
   */
  private registerBuiltins(): void {
    // echo - write arguments to stdout
    this.mockCommands.set('echo', async (_ctx, args) => {
      const output = args.join(' ') + '\n';
      return { code: 0, stdout: output };
    });

    // printf - formatted output without trailing newline
    this.mockCommands.set('printf', async (_ctx, args) => {
      if (args.length === 0) return { code: 0, stdout: '' };
      // Simple printf implementation - just joins args
      const format = args[0];
      const values = args.slice(1);
      let output = format;
      // Handle basic %s substitution
      let i = 0;
      output = output.replace(/%s/g, () => values[i++] || '');
      // Handle escape sequences
      output = output.replace(/\\n/g, '\n');
      output = output.replace(/\\t/g, '\t');
      return { code: 0, stdout: output };
    });

    // true - always succeeds
    this.mockCommands.set('true', async () => ({ code: 0 }));

    // false - always fails
    this.mockCommands.set('false', async () => ({ code: 1 }));

    // exit - return specific exit code
    this.mockCommands.set('exit', async (_ctx, args) => {
      const code = parseInt(args[0] || '0', 10);
      return { code: isNaN(code) ? 0 : code };
    });

    // test / [ - conditional expressions
    this.mockCommands.set('test', async (_ctx, args) => {
      return { code: this.evaluateTestExpression(args) ? 0 : 1 };
    });
    this.mockCommands.set('[', async (_ctx, args) => {
      // Remove trailing ]
      const testArgs = args[args.length - 1] === ']' ? args.slice(0, -1) : args;
      return { code: this.evaluateTestExpression(testArgs) ? 0 : 1 };
    });

    // cat - read from stdin or echo args
    this.mockCommands.set('cat', async (ctx, args) => {
      const stdin = ctx.getStdin();
      if (stdin !== '0' && this.pipes.has(stdin)) {
        const content = await this.pipeRead(stdin);
        return { code: 0, stdout: content ? content + '\n' : '' };
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

    // read - read a line from stdin into a variable
    this.mockCommands.set('read', async (ctx, args) => {
      const varName = args[0] || 'REPLY';
      const stdin = ctx.getStdin();
      if (stdin !== '0' && this.pipes.has(stdin)) {
        const content = await this.pipeRead(stdin);
        const firstLine = content.split('\n')[0] || '';
        ctx.setParams({ [varName]: firstLine });
        return { code: 0 };
      }
      return { code: 1 };
    });

    // export - set environment variable
    this.mockCommands.set('export', async (ctx, args) => {
      for (const arg of args) {
        const eqIdx = arg.indexOf('=');
        if (eqIdx > 0) {
          const name = arg.substring(0, eqIdx);
          const value = arg.substring(eqIdx + 1);
          ctx.setEnv({ [name]: value });
        }
      }
      return { code: 0 };
    });

    // unset - unset a variable
    this.mockCommands.set('unset', async (ctx, args) => {
      for (const name of args) {
        ctx.setParams({ [name]: null });
      }
      return { code: 0 };
    });

    // return - return from a function with exit code
    this.mockCommands.set('return', async (_ctx, args) => {
      const code = parseInt(args[0] || '0', 10);
      return { code: isNaN(code) ? 0 : code };
    });

    // colon / : - null command, always succeeds
    this.mockCommands.set(':', async () => ({ code: 0 }));
  }

  /**
   * Evaluate a test expression (for test / [ commands)
   */
  private evaluateTestExpression(args: string[]): boolean {
    if (args.length === 0) return false;

    // Handle negation
    if (args[0] === '!') {
      return !this.evaluateTestExpression(args.slice(1));
    }

    // Unary string operators
    if (args[0] === '-n') return (args[1]?.length || 0) > 0;
    if (args[0] === '-z') return !args[1] || args[1].length === 0;

    // Binary comparison operators
    if (args.length >= 3) {
      const left = args[0];
      const op = args[1];
      const right = args[2];

      switch (op) {
        case '=':
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case '-eq':
          return parseInt(left) === parseInt(right);
        case '-ne':
          return parseInt(left) !== parseInt(right);
        case '-lt':
          return parseInt(left) < parseInt(right);
        case '-le':
          return parseInt(left) <= parseInt(right);
        case '-gt':
          return parseInt(left) > parseInt(right);
        case '-ge':
          return parseInt(left) >= parseInt(right);
      }
    }

    // Single argument - true if non-empty
    return (args[0]?.length || 0) > 0;
  }

  /**
   * Write to the appropriate output stream
   */
  private async writeToStream(stream: string, content: string): Promise<void> {
    if (stream === '1') {
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

  async execSyncCommand(
    ctx: ExecContextIf,
    name: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const handler = this.mockCommands.get(name);
    if (handler) {
      const result = await handler(ctx, args);
      return { stdout: result.stdout || '', stderr: result.stderr || '' };
    }

    // Check if it's a function
    const fn = ctx.getFunction(name);
    if (fn) {
      const fnCtx = fn.ctx.spawnContext();
      // Set positional parameters
      const posParams: Record<string, string> = {};
      args.forEach((arg, i) => {
        posParams[(i + 1).toString()] = arg;
      });
      fnCtx.setLocalParams(posParams);

      // Capture output for sync execution
      const prevStdout = this.capturedStdout;
      const prevStderr = this.capturedStderr;
      this.capturedStdout = [];
      this.capturedStderr = [];

      await this.executor.executeNode(fn.body, fnCtx);

      const stdout = this.capturedStdout.join('');
      const stderr = this.capturedStderr.join('');

      this.capturedStdout = prevStdout;
      this.capturedStderr = prevStderr;

      return { stdout, stderr };
    }

    return { stdout: '', stderr: '' };
  }

  async execCommand(
    ctx: ExecContextIf,
    name: string,
    args: string[],
    _opts: ExecCommandOptions,
  ): Promise<number> {
    const handler = this.mockCommands.get(name);
    if (handler) {
      const result = await handler(ctx, args);
      if (result.stdout) await this.writeToStream(ctx.getStdout(), result.stdout);
      if (result.stderr) await this.writeToStream(ctx.getStderr(), result.stderr);
      return result.code;
    }

    // Check if it's a function
    const fn = ctx.getFunction(name);
    if (fn) {
      const fnCtx = fn.ctx.spawnContext();
      // Set positional parameters
      const posParams: Record<string, string> = {};
      args.forEach((arg, i) => {
        posParams[(i + 1).toString()] = arg;
      });
      fnCtx.setLocalParams(posParams);

      // Inherit I/O from caller context
      fnCtx.redirectStdin(ctx.getStdin());
      fnCtx.redirectStdout(ctx.getStdout());
      fnCtx.redirectStderr(ctx.getStderr());

      return await this.executor.executeNode(fn.body, fnCtx);
    }

    // Unknown command
    await this.writeToStream(ctx.getStderr(), `${name}: command not found\n`);
    return 127;
  }

  async execSubshell(
    ctx: ExecContextIf,
    cmd: AstNode,
    _opts: ExecCommandOptions,
  ): Promise<number> {
    const subCtx = ctx.subContext();
    return this.executor.executeNode(cmd, subCtx);
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

    const content = await pipe.readAll();
    return content.replace(/\n$/, ''); // Trim trailing newline for command expansion
  }

  async pipeWrite(name: string, data: string): Promise<void> {
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

  async run(script: string): Promise<number> {
    this.capturedStdout = [];
    this.capturedStderr = [];
    return this.executor.execute(script, this.ctx);
  }

  // Test utilities

  /**
   * Run a script and capture all output for assertions
   */
  async runAndCapture(script: string): Promise<TestRunResult> {
    this.capturedStdout = [];
    this.capturedStderr = [];

    const exitCode = await this.executor.execute(script, this.ctx);

    return {
      exitCode,
      stdout: this.capturedStdout.join(''),
      stderr: this.capturedStderr.join(''),
      params: { ...this.ctx.getParams() },
      env: { ...this.ctx.getEnv() },
    };
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
    this.clearMocks();
  }
}
