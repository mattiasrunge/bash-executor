# bash-executor

Execute bash AST nodes given by bash-parser.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
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

## Contributing

Contributions are welcome! Please see the [`CONTRIBUTING.md`](./CONTRIBUTING.md) file for guidelines on how to contribute to this project.

## License

This project is licensed under the MIT License. See the [`LICENSE`](./LICENCE) file for more details.

## Contact

For questions or support, please open an issue on the [GitHub repository](https://github.com/mattiasrunge/bash-executor/issues).
