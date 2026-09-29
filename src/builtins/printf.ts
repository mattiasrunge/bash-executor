/**
 * Implementation of the printf builtin using @std/fmt.
 *
 * Formats and prints arguments according to a format string.
 */

import { sprintf } from '@std/fmt/printf';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult } from './types.ts';

/**
 * Process bash-style escape sequences in a string.
 * Handles: \n, \t, \r, \\, \", \', \xHH (hex), \NNN (octal)
 */
function processEscapes(str: string): string {
  let result = '';
  let i = 0;

  while (i < str.length) {
    if (str[i] === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      switch (next) {
        case 'n':
          result += '\n';
          i += 2;
          break;
        case 't':
          result += '\t';
          i += 2;
          break;
        case 'r':
          result += '\r';
          i += 2;
          break;
        case '\\':
          result += '\\';
          i += 2;
          break;
        case '"':
          result += '"';
          i += 2;
          break;
        case "'":
          result += "'";
          i += 2;
          break;
        case 'x':
          // Hex escape \xHH
          if (i + 3 < str.length && /[0-9a-fA-F]{2}/.test(str.slice(i + 2, i + 4))) {
            result += String.fromCharCode(Number.parseInt(str.slice(i + 2, i + 4), 16));
            i += 4;
          } else {
            result += str[i];
            i++;
          }
          break;
        default:
          if (/[0-7]/.test(next)) {
            // Octal escape \NNN
            let octal = '';
            let j = i + 1;
            while (j < str.length && j < i + 4 && /[0-7]/.test(str[j])) {
              octal += str[j];
              j++;
            }
            result += String.fromCharCode(Number.parseInt(octal, 8));
            i = j;
          } else {
            result += str[i];
            i++;
          }
      }
    } else {
      result += str[i];
      i++;
    }
  }

  return result;
}

/**
 * The printf builtin command.
 *
 * Formats and prints arguments according to a format string.
 *
 * Format specifiers:
 * - %s: string
 * - %d, %i: decimal integer
 * - %o: octal integer
 * - %x, %X: hexadecimal integer
 * - %e: scientific notation
 * - %f: floating point
 * - %g: compact floating point
 * - %c: single character
 * - %%: literal percent
 *
 * @example
 * printf "Hello %s\n" "World"
 * printf "%d + %d = %d\n" 2 3 5
 * printf "%-10s %5d\n" "name" 42
 * printf "%s\n" a b c        # the format is reused until the arguments run out
 * printf -v line "%05d" 42   # into a variable instead of stdout
 */
export const printfBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
  let target: string | undefined;

  if (args[0] === '-v') {
    target = args[1];
    args = args.slice(2);

    if (!target || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(target)) {
      return { code: 2, stderr: `printf: \`${target ?? ''}': not a valid identifier\n` };
    }
  }

  if (args[0] === '--') {
    args = args.slice(1);
  }

  if (args.length === 0) {
    return {
      code: 1,
      stderr: 'printf: usage: printf format [arguments]\n',
    };
  }

  const rawFormat = args[0];
  const values = args.slice(1);

  try {
    // Process bash-style escape sequences in the format string
    let format = processEscapes(rawFormat);
    // Replace %i with %d since @std/fmt doesn't support %i
    format = format.replace(/%(-?\d*\.?\d*)i/g, '%$1d');
    // bash reuses the format as often as it takes to consume every argument,
    // and runs it once with none; a format that takes no arguments runs once
    const perRound = countConsumers(format);
    let output = '';
    let offset = 0;

    do {
      const round = values.slice(offset, offset + perRound);

      output += sprintf(format, ...convertValues(format, round));
      offset += perRound;
    } while (perRound > 0 && offset < values.length);

    if (target !== undefined) {
      ctx.setParams({ [target]: output });

      return { code: 0 };
    }

    return { code: 0, stdout: output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      stderr: `printf: ${message}\n`,
    };
  }
};

const SPECIFIER = /%[-+#0 ]*\d*\.?\d*[diouxXeEfFgGcsbq%]/g;

/** How many arguments one pass over the format consumes. */
function countConsumers(format: string): number {
  return [...format.matchAll(SPECIFIER)].filter((m) => !m[0].endsWith('%')).length;
}

/**
 * Convert string values to appropriate types based on format specifiers.
 * This is needed because sprintf expects typed arguments.
 */
function convertValues(format: string, values: string[]): unknown[] {
  const result: unknown[] = [];
  let valueIndex = 0;

  // Find format specifiers and convert corresponding values
  const specifierRegex = new RegExp(SPECIFIER);
  let match;

  while ((match = specifierRegex.exec(format)) !== null) {
    const spec = match[0];
    const type = spec[spec.length - 1];

    if (type === '%') {
      // Literal %, no value consumed
      continue;
    }

    const value = values[valueIndex] ?? '';
    valueIndex++;

    switch (type) {
      case 'd':
      case 'i':
      case 'o':
      case 'u':
      case 'x':
      case 'X':
        // Integer types
        result.push(Number.parseInt(value, 10) || 0);
        break;
      case 'e':
      case 'E':
      case 'f':
      case 'F':
      case 'g':
      case 'G':
        // Float types
        result.push(Number.parseFloat(value) || 0);
        break;
      case 'c':
        // Character - @std/fmt expects char code, not string
        result.push(value.charCodeAt(0) || 0);
        break;
      case 's':
      case 'q':
      default:
        // String types
        result.push(value);
        break;
    }
  }

  return result;
}
