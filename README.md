# bash-executor

Execute bash AST nodes given by bash-parser.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Arrays and field splitting](#arrays-and-field-splitting)
- [Shell options](#shell-options)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

## Installation

```bash
deno add @ein/bash-executor
# or
jsr add @ein/bash-executor
```

## Usage

```ts
import { AstExecutor, ExecContext, ExecContextIf, ShellIf } from '@ein/bash-executor';

class Shell implements ShellIf {
  // Implement required methods...
}

const ctx: ExecContextIf = new ExecContext();
const shell: ShellIf = new Shell();
const executor = new AstExecutor();
const exitCode = await this.executor.execute('echo "Hello World"', ctx);
```

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

`type`, `declare -f` and `set` print a function as bash does (`printFunction`),
from the source it was defined in. `export -f name` hands it to the commands the
shell runs as `BASH_FUNC_name%%`, the variable bash reads it back from; a host
starting a shell calls `importFunctions(ctx)` to define what its environment
carries.

## Contributing

Contributions are welcome! Please see the [`CONTRIBUTING.md`](./CONTRIBUTING.md) file for guidelines on how to contribute to this project.

## License

This project is licensed under the MIT License. See the [`LICENSE`](./LICENCE) file for more details.

## Contact

For questions or support, please open an issue on the [GitHub repository](https://github.com/mattiasrunge/bash-executor/issues).
