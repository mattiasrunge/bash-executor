/**
 * declare, typeset, local, readonly and export: the builtins that declare
 * variables and give them attributes, after bash's declare.def and setattr.def.
 *
 * All five come down to the same steps for each `name[=value]`: find or make
 * the variable — a function's own for `local`, and for `declare` in a
 * function — refuse what bash refuses, convert it to the kind asked for, set
 * and clear attributes, and assign the value as the variable now takes it.
 */

import { utils } from '@ein/bash-parser';
import { contextVariables, evaluateArithmeticText } from '../arith.ts';
import { CommandAbortError } from '../errors.ts';
import { functionEnvName, functionText } from '../print-command.ts';
import { type ExecContextIf, QUOTED_LIST_MARK, type ShellIf, type VariableInfo } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';
import { declareLine, setListing, sortedVariables } from './variable-listing.ts';
import { exportFunctions } from './variables.ts';

type Command = 'declare' | 'typeset' | 'local' | 'readonly' | 'export';

/** The options each takes, as bash's getopt strings. */
const OPTIONS: Record<Command, string> = {
  declare: 'aAfFgiIlnprtuxc',
  typeset: 'aAfFgiIlnprtuxc',
  local: 'aAfFgiIlnprtuxc',
  readonly: 'aAfnp',
  export: 'aAfnp',
};

/** Letters that are attributes a variable carries; the rest steer the builtin. */
const ATTRIBUTES = 'ilnrtuxc';

type Options = {
  on: Set<string>;
  off: Set<string>;
  print: boolean;
  global: boolean;
};

const isIdentifier = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/** The shell's own context, below every function and command. */
const rootOf = (ctx: ExecContextIf): ExecContextIf => {
  let root = ctx;

  while (root.getParent()) root = root.getParent()!;

  return root;
};

/** `(a "b c")` given as a string, as bash reads one assigned to an array: split into words, quotes removed. */
function wordsOf(list: string): string[] {
  const inner = list.trim().replace(/^\(/, '').replace(/\)$/, '');
  const words: string[] = [];
  let current = '';
  let quote = '';
  let started = false;

  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];

    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < inner.length) current += inner[++i];
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < inner.length) {
      current += inner[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += c;
      started = true;
    }
  }

  if (started) words.push(current);

  return words;
}

class Declaration {
  // What declare writes, in the order it writes it: `declare -p nope x` complains before it shows x
  private output: { stdout?: string; stderr?: string }[] = [];
  private failed = false;
  private assignError = false;

  constructor(
    private readonly command: Command,
    private readonly ctx: ExecContextIf,
    private readonly opts: Options,
  ) {}

  private print(stdout: string): void {
    this.output.push({ stdout });
  }

  private warn(message: string): void {
    this.output.push({ stderr: `${message}\n` });
  }

  private error(message: string, assignment = false): void {
    this.warn(message);
    if (assignment) this.assignError = true;
    else this.failed = true;
  }

  result(): BuiltinResult {
    return { code: this.failed || this.assignError ? 1 : 0, output: this.output };
  }

  private get posix(): boolean {
    return this.ctx.getShellOption('posix');
  }

  // -- showing ---------------------------------------------------------------------------------

  /** `declare -p name`: the variable, or `not found`. */
  showName(name: string): void {
    const info = this.ctx.getVariable(name);

    if (!info) {
      this.error(`${this.command}: ${name}: not found`);
      return;
    }

    this.print(declareLine(name, info, { command: this.command, posix: this.posix }));
  }

  /** `declare -p`: every variable. */
  showAll(): void {
    for (const [name, info] of sortedVariables(this.ctx)) {
      this.print(declareLine(name, info, { command: this.command, posix: this.posix }));
    }
  }

  /**
   * `declare -r`, `readonly`, `export -p`: the variables with any of the
   * attributes; with `-a` or `-A`, only arrays of that kind.
   */
  showWithAttributes(): void {
    const arrays = this.opts.on.has('a');
    const assocs = this.opts.on.has('A');
    const letters = [...this.opts.on].filter((letter) => ATTRIBUTES.includes(letter));

    for (const [name, info] of sortedVariables(this.ctx)) {
      if (arrays && info.kind !== 'array') continue;
      if (assocs && info.kind !== 'assoc') continue;
      if (letters.length && !letters.some((letter) => info.attributes.includes(letter))) continue;

      this.print(declareLine(name, info, { command: this.command, posix: this.posix }));
    }
  }

  /** `local` alone: the function's own variables. */
  showLocals(scope: ExecContextIf): void {
    const own = Object.entries(scope.getOwnVariables()).filter(([name]) => isIdentifier(name)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

    for (const [name, info] of own) {
      this.print(declareLine(name, info));
    }
  }

  // -- declaring -------------------------------------------------------------------------------

  /**
   * Where the variable is declared: in the function for `local` (and `declare`
   * there without -g), in the shell with -g, and otherwise wherever it is.
   */
  private scopeFor(): { target: ExecContextIf; local: boolean } {
    const fnScope = this.ctx.getFunctionScope();

    if (this.command === 'local' || ((this.command === 'declare' || this.command === 'typeset') && fnScope && !this.opts.global)) {
      return { target: fnScope ?? this.ctx, local: Boolean(fnScope) };
    }

    return { target: this.opts.global ? rootOf(this.ctx) : this.ctx, local: false };
  }

  async declare(arg: string): Promise<void> {
    const parts = utils.parseAssignmentWord(arg);
    const assigning = parts !== null;
    let name = parts?.name ?? arg;
    let subscript = parts?.subscript;
    let value = parts?.value;
    let quotedList = false;

    if (value?.startsWith(QUOTED_LIST_MARK)) {
      value = value.slice(QUOTED_LIST_MARK.length);
      quotedList = true;
    }

    const compound = parts?.list === true && !quotedList;

    // `declare a[3]` with no value names an element: the array is made, nothing assigned
    if (!assigning) {
      const element = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s);

      if (element) {
        name = element[1];
        subscript = element[2];
      }
    }

    if (!isIdentifier(name)) {
      this.error(`${this.command}: \`${assigning ? `${name}${subscript !== undefined ? `[${subscript}]` : ''}` : arg}': not a valid identifier`, assigning);
      return;
    }

    const { on, off } = this.opts;
    const { target, local } = this.scopeFor();

    // Making a name reference, or changing what one refers to
    if (on.has('n')) {
      this.declareNameref(target, local, name, subscript, assigning ? value ?? '' : undefined, parts?.append ?? false);
      return;
    }

    // `declare +n ref=v` assigns through the reference, then it is a plain variable
    if (off.has('n') && target.getVariable(name)?.attributes.includes('n')) {
      if (assigning) target.setParams({ [name]: value ?? '' });
      target.declareVariable(name, { remove: 'n', noref: true });
      return;
    }

    // `declare -n x; declare x[1]=one`: an element assigned makes the reference an array, as in bash
    if (assigning && subscript !== undefined) this.dropNameref(target, name);

    // A nameref otherwise stands for what it refers to — except that `local x` makes a new x
    if (!local && subscript === undefined) {
      const resolved = target.resolveNameref(name);
      const element = resolved.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s);

      name = element ? element[1] : resolved;
      subscript = element ? element[2] : subscript;

      // …and what it leads to may be an element of a reference: `declare -n a=b b='a[1]'`
      if (element && assigning) this.dropNameref(target, name);
    }

    const own = local ? target.getOwnVariables()[name] : undefined;
    let info: VariableInfo | undefined = local ? own : target.getVariable(name);

    // A nameref that refers to nothing yet is given what it refers to: that has to be a name
    if (assigning && info?.attributes.includes('n') && !info.value && !/^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?$/s.test(value ?? '')) {
      this.error(`${this.command}: \`${value ?? ''}': not a valid identifier`, true);
      return;
    }
    const creatingArray = on.has('a') || on.has('A');
    const arrayExists = info !== undefined && info.kind !== 'scalar';

    // Readonly: it keeps the attribute, and takes no value
    if (info?.attributes.includes('r') && off.has('r')) {
      this.error(`${this.command}: ${name}: readonly variable`);
      return;
    }

    if (info?.attributes.includes('r') && assigning) {
      // A plain `readonly x=1` fails as the assignment it is, and so does a
      // written list, which bash assigns as it expands it; the rest is
      // declare's own refusal, which says who refused
      // A written list is assigned as bash expands the word, so failing it
      // abandons the rest of the line, as an expansion error does
      if (compound) throw new CommandAbortError(`${name}: readonly variable`, { code: 'E_READONLY' });

      const plain = (this.command === 'readonly' || this.command === 'export') && !creatingArray;
      this.error(plain ? `${name}: readonly variable` : `${this.command}: ${name}: readonly variable`, true);
      return;
    }

    if ((off.has('a') && info?.kind === 'array') || (off.has('A') && info?.kind === 'assoc')) {
      this.error(`${this.command}: ${name}: cannot destroy array variables in this way`);
      return;
    }

    if (on.has('a') && info?.kind === 'assoc') {
      this.error(`${this.command}: ${name}: cannot convert associative to indexed array`);
      return;
    }

    if (on.has('A') && info?.kind === 'array') {
      this.error(`${this.command}: ${name}: cannot convert indexed to associative array`);
      return;
    }

    // Make it, of the kind asked for, and set its attributes
    const kind = on.has('A') ? 'assoc' : on.has('a') || subscript !== undefined ? (info?.kind === 'assoc' ? 'assoc' : 'array') : undefined;

    target.declareVariable(name, {
      kind: info && kind === undefined ? undefined : kind ?? (compound ? 'array' : undefined),
      add: [...on].filter((letter) => ATTRIBUTES.includes(letter) && letter !== 'n').join(''),
      remove: [...off].filter((letter) => ATTRIBUTES.includes(letter)).join(''),
      local: local && !own,
    });

    info = local ? target.getOwnVariables()[name] : target.getVariable(name);

    if (!assigning) return;

    await this.assign(target, name, info!, { subscript, value: value ?? '', append: parts!.append, compound, quotedList, creatingArray, arrayExists });
  }

  /** A reference that is to be an array stops being a reference, and loses the name it held. */
  private dropNameref(target: ExecContextIf, name: string): void {
    if (!target.getVariable(name)?.attributes.includes('n')) return;

    this.warn(`warning: ${name}: removing nameref attribute`);
    target.unsetVariable(name, { noref: true });
  }

  /**
   * `declare -n ref[=name]`: the variable becomes a reference to another, and
   * its value is that one's name. What bash refuses: an element as the
   * reference, a value no variable could be called, a reference to itself
   * (outside a function, where it is only a warning), an array, a readonly one.
   */
  private declareNameref(
    target: ExecContextIf,
    local: boolean,
    name: string,
    subscript: string | undefined,
    value: string | undefined,
    append: boolean,
  ): void {
    const validName = (text: string) => /^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?$/s.test(text);

    if (subscript !== undefined) {
      this.error(`${this.command}: ${name}[${subscript}]: reference variable cannot be an array`);
      return;
    }

    // `declare -n ref+=f` adds to the name it holds, which is checked only whole: `ref=var ref+=[@]`
    if (append && value !== undefined) {
      const current = local ? target.getOwnVariables()[name] : target.getVariable(name);
      const whole = (current?.attributes.includes('n') && typeof current.value === 'string' ? current.value : '') + value;

      if (whole === name || whole.startsWith(`${name}[`)) {
        if (this.ctx.getFunctionScope()) {
          this.warn(`warning: ${name}: circular name reference`);
        } else {
          this.error(`${name}: nameref variable self references not allowed`, true);
          return;
        }
      }

      value = whole;
    } else if (value !== undefined && value !== '' && !validName(value)) {
      this.error(`${this.command}: \`${value}': invalid variable name for name reference`, true);
      return;
    }

    // A reference to itself, or to one of its own elements
    if (!append && (value === name || value?.startsWith(`${name}[`))) {
      if (!this.ctx.getFunctionScope()) {
        this.error(`${this.command}: ${name}: nameref variable self references not allowed`, true);
        return;
      }

      // And a second time as the value is bound, as bash says it
      this.warn(`${this.command}: warning: ${name}: circular name reference`);
      this.warn(`warning: ${name}: circular name reference`);
    }

    const own = local ? target.getOwnVariables()[name] : undefined;
    const existing = local ? own : target.getVariable(name);

    if (existing && existing.kind !== 'scalar') {
      this.error(`${this.command}: ${name}: reference variable cannot be an array`);
      return;
    }

    if (existing?.attributes.includes('r')) {
      this.error(`${this.command}: ${name}: readonly variable`, value !== undefined);
      return;
    }

    if (value === undefined && typeof existing?.value === 'string' && !existing.attributes.includes('n') && !validName(existing.value)) {
      this.error(`${this.command}: \`${existing.value}': invalid variable name for name reference`);
      return;
    }

    const { on, off } = this.opts;

    target.declareVariable(name, {
      // A reference is no integer and changes no case: those go, as in ksh93
      add: [...on].filter((letter) => ATTRIBUTES.includes(letter) && !'iluc'.includes(letter)).join(''),
      remove: 'iluc' + [...off].filter((letter) => ATTRIBUTES.includes(letter)).join(''),
      local: local && !own,
      value,
      noref: true,
    });
  }

  private async assign(
    target: ExecContextIf,
    name: string,
    info: VariableInfo,
    how: { subscript?: string; value: string; append: boolean; compound: boolean; quotedList: boolean; creatingArray: boolean; arrayExists: boolean },
  ): Promise<void> {
    const integer = info.attributes.includes('i');
    const arith = async (text: string): Promise<string> => String(await evaluateArithmeticText(text || '0', contextVariables(this.ctx)));
    /** A value as the variable takes it: arithmetic for -i, `+=` adding or appending to what was there. */
    const valueFor = async (previous: string | undefined, text: string, append = how.append): Promise<string> => {
      if (integer) {
        const added = BigInt(await arith(text));
        return String(append ? BigInt(await arith(previous ?? '0')) + added : added);
      }

      return append ? (previous ?? '') + text : text;
    };

    // A list, or on declare's path a quoted one landing in an array, which bash
    // reads as a list too; readonly and export assign it as the string it is
    const declarePath = this.command === 'declare' || this.command === 'typeset' || this.command === 'local' || how.creatingArray;
    const listAssign = how.compound || (how.quotedList && declarePath && how.subscript === undefined && (how.arrayExists || how.creatingArray));

    if (listAssign) {
      const elements = how.compound ? (how.value === '' ? [] : how.value.split(utils.ARRAY_ELEMENT_SEPARATOR)) : wordsOf(how.value);

      if (info.kind === 'assoc') {
        const assoc = how.append ? { ...target.getAssoc(name) } : {};

        for (const element of elements) {
          const keyed = element.match(/^\[(.*?)\](\+?)=(.*)$/s);

          if (!keyed) {
            this.error(`${name}: ${element}: must use subscript when assigning associative array`, true);
            continue;
          }

          assoc[keyed[1]] = await valueFor(assoc[keyed[1]], keyed[3], keyed[2] === '+');
        }

        target.setAssoc(name, assoc);
        return;
      }

      const array = how.append ? (target.getArray(name) ?? []).slice() : [];
      let next = array.length;

      for (const element of elements) {
        const keyed = element.match(/^\[(.*?)\](\+?)=(.*)$/s);
        let index = next;
        let text = element;

        if (keyed) {
          const evaluated = Number(await arith(keyed[1]));
          index = evaluated < 0 ? array.length + evaluated : evaluated;
          text = keyed[3];
        }

        array[index] = await valueFor(array[index], text, keyed?.[2] === '+');
        next = index + 1;
      }

      target.setArray(name, array);
      return;
    }

    if (how.subscript !== undefined) {
      if (info.kind === 'assoc') {
        target.setAssocElement(name, how.subscript, await valueFor(target.getAssoc(name)?.[how.subscript], how.value));
        return;
      }

      const array = target.getArray(name) ?? [];
      const evaluated = Number(await arith(how.subscript));
      const index = evaluated < 0 ? array.length + evaluated : evaluated;

      target.setArrayElement(name, index, await valueFor(array[index], how.value));
      return;
    }

    if (info.kind === 'array') {
      target.setArrayElement(name, 0, await valueFor(target.getArray(name)?.[0], how.value));
      return;
    }

    if (info.kind === 'assoc') {
      target.setAssocElement(name, '0', await valueFor(target.getAssoc(name)?.['0'], how.value));
      return;
    }

    const previous = typeof info.value === 'string' ? info.value : undefined;

    target.setParams({ [name]: await valueFor(previous, how.value) });
  }
}

/** Parse the options, `-ar` and `+x` alike, up to the first name or `--`. */
function parseOptions(command: Command, args: string[]): { opts: Options; names: string[]; bad?: string } {
  const opts: Options = { on: new Set(), off: new Set(), print: false, global: false };
  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      i++;
      break;
    }

    if (!/^[-+]./.test(arg)) break;

    const set = arg[0] === '-' ? opts.on : opts.off;

    for (const letter of arg.slice(1)) {
      if (!OPTIONS[command].includes(letter)) return { opts, names: [], bad: `${arg[0]}${letter}` };
      if (letter === 'p') opts.print = true;
      else if (letter === 'g') opts.global = true;
      else set.add(letter);
    }
  }

  return { opts, names: args.slice(i) };
}

/**
 * The shared body of declare, typeset, local, readonly and export: readonly
 * and export only set their attribute on what they are given, `-r` or `-x`.
 */
export async function declareCommand(command: Command, ctx: ExecContextIf, args: string[]): Promise<BuiltinResult> {
  const { opts, names, bad } = parseOptions(command, args);

  if (bad) {
    return { code: 2, stderr: `${command}: ${bad}: invalid option\n${command}: usage: ${command} [-${OPTIONS[command]}] [name[=value] ...]\n` };
  }

  // readonly and export are declare giving one attribute; -n takes it instead,
  // which readonly silently cannot
  if (command === 'readonly' || command === 'export') {
    const attribute = command === 'readonly' ? 'r' : 'x';
    const undo = opts.on.delete('n');

    if (!undo) opts.on.add(attribute);
    else if (command === 'export') opts.off.add(attribute);
  }

  const fnScope = ctx.getFunctionScope();

  if (command === 'local' && !fnScope) {
    return { code: 1, stderr: 'local: can only be used in a function\n' };
  }

  if (opts.on.has('f') || opts.on.has('F')) return await declareFunctions(ctx, opts, names);

  const declaration = new Declaration(command, ctx, opts);

  if (names.length === 0) {
    const attributes = opts.on.size > 0;

    if (command === 'local') {
      declaration.showLocals(fnScope!);
    } else if (opts.print && opts.on.size === 0) {
      declaration.showAll();
    } else if (!attributes && !opts.print) {
      // `declare` alone is `set`: every variable, then the functions
      const listing = setListing(ctx) + await functionsListing(ctx);
      return { code: 0, stdout: listing };
    } else {
      declaration.showWithAttributes();
    }

    return declaration.result();
  }

  if (opts.print && command !== 'export' && command !== 'readonly') {
    for (const name of names) declaration.showName(name);
  } else {
    for (const name of names) await declaration.declare(name);
  }

  return declaration.result();
}

/** Every function as `set` ends its listing with them; posix mode leaves them out. */
async function functionsListing(ctx: ExecContextIf): Promise<string> {
  if (ctx.getShellOption('posix')) return '';

  const functions = ctx.getFunctions();
  let out = '';

  for (const name of Object.keys(functions).sort()) out += `${await functionText(functions[name])}\n`;

  return out;
}

/**
 * `-f` prints functions as bash would read them back, `-F` only their names:
 * the ones named, or all of them sorted. A name that is no function fails quietly.
 */
async function declareFunctions(ctx: ExecContextIf, opts: Options, names: string[]): Promise<BuiltinResult> {
  const exporting = opts.on.has('x') || opts.off.has('x');

  // `declare -fx name` exports it, as `export -f name` does
  if (names.length && exporting) return await exportFunctions(ctx, names, opts.off.has('x'));

  const functions = ctx.getFunctions();
  const env = ctx.getEnv();
  const exported = (name: string) => functionEnvName(name) in env;
  // `declare -xF` lists the exported ones only
  const listing = names.length === 0;
  const chosen = listing ? Object.keys(functions).sort().filter((name) => !opts.on.has('x') || exported(name)) : names;
  let output = '';
  let code = 0;

  for (const name of chosen) {
    const fn = functions[name];
    const declaration = `declare -f${exported(name) ? 'x' : ''} ${name}\n`;

    if (!fn) {
      code = 1;
    } else if (opts.on.has('F')) {
      output += listing ? declaration : `${name}\n`;
    } else {
      output += `${await functionText(fn, ctx.getShellOption('posix'))}\n`;
      if (listing && exported(name)) output += declaration;
    }
  }

  return { code, stdout: output };
}

export const declareBuiltin: BuiltinHandler = (ctx: ExecContextIf, args: string[], _shell: ShellIf) => declareCommand('declare', ctx, args);

/** typeset is declare by its ksh name. */
export const typesetBuiltin: BuiltinHandler = (ctx: ExecContextIf, args: string[], _shell: ShellIf) => declareCommand('typeset', ctx, args);

/**
 * Check if a variable is readonly.
 * @deprecated Use ctx.isReadonlyVar(name) instead. This function is kept for backwards compatibility.
 *
 * @param _name - The variable name (ignored)
 * @returns Always returns false since readonly tracking is now per-context
 */
export function isReadonly(_name: string): boolean {
  return false;
}

/**
 * Clear all tracked attributes (no-op for backwards compatibility).
 * @deprecated No longer needed since attributes are tracked per-context.
 */
export function clearAttributes(): void {
  // No-op - attributes are now tracked in the context
}
