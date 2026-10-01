/**
 * Implementation of the printf builtin.
 *
 * Formats and prints arguments according to a format string, as bash's printf
 * does: C's conversions on 64-bit integers, `*` for a width or precision taken
 * from the arguments, and bash's own `%b`, `%q` and `%(…)T`.
 */

import { decodeEscapedBytes, escapedByte } from '../bytes.ts';
import { backslashQuoted } from '../quote.ts';
import type { ExecContextIf, ShellIf } from '../types.ts';
import { assignReference, type NameReference, nameReference } from './element.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64 = 2n ** 64n;

/**
 * A backslash escape at `text[i]` (the backslash), as the format string and
 * `%b` read them. `%b` alone takes `\c`, which ends all output, and reads
 * `\0nnn` as octal as well as `\nnn`.
 */
function escapeAt(text: string, i: number, inB: boolean, errors?: Diagnostics): { value: string; end: number; stop?: boolean } {
  const next = text[i + 1];
  const simple: Record<string, string> = {
    a: '\x07',
    b: '\b',
    e: '\x1b',
    E: '\x1b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    '"': '"',
    "'": "'",
    '?': '?',
  };

  if (next === undefined) return { value: '\\', end: i + 1 };
  // %b leaves `\"`, `\'` and `\?` as they are
  if (next in simple && !(inB && '"\'?'.includes(next))) return { value: simple[next], end: i + 2 };
  if (next === 'c' && inB) return { value: '', end: text.length, stop: true };

  if (next === 'x' || next === 'u' || next === 'U') {
    const max = next === 'x' ? 2 : next === 'u' ? 4 : 8;
    const hex = text.slice(i + 2, i + 2 + max).match(/^[0-9a-fA-F]+/)?.[0] ?? '';

    if (hex === '') {
      if (next === 'x') errors?.add('missing hex digit for \\x');
      return { value: `\\${next}`, end: i + 2 };
    }

    const code = Number.parseInt(hex, 16);

    return { value: next === 'x' ? escapedByte(code) : String.fromCodePoint(Math.min(code, 0x10ffff)), end: i + 2 + hex.length };
  }

  // `\nnn`; in %b also `\0nnn`, the zero not counted
  if (/[0-7]/.test(next)) {
    const from = inB && next === '0' ? i + 2 : i + 1;
    const octal = text.slice(from, from + 3).match(/^[0-7]*/)![0];

    return { value: escapedByte(Number.parseInt(octal || '0', 8)), end: from + octal.length };
  }

  return { value: `\\${next}`, end: i + 2 };
}

/** A whole string's escapes, for `%b`; `stop` when it said `\c`. */
function expandEscapes(text: string, errors: Diagnostics): { value: string; stop: boolean } {
  let value = '';

  for (let i = 0; i < text.length;) {
    if (text[i] !== '\\') {
      value += text[i++];
      continue;
    }

    const escape = escapeAt(text, i, true, errors);

    value += escape.value;
    i = escape.end;

    if (escape.stop) return { value, stop: true };
  }

  return { value, stop: false };
}

/** What went wrong with an argument, said once the output is done. */
class Diagnostics {
  messages: string[] = [];

  add(message: string): void {
    this.messages.push(`printf: ${message}\n`);
  }
}

/**
 * An integer argument, as C's strtoimax reads one: decimal, `0x` hex, a
 * leading 0 octal, or after a quote the code of the character that follows.
 * What does not read as a number is an error, and counts as much of it as did.
 */
function integerArgument(value: string, errors: Diagnostics): bigint {
  if (/^['"]/.test(value)) {
    return BigInt(value.codePointAt(1) ?? 0);
  }

  const match = value.match(/^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/);

  if (!match) {
    if (value.trim() !== '') errors.add(`${value}: invalid number`);
    return 0n;
  }

  if (match[0].length !== value.length) {
    errors.add(`${value}: invalid number`);
  }

  const digits = match[2];
  let number = digits.startsWith('0x') || digits.startsWith('0X')
    ? BigInt(digits)
    : digits.length > 1 && digits.startsWith('0')
    ? BigInt(`0o${digits.slice(1)}`)
    : BigInt(digits);

  if (match[1] === '-') number = -number;

  if (number > INT64_MAX || number < INT64_MIN) {
    errors.add(`${value}: Result too large`);
    number = number > INT64_MAX ? INT64_MAX : INT64_MIN;
  }

  return number;
}

/** A floating-point argument, as strtold reads one. */
function floatArgument(value: string, errors: Diagnostics): number {
  if (/^['"]/.test(value)) {
    return value.codePointAt(1) ?? 0;
  }

  const text = value.trim();

  if (text === '') return 0;

  const match = text.match(/^[+-]?(inf(inity)?|nan|0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/i);

  if (!match) {
    errors.add(`${value}: invalid number`);
    return 0;
  }

  if (match[0].length !== text.length) {
    errors.add(`${value}: invalid number`);
  }

  const lower = match[0].toLowerCase().replace(/^\+/, '');

  if (lower.endsWith('inf') || lower.endsWith('infinity')) return lower.startsWith('-') ? -Infinity : Infinity;
  if (lower.endsWith('nan')) return NaN;

  return Number(match[0]);
}

type Spec = { flags: string; width?: number; precision?: number; conversion: string; strftime?: string };

/** Pad to the width: on the right with `-`, with zeros for a number under `0`, else blanks on the left. */
function pad(text: string, spec: Spec, numeric: boolean): string {
  const width = spec.width ?? 0;

  if (text.length >= width) return text;
  if (spec.flags.includes('-')) return text.padEnd(width);

  if (numeric && spec.flags.includes('0') && /^[+\- ]?(0[xX])?[0-9a-fA-F.]/.test(text) && !/inf|nan/i.test(text)) {
    const sign = text.match(/^([+\- ]?(0[xX])?)/)![0];

    return sign + text.slice(sign.length).padStart(width - sign.length, '0');
  }

  return text.padStart(width);
}

function formatInteger(number: bigint, spec: Spec): string {
  const conversion = spec.conversion;
  const signed = conversion === 'd' || conversion === 'i';
  const unsigned = !signed && number < 0n ? number + UINT64 : number;
  const magnitude = signed ? (number < 0n ? -number : number) : unsigned;
  const radix = conversion === 'o' ? 8 : conversion === 'x' || conversion === 'X' ? 16 : 10;
  let digits = magnitude.toString(radix);

  if (conversion === 'X') digits = digits.toUpperCase();

  // A precision is the least number of digits; 0 with a 0 precision is none
  if (spec.precision !== undefined) {
    digits = spec.precision === 0 && magnitude === 0n ? '' : digits.padStart(spec.precision, '0');
  }

  let prefix = '';

  if (signed) {
    prefix = number < 0n ? '-' : spec.flags.includes('+') ? '+' : spec.flags.includes(' ') ? ' ' : '';
  } else if (spec.flags.includes('#')) {
    if (conversion === 'o' && !digits.startsWith('0')) prefix = '0';
    if ((conversion === 'x' || conversion === 'X') && magnitude !== 0n) prefix = conversion === 'x' ? '0x' : '0X';
  }

  // With a precision the 0 flag is ignored, as in C
  return pad(prefix + digits, spec.precision !== undefined ? { ...spec, flags: spec.flags.replace('0', '') } : spec, true);
}

/** C's %e mantissa and exponent: `1.500000e+00`. */
function exponential(number: number, precision: number, upper: boolean, alternate: boolean): string {
  let text = number.toExponential(precision);

  if (alternate && precision === 0) text = text.replace('e', '.e');

  text = text.replace(/e([+-])(\d)$/, 'e$10$2');

  return upper ? text.toUpperCase() : text;
}

function formatFloat(number: number, spec: Spec): string {
  const conversion = spec.conversion;
  const upper = conversion === conversion.toUpperCase();
  const sign = number < 0 || Object.is(number, -0) ? '-' : spec.flags.includes('+') ? '+' : spec.flags.includes(' ') ? ' ' : '';
  const magnitude = Math.abs(number);
  let body: string;

  if (!Number.isFinite(magnitude)) {
    body = Number.isNaN(magnitude) ? 'nan' : 'inf';
    body = upper ? body.toUpperCase() : body;
  } else if (conversion === 'f' || conversion === 'F') {
    body = magnitude.toFixed(spec.precision ?? 6);
    if (spec.flags.includes('#') && spec.precision === 0) body += '.';
  } else if (conversion === 'e' || conversion === 'E') {
    body = exponential(magnitude, spec.precision ?? 6, upper, spec.flags.includes('#'));
  } else if (conversion === 'a' || conversion === 'A') {
    body = hexFloat(magnitude, spec.precision, upper);
  } else {
    // %g: %e or %f, whichever the exponent calls for, without trailing zeros
    const precision = spec.precision === undefined ? 6 : spec.precision === 0 ? 1 : spec.precision;
    const exponent = magnitude === 0 ? 0 : Math.floor(Math.log10(Number(magnitude.toExponential(precision - 1))));

    body = exponent < -4 || exponent >= precision ? exponential(magnitude, precision - 1, upper, false) : magnitude.toFixed(Math.max(0, precision - 1 - exponent));

    if (!spec.flags.includes('#') && body.includes('.')) {
      body = body.replace(/\.?0+(?=$|[eE])/, '');
    }
  }

  return pad(sign + body, spec, true);
}

/** `%a`, as glibc writes a long double: the first hex digit 8 to f, `0xcp-2` for 3. */
function hexFloat(number: number, precision: number | undefined, upper: boolean): string {
  if (number === 0) return upper ? '0X0P+0' : '0x0p+0';

  const exponent = Math.floor(Math.log2(number)) - 3;
  let rest = number / 2 ** exponent;
  const lead = Math.floor(rest);
  let fraction = '';

  rest -= lead;

  for (let i = 0; i < (precision ?? 16) && (precision !== undefined || rest > 0); i++) {
    rest *= 16;
    const digit = Math.floor(rest);
    fraction += digit.toString(16);
    rest -= digit;
  }

  const text = `0x${lead.toString(16)}${fraction ? `.${fraction}` : ''}p${exponent >= 0 ? '+' : ''}${exponent}`;

  return upper ? text.toUpperCase() : text;
}

/** The pieces of a time in a zone: what strftime works from. */
function timeParts(seconds: number, timeZone?: string) {
  const date = new Date(seconds * 1000);
  let format: Intl.DateTimeFormat;

  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'long',
      timeZoneName: 'short',
    });
  } catch {
    // A zone Intl does not know: the local one
    return timeParts(seconds);
  }

  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  // The zone's offset: its wall clock read as UTC, less the moment itself
  const offset = Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(seconds) * 1000) / 60000);

  return { year, month, day, hour, minute, second, weekday: parts.weekday, zone: parts.timeZoneName, offset };
}

/**
 * `%(fmt)T`: a time as strftime writes it, in the zone TZ names. -1 is now, -2
 * when the shell started, and no argument is now too.
 */
function strftime(format: string, seconds: number, timeZone?: string): string {
  const t = timeParts(seconds, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekday = days.indexOf(t.weekday);
  const dayOfYear = Math.floor((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(t.year, 0, 1)) / 86400000) + 1;
  const codes: Record<string, () => string> = {
    Y: () => String(t.year),
    C: () => two(Math.floor(t.year / 100)),
    y: () => two(t.year % 100),
    m: () => two(t.month),
    d: () => two(t.day),
    e: () => String(t.day).padStart(2),
    H: () => two(t.hour),
    k: () => String(t.hour).padStart(2),
    I: () => two(t.hour % 12 || 12),
    l: () => String(t.hour % 12 || 12).padStart(2),
    M: () => two(t.minute),
    S: () => two(t.second),
    p: () => (t.hour < 12 ? 'AM' : 'PM'),
    P: () => (t.hour < 12 ? 'am' : 'pm'),
    a: () => days[weekday].slice(0, 3),
    A: () => days[weekday],
    b: () => months[t.month - 1].slice(0, 3),
    h: () => months[t.month - 1].slice(0, 3),
    B: () => months[t.month - 1],
    j: () => String(dayOfYear).padStart(3, '0'),
    s: () => String(Math.floor(seconds)),
    u: () => String(weekday || 7),
    w: () => String(weekday),
    n: () => '\n',
    t: () => '\t',
    '%': () => '%',
    F: () => `${codes.Y()}-${codes.m()}-${codes.d()}`,
    T: () => `${codes.H()}:${codes.M()}:${codes.S()}`,
    D: () => `${codes.m()}/${codes.d()}/${codes.y()}`,
    x: () => codes.D(),
    X: () => codes.T(),
    R: () => `${codes.H()}:${codes.M()}`,
    r: () => `${codes.I()}:${codes.M()}:${codes.S()} ${codes.p()}`,
    c: () => `${codes.a()} ${codes.b()} ${codes.e()} ${codes.T()} ${codes.Y()}`,
    Z: () => t.zone,
    z: () => `${t.offset < 0 ? '-' : '+'}${two(Math.floor(Math.abs(t.offset) / 60))}${two(Math.abs(t.offset) % 60)}`,
  };

  return format.replace(/%(.)/g, (whole, code: string) => codes[code]?.() ?? whole);
}

/** When the shell started, for `%(…)T` of -2. */
const SHELL_START = Date.now() / 1000;

/**
 * One pass over the format with the arguments from `next`. Returns the text,
 * how many arguments it took, whether a `%b` said to stop, and whether the
 * format was unusable.
 */
function formatOnce(
  format: string,
  args: string[],
  errors: Diagnostics,
  assignments: [string, number][],
  timeZone?: string,
): { text: string; consumed: number; stop: boolean; failed: boolean } {
  let text = '';
  let consumed = 0;
  const next = () => (consumed < args.length ? args[consumed++] : undefined);

  for (let i = 0; i < format.length; i++) {
    const c = format[i];

    if (c === '\\') {
      const escape = escapeAt(format, i, false, errors);

      text += escape.value;
      i = escape.end - 1;
      continue;
    }

    if (c !== '%') {
      text += c;
      continue;
    }

    if (format[i + 1] === '%') {
      text += '%';
      i++;
      continue;
    }

    // %[flags][width][.precision]conversion, a `*` taking the number from the arguments
    const spec: Spec = { flags: '', conversion: '' };
    let j = i + 1;

    while (j < format.length && '-+ #0'.includes(format[j])) spec.flags += format[j++];

    if (format[j] === '*') {
      const width = Number(integerArgument(next() ?? '', errors));

      if (width < 0) spec.flags += '-';
      spec.width = Math.abs(width);
      j++;
    } else {
      const digits = format.slice(j).match(/^\d+/)?.[0];

      if (digits) {
        spec.width = Number(digits);
        j += digits.length;
      }
    }

    if (format[j] === '.') {
      j++;

      if (format[j] === '*') {
        const precision = Number(integerArgument(next() ?? '', errors));

        spec.precision = precision < 0 ? undefined : precision;
        j++;
      } else {
        const digits = format.slice(j).match(/^\d*/)![0];

        spec.precision = Number(digits || '0');
        j += digits.length;
      }
    }

    // Length modifiers mean nothing here
    while (j < format.length && 'hlLjzt'.includes(format[j])) j++;

    if (format[j] === '(') {
      // The `)` that closes it, parentheses inside counted: `%(%x (foo))T`
      let close = -1;

      for (let k = j, depth = 0; k < format.length; k++) {
        if (format[k] === '(') depth++;
        if (format[k] === ')' && --depth === 0) {
          close = k;
          break;
        }
      }

      if (close !== -1) {
        // `%(…)` names a time format, and only `T` may follow it
        if (format[close + 1] !== 'T') {
          errors.add(`warning: \`${format[close + 1] ?? ''}': invalid time format specification`);
          text += format.slice(i, close + 2);
          i = close + 1;
          continue;
        }

        spec.strftime = format.slice(j + 1, close);
        j = close + 1;
      }
    }

    spec.conversion = format[j] ?? '';

    if (spec.conversion === '') {
      errors.add(`\`${format.slice(i, j + 1)}': missing format character`);
      return { text, consumed, stop: false, failed: true };
    }

    const argument = next();
    const value = argument ?? '';

    switch (spec.conversion) {
      case 'd':
      case 'i':
      case 'o':
      case 'u':
      case 'x':
      case 'X':
        text += formatInteger(integerArgument(value, errors), spec);
        break;
      case 'e':
      case 'E':
      case 'f':
      case 'F':
      case 'g':
      case 'G':
      case 'a':
      case 'A':
        text += formatFloat(floatArgument(value, errors), spec);
        break;
      case 'c':
        // An empty argument is a NUL, as C's %c of '\0'
        text += pad([...value][0] ?? '\0', spec, false);
        break;
      case 'n':
        // The number of characters written so far, into the variable named
        if (argument !== undefined) assignments.push([argument, [...text].length]);
        break;
      case 's':
        text += pad(spec.precision === undefined ? value : value.slice(0, spec.precision), spec, false);
        break;
      case 'b': {
        const expanded = expandEscapes(value, errors);

        text += pad(spec.precision === undefined ? expanded.value : expanded.value.slice(0, spec.precision), spec, false);

        if (expanded.stop) {
          return { text, consumed, stop: true, failed: false };
        }
        break;
      }
      case 'q':
        text += pad(backslashQuoted(value), spec, false);
        break;
      case 'T': {
        const seconds = argument === undefined || value === '-1' ? Date.now() / 1000 : value === '-2' ? SHELL_START : Number(integerArgument(value, errors));
        const time = strftime(spec.strftime || '%X', seconds, timeZone);

        text += pad(spec.precision === undefined ? time : time.slice(0, spec.precision), spec, false);
        break;
      }
      default:
        errors.add(`\`${spec.conversion}': invalid format character`);
        return { text, consumed, stop: false, failed: true };
    }

    i = j;
  }

  return { text, consumed, stop: false, failed: false };
}

/**
 * The printf builtin command.
 *
 * @example
 * printf "Hello %s\n" "World"
 * printf "%d + %d = %d\n" 2 3 5
 * printf "%-10s %5d\n" "name" 42
 * printf "%s\n" a b c        # the format is reused until the arguments run out
 * printf -v line "%05d" 42   # into a variable instead of stdout
 * printf "%*s|\n" 6 x        # the width from an argument
 */
export const printfBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
  _io?,
  services?,
): Promise<BuiltinResult> => {
  let target: NameReference | undefined;

  if (args[0] === '-v') {
    const name = args[1] ?? '';
    const ref = nameReference(name, ctx);

    args = args.slice(2);

    if (!ref) return { code: 2, stderr: `printf: \`${name}': not a valid identifier\n` };
    target = ref;
  }

  if (args[0] === '--') {
    args = args.slice(1);
  }

  if (args.length === 0) {
    return {
      code: 2,
      stderr: 'printf: usage: printf [-v var] format [arguments]\n',
    };
  }

  const format = args[0];
  let values = args.slice(1);
  const errors = new Diagnostics();
  // Each pass's complaints, then its text, as bash's output interleaves them
  const chunks: { stdout?: string; stderr?: string }[] = [];
  // What %n counted, name and count
  const assignments: [string, number][] = [];
  let failed = false;

  // bash reuses the format as often as it takes to consume every argument, and
  // runs it once with none; a format that takes none runs once
  do {
    const reported = errors.messages.length;
    const pass = formatOnce(format, values, errors, assignments, ctx.getEnv().TZ ?? ctx.getParams().TZ);

    // Bytes the escapes made are UTF-8 where they can be
    chunks.push({ stderr: errors.messages.slice(reported).join('') || undefined, stdout: decodeEscapedBytes(pass.text) || undefined });
    values = values.slice(pass.consumed);

    if (pass.stop || pass.failed || pass.consumed === 0) {
      failed = pass.failed;
      break;
    }
  } while (values.length > 0);

  const code = failed || errors.messages.length > 0 ? 1 : 0;

  for (const [name, count] of assignments) {
    ctx.assignVariable(name, String(count));
  }

  if (target !== undefined) {
    await assignReference(ctx, target, chunks.map((chunk) => chunk.stdout ?? '').join(''), services);

    return { code, stderr: errors.messages.join('') || undefined };
  }

  // Interleaved only when there is something to interleave
  if (errors.messages.length === 0) {
    return { code, stdout: chunks.map((chunk) => chunk.stdout ?? '').join('') || undefined };
  }

  return { code, output: chunks };
};
