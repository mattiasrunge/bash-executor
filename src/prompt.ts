/**
 * A prompt's backslash escapes, as bash's decode_prompt_string reads them for
 * PS1, PS2, PS4 and `${x@P}`: `\u` the user, `\w` the working directory, `\$`
 * `#` for root and `$` otherwise, and the rest. What the shell knows of itself
 * comes in `PromptInfo`; the clock is the host's.
 *
 * With `promptvars` on — bash's default — the result is expanded after this,
 * as a double-quoted string is; what an escape put in that the user does not
 * control the text of (a directory, a host name) is quoted against that here.
 */

export type PromptInfo = {
  /** A variable's value, or undefined when it is not set */
  get(name: string): string | undefined;
  /** `$0`, for `\s` */
  shellName: string;
  /** Whether the result will be expanded, so what escapes give must be quoted */
  promptvars: boolean;
  /** The history number of the command being read, `\!` */
  historyNumber: number;
  /** The command number, `\#` */
  commandNumber: number;
  /** How many jobs there are, `\j` */
  jobs: number;
  /** Whether the shell edits lines with readline, which `\[` and `\]` speak to */
  lineEditing?: boolean;
  /** Now; tests pass a fixed time */
  now?: Date;
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n: number, width = 2, fill = '0') => String(n).padStart(width, fill);

/** strftime for the C locale, the conversions a prompt is likely to use. */
export function strftime(format: string, date: Date): string {
  const hours12 = date.getHours() % 12 || 12;

  return format.replace(/%([a-zA-Z%])/g, (all, c: string) => {
    switch (c) {
      case 'a':
        return DAYS[date.getDay()];
      case 'A':
        return FULL_DAYS[date.getDay()];
      case 'b':
      case 'h':
        return MONTHS[date.getMonth()];
      case 'B':
        return FULL_MONTHS[date.getMonth()];
      case 'c':
        return strftime('%a %b %e %H:%M:%S %Y', date);
      case 'd':
        return pad(date.getDate());
      case 'D':
        return strftime('%m/%d/%y', date);
      case 'e':
        return pad(date.getDate(), 2, ' ');
      case 'F':
        return strftime('%Y-%m-%d', date);
      case 'H':
        return pad(date.getHours());
      case 'I':
        return pad(hours12);
      case 'j': {
        const start = new Date(date.getFullYear(), 0, 1);

        return pad(Math.floor((date.getTime() - start.getTime()) / 86400000) + 1, 3);
      }
      case 'k':
        return pad(date.getHours(), 2, ' ');
      case 'l':
        return pad(hours12, 2, ' ');
      case 'm':
        return pad(date.getMonth() + 1);
      case 'M':
        return pad(date.getMinutes());
      case 'p':
        return date.getHours() < 12 ? 'AM' : 'PM';
      case 'r':
        return strftime('%I:%M:%S %p', date);
      case 'R':
        return strftime('%H:%M', date);
      case 's':
        return String(Math.floor(date.getTime() / 1000));
      case 'S':
        return pad(date.getSeconds());
      case 'T':
      case 'X':
        return strftime('%H:%M:%S', date);
      case 'u':
        return String(date.getDay() || 7);
      case 'w':
        return String(date.getDay());
      case 'x':
        return strftime('%m/%d/%y', date);
      case 'y':
        return pad(date.getFullYear() % 100);
      case 'Y':
        return String(date.getFullYear());
      case 'z': {
        const offset = -date.getTimezoneOffset();

        return `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
      }
      case 'Z':
        return Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? '';
      case '%':
        return '%';
      default:
        return all;
    }
  });
}

/** Quoted so the expansion after leaves it as it is: `$`, `` ` `` and `\` get a backslash. */
const forDoubleQuotes = (text: string) => text.replace(/[$`\\]/g, '\\$&');

/** Control characters shown as `^X`, as bash's sh_strvis shows them in `\w` and `\s`. */
// deno-lint-ignore no-control-regex -- the control characters are what it is about
const visible = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, (c) => c === '\x7f' ? '^?' : `^${String.fromCharCode(c.charCodeAt(0) + 64)}`);

/** `\w`: the working directory, `~` for HOME, with PROMPT_DIRTRIM's trailing parts only; `\W` its last part. */
function directory(info: PromptInfo, last: boolean): string {
  const pwd = info.get('PWD') || '.';
  const home = info.get('HOME');

  if (last) {
    if (home !== undefined && home === pwd) return '~';

    return pwd === '/' || pwd === '//' ? pwd : pwd.slice(pwd.lastIndexOf('/') + 1);
  }

  let dir = home && home.length > 1 && (pwd === home || pwd.startsWith(`${home}/`)) ? `~${pwd.slice(home.length)}` : pwd;
  const trim = Number(info.get('PROMPT_DIRTRIM') ?? '');

  // Keep a tilde prefix and the last PROMPT_DIRTRIM parts, `...` between
  if (Number.isInteger(trim) && trim > 0) {
    const prefix = dir.startsWith('~/') ? 1 : 0;
    const parts = dir.slice(prefix).split('/');

    if (parts.length - 1 > trim) dir = `${dir.slice(0, prefix)}/...${parts.slice(-trim).map((part) => `/${part}`).join('')}`.replace(/^\/\.\.\./, prefix ? '/...' : '...');
  }

  return dir;
}

/** The prompt with its escapes decoded; the caller expands it when `promptvars` is on. */
export function decodePrompt(text: string, info: PromptInfo): string {
  const quote = (value: string) => info.promptvars ? forDoubleQuotes(value) : value;
  const now = () => info.now ?? new Date();
  let out = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c !== '\\' || i + 1 >= text.length) {
      out += c;
      continue;
    }

    const e = text[++i];

    switch (e) {
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7': {
        // Three octal digits, or as many as are left: `\101` is A, `\0x` no escape at all
        const digits = text.slice(i, i + 3);

        if (!/^[0-7]+$/.test(digits)) {
          out += '\\';
          i--;
          break;
        }

        // `\000` is no character: bash's string ends there and goes on after it
        if (parseInt(digits, 8) & 0xff) out += String.fromCharCode(parseInt(digits, 8) & 0xff);
        i += digits.length - 1;
        break;
      }
      case 'a':
        out += '\x07';
        break;
      case 'd':
        out += strftime('%a %b %d', now());
        break;
      case 'D': {
        const close = text.indexOf('}', i + 2);

        if (text[i + 1] !== '{' || close === -1) {
          out += `\\${e}`;
          break;
        }

        out += quote(strftime(text.slice(i + 2, close) || '%X', now()));
        i = close;
        break;
      }
      case 'e':
        out += '\x1b';
        break;
      case 'h':
      case 'H': {
        const host = info.get('HOSTNAME') ?? 'localhost';

        out += quote(e === 'h' ? host.split('.')[0] : host);
        break;
      }
      case 'j':
        out += String(info.jobs);
        break;
      case 'l':
        out += 'tty';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 's': {
        const name = info.shellName;

        out += quote(visible(name.slice(name.lastIndexOf('/') + 1)));
        break;
      }
      case 't':
        out += strftime('%H:%M:%S', now());
        break;
      case 'T':
        out += strftime('%I:%M:%S', now());
        break;
      case '@':
        out += strftime('%I:%M %p', now());
        break;
      case 'A':
        out += strftime('%H:%M', now());
        break;
      case 'u':
        out += info.get('USER') ?? info.get('LOGNAME') ?? '';
        break;
      case 'v':
      case 'V': {
        const [major = '5', minor = '2', patch = '0'] = (info.get('BASH_VERSION') ?? '5.2.0').split(/[.(]/);

        out += e === 'v' ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
        break;
      }
      case 'w':
      case 'W':
        out += quote(visible(directory(info, e === 'W')));
        break;
      case '#':
        out += String(info.commandNumber);
        break;
      case '!':
        out += String(info.historyNumber);
        break;
      case '$': {
        const root = info.get('EUID') === '0';

        out += root ? '#' : info.promptvars ? '\\$' : '$';
        break;
      }
      case '[':
      case ']':
        // Readline's marks around what takes no room on the screen; without it, nothing
        if (info.lineEditing) out += e === '[' ? '\x01' : '\x02';
        break;
      case '\\':
        out += '\\';
        break;
      default:
        out += `\\${e}`;
    }
  }

  return out;
}
