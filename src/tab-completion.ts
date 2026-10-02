/**
 * Readline's half of a Tab, as bash configures it (complete.c, bashline.c):
 * which part of the line the word to complete is, how a match goes into the
 * line — quoted, the open quote closed, a `/` after a directory and a space
 * after anything else — and how matches are listed. What the matches are is
 * the executor's (`AstExecutor.completeTab`).
 */

/** Where a word to complete starts, and the quote it is open in. */
export type CompletionWord = {
  start: number;
  /** The open quote the word is in, `'` or `"`, or empty */
  quote: string;
  /** Whether a quote or a backslash is anywhere before the cursor */
  foundQuote: boolean;
};

/** What separates commands, for a word after one to be a command's name: bash's COMMAND_SEPARATORS. */
const COMMAND_SEPARATORS = ';|&{(`';

/** Characters a file name is quoted for: bash's default_filename_quote_characters. */
const FILENAME_QUOTE_CHARACTERS = ' \t\n\\"\'@<>=;|&()#$`?*[!:{~';

/** What `sh_backslash_quote` puts a backslash before (shquote.c's bstab). */
const BACKSLASHED = ' \t\n!"$&\'()*,;<>?[\\]^`{|}';

/** char_is_quoted: whether the character at `index` is escaped or inside quotes. */
export function charIsQuoted(line: string, index: number): boolean {
  let quote = '';

  for (let i = 0; i < index; i++) {
    const c = line[i];

    if (quote === "'") {
      if (c === "'") quote = '';
    } else if (c === '\\') {
      if (i + 1 === index) return true;
      i++;
    } else if (quote === '"') {
      if (c === '"') quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    }
  }

  return quote !== '';
}

/**
 * _rl_find_completion_word: the word ends at the cursor and starts after an
 * open quote, or else after the last word break (COMP_WORDBREAKS) that is
 * not quoted.
 */
export function findCompletionWord(line: string, point: number, breaks: string): CompletionWord {
  let start = point;
  let quote = '';
  let foundQuote = false;

  for (let i = 0; i < point; i++) {
    const c = line[i];

    if (quote !== "'" && c === '\\') {
      foundQuote = true;
      i++;
    } else if (quote) {
      if (c === quote) {
        quote = '';
        start = point;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      start = i + 1;
      foundQuote = true;
    }
  }

  if (start === point && !quote) {
    while (--start > 0) {
      if (breaks.includes(line[start]) && !(foundQuote && charIsQuoted(line, start))) break;
    }

    start = Math.max(start, 0);

    // Past the break the word starts
    if (start < point && breaks.includes(line[start]) && !(foundQuote && charIsQuoted(line, start))) start++;
  }

  return { start, quote, foundQuote };
}

/**
 * Whether the word at `start` is where a command's name goes: first on the
 * line, after a command separator (not a `>&` or `>|` redirection), or
 * after nothing but assignments. An open quote before it counts as the word's.
 */
export function inCommandPosition(line: string, start: number): boolean {
  let ti = start - 1;

  while (ti >= 0 && /[ \t\n]/.test(line[ti])) ti--;

  if (ti >= 0 && (line[ti] === '"' || line[ti] === "'")) {
    ti--;
    while (ti >= 0 && /[ \t\n]/.test(line[ti])) ti--;
  }

  if (ti < 0) return true;

  if (COMMAND_SEPARATORS.includes(line[ti])) {
    const previous = line[ti - 1];

    return !((line[ti] === '&' && (previous === '<' || previous === '>')) || (line[ti] === '|' && previous === '>'));
  }

  // `A=1 B=2 cm`: only assignments before it
  let begin = ti;

  while (begin > 0 && !COMMAND_SEPARATORS.includes(line[begin - 1]) && line[begin - 1] !== '\n') begin--;

  const words = line.slice(begin, ti + 1).trim().split(/[ \t]+/);

  return words.length > 0 && words.every((word) => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word));
}

/** bash_dequote_filename: the word as the file name it means, its quotes and backslashes gone. */
export function dequoteFilename(text: string, quote: string): string {
  let out = '';
  let quoted = quote;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '\\') {
      if (quoted === "'") out += c;
      else if (quoted === '"' && !'"$`\\\n'.includes(text[i + 1] ?? '')) out += c;
      if (i + 1 < text.length) out += text[++i];
    } else if (quoted && c === quoted) {
      quoted = '';
    } else if (!quoted && (c === "'" || c === '"')) {
      quoted = c;
    } else {
      out += c;
    }
  }

  return out;
}

/**
 * bash_quote_filename: a file name as it goes into the line — after
 * backslashes, or inside the quote the word is open in. Several matches
 * leave the quote open for more to be typed. `!` cannot be double-quoted
 * with history expansion on, so it gets backslashes and the quote goes.
 */
export function quoteFilename(name: string, multiple: boolean, quote: string, breaks: string, histexpand: boolean): { text: string; quote: string } {
  let style = quote === '"' ? 'double' : quote === "'" ? 'single' : name.includes('\n') ? 'single' : 'backslash';

  if (quote === '"' && histexpand && name.includes('!')) {
    style = 'backslash';
    quote = '';
  }

  let text: string;

  if (style === 'double') {
    text = `"${name.replace(/["$`\\]/g, '\\$&')}"`;
  } else if (style === 'single') {
    text = `'${name.replaceAll("'", "'\\''")}'`;
  } else {
    text = '';
    for (let i = 0; i < name.length; i++) {
      const c = name[i];

      text += BACKSLASHED.includes(c) || (c === '#' && i === 0) || breaks.includes(c) ? `\\${c}` : c;
    }
  }

  if (multiple && style !== 'backslash') text = text.slice(0, -1);

  return { text, quote };
}

/** Whether a file name has to be quoted to go into the line. */
export const needsQuoting = (name: string): boolean => [...name].some((c) => FILENAME_QUOTE_CHARACTERS.includes(c));

/** The longest prefix every match shares. */
export function commonPrefix(words: string[]): string {
  let prefix = words[0] ?? '';

  for (const word of words.slice(1)) {
    let i = 0;

    while (i < prefix.length && i < word.length && prefix[i] === word[i]) i++;
    prefix = prefix.slice(0, i);
  }

  return prefix;
}

/** printable_part: a file name as a list shows it, by its last part (`dir/` for `a/dir/`). */
export function printablePart(path: string): string {
  const slash = path.lastIndexOf('/');

  if (slash < 0 || path === '/') return path;
  if (slash < path.length - 1) return path.slice(slash + 1);

  const before = path.lastIndexOf('/', slash - 1);

  return before < 0 ? path : path.slice(before + 1);
}

/** completion_glob_pattern: whether the word has an unquoted `*`, `?` or `[…]` in it. */
export function isCompletionGlob(text: string): boolean {
  let quote = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '*' || c === '?') {
      return true;
    } else if (c === '[' && text.indexOf(']', i + 2) > i) {
      return true;
    }
  }

  return false;
}

/** A word as the glob pattern it is: its quotes gone, the pattern characters they quoted escaped. */
export function completionPattern(text: string): string {
  const special = '*?[]\\()|!+@';
  const escape = (c: string) => special.includes(c) ? `\\${c}` : c;
  let out = '';
  let quote = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quote === "'") {
      if (c === "'") quote = '';
      else out += escape(c);
    } else if (c === '\\' && i + 1 < text.length && (quote === '' || '"$`\\'.includes(text[i + 1]))) {
      out += escape(text[++i]);
    } else if (quote === '"') {
      if (c === '"') quote = '';
      else out += escape(c);
    } else if (c === '"' || c === "'") {
      quote = c;
    } else {
      out += c;
    }
  }

  return out;
}

/**
 * The matches laid out in columns as readline lists them
 * (rl_display_match_list): down the columns, each as wide as the widest
 * match and two spaces, as many as fit in `width` without filling it.
 * `widest` is the widest match, which readline measures without the `/`
 * it lists a directory with.
 */
export function matchColumns(words: string[], width: number, widest: number = Math.max(0, ...words.map((word) => [...word].length))): string {
  const max = widest + 2;
  let cols = Math.floor(width / max);

  if (cols !== 1 && cols * max === width) cols--;
  cols = Math.max(1, cols);

  const rows = Math.ceil(words.length / cols);
  const lines: string[] = [];

  for (let row = 0; row < rows; row++) {
    let line = '';

    for (let col = 0; col < cols; col++) {
      const word = words[col * rows + row];

      if (word === undefined) break;

      line += col + 1 < cols ? word + ' '.repeat(Math.max(1, max - [...word].length)) : word;
    }

    lines.push(line);
  }

  return lines.map((line) => `${line}\n`).join('');
}
