/**
 * Finds the constructs bash-parser rejects in bash's test files, one top-level
 * command at a time.
 *
 *   deno run -A conformance/parse-chunks.ts [file.tests …]   (default: every file that does not parse)
 *
 * Real bash decides where a command ends: lines are added until `bash -n`
 * accepts them, and that chunk is handed to the parser on its own. A chunk bash
 * rejects for anything but running out of input is one of the tests' deliberate
 * syntax errors and is skipped. Prints one JSON line per chunk the parser
 * rejects.
 */
import { parse } from '@ein/bash-parser';
import { dirname, fromFileUrl, join } from '@std/path';

const HERE = dirname(fromFileUrl(import.meta.url));
const config = JSON.parse(await Deno.readTextFile(join(HERE, 'config.json')));
const TESTS = join(HERE, '.cache', `bash-${config.bash}`, 'tests');

// What the tests switch on before the constructs that need it
const BASH_PRELUDE = 'shopt -s extglob\n';

async function bashAccepts(source: string): Promise<'ok' | 'incomplete' | 'error'> {
  const out = await new Deno.Command('/bin/bash', { args: ['-n', '-c', BASH_PRELUDE + source], stderr: 'piped', stdout: 'null' }).output();

  if (out.code === 0) {
    return 'ok';
  }

  const stderr = new TextDecoder().decode(out.stderr);

  return /unexpected end of file|here-document .* delimited by end-of-file|unexpected EOF while looking/.test(stderr) ? 'incomplete' : 'error';
}

async function parses(source: string): Promise<string | null> {
  try {
    await parse(source);
    return null;
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).split('\n')[0];
  }
}

async function files(): Promise<string[]> {
  if (Deno.args.length > 0) {
    return Deno.args;
  }

  const names: string[] = [];

  for await (const entry of Deno.readDir(TESTS)) {
    if (/\.(tests|sub)$/.test(entry.name)) names.push(entry.name);
  }

  const failing: string[] = [];

  for (const name of names.sort()) {
    if (await parses(await read(name)) !== null) failing.push(name);
  }

  return failing;
}

async function read(name: string): Promise<string> {
  return new TextDecoder('utf-8', { fatal: false }).decode(await Deno.readFile(join(TESTS, name)));
}

for (const name of await files()) {
  const lines = (await read(name)).split('\n');
  let start = 0;

  for (let end = 0; end < lines.length; end++) {
    const chunk = lines.slice(start, end + 1).join('\n');

    if (!chunk.trim()) {
      start = end + 1;
      continue;
    }

    const verdict = await bashAccepts(chunk);

    if (verdict === 'incomplete') {
      continue;
    }

    if (verdict === 'ok') {
      const error = await parses(chunk + '\n');

      if (error !== null) {
        console.log(JSON.stringify({ file: name, line: start + 1, error, chunk: chunk.slice(0, 400) }));
      }
    }

    start = end + 1;
  }
}
