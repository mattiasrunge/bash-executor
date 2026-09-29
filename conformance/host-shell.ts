import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, join, resolve } from '@std/path';
import type { ExecCommandOptions, ExecContextIf, JobHandle, JobHostIf, PathTestOperation, ShellIf } from '../mod.ts';
import { globToRegexSource } from '../src/pattern.ts';
import { PipeBuffer } from '../test/lib/pipe-buffer.ts';

/**
 * Every builtin bash 5.2 has (`compgen -b`). A name from this list that reaches
 * `execute` is one the executor does not implement: it falls through to a binary
 * on PATH, or to "command not found", and either way it is a gap worth counting.
 */
const BASH_BUILTINS = new Set(
  ('. : [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo enable eval exec ' +
    'exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly ' +
    'return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait').split(' '),
);

/** Reserved words (`compgen -k`); reaching `execute` means the parser took one for a command name. */
const BASH_KEYWORDS = new Set('if then else elif fi case esac for select while until do done in function time { } ! [[ ]] coproc'.split(' '));

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

/** A record for the conformance runner's gap report, appended to `$BASH_TS_GAPLOG`. */
export type Gap = {
  kind: 'builtin-fallthrough' | 'keyword-as-command' | 'syntax-error' | 'exception' | 'host-limit';
  name: string;
  detail?: string;
};

export function logGap(gap: Gap): void {
  const path = Deno.env.get('BASH_TS_GAPLOG');

  if (!path) {
    return;
  }

  const record = { test: Deno.env.get('BASH_TS_TEST') ?? '', script: Deno.env.get('BASH_TS_SCRIPT') ?? '', ...gap };

  try {
    Deno.writeTextFileSync(path, JSON.stringify(record) + '\n', { append: true });
  } catch {
    // The log is a report, never a reason to fail the script
  }
}

/** A descriptor opened with `fdOpen`, `exec 3<>file` style: a real file kept open between calls. */
type FileHandle = { file: Deno.FsFile };

export type RealShellOptions = {
  /** How to start another copy of this shell, for a script that has no `#!` line (bash runs those itself). */
  selfCommand: string[];
  /** `$0` as bash would print it in front of an error. */
  name: () => string;
  /** Added to every child's environment, out of sight of the script. */
  hostEnv?: Record<string, string>;
  /** A signal sent to this shell itself, `kill -USR1 $$`: its trap, or its default. */
  onSignal?: (signal: string) => Promise<void>;
};

/** Where a job's child processes are recorded, and how the job itself is stopped. */
type JobRecord = { children: Set<Deno.ChildProcess>; abort: AbortController; finished: boolean; killedBy?: number };

/** Signals whose default is to do nothing; every other one ends what it reaches. */
const HARMLESS_SIGNALS = new Set(['0', 'CHLD', 'CONT', 'URG', 'WINCH']);

/**
 * A ShellIf on the real operating system: external commands are processes,
 * redirections are files, globs read directories. It exists so bash's own test
 * suite can run against the executor; it is not meant as a production shell.
 *
 * Names the executor passes around as I/O endpoints are `0`/`1`/`2` (this
 * process's own stdio), pipes this shell opened, and descriptors opened with
 * `fdOpen`. Anything else is a path, which the executor bridges through a pipe.
 */
export class RealShell implements ShellIf {
  private pipes = new Map<string, PipeBuffer>();
  private files = new Map<string, FileHandle>();
  private pipeCounter = 0;
  private background = new Set<Promise<unknown>>();
  private encoder = new TextEncoder();

  /** The job whose code is running now, for `spawn` to file its processes under. */
  private currentJob = new AsyncLocalStorage<string>();
  private jobRecords = new Map<string, JobRecord>();
  /** Job ids, above any real pid on Linux */
  private nextJobPid = 4_200_000;

  constructor(private opts: RealShellOptions) {}

  /**
   * Job control. A job's id is its own number, not a process's: a job may be a
   * loop that starts many. `kill` reaches the processes it has running and
   * stops the job itself between commands.
   */
  jobs: JobHostIf = {
    start: async (ctx: ExecContextIf, run: (jobCtx: ExecContextIf) => Promise<number>): Promise<JobHandle> => {
      const pid = String(this.nextJobPid++);
      const record: JobRecord = { children: new Set(), abort: new AbortController(), finished: false };
      const jobCtx = ctx.subContext();

      jobCtx.setAbortSignal(record.abort.signal);
      this.jobRecords.set(pid, record);

      // A job a signal ended ends with 128 + its number, whatever it was running
      const done = this.currentJob.run(pid, () => run(jobCtx)).catch(() => 1)
        .then((code) => record.killedBy ? 128 + record.killedBy : code)
        .finally(() => {
          record.finished = true;
        });

      this.track(done);

      return await { pid, done };
    },

    signal: async (pid: string, signal: string): Promise<boolean> => {
      if (pid === String(Deno.pid)) {
        await this.opts.onSignal?.(signal);
        return true;
      }

      const record = this.jobRecords.get(pid);

      if (record) {
        if (record.finished) return false;
        if (HARMLESS_SIGNALS.has(signal)) return true;

        for (const child of record.children) {
          try {
            child.kill(`SIG${signal}` as Deno.Signal);
          } catch {
            // already gone
          }
        }

        record.killedBy = SIGNALS[`SIG${signal}`] ?? 15;
        record.abort.abort();
        return true;
      }

      // Any other process
      try {
        if (signal === '0') {
          return (await statOf(`/proc/${Number(pid)}`)) !== null;
        }

        Deno.kill(Number(pid), `SIG${signal}` as Deno.Signal);
        return true;
      } catch {
        return false;
      }
    },
  };

  /** Resolves once every job started with `&` has finished. */
  async waitForBackground(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.allSettled([...this.background]);
    }
  }

  private track(job: Promise<unknown>): void {
    const tracked = job.catch(() => {}).finally(() => this.background.delete(tracked));

    this.background.add(tracked);
  }

  private path(ctx: ExecContextIf, path: string): string {
    return isAbsolute(path) ? path : resolve(ctx.getCwd(), path);
  }

  private async error(message: string): Promise<void> {
    await this.writeAll(Deno.stderr, `${this.opts.name()}: ${message}\n`);
  }

  private async writeAll(target: { write(p: Uint8Array): Promise<number> }, data: string | Uint8Array): Promise<void> {
    let bytes = typeof data === 'string' ? this.encoder.encode(data) : data;

    while (bytes.length > 0) {
      const n = await target.write(bytes);

      bytes = bytes.subarray(n);
    }
  }

  // ===== External commands =====

  /** Where PATH finds `name`, or null. A name with a slash is taken as a path. */
  private async which(ctx: ExecContextIf, name: string): Promise<string | null> {
    if (name.includes('/')) {
      const path = this.path(ctx, name);

      return (await statOf(path)) ? path : null;
    }

    const search = ctx.getEnv().PATH ?? ctx.getParams().PATH ?? '/usr/local/bin:/usr/bin:/bin';

    for (const dir of search.split(':')) {
      const candidate = this.path(ctx, join(dir || '.', name));

      try {
        const stat = await Deno.stat(candidate);

        if (stat.isFile && ((stat.mode ?? 0) & 0o111)) {
          return candidate;
        }
      } catch {
        // not in this directory
      }
    }

    return null;
  }

  async execute(ctx: ExecContextIf, name: string, args: string[], opts: ExecCommandOptions): Promise<number> {
    if (BASH_BUILTINS.has(name)) {
      logGap({ kind: 'builtin-fallthrough', name });
    } else if (BASH_KEYWORDS.has(name)) {
      logGap({ kind: 'keyword-as-command', name });
    }

    const path = await this.which(ctx, name);

    if (!path) {
      const missing = name.includes('/') ? 'No such file or directory' : 'command not found';

      await this.writeTo(ctx.getStderr(), `${this.opts.name()}: ${name}: ${missing}\n`);

      return 127;
    }

    if ((await statOf(path))?.isDirectory) {
      await this.writeTo(ctx.getStderr(), `${this.opts.name()}: ${name}: Is a directory\n`);

      return 126;
    }

    const run = this.spawn(ctx, name, path, args);

    if (opts.async) {
      this.track(run);

      return 0;
    }

    return await run;
  }

  private async spawn(ctx: ExecContextIf, name: string, path: string, args: string[], viaSelf = false): Promise<number> {
    const stdin = ctx.getStdin();
    const stdout = ctx.getStdout();
    const stderr = ctx.getStderr();

    let child: Deno.ChildProcess;

    try {
      child = new Deno.Command(viaSelf ? this.opts.selfCommand[0] : path, {
        args: viaSelf ? [...this.opts.selfCommand.slice(1), path, ...args] : args,
        cwd: ctx.getCwd(),
        env: { ...ctx.getEnv(), ...this.opts.hostEnv },
        clearEnv: true,
        stdin: stdin === '0' ? 'inherit' : 'piped',
        stdout: stdout === '1' ? 'inherit' : 'piped',
        stderr: stderr === '2' ? 'inherit' : 'piped',
        signal: ctx.getAbortSignal(),
      }).spawn();
    } catch (err) {
      // No `#!` line: bash runs such a file as a script of its own
      if (!viaSelf && err instanceof Error && /exec format|os error 8\b/i.test(err.message)) {
        return await this.spawn(ctx, name, path, args, true);
      }

      if (err instanceof Deno.errors.PermissionDenied || (err instanceof Error && /permission denied|os error 13\b/i.test(err.message))) {
        await this.writeTo(stderr, `${this.opts.name()}: ${name}: Permission denied\n`);

        return 126;
      }

      await this.writeTo(stderr, `${this.opts.name()}: ${name}: ${err instanceof Error ? err.message : String(err)}\n`);

      return 126;
    }

    // A child of a job is the job's, for `kill %1` to reach
    const record = this.jobRecords.get(this.currentJob.getStore() ?? '');

    record?.children.add(child);
    child.status.finally(() => record?.children.delete(child));

    const pumps: Promise<void>[] = [];

    if (stdin !== '0') {
      pumps.push(this.pumpIn(stdin, child.stdin));
    }
    if (stdout !== '1') {
      pumps.push(this.pumpOut(child.stdout, stdout));
    }
    if (stderr !== '2') {
      pumps.push(this.pumpOut(child.stderr, stderr));
    }

    const status = await child.status;

    // The input pump stops by itself once the child's stdin is gone; the output
    // pumps end at the child's EOF
    await Promise.allSettled(pumps);

    return status.signal ? 128 + (SIGNALS[status.signal] ?? 0) : status.code;
  }

  /** Feed a child's stdin from one of our endpoints. */
  private async pumpIn(source: string, sink: WritableStream<Uint8Array>): Promise<void> {
    const writer = sink.getWriter();

    try {
      const pipe = this.pipes.get(source);
      const handle = this.files.get(source);

      while (true) {
        let chunk: Uint8Array;

        if (pipe) {
          chunk = await pipe.read(16384);
        } else if (handle) {
          const buf = new Uint8Array(16384);
          const n = await handle.file.read(buf);

          chunk = n ? buf.subarray(0, n) : new Uint8Array(0);
        } else {
          break;
        }

        if (chunk.length === 0) {
          break;
        }

        await writer.write(chunk);
      }
    } catch {
      // The child exited without reading everything, as `head` does
    } finally {
      await writer.close().catch(() => {});
    }
  }

  /** Copy a child's output to one of our endpoints. */
  private async pumpOut(source: ReadableStream<Uint8Array>, target: string): Promise<void> {
    const decoder = new TextDecoder();

    for await (const chunk of source) {
      const text = decoder.decode(chunk, { stream: true });

      if (text) {
        await this.writeTo(target, text);
      }
    }

    const rest = decoder.decode();

    if (rest) {
      await this.writeTo(target, rest);
    }
  }

  /** Write to an endpoint, where an empty string is just nothing (unlike `pipeWrite`, where it is EOF). */
  private async writeTo(target: string, data: string): Promise<void> {
    if (data.length > 0) {
      await this.pipeWrite(target, data);
    }
  }

  async executeBackground(ctx: ExecContextIf, run: (ctx: ExecContextIf) => Promise<number>, _command: string): Promise<number> {
    this.track(run(ctx));

    return await 0;
  }

  // ===== Pipes and descriptors =====

  async pipeOpen(): Promise<string> {
    const name = `pipe_${++this.pipeCounter}`;

    this.pipes.set(name, new PipeBuffer());

    return await name;
  }

  async pipeClose(name: string): Promise<void> {
    this.pipes.get(name)?.close();

    await undefined;
  }

  async pipeRemove(name: string): Promise<void> {
    this.pipes.get(name)?.close();
    this.pipes.delete(name);

    await undefined;
  }

  async pipeRead(name: string): Promise<string> {
    if (name === '0') {
      return await new Response(Deno.stdin.readable).text();
    }

    const handle = this.files.get(name);

    if (handle) {
      const chunks: Uint8Array[] = [];
      const buf = new Uint8Array(16384);

      for (let n = await handle.file.read(buf); n; n = await handle.file.read(buf)) {
        chunks.push(buf.slice(0, n));
      }

      return new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
    }

    return (await this.pipes.get(name)?.readAll()) ?? '';
  }

  async pipeWrite(name: string, data: string): Promise<void> {
    if (name === '1') {
      return await this.writeAll(Deno.stdout, data);
    }
    if (name === '2') {
      return await this.writeAll(Deno.stderr, data);
    }

    const handle = this.files.get(name);

    if (handle) {
      return await this.writeAll(handle.file, data);
    }

    const pipe = this.pipes.get(name);

    if (pipe && !pipe.isClosed) {
      if (data === '') {
        // An empty write is EOF, as in the test shell and MURRiX
        pipe.close();
      } else {
        await pipe.writeString(data).catch(() => {});
      }
    }
  }

  isPipe(name: string): boolean {
    return name === '0' || name === '1' || name === '2' || this.pipes.has(name) || this.files.has(name);
  }

  async pipeFromFile(ctx: ExecContextIf, path: string, pipe: string): Promise<void> {
    try {
      const file = await Deno.open(this.path(ctx, path), { read: true });
      const buf = new Uint8Array(16384);
      const target = this.pipes.get(pipe);

      try {
        for (let n = await file.read(buf); n; n = await file.read(buf)) {
          await target?.write(buf.slice(0, n));
        }
      } finally {
        file.close();
      }
    } catch (err) {
      await this.error(`${path}: ${describe(err)}`);
    } finally {
      await this.pipeClose(pipe);
    }
  }

  async pipeToFile(ctx: ExecContextIf, pipe: string, path: string, append: boolean): Promise<void> {
    let file: Deno.FsFile | null = null;

    try {
      file = await Deno.open(this.path(ctx, path), { write: true, create: true, append, truncate: !append });
    } catch (err) {
      await this.error(`${path}: ${describe(err)}`);
    }

    // Drain the pipe even when the file could not be opened, or the writer blocks
    const source = this.pipes.get(pipe);

    try {
      while (source) {
        const chunk = await source.read(16384);

        if (chunk.length === 0) {
          break;
        }

        if (file) {
          await this.writeAll(file, chunk);
        }
      }
    } finally {
      file?.close();
    }
  }

  async fdOpen(ctx: ExecContextIf, path: string, mode: string, fd?: string): Promise<string> {
    const name = fd ?? String(10 + ++this.pipeCounter);
    const writable = mode.includes('w') || mode.includes('+') || mode.includes('a');
    const file = await Deno.open(this.path(ctx, path), {
      read: mode.includes('r') || mode.includes('+'),
      write: writable,
      create: writable,
      append: mode.includes('a'),
      truncate: mode.startsWith('w'),
    });

    await this.fdClose(name);
    this.files.set(name, { file });

    return name;
  }

  async fdClose(fd: string): Promise<void> {
    const handle = this.files.get(fd);

    if (handle) {
      this.files.delete(fd);
      handle.file.close();
    }

    await undefined;
  }

  /**
   * One line, read a byte at a time, as bash does on anything it cannot seek:
   * whatever follows the line stays for the next reader, which may be another
   * process sharing the same stdin.
   */
  async pipeReadLine(fd: string, delimiter = '\n'): Promise<string | null> {
    const stop = (delimiter === '' ? '\0' : delimiter).charCodeAt(0);
    const bytes: number[] = [];
    const one = new Uint8Array(1);
    const pipe = this.pipes.get(fd);
    const handle = this.files.get(fd);

    if (!pipe && !handle && fd !== '0') {
      return null;
    }

    while (true) {
      let byte: number | null;

      if (pipe) {
        const chunk = await pipe.read(1);

        byte = chunk.length ? chunk[0] : null;
      } else {
        const n = await (handle ? handle.file : Deno.stdin).read(one);

        byte = n ? one[0] : null;
      }

      if (byte === null) {
        return bytes.length > 0 ? new TextDecoder().decode(new Uint8Array(bytes)) : null;
      }
      if (byte === stop) {
        return new TextDecoder().decode(new Uint8Array(bytes));
      }

      bytes.push(byte);
    }
  }

  // ===== Files =====

  async tempFile(_ctx: ExecContextIf): Promise<string> {
    return await Deno.makeTempFile({ prefix: 'bash-ts-psub-' });
  }

  async removeTempFile(_ctx: ExecContextIf, path: string): Promise<void> {
    await Deno.remove(path).catch(() => {});
  }

  async readFile(ctx: ExecContextIf, path: string): Promise<string> {
    return await Deno.readTextFile(this.path(ctx, path));
  }

  async resolveHomeUser(ctx: ExecContextIf, username: string | null): Promise<string> {
    if (username === null) {
      return ctx.getParams().HOME ?? ctx.getEnv().HOME ?? Deno.env.get('HOME') ?? '/';
    }

    const passwd = await Deno.readTextFile('/etc/passwd').catch(() => '');
    const entry = passwd.split('\n').map((line) => line.split(':')).find((fields) => fields[0] === username);

    // An unknown user leaves the tilde as it was written
    return entry?.[5] ?? `~${username}`;
  }

  /** Pathname expansion; a pattern that matches nothing stays as it was, bash's default. */
  async resolvePath(ctx: ExecContextIf, text: string): Promise<string[]> {
    if (!/[*?[]|[@+!]\(/.test(text)) {
      return [text];
    }

    const absolute = text.startsWith('/');
    const segments = text.split('/').filter((segment, i) => segment !== '' || i === 0);
    let found: string[] = [absolute ? '/' : ''];

    for (const segment of segments.slice(absolute ? 1 : 0)) {
      const next: string[] = [];

      for (const base of found) {
        if (!/[*?[]|[@+!]\(/.test(segment)) {
          const candidate = base === '' ? segment : base.endsWith('/') ? base + segment : `${base}/${segment}`;

          if (await exists(this.path(ctx, candidate || '.'))) {
            next.push(candidate);
          }
          continue;
        }

        const regex = globSegmentToRegex(segment);

        // A pattern bash cannot use either, like the backwards range in `[m-1]`, matches nothing
        if (!regex) {
          continue;
        }

        const dir = this.path(ctx, base || '.');

        try {
          for await (const entry of Deno.readDir(dir)) {
            if (regex.test(entry.name)) {
              next.push(base === '' ? entry.name : base.endsWith('/') ? base + entry.name : `${base}/${entry.name}`);
            }
          }
        } catch {
          // not a directory, or unreadable: no matches below it
        }
      }

      found = next;
    }

    // `*/` matches directories only, and keeps its slash
    if (text.endsWith('/')) {
      const dirs: string[] = [];

      for (const path of found) {
        if ((await statOf(this.path(ctx, path || '.')))?.isDirectory) {
          dirs.push(path.endsWith('/') ? path : `${path}/`);
        }
      }

      found = dirs;
    }

    found.sort(compareBytes);

    return found.length > 0 ? found : [text];
  }

  async testPath(ctx: ExecContextIf, path: string, op: PathTestOperation, path2?: string): Promise<boolean> {
    if (op === 'FD_IS_TERMINAL') {
      const fd = Number(path);

      return fd === 0 ? Deno.stdin.isTerminal() : fd === 1 ? Deno.stdout.isTerminal() : fd === 2 ? Deno.stderr.isTerminal() : false;
    }

    const full = this.path(ctx, path);

    if (op === 'SYMLINK') {
      return (await lstat(full))?.isSymlink ?? false;
    }

    const stat = await statOf(full);

    if (op === 'NEWER_THAN' || op === 'OLDER_THAN' || op === 'SAME_DEVICE_AND_INODE') {
      const other = path2 === undefined ? null : await statOf(this.path(ctx, path2));

      if (op === 'SAME_DEVICE_AND_INODE') {
        return !!stat && !!other && stat.dev === other.dev && stat.ino === other.ino;
      }

      const [newer, older] = op === 'NEWER_THAN' ? [stat, other] : [other, stat];

      if (!newer) {
        return false;
      }

      return !older || (newer.mtime?.getTime() ?? 0) > (older.mtime?.getTime() ?? 0);
    }

    if (!stat) {
      return false;
    }

    const mode = stat.mode ?? 0;

    switch (op) {
      case 'EXISTS':
        return true;
      case 'REGULAR_FILE':
        return stat.isFile;
      case 'DIRECTORY':
        return stat.isDirectory;
      case 'READABLE':
        return canAccess(stat, 4);
      case 'WRITABLE':
        return canAccess(stat, 2);
      case 'EXECUTABLE':
        return canAccess(stat, 1);
      case 'NON_EMPTY':
        return stat.size > 0;
      case 'BLOCK_DEVICE':
        return stat.isBlockDevice ?? false;
      case 'CHAR_DEVICE':
        return stat.isCharDevice ?? false;
      case 'NAMED_PIPE':
        return stat.isFifo ?? false;
      case 'SOCKET':
        return stat.isSocket ?? false;
      case 'SETUID':
        return (mode & 0o4000) !== 0;
      case 'SETGID':
        return (mode & 0o2000) !== 0;
      case 'STICKY':
        return (mode & 0o1000) !== 0;
      case 'OWNED_BY_EUID':
        return stat.uid === Deno.uid();
      case 'OWNED_BY_EGID':
        return stat.gid === Deno.gid();
      case 'MODIFIED_SINCE_LAST_READ':
        return (stat.mtime?.getTime() ?? 0) > (stat.atime?.getTime() ?? 0);
      default:
        return false;
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Deno.errors.NotFound) return 'No such file or directory';
  if (err instanceof Deno.errors.PermissionDenied) return 'Permission denied';
  if (err instanceof Deno.errors.IsADirectory) return 'Is a directory';
  return err instanceof Error ? err.message : String(err);
}

async function statOf(path: string): Promise<Deno.FileInfo | null> {
  return await Deno.stat(path).catch(() => null);
}

async function lstat(path: string): Promise<Deno.FileInfo | null> {
  return await Deno.lstat(path).catch(() => null);
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path)) !== null;
}

/** access(2) by hand: owner, group or other bits, and root reads and writes anything. */
function canAccess(stat: Deno.FileInfo, bit: number): boolean {
  const mode = stat.mode ?? 0;
  const uid = Deno.uid();

  if (uid === 0) {
    return bit !== 1 || (mode & 0o111) !== 0 || stat.isDirectory;
  }
  if (stat.uid === uid) {
    return (mode & (bit << 6)) !== 0;
  }
  if (stat.gid === Deno.gid()) {
    return (mode & (bit << 3)) !== 0;
  }
  return (mode & bit) !== 0;
}

/** Byte order, which is what the C locale the tests mostly run under sorts by. */
function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One path segment of a glob as a regex, or null when it is not a valid one. A leading dot is only matched by a literal dot. */
export function globSegmentToRegex(segment: string): RegExp | null {
  const leadingDotMatch = segment.startsWith('.') ? '' : '(?!\\.)';

  try {
    return new RegExp(`^${leadingDotMatch}${globToRegexSource(segment)}$`, 's');
  } catch {
    return null;
  }
}
