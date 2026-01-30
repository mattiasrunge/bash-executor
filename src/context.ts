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
  private readonlyVars = new Set<string>();
  private integerVars = new Set<string>();
  private dirStack: string[] = [];

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

    for (const fn of Object.values(this.getFunctions())) {
      ctx.setFunction(fn.name, fn.body, fn.ctx);
    }

    for (const [name, args] of Object.entries(this.getAliases())) {
      ctx.setAlias(name, args);
    }

    // Copy variable attributes
    for (const name of this.readonlyVars) {
      ctx.setReadonlyVar(name, true);
    }
    for (const name of this.integerVars) {
      ctx.setIntegerVar(name, true);
    }

    // Copy directory stack
    for (const dir of this.getDirStack().reverse()) {
      ctx.pushDirStack(dir);
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

  getFunctions(): Record<string, FunctionDef> {
    if (this.parent) {
      return {
        ...this.parent.getFunctions(),
        ...this.fns,
      };
    }

    return this.fns;
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

  getAliases(): Record<string, string> {
    if (this.parent) {
      return this.parent.getAliases();
    }

    return { ...this.alias };
  }

  isReadonlyVar(name: string): boolean {
    if (this.parent) {
      return this.parent.isReadonlyVar(name);
    }

    return this.readonlyVars.has(name);
  }

  setReadonlyVar(name: string, readonly: boolean): void {
    if (this.parent) {
      this.parent.setReadonlyVar(name, readonly);
    } else if (readonly) {
      this.readonlyVars.add(name);
    } else {
      this.readonlyVars.delete(name);
    }
  }

  isIntegerVar(name: string): boolean {
    if (this.parent) {
      return this.parent.isIntegerVar(name);
    }

    return this.integerVars.has(name);
  }

  setIntegerVar(name: string, integer: boolean): void {
    if (this.parent) {
      this.parent.setIntegerVar(name, integer);
    } else if (integer) {
      this.integerVars.add(name);
    } else {
      this.integerVars.delete(name);
    }
  }

  getDirStack(): string[] {
    if (this.parent) {
      return this.parent.getDirStack();
    }

    return [...this.dirStack];
  }

  pushDirStack(dir: string): void {
    if (this.parent) {
      this.parent.pushDirStack(dir);
    } else {
      this.dirStack.unshift(dir);
    }
  }

  popDirStack(): string | undefined {
    if (this.parent) {
      return this.parent.popDirStack();
    }

    return this.dirStack.shift();
  }

  clearDirStack(): void {
    if (this.parent) {
      this.parent.clearDirStack();
    } else {
      this.dirStack.length = 0;
    }
  }

  removeDirStackAt(index: number): string | undefined {
    if (this.parent) {
      return this.parent.removeDirStackAt(index);
    }

    if (index < 0 || index >= this.dirStack.length) {
      return undefined;
    }

    return this.dirStack.splice(index, 1)[0];
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
