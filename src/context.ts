import type { AstNodeCompoundList } from '@ein/bash-parser';
import type { FunctionDefinition } from './print-command.ts';
import { JobTable } from './jobs.ts';
import { History } from './history.ts';
import type { CompSpec } from './completion.ts';
import {
  type DeclareOptions,
  DEFAULT_SHELL_OPTIONS,
  DEFAULT_SHOPT_OPTIONS,
  type ExecContextIf,
  type FunctionDef,
  type GetoptsState,
  type IO,
  type VariableInfo,
  type VariableKind,
} from './types.ts';

// TODO: We need to define when cwd or params should go to parent or not...

/**
 * Execution context for shell commands, managing environment variables, I/O streams, and function definitions.
 */
/** bash's dynamic variables: made each time they are read. */
const DYNAMIC_PARAMS = ['SECONDS', 'EPOCHSECONDS', 'EPOCHREALTIME', 'RANDOM', 'SRANDOM', 'BASH_ARGV0', 'BASHPID', 'SHELLOPTS', 'BASHOPTS', 'BASH_SUBSHELL'];

/** The dynamic variables bash makes readonly: the lists of options that are on */
const OPTION_LISTS = new Set(['SHELLOPTS', 'BASHOPTS']);

/** The next subshell's BASHPID: no process of its own, so a number above Linux's pids */
let nextSubshellPid = 2 ** 22 + 100_000;

/**
 * The parameters that change from one command to the next without anything
 * being set: `$?`, `$LINENO`, `$BASH_COMMAND` and the dynamic variables. A host
 * that keeps the shell's state somewhere, or asks whether it changed, leaves
 * them out.
 */
export const VOLATILE_PARAMS: ReadonlySet<string> = new Set(['?', 'LINENO', 'BASH_COMMAND', ...DYNAMIC_PARAMS]);

/**
 * A shell variable as a scope holds it: a string, an indexed array (sparse, as
 * bash's are) or an associative one — or no value at all while it is only
 * declared, `declare x`, `local -a y` — and its attributes, as declare's letters.
 */
type Variable = {
  kind: VariableKind;
  value?: string | string[] | Record<string, string>;
  attrs: Set<string>;
};

const newVariable = (kind: VariableKind): Variable => ({ kind, attrs: new Set() });

const copyVariable = (variable: Variable): Variable => ({
  kind: variable.kind,
  value: Array.isArray(variable.value) ? variable.value.slice() : typeof variable.value === 'object' ? { ...variable.value } : variable.value,
  attrs: new Set(variable.attrs),
});

/** bash's order of attribute letters, as declare -p writes them. */
const ATTRIBUTE_ORDER = 'aAfinrtxclu';

const variableInfo = (variable: Variable, local: boolean): VariableInfo => ({
  kind: variable.kind,
  value: variable.value,
  attributes: [...variable.attrs].sort((a, b) => ATTRIBUTE_ORDER.indexOf(a) - ATTRIBUTE_ORDER.indexOf(b)).join(''),
  local,
});

/** A value as a variable with `-l`, `-u` or `-c` keeps it. */
const cased = (variable: Variable, value: string): string =>
  variable.attrs.has('l')
    ? value.toLowerCase()
    : variable.attrs.has('u')
    ? value.toUpperCase()
    : variable.attrs.has('c')
    ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
    : value;

/** `$1`, `$#`, `$?` and the like: parameters, but no variables. */
/** How many name references bash follows before it calls the chain circular. */
const NAMEREF_MAX = 8;

const isSpecialParam = (name: string): boolean => /^(\d+|[#@*?$!-])$/.test(name);

export class ExecContext implements ExecContextIf {
  private cwd = '/';
  private parent?: ExecContext;
  private io: IO;
  /** The positional and special parameters, `$1` `$#` `$?` …, which are no variables */
  private special: Record<string, string> = {};
  /** The variables this scope holds: the shell's, a function's locals, a command's own environment */
  private vars = new Map<string, Variable>();
  private fns: Record<string, FunctionDef> = {};
  private traps: Record<string, string> = {};
  /** The shell's traps, as a subshell's `trap` lists them until it sets one of its own */
  private inheritedTraps?: Record<string, string>;
  // The shell's own, in its root context alone: a spawned one asks the root
  private jobTable!: JobTable;
  private getoptsState?: GetoptsState;
  private umask = 0o022;
  private resourceLimits: Record<string, { soft: string; hard: string }> = {};
  private history?: History;
  private completionSpecs?: Map<string, CompSpec>;
  /** What `local -` saved in this function's scope */
  private savedOptions?: Record<string, boolean>;
  private dirStack: string[] = [];
  private fds: Record<string, string> = {};
  private options!: Record<string, boolean>;
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
      this.special['#'] = '0';
      // And `$?` is 0 before anything has run
      this.special['?'] = '0';

      // The shell's own tables, as bash shows them: the aliases and the hashed commands
      this.vars.set('BASH_ALIASES', { kind: 'assoc', value: {}, attrs: new Set() });
      this.vars.set('BASH_CMDS', { kind: 'assoc', value: {}, attrs: new Set() });

      // What only the shell has, made once for it rather than for every command's context
      this.jobTable = new JobTable();
      this.options = { ...DEFAULT_SHELL_OPTIONS, ...DEFAULT_SHOPT_OPTIONS };
      this.dynamic = new Set(DYNAMIC_PARAMS);
      this.secondsFrom = Date.now();
      this.randomSeed = Math.floor(Math.random() * 2 ** 31);
    }
  }

  spawnContext(): ExecContextIf {
    return new ExecContext(this);
  }

  subContext(subshell = false, nested = subshell): ExecContextIf {
    const ctx = new ExecContext();

    ctx.setCwd(this.getCwd());

    // Every variable the subshell can see becomes its own, copied so it cannot
    // write back: slice() keeps an array's holes holes
    for (const [name, variable] of this.visibleVariables()) {
      ctx.vars.set(name, copyVariable(variable));
    }

    for (const [name, value] of Object.entries(this.getParams())) {
      if (isSpecialParam(name)) ctx.special[name] = value;
    }

    ctx.redirectStdin(this.getStdin());
    ctx.redirectStdout(this.getStdout());
    ctx.redirectStderr(this.getStderr());

    for (const fn of Object.values(this.getFunctions())) {
      ctx.setFunction(fn.name, fn.body, fn.ctx, fn.definition);
      if (fn.readonly) ctx.getFunction(fn.name)!.readonly = true;
    }

    for (const [name, args] of Object.entries(this.getAliases())) {
      ctx.setAlias(name, args);
    }

    ctx.jobTable = this.getJobTable().copy();
    ctx.getoptsState = this.getGetoptsState();
    ctx.umask = this.getUmask();
    ctx.resourceLimits = { ...this.getResourceLimits() };
    ctx.history = this.root().history?.copy();
    ctx.completionSpecs = new Map([...this.getCompletionSpecs()].map(([name, spec]) => [name, { ...spec, actions: [...spec.actions], options: [...spec.options] }]));

    // A subshell does not run the shell's traps, but what the shell ignores it
    // ignores too, as in bash
    for (const [name, action] of Object.entries(this.getTraps())) {
      if (action === '') {
        ctx.setTrap(name, '');
      }
    }

    // …and `trap` in it lists the shell's, until it sets one of its own
    ctx.inheritedTraps = this.getListedTraps();

    // Copy directory stack
    for (const dir of this.getDirStack().reverse()) {
      ctx.pushDirStack(dir);
    }

    // The descriptors above 2 the subshell starts with, the shell's and its command's own
    ctx.fds = this.visibleFds();

    // A process of its own, as far as $BASHPID tells, or still the shell's
    ctx.subshellPid = subshell ? String(nextSubshellPid++) : this.subshellPid;
    // One level deeper in BASH_SUBSHELL, unless a simple command in a pipeline, which bash forks without
    ctx.subshellLevel = this.root().subshellLevel + (nested ? 1 : 0);

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
    const env: Record<string, string> = {};

    for (const [name, variable] of this.visibleVariables()) {
      if (variable.attrs.has('x') && !variable.attrs.has('n') && typeof variable.value === 'string') env[name] = variable.value;
    }

    return env;
  }

  setEnv(values: Record<string, string | null>): Record<string, string> {
    this.assigningSpecial(values);

    for (const [name, value] of Object.entries(values)) {
      if (value === null) {
        // What is exported goes; one that is not was never in the environment
        if (this.lookup(this.ref(name))?.variable.attrs.has('x')) this.unsetVariable(name);
      } else {
        this.assignVariableValue(name, value)?.attrs.add('x');
      }
    }

    return this.getEnv();
  }

  setLocalEnv(values: Record<string, string | null>): Record<string, string> {
    this.assigningSpecial(values);

    for (const [name, value] of Object.entries(values)) {
      if (value === null) {
        if (this.vars.get(name)?.attrs.has('x')) this.vars.delete(name);
      } else {
        this.assign(this, this.ref(name), value).attrs.add('x');
      }
    }

    return this.getEnv();
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

    const before = this.options[name];

    this.options[name] = value;

    // `set -o ignoreeof` is IGNOREEOF=10, `set +o ignoreeof` no IGNOREEOF, as in bash
    if (name === 'ignoreeof' && before !== value) this.setParams({ IGNOREEOF: value ? '10' : null });
  }

  /** `local -`: the `set` options as they are, for the function to put back when it returns. */
  saveLocalOptions(): void {
    this.savedOptions ??= Object.fromEntries(Object.keys(DEFAULT_SHELL_OPTIONS).map((name) => [name, this.getShellOption(name)]));
  }

  /** The function returns: the options `local -` saved come back. */
  restoreLocalOptions(): void {
    if (!this.savedOptions) return;

    for (const [name, value] of Object.entries(this.savedOptions)) {
      if (this.getShellOption(name) !== value) this.setShellOption(name, value);
    }

    this.savedOptions = undefined;
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
  private dynamic!: Set<string>;
  private secondsFrom = 0;
  private secondsBase = 0;
  private randomSeed = 0;
  /** The value RANDOM gave last, which bash never gives twice in a row */
  private lastRandom = -1;
  /** A subshell's own BASHPID; the shell's is `$$` */
  private subshellPid?: string;
  /** How many subshells deep this shell is: BASH_SUBSHELL */
  private subshellLevel = 0;

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
      case 'RANDOM': {
        // bash 5.2's own generator, so that `RANDOM=42` starts the sequence bash's does
        let value: number;

        do value = this.nextRandom(); while (value === this.lastRandom);

        this.lastRandom = value;
        return String(value);
      }
      case 'SRANDOM':
        return String(crypto.getRandomValues(new Uint32Array(1))[0]);
      case 'BASHPID':
        return this.subshellPid ?? this.special['$'] ?? '';
      case 'BASH_SUBSHELL':
        return String(this.subshellLevel);
      case 'SHELLOPTS':
        // The `set -o` options that are on, in order, colon-separated; BASHOPTS shopt's
        return Object.keys(DEFAULT_SHELL_OPTIONS).filter((option) => this.getShellOption(option)).sort().join(':');
      case 'BASHOPTS':
        return Object.keys(DEFAULT_SHOPT_OPTIONS).filter((option) => this.getShellOption(option)).sort().join(':');
      default:
        return this.special['0'] ?? '';
    }
  }

  /**
   * bash's brand(): the minimal standard generator (Park and Miller, by
   * Schrage's method), its high and low halves folded together, 0 to 32767.
   */
  private nextRandom(): number {
    let seed = this.randomSeed === 0 ? 123459876 : this.randomSeed;
    const high = Math.floor(seed / 127773);
    const low = seed - 127773 * high;
    const next = 16807 * low - 2836 * high;

    seed = next < 0 ? next + 0x7fffffff : next;
    this.randomSeed = seed;

    return ((seed >>> 16) ^ (seed & 0xffff)) & 0x7fff;
  }

  /** Setting a dynamic variable: SECONDS counts on from it, RANDOM takes it as a seed, BASH_ARGV0 is $0. */
  private setDynamic(name: string, value: string): void {
    if (name === 'SECONDS') {
      this.secondsBase = Number.parseInt(value, 10) || 0;
      this.secondsFrom = Date.now();
    } else if (name === 'RANDOM') {
      // As strtol reads it, into 32 bits
      this.randomSeed = (Number.parseInt(value, 10) || 0) >>> 0;
      this.lastRandom = -1;
    } else if (name === 'BASH_ARGV0') {
      this.special['0'] = value;
    }
  }

  getParams(): Record<string, string> {
    const params: Record<string, string> = {};
    const chain = this.chain();

    for (const scope of chain) {
      // A function frame's positional parameters are the whole set: after `shift`
      // its $3 is gone, not the caller's $3 showing through
      if (scope.parent && '#' in scope.special) {
        for (const key of Object.keys(params)) {
          if (/^[1-9]\d*$/.test(key)) delete params[key];
        }
      }

      Object.assign(params, scope.special);
    }

    const visible = this.visibleVariables();

    for (const [name, variable] of visible) {
      if (variable.attrs.has('n')) {
        // `$ref` is what it refers to
        const value = this.scalarOf(name);
        if (value !== undefined) params[name] = value;
      } else if (!variable.attrs.has('x') && typeof variable.value === 'string') {
        params[name] = variable.value;
      }
    }

    const root = chain[0];

    for (const name of root.dynamic) {
      if (!visible.has(name)) params[name] = root.dynamicValue(name);
    }

    return params;
  }

  /**
   * One parameter as `$name` gives it, without making all of them: a special or
   * positional one, the nearest variable of that name (what a nameref refers
   * to), exported or not, or a dynamic one. An array is not one here, as it is
   * not in `getParams`.
   */
  /** A special parameter from the nearest scope that has it; a function's positional ones stop at its frame. */
  private specialParam(name: string, positional: boolean): string | undefined {
    if (name in this.special) return this.special[name];
    if (positional && this.parent && '#' in this.special) return undefined;

    return this.parent?.specialParam(name, positional);
  }

  getParam(name: string): string | undefined {
    if (isSpecialParam(name)) {
      // A function frame's positional parameters are the whole set, as in getParams
      const positional = /^([1-9]\d*|#|@|\*)$/.test(name);

      return this.specialParam(name, positional);
    }

    const found = this.lookup(name);

    if (found) {
      if (found.variable.attrs.has('n')) return this.scalarOf(name);

      return typeof found.variable.value === 'string' ? found.variable.value : undefined;
    }

    const root = this.root();

    return root.dynamic.has(name) ? root.dynamicValue(name) : undefined;
  }

  /**
   * Assign where bash would: dynamic scoping sends a name to the nearest context
   * that has it — a function's `local x` takes `x=2` in that function and in
   * what it calls — and to the shell itself when none does. The positional
   * parameters belong, as one set, to the nearest function frame, so `shift`
   * and `set --` there leave the caller's arguments alone.
   */
  setParams(values: Record<string, string | null>): Record<string, string> {
    this.assigningSpecial(values);

    for (const [key, value] of Object.entries(values)) {
      if (isSpecialParam(key)) {
        this.paramOwner(key).setLocalParams({ [key]: value });
        continue;
      }

      const root = this.root();

      if (root.dynamic.has(key) && !this.lookup(key)) {
        root.setLocalParams({ [key]: value });
      } else if (value === null) {
        // Unsetting a scalar; an array of that name is `unset`'s to remove
        const target = this.ref(key);
        if (this.lookup(target)?.variable.kind === 'scalar') this.unsetVariable(key);
      } else {
        this.assignVariableValue(key, value);
      }
    }

    // What was set, not every parameter: making those on every assignment cost more than the rest of a command
    return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null));
  }

  private paramOwner(key: string): ExecContext {
    const positional = /^([1-9]\d*|#|@|\*)$/.test(key);
    const holds = positional ? '#' in this.special : key in this.special;

    return holds || !this.parent ? this : this.parent.paramOwner(key);
  }

  /** This scope's own: its positional and special parameters, and its scalar variables. */
  setLocalParams(
    values: Record<string, string | null>,
  ): Record<string, string> {
    this.assigningSpecial(values);

    for (const key in values) {
      const value = values[key];

      if (isSpecialParam(key)) {
        if (value === null) delete this.special[key];
        else this.special[key] = value;
      } else if (!this.parent && this.dynamic.has(key)) {
        if (value === null) {
          this.dynamic.delete(key);
        } else {
          this.setDynamic(key, value);
        }
      } else if (value === null) {
        if (this.vars.get(key)?.kind === 'scalar') this.vars.delete(key);
      } else {
        // `ref=x cmd` gives what ref refers to a value for the command
        this.assign(this, this.ref(key), value);
      }
    }

    // What was set; the scope's own are `getOwnVariables`, not made on every assignment
    return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null));
  }

  getArray(name: string): string[] | undefined {
    name = this.ref(name);

    const variable = this.lookup(name)?.variable;

    // DIRSTACK is what `dirs` shows: the working directory, then the stack
    if (name === 'DIRSTACK' && !variable) return [this.getCwd(), ...this.getDirStack()];

    if (variable?.kind !== 'array') return undefined;

    // Declared and not yet assigned, `declare -a x`: an array with nothing in it
    return Array.isArray(variable.value) ? variable.value : [];
  }

  getArrays(): Record<string, string[]> {
    const arrays: Record<string, string[]> = {};

    for (const [name, variable] of this.visibleVariables()) {
      if (variable.kind === 'array' && Array.isArray(variable.value)) arrays[name] = variable.value;
    }

    return arrays;
  }

  setArray(name: string, values: string[]): void {
    name = this.ref(name);

    this.storeArray(this.ownerOf(name), name, values);
  }

  setLocalArray(name: string, values: string[]): void {
    name = this.ref(name);

    this.storeArray(this, name, values);
  }

  setArrayElement(name: string, index: number, value: string): void {
    name = this.ref(name);

    // DIRSTACK[N]=dir changes the Nth entry `dirs` shows; the working directory, 0, stays
    if (name === 'DIRSTACK' && !this.lookup(name)) {
      const stack = this.getDirStack();

      if (index >= 1 && index <= stack.length) {
        stack[index - 1] = value;
        this.clearDirStack();
        for (const dir of stack.reverse()) this.pushDirStack(dir);
      }

      return;
    }

    // The element goes where the variable already is, so `a[0]=x` updates the
    // array it can see instead of shadowing it; a new one lands in the shell.
    const owner = this.ownerOf(name);
    const variable = owner.vars.get(name) ?? newVariable('array');

    owner.vars.set(name, variable);

    if (variable.kind === 'assoc') {
      (variable.value as Record<string, string> | undefined ?? (variable.value = {}))[String(index)] = cased(variable, value);
      return;
    }

    // A variable that was a plain one becomes the array's element 0
    if (variable.kind === 'scalar') {
      variable.value = typeof variable.value === 'string' ? [variable.value] : [];
      variable.kind = 'array';
    }

    if (!Array.isArray(variable.value)) variable.value = [];

    variable.value[index] = cased(variable, value);
  }

  unsetArray(name: string): void {
    name = this.ref(name);

    if (this.lookup(name)?.variable.kind === 'array') this.unsetVariable(name);
  }

  unsetArrayElement(name: string, index: number): void {
    name = this.ref(name);

    const variable = this.lookup(name)?.variable;

    if (variable?.kind === 'array' && Array.isArray(variable.value)) {
      delete variable.value[index];
    }
  }

  getAssoc(name: string): Record<string, string> | undefined {
    name = this.ref(name);

    const variable = this.lookup(name)?.variable;

    if (variable?.kind !== 'assoc') return undefined;

    // Declared and not yet assigned, `declare -A h`: it takes `[key]=value` elements already
    return variable.value && typeof variable.value === 'object' && !Array.isArray(variable.value) ? variable.value : {};
  }

  getAssocs(): Record<string, Record<string, string>> {
    const assocs: Record<string, Record<string, string>> = {};

    for (const [name, variable] of this.visibleVariables()) {
      if (variable.kind === 'assoc' && variable.value && typeof variable.value === 'object' && !Array.isArray(variable.value)) {
        assocs[name] = variable.value;
      }
    }

    return assocs;
  }

  setAssoc(name: string, values: Record<string, string>): void {
    name = this.ref(name);

    this.storeAssoc(this.ownerOf(name), name, values);
  }

  setLocalAssoc(name: string, values: Record<string, string>): void {
    name = this.ref(name);

    this.storeAssoc(this, name, values);
  }

  setAssocElement(name: string, key: string, value: string): void {
    name = this.ref(name);

    const owner = this.ownerOf(name);
    const variable = owner.vars.get(name) ?? newVariable('assoc');

    owner.vars.set(name, variable);

    if (variable.kind !== 'assoc' || !variable.value || typeof variable.value !== 'object' || Array.isArray(variable.value)) {
      variable.kind = 'assoc';
      variable.value = {};
    }

    variable.value[key] = cased(variable, value);
  }

  unsetAssoc(name: string): void {
    name = this.ref(name);

    if (this.lookup(name)?.variable.kind === 'assoc') this.unsetVariable(name);
  }

  unsetAssocElement(name: string, key: string): void {
    name = this.ref(name);

    const variable = this.lookup(name)?.variable;

    if (variable?.kind === 'assoc' && variable.value && typeof variable.value === 'object' && !Array.isArray(variable.value)) {
      delete variable.value[key];
    }
  }

  /** SHELLOPTS or BASHOPTS while still bash's own: readonly, their value the options on now. */
  private optionList(name: string): VariableInfo | undefined {
    const root = this.root();

    if (!OPTION_LISTS.has(name) || !root.dynamic?.has(name)) return undefined;

    return { kind: 'scalar', value: root.dynamicValue(name), attributes: 'r', local: false };
  }

  getVariable(name: string): VariableInfo | undefined {
    const list = this.optionList(name);

    if (list) return list;

    const found = this.lookup(name);

    return found ? variableInfo(found.variable, found.scope !== this.root()) : undefined;
  }

  getVariables(): Record<string, VariableInfo> {
    const root = this.root();
    const infos: Record<string, VariableInfo> = {};

    for (const scope of this.chain()) {
      for (const [name, variable] of scope.vars) infos[name] = variableInfo(variable, scope !== root);
    }

    for (const name of OPTION_LISTS) {
      const list = this.optionList(name);

      if (list) infos[name] = list;
    }

    return infos;
  }

  getOwnVariables(): Record<string, VariableInfo> {
    const infos: Record<string, VariableInfo> = {};

    for (const [name, variable] of this.vars) infos[name] = variableInfo(variable, Boolean(this.parent));

    return infos;
  }

  declareVariable(name: string, opts: DeclareOptions = {}): void {
    // `declare -i ref` gives what ref refers to the attribute; making or
    // unmaking a reference is about the reference itself
    const refers = opts.noref || opts.add?.includes('n') || opts.remove?.includes('n');
    // `local x` makes a new x: a reference of that name further out is not followed, only one of its own
    const newLocal = opts.local && !this.vars.has(name);

    if (!refers && !newLocal) name = this.ref(name);

    const found = this.lookup(name);
    // `local x` is a variable of the function's own, whatever the caller has
    const owner = opts.local ? this : found?.scope ?? this.root();
    let variable = owner.vars.get(name);

    if (!variable) {
      variable = newVariable(opts.kind ?? 'scalar');
      owner.vars.set(name, variable);
    }

    if (opts.kind && opts.kind !== variable.kind) {
      // A scalar's value is element 0 of what it becomes
      const scalar = typeof variable.value === 'string' ? variable.value : undefined;

      variable.value = scalar === undefined ? undefined : opts.kind === 'array' ? [scalar] : opts.kind === 'assoc' ? { '0': scalar } : scalar;
      variable.kind = opts.kind;
    }

    for (const attr of opts.remove ?? '') variable.attrs.delete(attr);

    // A reference's own value, the name it refers to, set as it is
    if (opts.value !== undefined) variable.value = opts.value;

    for (const attr of opts.add ?? '') {
      // Upper, lower and capitalized case exclude each other: the one given last wins
      if ('luc'.includes(attr)) { for (const other of 'luc') variable.attrs.delete(other); }
      variable.attrs.add(attr);
    }
  }

  unsetVariable(name: string, opts: { noref?: boolean } = {}): void {
    // `unset ref` unsets what it refers to, `unset -n ref` the reference
    const resolved = opts.noref ? name : this.resolveNameref(name);
    const element = opts.noref ? undefined : this.element(resolved);

    if (element) {
      const target = this.lookup(element.name)?.variable;

      if (Array.isArray(target?.value)) delete target.value[Number.parseInt(element.key, 10) || 0];
      else if (target?.value && typeof target.value === 'object') delete target.value[element.key];

      return;
    }

    name = resolved;

    const found = this.lookup(name);

    if (!found) return;

    if (name === 'HISTSIZE') this.historySize(null);

    // A local unset in its own function stays local: assigning it again sets the
    // function's own, as in bash. One a calling function made goes, and what it
    // hid shows again, unless localvar_unset says otherwise
    const own = found.scope === this.getFunctionScope() || this.getShellOption('localvar_unset');

    if (found.scope.parent && own) {
      found.scope.vars.set(name, newVariable('scalar'));
    } else {
      found.scope.vars.delete(name);
    }
  }

  // -- the variable store --------------------------------------------------------------------

  /**
   * Where a name leads once its name references are followed, as bash's
   * find_variable does: `r` after `declare -n r=a` is `a`, and a reference to
   * an element keeps its subscript, `a[1]`. A nameref with no value yet leads
   * to itself, so assigning it gives it one. bash gives up after 8 steps.
   */
  resolveNameref(name: string): string {
    if (this.namerefLoops(name)) return name;

    let current = name;

    for (let depth = 0; depth < NAMEREF_MAX; depth++) {
      const variable = this.lookup(current)?.variable;

      if (!variable?.attrs.has('n') || typeof variable.value !== 'string' || variable.value === '') return current;

      current = variable.value;

      if (current.includes('[')) return current;
    }

    return current;
  }

  /**
   * Whether following a name's references comes back round, which bash takes
   * 8 steps to be sure of: `declare -n a=b b=a`, or a function's `local -n v=$1`
   * called with `v`. Such a name has no value and takes none, except in a
   * function, where bash reads and assigns the shell's variable of that name.
   */
  namerefLoops(name: string): boolean {
    let current = name;

    for (let depth = 0; depth <= NAMEREF_MAX; depth++) {
      const variable = this.lookup(current)?.variable;

      if (!variable?.attrs.has('n') || typeof variable.value !== 'string' || variable.value === '' || variable.value.includes('[')) return false;

      current = variable.value;
    }

    return true;
  }

  /** A name references followed, and without the subscript one to an element carries: what array operations take. */
  private ref(name: string): string {
    const resolved = this.resolveNameref(name);

    return /^[A-Za-z_][A-Za-z0-9_]*\[/.test(resolved) ? resolved.slice(0, resolved.indexOf('[')) : resolved;
  }

  /** A reference to an element, `a[1]`, split; undefined for a plain name. */
  private element(resolved: string): { name: string; key: string } | undefined {
    const match = resolved.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s);

    return match ? { name: match[1], key: match[2] } : undefined;
  }

  /** What `$name` gives, name references followed: a string, element 0 of an array, or the element referred to. */
  private scalarOf(name: string): string | undefined {
    if (this.namerefLoops(name)) {
      // A function's reference round to itself reads the shell's variable of that name, as it assigns it
      const root = this.root();
      const global = this.lookup(name)!.scope !== root ? root.vars.get(name) : undefined;

      const value = global?.value;

      return Array.isArray(value) ? value[0] : value && typeof value === 'object' ? value['0'] : value;
    }

    const resolved = this.resolveNameref(name);
    const element = this.element(resolved);
    const variable = this.lookup(element?.name ?? resolved)?.variable;

    if (!variable || variable.attrs.has('n') && resolved === name) return undefined;
    if (Array.isArray(variable.value)) return variable.value[element ? Number.parseInt(element.key, 10) || 0 : 0];
    if (variable.value && typeof variable.value === 'object') return variable.value[element?.key ?? '0'];

    // A plain variable is its own element 0
    return element && element.key !== '0' ? undefined : variable.value;
  }

  /** The contexts from the shell's own down to this one. */
  private chain(): ExecContext[] {
    return this.parent ? [...this.parent.chain(), this] : [this];
  }

  /** The nearest variable of that name, and the context holding it. */
  private lookup(name: string): { scope: ExecContext; variable: Variable } | undefined {
    const variable = this.vars.get(name);

    return variable ? { scope: this, variable } : this.parent?.lookup(name);
  }

  /** Where assigning `name` goes: the context that has it, or the shell. */
  private ownerOf(name: string): ExecContext {
    return this.lookup(name)?.scope ?? this.root();
  }

  /** Every variable this context sees, each the nearest of its name. */
  private visibleVariables(): Map<string, Variable> {
    const visible = new Map<string, Variable>();

    for (const scope of this.chain()) {
      for (const [name, variable] of scope.vars) visible.set(name, variable);
    }

    return visible;
  }

  /** `name=value` on the variable `scope` holds, made there if it has none; an array takes it as element 0. */
  private assign(scope: ExecContext, name: string, value: string): Variable {
    const variable = scope.vars.get(name) ?? newVariable('scalar');

    scope.vars.set(name, variable);

    if (variable.kind === 'array') {
      if (!Array.isArray(variable.value)) variable.value = [];
      variable.value[0] = cased(variable, value);
    } else if (variable.kind === 'assoc') {
      if (!variable.value || typeof variable.value !== 'object' || Array.isArray(variable.value)) variable.value = {};
      variable.value['0'] = cased(variable, value);
    } else {
      variable.value = cased(variable, value);
    }

    return variable;
  }

  /** Assign a variable wherever it is, or in the shell when it is nowhere; through a name reference, what it refers to. */
  private assignVariableValue(name: string, value: string): Variable | undefined {
    if (this.namerefLoops(name)) {
      const root = this.root();

      // A function's reference round to itself: bash assigns the shell's variable instead, when that one leads somewhere
      return this.lookup(name)!.scope !== root && !root.namerefLoops(name) ? root.assignVariableValue(name, value) : undefined;
    }

    const resolved = this.resolveNameref(name);
    const element = this.element(resolved);

    if (element) {
      if (this.lookup(element.name)?.variable.kind === 'assoc') this.setAssocElement(element.name, element.key, value);
      else this.setArrayElement(element.name, Number.parseInt(element.key, 10) || 0, value);

      return this.lookup(element.name)!.variable;
    }

    return this.assign(this.ownerOf(resolved), resolved, value);
  }

  private storeArray(scope: ExecContext, name: string, values: string[]): void {
    const variable = scope.vars.get(name) ?? newVariable('array');

    variable.kind = 'array';
    variable.value = ['l', 'u', 'c'].some((attr) => variable.attrs.has(attr)) ? values.map((value) => cased(variable, value)) : values;
    scope.vars.set(name, variable);
  }

  private storeAssoc(scope: ExecContext, name: string, values: Record<string, string>): void {
    const variable = scope.vars.get(name) ?? newVariable('assoc');

    variable.kind = 'assoc';
    variable.value = ['l', 'u', 'c'].some((attr) => variable.attrs.has(attr))
      ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, cased(variable, value)]))
      : values;
    scope.vars.set(name, variable);
  }

  private root(): ExecContext {
    return this.parent ? this.parent.root() : this;
  }

  setFunction(
    name: string,
    body: AstNodeCompoundList,
    ctx: ExecContextIf,
    definition?: FunctionDefinition,
  ): void {
    if (this.parent) {
      return this.parent.setFunction(name, body, ctx, definition);
    }

    this.fns[name] = {
      name,
      body,
      ctx,
      definition,
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

  /** The aliases are BASH_ALIASES, as in bash: assigning an element defines one. */
  private aliasTable(): Record<string, string> | undefined {
    return this.root().getAssoc('BASH_ALIASES');
  }

  setAlias(name: string, alias: string): void {
    this.root().setAssocElement('BASH_ALIASES', name, alias);
  }

  unsetAlias(name: string): void {
    this.root().unsetAssocElement('BASH_ALIASES', name);
  }

  getJobTable(): JobTable {
    return this.parent ? this.parent.getJobTable() : this.jobTable;
  }

  /**
   * What assigning a variable does besides: a new OPTIND starts getopts over,
   * as bash's sv_optind does, a new PATH empties the table of hashed
   * commands, as its sv_path does, POSIXLY_CORRECT turns posix mode on while
   * it is set, as sv_strict_posix does, IGNOREEOF ignoreeof, and HISTSIZE how long the history is.
   */
  private assigningSpecial(values: Record<string, string | null>): void {
    if ('OPTIND' in values) this.setGetoptsState(undefined);
    if ('POSIXLY_CORRECT' in values) this.setShellOption('posix', values.POSIXLY_CORRECT !== null);
    // IGNOREEOF set is ignoreeof on, as sv_ignoreeof has it
    if ('IGNOREEOF' in values) this.root().options.ignoreeof = values.IGNOREEOF !== null;
    if ('PATH' in values) this.root().setLocalAssoc('BASH_CMDS', {});
    if ('HISTSIZE' in values) this.historySize(values.HISTSIZE);
  }

  /** sv_histsize: HISTSIZE keeps the history to so many entries, unset or negative any number. */
  private historySize(value: string | null): void {
    const n = value && /^[ \t\n]*[-+]?\d+[ \t\n]*$/.test(value) ? Number(value.trim()) : undefined;

    if (value === null || value === '' || (n !== undefined && n < 0)) this.getHistory().unstifle();
    else if (n !== undefined) this.getHistory().stifle(n);
  }

  getUmask(): number {
    return this.root().umask;
  }

  setUmask(mask: number): void {
    this.root().umask = mask & 0o777;
  }

  getCompletionSpecs(): Map<string, CompSpec> {
    const root = this.root();

    return root.completionSpecs ??= new Map();
  }

  getHistory(): History {
    const root = this.root();

    return root.history ??= new History();
  }

  getResourceLimits(): Record<string, { soft: string; hard: string }> {
    return this.root().resourceLimits;
  }

  setResourceLimit(letter: string, limit: { soft: string; hard: string }): void {
    this.root().resourceLimits[letter] = limit;
  }

  getGetoptsState(): GetoptsState | undefined {
    return this.root().getoptsState;
  }

  setGetoptsState(state: GetoptsState | undefined): void {
    this.root().getoptsState = state;
  }

  getTrap(name: string): string | undefined {
    return this.parent ? this.parent.getTrap(name) : this.traps[name];
  }

  setTrap(name: string, action: string | null): void {
    if (this.parent) {
      this.parent.setTrap(name, action);
      return;
    }

    this.inheritedTraps = undefined;

    if (action === null) {
      delete this.traps[name];
    } else {
      this.traps[name] = action;
    }
  }

  getTraps(): Record<string, string> {
    return this.parent ? this.parent.getTraps() : { ...this.traps };
  }

  getListedTraps(): Record<string, string> {
    const root = this.root();

    return root.inheritedTraps ? { ...root.inheritedTraps } : root.getTraps();
  }

  getAlias(name: string): string | undefined {
    const table = this.aliasTable();

    return table && Object.hasOwn(table, name) ? table[name] : undefined;
  }

  getAliases(): Record<string, string> {
    return { ...this.aliasTable() };
  }

  isReadonlyVar(name: string): boolean {
    name = this.ref(name);

    if (this.optionList(name)) return true;

    return this.lookup(name)?.variable.attrs.has('r') ?? false;
  }

  setReadonlyVar(name: string, readonly: boolean): void {
    this.declareVariable(name, readonly ? { add: 'r' } : { remove: 'r' });
  }

  isIntegerVar(name: string): boolean {
    name = this.ref(name);

    return this.lookup(name)?.variable.attrs.has('i') ?? false;
  }

  setIntegerVar(name: string, integer: boolean): void {
    this.declareVariable(name, integer ? { add: 'i' } : { remove: 'i' });
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
    if (fd in this.fds) return this.fds[fd] || undefined;
    if (this.parent) return this.parent.getFd(fd);
    return undefined;
  }

  redirectFd(fd: string, target: string, local = false): void {
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
    // One command's own, `cmd 3<file`, is gone with the command's context;
    // any other is the shell's, `exec 3<file`, and nothing in between hides it
    if (local && this.parent) {
      this.fds[fd] = target;
      return;
    }
    if (this.parent) {
      delete this.fds[fd];
      this.parent.redirectFd(fd, target);
      return;
    }
    this.fds[fd] = target;
  }

  /** The descriptors above 2 as this context sees them: the shell's, under the ones its commands opened or closed. */
  private visibleFds(): Record<string, string> {
    const fds = { ...this.parent?.visibleFds(), ...this.fds };

    return Object.fromEntries(Object.entries(fds).filter(([, target]) => target));
  }

  /** A descriptor the host holds under its number that the shell no longer has: moved away, `exec 0<&5-`. */
  hideFd(fd: string): void {
    this.root().fds[fd] = '';
  }

  /** Whether the shell has no such descriptor though the host may: hidden, or closed for this command. */
  isFdHidden(fd: string): boolean {
    if (fd in this.fds) return this.fds[fd] === '';

    return this.parent?.isFdHidden(fd) ?? false;
  }

  closeFd(fd: string, local = false): void {
    // Closed for one command, `cmd 3>&-`: hidden from it, and open again after
    if (local && this.parent) {
      this.fds[fd] = '';
      return;
    }
    if (this.parent) {
      delete this.fds[fd];
      this.parent.closeFd(fd);
      return;
    }
    delete this.fds[fd];
  }

  getParent(): ExecContextIf | undefined {
    return this.parent;
  }

  assignVariable(name: string, value: string): void {
    // An exported variable stays exported: the attribute is the variable's
    this.setParams({ [name]: value });
  }

  getFunctionScope(): ExecContextIf | undefined {
    // A function's context is the one below the shell's that holds positional
    // parameters of its own; a block or a command's context holds none
    if (!this.parent) {
      return undefined;
    }

    return '#' in this.special ? this : this.parent.getFunctionScope();
  }
}
