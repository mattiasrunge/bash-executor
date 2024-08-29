import {
  type AstNode,
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
    const ast = await parse(source, {
      // TODO: Evaluate if this is good enough or an external library should be used
      runArithmeticExpression: async (expression: string, _arithmeticAST: AstNode) => new Function(`return ${expression}`)().toString(),
    });

    return await this.executeNode(ast, ctx);
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
          ctx.redirectStderr(r.file.text);
        } else {
          ctx.redirectStdout(r.file.text);
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

  protected async executeScript(node: AstNodeScript, ctx: ExecContextIf): Promise<any> {
    for (const command of node.commands) {
      await this.executeNode(command, ctx);
    }
  }

  protected async executeCommand(node: AstNodeCommand, parentCtx: ExecContextIf): Promise<number> {
    // Create an execution context
    const ctx = parentCtx.spawnContext();

    // Update context with prefix assignments
    const params: Record<string, string> = {};

    for (const arg of node.prefix?.filter((arg) => arg.type === 'AssignmentWord') || []) {
      const { value, code } = await this.resolveExpansions(arg, ctx);

      if (code !== 0) {
        // TODO: Print error to stderr?
        return code;
      }

      const [k, v] = value.split('=');
      params[k] = v;
    }
    ctx.setParams(params);

    // There is no command name, nothing to execute
    if (!node?.name) {
      return 0;
    }

    // Create an args list
    const args: string[] = [];

    for (const arg of node.suffix?.filter((arg) => arg.type === 'Word') || []) {
      const { value, code } = await this.resolveExpansions(arg, ctx);

      if (code !== 0) {
        // TODO: Print error to stderr?
        return code;
      }

      args.push(value);
    }

    // Apply IO redirections
    this.applyRedirections(ctx, node.suffix?.filter((arg) => arg.type === 'Redirect'));

    // Execute command
    const code = await this.shell.execCommand(
      ctx,
      node.name.text,
      args || [],
      {
        async: node.async,
      },
    );

    return code;
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
    if (await this.executeNode(node.clause, ctx)) {
      return await this.executeNode(node.then, ctx);
    } else if (node.else) {
      return await this.executeNode(node.else, ctx);
    }

    return 0;
  }

  protected async executeWhile(node: AstNodeWhile, ctx: ExecContextIf): Promise<number> {
    while (await this.executeNode(node.clause, ctx)) {
      const code = await this.executeNode(node.do, ctx);

      if (code !== 0) {
        return code;
      }
    }

    return 0;
  }

  protected async executeUntil(node: AstNodeUntil, ctx: ExecContextIf): Promise<number> {
    while (!(await this.executeNode(node.clause, ctx))) {
      const code = await this.executeNode(node.do, ctx);

      if (code !== 0) {
        return code;
      }
    }

    return 0;
  }

  protected async executeFor(node: AstNodeFor, ctx: ExecContextIf): Promise<number> {
    for (const word of node.wordlist || []) {
      ctx.setParams({ [node.name.text]: word.text });

      const code = await this.executeNode(node.do, ctx);

      if (code !== 0) {
        return code;
      }
    }

    return 0;
  }

  protected async executeCase(node: AstNodeCase, ctx: ExecContextIf): Promise<any> {
    for (const caseItem of node.cases || []) {
      if (caseItem.pattern.some((pattern) => pattern.text === node.clause.text)) {
        await this.executeNode(caseItem.body, ctx);
        break;
      }
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

  protected async resolveExpansions(node: AstNodeWord | AstNodeAssignmentWord, ctx: ExecContextIf): Promise<{ value: string; code: number }> {
    if (!node.expansion || node.expansion.length === 0) {
      return { value: node.text, code: 0 };
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

          await this.shell.pipeClose(cmdCtx.getStdout());

          if (code !== 0) {
            return { value: rValue.text, code };
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
      }
    }

    let value = rValue.text;
    const result = utils.unquoteWord(value);

    if (result.values.length > 0) {
      value = utils.unescape(result.values[0]);
    }

    return { value, code: 0 };
  }
}
