import { decodeEscapedBytes, escapedByte } from '../bytes.ts';
import type { BuiltinHandler } from './types.ts';

/** The text with its escapes made; `stopped` when a `\c` ended it there. */
function interpretEscapes(str: string): { text: string; stopped: boolean } {
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
          // \c stops output, the newline included
          return { text: decodeEscapedBytes(result), stopped: true };
        case '0': {
          // Octal: \0nnn (up to 3 octal digits)
          let octal = '';
          let j = i + 2;
          while (j < str.length && j < i + 5 && /[0-7]/.test(str[j])) {
            octal += str[j];
            j++;
          }
          if (octal.length > 0) {
            result += escapedByte(parseInt(octal, 8));
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
            result += escapedByte(parseInt(hex, 16));
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

  return { text: decodeEscapedBytes(result), stopped: false };
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
export const echoBuiltin: BuiltinHandler = async (ctx, args) => {
  let noNewline = false;
  // `shopt -s xpg_echo` makes -e the default
  let interpretEscapesFlag = ctx.getShellOption('xpg_echo');
  let argStart = 0;

  // Options are words of n, e and E only, in any mix: `-neE`. Anything else,
  // `--` too, is the first word to print, as bash's echo has it
  for (; argStart < args.length && /^-[neE]+$/.test(args[argStart]); argStart++) {
    for (const letter of args[argStart].slice(1)) {
      if (letter === 'n') noNewline = true;
      else interpretEscapesFlag = letter === 'e';
    }
  }

  let output = args.slice(argStart).join(' ');
  let stopped = false;

  if (interpretEscapesFlag) {
    ({ text: output, stopped } = interpretEscapes(output));
  }

  if (!noNewline && !stopped) {
    output += '\n';
  }

  return { code: 0, stdout: output };
};
