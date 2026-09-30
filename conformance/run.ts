/**
 * Runs GNU bash's own test suite against bash-parser + bash-executor and
 * writes a gap report and a regression baseline.
 *
 *   deno task conformance                 run everything, compare with baseline.json
 *   deno task conformance:update          …and write baseline.json and REPORT.md
 *   … --only arith,run-quote              just these (no report, baseline updated only for them)
 *   … --tier parse                        parse every test file, nothing else
 *   … --jobs 8                            parallel test scripts (default 4)
 *   … --allow-drop                        let --update lower a score
 *   … --reference                         re-run real bash for the reference scores
 *
 * Per `run-X` script there are three scores, see README.md: `upstream` (the
 * suite's own diff against X.right), `stdout` (stdout only, real bash as the
 * oracle) and `reference` (real bash on this machine through the upstream
 * harness, to tell our failures from the environment's).
 */
import { parse } from '@ein/bash-parser';
import { dirname, fromFileUrl, join } from '@std/path';

const HERE = dirname(fromFileUrl(import.meta.url));
const ROOT = join(HERE, '..');
const CACHE = join(HERE, '.cache');
const WORK = join(CACHE, 'work');
const BASH_TS = join(HERE, 'bash-ts');
const REAL_BASH = '/bin/bash';

type Config = {
  bash: string;
  timeoutSeconds: number;
  tolerance: number;
  exclude: Record<string, string>;
  /** Tests that fail now and then for reasons of their own: a drop is said, not held against the run */
  flaky?: Record<string, string>;
};

const config: Config = JSON.parse(await Deno.readTextFile(join(HERE, 'config.json')));
const SRC = join(CACHE, `bash-${config.bash}`);
const TESTS = join(SRC, 'tests');
const HELPERS = join(CACHE, 'helpers');

type Flags = { only?: string[]; tier: 'all' | 'parse'; update: boolean; allowDrop: boolean; jobs: number; reference: boolean };

function parseFlags(args: string[]): Flags {
  const flags: Flags = { tier: 'all', update: false, allowDrop: false, jobs: 4, reference: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--only') {
      flags.only = args[++i].split(',').map((name) => name.startsWith('run-') ? name : `run-${name}`);
    } else if (arg === '--tier') {
      flags.tier = args[++i] === 'parse' ? 'parse' : 'all';
    } else if (arg === '--update') {
      flags.update = true;
    } else if (arg === '--allow-drop') {
      flags.allowDrop = true;
    } else if (arg === '--jobs') {
      flags.jobs = Number(args[++i]);
    } else if (arg === '--reference') {
      flags.reference = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return flags;
}

// ===== Processes =====

type Output = { code: number; stdout: string; stderr: string };

async function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<Output> {
  const out = await new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    clearEnv: opts.env !== undefined,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const decoder = new TextDecoder();

  return { code: out.code, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
}

/**
 * GNU timeout puts the command in a process group of its own and signals the
 * whole group, so a hung shell's children go too.
 */
function timed(cmd: string, args: string[]): [string, string[]] {
  return ['timeout', ['-k', '5', String(config.timeoutSeconds), cmd, ...args]];
}

function isTimeout(code: number): boolean {
  return code === 124 || code === 137;
}

async function pool<T, R>(items: T[], jobs: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;

      results[i] = await fn(items[i]);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));

  return results;
}

// ===== The test suite =====

/** A script `run-X` hands to `$THIS_SH`, as a file argument or (`$THIS_SH < ./file`) on stdin. */
type Script = { file: string; stdin: boolean };
type RunInfo = { name: string; tests: Script[]; rights: string[] };

async function listRuns(only?: string[]): Promise<RunInfo[]> {
  const runs: RunInfo[] = [];

  for await (const entry of Deno.readDir(TESTS)) {
    if (!entry.name.startsWith('run-') || entry.name in config.exclude) continue;
    if (only && !only.includes(entry.name)) continue;

    let text = await Deno.readTextFile(join(TESTS, entry.name));
    const testName = text.match(/^TEST_NAME='([^']+)'/m)?.[1];

    if (testName) {
      text = text.replace(/\$\{?TEST_NAME\}?/g, testName);
    }

    const tests = [...text.matchAll(/^\s*\$\{THIS_SH\}\s+(<\s*)?\.\/([\w.+-]+)/gm)]
      .map((m) => ({ file: m[2], stdin: !!m[1] }))
      .filter((script) => !script.file.startsWith('version'));
    const rights = [...new Set([...text.matchAll(/([\w.+-]+\.right)\b/g)].map((m) => m[1]))];

    runs.push({ name: entry.name, tests, rights });
  }

  return runs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A private copy of tests/ with the rest of the source tree linked beside it,
 * so parallel scripts cannot trip over each other's files and `../` still works.
 */
async function workspace(label: string, name: string): Promise<string> {
  const dir = join(WORK, label, name);

  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(join(dir, 'tmp'), { recursive: true });

  for await (const entry of Deno.readDir(SRC)) {
    if (entry.name !== 'tests') {
      await Deno.symlink(join(SRC, entry.name), join(dir, entry.name));
    }
  }

  const copy = await run('cp', ['-r', TESTS, join(dir, 'tests')]);

  if (copy.code !== 0) {
    throw new Error(`could not copy tests: ${copy.stderr}`);
  }

  return dir;
}

/** The environment `run-all` gives each script. */
function suiteEnv(dir: string, thisSh: string, extra: Record<string, string> = {}): Record<string, string> {
  const env = Deno.env.toObject();

  for (const name of ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GLOBIGNORE', 'BASH_TS_GAPLOG', 'BASH_TS_TEST']) {
    delete env[name];
  }

  return {
    ...env,
    PATH: `${HELPERS}:.:${env.PATH}`,
    TMPDIR: join(dir, 'tmp'),
    BASH_TSTOUT: join(dir, 'tmp', 'bashtst-out'),
    THIS_SH: thisSh,
    BUILD_DIR: dir,
    ...extra,
  };
}

function lines(text: string): string[] {
  const all = text.split('\n');

  return all[all.length - 1] === '' ? all.slice(0, -1) : all;
}

/** How much of `expected` a diff says we got: 2·matched / (expected + ours), 1 for identical. */
type Diffed = { score: number; firstDiff: string; changed: number };

function scoreDiff(diffOutput: string, expectedLines: number): Diffed {
  const out = lines(diffOutput);
  const missing = out.filter((l) => l.startsWith('>')).length;
  const extra = out.filter((l) => l.startsWith('<')).length;
  const matched = Math.max(0, expectedLines - missing);
  const total = expectedLines + matched + extra;
  const hunk = out.findIndex((l) => /^\d/.test(l));
  const firstDiff = hunk === -1 ? '' : out.slice(hunk, hunk + 3).join(' ⏎ ').slice(0, 160);

  return { score: total === 0 ? 1 : round((2 * matched) / total), firstDiff, changed: missing + extra };
}

async function diffFiles(ours: string, expected: string): Promise<Diffed> {
  const out = await run('diff', ['-a', ours, expected]);
  const expectedLines = lines(await Deno.readTextFile(expected).catch(() => '')).length;

  return scoreDiff(out.stdout, expectedLines);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

type Upstream = { pass: boolean; score: number; timeout: boolean; firstDiff: string };

/** `sh run-X` as `run-all` does it, scored from the diff it prints. */
async function upstream(info: RunInfo, dir: string, thisSh: string, extra: Record<string, string> = {}): Promise<Upstream> {
  const tests = join(dir, 'tests');
  const [cmd, args] = timed('sh', [`./${info.name}`]);
  const out = await run(cmd, args, { cwd: tests, env: suiteEnv(dir, thisSh, extra) });
  const timeout = isTimeout(out.code);
  const expected = (await Promise.all(info.rights.map((r) => Deno.readTextFile(join(tests, r)).catch(() => ''))))
    .reduce((n, text) => n + lines(text).length, 0);

  if (timeout) {
    // The script never reached its diff; score what the test got written before it was killed
    const partial = info.rights.length === 1 ? await diffFiles(join(dir, 'tmp', 'bashtst-out'), join(tests, info.rights[0])) : null;

    return { pass: false, score: partial?.score ?? 0, timeout, firstDiff: 'timeout' };
  }

  const diffed = scoreDiff(out.stdout, expected);
  const pass = diffed.changed === 0 && !/^Binary files/m.test(out.stdout);

  return { pass, score: pass ? 1 : expected === 0 ? 0 : diffed.score, timeout, firstDiff: diffed.firstDiff };
}

type StdoutTier = { score: number | null; firstDiff: string; ourErrors: string[] };

/**
 * Each .tests file, stdout only, with real bash as the oracle — the error
 * messages' wording drops out, and so does anything about this machine.
 */
async function stdoutTier(info: RunInfo, dir: string): Promise<StdoutTier> {
  const tests = join(dir, 'tests');
  let expected = '';
  let ours = '';
  const bashErrors = new Set<string>();
  const ourErrors = new Set<string>();

  if (info.tests.length === 0) {
    return { score: null, firstDiff: '', ourErrors: [] };
  }

  for (const test of info.tests) {
    for (const [label, shell] of [['bash', REAL_BASH], ['ours', BASH_TS]] as const) {
      const [cmd, args] = test.stdin ? timed('sh', ['-c', 'exec "$0" < "$1"', shell, `./${test.file}`]) : timed(shell, [`./${test.file}`]);
      const out = await run(cmd, args, { cwd: tests, env: suiteEnv(dir, shell) });
      const stdout = out.stdout + (isTimeout(out.code) ? '\n[timeout]\n' : '');

      if (label === 'bash') {
        expected += stdout;
        lines(out.stderr).forEach((l) => bashErrors.add(normalizeError(l)));
      } else {
        ours += stdout;
        lines(out.stderr).forEach((l) => ourErrors.add(normalizeError(l)));
      }
    }
  }

  const a = join(dir, 'tmp', 'stdout-ours');
  const b = join(dir, 'tmp', 'stdout-bash');

  await Deno.writeTextFile(a, ours);
  await Deno.writeTextFile(b, expected);

  const diffed = await diffFiles(a, b);

  return { score: diffed.score, firstDiff: diffed.firstDiff, ourErrors: [...ourErrors].filter((e) => e && !bashErrors.has(e)) };
}

/** A parser message without its position, so the same fault in different places counts once. */
function normalizeSyntaxError(message: string): string {
  return message.replace(/^Parse error on line \d+: /, '').replace(/\d{3,}/g, 'N');
}

/** An error line without the script name, line number or other numbers, so the same fault counts once. */
function normalizeError(line: string): string {
  return normalizeSyntaxError(line.replace(/^[^:\s]*:\s*(line \S+:\s*)?/, '').replace(/syntax error: Parse error on line \d+: /, 'syntax error: '))
    .replace(/\d+/g, 'N').trim().slice(0, 120);
}

// ===== Parse tier =====

type ParseResult = Record<string, string | true>;

async function parseTier(): Promise<ParseResult> {
  const result: ParseResult = {};
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const names: string[] = [];

  for await (const entry of Deno.readDir(TESTS)) {
    if (/\.(tests|sub)$/.test(entry.name)) names.push(entry.name);
  }

  for (const name of names.sort()) {
    try {
      // As a script is parsed: a here-document it ends inside is taken to the end, with a warning
      await parse(decoder.decode(await Deno.readFile(join(TESTS, name))), { unterminatedHereDocuments: 'end' });
      result[name] = true;
    } catch (err) {
      result[name] = (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 160);
    }
  }

  return result;
}

// ===== Gap log =====

type GapRecord = { test: string; kind: string; name: string; detail?: string };

async function readGaps(dir: string): Promise<GapRecord[]> {
  const text = await Deno.readTextFile(join(dir, 'gaps.jsonl')).catch(() => '');

  return lines(text).filter(Boolean).map((l) => JSON.parse(l));
}

// ===== Baseline =====

type TestScores = { upstream: number; pass: boolean; stdout: number | null; reference: 'pass' | 'env'; timeout?: boolean; firstDiff?: string };
type Baseline = { bash: string; parse: Record<string, boolean>; tests: Record<string, TestScores> };

async function readBaseline(): Promise<Baseline> {
  try {
    return JSON.parse(await Deno.readTextFile(join(HERE, 'baseline.json')));
  } catch {
    return { bash: config.bash, parse: {}, tests: {} };
  }
}

function compare(baseline: Baseline, parse: ParseResult | null, tests: Record<string, TestScores>): string[] {
  const drops: string[] = [];
  const tol = config.tolerance;

  for (const [file, ok] of Object.entries(parse ?? {})) {
    if (baseline.parse[file] === true && ok !== true) {
      drops.push(`${file}: parsed before, now: ${ok}`);
    }
  }

  for (const [name, now] of Object.entries(tests)) {
    const before = baseline.tests[name];

    if (!before) continue;
    if (before.pass && !now.pass) drops.push(`${name}: passed before, fails now`);
    if (now.upstream < before.upstream - tol) drops.push(`${name}: upstream ${before.upstream} → ${now.upstream}`);
    if (now.stdout !== null && before.stdout !== null && now.stdout < before.stdout - tol) drops.push(`${name}: stdout ${before.stdout} → ${now.stdout}`);
  }

  return drops;
}

// ===== Report =====

type Reference = { bashVersion: string; results: Record<string, Upstream> };

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/`/g, "'").replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pct(n: number | null): string {
  return n === null ? 'n/a' : `${Math.round(n * 100)}%`;
}

function writeReport(
  parse: ParseResult,
  tests: Record<string, TestScores>,
  gaps: GapRecord[],
  errors: Map<string, Set<string>>,
): string {
  const files = Object.keys(parse);
  const parsed = files.filter((f) => parse[f] === true).length;
  const names = Object.keys(tests).sort();
  const passes = names.filter((n) => tests[n].pass).length;
  const refPasses = names.filter((n) => tests[n].reference === 'pass').length;
  const mean = (key: 'upstream' | 'stdout') => {
    const scores = names.map((t) => tests[t][key]).filter((n): n is number => n !== null);

    return scores.reduce((n, score) => n + score, 0) / Math.max(1, scores.length);
  };
  const out: string[] = [];

  out.push('# Bash conformance report', '');
  out.push(`Generated by \`deno task conformance:update\` from GNU bash ${config.bash}'s own test suite. Do not edit by hand;`);
  out.push('see [README.md](README.md) for what the scores mean.', '');
  out.push('| Measure | Result |', '| --- | --- |');
  out.push(`| Test files that parse | ${parsed} / ${files.length} |`);
  out.push(`| \`run-*\` scripts passing | ${passes} / ${names.length} (real bash here: ${refPasses}) |`);
  out.push(`| Mean upstream score | ${pct(mean('upstream'))} |`);
  out.push(`| Mean stdout score | ${pct(mean('stdout'))} |`, '');

  out.push('## Gaps', '');

  // Parse errors, grouped by message with the line number taken out
  const parseGroups = new Map<string, string[]>();

  for (const file of files) {
    if (parse[file] === true) continue;

    const key = normalizeSyntaxError(String(parse[file]));

    parseGroups.set(key, [...(parseGroups.get(key) ?? []), file]);
  }

  out.push('### Parser: files that do not parse', '');
  out.push('A file that does not parse runs not at all: bash reads a script one command at a time, and a syntax error costs only');
  out.push('that command, while the parser here takes the whole file at once. Some files hold deliberate syntax errors.', '');
  out.push('| Error | Files | Count |', '| --- | --- | --- |');

  for (const [key, list] of [...parseGroups].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`| ${mdEscape(key)} | ${list.join(', ')} | ${list.length} |`);
  }

  out.push('');

  const gapTable = (title: string, kinds: string[], note: string) => {
    const groups = new Map<string, { count: number; tests: Set<string> }>();

    for (const gap of gaps.filter((g) => kinds.includes(g.kind))) {
      const name = gap.kind === 'syntax-error' ? normalizeSyntaxError(gap.name) : gap.name;
      const key = gap.detail ? `${name}: ${gap.detail}` : name;
      const group = groups.get(key) ?? { count: 0, tests: new Set() };

      group.count++;
      group.tests.add(gap.test.replace(/^run-/, ''));
      groups.set(key, group);
    }

    out.push(`### ${title}`, '', note, '');

    if (groups.size === 0) {
      out.push('None.', '');
      return;
    }

    out.push('| Name | Tests | Times hit |', '| --- | --- | --- |');

    for (const [key, group] of [...groups].sort((a, b) => b[1].tests.size - a[1].tests.size || b[1].count - a[1].count)) {
      out.push(`| ${mdEscape(key)} | ${[...group.tests].sort().join(', ')} | ${group.count} |`);
    }

    out.push('');
  };

  gapTable('Builtins the executor lacks', ['builtin-fallthrough'], 'Bash builtins that reached the host as external commands.');
  gapTable('Keywords run as commands', ['keyword-as-command'], 'Reserved words the parser handed over as a command name.');
  gapTable(
    'Syntax errors at run time',
    ['syntax-error'],
    'What bash-ts refused to parse as it ran: test scripts, the `.sub` files and `-c` strings they start.',
  );
  gapTable('Uncaught exceptions', ['exception'], 'Errors that escaped the executor and ended the script.');
  gapTable('Invocation options not supported', ['host-limit'], 'Options passed to `bash-ts` it has no counterpart for.');

  out.push('### Error messages bash does not print', '');
  out.push('Normalized stderr lines from the stdout tier that real bash never printed for the same test.', '');
  out.push('| Message | Tests |', '| --- | --- |');

  for (const [message, set] of [...errors].sort((a, b) => b[1].size - a[1].size).slice(0, 40)) {
    out.push(`| ${mdEscape(message)} | ${[...set].sort().join(', ')} |`);
  }

  out.push('', '## Per test', '');
  out.push('`ref` is real bash through the same harness on this machine: `env` means it fails there too.', '');
  out.push('| Test | ref | pass | upstream | stdout | First difference (upstream) |', '| --- | --- | --- | --- | --- | --- |');

  for (const name of names) {
    const t = tests[name];

    out.push(
      `| ${name.replace(/^run-/, '')} | ${t.reference} | ${t.pass ? 'yes' : t.timeout ? 'timeout' : 'no'} | ${pct(t.upstream)} | ${pct(t.stdout)} | ${
        mdEscape(t.firstDiff ?? '')
      } |`,
    );
  }

  out.push('');

  return out.join('\n');
}

// ===== Main =====

async function main(): Promise<number> {
  const flags = parseFlags(Deno.args);

  const fetch = await run(join(HERE, 'fetch.sh'), []);

  if (fetch.code !== 0) {
    console.error(fetch.stdout + fetch.stderr);
    return 1;
  }

  console.log('parse tier…');

  const parse = await parseTier();
  const parsed = Object.values(parse).filter((v) => v === true).length;

  console.log(`  ${parsed} / ${Object.keys(parse).length} files parse`);

  const baseline = await readBaseline();
  const tests: Record<string, TestScores> = {};
  const gaps: GapRecord[] = [];
  const errors = new Map<string, Set<string>>();

  if (flags.tier === 'all') {
    // Always rebuilt, so the binary is the source as it is now
    const compile = await run(Deno.execPath(), [
      'compile',
      '-A',
      '--no-check',
      '--quiet',
      '--config',
      join(ROOT, 'deno.jsonc'),
      '-o',
      join(CACHE, 'bash-ts-bin'),
      join(HERE, 'cli.ts'),
    ]);

    if (compile.code !== 0) {
      console.error(compile.stderr);
      return 1;
    }

    // The binary unpacks itself on first start; do that once now, not racing in parallel scripts
    await Deno.remove(join(CACHE, 'bin-tmp'), { recursive: true }).catch(() => {});
    await Deno.mkdir(join(CACHE, 'bin-tmp'));
    await run(BASH_TS, ['-c', ':']);

    const runs = await listRuns(flags.only);
    const referencePath = join(CACHE, 'reference.json');
    const bashVersion = lines((await run(REAL_BASH, ['--version'])).stdout)[0];
    let reference: Reference = { bashVersion, results: {} };

    try {
      const cached: Reference = JSON.parse(await Deno.readTextFile(referencePath));

      if (cached.bashVersion === bashVersion && !flags.reference) reference = cached;
    } catch {
      // first run on this machine
    }

    console.log(`running ${runs.length} test scripts, ${flags.jobs} at a time…`);

    await pool(runs, flags.jobs, async (info) => {
      const started = Date.now();

      if (!reference.results[info.name]) {
        reference.results[info.name] = await upstream(info, await workspace('reference', info.name), REAL_BASH);
      }

      const dir = await workspace('ours', info.name);
      const ours = await upstream(info, dir, BASH_TS, { BASH_TS_GAPLOG: join(dir, 'gaps.jsonl'), BASH_TS_TEST: info.name });

      gaps.push(...(await readGaps(dir)));

      const std = await stdoutTier(info, await workspace('stdout', info.name));

      for (const message of std.ourErrors) {
        errors.set(message, (errors.get(message) ?? new Set()).add(info.name.replace(/^run-/, '')));
      }

      tests[info.name] = {
        upstream: ours.score,
        pass: ours.pass,
        stdout: std.score,
        reference: reference.results[info.name].pass ? 'pass' : 'env',
        ...(ours.timeout ? { timeout: true } : {}),
        firstDiff: ours.firstDiff,
      };

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const verdict = ours.pass ? 'PASS' : ours.timeout ? 'TIME' : 'fail';

      console.log(`  ${info.name.padEnd(22)} ${verdict} upstream ${pct(ours.score).padStart(4)} stdout ${pct(std.score).padStart(4)} (${seconds}s)`);
    });

    await Deno.writeTextFile(referencePath, JSON.stringify(reference, null, 2) + '\n');
  }

  const drops = compare(baseline, parse, tests);

  // A flaky test's drop is said, and neither fails the run nor lowers its baseline
  const flaky = (drop: string) => Object.keys(config.flaky ?? {}).some((name) => drop.startsWith(`${name}:`));

  for (const drop of drops) {
    console.error(`${flaky(drop) ? 'FLAKY' : 'REGRESSION'} ${drop}`);
  }

  drops.splice(0, drops.length, ...drops.filter((drop) => !flaky(drop)));

  if (flags.update) {
    if (drops.length > 0 && !flags.allowDrop) {
      console.error('not updating the baseline over regressions; pass --allow-drop to accept them');
      return 1;
    }

    const next: Baseline = {
      bash: config.bash,
      parse: Object.fromEntries(Object.entries(parse).map(([file, ok]) => [file, ok === true])),
      tests: { ...baseline.tests },
    };

    for (const [name, scores] of Object.entries(tests)) {
      const { firstDiff: _, ...kept } = scores;
      const before = baseline.tests[name];

      next.tests[name] = before && name in (config.flaky ?? {}) && (before.pass && !kept.pass || kept.upstream < before.upstream) ? before : kept;
    }

    next.tests = Object.fromEntries(Object.entries(next.tests).sort(([a], [b]) => a.localeCompare(b)));

    await Deno.writeTextFile(join(HERE, 'baseline.json'), JSON.stringify(next, null, 2) + '\n');
    console.log('baseline.json updated');

    if (!flags.only && flags.tier === 'all') {
      await Deno.writeTextFile(join(HERE, 'REPORT.md'), writeReport(parse, tests, gaps, errors));
      console.log('REPORT.md written');
    }
  }

  // Drops accepted into the baseline are no longer a failure
  return drops.length > 0 && !(flags.update && flags.allowDrop) ? 1 : 0;
}

Deno.exit(await main());
