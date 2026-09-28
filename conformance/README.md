# Bash conformance

Runs GNU bash's own test suite (`tests/` of bash 5.2.21) against bash-parser and
bash-executor, to find what they do not do yet and to catch regressions as they
learn it. [REPORT.md](REPORT.md) is the current state.

```sh
deno task conformance:fetch   # download bash's source, build its test helpers
deno task conformance         # run everything, fail on a drop against baseline.json
deno task conformance:update  # …and write baseline.json and REPORT.md
deno task conformance --only arith,quote      # iterate on a few run-* scripts
deno task conformance --tier parse            # parse every test file, nothing else
```

Needs network once, a C compiler, GNU `timeout` and `diff`, and `/bin/bash`. A
full run takes a few minutes. It is not part of `deno task test`.

The tests are GPLv3, so they are fetched into `conformance/.cache/`, never
committed. Everything under `.cache/` can be deleted.

## How it runs

Each `tests/run-X` script does `${THIS_SH} ./X.tests > $BASH_TSTOUT 2>&1` and
diffs that against `X.right`. [`bash-ts`](bash-ts) is a `THIS_SH`:
[`cli.ts`](cli.ts) takes bash's command line (`-c`, a script file, `-e`, `-o`…)
and runs the script with `AstExecutor` on [`RealShell`](host-shell.ts), a
`ShellIf` on the real OS: external commands are processes, redirections are
files, globs read directories. `run.ts` compiles `cli.ts` into a binary so the
suite's hundreds of shell starts stay cheap.

Every script gets a private copy of `tests/`, with the rest of bash's source tree
linked beside it, so scripts can run in parallel.

## Scores

Per `run-X` script:

| Score       | What it is                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`      | the upstream diff is empty, as `run-all` counts it                                                                                          |
| `upstream`  | how much of `X.right` we produce: 2·matched / (expected + ours), from that diff. Error messages count, so their wording matters here        |
| `stdout`    | the same measure on stdout alone, with real bash run on the same files as the oracle. Wording of errors and quirks of this machine drop out |
| `reference` | real bash through the upstream harness on this machine. `env` means bash itself fails here (locale, timing), so the test cannot fully pass  |

Per test file, the parse tier records whether bash-parser accepts it.

## Gaps the report lists

- **Parser**: files that do not parse, grouped by message. A file that does not
  parse does not run at all, which makes this the biggest lever: bash reads and
  runs a script one command at a time, so a syntax error costs it one command,
  while bash-parser takes the whole file at once. Some files hold deliberate
  syntax errors, and matching bash there needs incremental parsing.
- **Builtins the executor lacks**: bash builtins that reached the host as
  external commands (`RealShell` logs every one).
- **Uncaught exceptions** that ended a script, **syntax errors at run time**, and
  **invocation options** `bash-ts` has no counterpart for.
- **Error messages bash does not print**: stderr lines from the stdout tier that
  real bash never printed for the same test.

## Regressions

`baseline.json` holds every score. `deno task conformance` exits non-zero when a
file that parsed no longer does, a pass turns into a failure, or a score drops by
more than `tolerance` in [`config.json`](config.json) (timing-dependent tests
wobble a little). `conformance:update` refuses to write a lower baseline unless
given `--allow-drop`, so update it when a change improves the scores and commit
it with that change.

## Known limits of the harness

These are `RealShell`'s, not the executor's, and show up as failures that are
not the executor's fault:

- The `ShellIf` pipe interface carries strings, so bytes that are not valid
  UTF-8 are replaced (some of `intl`, `unicode`, `printf`).
- A child process only gets fds 0–2; `cmd 3>file` cannot reach it.
- Errors the host prints (`command not found`, a file it cannot open) lack
  bash's `line N:` part: `ShellIf` is not told which line a command is on.
- Background jobs run, but `$!`, `jobs`, `fg` and signals to them are not
  there.
