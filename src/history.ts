/**
 * The shell's command history, as bash keeps it: readline's history list
 * (history.c, histfile.c), bash's rules for what goes on it (bashhist.c), and
 * `!` history expansion (histexpand.c), ported closely so that what a line
 * becomes is what bash makes of it.
 *
 * The list is the shell's own; a subshell gets a copy. What is read from a
 * file and written to one goes through the host, by the builtins.
 */

import { globToRegExp } from './pattern.ts';

/**
 * How a further line of a command joins its history entry: what goes between,
 * and whether the line goes on a quoted string.
 */
export type LineDelimiter = { chars: () => string; quoted: boolean };

/** One remembered line, and when it was added (seconds since the epoch). */
export type HistoryEntry = { line: string; time: number };

/** What the variables that steer history say, read as they are now. */
export type HistorySettings = {
  /** HISTCONTROL */
  ignoreSpace: boolean;
  ignoreDups: boolean;
  eraseDups: boolean;
  /** HISTIGNORE, split at unquoted colons */
  ignore: string[];
  /** histchars: the expansion, quick substitution and comment characters */
  expansionChar: string;
  substChar: string;
  commentChar: string;
};

/** The variables history reads its settings from. */
export function historySettings(get: (name: string) => string | undefined): HistorySettings {
  const control = (get('HISTCONTROL') ?? '').split(':');
  const chars = get('histchars');

  return {
    ignoreSpace: control.includes('ignorespace') || control.includes('ignoreboth'),
    ignoreDups: control.includes('ignoredups') || control.includes('ignoreboth'),
    eraseDups: control.includes('erasedups'),
    ignore: splitIgnore(get('HISTIGNORE') ?? ''),
    expansionChar: chars === undefined ? '!' : chars[0] ?? '',
    substChar: chars === undefined ? '^' : chars.length > 1 ? chars[1] : '^',
    commentChar: chars === undefined ? '#' : chars.length > 2 ? chars[2] : '#',
  };
}

/** HISTIGNORE's patterns: colon-separated, a backslash quoting a colon. */
function splitIgnore(text: string): string[] {
  const patterns: string[] = [];
  let current = '';

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      current += text[i] + text[++i];
    } else if (text[i] === ':') {
      if (current) patterns.push(current);
      current = '';
    } else {
      current += text[i];
    }
  }

  if (current) patterns.push(current);

  return patterns;
}

/**
 * The history list and what bash remembers about the lines it adds: the
 * numbering base, the most entries kept (HISTSIZE), how many lines this
 * session added and how many the history file had, and the state of the
 * command being read for command-oriented history.
 */
export class History {
  entries: HistoryEntry[] = [];
  /** The number of the first entry */
  base = 1;
  /** At most this many entries are kept (HISTSIZE), or any number */
  max?: number;

  /** Lines added since the history file was last written */
  linesThisSession = 0;
  /** Lines the history file is known to hold */
  linesInFile = 0;

  /** Whether the last line read was added as an entry of its own */
  lastLineAdded = false;
  /** Whether `history -s` added the last entry */
  lastLinePushed = false;

  /** The lines read of the command being read, and whether its first was saved */
  commandLineCount = 0;
  firstLineSaved = false;
  /** The line of the command that was a comment, or -2 */
  lineComment = -2;

  /** The last `!?string?` searched for and the word it matched */
  searchString?: string;
  searchMatch?: string;
  /** The last `:s/lhs/rhs/` */
  substLhs?: string;
  substRhs?: string;

  /** A subshell's own copy. */
  copy(): History {
    const copy = new History();

    Object.assign(copy, this);
    copy.entries = this.entries.map((entry) => ({ ...entry }));

    return copy;
  }

  get length(): number {
    return this.entries.length;
  }

  /** The entry numbered `n`, as `!n` and `fc` count. */
  get(n: number): HistoryEntry | undefined {
    return this.entries[n - this.base];
  }

  /** add_history: a new entry at the end, the oldest dropped past the limit. */
  add(line: string, time = Math.floor(Date.now() / 1000)): void {
    if (this.max !== undefined && this.max <= 0) return;

    if (this.max !== undefined && this.entries.length >= this.max) {
      const drop = this.entries.length - this.max + 1;

      this.entries.splice(0, drop);
      this.base += drop;
    }

    this.entries.push({ line, time });
  }

  /** stifle_history: keep at most `max` entries from now on. */
  stifle(max: number): void {
    if (max < 0) max = 0;

    if (this.entries.length > max) {
      const drop = this.entries.length - max;

      this.entries.splice(0, drop);
      this.base += drop;
    }

    this.max = max;

    if (this.linesThisSession > this.entries.length) this.linesThisSession = this.entries.length;
  }

  unstifle(): void {
    this.max = undefined;
  }

  /** remove_history: the entry at offset `i` from the oldest. */
  remove(i: number): boolean {
    if (i < 0 || i >= this.entries.length) return false;

    this.entries.splice(i, 1);
    this.linesThisSession--;

    return true;
  }

  /** remove_history_range: offsets `first` to `last`, both included. */
  removeRange(first: number, last: number): boolean {
    if (first < 0 || last >= this.entries.length || first > last) return false;

    this.entries.splice(first, last - first + 1);
    this.linesThisSession -= last - first + 1;

    return true;
  }

  /** bash_delete_last_history */
  removeLast(): boolean {
    return this.remove(this.entries.length - 1);
  }

  /** bash_clear_history */
  clear(): void {
    this.entries = [];
    this.base = 1;
    this.linesThisSession = 0;
  }

  /** really_add_history: added, and counted as this session's. */
  private reallyAdd(line: string): void {
    this.lastLineAdded = true;
    this.lastLinePushed = false;
    this.add(line);
    this.linesThisSession++;
  }

  /** check_history_control: whether HISTCONTROL lets the line be saved. */
  private allowedByControl(line: string, settings: HistorySettings): boolean {
    if (settings.ignoreSpace && line[0] === ' ') return false;
    if (settings.ignoreDups && this.entries.length > 0 && this.entries[this.entries.length - 1].line === line) return false;

    return true;
  }

  /** history_should_ignore: a HISTIGNORE pattern matches it, `&` the previous entry. */
  private ignored(line: string, settings: HistorySettings): boolean {
    const previous = this.entries[this.entries.length - 1]?.line;

    return settings.ignore.some((pattern) => {
      const expanded = previous === undefined ? pattern : pattern.replace(/\\&|&/g, (m) => m === '&' ? previous.replace(/[\\*?[\]@+!()|]/g, '\\$&') : m);

      return globToRegExp(expanded).test(line);
    });
  }

  /**
   * check_add_history: saved if HISTCONTROL and HISTIGNORE let it be, after
   * erasing earlier copies under erasedups. `force` adds it as an entry of its
   * own, never as a further line of the command being read.
   */
  checkAdd(line: string, settings: HistorySettings, force: boolean, delimiter?: LineDelimiter): boolean {
    if (!this.allowedByControl(line, settings) || this.ignored(line, settings)) return false;

    if (settings.eraseDups) {
      this.entries = this.entries.filter((entry) => entry.line !== line);
    }

    if (force) this.reallyAdd(line);
    else this.addLine(line, delimiter);

    return true;
  }

  /**
   * bash_add_history: a further line of a command joins its entry, with what
   * `delimiter` says goes between (cmdhist); any other line is an entry.
   */
  addLine(line: string, delimiter?: LineDelimiter): void {
    if (delimiter && this.commandLineCount > 1 && this.entries.length > 0) {
      let chars = this.commandLineCount === this.lineComment + 1 ? '\n' : delimiter.chars();
      const current = this.entries[this.entries.length - 1];
      let text = current.line;

      // A line that ended in an escaped newline goes on without it
      if (!delimiter.quoted && text.endsWith('\\') && !text.endsWith('\\\\')) {
        text = text.slice(0, -1);
        chars = '';
      }

      if (!delimiter.quoted && text.endsWith('\n') && chars.startsWith(';')) chars = chars.slice(1);

      current.line = text + chars + line;

      return;
    }

    this.reallyAdd(line);
  }
}

// ---------------------------------------------------------------------------
// History expansion
// ---------------------------------------------------------------------------

const WORD_DELIMITERS = ' \t\n;&()|<>';
const QUOTE_CHARACTERS = '"\'`';
const EVENT_DELIMITERS = '^$*%-';
const SEARCH_DELIMITERS = ';&()|<>';
const NO_EXPAND_CHARS = ' \t\n\r=';
const SLASHIFY_IN_QUOTES = '\\`"$';

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const fieldDelim = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n';

/** How a line is expanded: the shell's settings around it. */
export type ExpandOptions = {
  settings: HistorySettings;
  /** The line goes on a quoted string a line before it opened */
  quoting?: "'" | '"';
  posix?: boolean;
  extglob?: boolean;
  /** The number of entries to see: fewer while the command being expanded has its own */
  length?: number;
};

/**
 * What history_expand returns: -1 an error (the text its message), 0 nothing
 * expanded, 1 expanded, 2 to be printed and not run (`:p`).
 */
export type ExpandResult = { status: -1 | 0 | 1 | 2; text: string };

/** sh_single_quote */
function shSingleQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** quote_breaks: `:x`, quoted with the words broken at blanks and newlines. */
function quoteBreaks(text: string): string {
  let out = "'";

  for (const c of text) {
    if (c === "'") out += "'\\''";
    else if (c === ' ' || c === '\t' || c === '\n') out += `'${c}'`;
    else out += c;
  }

  return out + "'";
}

/** hist_string_extract_single_quoted: the index of the closing quote. */
function extractSingleQuoted(text: string, i: number, backslash: boolean): number {
  for (; i < text.length && text[i] !== "'"; i++) {
    if (backslash && text[i] === '\\' && i + 1 < text.length) i++;
  }

  return i;
}

/** skip_single_quoted: past the closing quote. */
function skipSingleQuoted(text: string, i: number): number {
  while (i < text.length && text[i] !== "'") i++;

  return i < text.length ? i + 1 : i;
}

/** skip_double_quoted: past the closing quote, a `$(…)` or backquote inside skipped whole. */
function skipDoubleQuoted(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i];

    if (c === '\\') {
      i += 2;
    } else if (c === '"') {
      return i + 1;
    } else if (c === '`') {
      i++;
      while (i < text.length && text[i] !== '`') i += text[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '$' && text[i + 1] === '(') {
      let depth = 1;

      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '\\') i++;
        else if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      }
    } else {
      i++;
    }
  }

  return i;
}

/**
 * skip_to_histexp: the index of the first `!` in `text` from `start` that
 * quoting does not hide, or its length. A double-quoted string hides it only
 * in POSIX mode; a command substitution starts unquoted.
 */
function skipToHistexp(text: string, start: number, delim: string, posix: boolean): number {
  let i = start;
  let passNext = false;
  let backq = false;
  let dquote = false;
  let oldDquote = false;
  let comsub = 0;

  while (i < text.length) {
    const c = text[i];

    if (passNext) {
      passNext = false;
      i++;
    } else if (c === '\\') {
      passNext = true;
      i++;
    } else if (backq && c === '`') {
      backq = false;
      dquote = oldDquote;
      i++;
    } else if (c === '`') {
      backq = true;
      oldDquote = dquote;
      dquote = false;
      i++;
    } else if (dquote && c === delim && text[i + 1] === '"') {
      i++;
    } else if (c === delim) {
      break;
    } else if (dquote && c === "'") {
      i++;
    } else if (c === "'") {
      i = skipSingleQuoted(text, i + 1);
    } else if (!posix && c === '"') {
      dquote = !dquote;
      i++;
    } else if (c === '"') {
      i = skipDoubleQuoted(text, i + 1);
    } else if ((c === '$' || c === '<' || c === '>') && text[i + 1] === '(' && text[i + 2] !== '(') {
      if (i + 2 >= text.length) return i + 2;
      i += 2;
      comsub++;
      oldDquote = dquote;
      dquote = false;
    } else if (comsub && c === ')') {
      comsub--;
      dquote = oldDquote;
      i++;
    } else {
      i++;
    }
  }

  return i;
}

/**
 * bash_history_inhibit_expansion: whether the `!` at `i` is one the shell
 * keeps — in a bracket expression, `${!name}`, `$!`, an extglob `!(…)`, or
 * quoted.
 */
function inhibitExpansion(text: string, i: number, opts: ExpandOptions): boolean {
  const hx = opts.settings.expansionChar;
  const after = text.slice(i + 1);

  if (i > 0 && text[i - 1] === '[' && after.includes(']')) return true;
  if (i > 1 && text[i - 1] === '{' && text[i - 2] === '$' && after.includes('}')) return true;
  if (i > 1 && text[i - 1] === '$' && text[i] === '!') return true;
  if (opts.extglob && i > 1 && text[i + 1] === '(' && text.slice(i + 2).includes(')')) return true;

  let si = 0;

  if (opts.quoting === "'") {
    si = skipToDelimQuote(text);
    if (si >= text.length || si >= i) return true;
    si++;
  }

  let t = skipToHistexp(text, si, hx, opts.posix ?? false);

  if (t > 0) {
    while (t < i) {
      t = skipToHistexp(text, t + 1, hx, opts.posix ?? false);
      if (t <= 0) return false;
    }

    return t > i;
  }

  return false;
}

/** The index of the first single quote: where a string a line before opened ends. */
function skipToDelimQuote(text: string): number {
  const at = text.indexOf("'");

  return at === -1 ? text.length : at;
}

/**
 * history_tokenize_word: where the word that starts at `ind` ends, split as
 * the shell would split it.
 */
function tokenizeWord(text: string, ind: number): number {
  let i = ind;
  let delimiter = '';
  let nestdelim = 0;
  let delimopen = '';

  if ('()\n'.includes(text[i])) return i + 1;

  getWord: {
    if (isDigit(text[i])) {
      let j = i;

      while (j < text.length && isDigit(text[j])) j++;
      if (j >= text.length) return j;

      i = j;
      // A digit sequence before a redirection is its descriptor; otherwise part of a word
      if (text[j] !== '<' && text[j] !== '>') break getWord;
    }

    if ('<>;&|'.includes(text[i]) && i < text.length) {
      const peek = text[i + 1];

      if (peek === text[i]) {
        if (peek === '<' && (text[i + 2] === '-' || text[i + 2] === '<')) i++;
        return i + 2;
      } else if (peek === '&' && (text[i] === '>' || text[i] === '<')) {
        let j = i + 2;

        while (j < text.length && isDigit(text[j])) j++;
        if (text[j] === '-') j++;
        return j;
      } else if ((peek === '>' && text[i] === '&') || (peek === '|' && text[i] === '>')) {
        return i + 2;
      } else if (peek === '(' && (text[i] === '>' || text[i] === '<')) {
        i += 2;
        delimopen = '(';
        delimiter = ')';
        nestdelim = 1;
        break getWord;
      }

      return i + 1;
    }
  }

  if (delimiter === '' && QUOTE_CHARACTERS.includes(text[i]) && i < text.length) delimiter = text[i++];

  for (; i < text.length; i++) {
    const c = text[i];

    if (c === '\\' && text[i + 1] === '\n') {
      i++;
      continue;
    }

    if (c === '\\' && delimiter !== "'" && (delimiter !== '"' || SLASHIFY_IN_QUOTES.includes(c))) {
      i++;
      continue;
    }

    if (nestdelim && c === delimopen) {
      nestdelim++;
      continue;
    }

    if (nestdelim && c === delimiter) {
      nestdelim--;
      if (nestdelim === 0) delimiter = '';
      continue;
    }

    if (delimiter && c === delimiter) {
      delimiter = '';
      continue;
    }

    // Command and process substitution, and extended patterns
    if (nestdelim === 0 && delimiter === '' && '<>$!@?+*'.includes(c) && text[i + 1] === '(') {
      // Past the parenthesis and the character after it, as readline goes
      i += 2;
      delimopen = '(';
      delimiter = ')';
      nestdelim = 1;
      continue;
    }

    if (delimiter === '' && WORD_DELIMITERS.includes(c)) break;
    if (delimiter === '' && QUOTE_CHARACTERS.includes(c)) delimiter = c;
  }

  return i;
}

/** history_tokenize_internal: the words of a line, and which one holds index `wind`. */
function tokenize(text: string, commentChar: string, wind = -1): { words: string[]; index: number } {
  const words: string[] = [];
  let index = -1;
  let i = 0;

  while (i < text.length) {
    while (i < text.length && fieldDelim(text[i])) i++;
    if (i >= text.length || (commentChar !== '' && text[i] === commentChar)) break;

    const start = i;

    i = tokenizeWord(text, start);

    // A delimiter that is not a blank is a word, with any next to it
    if (i === start) {
      i++;
      while (i < text.length && WORD_DELIMITERS.includes(text[i])) i++;
    }

    if (wind !== -1 && wind >= start && wind < i) index = words.length;

    words.push(text.slice(start, i));
  }

  return { words, index };
}

/** The words of a line, as `history_tokenize` splits them. */
export function historyTokenize(text: string): string[] {
  return tokenize(text, '').words;
}

/** history_arg_extract: words `first` to `last` (`$` the last, negative from the end). */
function argExtract(first: number | '$', last: number | '$', text: string): string | undefined {
  const words = tokenize(text, '').words;
  const len = words.length;

  if (words.length === 0) return undefined;

  const f = first === '$' ? len - 1 : first < 0 ? len + first - 1 : first;
  let l = last === '$' ? len - 1 : last < 0 ? len + last - 1 : last;

  l++;
  if (f >= len || l > len || f < 0 || l < 0 || f > l) return undefined;

  return words.slice(f, l).join(' ');
}

const BAD_WORD_SPEC = Symbol('bad word specifier');

/**
 * get_history_word_specifier: the words of `from` the specifier at `spec[i]`
 * names, undefined for none, or BAD_WORD_SPEC.
 */
function wordSpecifier(spec: string, from: string, at: { i: number }, h: History): string | undefined | typeof BAD_WORD_SPEC {
  let i = at.i;
  let expecting = false;
  let first: number | '$' = 0;
  let last: number | '$' = 0;

  if (spec[i] === ':') {
    i++;
    expecting = true;
  }

  if (spec[i] === '%') {
    at.i = i + 1;
    return h.searchMatch ?? '';
  }

  if (spec[i] === '*') {
    at.i = i + 1;
    return argExtract(1, '$', from) ?? '';
  }

  if (spec[i] === '$') {
    at.i = i + 1;
    return argExtract('$', '$', from);
  }

  if (spec[i] === '-') {
    first = 0;
  } else if (spec[i] === '^') {
    first = 1;
    i++;
  } else if (isDigit(spec[i]) && expecting) {
    first = 0;
    for (; isDigit(spec[i]); i++) first = first * 10 + Number(spec[i]);
  } else {
    return undefined;
  }

  if (spec[i] === '^' || spec[i] === '*') {
    last = spec[i] === '^' ? 1 : '$';
    i++;
  } else if (spec[i] !== '-') {
    last = first;
  } else {
    i++;

    if (isDigit(spec[i])) {
      last = 0;
      for (; isDigit(spec[i]); i++) last = last * 10 + Number(spec[i]);
    } else if (spec[i] === '$') {
      i++;
      last = '$';
    } else if (spec[i] === '^') {
      i++;
      last = 1;
    } else {
      // `x-` is x to the word before the last
      last = -1;
    }
  }

  at.i = i;

  let result: string | undefined;

  if (last === '$' || (typeof last === 'number' && (last < 0 || last >= (first as number)))) {
    result = argExtract(first, last, from);
  }

  return result ?? BAD_WORD_SPEC;
}

/** history_find_word: the word of `line` that holds index `ind`. */
function findWord(line: string, ind: number): string | undefined {
  const { words, index } = tokenize(line, '', ind);

  return index === -1 ? undefined : words[index];
}

/**
 * get_history_event: the line the event at `text[at.i]` names — `!!`, `!n`,
 * `!-n`, `!string` or `!?string?` — and `at.i` moved past it.
 */
function historyEvent(text: string, at: { i: number }, quote: string, h: History, opts: ExpandOptions): string | undefined {
  let i = at.i;
  const hx = opts.settings.expansionChar;
  const length = opts.length ?? h.length;
  const entry = (n: number) => n - h.base >= 0 && n - h.base < length ? h.entries[n - h.base].line : undefined;

  if (text[i] !== hx) return undefined;
  i++;

  if (text[i] === hx) {
    at.i = i + 1;
    return entry(h.base + length - 1);
  }

  let sign = 1;

  if (text[i] === '-' && isDigit(text[i + 1])) {
    sign = -1;
    i++;
  }

  if (isDigit(text[i])) {
    let which = 0;

    for (; isDigit(text[i]); i++) which = which * 10 + Number(text[i]);
    at.i = i;
    if (sign < 0) which = length + h.base - which;

    return entry(which);
  }

  let substring = false;

  if (text[i] === '?') {
    substring = true;
    i++;
  }

  const start = i;

  for (; i < text.length; i++) {
    const c = text[i];

    if (
      (!substring && (fieldDelim(c) || c === ':' || (i > start && c === '-') || (c !== '-' && EVENT_DELIMITERS.includes(c)) ||
        SEARCH_DELIMITERS.includes(c) || (quote !== '' && c === quote))) ||
      c === '\n' || (substring && c === '?')
    ) {
      break;
    }
  }

  let search = text.slice(start, i);

  if (substring && text[i] === '?') i++;
  at.i = i;

  if (search === '' && substring) {
    if (h.searchString === undefined) return undefined;
    search = h.searchString;
  }

  if (search === '') return undefined;

  for (let n = length - 1; n >= 0; n--) {
    const line = h.entries[n].line;

    if (substring) {
      const index = line.lastIndexOf(search);

      if (index !== -1) {
        h.searchString = search;
        h.searchMatch = findWord(line, index);
        return line;
      }
    } else if (line.startsWith(search)) {
      return line;
    }
  }

  return undefined;
}

/** hist_error: the text of the specifier, and what went wrong with it. */
function histError(text: string, start: number, current: number, message: string): string {
  return `${start < text.length ? text.slice(start, current) : ''}: ${message}`;
}

/** get_subst_pattern: a part of `:s/lhs/rhs/`, a backslash quoting the delimiter. */
function substPattern(text: string, at: { i: number }, delimiter: string, isRhs: boolean): string | undefined {
  let i = at.i;
  let si = i;

  for (; si < text.length && text[si] !== delimiter; si++) {
    if (text[si] === '\\' && text[si + 1] === delimiter) si++;
  }

  let result: string | undefined;

  if (si > i || isRhs) {
    result = '';
    for (let k = i; k < si; k++) {
      if (text[k] === '\\' && text[k + 1] === delimiter) k++;
      result += text[k];
    }
  }

  i = si;
  if (i < text.length) i++;
  at.i = i;

  return result;
}

/** `&` in the right side of `:s` is the left side; `\&` an ampersand. */
function rhsWithLhs(rhs: string, lhs: string): string {
  let out = '';

  for (let i = 0; i < rhs.length; i++) {
    if (rhs[i] === '&') out += lhs;
    else {
      if (rhs[i] === '\\' && rhs[i + 1] === '&') i++;
      out += rhs[i];
    }
  }

  return out;
}

/**
 * history_expand_internal: the expansion that starts at `text[start]`, its
 * event, words and modifiers. `current` is the line as expanded so far, for
 * `!#`.
 */
function expandOne(
  text: string,
  start: number,
  quote: string,
  current: string,
  h: History,
  opts: ExpandOptions,
): { status: -1 | 0 | 1; text: string; end: number } {
  const hx = opts.settings.expansionChar;
  const at = { i: start };
  let event: string | undefined;

  if (':$*%^'.includes(text[start + 1] ?? '\0') && text[start + 1] !== undefined) {
    at.i = start + 1;
    event = historyEvent(hx + hx, { i: 0 }, '', h, opts);
  } else if (text[start + 1] === '#') {
    at.i = start + 2;
    event = current;
  } else {
    event = historyEvent(text, at, quote, h, opts);
  }

  if (event === undefined) return { status: -1, text: histError(text, start, at.i, 'event not found'), end: at.i };

  let startingIndex = at.i;
  const words = wordSpecifier(text, event, at, h);

  if (words === BAD_WORD_SPEC) return { status: -1, text: histError(text, startingIndex, at.i, 'bad word specifier'), end: at.i };

  let temp = words ?? event;
  let wantQuotes = '';
  let printOnly = false;
  let i = at.i;

  startingIndex = i;

  while (text[i] === ':') {
    let c = text[i + 1];
    let globally = 0;
    let byWords = false;

    if (c === 'g' || c === 'a') {
      globally = 1;
      i++;
      c = text[i + 1];
    } else if (c === 'G') {
      byWords = true;
      i++;
      c = text[i + 1];
    }

    switch (c) {
      case 'q':
        wantQuotes = 'q';
        break;
      case 'x':
        wantQuotes = 'x';
        break;
      case 'p':
        printOnly = true;
        break;
      case 't': {
        const slash = temp.lastIndexOf('/');
        if (slash !== -1) temp = temp.slice(slash + 1);
        break;
      }
      case 'h': {
        const slash = temp.lastIndexOf('/');
        if (slash !== -1) temp = temp.slice(0, slash);
        break;
      }
      case 'r': {
        const dot = temp.lastIndexOf('.');
        if (dot !== -1) temp = temp.slice(0, dot);
        break;
      }
      case 'e': {
        const dot = temp.lastIndexOf('.');
        if (dot !== -1) temp = temp.slice(dot);
        break;
      }
      case '&':
      case 's': {
        if (c === 's') {
          if (i + 2 >= text.length) break;

          const delimiter = text[i + 2];
          const p = { i: i + 3 };
          const lhs = substPattern(text, p, delimiter, false);

          if (lhs !== undefined) h.substLhs = lhs;
          else if (h.substLhs === undefined) h.substLhs = h.searchString || undefined;

          let rhs = substPattern(text, p, delimiter, true) ?? '';

          if (rhs.includes('&')) rhs = rhsWithLhs(rhs, h.substLhs ?? '');
          h.substRhs = rhs;
          i = p.i;
        } else {
          i += 2;
        }

        const lhs = h.substLhs ?? '';
        const rhs = h.substRhs ?? '';

        if (lhs === '') return { status: -1, text: histError(text, startingIndex, i, 'no previous substitution'), end: i };
        if (lhs.length > temp.length) return { status: -1, text: histError(text, startingIndex, i, 'substitution failed'), end: i };

        let failed = true;
        let we = 0;

        for (let si = 0; si + lhs.length <= temp.length; si++) {
          if (byWords && si > we) {
            while (si < temp.length && fieldDelim(temp[si])) si++;
            we = tokenizeWord(temp, si);
          }

          if (temp.startsWith(lhs, si)) {
            temp = temp.slice(0, si) + rhs + temp.slice(si + lhs.length);
            failed = false;

            if (globally) {
              si += rhs.length - 1;
              globally++;
              continue;
            } else if (byWords) {
              si = we;
              continue;
            }

            break;
          }
        }

        if (globally > 1 || !failed) continue;

        return { status: -1, text: histError(text, startingIndex, i, 'substitution failed'), end: i };
      }
      default:
        return { status: -1, text: histError(text, i + 1, i + 2, 'unrecognized history modifier'), end: i };
    }

    i += 2;
  }

  if (wantQuotes === 'q') temp = shSingleQuote(temp);
  else if (wantQuotes === 'x') temp = quoteBreaks(temp);

  return { status: printOnly ? 1 : 0, text: temp, end: i - 1 };
}

/**
 * history_expand: `line` with its history expansions made. A `^old^new` at
 * its start is `!!:s^old^new`.
 */
export function historyExpand(line: string, h: History, opts: ExpandOptions): ExpandResult {
  const { expansionChar: hx, substChar, commentChar } = opts.settings;

  if (hx === '') return { status: 0, text: line };

  let text = line;

  if (substChar !== '' && line[0] === substChar) {
    text = `${hx}${hx}:s${line}`;
  } else {
    // Is there anything to expand at all?
    let dquote = opts.quoting === '"';
    let i = 0;

    if (opts.quoting === "'") {
      i = extractSingleQuoted(text, 0, false);
      if (i < text.length) i++;
    }

    for (; i < text.length; i++) {
      const c = text[i];
      const cc = text[i + 1];

      if (commentChar !== '' && c === commentChar && !dquote && (i === 0 || WORD_DELIMITERS.includes(text[i - 1]))) {
        i = text.length;
        break;
      } else if (c === hx) {
        if (cc === undefined || NO_EXPAND_CHARS.includes(cc)) continue;
        else if (dquote && cc === '"') continue;
        else if (inhibitExpansion(text, i, opts)) continue;
        else break;
      } else if (dquote && c === '\\' && cc === '"') {
        i++;
      } else if (c === '"') {
        dquote = !dquote;
      } else if (!dquote && c === "'") {
        const backslash = i > 0 && text[i - 1] === '$';

        i = extractSingleQuoted(text, i + 1, backslash);
      } else if (c === '\\') {
        if (cc === "'" || cc === hx) i++;
      }
    }

    if (text[i] !== hx) return { status: 0, text };
  }

  let result = '';
  let dquote = opts.quoting === '"';
  let squote = opts.quoting === "'";
  let i = 0;
  let modified = false;
  let onlyPrinting = false;
  let passc = false;

  if (squote) {
    i = extractSingleQuoted(text, 0, false);
    squote = false;
    result += text.slice(0, i);
    if (i < text.length) result += text[i++];
  }

  for (; i < text.length; i++) {
    const c = text[i];

    if (passc) {
      passc = false;
      result += c;
      continue;
    }

    if (c === hx) {
      const cc = text[i + 1];

      if (cc === undefined || NO_EXPAND_CHARS.includes(cc) || (dquote && cc === '"')) {
        result += c;
        continue;
      }

      // Whether to expand is decided on what has been expanded so far
      if (inhibitExpansion(result + c + cc, result.length, opts)) {
        result += c;
        continue;
      }

      if (cc === '#') {
        result += result;
        i++;
        continue;
      }

      const quote = squote ? "'" : dquote ? '"' : '';
      const one = expandOne(text, i, quote, result, h, opts);

      if (one.status < 0) return { status: -1, text: one.text };

      modified = true;
      result += one.text;
      onlyPrinting ||= one.status === 1;
      i = one.end;
      continue;
    }

    if (commentChar !== '' && c === commentChar) {
      if (!dquote && (i === 0 || WORD_DELIMITERS.includes(text[i - 1]))) {
        result += text.slice(i);
        break;
      }

      result += c;
      continue;
    }

    switch (c) {
      case '\\':
        passc = true;
        result += c;
        break;
      case '"':
        dquote = !dquote;
        result += c;
        break;
      case "'": {
        if (squote) {
          squote = false;
          result += c;
        } else if (!dquote) {
          const backslash = i > 0 && text[i - 1] === '$';
          const quoteAt = i;

          i = extractSingleQuoted(text, i + 1, backslash);
          result += text.slice(quoteAt, i + 1);
        } else {
          result += c;
        }
        break;
      }
      default:
        result += c;
    }
  }

  if (onlyPrinting) return { status: 2, text: result };

  return { status: modified ? 1 : 0, text: result };
}

/** Whether a line has anything history expansion could act on (history_expansion_p). */
export function mayExpand(line: string, settings: HistorySettings): boolean {
  return (settings.expansionChar !== '' && line.includes(settings.expansionChar)) || (settings.substChar !== '' && line.includes(settings.substChar));
}

/** The history file's text as entries: a `#<digits>` line is the time of the entry after it. */
export function parseHistoryFile(text: string, commentChar = '#'): { entries: HistoryEntry[]; lines: number } {
  const entries: HistoryEntry[] = [];
  let time: number | undefined;
  let lines = 0;

  for (const line of text.split('\n')) {
    if (line === '') continue;

    if (line[0] === commentChar && isDigit(line[1])) {
      time = Number.parseInt(line.slice(1), 10);
      continue;
    }

    entries.push({ line: line.replace(/\r$/, ''), time: time ?? Math.floor(Date.now() / 1000) });
    time = undefined;
    lines++;
  }

  return { entries, lines };
}

/** Entries as the history file holds them, each with its time when `timestamps`. */
export function historyFileText(entries: HistoryEntry[], timestamps: boolean, commentChar = '#'): string {
  return entries.map((entry) => (timestamps ? `${commentChar}${entry.time}\n` : '') + `${entry.line}\n`).join('');
}
