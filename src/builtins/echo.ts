import type { BuiltinHandler } from './types.ts';

/**
 * Interpret escape sequences in a string.
 * Supports: \n, \t, \r, \\, \a, \b, \f, \v, \0nnn (octal), \xHH (hex)
 */
function interpretEscapes(str: string): string {
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
        case 'a':
          result += '\x07'; // bell
          i += 2;
          break;
        case 'b':
          result += '\b';
          i += 2;
          break;
        case 'f':
          result += '\f';
          i += 2;
          break;
        case 'v':
          result += '\v';
          i += 2;
          break;
        case 'c':
          // \c stops output
          return result;
        case '0': {
          // Octal: \0nnn (up to 3 octal digits)
          let octal = '';
          let j = i + 2;
          while (j < str.length && j < i + 5 && /[0-7]/.test(str[j])) {
            octal += str[j];
            j++;
          }
          if (octal.length > 0) {
            result += String.fromCharCode(parseInt(octal, 8));
            i = j;
          } else {
            result += '\0';
            i += 2;
          }
          break;
        }
        case 'x': {
          // Hex: \xHH (up to 2 hex digits)
          let hex = '';
          let j = i + 2;
          while (j < str.length && j < i + 4 && /[0-9a-fA-F]/.test(str[j])) {
            hex += str[j];
            j++;
          }
          if (hex.length > 0) {
            result += String.fromCharCode(parseInt(hex, 16));
            i = j;
          } else {
            result += str[i];
            i++;
          }
          break;
        }
        default:
          // Unknown escape, keep as-is
          result += str[i];
          i++;
      }
    } else {
      result += str[i];
      i++;
    }
  }

  return result;
}

/**
 * The echo builtin - write arguments to stdout.
 *
 * Options:
 *   -n    Do not output trailing newline
 *   -e    Enable interpretation of escape sequences
 *   -E    Disable interpretation of escape sequences (default)
 *
 * Escape sequences (when -e is used):
 *   \\    backslash
 *   \a    alert (bell)
 *   \b    backspace
 *   \c    stop output
 *   \f    form feed
 *   \n    newline
 *   \r    carriage return
 *   \t    horizontal tab
 *   \v    vertical tab
 *   \0nnn octal value (up to 3 digits)
 *   \xHH  hex value (up to 2 digits)
 */
export const echoBuiltin: BuiltinHandler = async (_ctx, args) => {
  let noNewline = false;
  let interpretEscapesFlag = false;
  let argStart = 0;

  // Parse options
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-n') {
      noNewline = true;
      argStart = i + 1;
    } else if (arg === '-e') {
      interpretEscapesFlag = true;
      argStart = i + 1;
    } else if (arg === '-E') {
      interpretEscapesFlag = false;
      argStart = i + 1;
    } else if (arg === '-ne' || arg === '-en') {
      noNewline = true;
      interpretEscapesFlag = true;
      argStart = i + 1;
    } else if (arg === '-nE' || arg === '-En') {
      noNewline = true;
      interpretEscapesFlag = false;
      argStart = i + 1;
    } else if (arg === '--') {
      argStart = i + 1;
      break;
    } else if (arg.startsWith('-')) {
      // Unknown option, treat as regular argument
      break;
    } else {
      break;
    }
  }

  let output = args.slice(argStart).join(' ');

  if (interpretEscapesFlag) {
    output = interpretEscapes(output);
  }

  if (!noNewline) {
    output += '\n';
  }

  return { code: 0, stdout: output };
};
