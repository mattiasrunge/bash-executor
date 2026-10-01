/**
 * The test and [ builtins, as bash's test.c has them.
 *
 * POSIX decides by the number of arguments up to four — `test -n` is true,
 * since one argument is a string — and past that a small grammar takes over:
 * `-o` binds looser than `-a`, `!` negates a term, and `( … )` groups. Errors
 * leave status 2 and say what was expected, as bash says it.
 *
 * File tests go to the host (`testPath`), since only it knows its files.
 */

import { contextVariables, evaluateArithmeticText } from '../arith.ts';
import { DEFAULT_SHELL_OPTIONS, type ExecContextIf, PATH_TEST_OPERATOR_MAP, type ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult, BuiltinServices } from './types.ts';

/** Operators taking one argument */
const UNARY = new Set([
  '-a',
  '-b',
  '-c',
  '-d',
  '-e',
  '-f',
  '-g',
  '-h',
  '-k',
  '-n',
  '-o',
  '-p',
  '-r',
  '-s',
  '-t',
  '-u',
  '-v',
  '-w',
  '-x',
  '-z',
  '-G',
  '-L',
  '-O',
  '-S',
  '-N',
  '-R',
]);

/** Operators between two arguments */
const BINARY = new Set(['=', '==', '!=', '<', '>', '-nt', '-ot', '-ef', '-eq', '-ne', '-lt', '-le', '-gt', '-ge']);

/** What bash says, and the status 2 that goes with it. */
class TestError extends Error {}

/** bash's legal_number: decimal, a sign, blanks around it, and within 64 bits. */
function integer(text: string): bigint {
  const match = text.match(/^[ \t\n]*([-+]?[0-9]+)[ \t\n]*$/);
  const value = match ? BigInt(match[1]) : undefined;

  if (value === undefined || value > 9223372036854775807n || value < -9223372036854775808n) {
    throw new TestError(`${text}: integer expression expected`);
  }

  return value;
}

class Test {
  private pos = 0;

  constructor(
    private readonly ctx: ExecContextIf,
    private readonly args: string[],
    private readonly shell: ShellIf,
    private readonly services?: BuiltinServices,
  ) {}

  async run(): Promise<boolean> {
    const { args } = this;

    switch (args.length) {
      case 0:
        return false;
      case 1:
        return args[0] !== '';
      case 2:
        return await this.two();
      case 3:
        return await this.three();
      case 4:
        if (args[0] === '!') {
          this.pos = 1;
          return !(await this.three());
        }

        if (args[0] === '(' && args[3] === ')') {
          this.pos = 1;
          return await this.two();
        }
    }

    const value = await this.or();

    if (this.pos !== args.length) {
      const at = args[this.pos];

      throw new TestError(at.startsWith('-') ? `syntax error: \`${at}' unexpected` : 'too many arguments');
    }

    return value;
  }

  /** Past the argument at `pos`; `needMore` when an operand must follow. */
  private advance(needMore: boolean): void {
    this.pos++;

    if (needMore && this.pos >= this.args.length) {
      throw new TestError('argument expected');
    }
  }

  private async two(): Promise<boolean> {
    const [first, second] = this.args.slice(this.pos);

    if (first === '!') return second === '';

    if (UNARY.has(first)) return await this.unary();

    throw new TestError(`${first}: unary operator expected`);
  }

  private async three(): Promise<boolean> {
    const [first, second, third] = this.args.slice(this.pos);

    if (BINARY.has(second)) return await this.binary();
    if (second === '-a') return first !== '' && third !== '';
    if (second === '-o') return first !== '' || third !== '';

    if (first === '!') {
      this.pos++;
      return !(await this.two());
    }

    if (first === '(' && third === ')') return second !== '';

    throw new TestError(`${second}: binary operator expected`);
  }

  private async or(): Promise<boolean> {
    const value = await this.and();

    if (this.args[this.pos] === '-o') {
      this.advance(false);
      const rest = await this.or();

      return value || rest;
    }

    return value;
  }

  private async and(): Promise<boolean> {
    const value = await this.term();

    if (this.args[this.pos] === '-a') {
      this.advance(false);
      const rest = await this.and();

      return value && rest;
    }

    return value;
  }

  private async term(): Promise<boolean> {
    const { args } = this;

    if (this.pos >= args.length) throw new TestError('argument expected');

    if (args[this.pos] === '!') {
      let negate = false;

      while (this.pos < args.length && args[this.pos] === '!') {
        this.advance(true);
        negate = !negate;
      }

      const value = await this.term();

      return negate ? !value : value;
    }

    if (args[this.pos] === '(') {
      this.advance(true);

      const value = await this.or();

      if (this.pos >= args.length) throw new TestError("`)' expected");
      if (args[this.pos] !== ')') throw new TestError(`\`)' expected, found ${args[this.pos]}`);

      this.advance(false);

      return value;
    }

    if (this.pos + 3 <= args.length && BINARY.has(args[this.pos + 1])) return await this.binary();
    if (this.pos + 2 <= args.length && UNARY.has(args[this.pos])) return await this.unary();

    const value = args[this.pos] !== '';

    this.advance(false);

    return value;
  }

  private async binary(): Promise<boolean> {
    const [left, op, right] = this.args.slice(this.pos, this.pos + 3);

    this.pos += 3;

    switch (op) {
      case '=':
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      case '<':
        return left < right;
      case '>':
        return left > right;
      case '-eq':
        return integer(left) === integer(right);
      case '-ne':
        return integer(left) !== integer(right);
      case '-lt':
        return integer(left) < integer(right);
      case '-le':
        return integer(left) <= integer(right);
      case '-gt':
        return integer(left) > integer(right);
      case '-ge':
        return integer(left) >= integer(right);
    }

    return await this.path(left, op, right);
  }

  private async unary(): Promise<boolean> {
    const op = this.args[this.pos];

    // `-t` alone is `-t 1`; its argument, when there is one, has to be a number
    if (op === '-t') {
      this.advance(false);

      if (this.pos >= this.args.length) return await this.path('1', op);

      const fd = this.args[this.pos];

      if (!/^[ \t\n]*[-+]?[0-9]+[ \t\n]*$/.test(fd)) return false;

      this.advance(false);

      return await this.path(fd.trim(), op);
    }

    this.advance(true);

    const arg = this.args[this.pos];

    this.advance(false);

    switch (op) {
      case '-n':
        return arg !== '';
      case '-z':
        return arg === '';
      case '-o':
        return arg in DEFAULT_SHELL_OPTIONS && this.ctx.getShellOption(arg);
      case '-v':
        return await this.isSet(arg);
      case '-R':
        return this.ctx.getVariable(arg)?.attributes.includes('n') ?? false;
    }

    return await this.path(arg, op);
  }

  /** A file test, which only the host can answer. */
  private async path(arg: string, op: string, other?: string): Promise<boolean> {
    if (!this.shell.testPath) {
      throw new Error(`'${op}' could not be evaluated, testPath is not defined in shell`);
    }

    return await this.shell.testPath(this.ctx, arg, PATH_TEST_OPERATOR_MAP[op === '-a' ? '-e' : op], other);
  }

  /**
   * `-v name`: set, an array by its element 0; `-v a[sub]`, that element, the
   * subscript expanded as arithmetic expands one — `test` sees the word after
   * the shell expanded it, and expands the subscript once more, as bash does.
   */
  private async isSet(arg: string): Promise<boolean> {
    const { ctx } = this;
    const match = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s);
    const params = { ...ctx.getEnv(), ...ctx.getParams() };

    if (!match) {
      return params[arg] !== undefined || ctx.getArray(arg)?.[0] !== undefined || ctx.getAssoc(arg)?.['0'] !== undefined;
    }

    const [, name, written] = match;
    const assoc = ctx.getAssoc(name);
    const array = ctx.getArray(name) ?? (params[name] !== undefined ? [params[name]] : undefined);

    if (written === '@' || written === '*') {
      return assoc ? Object.keys(assoc).length > 0 : (array ?? []).some((value) => value !== undefined);
    }

    const expand = this.services?.expandSubscript;
    const subscript = expand ? await expand(written, Boolean(assoc)) : written;

    if (assoc) return subscript in assoc;

    const index = Number(await evaluateArithmeticText(subscript, contextVariables(ctx, expand)));
    const at = index < 0 ? (array?.length ?? 0) + index : index;

    return array?.[at] !== undefined;
  }
}

async function test(name: string, ctx: ExecContextIf, args: string[], shell: ShellIf, services?: BuiltinServices): Promise<BuiltinResult> {
  try {
    return { code: (await new Test(ctx, args, shell, services).run()) ? 0 : 1 };
  } catch (error) {
    if (error instanceof TestError) {
      return { code: 2, stderr: `${name}: ${error.message}\n` };
    }

    const message = error instanceof Error ? error.message : String(error);

    return { code: 2, stderr: `${name}: expression error: ${message}\n` };
  }
}

/** The test builtin: 0 when the expression is true, 1 when false, 2 when it is none. */
export const testBuiltin: BuiltinHandler = async (ctx, args, shell, _io?, services?) => await test('test', ctx, args, shell, services);

/** The [ builtin: test, ending in a `]` of its own. */
export const bracketBuiltin: BuiltinHandler = async (ctx, args, shell, _io?, services?) => {
  if (args.length === 0 || args[args.length - 1] !== ']') {
    return { code: 2, stderr: "[: missing `]'\n" };
  }

  return await test('[', ctx, args.slice(0, -1), shell, services);
};
