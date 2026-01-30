/**
 * Arithmetic expression evaluator.
 *
 * This module provides functionality to evaluate arithmetic AST nodes
 * from bash-parser. It can be used by the executor and builtins like let.
 */

import type { AstArithmeticExpression, AstNode } from '@ein/bash-parser';
import type { ExecContextIf, ShellIf } from './types.ts';

/**
 * Options for the arithmetic evaluator.
 */
export type EvaluateArithmeticOptions = {
  /** Shell interface for command substitution support */
  shell?: ShellIf;
  /** Function to execute an AST node (for command substitution) */
  executeNode?: (node: AstNode, ctx: ExecContextIf) => Promise<number>;
  /** Use setEnv instead of setParams for variable assignment (for let builtin) */
  useEnvForAssignment?: boolean;
};

/**
 * Evaluates an arithmetic AST node.
 *
 * @param node - The AST node to evaluate
 * @param ctx - The execution context for variable resolution
 * @param options - Optional shell and executor for command substitution
 * @returns The numeric result of the arithmetic expression
 */
export async function evaluateArithmetic(
  node: AstArithmeticExpression | { type: 'CommandSubstitution'; commandAST: AstNode } | null | undefined,
  ctx: ExecContextIf,
  options?: EvaluateArithmeticOptions,
): Promise<number> {
  if (!node) {
    return 0;
  }

  switch (node.type) {
    case 'NumericLiteral':
      return node.value;

    case 'Identifier': {
      const params = {
        ...ctx.getEnv(),
        ...ctx.getParams(),
      };
      const value = params[node.name] || '0';
      return Number.parseInt(value, 10) || 0;
    }

    case 'UnaryExpression': {
      const arg = await evaluateArithmetic(node.argument, ctx, options);
      switch (node.operator) {
        case '-':
          return -arg;
        case '+':
          return +arg;
        case '!':
          return arg === 0 ? 1 : 0;
        case '~':
          return ~arg;
        default:
          throw new Error(`Unsupported unary operator: ${(node as { operator: string }).operator}`);
      }
    }

    case 'BinaryExpression': {
      const left = await evaluateArithmetic(node.left, ctx, options);
      const right = await evaluateArithmetic(node.right, ctx, options);
      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return right === 0 ? 0 : Math.trunc(left / right);
        case '%':
          return right === 0 ? 0 : left % right;
        case '**':
          return Math.pow(left, right);
        case '&':
          return left & right;
        case '|':
          return left | right;
        case '^':
          return left ^ right;
        case '<<':
          return left << right;
        case '>>':
          return left >> right;
        case '<':
          return left < right ? 1 : 0;
        case '>':
          return left > right ? 1 : 0;
        case '<=':
          return left <= right ? 1 : 0;
        case '>=':
          return left >= right ? 1 : 0;
        case '==':
          return left === right ? 1 : 0;
        case '!=':
          return left !== right ? 1 : 0;
        default:
          throw new Error(`Unsupported binary operator: ${(node as { operator: string }).operator}`);
      }
    }

    case 'LogicalExpression': {
      const left = await evaluateArithmetic(node.left, ctx, options);
      if (node.operator === '&&') {
        return left === 0 ? 0 : (await evaluateArithmetic(node.right, ctx, options)) === 0 ? 0 : 1;
      } else if (node.operator === '||') {
        return left !== 0 ? 1 : (await evaluateArithmetic(node.right, ctx, options)) !== 0 ? 1 : 0;
      }
      throw new Error(`Unsupported logical operator: ${node.operator}`);
    }

    case 'ConditionalExpression': {
      const test = await evaluateArithmetic(node.test, ctx, options);
      return test !== 0 ? await evaluateArithmetic(node.consequent, ctx, options) : await evaluateArithmetic(node.alternate, ctx, options);
    }

    case 'SequenceExpression': {
      let result = 0;
      for (const expr of node.expressions) {
        result = await evaluateArithmetic(expr, ctx, options);
      }
      return result;
    }

    case 'AssignmentExpression': {
      const varName = node.left.name;
      let value: number;

      if (node.operator === '=') {
        value = await evaluateArithmetic(node.right, ctx, options);
      } else {
        const currentValue = await evaluateArithmetic(node.left, ctx, options);
        const rightValue = await evaluateArithmetic(node.right, ctx, options);
        switch (node.operator) {
          case '+=':
            value = currentValue + rightValue;
            break;
          case '-=':
            value = currentValue - rightValue;
            break;
          case '*=':
            value = currentValue * rightValue;
            break;
          case '/=':
            value = rightValue === 0 ? 0 : Math.trunc(currentValue / rightValue);
            break;
          case '%=':
            value = rightValue === 0 ? 0 : currentValue % rightValue;
            break;
          case '&=':
            value = currentValue & rightValue;
            break;
          case '|=':
            value = currentValue | rightValue;
            break;
          case '^=':
            value = currentValue ^ rightValue;
            break;
          case '<<=':
            value = currentValue << rightValue;
            break;
          case '>>=':
            value = currentValue >> rightValue;
            break;
          default:
            throw new Error(`Unsupported assignment operator: ${(node as { operator: string }).operator}`);
        }
      }

      // Use setEnv for let builtin, setParams for executor
      if (options?.useEnvForAssignment) {
        ctx.setEnv({ [varName]: String(value) });
      } else {
        ctx.setParams({ [varName]: String(value) });
      }
      return value;
    }

    case 'UpdateExpression': {
      const varName = node.argument.name;
      const currentValue = await evaluateArithmetic(node.argument, ctx, options);
      const newValue = node.operator === '++' ? currentValue + 1 : currentValue - 1;
      // Use setEnv for let builtin, setParams for executor
      if (options?.useEnvForAssignment) {
        ctx.setEnv({ [varName]: String(newValue) });
      } else {
        ctx.setParams({ [varName]: String(newValue) });
      }
      return node.prefix ? newValue : currentValue;
    }

    case 'CommandSubstitution': {
      const cmdNode = node as { type: 'CommandSubstitution'; commandAST: AstNode };
      if (!cmdNode.commandAST || !options?.shell || !options?.executeNode) {
        return 0;
      }

      const cmdCtx = ctx.spawnContext();
      cmdCtx.setLocalEnv({ TERM: '0' });
      cmdCtx.redirectStdout(await options.shell.pipeOpen());

      try {
        await options.executeNode(cmdNode.commandAST, cmdCtx);
        await options.shell.pipeWrite(cmdCtx.getStdout(), '');
        const output = await options.shell.pipeRead(cmdCtx.getStdout());
        const trimmed = output.trim();
        return trimmed === '' ? 0 : Number.parseInt(trimmed, 10) || 0;
      } finally {
        options.shell.pipeRemove(cmdCtx.getStdout()).catch((err) => console.error('Failed to remove pipe from command substitution: ', err));
      }
    }

    default:
      throw new Error(`Unsupported arithmetic node type: ${(node as { type: string }).type}`);
  }
}
