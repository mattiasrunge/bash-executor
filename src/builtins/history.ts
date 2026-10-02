/**
 * The history and fc builtins, as bash's history.def and fc.def have them,
 * and what turning `set -o history` on does: read the history file.
 *
 * The list is the context's (`getHistory()`); the file is read and written
 * through the host, named by HISTFILE or the argument.
 */

import { History, historyExpand, historyFileText, historySettings, parseHistoryFile } from '../history.ts';
import type { ExecContextIf, ShellIf } from '../types.ts';
import type { BuiltinHandler, BuiltinResult, BuiltinServices } from './types.ts';

const HISTORY_USAGE = 'history: usage: history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]\n';
const FC_USAGE = 'fc: usage: fc [-e ename] [-lnr] [first] [last] or fc -s [pat=rep] [command]\n';

/** bash's legal_number: an integer, blanks around it allowed. */
const legalNumber = (text: string): number | undefined => /^[ \t\n]*[-+]?\d+[ \t\n]*$/.test(text) ? Number(text.trim()) : undefined;

/** The history the shell keeps, made the first time it is asked for. */
function historyOf(ctx: ExecContextIf): History {
  return ctx.getHistory?.() ?? new History();
}

const settingsOf = (ctx: ExecContextIf) => historySettings((name) => ctx.getParam(name));

/** Write `text` to `path`, or add it to the end. */
async function writeFile(ctx: ExecContextIf, shell: ShellIf, path: string, text: string, append: boolean): Promise<void> {
  const pipe = await shell.pipeOpen();
  const done = shell.pipeToFile(ctx, pipe, path, append);

  try {
    await shell.pipeWrite(pipe, text);
  } finally {
    await shell.pipeClose(pipe);
  }

  await done;
}

/** The text of a file, or undefined when there is none to read. */
async function readFile(ctx: ExecContextIf, shell: ShellIf, path: string): Promise<string | undefined> {
  if (!shell.readFile) return undefined;
  if (shell.testPath && !await shell.testPath(ctx, path, 'EXISTS')) return undefined;

  try {
    return await shell.readFile(ctx, path);
  } catch {
    return undefined;
  }
}

/** read_history_range: the file's entries from line `from` on added to the list. */
async function readHistory(ctx: ExecContextIf, shell: ShellIf, history: History, path: string, from = 0): Promise<boolean> {
  const text = await readFile(ctx, shell, path);

  if (text === undefined) return false;

  const { entries, lines } = parseHistoryFile(text);

  for (const entry of entries.slice(from)) history.add(entry.line, entry.time);
  history.linesInFile = lines;

  return true;
}

/**
 * load_history: what `set -o history` does first — HISTSIZE and HISTFILESIZE
 * given their defaults, the history file cut to HISTFILESIZE lines, as bash's
 * sv_histsize cuts it, and read.
 */
export async function loadHistory(ctx: ExecContextIf, shell: ShellIf): Promise<void> {
  if (ctx.getParam('HISTSIZE') === undefined) ctx.setParams({ HISTSIZE: '500' });
  if (ctx.getParam('HISTFILESIZE') === undefined) ctx.setParams({ HISTFILESIZE: ctx.getParam('HISTSIZE')! });

  const file = ctx.getParam('HISTFILE');

  if (!file) return;

  await truncateHistoryFile(ctx, shell, file);
  await readHistory(ctx, shell, historyOf(ctx), file);
}

/** history_truncate_file: the file cut to its last HISTFILESIZE lines. */
export async function truncateHistoryFile(ctx: ExecContextIf, shell: ShellIf, file: string): Promise<void> {
  const size = ctx.getParam('HISTFILESIZE') ?? '';

  if (!/^\d+$/.test(size)) return;

  const text = await readFile(ctx, shell, file);

  if (text === undefined) return;

  const { entries, lines } = parseHistoryFile(text);

  if (lines <= Number(size)) return;

  // Timestamps stay with their lines, and only where the file had them
  const kept = entries.slice(Math.max(0, entries.length - Number(size)));

  await writeFile(ctx, shell, file, historyFileText(kept, /^#\d+$/m.test(text)), false);
}

/**
 * maybe_append_history, `history -a`: the lines this session added since the
 * last time, added to the end of the file.
 */
export async function appendHistory(ctx: ExecContextIf, shell: ShellIf, file: string | undefined = ctx.getParam('HISTFILE')): Promise<void> {
  const history = historyOf(ctx);

  if (file && history.linesThisSession > 0) {
    const count = Math.min(history.linesThisSession, history.length);
    const timestamps = ctx.getParam('HISTTIMEFORMAT') !== undefined;

    await writeFile(ctx, shell, file, historyFileText(history.entries.slice(history.length - count), timestamps), true);
    history.linesInFile += count;
  }

  history.linesThisSession = 0;
}

/**
 * maybe_save_shell_history: what a shell that ends does with its history —
 * written to HISTFILE, the lines this session added appended under
 * `shopt -s histappend`, and the file cut to HISTFILESIZE.
 */
export async function saveHistory(ctx: ExecContextIf, shell: ShellIf): Promise<void> {
  const file = ctx.getParam('HISTFILE');
  const history = historyOf(ctx);

  if (!file || !ctx.getShellOption('history')) return;

  const timestamps = ctx.getParam('HISTTIMEFORMAT') !== undefined;

  if (ctx.getShellOption('histappend')) {
    await appendHistory(ctx, shell, file);
  } else {
    await writeFile(ctx, shell, file, historyFileText(history.entries, timestamps), false);
    history.linesThisSession = 0;
  }

  await truncateHistoryFile(ctx, shell, file);
}

/**
 * Set a shell option, as `set` and `shopt -o` do: turning `history` on reads
 * the history file, unless this session has added lines already.
 */
export async function setShellOption(ctx: ExecContextIf, shell: ShellIf, name: string, on: boolean): Promise<void> {
  const before = ctx.getShellOption(name);

  ctx.setShellOption(name, on);

  if (name === 'history' && on && !before && historyOf(ctx).linesThisSession === 0) await loadHistory(ctx, shell);
}

/** A time as HISTTIMEFORMAT says to show it: strftime's common conversions. */
function formatTime(format: string, seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const conversions: Record<string, () => string> = {
    Y: () => String(date.getFullYear()),
    y: () => pad(date.getFullYear() % 100),
    m: () => pad(date.getMonth() + 1),
    d: () => pad(date.getDate()),
    e: () => String(date.getDate()).padStart(2, ' '),
    H: () => pad(date.getHours()),
    M: () => pad(date.getMinutes()),
    S: () => pad(date.getSeconds()),
    a: () => days[date.getDay()],
    b: () => months[date.getMonth()],
    F: () => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    T: () => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    s: () => String(seconds),
    '%': () => '%',
  };

  return format.replace(/%(.)/g, (whole, c: string) => conversions[c]?.() ?? whole);
}

/**
 * history [-c] [-d offset] [n] | -anrw [file] | -ps arg…: list the history,
 * numbered; change it; read and write the history file.
 */
export const historyBuiltin: BuiltinHandler = async (ctx: ExecContextIf, args: string[], shell: ShellIf): Promise<BuiltinResult> => {
  const history = historyOf(ctx);
  const flags = new Set<string>();
  let deleteArg: string | undefined;
  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      i++;
      break;
    }

    if (!arg.startsWith('-') || arg === '-' || /^-\d/.test(arg)) break;

    for (let j = 1; j < arg.length; j++) {
      const c = arg[j];

      if (c === 'd') {
        deleteArg = arg.slice(j + 1) || args[++i];

        if (deleteArg === undefined) return { code: 2, stderr: `history: -d: option requires an argument\n${HISTORY_USAGE}` };
        flags.add('d');
        break;
      }

      if (!'acnpsrw'.includes(c)) return { code: 2, stderr: `history: -${c}: invalid option\n${HISTORY_USAGE}` };
      flags.add(c);
    }
  }

  const list = args.slice(i);
  const files = ['a', 'r', 'w', 'n'].filter((f) => flags.has(f));

  if (files.length > 1) return { code: 1, stderr: 'history: cannot use more than one of -anrw\n' };

  if (flags.has('c')) {
    history.clear();
    if (list.length === 0) return { code: 0 };
  }

  if (flags.has('s')) {
    if (list.length > 0) pushHistory(ctx, history, list.join(' '));
    return { code: 0 };
  }

  if (flags.has('p')) {
    // The `history -p` line itself is not to be expanded against
    if (!history.lastLinePushed && history.lastLineAdded && !history.removeLast()) return { code: 1 };

    let stdout = '';
    let stderr = '';
    let code = 0;

    for (const word of list) {
      const result = historyExpand(word, history, { settings: settingsOf(ctx), posix: ctx.getShellOption('posix'), extglob: ctx.getShellOption('extglob') });

      if (result.status < 0) {
        stderr += `history: ${word}: history expansion failed\n`;
        code = 1;
      } else {
        stdout += `${result.text}\n`;
      }
    }

    return { code, stdout: stdout || undefined, stderr: stderr || undefined };
  }

  if (deleteArg !== undefined) return deleteEntries(history, deleteArg);

  if (files.length === 0) {
    let limit = -1;

    if (list.length > 0) {
      const n = legalNumber(list[0]);

      if (n === undefined) return { code: 1, stderr: `history: ${list[0]}: numeric argument required\n` };
      if (list.length > 1) return { code: 1, stderr: 'history: too many arguments\n' };
      limit = Math.abs(n);
    }

    const format = ctx.getParam('HISTTIMEFORMAT');
    const first = limit >= 0 && limit < history.length ? history.length - limit : 0;
    let stdout = '';

    for (let n = first; n < history.length; n++) {
      const entry = history.entries[n];
      const time = format ? formatTime(format, entry.time) : '';

      stdout += `${String(n + history.base).padStart(5)}  ${time}${entry.line}\n`;
    }

    return { code: 0, stdout: stdout || undefined };
  }

  const file = list[0] ?? ctx.getParam('HISTFILE');

  // No file to read or write: nothing to do, where readline would fall back on ~/.history
  if (!file) return { code: 0 };

  const timestamps = ctx.getParam('HISTTIMEFORMAT') !== undefined;

  try {
    if (flags.has('a')) {
      // maybe_append_history: this session's lines, at most as many as the list holds
      await appendHistory(ctx, shell, file);
    } else if (flags.has('w')) {
      await writeFile(ctx, shell, file, historyFileText(history.entries, timestamps), false);
      history.linesInFile = history.length;
    } else if (flags.has('r')) {
      if (!await readHistory(ctx, shell, history, file)) return { code: 1 };
    } else if (flags.has('n')) {
      const before = history.linesInFile;
      const base = history.base;

      if (!await readHistory(ctx, shell, history, file, before)) return { code: 1 };
      history.linesThisSession += history.linesInFile - before + history.base - base;
    }
  } catch {
    return { code: 1 };
  }

  return { code: 0 };
};

/** push_history: `history -s` — its own line taken off, the words added as one entry. */
function pushHistory(ctx: ExecContextIf, history: History, line: string): void {
  if (
    ctx.getShellOption('history') && !history.lastLinePushed &&
    (history.lastLineAdded || (history.commandLineCount > 0 && history.firstLineSaved && ctx.getShellOption('cmdhist'))) &&
    !history.removeLast()
  ) {
    return;
  }

  history.checkAdd(line, settingsOf(ctx), true);
  history.lastLinePushed = true;
}

/** history -d offset | start-end: the entries numbered so taken off, a negative number counted from the end. */
function deleteEntries(history: History, arg: string): BuiltinResult {
  const outOfRange = (text: string): BuiltinResult => ({ code: 1, stderr: `history: ${text}: history position out of range\n` });
  const dash = arg.indexOf('-', arg[0] === '-' ? 1 : 0);

  if (dash !== -1) {
    const startText = arg.slice(0, dash);
    const endText = arg.slice(dash + 1);
    let start = legalNumber(startText);
    let end = legalNumber(endText);

    if (start === undefined || end === undefined) return outOfRange(arg);

    if (startText[0] === '-' && start < 0) start += history.length;
    else if (start > 0) start -= history.base;
    if (start < 0 || start >= history.length) return outOfRange(startText);

    if (endText[0] === '-' && end < 0) end += history.length;
    else if (end > 0) end -= history.base;
    if (end < 0 || end >= history.length) return outOfRange(endText);

    return { code: history.removeRange(start, end) ? 0 : 1 };
  }

  const offset = legalNumber(arg);

  if (offset === undefined) return outOfRange(arg);

  let n: number;

  if (arg[0] === '-' && offset < 0) {
    const index = history.length + offset;

    if (index < 0) return outOfRange(arg);
    n = index + history.base;
  } else if (offset < history.base || offset >= history.base + history.length) {
    return outOfRange(arg);
  } else {
    n = offset;
  }

  return { code: history.remove(n - history.base) ? 0 : 1 };
}

const HIST_INVALID = -1_000_000;
const HIST_NOTFOUND = -1_000_001;

/**
 * fc_gethnum: the index in the list a `first` or `last` names — a number,
 * negative counting back from the last command, or the start of a command.
 */
function entryIndex(spec: string | undefined, history: History, rh: boolean, listing: boolean, first: boolean): number {
  const count = history.length;
  let last = count - (rh ? 1 : 0) - (history.lastLineAdded ? 1 : 0);

  if (last === count && history.entries[last] === undefined) {
    while (last >= 0 && history.entries[last] === undefined) last--;
  }

  if (last < 0) return -1;

  if (spec === undefined) return last;

  let realLast = count;

  while (history.entries[realLast] === undefined && realLast > 0) realLast--;

  let text = spec;
  let sign = 1;

  if (text[0] === '-') {
    sign = -1;
    text = text.slice(1);
  }

  if (/^\d/.test(text)) {
    let n = Number.parseInt(text, 10) * sign;

    if (n < 0) {
      n += last + 1;
      return n < 0 ? 0 : n;
    }

    if (n === 0) return sign === -1 ? (listing ? realLast : HIST_INVALID) : last;

    n -= history.base;
    if (n < 0 || n >= last) return first ? 0 : last;

    return n;
  }

  for (let j = last; j >= 0; j--) {
    if (history.entries[j]?.line.startsWith(spec)) return j;
  }

  return HIST_NOTFOUND;
}

/** `fc -s` and `r`: each `pat=rep` replacing every `pat`, in order. */
function substitute(command: string, replacements: [string, string][]): string {
  for (const [pat, rep] of replacements) {
    if (pat !== '') command = command.replaceAll(pat, rep);
  }

  return command;
}

/**
 * fc [-e ename] [-lnr] [first] [last] | -s [pat=rep] [command]: list commands
 * from the history, edit them and run what the editor leaves, or run one
 * again with replacements made.
 */
export const fcBuiltin: BuiltinHandler = async (
  ctx: ExecContextIf,
  args: string[],
  shell: ShellIf,
  execute: (script: string, opts?: { file?: string }) => Promise<number>,
  services?: BuiltinServices,
): Promise<BuiltinResult> => {
  const history = historyOf(ctx);
  let numbering = true;
  let reverse = false;
  let listing = false;
  let run = false;
  let editor: string | undefined;
  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i];

    // A negative number is a history number, not an option
    if (arg === '--') {
      i++;
      break;
    }

    if (!arg.startsWith('-') || arg === '-' || legalNumber(arg.slice(1)) !== undefined) break;

    for (let j = 1; j < arg.length; j++) {
      const c = arg[j];

      if (c === 'e') {
        editor = arg.slice(j + 1) || args[++i];
        if (editor === undefined) return { code: 2, stderr: `fc: -e: option requires an argument\n${FC_USAGE}` };
        break;
      }

      if (c === 'n') numbering = false;
      else if (c === 'l') listing = true;
      else if (c === 'r') reverse = true;
      else if (c === 's') run = true;
      else return { code: 2, stderr: `fc: -${c}: invalid option\n${FC_USAGE}` };
    }
  }

  let list = args.slice(i);
  const rh = ctx.getShellOption('history');

  if (editor === '-') run = true;

  if (run) {
    const replacements: [string, string][] = [];

    while (list.length > 0 && list[0].includes('=')) {
      const at = list[0].indexOf('=');

      replacements.push([list[0].slice(0, at), list[0].slice(at + 1)]);
      list = list.slice(1);
    }

    const index = history.length === 0 ? -1 : entryIndex(list[0], history, rh, false, false);

    if (index < 0) return { code: 1, stderr: 'fc: no command found\n' };

    let command = substitute(history.entries[index].line, replacements);

    await shell.pipeWrite(ctx.getStderr(), `${command}\n`).catch(() => {});

    // fc_replhist: the command takes the place of the `fc -s` that ran it
    if (command.endsWith('\n')) command = command.slice(0, -1);
    if (command !== '') {
      history.removeLast();
      history.checkAdd(command, settingsOf(ctx), false);
    }

    return { code: await execute(command) };
  }

  if (history.length === 0) return { code: 0 };

  const count = history.length;
  let last = count - (rh ? 1 : 0) - (history.lastLineAdded ? 1 : 0);
  let realLast = count;

  while (history.entries[realLast] === undefined && realLast > 0) realLast--;

  if (count === last && history.entries[last] === undefined) {
    while (last >= 0 && history.entries[last] === undefined) last--;
  }

  if (last < 0) last = 0;

  let begin: number;
  let end: number;

  if (list.length > 0) {
    begin = entryIndex(list[0], history, rh, listing, true);

    if (list.length > 1) end = entryIndex(list[1], history, rh, listing, false);
    else if (begin === realLast) end = listing ? realLast : begin;
    else end = listing ? last : begin;
  } else if (listing) {
    end = last;
    begin = Math.max(end - 16 + 1, 0);
  } else {
    begin = end = last;
  }

  const rangeError = (): BuiltinResult | undefined => {
    if (begin === HIST_INVALID || end === HIST_INVALID) return { code: 1, stderr: 'fc: history specification out of range\n' };
    if (begin === HIST_NOTFOUND || end === HIST_NOTFOUND) return { code: 1, stderr: 'fc: no command found\n' };
    return undefined;
  };

  const error = rangeError();

  if (error) return error;

  if (begin < 0) begin = 0;
  if (end < 0) end = 0;

  // Not listing, the fc line itself is not kept
  if (!listing && history.lastLineAdded) {
    history.removeLast();

    if (begin === end && end === last && history.entries[last] === undefined) last = begin = --end;
    if (history.entries[last] === undefined) last--;
    if (end >= last) end = last;
    else if (begin >= last) begin = last;
  }

  if (begin < 0) begin = 0;
  if (end < 0) end = 0;

  if (end < begin) {
    [begin, end] = [end, begin];
    reverse = true;
  }

  const lines: string[] = [];

  for (let n = reverse ? end : begin; reverse ? n >= begin : n <= end; reverse ? n-- : n++) {
    const entry = history.entries[n];

    if (!entry) continue;

    if (listing) {
      const marker = ctx.getShellOption('posix') ? '\t' : '\t ';

      lines.push(`${numbering ? n + history.base : ''}${marker}${entry.line}\n`);
    } else {
      lines.push(`${entry.line}\n`);
    }
  }

  if (listing) return { code: 0, stdout: lines.join('') || undefined };

  // Edit the commands in a file, then run what the editor leaves in it
  if (!shell.tempFile || !shell.readFile) return { code: 1, stderr: 'fc: cannot open temp file\n' };

  const file = await shell.tempFile(ctx);

  try {
    await writeFile(ctx, shell, file, lines.join(''), false);

    const command = editor !== undefined ? `${editor} ${file}` : ctx.getShellOption('posix') ? `\${FCEDIT:-\${EDITOR:-ed}} ${file}` : `\${FCEDIT:-\${EDITOR:-vi}} ${file}`;

    if (await execute(command) !== 0) return { code: 1 };

    const edited = await shell.readFile(ctx, file);

    // Run as the shell's input: each line echoed as it is read and kept in the history
    return { code: services?.readInput ? await services.readInput(edited, { echo: true }) : await execute(edited) };
  } finally {
    await shell.removeTempFile?.(ctx, file);
  }
};
