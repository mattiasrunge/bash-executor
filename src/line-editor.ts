/**
 * The line a person types at a prompt, edited with the keys bash's readline
 * gives them in its emacs mode: moving and deleting by character and word,
 * killing and yanking, stepping through the history, searching it as they
 * type (`C-r`), and `C-o`, which runs a line and brings the one after it back.
 *
 * It draws nothing. A host feeds it what the terminal sends, asks it what to
 * show (`display`) and acts on what a key ended in: a line to run, the end of
 * input, an interrupt, a completion to make. The history it steps through is
 * the executor's own, so what `history`, `fc` and `!` see is what `C-p` sees.
 */

import type { History } from './history.ts';

/** What a key came to, for the host to act on. */
export type EditorResult =
  /** The line or the cursor changed, or nothing did: show it again */
  | { kind: 'edit' }
  /** Enter, or `C-o`: the line is done */
  | { kind: 'accept'; line: string }
  /** `C-d` on an empty line: the end of input */
  | { kind: 'eof' }
  /** `C-c`: the line is dropped */
  | { kind: 'interrupt' }
  /**
   * Tab: the host completes the word (`AstExecutor.completeTab`) and hands the
   * line back with `completed`; `list` when the key before was a Tab that
   * changed nothing, which lists the matches instead, as readline does
   */
  | { kind: 'complete'; list: boolean }
  /** `C-l`: the screen cleared, the line shown again on it */
  | { kind: 'clear' }
  /** Nothing to do for it: the start of the history, a search that failed */
  | { kind: 'bell' };

/** What the host shows: the text before the line, the line, and where the cursor is in it. */
export type EditorDisplay = { prompt: string; line: string; cursor: number };

type Search = {
  query: string;
  reverse: boolean;
  failing: boolean;
  /** Where the search began, to go back to on `C-g` */
  savedLine: string;
  savedPoint: number;
  savedPosition: number;
  /** The entry the match is in, and where in it */
  position: number;
  at: number;
};

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** CSI and SS3 sequences, and what they are for. */
const SEQUENCES: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1bOA': 'up',
  '\x1bOB': 'down',
  '\x1bOC': 'right',
  '\x1bOD': 'left',
  '\x1bOH': 'home',
  '\x1bOF': 'end',
  '\x1b[1~': 'home',
  '\x1b[7~': 'home',
  '\x1b[4~': 'end',
  '\x1b[8~': 'end',
  '\x1b[3~': 'delete',
  '\x1b[1;5C': 'word-right',
  '\x1b[1;5D': 'word-left',
  '\x1b[1;3C': 'word-right',
  '\x1b[1;3D': 'word-left',
  '\x1b[5~': 'history-start',
  '\x1b[6~': 'history-end',
};

/**
 * What a terminal sent, as keys: a character, a control character, an escape
 * sequence (`\x1b[A`), or a meta key, ESC and a character (`\x1bb`). An escape
 * sequence cut off at the end is handed back as `rest`, to go before the next.
 */
export function splitKeys(input: string): { keys: string[]; rest: string } {
  const keys: string[] = [];
  let i = 0;

  while (i < input.length) {
    const c = input[i];

    if (c !== '\x1b') {
      const cp = input.codePointAt(i)!;
      const char = String.fromCodePoint(cp);

      keys.push(char);
      i += char.length;
      continue;
    }

    // A lone ESC at the end may be the start of a sequence still to come
    if (i + 1 >= input.length) return { keys, rest: input.slice(i) };

    const next = input[i + 1];

    if (next === '[') {
      // CSI: parameters, then a final byte
      let end = i + 2;

      while (end < input.length && !/[\x40-\x7e]/.test(input[end])) end++;

      if (end >= input.length) return { keys, rest: input.slice(i) };

      keys.push(input.slice(i, end + 1));
      i = end + 1;
    } else if (next === 'O') {
      if (i + 2 >= input.length) return { keys, rest: input.slice(i) };

      keys.push(input.slice(i, i + 3));
      i += 3;
    } else {
      keys.push(input.slice(i, i + 2));
      i += 2;
    }
  }

  return { keys, rest: '' };
}

export class LineEditor {
  /** The line as it stands, and the cursor in it */
  line = '';
  point = 0;

  /** The entry shown, by index; the history's length is the line being typed */
  private position = 0;
  /** The line being typed, while an entry of the history is shown */
  private typed = '';
  private search?: Search;
  /** The last thing killed, for C-y; whether the last key killed, so the next adds to it */
  private killed = '';
  private lastKilled = false;
  private lastKey = '';
  /** Whether the last Tab's completion changed the line */
  private completionChanged = false;
  /** C-v: the next key goes in as it is */
  private quoting = false;
  /** C-o: the number of the entry to bring back once the line has run */
  private nextEntry?: number;
  /** The last string searched for, for C-r C-r */
  private lastQuery = '';
  /** Keys a host had read past the end of a line, for the next one; an escape sequence cut off */
  private queued: string[] = [];
  private partial = '';

  constructor(private readonly history: () => History | undefined = () => undefined) {}

  private get entries(): string[] {
    return this.history()?.entries.map((entry) => entry.line) ?? [];
  }

  /**
   * A new line begins: empty, or — after `C-o` — the entry that came after the
   * one run, as readline brings it back.
   */
  start(): void {
    const entries = this.entries;

    this.search = undefined;
    this.typed = '';
    this.quoting = false;
    this.position = entries.length;
    this.line = '';
    this.point = 0;

    if (this.nextEntry !== undefined) {
      const history = this.history();
      const index = history ? this.nextEntry - history.base : -1;

      this.nextEntry = undefined;

      if (index >= 0 && index < entries.length) {
        this.position = index;
        this.setLine(entries[index]);
      }
    }
  }

  /** Put a line in, the cursor where it says or at its end. */
  setLine(line: string, point: number = line.length): void {
    this.line = line;
    this.point = Math.max(0, Math.min(point, line.length));
  }

  /** The line as a Tab's completion leaves it; one that changed nothing lets the next Tab list. */
  completed(line: string, point: number = line.length): void {
    this.completionChanged = line !== this.line;
    this.setLine(line, point);
  }

  /** What to show for `prompt`: it, or the search's own while one goes on. */
  display(prompt: string): EditorDisplay {
    if (!this.search) return { prompt, line: this.line, cursor: this.point };

    const { query, reverse, failing } = this.search;
    const label = `(${failing ? 'failed ' : ''}${reverse ? 'reverse-' : ''}i-search)\`${query}': `;

    return { prompt: label, line: this.line, cursor: this.point };
  }

  /** Whether a search is going on. */
  get searching(): boolean {
    return this.search !== undefined;
  }

  /**
   * What the terminal sent: the keys in it, each acted on, up to one that ends
   * the line — the rest wait for the next. An escape sequence cut off at the
   * end waits for what completes it.
   */
  feedText(text: string): EditorResult[] {
    const { keys, rest } = splitKeys(this.partial + text);

    this.partial = rest;
    this.queued.push(...keys);

    return this.drain();
  }

  /** The keys waiting, acted on up to one that ends the line. */
  drain(): EditorResult[] {
    const results: EditorResult[] = [];

    while (this.queued.length > 0) {
      const result = this.feed(this.queued.shift()!);

      results.push(result);

      if (result.kind === 'accept' || result.kind === 'eof' || result.kind === 'interrupt' || result.kind === 'complete' || result.kind === 'clear') break;
    }

    return results;
  }

  /** Whether keys are waiting, read past the end of the last line. */
  get pending(): boolean {
    return this.queued.length > 0;
  }

  /** A lone ESC with nothing after it: the key on its own. */
  flushEscape(): EditorResult | undefined {
    if (this.partial !== '\x1b') return undefined;

    this.partial = '';

    return this.feed('\x1b');
  }

  /** One key. */
  feed(key: string): EditorResult {
    const previous = this.lastKey;

    this.lastKey = key;

    if (this.quoting) {
      this.quoting = false;
      return this.insert(key);
    }

    if (this.search) {
      const handled = this.searchKey(key);

      if (handled) return handled;
    }

    const wasKill = this.lastKilled;

    this.lastKilled = false;

    const action = SEQUENCES[key] ?? key;

    switch (action) {
      case '\r':
      case '\n':
        return this.accept();
      case '\x0f': // C-o: operate-and-get-next
        return this.operateAndGetNext();
      case '\x01':
      case 'home':
        this.point = 0;
        return { kind: 'edit' };
      case '\x05':
      case 'end':
        this.point = this.line.length;
        return { kind: 'edit' };
      case '\x02':
      case 'left':
        if (this.point === 0) return { kind: 'bell' };
        this.point -= this.charBefore().length;
        return { kind: 'edit' };
      case '\x06':
      case 'right':
        if (this.point >= this.line.length) return { kind: 'bell' };
        this.point += this.charAt().length;
        return { kind: 'edit' };
      case '\x1bb':
      case 'word-left':
        this.point = this.wordStart();
        return { kind: 'edit' };
      case '\x1bf':
      case 'word-right':
        this.point = this.wordEnd();
        return { kind: 'edit' };
      case '\x04': // C-d: the end on an empty line, else delete-char
        if (this.line === '') return { kind: 'eof' };
        return this.deleteForward();
      case 'delete':
        return this.deleteForward();
      case '\x7f':
      case '\x08':
        if (this.point === 0) return { kind: 'bell' };
        this.cut(this.point - this.charBefore().length, this.point);
        return { kind: 'edit' };
      case '\x0b': // C-k: kill-line
        return this.kill(this.point, this.line.length, wasKill, true);
      case '\x15': // C-u: unix-line-discard
        return this.kill(0, this.point, wasKill, false);
      case '\x17': // C-w: unix-word-rubout, back to whitespace
        return this.kill(this.whitespaceStart(), this.point, wasKill, false);
      case '\x1bd':
        return this.kill(this.point, this.wordEnd(), wasKill, true);
      case '\x1b\x7f':
      case '\x1b\x08':
        return this.kill(this.wordStart(), this.point, wasKill, false);
      case '\x19': // C-y: yank
        return this.insert(this.killed);
      case '\x14': // C-t: transpose-chars
        return this.transpose();
      case '\x10':
      case 'up':
        return this.step(-1);
      case '\x0e':
      case 'down':
        return this.step(1);
      case '\x1b<':
      case 'history-start':
        return this.moveTo(0);
      case '\x1b>':
      case 'history-end':
        return this.moveTo(this.entries.length);
      case '\x1b.':
      case '\x1b_':
        return this.yankLastArg();
      case '\x12': // C-r
        return this.beginSearch(true);
      case '\x13': // C-s
        return this.beginSearch(false);
      case '\x16': // C-v: quoted-insert
        this.quoting = true;
        return { kind: 'edit' };
      case '\x03':
        this.line = '';
        this.point = 0;
        return { kind: 'interrupt' };
      case '\x07': // C-g: abort
        return { kind: 'bell' };
      case '\x0c':
        return { kind: 'clear' };
      case '\t': {
        const list = previous === '\t' && !this.completionChanged;

        this.completionChanged = false;

        return { kind: 'complete', list };
      }
      default:
        // Another control character or sequence is no key bound here
        if (key.startsWith('\x1b') || (key.length === 1 && key.charCodeAt(0) < 0x20)) return { kind: 'bell' };

        return this.insert(key);
    }
  }

  private accept(): EditorResult {
    const line = this.line;

    this.position = this.entries.length;

    return { kind: 'accept', line };
  }

  /** C-o: the line runs, and once it has, the entry after the one it was comes back. */
  private operateAndGetNext(): EditorResult {
    const history = this.history();

    if (history && this.position < this.entries.length) this.nextEntry = history.base + this.position + 1;

    return this.accept();
  }

  private charBefore(): string {
    const before = this.line.slice(0, this.point);
    const last = before.codePointAt(before.length - 1) ?? 0;

    return before.length >= 2 && last >= 0xdc00 && last <= 0xdfff ? before.slice(-2) : before.slice(-1);
  }

  private charAt(): string {
    const cp = this.line.codePointAt(this.point);

    return cp === undefined ? '' : String.fromCodePoint(cp);
  }

  private insert(text: string): EditorResult {
    this.line = this.line.slice(0, this.point) + text + this.line.slice(this.point);
    this.point += text.length;

    return { kind: 'edit' };
  }

  private deleteForward(): EditorResult {
    if (this.point >= this.line.length) return { kind: 'bell' };

    this.cut(this.point, this.point + this.charAt().length);

    return { kind: 'edit' };
  }

  /** Take out [from, to), the cursor at `from`. */
  private cut(from: number, to: number): string {
    const text = this.line.slice(from, to);

    this.line = this.line.slice(0, from) + this.line.slice(to);
    this.point = from;

    return text;
  }

  /** A kill: what goes is kept for C-y, joined to the last kill when that was the key before. */
  private kill(from: number, to: number, append: boolean, forward: boolean): EditorResult {
    if (from >= to) return { kind: 'edit' };

    const text = this.cut(from, to);

    this.killed = append ? (forward ? this.killed + text : text + this.killed) : text;
    this.lastKilled = true;

    return { kind: 'edit' };
  }

  private transpose(): EditorResult {
    if (this.line.length < 2 || this.point === 0) return { kind: 'bell' };

    // At the end the last two change places; elsewhere the one before the cursor and the one under it
    const at = this.point >= this.line.length ? this.line.length - 1 : this.point;
    const chars = [...this.line];
    const index = [...this.line.slice(0, at)].length;

    [chars[index - 1], chars[index]] = [chars[index], chars[index - 1]];
    this.line = chars.join('');
    this.point = Math.min(this.line.length, at + 1);

    return { kind: 'edit' };
  }

  /** Where the word before the cursor starts: past what is no word, then the word. */
  private wordStart(): number {
    let i = this.point;

    while (i > 0 && !isWordChar(this.line[i - 1])) i--;
    while (i > 0 && isWordChar(this.line[i - 1])) i--;

    return i;
  }

  /** Where the word after the cursor ends. */
  private wordEnd(): number {
    let i = this.point;

    while (i < this.line.length && !isWordChar(this.line[i])) i++;
    while (i < this.line.length && isWordChar(this.line[i])) i++;

    return i;
  }

  /** C-w's start: back over blanks, then to the blank before the word. */
  private whitespaceStart(): number {
    let i = this.point;

    while (i > 0 && /\s/.test(this.line[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.line[i - 1])) i--;

    return i;
  }

  /** An entry `by` away, the line being typed kept while an entry is shown. */
  private step(by: number): EditorResult {
    return this.moveTo(this.position + by);
  }

  private moveTo(position: number): EditorResult {
    const entries = this.entries;

    if (position < 0 || position > entries.length || position === this.position) return { kind: 'bell' };

    if (this.position >= entries.length) this.typed = this.line;

    this.position = position;
    this.setLine(position >= entries.length ? this.typed : entries[position]);

    return { kind: 'edit' };
  }

  /** M-. : the last word of the entry before. */
  private yankLastArg(): EditorResult {
    const entries = this.entries;
    const last = entries[entries.length - 1];

    if (last === undefined) return { kind: 'bell' };

    const words = last.trim().split(/\s+/);

    return this.insert(words[words.length - 1] ?? '');
  }

  private beginSearch(reverse: boolean): EditorResult {
    this.search = {
      query: '',
      reverse,
      failing: false,
      savedLine: this.line,
      savedPoint: this.point,
      savedPosition: this.position,
      position: this.position,
      at: this.point,
    };

    return { kind: 'edit' };
  }

  /**
   * A key while searching: one that searches, or one that ends the search —
   * C-g back where it began, Enter running what was found, and any other key
   * leaving the line found and then doing what it does.
   */
  private searchKey(key: string): EditorResult | undefined {
    const search = this.search!;

    switch (key) {
      case '\x12':
      case '\x13': {
        search.reverse = key === '\x12';
        if (search.query === '') search.query = this.lastQuery;
        return this.findMatch(true);
      }
      case '\x7f':
      case '\x08':
        if (search.query === '') return { kind: 'bell' };
        search.query = search.query.slice(0, -1);
        search.position = search.savedPosition;
        search.at = search.savedPoint;
        search.failing = false;
        if (search.query === '') {
          this.position = search.savedPosition;
          this.setLine(search.savedLine, search.savedPoint);
          return { kind: 'edit' };
        }
        return this.findMatch(false);
      case '\x07':
        this.position = search.savedPosition;
        this.setLine(search.savedLine, search.savedPoint);
        this.search = undefined;
        return { kind: 'edit' };
      case '\x1b':
        this.endSearch();
        return { kind: 'edit' };
      default:
        break;
    }

    // A character goes on the string searched for
    if (!key.startsWith('\x1b') && !(key.length === 1 && key.charCodeAt(0) < 0x20) && key !== '\x7f') {
      search.query += key;
      return this.findMatch(false);
    }

    this.endSearch();

    return undefined;
  }

  private endSearch(): void {
    if (this.search && this.search.query !== '') this.lastQuery = this.search.query;

    this.search = undefined;
  }

  /**
   * The next entry holding the string, from where the search stands — from the
   * match itself for a longer string, past it for C-r again — in its direction.
   */
  private findMatch(next: boolean): EditorResult {
    const search = this.search!;
    const entries = this.entries;
    const query = search.query;

    if (query === '') return { kind: 'edit' };

    const lineAt = (position: number) => position >= entries.length ? (position === search.savedPosition ? search.savedLine : this.typed) : entries[position];
    let position = search.position;
    let at = search.at;

    for (let tries = 0; tries <= entries.length + 1; tries++) {
      const text = lineAt(position);
      const found = search.reverse ? text.lastIndexOf(query, next ? at - 1 : Math.min(at, text.length - query.length)) : text.indexOf(query, next ? at + 1 : at);

      if (found >= 0 && (tries > 0 || !next || found !== at)) {
        search.position = position;
        search.at = found;
        search.failing = false;
        this.position = position;
        this.setLine(text, found);
        return { kind: 'edit' };
      }

      position += search.reverse ? -1 : 1;
      if (position < 0 || position > entries.length) break;
      at = search.reverse ? lineAt(position).length : -1;
      next = false;
    }

    search.failing = true;

    return { kind: 'bell' };
  }
}
