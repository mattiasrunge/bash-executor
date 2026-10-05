# bash-executor

Execute bash scripts, with the AST given by [bash-parser](https://github.com/mattiasrunge/bash-parser).

The executor implements the shell itself (expansions, control flow, functions, variables, redirections and bash's
builtins) and leaves what touches the outside world to a host: running external commands, files, pipes and directories
go through the `ShellIf` interface it implements.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Arrays and field splitting](#arrays-and-field-splitting)
- [Shell options](#shell-options)
- [An interactive prompt](#an-interactive-prompt)
- [Bash conformance](#bash-conformance)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

## Installation

```bash
deno add jsr:@ein/bash-executor
```

## Usage

```ts
import { AstExecutor, ExecContext, ExecContextIf, ShellIf } from '@ein/bash-executor';

class Shell implements ShellIf {
  // Implement required methods...
}

const ctx: ExecContextIf = new ExecContext();
const shell: ShellIf = new Shell();
const executor = new AstExecutor(shell);
const exitCode = await executor.execute('echo "Hello World"', ctx);
```

[`conformance/host-shell.ts`](./conformance/host-shell.ts) is a complete `ShellIf` on the real operating system: external
commands are processes, redirections are files and globs read directories. [`conformance/cli.ts`](./conformance/cli.ts)
uses it to run scripts as `bash` would, from bash's own command line.

## Arrays and field splitting

Indexed arrays and IFS field splitting work as in bash:

```bash
IFS=$'\n'
FILES=($(find . -type f))     # one element per line, blanks in names kept
unset IFS

for file in "${FILES[@]}"; do # one word per element, whatever it contains
  echo "${#FILES[@]} ${file}"
done

FILES+=(extra)                # append
FILES[0]=first                # assign one element, subscript is arithmetic
unset 'FILES[1]'              # remove one, leaving a hole
echo "${!FILES[@]}"           # the indices that are set
mapfile -t LINES < list.txt   # read a file into an array
```

Splitting applies to what an expansion produced, never to the literal text
around it, and `IFS=` disables it. Arrays live beside the parameters, are never
exported and can be sparse. `declare -a`, `local -a`, `declare -p`, `read -a`,
`mapfile`/`readarray` and `BASH_REMATCH` all operate on them.

Associative arrays are declared, as in bash, with `declare -A`, which is what
makes their subscripts keys rather than arithmetic expressions:

```bash
declare -A seen
seen[$path]=1
for key in "${!seen[@]}"; do echo "$key ${seen[$key]}"; done
```

A subscript is expanded once, as bash 5.2 expands it, and what it expands to is
the key: `seen[$path]=1` keeps a path holding `=` or `]`, and `(( count[$k]++ ))`
neither ends the subscript early nor runs a `$( )` that the key holds.

An operator applies to each element of `${a[@]}` and the expansion stays a list
(`${a[@]%.jpg}`, `${a[@]^^}`, `${a[@]/x/y}`), while `${a[@]:1:2}` slices the list
itself. Here-documents (`cat > f <<'EOF'` … `EOF`, `<<-` too; an unquoted delimiter
expands the body), here-strings (`read -a p <<< "$line"`) and process substitution
(`mapfile -t f < <(find .)`) all work; the last needs the `tempFile` and
`removeTempFile` callbacks on `ShellIf`, since only the host knows what a command
can open.

## Shell options

`set` options are per-shell state on the execution context, not process-wide, so
a host running many shells in one process keeps them apart. A subshell inherits
them as a copy; a function writes through to the shell it was called from.

| Option             | What it does                                                             |
| ------------------ | ------------------------------------------------------------------------ |
| `-e` / `errexit`   | A failing command ends the shell, with bash's exemptions                 |
| `-u` / `nounset`   | Expanding an unset parameter is an error, status 127                     |
| `-x` / `xtrace`    | Write each command to the shell's stderr as it runs, prefixed with `PS4` |
| `-v` / `verbose`   | Echo each command's source before running it                             |
| `-f` / `noglob`    | No pathname expansion                                                    |
| `-a` / `allexport` | A plain assignment goes to the environment                               |
| `-C` / `noclobber` | `>` will not truncate an existing file; `>                               |
| `-n` / `noexec`    | Read the rest without running it                                         |
| `pipefail`         | A pipeline takes the rightmost non-zero status                           |
| `PIPESTATUS`       | (not an option) the array of the last pipeline's stage statuses          |

`errexit` is decided per command, where it runs, so a failure is exempt in an
`if`/`while`/`until` clause, under `!`, on the left of `&&`/`||`, in a pipeline
stage or in a command substitution — and the exemption covers what those call,
functions included.

`noclobber` needs the `testPath` callback on `ShellIf` to know whether a file is
there; without one it cannot refuse.

`monitor`, `notify` and `ignoreeof` are recorded for the host to read off the
context and act on — job control, background-job reports and what Ctrl-D does at
a prompt are the host shell's, not the executor's.

`shopt -s expand_aliases` is off by default, as in a bash script: an interactive
host turns it on, or aliases are defined but never expanded.

Some builtins ask the host what only it knows. `type`, `command -v` and `hash`
find commands with the `lookupCommand` callback (falling back to running `which
-a`); `umask` keeps the mask on the context (`getUmask`) for the host to apply to
what it creates; and `exec -a`/`-c` hand `argv0` and `clearEnv` to `execute` in
its options.

A variable is one record in the scope that holds it — a string, an indexed or an
associative array, or nothing yet (`declare x`, `local -a y`) — with its
attributes as `declare`'s letters, so `local -r`, `declare -i` and `export` belong
to the variable and not to its name. `getVariable`/`getVariables` show them,
`declareVariable` and `unsetVariable` change them; `getEnv()` is the exported
strings and `getParams()` the rest, as before. `BASH_ALIASES` is the alias table
and `BASH_CMDS` the hash table, as in bash.

A name reference (`declare -n`, `local -n ref=$1`) reads and assigns what it
refers to. One that leads round in a circle warns `circular name reference`, as
bash does, and in a function reads and assigns the shell's variable of that name.

`time [-p] pipeline` reports on the shell's stderr in `TIMEFORMAT`, or POSIX's
format after `-p`; the CPU times, its own and `times`', come from the optional
`cpuTimes` callback on `ShellIf`, and are zero without one. `coproc [NAME] command`
runs the command as a job with a pipe each way, the shell's ends under high
descriptors in `NAME[0]` (read) and `NAME[1]` (write): closing `NAME[1]`, or the
shell ending, is the end of the command's input.

A script is read as bash reads one, a command at a time: an `alias` or `set -o
posix` applies from the next line on, and the complete commands before a
syntax error run before it is reported.

`cmd 3<file` opens descriptor 3 for that command alone; `exec 3<file` for the
shell. `{name}<file` picks a free descriptor from 10 up, puts its number in
`name` and leaves it open, as bash does; `{name}>&-` closes it.

Pathname expansion is the executor's own when the host lists directories
(`readDirectory` on `ShellIf`): what a word quoted matches itself — `"$dir"/*`
— while an unquoted expansion's glob characters glob, `pat='*.log'; rm $pat`;
`globstar`, `extglob`, `dotglob`, `nocaseglob`, `nullglob`, `failglob` and
`GLOBIGNORE` apply, and matches sort by bytes in the C locale, bash's default,
and as the locale collates otherwise. A host with only `resolvePath` is asked
for the matches instead.

`type`, `declare -f` and `set` print a function as bash does (`printFunction`),
from the source it was defined in. `export -f name` hands it to the commands the
shell runs as `BASH_FUNC_name%%`, the variable bash reads it back from; a host
starting a shell calls `importFunctions(ctx)` to define what its environment
carries.

## An interactive prompt

A host reading commands at a prompt gets bash's readline from the executor:
`LineEditor` takes the keys the terminal sends and edits the line with
readline's emacs keys over the shell's history (`C-r`, `C-o`, `M-.` and the
rest); the host draws `display(prompt)` and acts on what a key came to — a
line to run, the end of input, a Tab.

A Tab is `executor.completeTab(ctx, line, point, list)`, readline's completion
as bash sets it up: the matches come from the `complete` specification that
applies, or else bash's own — variable names after `$`, command names where a
command goes, file names — and go into the line as readline puts them there:
the one match quoted, with a `/` after a directory and a space after anything
else, or the prefix several share. The host hands the line back to the editor
with `completed(line, point)`; the Tab after one that changed nothing asks for
the list, which `matchColumns` lays out as readline does. Which entry is a
directory is the host's `readDirectory`'s say.

`startHistory(ctx)` reads HISTFILE as an interactive bash starts,
`appendHistory` adds what was run since to its end (`history -a`) and
`saveHistory` writes it as the shell ends; none of them touch a file unless the
context is interactive.

## Bash conformance

The executor and bash-parser are tested against GNU bash 5.2.21's own test suite: each of its `run-*` scripts runs
through the executor on a real host and its output is compared with what bash prints.
[`conformance/REPORT.md`](./conformance/REPORT.md) is the current state, and
[`conformance/README.md`](./conformance/README.md) explains how to run it and what the scores mean.

| Measure                                      | Result    |
| -------------------------------------------- | --------- |
| Test files that parse                        | 462 / 471 |
| `run-*` scripts passing                      | 59 / 83   |
| ...passing for real bash on the same machine | 74 / 83   |
| Mean share of the expected output produced   | 95%       |

### What works

These test scripts pass in full: arithmetic and `for (( ))`, indexed and associative arrays and `+=`, variable
attributes, brace expansion, `case`, case modification, `[[ ]]`, coprocesses, the directory stack, dynamic variables
(`RANDOM`, `SECONDS`, `LINENO`…), `set -e`, `set -x`, extended globs and `globstar`, functions, `getopts`, here-strings,
history and `!` expansion, IFS splitting, `lastpipe`, parameter expansion in all its forms, POSIX mode, operator
precedence, `printf`, quoting, redirections, `shopt`, tildes, `trap`, `type` and programmable completion. In the rest,
most of the output matches: the mean over all 83 is 95%.

### Where it differs from bash

- **A script is parsed one complete command at a time**, as bash reads it, but a few constructs bash-parser rejects
  outright: an alias whose value opens a comment (`alias c='# for x in '`), and a here-document begun inside `$( … )`
  whose body comes after the `)`. An alias that expands to a reserved word opening a compound command (`alias switch=case`)
  is not supported either.
- **Some syntax errors are found later than bash finds them**, or not at all, such as `a=(first & second)`.
- **Restricted mode** (`set -r`, `bash -r`) is not implemented.
- **`set -k`** (assignments anywhere on the command line) is not implemented, and an assignment after a redirection
  (`< /dev/null x=value`) is taken as a command name.
- **`$"…"`** (locale translation) keeps the `$` rather than dropping it.
- **Debugger support** (`extdebug`): `BASH_ARGV`, `BASH_ARGC` and some line numbers differ.
- **Process substitution** does not set `$!`, so `wait $!` after one fails.
- **Error messages** are bash's in most places, but some differ in wording or the line they name, and a few errors bash
  reports (around namerefs and readonly variables, for example) are not reported.

The rest of the failing tests come from the test host, `RealShell`, not from the executor:

- Pipes carry strings, so bytes that are not valid UTF-8 are replaced (`intl`, `mapfile`, `nquote4`).
- A child process gets only descriptors 0–2, and there is no controlling terminal for `read` from `/dev/tty`.
- Background jobs run, but job control (`jobs`, `fg`, signals to jobs) is the host's, and the test host has none
  (`jobs` times out).
- Errors the host prints, such as `command not found`, lack bash's `line N:` prefix.

## Contributing

Contributions are welcome! Please see the [`CONTRIBUTING.md`](./CONTRIBUTING.md) file for guidelines on how to contribute to this project.

## License

This project is licensed under the MIT License. See the [`LICENSE`](./LICENCE) file for more details.

## Contact

For questions or support, please open an issue on the [GitHub repository](https://github.com/mattiasrunge/bash-executor/issues).
