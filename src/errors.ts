/**
 * Custom error types for bash-executor with source location information.
 */

// Re-export BashSyntaxError and location types from bash-parser
export { BashSyntaxError, type ErrorLocation, type ErrorPosition } from '@ein/bash-parser';

import type { ErrorPosition } from '@ein/bash-parser';

/**
 * Base error class for bash-executor errors with source location.
 */
export class BashExecutorError extends Error {
  /** Source location where the error occurred (matches bash-parser ErrorPosition format) */
  readonly location?: ErrorPosition;

  /** Original source code being executed */
  readonly source?: string;

  /** Error code for programmatic handling */
  readonly code: string;

  constructor(
    message: string,
    options: {
      code: string;
      location?: ErrorPosition;
      source?: string;
    },
  ) {
    super(message);
    this.name = 'BashExecutorError';
    this.code = options.code;
    this.location = options.location;
    this.source = options.source;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Get a code snippet showing the error location.
   * Returns undefined if source is not available.
   */
  getCodeSnippet(contextLines: number = 2): string | undefined {
    if (!this.source || !this.location) {
      return undefined;
    }

    const lines = this.source.split('\n');

    // Compute row and col from char offset if missing
    let errorLine = this.location.row;
    let errorCol = this.location.col;
    if ((errorLine === undefined || errorCol === undefined) && this.location.char !== undefined) {
      const computed = this.computePosition(this.location.char);
      errorLine = errorLine ?? computed.row;
      errorCol = errorCol ?? computed.col;
    }

    if (!errorLine || errorLine < 1 || errorLine > lines.length) {
      return undefined;
    }

    const startLine = Math.max(1, errorLine - contextLines);
    const endLine = Math.min(lines.length, errorLine + contextLines);

    const snippetLines: string[] = [];
    const lineNumWidth = String(endLine).length;

    for (let i = startLine; i <= endLine; i++) {
      const lineNum = String(i).padStart(lineNumWidth, ' ');
      const prefix = i === errorLine ? '>' : ' ';
      snippetLines.push(`${prefix} ${lineNum} | ${lines[i - 1]}`);

      if (i === errorLine && errorCol !== undefined) {
        const pointer = ' '.repeat(lineNumWidth + 4 + errorCol - 1) + '^';
        snippetLines.push(pointer);
      }
    }

    return snippetLines.join('\n');
  }

  /**
   * Compute row (1-indexed) and col (1-indexed) from char offset (0-indexed).
   */
  private computePosition(char: number): { row: number; col: number } {
    let row = 1;
    let col = 1;
    for (let i = 0; i < char && i < this.source!.length; i++) {
      if (this.source![i] === '\n') {
        row++;
        col = 1;
      } else {
        col++;
      }
    }
    return { row, col };
  }
}

/**
 * Error thrown when an unknown AST node type is encountered.
 */
export class UnknownNodeTypeError extends BashExecutorError {
  readonly nodeType: string;

  constructor(nodeType: string, location?: ErrorPosition, source?: string) {
    super(`Unknown node type: ${nodeType}`, {
      code: 'E_UNKNOWN_NODE_TYPE',
      location,
      source,
    });
    this.name = 'UnknownNodeTypeError';
    this.nodeType = nodeType;
  }
}

/**
 * Error thrown for unsupported operators.
 */
export class UnsupportedOperatorError extends BashExecutorError {
  readonly operator: string;
  readonly operatorType: 'logical' | 'unary' | 'binary' | 'assignment';

  constructor(
    operator: string,
    operatorType: 'logical' | 'unary' | 'binary' | 'assignment',
    location?: ErrorPosition,
    source?: string,
  ) {
    super(`Unsupported ${operatorType} operator: ${operator}`, {
      code: `E_UNSUPPORTED_${operatorType.toUpperCase()}_OPERATOR`,
      location,
      source,
    });
    this.name = 'UnsupportedOperatorError';
    this.operator = operator;
    this.operatorType = operatorType;
  }
}

/**
 * Error thrown for unsupported arithmetic expression types.
 */
export class UnsupportedArithmeticNodeError extends BashExecutorError {
  readonly arithmeticNodeType: string;

  constructor(nodeType: string, location?: ErrorPosition, source?: string) {
    super(`Unsupported arithmetic node type: ${nodeType}`, {
      code: 'E_UNSUPPORTED_ARITHMETIC_NODE',
      location,
      source,
    });
    this.name = 'UnsupportedArithmeticNodeError';
    this.arithmeticNodeType = nodeType;
  }
}

/**
 * Error thrown when `set -u` meets a parameter that is not set, and when
 * `${x:?message}` is asked to complain.
 *
 * It carries no location because it is not a defect in the script the way the
 * others here are — it is a shell diagnostic, and the shell prints it and takes
 * the status. `executeScript` catches it, which is also what scopes it to a
 * command substitution: that parses to a Script of its own, so `$(echo $NOPE)`
 * dies and the shell around it carries on, as in bash.
 */
export class UnboundVariableError extends BashExecutorError {
  readonly parameter: string;

  constructor(parameter: string, message = 'unbound variable') {
    super(`${parameter}: ${message}`, { code: 'E_UNBOUND_VARIABLE' });
    this.name = 'UnboundVariableError';
    this.parameter = parameter;
  }
}

/**
 * An error that ends the command the shell is running, as bash's jump back to
 * its top level does: the rest of the line the command is on is dropped, the
 * status is 1, and the script carries on with the next line. A subshell — `( )`,
 * a pipeline stage, `$( )` — is a top level of its own.
 */
export class CommandAbortError extends BashExecutorError {}

/**
 * An arithmetic expression that is not one once expanded: `$(( 1 + ))`,
 * `(( a b ))`. Bash checks arithmetic only when it runs, so this is a run-time
 * failure, status 1; `((` and `let` fail, an expansion aborts its command.
 */
export class ArithmeticSyntaxError extends CommandAbortError {
  readonly expression: string;

  constructor(expression: string, detail: string) {
    super(`${expression}: syntax error: ${detail}`, { code: 'E_ARITHMETIC_SYNTAX' });
    this.name = 'ArithmeticSyntaxError';
    this.expression = expression;
  }
}

/**
 * An arithmetic expression that cannot be evaluated: `1/0`. The evaluator
 * knows where in the expression it went wrong, not the expression's text;
 * whoever has the text adds it with `in`, and the message is bash's:
 * `10/(1-1): division by 0 (error token is "(1-1)")`.
 */
export class ArithmeticError extends CommandAbortError {
  constructor(readonly reason: string, readonly at?: number, readonly expression?: string) {
    super(ArithmeticError.describe(reason, at, expression), { code: 'E_ARITHMETIC' });
    this.name = 'ArithmeticError';
  }

  /** Said without the command's name, `((: `, as bash says an error in evaluating a subscript. */
  nameless = false;

  private static describe(reason: string, at?: number, expression?: string): string {
    if (expression === undefined) {
      return reason;
    }

    const token = at === undefined ? '' : ` (error token is "${expression.slice(at)}")`;

    return `${expression}: ${reason}${token}`;
  }

  /** The same error, told which expression it was in — offsets relative to it. */
  in(expression: string): ArithmeticError {
    return this.expression === undefined ? new ArithmeticError(this.reason, this.at, expression) : this;
  }
}

/** A pattern that matched no file under `shopt -s failglob`: `no match: q*`. */
export class GlobNoMatchError extends CommandAbortError {
  constructor(readonly pattern: string) {
    super(`no match: ${pattern}`, { code: 'E_GLOB_NO_MATCH' });
    this.name = 'GlobNoMatchError';
  }
}

/** An assignment to a readonly variable: `x: readonly variable`. */
export class ReadonlyVariableError extends CommandAbortError {
  constructor(readonly variable: string) {
    super(`${variable}: readonly variable`, { code: 'E_READONLY' });
    this.name = 'ReadonlyVariableError';
  }
}

/**
 * Error thrown when `set -C` refuses to let `>` truncate a file that is there.
 *
 * Like `UnboundVariableError` this is a diagnostic rather than a defect: the
 * command it belongs to fails with status 1 and the shell carries on, so it is
 * caught where redirections are applied.
 */
/**
 * A redirection that could not be made: `< missing`, `> /no/dir/x`. It fails
 * the one command it was for, which does not run, with status 1.
 */
export class RedirectionError extends BashExecutorError {
  constructor(message: string, code = 'E_REDIRECTION') {
    super(message, { code });
    this.name = 'RedirectionError';
  }
}

export class NoClobberError extends RedirectionError {
  readonly path: string;

  constructor(path: string) {
    super(`${path}: cannot overwrite existing file`, 'E_NO_CLOBBER');
    this.name = 'NoClobberError';
    this.path = path;
  }
}
