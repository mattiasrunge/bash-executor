import type { AstNodeCompoundList } from '@ein/bash-parser';
import type { ExecContextIf, FunctionDef, IO } from './types.ts';

// TODO: We need to define when cwd or params should go to parent or not...

/**
 * Execution context for shell commands, managing environment variables, I/O streams, and function definitions.
 */
export class ExecContext implements ExecContextIf {
  private cwd = '/';
  private parent?: ExecContext;
  private io: IO;
  private env: Record<string, string> = {};
  private params: Record<string, string> = {};
  private fns: Record<string, FunctionDef> = {};
  private alias: Record<string, string> = {};

  constructor(parent?: ExecContext) {
    if (parent) {
      this.parent = parent;
      this.io = {
        stdin: parent.getStdin(),
        stdout: parent.getStdout(),
        stderr: parent.getStderr(),
      };
    } else {
      this.io = {
        stdin: '0',
        stdout: '1',
        stderr: '2',
      };
    }
  }

  spawnContext(): ExecContextIf {
    return new ExecContext(this);
  }

  subContext(): ExecContextIf {
    const ctx = new ExecContext();

    ctx.setCwd(this.getCwd());
    ctx.setEnv(this.getEnv());
    ctx.setParams(this.getParams());
    ctx.redirectStdin(this.getStdin());
    ctx.redirectStdout(this.getStdout());
    ctx.redirectStderr(this.getStderr());

    for (const fn of Object.values(this.fns)) {
      ctx.setFunction(fn.name, fn.body, fn.ctx);
    }

    for (const [name, args] of Object.entries(this.alias)) {
      ctx.setAlias(name, args);
    }

    return ctx;
  }

  getCwd(): string {
    if (this.parent) {
      return this.parent.getCwd();
    }

    return this.cwd;
  }

  setCwd(cwd: string): string {
    if (this.parent) {
      return this.parent.setCwd(cwd);
    }

    this.setEnv({ PWD: cwd });

    return this.cwd = cwd;
  }

  getEnv(): Record<string, string> {
    if (this.parent) {
      return {
        ...this.parent.getEnv(),
        ...this.env,
      };
    }

    return this.env;
  }

  setEnv(values: Record<string, string | null>): Record<string, string> {
    if (this.parent) {
      return {
        ...this.parent.setEnv(values),
        ...this.env,
      };
    }

    return this.setLocalEnv(values);
  }

  setLocalEnv(values: Record<string, string | null>): Record<string, string> {
    for (const key in values) {
      if (values[key] === null) {
        delete this.env[key];
      } else {
        this.env[key] = values[key];
      }
    }

    return this.env;
  }

  getParams(): Record<string, string> {
    if (this.parent) {
      return {
        ...this.parent.getParams(),
        ...this.params,
      };
    }

    return this.params;
  }

  setParams(values: Record<string, string | null>): Record<string, string> {
    if (this.parent) {
      return {
        ...this.parent.setParams(values),
        ...this.params,
      };
    }

    return this.setLocalParams(values);
  }

  setLocalParams(
    values: Record<string, string | null>,
  ): Record<string, string> {
    for (const key in values) {
      if (values[key] === null) {
        delete this.params[key];
      } else {
        this.params[key] = values[key];
      }
    }

    return this.params;
  }

  setFunction(
    name: string,
    body: AstNodeCompoundList,
    ctx: ExecContextIf,
  ): void {
    if (this.parent) {
      return this.parent.setFunction(name, body, ctx);
    }

    this.fns[name] = {
      name,
      body,
      ctx,
    };
  }

  unsetFunction(name: string): void {
    if (this.fns[name]) {
      delete this.fns[name];
    } else if (this.parent) {
      this.parent.unsetFunction(name);
    }
  }

  getFunction(name: string): FunctionDef | null {
    return this.fns[name] || (this.parent && this.parent.getFunction(name));
  }

  setAlias(name: string, alias: string): void {
    if (this.parent) {
      this.parent.setAlias(name, alias);
    } else {
      this.alias[name] = alias;
    }
  }

  unsetAlias(name: string): void {
    if (this.parent) {
      this.parent.unsetAlias(name);
    } else {
      delete this.alias[name];
    }
  }

  getAlias(name: string): string | undefined {
    if (this.parent) {
      return this.parent.getAlias(name);
    }

    return this.alias[name];
  }

  redirectStdin(name: string): string {
    return this.io.stdin = name;
  }

  redirectStdout(name: string, append?: boolean): string {
    this.io.stdoutAppend = append;
    return this.io.stdout = name;
  }

  redirectStderr(name: string, append?: boolean): string {
    this.io.stderrAppend = append;
    return this.io.stderr = name;
  }

  getStdin(): string {
    return this.io.stdin;
  }

  getStdout(): string {
    return this.io.stdout;
  }

  getStderr(): string {
    return this.io.stderr;
  }

  getStdoutAppend(): boolean {
    return !!this.io.stdoutAppend;
  }

  getStderrAppend(): boolean {
    return !!this.io.stderrAppend;
  }
}
