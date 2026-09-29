import type { AstNodeCompoundList } from '@ein/bash-parser';
import { JobTable } from './jobs.ts';
import { DEFAULT_SHELL_OPTIONS, DEFAULT_SHOPT_OPTIONS, type ExecContextIf, type FunctionDef, type IO } from './types.ts';

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
  private arrays: Record<string, string[]> = {};
  private assocs: Record<string, Record<string, string>> = {};
  private fns: Record<string, FunctionDef> = {};
  private alias: Record<string, string> = {};
  private traps: Record<string, string> = {};
  private jobTable = new JobTable();
  private readonlyVars = new Set<string>();
  private integerVars = new Set<string>();
  private dirStack: string[] = [];
  private fds: Record<string, string> = {};
  private options: Record<string, boolean> = { ...DEFAULT_SHELL_OPTIONS, ...DEFAULT_SHOPT_OPTIONS };
  private abortSignal?: AbortSignal;
  // undefined means "whatever the shell above says"; set explicitly, it decides
  private errexitSuppressed?: boolean;

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

      // `$#` is 0 in a shell nobody passed arguments to, not the empty string a
      // never-assigned parameter gives. Only the shell itself carries it: a
      // spawned context with its own would shadow whatever `set --` wrote.
      this.params['#'] = '0';
      // And `$?` is 0 before anything has run
      this.params['?'] = '0';
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

    // slice() so the subshell cannot mutate the caller's array, and so holes stay holes
    for (const [name, values] of Object.entries(this.getArrays())) {
      ctx.setArray(name, values.slice());
    }

    for (const [name, values] of Object.entries(this.getAssocs())) {
      ctx.setAssoc(name, { ...values });
    }

    ctx.redirectStdin(this.getStdin());
    ctx.redirectStdout(this.getStdout());
    ctx.redirectStderr(this.getStderr());

    for (const fn of Object.values(this.getFunctions())) {
      ctx.setFunction(fn.name, fn.body, fn.ctx);
    }

    for (const [name, args] of Object.entries(this.getAliases())) {
      ctx.setAlias(name, args);
    }

    ctx.jobTable = this.getJobTable().copy();

    // A subshell does not run the shell's traps, but what the shell ignores it
    // ignores too, as in bash
    for (const [name, action] of Object.entries(this.getTraps())) {
      if (action === '') {
        ctx.setTrap(name, '');
      }
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

    // Copy arbitrary file descriptors
    ctx.fds = { ...this.fds };

    // A subshell inherits the shell's options and cannot write them back
    ctx.options = { ...this.getShellOptions() };

    // `if ( false; echo here ); then` — the exemption covers the subshell too
    ctx.errexitSuppressed = this.getErrexitSuppressed();
    ctx.abortSignal = this.getAbortSignal();

    return ctx;
  }

  getAbortSignal(): AbortSignal | undefined {
    return this.abortSignal ?? this.parent?.getAbortSignal();
  }

  setAbortSignal(signal: AbortSignal | undefined): void {
    this.abortSignal = signal;
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

  getShellOption(name: string): boolean {
    if (this.parent) {
      return this.parent.getShellOption(name);
    }

    return this.options[name] ?? false;
  }

  getShellOptions(): Record<string, boolean> {
    if (this.parent) {
      return this.parent.getShellOptions();
    }

    return { ...this.options };
  }

  setShellOption(name: string, value: boolean): void {
    if (this.parent) {
      this.parent.setShellOption(name, value);
      return;
    }

    this.options[name] = value;
  }

  getErrexitSuppressed(): boolean {
    return this.errexitSuppressed ?? this.parent?.getErrexitSuppressed() ?? false;
  }

  setErrexitSuppressed(value: boolean): void {
    this.errexitSuppressed = value;
  }

  /**
   * bash's dynamic variables, in the shell's own context: their value is made
   * each time one is read. One that is unset is an ordinary variable from then on.
   */
  private dynamic = new Set(['SECONDS', 'EPOCHSECONDS', 'EPOCHREALTIME', 'RANDOM', 'SRANDOM', 'BASH_ARGV0']);
  private secondsFrom = Date.now();
  private secondsBase = 0;
  private randomSeed = Math.floor(Math.random() * 2 ** 31);

  private dynamicValue(name: string): string {
    const now = Date.now();

    switch (name) {
      case 'SECONDS':
        return String(this.secondsBase + Math.floor((now - this.secondsFrom) / 1000));
      case 'EPOCHSECONDS':
        return String(Math.floor(now / 1000));
      case 'EPOCHREALTIME': {
        const micros = Math.floor((performance.timeOrigin + performance.now()) * 1000);

        return `${Math.floor(micros / 1e6)}.${String(micros % 1e6).padStart(6, '0')}`;
      }
      case 'RANDOM':
        // bash's own generator is a different one; what matters is 0 to 32767, and a seed
        this.randomSeed = (this.randomSeed * 1103515245 + 12345) % 2 ** 31;
        return String(this.randomSeed >> 16 & 0x7fff);
      case 'SRANDOM':
        return String(crypto.getRandomValues(new Uint32Array(1))[0]);
      default:
        return this.params['0'] ?? '';
    }
  }

  /** Setting a dynamic variable: SECONDS counts on from it, RANDOM takes it as a seed, BASH_ARGV0 is $0. */
  private setDynamic(name: string, value: string): void {
    if (name === 'SECONDS') {
      this.secondsBase = Number.parseInt(value, 10) || 0;
      this.secondsFrom = Date.now();
    } else if (name === 'RANDOM') {
      this.randomSeed = (Number.parseInt(value, 10) || 0) % 2 ** 31;
    } else if (name === 'BASH_ARGV0') {
      this.params['0'] = value;
    }
  }

  getParams(): Record<string, string> {
    if (!this.parent) {
      if (this.dynamic.size === 0) {
        return this.params;
      }

      const params = { ...this.params };

      for (const name of this.dynamic) {
        params[name] = this.dynamicValue(name);
      }

      return params;
    }

    const params = { ...this.parent.getParams(), ...this.params };

    // A function frame's positional parameters are the whole set: after `shift`
    // its $3 is gone, not the caller's $3 showing through
    if ('#' in this.params) {
      for (const key of Object.keys(params)) {
        if (/^[1-9]\d*$/.test(key) && !(key in this.params)) {
          delete params[key];
        }
      }
    }

    return params;
  }

  /**
   * Assign where bash would: dynamic scoping sends a name to the nearest context
   * that has it — a function's `local x` takes `x=2` in that function and in
   * what it calls — and to the shell itself when none does. The positional
   * parameters belong, as one set, to the nearest function frame, so `shift`
   * and `set --` there leave the caller's arguments alone.
   */
  setParams(values: Record<string, string | null>): Record<string, string> {
    for (const [key, value] of Object.entries(values)) {
      this.paramOwner(key).setLocalParams({ [key]: value });
    }

    return this.getParams();
  }

  private paramOwner(key: string): ExecContext {
    const positional = /^([1-9]\d*|#|@|\*)$/.test(key);
    const holds = positional ? '#' in this.params : key in this.params;

    return holds || !this.parent ? this : this.parent.paramOwner(key);
  }

  setLocalParams(
    values: Record<string, string | null>,
  ): Record<string, string> {
    for (const key in values) {
      if (!this.parent && this.dynamic.has(key)) {
        if (values[key] === null) {
          this.dynamic.delete(key);
        } else {
          this.setDynamic(key, values[key]!);
        }

        continue;
      }

      if (values[key] === null) {
        delete this.params[key];
      } else {
        this.params[key] = values[key];
      }
    }

    return this.params;
  }

  getArray(name: string): string[] | undefined {
    if (this.arrays[name]) {
      return this.arrays[name];
    }

    return this.parent?.getArray(name);
  }

  getArrays(): Record<string, string[]> {
    if (this.parent) {
      return {
        ...this.parent.getArrays(),
        ...this.arrays,
      };
    }

    return this.arrays;
  }

  setArray(name: string, values: string[]): void {
    if (this.parent) {
      this.parent.setArray(name, values);
      return;
    }

    this.setLocalArray(name, values);
  }

  setLocalArray(name: string, values: string[]): void {
    this.arrays[name] = values;
  }

  setArrayElement(name: string, index: number, value: string): void {
    // The element goes where the array already is, so `a[0]=x` updates the array
    // it can see instead of shadowing it. A new array lands in the shell context,
    // the same place a plain assignment goes.
    const owner = this.ownerOfArray(name) ?? this.root();

    if (!owner.arrays[name]) {
      // A variable that was a plain one becomes the array's element 0
      const scalar = this.getParams()[name] ?? this.getEnv()[name];

      owner.arrays[name] = scalar === undefined ? [] : [scalar];

      if (scalar !== undefined) {
        this.setParams({ [name]: null });
      }
    }

    owner.arrays[name][index] = value;
  }

  unsetArray(name: string): void {
    delete this.arrays[name];
    this.parent?.unsetArray(name);
  }

  unsetArrayElement(name: string, index: number): void {
    const owner = this.ownerOfArray(name);

    if (owner) {
      delete owner.arrays[name][index];
    }
  }

  getAssoc(name: string): Record<string, string> | undefined {
    if (this.assocs[name]) {
      return this.assocs[name];
    }

    return this.parent?.getAssoc(name);
  }

  getAssocs(): Record<string, Record<string, string>> {
    if (this.parent) {
      return {
        ...this.parent.getAssocs(),
        ...this.assocs,
      };
    }

    return this.assocs;
  }

  setAssoc(name: string, values: Record<string, string>): void {
    if (this.parent) {
      this.parent.setAssoc(name, values);
      return;
    }

    this.setLocalAssoc(name, values);
  }

  setLocalAssoc(name: string, values: Record<string, string>): void {
    this.assocs[name] = values;
  }

  setAssocElement(name: string, key: string, value: string): void {
    const owner = this.ownerOfAssoc(name) ?? this.root();

    if (!owner.assocs[name]) {
      owner.assocs[name] = {};
    }

    owner.assocs[name][key] = value;
  }

  unsetAssoc(name: string): void {
    delete this.assocs[name];
    this.parent?.unsetAssoc(name);
  }

  unsetAssocElement(name: string, key: string): void {
    const owner = this.ownerOfAssoc(name);

    if (owner) {
      delete owner.assocs[name][key];
    }
  }

  private ownerOfAssoc(name: string): ExecContext | undefined {
    if (this.assocs[name]) {
      return this;
    }

    return this.parent?.ownerOfAssoc(name);
  }

  private ownerOfArray(name: string): ExecContext | undefined {
    if (this.arrays[name]) {
      return this;
    }

    return this.parent?.ownerOfArray(name);
  }

  private root(): ExecContext {
    return this.parent ? this.parent.root() : this;
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

  getJobTable(): JobTable {
    return this.parent ? this.parent.getJobTable() : this.jobTable;
  }

  getTrap(name: string): string | undefined {
    return this.parent ? this.parent.getTrap(name) : this.traps[name];
  }

  setTrap(name: string, action: string | null): void {
    if (this.parent) {
      this.parent.setTrap(name, action);
    } else if (action === null) {
      delete this.traps[name];
    } else {
      this.traps[name] = action;
    }
  }

  getTraps(): Record<string, string> {
    return this.parent ? this.parent.getTraps() : { ...this.traps };
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

  getFd(fd: string): string | undefined {
    if (fd === '0') return this.getStdin();
    if (fd === '1') return this.getStdout();
    if (fd === '2') return this.getStderr();
    if (this.fds[fd]) return this.fds[fd];
    if (this.parent) return this.parent.getFd(fd);
    return undefined;
  }

  redirectFd(fd: string, target: string): void {
    if (fd === '0') {
      this.redirectStdin(target);
      return;
    }
    if (fd === '1') {
      this.redirectStdout(target);
      return;
    }
    if (fd === '2') {
      this.redirectStderr(target);
      return;
    }
    if (this.parent) {
      this.parent.redirectFd(fd, target);
      return;
    }
    this.fds[fd] = target;
  }

  closeFd(fd: string): void {
    if (this.parent) {
      this.parent.closeFd(fd);
      return;
    }
    delete this.fds[fd];
  }

  getParent(): ExecContextIf | undefined {
    return this.parent;
  }

  assignVariable(name: string, value: string): void {
    if (this.getParams()[name] === undefined && name in this.getEnv()) {
      this.setEnv({ [name]: value });
    } else {
      this.setParams({ [name]: value });
    }
  }

  getFunctionScope(): ExecContextIf | undefined {
    // A function's context is the one below the shell's that holds positional
    // parameters of its own; a block or a command's context holds none
    if (!this.parent) {
      return undefined;
    }

    return '#' in this.params ? this : this.parent.getFunctionScope();
  }
}
