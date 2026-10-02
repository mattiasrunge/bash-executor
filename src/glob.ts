/**
 * Pathname expansion, as bash's glob does it, over directory listings the
 * host gives (`ShellIf.readDirectory`).
 *
 * A word's glob characters glob only where they were not quoted: `"$dir"/*`
 * lists the directory whatever `$dir` holds, and `$pat` with pat='*.log' globs,
 * since what an unquoted expansion gives is a pattern. `globPatterns` makes
 * each field of a word into a pattern in which the quoted characters are
 * backslash-quoted; `expandPattern` matches one against the tree.
 */

import { utils } from '@ein/bash-parser';
import { globToRegExp } from './pattern.ts';
import type { DirectoryEntry } from './types.ts';

/**
 * Characters that mean something in a pattern, and are quoted where the word
 * quoted them: `:`, `=` and `.` too, which open a class in a bracket expression,
 * `[":alpha:"]` being none.
 */
const PATTERN_CHARS = '\\*?[]()|@!+:=.';

/** The characters field splitting counts as whitespace, as the parser's does. */
const WHITESPACE = ' \t\n\r\v\f';

type Char = { c: string; quoted: boolean; split?: 'blank' | 'delimiter' | 'field' };

/**
 * The fields of a word as patterns: its text with the expansions in it (at
 * `ranges`) and its quotes still there, split where an unquoted expansion's
 * IFS characters split it, with every character the word quoted quoted with
 * a backslash. The same fields the word's quote removal gives, one pattern
 * each — or null when they could not be told apart the same way.
 */
export function globPatterns(text: string, ranges: { start: number; end: number }[], ifs: string): Char[][] | null {
  const chars: Char[] = [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let next = 0;
  let single = false;
  let double = false;

  for (let i = 0; i < text.length; i++) {
    const range = sorted[next];

    if (range && i === range.start) {
      const quoted = single || double;

      for (const c of text.slice(range.start, range.end)) {
        if (c === utils.FIELD_MARKER) chars.push({ c, quoted, split: 'field' });
        else if (!quoted && ifs.includes(c)) chars.push({ c, quoted, split: WHITESPACE.includes(c) ? 'blank' : 'delimiter' });
        else chars.push({ c, quoted });
      }

      i = range.end - 1;
      next++;
      continue;
    }

    const c = text[i];

    if (single) {
      if (c === "'") single = false;
      else chars.push({ c, quoted: true });
    } else if (double) {
      if (c === '"') {
        double = false;
      } else if (c === '\\' && i + 1 < text.length && '$`"\\\n'.includes(text[i + 1])) {
        if (text[i + 1] !== '\n') chars.push({ c: text[i + 1], quoted: true });
        i++;
      } else {
        chars.push({ c, quoted: true });
      }
    } else if (c === "'") {
      single = true;
    } else if (c === '"') {
      double = true;
    } else if (c === '\\') {
      if (i + 1 < text.length) chars.push({ c: text[++i], quoted: true });
    } else {
      chars.push({ c, quoted: false });
    }
  }

  // Unclosed quotes: the word is not what this reads it as
  if (single || double) return null;

  return splitChars(chars);
}

/** Field splitting over characters, as `splitByIfs` does it over text: a field marker always splits. */
function splitChars(chars: Char[]): Char[][] {
  const fields: Char[][] = [];
  let current: Char[] = [];
  // Whether the field has anything quoted, which keeps an empty one
  let quoted = false;
  let i = 0;

  while (i < chars.length && chars[i].split === 'blank') i++;

  while (i < chars.length) {
    const ch = chars[i];

    if (ch.split === 'field') {
      fields.push(current);
      current = [];
      quoted = false;
      i++;
      continue;
    }

    if (!ch.split) {
      current.push(ch);
      quoted ||= ch.quoted;
      i++;
      continue;
    }

    // One delimiter is `blank* separator? blank*`
    let sawDelimiter = ch.split === 'delimiter';
    let end = i + 1;

    while (end < chars.length && (chars[end].split === 'blank' || (!sawDelimiter && chars[end].split === 'delimiter'))) {
      sawDelimiter ||= chars[end].split === 'delimiter';
      end++;
    }

    if (end >= chars.length && !sawDelimiter) break;

    fields.push(current);
    current = [];
    quoted = false;
    i = end;

    if (i >= chars.length) return fields;
  }

  if (current.length > 0 || quoted) fields.push(current);

  return fields;
}

/**
 * What a quoted `/` is in a pattern: a separator still, as bash's is, but one
 * that ends no bracket expression — `[qwe\/qwe]` is a pattern, matching nothing.
 */
const QUOTED_SLASH = '\uFDDB';

/** A field as a pattern: what the word quoted, backslash-quoted. */
export function patternOf(field: Char[]): string {
  return field.map(({ c, quoted }) => quoted && c === '/' ? QUOTED_SLASH : quoted && PATTERN_CHARS.includes(c) ? `\\${c}` : c).join('');
}

/** Whether a pattern has a character that globs: `*`, `?`, a bracket expression, an extended pattern. */
export function isGlobPattern(pattern: string, extglob: boolean, pathname = false): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if (c === '\\') {
      i++;
    } else if (c === '*' || c === '?') {
      return true;
    } else if (c === '[' && closingBracket(pattern, i, pathname) !== -1) {
      return true;
    } else if (extglob && '@!+'.includes(c) && pattern[i + 1] === '(') {
      return true;
    }
  }

  return false;
}

/** The `]` ending a bracket expression that opens at `open`, or -1; in a pathname one before a `/`. */
function closingBracket(pattern: string, open: number, pathname = false): number {
  let i = open + 1;

  if (pattern[i] === '!' || pattern[i] === '^') i++;
  if (pattern[i] === ']') i++;

  for (; i < pattern.length; i++) {
    if (pattern[i] === '\\') i++;
    // A bracket expression stays in its pathname segment: `[a/b]` is no pattern
    else if (pathname && pattern[i] === '/') return -1;
    else if (pattern[i] === '[' && ':.='.includes(pattern[i + 1] ?? '')) {
      const close = pattern.indexOf(`${pattern[i + 1]}]`, i + 2);

      if (close === -1) return -1;
      i = close + 1;
    } else if (pattern[i] === ']') return i;
  }

  return -1;
}

export type GlobOptions = {
  /** `.` files match without a leading `.` in the pattern */
  dotglob: boolean;
  nocaseglob: boolean;
  /** `**` alone in a segment matches any depth of directories */
  globstar: boolean;
  extglob: boolean;
  /** GLOBIGNORE's patterns: a match that is one of them is left out */
  ignore: string[];
  /** Order the matches by bytes, as the C locale does, rather than as the locale collates them */
  bytewise: boolean;
  /** `.` and `..` match no pattern, as bash 5.2 has it by default; off, `.*` matches them */
  globskipdots?: boolean;
};

type Found = { path: string; directory?: boolean; link?: boolean };

/**
 * The paths a pattern matches, as it spells them — `../b*` gives `../bin` —
 * in order; none when it matches nothing, which the caller makes the word
 * itself, or nothing under `nullglob`.
 */
export async function expandPattern(
  pattern: string,
  list: (dir: string) => Promise<DirectoryEntry[] | null>,
  opts: GlobOptions,
  stat?: (path: string) => Promise<{ directory: boolean } | null>,
): Promise<string[]> {
  // A quoted `/` closed no bracket expression; past that it is a `/` like any
  pattern = pattern.replaceAll(QUOTED_SLASH, '/');

  const absolute = pattern.startsWith('/');
  const trailingSlash = pattern.length > 1 && pattern.endsWith('/') && !pattern.endsWith('\\/');
  const written = splitSegments(pattern).filter((segment) => segment !== '');
  // A run of `**` is one, as bash has it: `**/**` is `**`
  const segments = written.filter((segment, i) => !(opts.globstar && segment === '**' && written[i - 1] === '**'));
  // …and the one that stands for a run is no written-out segment for what follows it
  const collapsed = opts.globstar && written.some((segment, i) => segment === '**' && written[i - 1] === '**');
  const dotglob = opts.dotglob || opts.ignore.length > 0;
  let found: Found[] = [{ path: absolute ? '/' : '', directory: true }];
  // The literal segments after the last glob one, which nothing has listed yet
  let unchecked = false;
  // Whether a segment was matched against a listing, which found what is there
  let listed = false;

  const join = (base: string, name: string) => base === '' ? name : base.endsWith('/') ? base + name : `${base}/${name}`;
  const entries = async (base: string) => await list(base === '' ? '.' : base).catch(() => null) ?? [];

  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    // Whether every segment before this one was written out, no pattern among them
    const literalPrefix = !collapsed && segments.slice(0, index).every((s) => !isGlobPattern(s, opts.extglob) && !(opts.globstar && s === '**'));

    if (opts.globstar && segment === '**') {
      const next: Found[] = [];

      if (unchecked) {
        found = await verify(found);
        unchecked = false;
      }

      for (const base of found) {
        if (base.directory === false) continue;

        // No directories at all, then every one below: at the end, every file as
        // well, and the directory it starts from — `a/**` is `a/` and all in it,
        // bash's slash there only when all before it was written out
        if (!last || trailingSlash) next.push(base);
        else if (base.path !== '') next.push({ path: literalPrefix && !base.path.endsWith('/') ? `${base.path}/` : base.path, directory: true });

        // A link to a directory matches `**/`, but what is inside it is not looked for
        next.push(...(await descend(base.path, !last || trailingSlash)).filter((f) => last || !f.link));
      }

      found = next.filter((f) => f.path !== '' || !last);
      unchecked = false;
      listed = true;
      continue;
    }

    if (!isGlobPattern(segment, opts.extglob)) {
      const name = segment.replace(/\\(.?)/g, '$1');

      found = found.map((base) => ({ path: join(base.path, name) }));
      unchecked ||= index > 0 && found.length > 0 && segments.slice(0, index).some((s) => isGlobPattern(s, opts.extglob) || (opts.globstar && s === '**'));
      continue;
    }

    if (unchecked) {
      found = await verify(found);
      unchecked = false;
    }

    const written = opts.nocaseglob ? segment.toLowerCase() : segment;
    const regex = globToRegExp(written);
    // A leading `.` has to be matched by one the pattern spells, `.` and `..`'s
    // under dotglob too, as bash's FNM_PERIOD and FNM_DOTDOT have it
    const period = periodRegExp(regex);
    const dots = !opts.globskipdots && opts.ignore.length === 0 ? [{ name: '.', directory: true }, { name: '..', directory: true }] : [];
    const next: Found[] = [];

    listed = true;

    for (const base of found) {
      if (base.directory === false) continue;

      for (const entry of [...dots, ...await entries(base.path)]) {
        const name = opts.nocaseglob ? entry.name.toLowerCase() : entry.name;
        const dotOrDotdot = name === '.' || name === '..';

        if (name.startsWith('.') && skipName(segment, name, { ...opts, dotglob })) continue;
        if (!((name.startsWith('.') && (!dotglob || dotOrDotdot)) ? matchesPeriod(regex, period, written, name) : regex.test(name))) continue;
        if (!last && !entry.directory) continue;

        next.push({ path: join(base.path, entry.name), directory: entry.directory });
      }
    }

    found = next;
  }

  // A pattern that is one only as a whole, `[a\/b]`, matches what is there
  if (unchecked || !listed) found = await verify(found);

  // `*/` matches directories only, and keeps its slash
  if (trailingSlash) {
    found = found.filter((f) => f.directory).map((f) => ({ path: f.path.endsWith('/') ? f.path : `${f.path}/` }));
  }

  let paths = found.map((f) => f.path).filter((path) => path !== '');

  if (opts.ignore.length > 0) {
    const ignored = opts.ignore.map((glob) => globToRegExp(glob));

    paths = paths.filter((path) => !ignored.some((regex) => regex.test(path)));
  }

  return paths.sort(opts.bytewise ? compareBytes : collate);

  /** Every directory below `base`, and every file too unless `directoriesOnly`: a `.` one only under dotglob. */
  async function descend(base: string, directoriesOnly: boolean): Promise<Found[]> {
    const out: Found[] = [];

    for (const entry of await entries(base)) {
      if (entry.name.startsWith('.') && !dotglob) continue;

      const path = join(base, entry.name);

      if (entry.directory) {
        out.push({ path, directory: true, link: entry.link });
        // A link to a directory is listed, not gone into
        if (!entry.link) out.push(...await descend(path, directoriesOnly));
      } else if (!directoriesOnly) {
        out.push({ path, directory: false });
      }
    }

    return out;
  }

  /**
   * The paths that are there, and which of them are directories: by asking for
   * each, which a directory that may be searched but not read answers too,
   * `foo/bar` in a `chmod 311 foo` — or else by their parent's listing.
   */
  async function verify(paths: Found[]): Promise<Found[]> {
    const out: Found[] = [];

    for (const found of paths) {
      if (stat) {
        const there = await stat(found.path === '' ? '.' : found.path).catch(() => null);

        if (there) out.push({ path: found.path, directory: there.directory });
        continue;
      }

      const slash = found.path.lastIndexOf('/');
      const parent = slash === -1 ? '' : slash === 0 ? '/' : found.path.slice(0, slash);
      const name = found.path.slice(slash + 1);
      const entry = (await entries(parent)).find((e) => e.name === name);

      if (entry) out.push({ path: found.path, directory: entry.directory });
    }

    return out;
  }
}

/**
 * A pattern's `/`-separated segments; a quoted `/` is still a separator, as in
 * bash, its backslash left at the end of the segment before: nothing to a
 * name written out, `tmp\/a`, and to a pattern a character no name ends in.
 */
function splitSegments(pattern: string): string[] {
  const segments: string[] = [];
  let current = '';

  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\' && pattern[i + 1] === '/') {
      segments.push(`${current}\\`);
      current = '';
      i++;
    } else if (pattern[i] === '\\' && i + 1 < pattern.length) {
      current += pattern[i] + pattern[++i];
    } else if (pattern[i] === '/') {
      segments.push(current);
      current = '';
    } else {
      current += pattern[i];
    }
  }

  return [...segments, current];
}

/** What stands for a name's leading `.` while it is matched, which only a `.` the pattern spells matches. */
const PERIOD = '\uFDD9';

/**
 * A pattern's regular expression as FNM_PERIOD matches a name's leading `.`
 * with it: no `?`, `*` or bracket expression takes it, a written `.` does. The
 * name is tried with that `.` as PERIOD. Null for one with `!(…)`, which is
 * matched by trying, and takes no such name at all, as in bash.
 */
function periodRegExp(regex: RegExp): RegExp | null {
  if (regex.constructor !== RegExp) return null;

  // Any character, `[\s\S]`, stands aside while the rest is read
  const any = '\uFDDA';
  const source = regex.source.replaceAll('[\\s\\S]', any);
  let out = '';
  let inClass = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];

    if (c === '\\') {
      // `\.` outside a class is a written `.`
      out += !inClass && source[i + 1] === '.' ? `[.${PERIOD}]` : c + source[i + 1];
      i++;
    } else if (!inClass && c === '[') {
      inClass = true;
      // A negated class takes everything but what it names: not the period either
      out += source[i + 1] === '^' ? `[^${PERIOD}` : c;
      if (source[i + 1] === '^') i++;
    } else if (inClass && c === ']') {
      inClass = false;
      out += c;
    } else {
      out += !inClass && c === '.' ? `[^${PERIOD}]` : c;
    }
  }

  return new RegExp(out.replaceAll(any, `[^${PERIOD}]`), regex.flags);
}

/**
 * A name with a leading `.` matched as FNM_PERIOD has it. A pattern with `!(…)`
 * takes one only by a `.` written first, `.!(x)`: its `!(…)` takes none.
 */
function matchesPeriod(regex: RegExp, period: RegExp | null, pattern: string, name: string): boolean {
  if (period) return period.test(PERIOD + name.slice(1));

  if (pattern[0] === '.' || pattern.startsWith('\\.')) return regex.test(name);

  // A group first, `@(*|.!(x))`: each of its alternatives tried in its place on its own
  const close = /^[?*+@]\(/.test(pattern) ? groupEnd(pattern, 1) : -1;

  if (close === -1) return false;

  const rest = pattern.slice(close + 1);
  const tries = splitAlternatives(pattern.slice(2, close)).map((alternative) => alternative + rest);

  if (pattern[0] === '?' || pattern[0] === '*') tries.push(rest);

  return tries.some((attempt) => {
    const attemptRegex = globToRegExp(attempt);

    return matchesPeriod(attemptRegex, periodRegExp(attemptRegex), attempt, name);
  });
}

/**
 * Whether a `.` name is passed over for a pattern, as bash's skipname has it:
 * `.` and `..` under globskipdots, and unless the pattern starts with a `.`,
 * them too under dotglob and any `.` name without it. An extended pattern
 * looks at its alternatives: `@(.?)` and `*(bar).foo` may take a `.` name.
 */
function skipName(pattern: string, name: string, opts: GlobOptions): boolean {
  if (opts.extglob && /^[?*+@!]\(/.test(pattern)) return extglobSkipName(pattern, name, opts);

  const dotOrDotdot = name === '.' || name === '..';
  const written = pattern[0] === '.' || (pattern[0] === '\\' && pattern[1] === '.');

  if (opts.globskipdots && dotOrDotdot) return true;
  if (opts.dotglob && !written && dotOrDotdot) return true;

  return !opts.dotglob && name[0] === '.' && !written;
}

/** skipname for `@(a|b)rest` and its kin, as bash's extglob_skipname. */
function extglobSkipName(pattern: string, name: string, opts: GlobOptions): boolean {
  const wild = pattern[0] === '*' || pattern[0] === '?';
  const close = groupEnd(pattern, 1);

  if (close === -1) return false;

  const alternatives = splitAlternatives(pattern.slice(2, close));
  const rest = pattern.slice(close + 1);

  if (rest === '' && alternatives.length === 1) return skipName(alternatives[0], name, opts);

  for (const alternative of alternatives) {
    if (!skipName(alternative, name, opts)) return false;
  }

  if (rest === '') return true;

  // What can match nothing leaves the name to the rest: `*(bar).foo`
  return wild ? skipName(rest, name, opts) : true;
}

/** The `)` closing the `(` at `open`, or -1. */
function groupEnd(pattern: string, open: number): number {
  let depth = 0;

  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '\\') i++;
    else if (pattern[i] === '(') depth++;
    else if (pattern[i] === ')' && --depth === 0) return i;
  }

  return -1;
}

/** A group's alternatives, split at its own `|`s. */
function splitAlternatives(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === '|' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }

  return [...out, text.slice(start)];
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A locale's order, as glibc's has it: punctuation weighs nothing, `.dot` sorts among the d's. */
const collator = new Intl.Collator(undefined, { ignorePunctuation: true });

function collate(a: string, b: string): number {
  return collator.compare(a, b) || compareBytes(a, b);
}
