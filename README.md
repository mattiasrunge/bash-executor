# bash-executor

Execute bash AST nodes given by bash-parser.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Arrays and field splitting](#arrays-and-field-splitting)
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
itself. Here-strings (`read -a p <<< "$line"`) and process substitution
(`mapfile -t f < <(find .)`) both work; the latter needs the `tempFile` and
`removeTempFile` callbacks on `ShellIf`, since only the host knows what a command
can open.

## Contributing

Contributions are welcome! Please see the [`CONTRIBUTING.md`](./CONTRIBUTING.md) file for guidelines on how to contribute to this project.

## License

This project is licensed under the MIT License. See the [`LICENSE`](./LICENCE) file for more details.

## Contact

For questions or support, please open an issue on the [GitHub repository](https://github.com/mattiasrunge/bash-executor/issues).
