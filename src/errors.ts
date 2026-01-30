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
