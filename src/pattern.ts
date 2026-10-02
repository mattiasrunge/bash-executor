/**
 * Shell patterns and POSIX regular expressions, as JavaScript regular
 * expressions.
 *
 * One translation for every place bash matches a pattern — `case`, `[[ == ]]`,
 * `${v#pat}` and the like — and one for `[[ =~ ]]`, whose POSIX extended
 * regular expressions differ from JavaScript's mainly in their bracket
 * expressions.
 */

/** POSIX character classes, `[[:alpha:]]`, as JavaScript class contents (C locale). */
const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  word: '\\w',
  cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
  ascii: '\\x00-\\x7f',
};

/**
 * POSIX's names for the characters a collating symbol, `[.hyphen.]`, may
 * name — the ones bash's own table has that are not the character itself.
 */
const COLLATING_NAMES: Record<string, string> = {
  NUL: '\0',
  SOH: '\x01',
  STX: '\x02',
  ETX: '\x03',
  EOT: '\x04',
  ENQ: '\x05',
  ACK: '\x06',
  alert: '\x07',
  BEL: '\x07',
  backspace: '\b',
  BS: '\b',
  tab: '\t',
  HT: '\t',
  newline: '\n',
  LF: '\n',
  'vertical-tab': '\v',
  VT: '\v',
  'form-feed': '\f',
  FF: '\f',
  'carriage-return': '\r',
  CR: '\r',
  ESC: '\x1b',
  IS4: '\x1c',
  IS3: '\x1d',
  IS2: '\x1e',
  IS1: '\x1f',
  space: ' ',
  'exclamation-mark': '!',
  'quotation-mark': '"',
  'number-sign': '#',
  'dollar-sign': '$',
  'percent-sign': '%',
  ampersand: '&',
  apostrophe: "'",
  'left-parenthesis': '(',
  'right-parenthesis': ')',
  asterisk: '*',
  'plus-sign': '+',
  comma: ',',
  hyphen: '-',
  'hyphen-minus': '-',
  period: '.',
  'full-stop': '.',
  slash: '/',
  solidus: '/',
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  colon: ':',
  semicolon: ';',
  'less-than-sign': '<',
  'equals-sign': '=',
  'greater-than-sign': '>',
  'question-mark': '?',
  'commercial-at': '@',
  'left-square-bracket': '[',
  backslash: '\\',
  'reverse-solidus': '\\',
  'right-square-bracket': ']',
  circumflex: '^',
  'circumflex-accent': '^',
  underscore: '_',
  'low-line': '_',
  'grave-accent': '`',
  'left-brace': '{',
  'left-curly-bracket': '{',
  'vertical-line': '|',
  'right-brace': '}',
  'right-curly-bracket': '}',
  tilde: '~',
  DEL: '\x7f',
};

/** A collating symbol's character: its name, or the character itself; a name bash does not know is no character. */
function collatingElement(name: string): string {
  return COLLATING_NAMES[name] ?? ([...name].length === 1 ? name : '');
}

/**
 * A bracket expression, `[...]`, as a JavaScript character class.
 *
 * `pattern[open]` must be the `[`. Returns the class and the index of the
 * closing `]`, or undefined when there is none — the `[` is then an ordinary
 * character, as in bash.
 *
 * Negation is `[!...]` in a pattern and `[^...]` in both; a `]` first (after
 * the negation) is a member, not the end; `[:alpha:]`, `[=c=]` and `[.c.]`
 * name a class, an equivalence class and a collating element. In a pattern a
 * backslash quotes the next character; in a regular expression it is itself a
 * member.
 */
export function bracketExpression(pattern: string, open: number, backslashQuotes = true): { source: string; end: number } | undefined {
  let i = open + 1;
  let negate = false;
  // The members: a character, which may start or end a range, or a class's contents
  const members: ({ char: string } | { raw: string } | { hyphen: true })[] = [];

  if (pattern[i] === '!' || pattern[i] === '^') {
    negate = true;
    i++;
  }

  if (pattern[i] === ']') {
    members.push({ char: ']' });
    i++;
  }

  for (; i < pattern.length; i++) {
    const c = pattern[i];

    if (c === ']') {
      const body = classBody(members);

      return { source: body === '' ? (negate ? '[\\s\\S]' : '(?!)') : `[${negate ? '^' : ''}${body}]`, end: i };
    }

    if (c === '[' && ':=.'.includes(pattern[i + 1])) {
      const kind = pattern[i + 1];
      const close = pattern.indexOf(`${kind}]`, i + 2);

      if (close !== -1) {
        const name = pattern.slice(i + 2, close);

        if (kind === ':') {
          members.push({ raw: POSIX_CLASSES[name] ?? '' });
        } else {
          const element = kind === '.' ? collatingElement(name) : name;

          // A name bash does not know is no member at all
          if (element) members.push({ char: element });
        }

        i = close + 1;
        continue;
      }
    }

    if (c === '\\' && backslashQuotes && i + 1 < pattern.length) {
      members.push({ char: pattern[++i] });
      continue;
    }

    members.push(c === '-' ? { hyphen: true } : { char: c });
  }

  return undefined;
}

/**
 * A bracket expression's members as a JavaScript class's contents. A `-`
 * between two characters is a range — one whose end comes before its start
 * matches nothing, as in bash, rather than being the syntax error it is to
 * JavaScript — and anywhere else it is itself.
 */
function classBody(members: ({ char: string } | { raw: string } | { hyphen: true })[]): string {
  let out = '';

  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const next = members[i + 1];
    const end = members[i + 2];

    if ('char' in member && next && 'hyphen' in next && end && 'char' in end) {
      if (member.char <= end.char) {
        out += `${escapeClassChar(member.char)}-${escapeClassChar(end.char)}`;
      }

      i += 2;
    } else if ('raw' in member) {
      out += member.raw;
    } else {
      out += escapeClassChar('char' in member ? member.char : '-');
    }
  }

  return out;
}

function escapeClassChar(text: string): string {
  return text.replace(/[\\\]\[^-]/g, '\\$&');
}

function escapeRegexChar(c: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c;
}

/** Where the `)` that closes the group opened at `open` stands, or -1. */
function groupEnd(pattern: string, open: number): number {
  let depth = 0;

  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];

    if (c === '\\') {
      i++;
    } else if (c === '[') {
      const bracket = bracketExpression(pattern, i);

      // A `[` that no `]` closes reads on to the end, as bash's patscan has it: the group never closes
      if (!bracket) return -1;
      i = bracket.end;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i;
    }
  }

  return -1;
}

/** Split an extglob group's contents at the `|` of its own level. */
function alternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];

    if (c === '\\') {
      i++;
    } else if (c === '[') {
      const bracket = bracketExpression(body, i);

      if (bracket) i = bracket.end;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    } else if (c === '|' && depth === 0) {
      parts.push(body.slice(from, i));
      from = i + 1;
    }
  }

  parts.push(body.slice(from));

  return parts;
}

/**
 * A shell pattern as regular expression source, unanchored.
 *
 * `*`, `?`, bracket expressions, a backslash quoting the next character, and
 * the extended patterns `@(a|b)`, `*(…)`, `+(…)`, `?(…)` and `!(…)`. Bash
 * reads those only with `shopt -s extglob` (and always in `[[ ]]`); where it
 * would not, the text could not have parsed, so they are always read here.
 */
export function globToRegexSource(pattern: string): string {
  let out = '';

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if ('@*+?!'.includes(c) && pattern[i + 1] === '(') {
      const close = groupEnd(pattern, i + 1);

      if (close !== -1) {
        const body = alternatives(pattern.slice(i + 2, close)).map(globToRegexSource).join('|');

        if (c === '!') {
          // Anything the group does not match: what follows has to match the rest
          const rest = globToRegexSource(pattern.slice(close + 1));

          return `${out}(?:(?!(?:${body})${rest}$)[\\s\\S]*?)${rest}`;
        }

        out += `(?:${body})${c === '@' ? '' : c}`;
        i = close;
        continue;
      }
    }

    if (c === '*') {
      out += '[\\s\\S]*';
    } else if (c === '?') {
      out += '[\\s\\S]';
    } else if (c === '[') {
      const bracket = bracketExpression(pattern, i);

      if (bracket) {
        out += bracket.source;
        i = bracket.end;
      } else {
        out += '\\[';
      }
    } else if (c === '\\' && i + 1 < pattern.length) {
      out += escapeRegexChar(pattern[++i]);
    } else {
      out += escapeRegexChar(c);
    }
  }

  return out;
}

/** One piece of a parsed pattern, for the matcher `!(…)` needs. */
type Piece =
  | { regex: RegExp }
  | { star: true }
  | { group: string; alternatives: Piece[][] };

/** A pattern as pieces: extended groups, `*`, and a one-character regex for anything else. */
function pieces(pattern: string): Piece[] {
  const out: Piece[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if ('@*+?!'.includes(c) && pattern[i + 1] === '(') {
      const close = groupEnd(pattern, i + 1);

      if (close !== -1) {
        out.push({ group: c, alternatives: alternatives(pattern.slice(i + 2, close)).map(pieces) });
        i = close;
        continue;
      }
    }

    if (c === '*') {
      out.push({ star: true });
    } else if (c === '?') {
      out.push({ regex: /^[\s\S]$/ });
    } else if (c === '[' && bracketExpression(pattern, i)) {
      const bracket = bracketExpression(pattern, i)!;

      out.push({ regex: new RegExp(`^${bracket.source}$`) });
      i = bracket.end;
    } else if (c === '\\' && i + 1 < pattern.length) {
      out.push({ regex: new RegExp(`^${escapeRegexChar(pattern[++i])}$`) });
    } else {
      out.push({ regex: new RegExp(`^${escapeRegexChar(c)}$`) });
    }
  }

  return out;
}

/**
 * Whether `text` from `at` on matches the pieces from `index` on. Backtracking,
 * which is what `!(…)` needs: it matches any stretch of text that none of its
 * alternatives match whole, and only trying each stretch can tell.
 */
function matchPieces(list: Piece[], index: number, text: string, at: number): boolean {
  if (index === list.length) {
    return at === text.length;
  }

  const piece = list[index];
  const rest = (end: number) => matchPieces(list, index + 1, text, end);
  const whole = (alternative: Piece[], from: number, to: number) => matchPieces(alternative, 0, text.slice(from, to), 0);

  if ('regex' in piece) {
    return at < text.length && piece.regex.test(text[at]) && rest(at + 1);
  }

  if ('star' in piece) {
    for (let end = at; end <= text.length; end++) {
      if (rest(end)) return true;
    }

    return false;
  }

  const one = (from: number, to: number) => piece.alternatives.some((alternative) => whole(alternative, from, to));

  switch (piece.group) {
    case '!':
      for (let end = at; end <= text.length; end++) {
        if (!one(at, end) && rest(end)) return true;
      }

      return false;
    case '@':
    case '?':
      if (piece.group === '?' && rest(at)) return true;

      for (let end = at; end <= text.length; end++) {
        if (one(at, end) && rest(end)) return true;
      }

      return false;
    default: {
      // `*(…)` and `+(…)`: repeats, each taking at least one character
      const repeat = (from: number, count: number): boolean => {
        if ((count > 0 || piece.group === '*') && rest(from)) return true;

        for (let end = from + 1; end <= text.length; end++) {
          if (one(from, end) && repeat(end, count + 1)) return true;
        }

        return false;
      };

      return repeat(at, 0);
    }
  }
}

/**
 * A pattern with `!(…)` as a RegExp whose `test` matches it: a regular
 * expression cannot say "this stretch is not that", which `!(foo)*` needs.
 */
class NegatedPatternRegExp extends RegExp {
  constructor(source: string, private readonly list: Piece[]) {
    super(source);
  }

  override test(text: string): boolean {
    return matchPieces(this.list, 0, text, 0);
  }
}

/** A whole-string matcher for a shell pattern; an unusable one matches only itself. */
export function globToRegExp(pattern: string): RegExp {
  if (/(^|[^\\])!\(/.test(pattern)) {
    try {
      return new NegatedPatternRegExp(`^${globToRegexSource(pattern)}$`, pieces(pattern));
    } catch {
      // Unusable as a regular expression: fall through to the literal
    }
  }

  try {
    return new RegExp(`^${globToRegexSource(pattern)}$`);
  } catch {
    return new RegExp(`^${[...pattern].map(escapeRegexChar).join('')}$`);
  }
}

/** The text a quoted glob stands for: quoteGlob undone. */
export function unquoteGlob(glob: string): string {
  return glob.replace(/\\(.)/gs, '$1');
}

/** Quote every character of a text so a shell pattern matches it literally. */
export function quoteGlob(text: string): string {
  return text.replace(/[\\*?[\]()|@!+]/g, '\\$&');
}

/**
 * A POSIX extended regular expression as JavaScript regex source. The syntax
 * mostly agrees; bracket expressions do not — `[[:alpha:]]`, a `]` first in
 * the list, a backslash as a member.
 */
export function posixRegexToSource(regex: string): string {
  let out = '';

  for (let i = 0; i < regex.length; i++) {
    const c = regex[i];

    if (c === '\\' && i + 1 < regex.length) {
      out += c + regex[++i];
    } else if (c === '[') {
      const bracket = bracketExpression(regex, i, false);

      if (bracket) {
        out += bracket.source;
        i = bracket.end;
      } else {
        out += '\\[';
      }
    } else {
      out += c;
    }
  }

  return out;
}

/** The characters special in a POSIX extended regular expression, which a quoted one is escaped from. */
const ERE_CHARS = '.[\\()*+?{|^$';

/**
 * The text of `[[ =~ ]]`'s right side as the expression it is, the way bash's
 * quote_string_for_globbing makes it: a quoted character that is special to
 * a regular expression is escaped with a backslash, any other one is itself —
 * and inside a bracket expression a quoted character is copied as it is, no
 * backslash, there being none that means anything there: `['a]']` is `[a]]`.
 */
export function quoteRegexWord(chars: { char: string; quoted: boolean }[]): string {
  let out = '';

  for (let i = 0; i < chars.length; i++) {
    const { char, quoted } = chars[i];

    if (quoted) {
      out += ERE_CHARS.includes(char) ? `\\${char}` : char;
      continue;
    }

    if (char !== '[') {
      out += char;
      continue;
    }

    // A bracket expression, up to the first unquoted `]` that is not its first member
    const plain = (k: number, c: string) => k < chars.length && !chars[k].quoted && chars[k].char === c;
    let body = '[';
    let k = i + 1;

    if (plain(k, '^')) body += chars[k++].char;
    if (plain(k, ']')) body += chars[k++].char;

    let closed = false;
    let inner: string | undefined;

    for (; k < chars.length; k++) {
      const c = chars[k];

      if (!c.quoted && inner === undefined && c.char === ']') {
        closed = true;
        break;
      }

      // `[:alpha:]`, `[=a=]`, `[.a.]` keep their `]`
      if (!c.quoted && c.char === '[' && k + 1 < chars.length && ':=.'.includes(chars[k + 1].char) && !chars[k + 1].quoted) {
        inner = chars[k + 1].char;
        body += c.char + chars[++k].char;
        if (inner !== ':' && plain(k + 1, ']')) body += chars[++k].char;
        continue;
      }

      if (inner !== undefined && !c.quoted && c.char === inner && plain(k + 1, ']')) {
        body += c.char + chars[++k].char;
        inner = undefined;
        continue;
      }

      body += c.char;
    }

    // With no `]` to close it the `[` is no bracket expression, and the rest is read as anything else
    if (!closed) {
      out += '[';
      continue;
    }

    out += `${body}]`;
    i = k;
  }

  return out;
}

/** Quote every character of a text so a regular expression matches it literally. */
export function quoteRegex(text: string): string {
  return [...text].map(escapeRegexChar).join('');
}
