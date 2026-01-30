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
 */
export const printfBuiltin: BuiltinHandler = async (
  _ctx: ExecContextIf,
  args: string[],
  _shell: ShellIf,
): Promise<BuiltinResult> => {
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
    // Convert values to appropriate types based on format specifiers
    const typedValues = convertValues(format, values);
    const output = sprintf(format, ...typedValues);
    return { code: 0, stdout: output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      stderr: `printf: ${message}\n`,
    };
  }
};

/**
 * Convert string values to appropriate types based on format specifiers.
 * This is needed because sprintf expects typed arguments.
 */
function convertValues(format: string, values: string[]): unknown[] {
  const result: unknown[] = [];
  let valueIndex = 0;

  // Find format specifiers and convert corresponding values
  const specifierRegex = /%[-+#0 ]*\d*\.?\d*[diouxXeEfFgGcsbq%]/g;
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
