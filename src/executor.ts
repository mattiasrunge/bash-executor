import {
  type AstArithmeticExpression,
  type AstNode,
  type AstNodeArithmeticCommand,
  type AstNodeAssignmentWord,
  type AstNodeCase,
  type AstNodeCommand,
  type AstNodeCompoundList,
  type AstNodeFor,
  type AstNodeFunction,
  type AstNodeIf,
  type AstNodeLogicalExpression,
  type AstNodePipeline,
  type AstNodeRedirect,
  type AstNodeScript,
  type AstNodeSubshell,
  type AstNodeUntil,
  type AstNodeWhile,
  type AstNodeWord,
  parse,
  utils,
} from '@ein/bash-parser';
import type { ExecContextIf, ShellIf } from './types.ts';

const CONTINUE_CODE = -10 as const;
const BREAK_CODE = -11 as const;

/**
 * Class responsible for executing AST nodes parsed from shell scripts.
 */
export class AstExecutor {
  private shell: ShellIf;

  constructor(shell: ShellIf) {
    this.shell = shell;
  }

  /**
   * Executes a shell script source code.
   * @param {string} source - The shell script source code.
   * @param {ExecContextIf} ctx - The execution context.
   * @returns {Promise<number>} - The exit code of the executed script.
   */
  public async execute(source: string, ctx: ExecContextIf): Promise<number> {
    try {
      // Resolvers given here will be evaluated at parse time.
      // Most things we want to evaluate at execution time and
      // that is instead done during execution with resolveExpansions.
      const ast = await parse(source, {
        resolveAlias: async (name: string) => ctx.getAlias(name),

        resolveHomeUser: this.shell.resolveHomeUser ? (async (username: string | null) => this.shell.resolveHomeUser!(username, ctx)) : undefined,
      });

      return await this.executeNode(ast, ctx);
    } catch (e) {
      // console.error('executer', e);
      throw e;
    }
  }

  /**
   * Executes an AST node based on its type.
   * @param {AstNode} node - The AST node to execute.
   * @param {ExecContextIf} ctx - The execution context.
   * @returns {Promise<number>} - The exit code of the executed node.
   */
  public async executeNode(node: AstNode, ctx: ExecContextIf): Promise<number> {
    switch (node.type) {
      case 'Script':
        return this.executeScript(node as AstNodeScript, ctx);
      case 'Command':
        return this.executeCommand(node as AstNodeCommand, ctx);
      case 'Function':
        return this.registerFunction(node as AstNodeFunction, ctx);
      case 'If':
        return this.executeIf(node as AstNodeIf, ctx);
      case 'While':
        return this.executeWhile(node as AstNodeWhile, ctx);
      case 'Until':
        return this.executeUntil(node as AstNodeUntil, ctx);
      case 'For':
        return this.executeFor(node as AstNodeFor, ctx);
      case 'Case':
        return this.executeCase(node as AstNodeCase, ctx);
      case 'Subshell':
        return this.executeSubshell(node as AstNodeSubshell, ctx);
      case 'Pipeline':
        return this.executePipeline(node as AstNodePipeline, ctx);
      case 'LogicalExpression':
        return this.executeLogicalExpression(node as AstNodeLogicalExpression, ctx);
      case 'CompoundList':
        return this.executeCompondList(node as AstNodeCompoundList, ctx);
      case 'ArithmeticCommand':
        return this.executeArithmeticCommand(node as AstNodeArithmeticCommand, ctx);
      default:
        throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  protected applyRedirections(ctx: ExecContextIf, redirects?: AstNodeRedirect[]) {
    for (const r of (redirects || [])) {
      if (r.op.text === '<') {
        ctx.redirectStdin(r.file.text);
      } else if (r.op.text === '>') {
        if (r.numberIo?.text === '2') {
          ctx.redirectStderr(r.file.text);
        } else {
          ctx.redirectStdout(r.file.text);
        }
      } else if (r.op.text === '>>') {
        // TODO: Implement append redirection
        if (r.numberIo?.text === '2') {
          ctx.redirectStderr(r.file.text, true);
        } else {
          ctx.redirectStdout(r.file.text, true);
        }
      } else if (r.op.text === '>&') {
        if (r.numberIo?.text === '2') {
          ctx.redirectStderr(r.file.text);
        } else {
          ctx.redirectStdout(r.file.text);
        }
      }
    }
  }

  protected async executeScript(node: AstNodeScript, ctx: ExecContextIf): Promise<number> {
    for (const command of node.commands) {
      const exitCode = await this.executeNode(command, ctx);

      if (exitCode !== 0) {
        return exitCode;
      }
    }

    return 0;
  }

  protected async executeCommand(node: AstNodeCommand, parentCtx: ExecContextIf): Promise<number> {
    // Create an execution context
    const ctx = parentCtx.spawnContext();

    // Update context with prefix assignments
    const params: Record<string, string> = {};

    for (const arg of node.prefix?.filter((arg) => arg.type === 'AssignmentWord') || []) {
      const { values, code } = await this.resolveExpansions(arg, ctx);

      if (code !== 0) {
        // TODO: Print error to stderr?
        return code;
      }

      for (const value of values) {
        const [k, v] = value.split('=');
        params[k] = v;
      }
    }
    ctx.setParams(params);

    // There is no command name, nothing to execute
    if (!node?.name) {
      return 0;
    }

    // Create an args list
    const args: string[] = [];

    for (const arg of node.suffix?.filter((arg) => arg.type === 'Word') || []) {
      const { values, code } = await this.resolveExpansions(arg, ctx);

      if (code !== 0) {
        // TODO: Print error to stderr?
        return code;
      }

      args.push(...values);
    }

    // Apply IO redirections
    this.applyRedirections(ctx, node.suffix?.filter((arg) => arg.type === 'Redirect'));

    // Expand command
    const expandedName = await this.resolveExpansions(node.name, ctx);

    if (expandedName.code !== 0) {
      return expandedName.code;
    }

    // TODO: We can fail for any number of things above, should we apply the bang inversion to those as well?

    // Execute command
    const code = await this.shell.execCommand(
      ctx,
      expandedName.values[0], // TODO: Can we expand to more than one value here?
      args || [],
      {
        async: node.async,
      },
    );

    return node.bang ? (code === 0 ? 1 : 0) : code;
  }

  protected async executeSubshell(node: AstNodeSubshell, ctx: ExecContextIf): Promise<number> {
    // TODO: Handle redirections
    return this.shell.execSubshell(ctx, node.list, { async: node.async });
  }

  protected async executePipeline(node: AstNodePipeline, ctx: ExecContextIf): Promise<number> {
    const pipes: string[] = [];
    const executions: Promise<number>[] = [];
    let lastCtx: ExecContextIf | null = null;

    try {
      for (let n = 0; n < node.commands.length; n++) {
        // Create a new context for the command
        const cmdCtx = ctx.spawnContext();

        // If not the first command redirect stdin from the last command
        lastCtx && cmdCtx.redirectStdin(lastCtx.getStdout());

        // If not the last command create a pipe and make it stdout
        let stdoutRedirected = false;
        if (n < node.commands.length - 1) {
          const pipe = await this.shell.pipeOpen();
          pipes.push(pipe);

          cmdCtx.setLocalEnv({ IS_TTY: '0' });
          cmdCtx.redirectStdout(pipe);
          stdoutRedirected = true;
        }

        executions.push(
          this.shell.execSubshell(cmdCtx, node.commands[n], {}).finally(() => {
            if (stdoutRedirected) {
              this.shell.pipeClose(cmdCtx.getStdout()).catch((err) => console.error('Failed to close pipe: ', err));
            }
          }),
        );

        lastCtx = cmdCtx;
      }

      const codes = await Promise.all(executions);
      return codes[codes.length - 1];
    } finally {
      for (const pipe of pipes) {
        this.shell.pipeRemove(pipe).catch((err) => console.error('Failed to remove pipe: ', err));
      }
    }
  }

  protected async executeCompondList(node: AstNodeCompoundList, parentCtx: ExecContextIf): Promise<number> {
    const ctx = parentCtx.spawnContext();
    this.applyRedirections(ctx, node.redirections);

    for (const command of node.commands) {
      const code = await this.executeNode(command, ctx);

      if (code !== 0) {
        return code;
      }
    }

    return 0;
  }

  protected async registerFunction(node: AstNodeFunction, parentCtx: ExecContextIf): Promise<number> {
    const ctx = parentCtx.spawnContext();
    this.applyRedirections(ctx, node.redirections);
    parentCtx.setFunction(node.name.text, node.body, ctx);

    return 0;
  }

  protected async executeIf(node: AstNodeIf, ctx: ExecContextIf): Promise<number> {
    if (await this.executeNode(node.clause, ctx) === 0) {
      return await this.executeNode(node.then, ctx);
    } else if (node.else) {
      return await this.executeNode(node.else, ctx);
    }

    return 0;
  }

  protected async executeWhile(node: AstNodeWhile, ctx: ExecContextIf): Promise<number> {
    while (await this.executeNode(node.clause, ctx) === 0) {
      const code = await this.executeNode(node.do, ctx);

      if (code === BREAK_CODE) {
        return 0;
      }

      if (code === CONTINUE_CODE) {
        continue;
      }

      if (code !== 0) {
        return code;
      }
    }

    return 0;
  }

  protected async executeUntil(node: AstNodeUntil, ctx: ExecContextIf): Promise<number> {
    while (await this.executeNode(node.clause, ctx) !== 0) {
      const code = await this.executeNode(node.do, ctx);

      if (code === BREAK_CODE) {
        return 0;
      }

      if (code === CONTINUE_CODE) {
        continue;
      }

      if (code !== 0) {
        return code;
      }
    }

    return 0;
  }

  protected async executeFor(node: AstNodeFor, ctx: ExecContextIf): Promise<number> {
    for (const word of node.wordlist || []) {
      const expanded = await this.resolveExpansions(word, ctx);

      if (expanded.code !== 0) {
        return expanded.code;
      }

      for (const value of expanded.values) {
        ctx.setParams({ [node.name.text]: value });

        const code = await this.executeNode(node.do, ctx);

        if (code === BREAK_CODE) {
          return 0;
        }

        if (code === CONTINUE_CODE) {
          continue;
        }

        if (code !== 0) {
          return code;
        }
      }
    }

    return 0;
  }

  protected async executeCase(node: AstNodeCase, ctx: ExecContextIf): Promise<number> {
    // Expand the clause value
    const clauseExpanded = await this.resolveExpansions(node.clause, ctx);
    if (clauseExpanded.code !== 0) {
      return clauseExpanded.code;
    }
    const clauseValue = clauseExpanded.values[0] || '';

    for (const caseItem of node.cases || []) {
      // Check if any pattern matches
      const matched = caseItem.pattern.some((pattern) => {
        // Expand the pattern
        const patternText = pattern.text;
        // Convert glob pattern to regex
        return this.matchGlobPattern(patternText, clauseValue);
      });

      if (matched) {
        return await this.executeNode(caseItem.body, ctx);
      }
    }

    return 0;
  }

  /**
   * Matches a glob pattern against a value.
   * Supports *, ?, and character classes.
   */
  protected matchGlobPattern(pattern: string, value: string): boolean {
    // Convert glob pattern to regex
    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      switch (c) {
        case '*':
          regex += '.*';
          break;
        case '?':
          regex += '.';
          break;
        case '[': {
          // Find the closing bracket
          const end = pattern.indexOf(']', i + 1);
          if (end !== -1) {
            regex += pattern.slice(i, end + 1);
            i = end;
          } else {
            regex += '\\[';
          }
          break;
        }
        case '\\':
        case '^':
        case '$':
        case '.':
        case '+':
        case '(':
        case ')':
        case '{':
        case '}':
        case '|':
          regex += '\\' + c;
          break;
        default:
          regex += c;
      }
    }
    regex += '$';

    try {
      return new RegExp(regex).test(value);
    } catch {
      // If regex is invalid, fall back to exact match
      return pattern === value;
    }
  }

  protected async executeLogicalExpression(node: AstNodeLogicalExpression, ctx: ExecContextIf): Promise<number> {
    const left = await this.executeNode(node.left, ctx);

    if (node.op === 'and') {
      if (left !== 0) {
        return left;
      }
    } else if (node.op === 'or') {
      if (left === 0) {
        return left;
      }
    } else {
      throw new Error(`Unsupported logical operator: ${node.op}`);
    }

    return await this.executeNode(node.right, ctx);
  }

  protected async executeArithmeticCommand(node: AstNodeArithmeticCommand, ctx: ExecContextIf): Promise<number> {
    const result = await this.evaluateArithmetic(node.arithmeticAST, ctx);
    // In bash, (( expr )) returns 0 (success) if expr is non-zero, 1 (failure) if expr is zero
    return result !== 0 ? 0 : 1;
  }

  protected async resolveExpansions(node: AstNodeWord | AstNodeAssignmentWord, ctx: ExecContextIf): Promise<{ values: string[]; code: number }> {
    if (!node.expansion || node.expansion.length === 0) {
      let code = 0;
      if (node.type === 'Word') {
        if (node.text === 'continue') {
          code = CONTINUE_CODE;
        } else if (node.text === 'break') {
          code = BREAK_CODE;
        }
      }

      // Process escape sequences even when there are no expansions
      // Note: Don't use unquoteWord here - quotes are already processed by the parser
      return { values: [utils.unescape(node.text)], code };
    }

    const rValue = new utils.ReplaceString(node.text);

    for (const xp of node.expansion) {
      if (xp.resolved) {
        continue;
      }

      if (xp.type === 'ParameterExpansion') {
        // TODO: Handle kind and op word if needed
        const params = {
          ...await ctx.getEnv(),
          ...await ctx.getParams(),
        };

        rValue.replace(
          xp.loc!.start,
          xp.loc!.end + 1,
          params[xp.parameter!] || '',
        );
      } else if (xp.type === 'CommandExpansion') {
        const cmdCtx = ctx.spawnContext();
        cmdCtx.setLocalEnv({ IS_TTY: '0' });
        cmdCtx.redirectStdout(await this.shell.pipeOpen());

        try {
          const code = await this.executeNode(xp.commandAST, cmdCtx);

          // Send EOF so reads does not block
          await this.shell.pipeWrite(cmdCtx.getStdout(), '');
          // await this.shell.pipeClose(cmdCtx.getStdout());

          if (code !== 0) {
            return { values: [rValue.text], code };
          }

          const output = await this.shell.pipeRead(cmdCtx.getStdout());

          rValue.replace(
            xp.loc!.start,
            xp.loc!.end + 1,
            output,
          );
        } finally {
          this.shell.pipeRemove(cmdCtx.getStdout()).catch((err) => console.error('Failed to remove pipe from command expansion: ', err));
        }
      } else if (xp.type === 'ArithmeticExpansion') {
        const result = await this.evaluateArithmetic(xp.arithmeticAST, ctx);

        rValue.replace(
          xp.loc!.start,
          xp.loc!.end + 1,
          String(result),
        );
      }
    }

    const hasPathExpansion = node.expansion.some((xp) => xp.type === 'PathExpansion' && !xp.resolved);
    const value = rValue.text;
    const unquotedResult = utils.unquoteWord(value);
    let result = { values: [value], code: 0 };

    if (unquotedResult.values.length > 0) {
      result = { values: unquotedResult.values.map(utils.unescape), code: 0 };
    }

    // Path globbing expansion must be done last
    if (hasPathExpansion && this.shell.resolvePath) {
      const newValues: string[] = [];

      for (const path of result.values) {
        newValues.push(...(await this.shell.resolvePath(path, ctx)));
      }

      result.values = newValues;
    }

    return result;
  }

  /**
   * Evaluates a arithmetic AST node.
   * @param node - The AST node to evaluate
   * @param ctx - The execution context for variable resolution
   * @returns The numeric result of the arithmetic expression
   */
  protected async evaluateArithmetic(node: AstArithmeticExpression | { type: 'CommandSubstitution'; commandAST: AstNode }, ctx: ExecContextIf): Promise<number> {
    if (!node) {
      return 0;
    }

    switch (node.type) {
      case 'NumericLiteral':
        return node.value;

      case 'Identifier': {
        const params = {
          ...await ctx.getEnv(),
          ...await ctx.getParams(),
        };
        const value = params[node.name] || '0';
        return parseInt(value, 10) || 0;
      }

      case 'UnaryExpression': {
        const arg = await this.evaluateArithmetic(node.argument, ctx);
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
            throw new Error(`Unsupported unary operator: ${(node as unknown as { operator: string }).operator}`);
        }
      }

      case 'BinaryExpression': {
        const left = await this.evaluateArithmetic(node.left, ctx);
        const right = await this.evaluateArithmetic(node.right, ctx);
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
            throw new Error(`Unsupported binary operator: ${(node as unknown as { operator: string }).operator}`);
        }
      }

      case 'LogicalExpression': {
        const left = await this.evaluateArithmetic(node.left, ctx);
        if (node.operator === '&&') {
          return left === 0 ? 0 : (await this.evaluateArithmetic(node.right, ctx)) === 0 ? 0 : 1;
        } else if (node.operator === '||') {
          return left !== 0 ? 1 : (await this.evaluateArithmetic(node.right, ctx)) !== 0 ? 1 : 0;
        }
        throw new Error(`Unsupported logical operator: ${node.operator}`);
      }

      case 'ConditionalExpression': {
        const test = await this.evaluateArithmetic(node.test, ctx);
        return test !== 0 ? await this.evaluateArithmetic(node.consequent, ctx) : await this.evaluateArithmetic(node.alternate, ctx);
      }

      case 'SequenceExpression': {
        let result = 0;
        for (const expr of node.expressions) {
          result = await this.evaluateArithmetic(expr, ctx);
        }
        return result;
      }

      case 'AssignmentExpression': {
        const varName = node.left.name;
        let value: number;

        if (node.operator === '=') {
          value = await this.evaluateArithmetic(node.right, ctx);
        } else {
          const currentValue = await this.evaluateArithmetic(node.left, ctx);
          const rightValue = await this.evaluateArithmetic(node.right, ctx);
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
              throw new Error(`Unsupported assignment operator: ${(node as unknown as { operator: string }).operator}`);
          }
        }

        ctx.setParams({ [varName]: String(value) });
        return value;
      }

      case 'UpdateExpression': {
        const varName = node.argument.name;
        const currentValue = await this.evaluateArithmetic(node.argument, ctx);
        const newValue = node.operator === '++' ? currentValue + 1 : currentValue - 1;
        ctx.setParams({ [varName]: String(newValue) });
        return node.prefix ? newValue : currentValue;
      }

      case 'CommandSubstitution': {
        const cmdNode = node as { type: 'CommandSubstitution'; commandAST: AstNode };
        if (!cmdNode.commandAST) {
          return 0;
        }
        const cmdCtx = ctx.spawnContext();
        cmdCtx.setLocalEnv({ IS_TTY: '0' });
        cmdCtx.redirectStdout(await this.shell.pipeOpen());

        try {
          await this.executeNode(cmdNode.commandAST, cmdCtx);
          await this.shell.pipeWrite(cmdCtx.getStdout(), '');
          const output = await this.shell.pipeRead(cmdCtx.getStdout());
          const trimmed = output.trim();
          return trimmed === '' ? 0 : parseInt(trimmed, 10) || 0;
        } finally {
          this.shell.pipeRemove(cmdCtx.getStdout()).catch((err) => console.error('Failed to remove pipe from command substitution: ', err));
        }
      }

      default:
        throw new Error(`Unsupported arithmetic node type: ${(node as unknown as { type: string }).type}`);
    }
  }
}
