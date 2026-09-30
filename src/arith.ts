/**
 * Shell arithmetic, as bash's expr.c does it.
 *
 * The expression is text, expanded already — bash substitutes `$x` and `$( )`
 * first and parses what comes out — and it is read and evaluated in one pass,
 * on 64-bit integers that wrap. A variable's value is an expression in its own
 * right: `x=4+3; $((x))` is 7. The errors are bash's, word for word, with the
 * token bash names: the text from the start of the last token it read.
 */

import { ArithmeticError, ReadonlyVariableError, UnboundVariableError } from './errors.ts';
import type { ExecContextIf } from './types.ts';

/** What arithmetic can do to the shell's variables. */
export interface ArithVariables {
  /** A variable's value, or an element's (`subscript` as written); undefined when it is not set. */
  get(name: string, subscript?: string): Promise<string | undefined>;
  /** Set a variable, or an element. */
  set(name: string, subscript: string | undefined, value: string): Promise<void>;
  /** Whether a subscript of `name` is a key rather than an expression — an associative array. */
  keyed(name: string): boolean;
  readonly(name: string): boolean;
  /** `set -u`: whether an unset variable is an error. */
  nounset(): boolean;
  /**
   * A subscript expanded before it is used, as bash expands one — a key as a
   * word, an index as in double quotes: what expanding the expression put
   * there came backslash-quoted, and so comes out as it was. Without this a
   * subscript is taken as it reads.
   */
  expand?(subscript: string, keyed: boolean): Promise<string>;
}

const MAX_RECURSION = 1024;

/** The characters that start an operator, bash's _is_arithop. */
const ARITH_OPERATOR_CHARS = '=><+-*/%!()&|^~?:,';

type Token =
  | { kind: 'eof' }
  | { kind: 'num'; text: string }
  | { kind: 'var'; name: string; subscript?: string }
  | { kind: 'op'; op: string };

/** The operators, longest first, as the tokenizer tries them. */
const OPERATORS = [
  '<<=',
  '>>=',
  '**',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '^=',
  '|=',
  '++',
  '--',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '&',
  '|',
  '^',
  '!',
  '~',
  '?',
  ':',
  '(',
  ')',
  ',',
];

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '<<=', '>>=']);

const wrap = (value: bigint) => BigInt.asIntN(64, value);

/** An integer constant, as bash's strlong reads one. Errors name the constant itself. */
function readNumber(text: string): bigint {
  const fail = (reason: string) => {
    throw new ArithmeticError(reason, 0, text);
  };
  let s = 0;
  let base = 10n;
  let foundBase = false;

  if (text[0] === '0') {
    s = 1;

    if (text.length === 1) return 0n;

    if (text[1] === 'x' || text[1] === 'X') {
      base = 16n;
      s = 2;
    } else {
      base = 8n;
    }

    foundBase = true;
  }

  let value = 0n;

  for (; s < text.length; s++) {
    const c = text[s];

    if (c === '#') {
      if (foundBase) fail('invalid number');
      if (value < 2n || value > 64n) fail('invalid arithmetic base');

      base = value;
      value = 0n;
      foundBase = true;

      if (!/[0-9a-zA-Z_@]/.test(text[s + 1] ?? '')) fail('invalid integer constant');
      continue;
    }

    let digit: bigint;

    if (c >= '0' && c <= '9') digit = BigInt(c.charCodeAt(0) - 48);
    else if (c >= 'a' && c <= 'z') digit = BigInt(c.charCodeAt(0) - 97 + 10);
    else if (c >= 'A' && c <= 'Z') digit = BigInt(c.charCodeAt(0) - 65 + (base <= 36n ? 10 : 36));
    else if (c === '@') digit = 62n;
    else if (c === '_') digit = 63n;
    else break;

    if (digit >= base) fail('value too great for base');

    value = wrap(value * base + digit);
  }

  return value;
}

/**
 * Where the subscript that opens at `open` closes, or -1: bash's skipsubscript,
 * which counts brackets and steps over a quoted string, an escaped character
 * and a `$( )`, `${ }` or backquoted substitution — `a[']']` is one element.
 */
export function subscriptEnd(text: string, open: number): number {
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    const char = text[i];

    if (char === '\\') {
      i++;
    } else if (char === "'") {
      i = text.indexOf("'", i + 1);
      if (i === -1) return -1;
    } else if (char === '"' || char === '`') {
      i = closingQuote(text, i);
      if (i === -1) return -1;
    } else if (char === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) {
      i = closingBracket(text, i + 1);
      if (i === -1) return -1;
    } else if (char === '[') {
      depth++;
    } else if (char === ']' && --depth === 0) {
      return i;
    }
  }

  return -1;
}

/** The quote that closes the one at `open`, escapes stepped over, or -1. */
export function closingQuote(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === text[open]) return i;
  }

  return -1;
}

/** The `)` or `}` that closes the one at `open`, nested pairs and quotes stepped over, or -1. */
export function closingBracket(text: string, open: number): number {
  const [opener, closer] = text[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    const char = text[i];

    if (char === '\\') {
      i++;
    } else if (char === "'") {
      i = text.indexOf("'", i + 1);
      if (i === -1) return -1;
    } else if (char === '"' || char === '`') {
      i = closingQuote(text, i);
      if (i === -1) return -1;
    } else if (char === opener) {
      depth++;
    } else if (char === closer && --depth === 0) {
      return i;
    }
  }

  return -1;
}

class Evaluation {
  private at = 0;
  private token: Token = { kind: 'eof' };
  /** Start of the current token, and of the last one that was not the end */
  private start = 0;
  private lastStart = 0;
  private previous: Token = { kind: 'eof' };
  /** Inside the branch `&&`, `||` or `?:` does not take: parsed, not run */
  private noeval = 0;

  constructor(private readonly text: string, private readonly vars: ArithVariables, private readonly depth: number) {}

  /** An error the way bash says it: the expression, then from the last token on. */
  private fail(reason: string, from = this.lastStart): never {
    throw new ArithmeticError(reason, from, this.text);
  }

  private next(): void {
    this.previous = this.token;

    while (this.at < this.text.length && /[ \t\n\r]/.test(this.text[this.at])) this.at++;

    if (this.at >= this.text.length) {
      this.start = this.at;
      this.token = { kind: 'eof' };
      return;
    }

    this.start = this.lastStart = this.at;

    const rest = this.text.slice(this.at);
    const name = rest.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)?.[0];

    if (name) {
      this.at += name.length;

      if (this.text[this.at] === '[') {
        const close = subscriptEnd(this.text, this.at);

        if (close === -1) this.fail('bad array subscript');

        this.token = { kind: 'var', name, subscript: this.text.slice(this.at + 1, close) };
        this.at = close + 1;
      } else {
        this.token = { kind: 'var', name };
      }

      return;
    }

    if (/^[0-9]/.test(rest)) {
      const number = rest.match(/^[0-9a-zA-Z#@_]+/)![0];

      this.at += number.length;
      this.token = { kind: 'num', text: number };
      return;
    }

    let op = OPERATORS.find((candidate) => rest.startsWith(candidate)) ?? rest[0];

    // `++` and `--`: after a variable they are its post-increment; otherwise a
    // pre-increment only when a variable follows, and else two signs, `4+++a`
    // being `4 + ++a`
    if (op === '++' || op === '--') {
      if (this.previous.kind === 'var') {
        op = op === '++' ? 'post++' : 'post--';
      } else if (/^\s*[a-zA-Z_]/.test(rest.slice(2))) {
        op = op === '++' ? 'pre++' : 'pre--';
      } else {
        op = op[0];
      }
    }

    // A character that is no operator, `]` or `;` or a quote: bash stops there, and
    // says what it wanted — an operand after an operator, else an operator
    if (op.length === 1 && !ARITH_OPERATOR_CHARS.includes(op)) {
      const wanted = this.previous.kind === 'eof' || this.previous.kind === 'op' ? 'operand expected' : 'invalid arithmetic operator';

      this.fail(`syntax error: ${wanted}`, this.at);
    }

    this.at += op.replace(/^(pre|post)/, '').length;
    this.token = { kind: 'op', op };
  }

  /** Whether the whole expression has been read — a method, so the checker does not keep an old answer. */
  private atEnd(): boolean {
    return this.token.kind === 'eof';
  }

  private is(op: string): boolean {
    return this.token.kind === 'op' && this.token.op === op;
  }

  async run(): Promise<bigint> {
    if (this.depth > MAX_RECURSION) {
      this.fail('expression recursion level exceeded', 0);
    }

    this.next();

    if (this.atEnd()) return 0n;

    const value = await this.comma();

    if (!this.atEnd()) {
      this.fail('syntax error in expression');
    }

    return value;
  }

  private async comma(): Promise<bigint> {
    let value = await this.assignment();

    while (this.is(',')) {
      this.next();
      value = await this.assignment();
    }

    return value;
  }

  private async assignment(): Promise<bigint> {
    const first = this.token;
    const value = await this.conditional();

    if (this.token.kind === 'op' && ASSIGN_OPS.has(this.token.op)) {
      const op = this.token.op;

      // Only a variable on its own can be assigned: `x=1`, not `1=x` or `x++=1`
      if (first.kind !== 'var' || this.previous !== first) {
        this.fail('attempted assignment to non-variable');
      }

      this.next();

      const right = await this.assignment();
      let result = right;

      if (op !== '=') {
        result = this.binary(op.slice(0, -1), value, right, this.lastStart);
      }

      await this.store(first, result);

      return result;
    }

    return value;
  }

  private async conditional(): Promise<bigint> {
    const test = await this.logicalOr();

    if (!this.is('?')) return test;

    this.next();

    if (this.is(':')) this.fail('expression expected');

    if (test === 0n) this.noeval++;
    const yes = await this.comma();
    if (test === 0n) this.noeval--;

    if (!this.is(':')) this.fail("`:' expected for conditional expression");

    this.next();

    if (this.atEnd()) this.fail('expression expected');

    if (test !== 0n) this.noeval++;
    const no = await this.conditional();
    if (test !== 0n) this.noeval--;

    return test !== 0n ? yes : no;
  }

  private async logicalOr(): Promise<bigint> {
    let value = await this.logicalAnd();

    while (this.is('||')) {
      this.next();

      if (value !== 0n) this.noeval++;
      const right = await this.logicalAnd();
      if (value !== 0n) this.noeval--;

      value = value !== 0n || right !== 0n ? 1n : 0n;
    }

    return value;
  }

  private async logicalAnd(): Promise<bigint> {
    let value = await this.levels(0);

    while (this.is('&&')) {
      this.next();

      if (value === 0n) this.noeval++;
      const right = await this.levels(0);
      if (value === 0n) this.noeval--;

      value = value !== 0n && right !== 0n ? 1n : 0n;
    }

    return value;
  }

  /** The binary operators from `|` down to `*`, one level of precedence each. */
  private static LEVELS = [['|'], ['^'], ['&'], ['==', '!='], ['<=', '>=', '<', '>'], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

  private async levels(level: number): Promise<bigint> {
    if (level === Evaluation.LEVELS.length) return await this.power();

    let value = await this.levels(level + 1);

    while (this.token.kind === 'op' && Evaluation.LEVELS[level].includes(this.token.op)) {
      const op = this.token.op;

      this.next();

      // Division by zero names the divisor on
      const divisorStart = this.start;
      const right = await this.levels(level + 1);

      value = this.binary(op, value, right, divisorStart);
    }

    return value;
  }

  private binary(op: string, left: bigint, right: bigint, rightStart: number): bigint {
    if (this.noeval > 0) return 0n;

    switch (op) {
      case '+':
        return wrap(left + right);
      case '-':
        return wrap(left - right);
      case '*':
        return wrap(left * right);
      case '/':
      case '%':
        if (right === 0n) this.fail('division by 0', rightStart);

        // The one division that overflows: bash gives the dividend, and 0 for its remainder
        if (right === -1n && left === -(2n ** 63n)) return op === '/' ? left : 0n;

        return op === '/' ? left / right : left % right;
      case '**':
        return this.power2(left, right);
      case '<<':
        return wrap(left << (right & 63n));
      case '>>':
        return left >> (right & 63n);
      case '&':
        return left & right;
      case '|':
        return left | right;
      case '^':
        return left ^ right;
      case '<':
        return left < right ? 1n : 0n;
      case '>':
        return left > right ? 1n : 0n;
      case '<=':
        return left <= right ? 1n : 0n;
      case '>=':
        return left >= right ? 1n : 0n;
      case '==':
        return left === right ? 1n : 0n;
      case '!=':
        return left !== right ? 1n : 0n;
      default:
        return this.fail('syntax error in expression');
    }
  }

  private power2(base: bigint, exponent: bigint): bigint {
    if (exponent < 0n) this.fail('exponent less than 0');

    let result = 1n;
    let b = base;
    let e = exponent;

    // Square and multiply, wrapping as it goes, as C's does
    while (e > 0n) {
      if (e & 1n) result = wrap(result * b);
      b = wrap(b * b);
      e >>= 1n;
    }

    return result;
  }

  /** `**`, right to left: `2**3**2` is 2**9. */
  private async power(): Promise<bigint> {
    const base = await this.unary();

    if (!this.is('**')) return base;

    this.next();

    const exponent = await this.power();

    return this.noeval > 0 ? 0n : this.power2(base, exponent);
  }

  private async unary(): Promise<bigint> {
    if (this.token.kind === 'op' && ['!', '~', '-', '+'].includes(this.token.op)) {
      const op = this.token.op;

      this.next();

      const value = await this.unary();

      return op === '!' ? (value === 0n ? 1n : 0n) : op === '~' ? ~value : op === '-' ? wrap(-value) : value;
    }

    return await this.operand();
  }

  private async operand(): Promise<bigint> {
    const token = this.token;

    if (token.kind === 'op' && (token.op === 'pre++' || token.op === 'pre--')) {
      this.next();

      const variable = this.token;

      if (variable.kind !== 'var') this.fail('syntax error: operand expected');

      const value = wrap((await this.load(variable)) + (token.op === 'pre++' ? 1n : -1n));

      await this.store(variable, value);
      this.next();

      return value;
    }

    if (token.kind === 'op' && token.op === '(') {
      this.next();

      const value = await this.comma();

      if (!this.is(')')) this.fail("missing `)'");

      this.next();

      return value;
    }

    if (token.kind === 'num') {
      const value = this.noeval > 0 ? 0n : readNumber(token.text);

      this.next();

      return value;
    }

    if (token.kind === 'var') {
      this.next();

      // A plain `=` does not read what it is about to replace — which may be
      // an expression that refers back to itself
      const value = this.is('=') ? 0n : await this.load(token);

      if (this.token.kind === 'op' && (this.token.op === 'post++' || this.token.op === 'post--')) {
        await this.store(token, wrap(value + (this.token.op === 'post++' ? 1n : -1n)));
        this.next();
      }

      return value;
    }

    // Nothing where an operand has to be: the end, an operator, a stray character
    this.fail('syntax error: operand expected');
  }

  /** A variable's value as a number: its text is an expression of its own. */
  private async load(token: Token & { kind: 'var' }): Promise<bigint> {
    if (this.noeval > 0) return 0n;

    const subscript = await this.subscriptOf(token);
    const text = await this.vars.get(token.name, subscript);

    if (text === undefined) {
      if (this.vars.nounset()) throw new UnboundVariableError(subscript === undefined ? token.name : `${token.name}[${subscript}]`);
      return 0n;
    }

    if (text.trim() === '') return 0n;
    if (/^\s*[0-9]+\s*$/.test(text) && !/^\s*0/.test(text)) return wrap(BigInt(text.trim()));

    return await new Evaluation(text, this.vars, this.depth + 1).run();
  }

  private async store(token: Token, value: bigint): Promise<void> {
    if (this.noeval > 0 || token.kind !== 'var') return;

    if (this.vars.readonly(token.name)) throw new ReadonlyVariableError(token.name);

    await this.vars.set(token.name, await this.subscriptOf(token), String(value));
  }

  /** An indexed array's subscript is arithmetic, evaluated here; an associative one is its key. Either is expanded first. */
  private async subscriptOf(token: Token & { kind: 'var' }): Promise<string | undefined> {
    if (token.subscript === undefined) return undefined;

    const keyed = this.vars.keyed(token.name);
    const subscript = this.vars.expand ? await this.vars.expand(token.subscript, keyed) : token.subscript;

    if (keyed) return subscript;

    try {
      return String(await new Evaluation(subscript, this.vars, this.depth + 1).run());
    } catch (err) {
      if (err instanceof ArithmeticError) err.nameless = true;
      throw err;
    }
  }
}

/**
 * Evaluate an arithmetic expression, expanded already. Throws ArithmeticError
 * with bash's message, ReadonlyVariableError and, under `set -u`,
 * UnboundVariableError.
 */
export async function evaluateArithmeticText(text: string, vars: ArithVariables): Promise<bigint> {
  // bash shows the expression from its first non-blank on
  const trimmed = text.replace(/^[ \t\n]+/, '');

  return await new Evaluation(trimmed, vars, 0).run();
}

/** The shell's variables as arithmetic sees them: scalars, and elements of either kind of array. */
export function contextVariables(ctx: ExecContextIf, expand?: (subscript: string, keyed: boolean) => Promise<string>): ArithVariables {
  const indexOf = (subscript: string, length: number) => {
    const index = Number(subscript);

    return index < 0 ? length + index : index;
  };

  return {
    get: (name, subscript) => {
      const value = ctx.getParam(name);

      // A scalar, the common case, without looking for arrays of the name
      if (subscript === undefined && value !== undefined) return Promise.resolve(value);

      const assoc = ctx.getAssoc(name);
      const array = ctx.getArray(name);

      if (subscript === undefined) {
        return Promise.resolve(array?.[0] ?? assoc?.['0']);
      }

      if (assoc) return Promise.resolve(assoc[subscript]);
      if (array) return Promise.resolve(array[indexOf(subscript, array.length)]);

      // `x[0]` on a scalar is the scalar
      return Promise.resolve(Number(subscript) === 0 ? value : undefined);
    },
    set: (name, subscript, value) => {
      if (subscript === undefined) {
        if (ctx.getArray(name)) ctx.setArrayElement(name, 0, value);
        else ctx.assignVariable(name, value);
      } else if (ctx.getAssoc(name)) {
        ctx.setAssocElement(name, subscript, value);
      } else {
        ctx.setArrayElement(name, indexOf(subscript, ctx.getArray(name)?.length ?? 0), value);
      }

      return Promise.resolve();
    },
    keyed: (name) => Boolean(ctx.getAssoc(name)),
    readonly: (name) => ctx.isReadonlyVar(name),
    nounset: () => ctx.getShellOption('nounset'),
    expand,
  };
}
