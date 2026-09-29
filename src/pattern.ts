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
};

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
  let out = '[';

  if (pattern[i] === '!' || pattern[i] === '^') {
    out += '^';
    i++;
  }

  if (pattern[i] === ']') {
    out += '\\]';
    i++;
  }

  for (; i < pattern.length; i++) {
    const c = pattern[i];

    if (c === ']') {
      return { source: out === '[' ? '(?!)' : out === '[^' ? '[\\s\\S]' : out + ']', end: i };
    }

    if (c === '[' && ':=.'.includes(pattern[i + 1])) {
      const kind = pattern[i + 1];
      const close = pattern.indexOf(`${kind}]`, i + 2);

      if (close !== -1) {
        const name = pattern.slice(i + 2, close);

        out += kind === ':' ? POSIX_CLASSES[name] ?? '' : escapeClassChar(name);
        i = close + 1;
        continue;
      }
    }

    if (c === '\\' && backslashQuotes && i + 1 < pattern.length) {
      out += escapeClassChar(pattern[++i]);
      continue;
    }

    out += c === '-' ? '-' : escapeClassChar(c);
  }

  return undefined;
}

function escapeClassChar(text: string): string {
  return text.replace(/[\\\]\[^]/g, '\\$&');
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

      if (bracket) i = bracket.end;
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

/** A whole-string matcher for a shell pattern; an unusable one matches only itself. */
export function globToRegExp(pattern: string): RegExp {
  try {
    return new RegExp(`^${globToRegexSource(pattern)}$`);
  } catch {
    return new RegExp(`^${[...pattern].map(escapeRegexChar).join('')}$`);
  }
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

/** Quote every character of a text so a regular expression matches it literally. */
export function quoteRegex(text: string): string {
  return [...text].map(escapeRegexChar).join('');
}
