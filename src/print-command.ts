/**
 * A command turned back into text, the way bash prints it: `type f`,
 * `declare -f` and `set` show a function this way.
 *
 * A port of bash's print_cmd.c, quirks included, since scripts and tests
 * compare the output: `elif` comes back as a nested `else if`, the words keep
 * the quoting they were written with, and `$( … )` is printed from its parsed
 * command (bash 5.2 does that when it parses one).
 *
 * The words' own text comes from the source the AST was parsed from, through
 * each node's `loc`; without one, the quote-removed text is all there is.
 */

import {
  type AstCommandExpansion,
  type AstConditionalExpression,
  type AstNode,
  type AstNodeCase,
  type AstNodeCommand,
  type AstNodeCompoundList,
  type AstNodeFunction,
  type AstNodeIf,
  type AstNodeRedirect,
  type AstNodeWord,
  parse,
  utils,
} from '@ein/bash-parser';
import { decodeEscapedBytes } from './bytes.ts';
import type { FunctionDef } from './types.ts';

/** Where a function was defined: its node, and the text its `loc`s index into. */
export type FunctionDefinition = {
  node: AstNodeFunction;
  source?: string;
};

type Located = AstNode & { text?: string };

/** bash's `connection`: two commands and what joins them, `;` `\n` `&` `|` `&&` `||`. */
type Connection = {
  type: '#connection';
  first: Printable;
  connector: string;
  second?: Printable;
  bang?: boolean;
};

type Printable = AstNode | Connection;

/** A parsed `$( … )`, with the text its nodes' `loc`s index into. */
type Comsub = { ast: AstNode; source: string };

const RESERVED = new Set([
  '!',
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
  '{',
  '}',
  '[[',
  ']]',
]);

const INDENTATION_AMOUNT = 4;

const singleQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * `$'…'` as bash keeps it once parsed: the string it stands for, single-quoted.
 * Inside double quotes it is no quoting at all, and stays.
 */
function ansiCQuoted(text: string): string {
  let out = '';
  let inDouble = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '\\') {
      out += text.slice(i, i + 2);
      i++;
    } else if (c === '"') {
      inDouble = !inDouble;
      out += c;
    } else if (c === "'" && !inDouble) {
      const close = text.indexOf("'", i + 1);
      const end = close < 0 ? text.length : close + 1;
      out += text.slice(i, end);
      i = end - 1;
    } else if (c === '$' && text[i + 1] === "'" && !inDouble) {
      let end = i + 2;

      while (end < text.length && text[end] !== "'") end += text[end] === '\\' ? 2 : 1;

      const value = utils.unquoteWord(text.slice(i, end + 1)).values[0] ?? '';
      out += singleQuote(decodeEscapedBytes(value));
      i = end;
    } else {
      out += c;
    }
  }

  return out;
}

/** Every `$( … )` in the tree, parsed again with locations so its words can be printed as written. */
async function parseComsubs(node: unknown, found: Map<AstCommandExpansion, Comsub>): Promise<void> {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) await parseComsubs(item, found);
    return;
  }

  const record = node as Record<string, unknown>;

  if (record.type === 'CommandExpansion') {
    const xp = record as unknown as AstCommandExpansion;

    if (!found.has(xp)) {
      try {
        const ast = await parse(xp.command, { insertLOC: true });
        found.set(xp, { ast, source: xp.command });
        await parseComsubs(ast, found);
      } catch {
        // Printed as written
      }
    }

    return;
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'loc' && key !== 'commandAST' && key !== 'arithmeticAST') await parseComsubs(value, found);
  }
}

class CommandPrinter {
  private out = '';
  private indentation = 0;
  private skipThisIndent = 0;
  private insideFunctionDef = 0;
  private printingConnection = 0;
  private printingComsub = 0;
  private deferredHeredocs: AstNodeRedirect[] = [];
  private wasHeredoc = false;
  private indentationAmount = INDENTATION_AMOUNT;

  constructor(
    private source: string | undefined,
    private readonly comsubs: Map<AstCommandExpansion, Comsub>,
    private readonly posix: boolean,
  ) {}

  /**
   * named_function_string: `name () \n{ \n    body\n}` multiline, and with
   * no name and not multiline `() {  body\n}`, the form a function takes in
   * the environment.
   */
  functionString(name: string, body: AstNode, redirections: AstNodeRedirect[] | undefined, multiline: boolean): string {
    if (name) {
      if (RESERVED.has(name)) this.cprintf('function ');
      this.cprintf(`${name} `);
    }

    this.cprintf('() ');

    if (multiline) {
      this.cprintf('\n');
      this.indentation += this.indentationAmount;
    } else {
      this.indentation = 1;
      this.indentationAmount = 0;
    }

    this.insideFunctionDef++;
    this.cprintf(multiline ? '{ \n' : '{ ');

    const inner = this.functionBody(body, redirections);
    this.makeCommandString(inner.body);
    this.printDeferredHeredocs('');

    this.indentation = 0;
    this.indentationAmount = INDENTATION_AMOUNT;
    this.insideFunctionDef--;

    if (inner.redirections?.length) {
      this.newline('} ');
      this.printRedirectionList(inner.redirections);
    } else {
      this.newline('}');
      this.wasHeredoc = false;
    }

    return this.out;
  }

  /**
   * A function body, and the redirections printed after its closing brace.
   * Only a `{ … }` body is unwrapped; any other, `f() ( … )`, is printed
   * whole inside the braces, keeping the redirections, as bash does.
   */
  private functionBody(body: AstNode, redirections: AstNodeRedirect[] | undefined): { body?: Printable; redirections?: AstNodeRedirect[] } {
    if (body.type === 'CompoundList') return { body: this.bodyOf(body as AstNodeCompoundList), redirections };

    const own = (body as AstNode & { redirections?: AstNodeRedirect[] }).redirections ?? [];

    return { body: { ...body, redirections: [...own, ...(redirections ?? [])] } as AstNode };
  }

  // -- the text as it was written --------------------------------------------------------------

  /** A word as written, its `$( … )`s printed from their parsed commands. */
  private word(node: Located | undefined): string {
    if (!node) return '';

    const start = node.loc?.start?.char;
    const end = node.loc?.end?.char;
    let text = this.source !== undefined && start !== undefined && end !== undefined ? this.source.slice(start, end + 1) : node.text ?? '';

    const expansions = (node as AstNodeWord).expansion ?? [];
    let cursor = 0;

    for (const xp of expansions) {
      if (xp.type !== 'CommandExpansion') continue;

      const comsub = this.comsubs.get(xp);
      const written = `$(${xp.command})`;
      const at = text.indexOf(written, cursor);

      if (!comsub || at < 0) continue;

      const printed = `$(${this.printComsub(comsub)})`;
      text = text.slice(0, at) + printed + text.slice(at + written.length);
      cursor = at + printed.length;
    }

    return text.includes("$'") ? ansiCQuoted(text) : text;
  }

  /** The text of a node as written, when there is any. */
  private written(node: AstNode): string | undefined {
    const start = node.loc?.start?.char;
    const end = node.loc?.end?.char;

    return this.source !== undefined && start !== undefined && end !== undefined ? this.source.slice(start, end + 1) : undefined;
  }

  /** print_comsub: the command of a `$( … )`, keeping its newlines. */
  private printComsub(comsub: Comsub): string {
    const saved = { out: this.out, source: this.source, indentation: this.indentation, skip: this.skipThisIndent };
    const savedDef = this.insideFunctionDef;
    const savedConnection = this.printingConnection;
    const savedDeferred = this.deferredHeredocs;
    const savedWasHeredoc = this.wasHeredoc;

    this.out = '';
    this.source = comsub.source;
    this.indentation = 0;
    this.skipThisIndent = 0;
    this.insideFunctionDef = 0;
    this.printingConnection = 0;
    this.deferredHeredocs = [];
    this.wasHeredoc = false;
    this.printingComsub++;

    const commands = (comsub.ast as AstNodeCompoundList).commands ?? [];
    this.makeCommandString(this.listOf(commands));
    this.printDeferredHeredocs('');
    const printed = this.out;

    this.printingComsub--;
    this.out = saved.out;
    this.source = saved.source;
    this.indentation = saved.indentation;
    this.skipThisIndent = saved.skip;
    this.insideFunctionDef = savedDef;
    this.printingConnection = savedConnection;
    this.deferredHeredocs = savedDeferred;
    this.wasHeredoc = savedWasHeredoc;

    return printed;
  }

  // -- output ----------------------------------------------------------------------------------

  private cprintf(text: string): void {
    this.out += text;
  }

  private indent(amount: number): void {
    this.out += ' '.repeat(Math.max(0, amount));
  }

  private newline(text: string): void {
    this.cprintf('\n');
    this.indent(this.indentation);
    if (text) this.cprintf(text);
  }

  private semicolon(): void {
    if (this.out.endsWith('&') || this.out.endsWith('\n')) return;
    this.cprintf(';');
  }

  // -- lists -----------------------------------------------------------------------------------

  /**
   * A list as bash holds it: connections nested to the left, `a; b; c` being
   * `(a ; b) ; c`, and `a & b` joined by `&` instead of `;`.
   */
  private listOf(commands: AstNode[]): Printable | undefined {
    if (commands.length === 0) return undefined;

    let node: Printable = commands[0];

    for (let i = 1; i < commands.length; i++) {
      node = { type: '#connection', first: node, connector: this.separator(commands[i - 1], commands[i]), second: commands[i] };
    }

    if (commands[commands.length - 1].async) node = { type: '#connection', first: node, connector: '&' };

    return node;
  }

  /** What joined two commands of a list: `&` after one sent to the background, else a newline or `;` as written. */
  private separator(previous: AstNode, next: AstNode): string {
    if (previous.async) return '&';

    const end = previous.loc?.end?.row;
    const start = next.loc?.start?.row;

    return end !== undefined && start !== undefined && start > end ? '\n' : ';';
  }

  /** The commands of a compound command's body. */
  private bodyOf(list: AstNodeCompoundList | undefined): Printable | undefined {
    return list ? this.listOf(list.commands ?? []) : undefined;
  }

  // -- make_command_string_internal ------------------------------------------------------------

  private makeCommandString(command: Printable | undefined): void {
    if (!command) {
      this.cprintf('');
      return;
    }

    if (this.skipThisIndent) this.skipThisIndent--;
    else this.indent(this.indentation);

    const time = (command as AstNode).time;

    if (time) this.cprintf(time.posix ? 'time -p ' : 'time ');
    if ((command as { bang?: boolean }).bang) this.cprintf('! ');

    let redirects: AstNodeRedirect[] | undefined;

    switch (command.type) {
      case '#connection':
        this.printConnection(command as Connection);
        break;

      case 'LogicalExpression': {
        const node = command as AstNode & { op: 'and' | 'or'; left: AstNode; right: AstNode };
        this.printConnection({ type: '#connection', first: node.left, connector: node.op === 'and' ? '&&' : '||', second: node.right });
        break;
      }

      case 'Pipeline': {
        const commands = (command as AstNode & { commands: AstNode[] }).commands;
        let node: Printable = commands[0];

        for (const next of commands.slice(1)) node = { type: '#connection', first: node, connector: '|', second: next };

        if (node.type === '#connection') this.printConnection(node as Connection);
        else this.makeCommandString(node);
        break;
      }

      case 'Command':
        this.printSimpleCommand(command as AstNodeCommand);
        break;

      case 'Function':
        this.printFunctionDef(command as AstNodeFunction);
        break;

      case 'Coproc': {
        const node = command as AstNode & { name: string; body: AstNode };
        this.cprintf(`coproc ${node.name} `);
        this.skipThisIndent++;
        this.makeCommandString(node.body);
        break;
      }

      case 'CompoundList':
        this.printGroupCommand(command as AstNodeCompoundList);
        redirects = (command as AstNodeCompoundList).redirections;
        break;

      case 'Subshell': {
        const node = command as AstNode & { list: AstNodeCompoundList; redirections?: AstNodeRedirect[] };
        this.cprintf('( ');
        this.skipThisIndent++;
        this.makeCommandString(this.bodyOf(node.list));
        this.printDeferredHeredocs('');
        this.cprintf(' )');
        redirects = node.redirections ?? node.list.redirections;
        break;
      }

      case 'For':
      case 'Select': {
        const node = command as AstNode & { name: AstNodeWord; wordlist?: AstNodeWord[]; do: AstNodeCompoundList; redirections?: AstNodeRedirect[] };
        const words = node.wordlist ? node.wordlist.map((w) => this.word(w)).join(' ') : '"$@"';
        this.cprintf(`${command.type === 'For' ? 'for' : 'select'} ${node.name.text} in ${words}`);
        this.cprintf(';');
        this.newline('do\n');
        this.indentation += this.indentationAmount;
        this.makeCommandString(this.bodyOf(node.do));
        this.printDeferredHeredocs('');
        this.semicolon();
        this.indentation -= this.indentationAmount;
        this.newline('done');
        redirects = node.redirections;
        break;
      }

      case 'ArithmeticFor': {
        const node = command as AstNode & { do: AstNodeCompoundList; redirections?: AstNodeRedirect[] };
        this.cprintf(`for ((${this.arithForParts(command).join('; ')}))`);
        this.newline('do\n');
        this.indentation += this.indentationAmount;
        this.makeCommandString(this.bodyOf(node.do));
        this.printDeferredHeredocs('');
        this.semicolon();
        this.indentation -= this.indentationAmount;
        this.newline('done');
        redirects = node.redirections;
        break;
      }

      case 'Case':
        this.printCaseCommand(command as AstNodeCase);
        redirects = (command as AstNodeCase).redirections;
        break;

      case 'While':
      case 'Until': {
        const node = command as AstNode & { clause: AstNodeCompoundList; do: AstNodeCompoundList; redirections?: AstNodeRedirect[] };
        this.cprintf(`${command.type === 'While' ? 'while' : 'until'} `);
        this.skipThisIndent++;
        this.makeCommandString(this.bodyOf(node.clause));
        this.printDeferredHeredocs('');
        this.semicolon();
        this.cprintf(' do\n');
        this.indentation += this.indentationAmount;
        this.makeCommandString(this.bodyOf(node.do));
        this.printDeferredHeredocs('');
        this.indentation -= this.indentationAmount;
        this.semicolon();
        this.newline('done');
        redirects = node.redirections;
        break;
      }

      case 'If':
        this.printIfCommand(command as AstNodeIf);
        redirects = (command as AstNodeIf).redirections;
        break;

      case 'ArithmeticCommand': {
        const written = this.written(command);
        this.cprintf(written?.startsWith('((') ? written : `((${(command as AstNode & { expression: string }).expression}))`);
        break;
      }

      case 'ConditionalCommand': {
        this.cprintf('[[ ');
        this.printCondNode((command as AstNode & { conditionAST: AstConditionalExpression }).conditionAST);
        this.cprintf(' ]]');
        break;
      }

      default:
        this.cprintf(this.written(command) ?? '');
        break;
    }

    if (redirects?.length) {
      this.cprintf(' ');
      this.printRedirectionList(redirects);
    }
  }

  private printConnection(connection: Connection): void {
    this.skipThisIndent++;
    this.printingConnection++;
    this.makeCommandString(connection.first);

    const { connector, second } = connection;

    switch (connector) {
      case '&':
      case '|':
        this.printDeferredHeredocs(` ${connector}`);

        if (connector !== '&' || second) {
          this.cprintf(' ');
          this.skipThisIndent++;
        }
        break;

      case '&&':
      case '||':
        this.printDeferredHeredocs(` ${connector} `);
        if (second) this.skipThisIndent++;
        break;

      default: {
        // `;` or a newline
        const wasNewline = this.deferredHeredocs.length === 0 && !this.wasHeredoc && connector === '\n';

        if (this.deferredHeredocs.length === 0) {
          if (!this.wasHeredoc) this.cprintf(this.printingComsub ? connector : ';');
          else this.wasHeredoc = false;
        } else {
          this.printDeferredHeredocs(this.insideFunctionDef ? '' : ';');
        }

        if (this.insideFunctionDef) {
          this.cprintf('\n');
        } else if (this.printingComsub && connector === '\n' && !wasNewline) {
          this.cprintf('\n');
        } else {
          if (connector === ';') this.cprintf(' ');
          if (second) this.skipThisIndent++;
        }
      }
    }

    this.makeCommandString(second);
    this.printDeferredHeredocs('');
    this.printingConnection--;
  }

  private printSimpleCommand(command: AstNodeCommand): void {
    const words: string[] = [];
    const redirects: AstNodeRedirect[] = [];

    for (const item of command.prefix ?? []) {
      if (item.type === 'Redirect') redirects.push(item as AstNodeRedirect);
      else words.push(this.word(item));
    }

    if (command.name) words.push(this.word(command.name));

    for (const item of command.suffix ?? []) {
      if (item.type === 'Redirect') redirects.push(item as AstNodeRedirect);
      else words.push(this.word(item));
    }

    this.cprintf(words.join(' '));

    if (redirects.length) {
      if (words.length) this.cprintf(' ');
      this.printRedirectionList(redirects);
    }
  }

  private printFunctionDef(fn: AstNodeFunction): void {
    this.cprintf(this.posix ? `${fn.name.text} () \n` : `function ${fn.name.text} () \n`);
    this.indent(this.indentation);
    this.cprintf('{ \n');

    this.insideFunctionDef++;
    this.indentation += this.indentationAmount;

    const inner = this.functionBody(fn.body, fn.redirections);
    this.makeCommandString(inner.body);
    this.printDeferredHeredocs('');

    this.indentation -= this.indentationAmount;
    this.insideFunctionDef--;

    if (inner.redirections?.length) {
      this.newline('} ');
      this.printRedirectionList(inner.redirections);
    } else {
      this.newline('}');
      this.wasHeredoc = false;
    }
  }

  private printGroupCommand(group: AstNodeCompoundList): void {
    this.cprintf('{ ');

    if (this.insideFunctionDef === 0) {
      this.skipThisIndent++;
    } else {
      this.cprintf('\n');
      this.indentation += this.indentationAmount;
    }

    this.makeCommandString(this.bodyOf(group));
    this.printDeferredHeredocs('');

    if (this.insideFunctionDef) {
      this.cprintf('\n');
      this.indentation -= this.indentationAmount;
      this.indent(this.indentation);
    } else {
      this.semicolon();
      this.cprintf(' ');
    }

    this.cprintf('}');
  }

  private printCaseCommand(node: AstNodeCase): void {
    this.cprintf(`case ${this.word(node.clause)} in `);

    if (node.cases?.length) {
      this.indentation += this.indentationAmount;

      for (const item of node.cases) {
        this.newline('');
        this.cprintf(item.pattern.map((p) => this.word(p)).join(' | '));
        this.cprintf(')\n');
        this.indentation += this.indentationAmount;
        this.makeCommandString(this.bodyOf(item.body));
        this.indentation -= this.indentationAmount;
        this.printDeferredHeredocs('');
        this.newline(item.terminator ?? ';;');
      }

      this.indentation -= this.indentationAmount;
    }

    this.newline('esac');
  }

  private printIfCommand(node: AstNodeIf): void {
    this.cprintf('if ');
    this.skipThisIndent++;
    this.makeCommandString(this.bodyOf(node.clause));
    this.semicolon();
    this.cprintf(' then\n');
    this.indentation += this.indentationAmount;
    this.makeCommandString(this.bodyOf(node.then));
    this.printDeferredHeredocs('');
    this.indentation -= this.indentationAmount;

    if (node.else) {
      this.semicolon();
      this.newline('else\n');
      this.indentation += this.indentationAmount;
      // An `elif` is an `if` in the `else` (the parser's type does not say so), as in bash
      const other = node.else as AstNode;
      this.makeCommandString(other.type === 'If' ? other : this.bodyOf(node.else));
      this.printDeferredHeredocs('');
      this.indentation -= this.indentationAmount;
    }

    this.semicolon();
    this.newline('fi');
  }

  /**
   * The three parts of `for (( … ))` as bash keeps them: split at the `;`s,
   * leading blanks dropped and an empty part made `1`.
   */
  private arithForParts(node: AstNode): string[] {
    const written = this.written(node);
    const open = written?.indexOf('((') ?? -1;

    if (written === undefined || open < 0) {
      const parts = node as AstNode & Record<'init' | 'test' | 'update', { expression: string } | undefined>;
      return [parts.init, parts.test, parts.update].map((part) => part?.expression || '1');
    }

    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (let i = open + 2; i < written.length; i++) {
      const c = written[i];

      if (depth === 0 && c === ')' && written[i + 1] === ')') break;
      if (c === '(') depth++;
      if (c === ')') depth--;

      if (depth === 0 && c === ';') {
        parts.push(current);
        current = '';
      } else {
        current += c;
      }
    }

    parts.push(current);

    return parts.map((part) => part.replace(/^\s+/, '') || '1');
  }

  private printCondNode(node: AstConditionalExpression): void {
    switch (node.type) {
      case 'ConditionalNegation':
        this.cprintf('! ');
        this.printCondNode(node.argument);
        break;
      case 'ConditionalLogicalExpression':
        this.printCondNode(node.left);
        this.cprintf(` ${node.operator} `);
        this.printCondNode(node.right);
        break;
      case 'ConditionalUnaryExpression':
        this.cprintf(`${node.operator} `);
        this.printCondNode(node.argument);
        break;
      case 'ConditionalBinaryExpression':
        this.printCondNode(node.left);
        this.cprintf(` ${node.operator} `);
        this.printCondNode(node.right);
        break;
      case 'ConditionalWord':
        this.cprintf(this.word(node));
        break;
    }
  }

  // -- redirections ----------------------------------------------------------------------------

  private printRedirectionList(redirects: AstNodeRedirect[]): void {
    const heredocs: AstNodeRedirect[] = [];

    this.wasHeredoc = false;

    redirects.forEach((redirect, i) => {
      if (redirect.heredoc) {
        this.printHeredocHeader(redirect);
        heredocs.push(redirect);
      } else {
        this.printRedirection(redirect);
      }

      if (i < redirects.length - 1) this.cprintf(' ');
    });

    // The bodies follow the whole line: after the connector when there is one
    if (heredocs.length && this.printingConnection) {
      this.deferredHeredocs = heredocs;
    } else if (heredocs.length) {
      this.printHeredocBodies(heredocs);
    }
  }

  private printHeredocHeader(redirect: AstNodeRedirect): void {
    const fd = redirect.numberIo?.text;
    const eof = redirect.file.text;

    if (fd?.startsWith('{')) this.cprintf(fd);
    else if (fd !== undefined && fd !== '0') this.cprintf(fd);

    this.cprintf(`${redirect.op.text}${redirect.heredoc?.quoted ? singleQuote(eof) : eof}`);
  }

  private printHeredocBodies(heredocs: AstNodeRedirect[]): void {
    this.cprintf('\n');

    for (const heredoc of heredocs) {
      this.cprintf(`${heredoc.heredoc?.body ?? ''}${heredoc.file.text}`);
      this.cprintf('\n');
    }

    this.wasHeredoc = true;
  }

  private printDeferredHeredocs(connector: string): void {
    const printsConnector = connector !== '' && (connector[0] !== ';' || connector.length > 1);

    if (printsConnector) this.cprintf(connector);

    if (this.deferredHeredocs.length) {
      this.printHeredocBodies(this.deferredHeredocs);
      if (printsConnector) this.cprintf(' ');
      this.wasHeredoc = true;
    }

    this.deferredHeredocs = [];
  }

  private printRedirection(redirect: AstNodeRedirect): void {
    const op = redirect.op.text;
    const target = this.word(redirect.file);
    const fd = redirect.numberIo?.text;
    const varAssign = fd?.startsWith('{') ? fd : undefined;
    /** The redirector when it is not the one the operator implies. */
    const explicit = (implied: string) => varAssign ?? (fd !== undefined && fd !== implied ? fd : '');
    const numbered = (implied: string) => varAssign ?? fd ?? implied;

    switch (op) {
      case '<':
        this.cprintf(`${explicit('0')}< ${target}`);
        break;
      case '>':
        this.cprintf(`${explicit('1')}> ${target}`);
        break;
      case '>|':
        this.cprintf(`${explicit('1')}>| ${target}`);
        break;
      case '>>':
        this.cprintf(`${explicit('1')}>> ${target}`);
        break;
      case '<>': {
        // bash compares with 1 here, so `<> f` prints as `0<> f`
        const redirector = varAssign ?? fd ?? '0';
        this.cprintf(`${varAssign || redirector !== '1' ? redirector : ''}<> ${target}`);
        break;
      }
      case '<<<':
        this.cprintf(`${explicit('0')}<<< ${target}`);
        break;
      case '&>':
        this.cprintf(`&> ${target}`);
        break;
      case '&>>':
        this.cprintf(`&>> ${target}`);
        break;
      case '<&':
      case '>&': {
        const implied = op === '<&' ? '0' : '1';

        if (target === '-') {
          // r_close_this is printed with `>&` whichever way it was written
          this.cprintf(`${numbered(implied)}>&-`);
        } else if (/^\d+-?$/.test(target)) {
          this.cprintf(`${numbered(implied)}${op}${target}`);
        } else if (varAssign) {
          this.cprintf(`${varAssign}${op}${target}`);
        } else {
          this.cprintf(`${(fd ?? implied) === implied ? '' : fd}${op}${target}`);
        }
        break;
      }
      default:
        this.cprintf(`${fd ?? ''}${op} ${target}`);
    }
  }
}

/**
 * A function as `type` and `declare -f` print it: `name () \n{ \n    body\n}`.
 *
 * `posix` prints a function defined inside it as `name ()` rather than
 * `function name ()`, as bash does in posix mode.
 */
export async function printFunction(name: string, definition: FunctionDefinition, posix = false, multiline = true): Promise<string> {
  const comsubs = new Map<AstCommandExpansion, Comsub>();
  await parseComsubs(definition.node, comsubs);

  return new CommandPrinter(definition.source, comsubs, posix).functionString(name, definition.node.body, definition.node.redirections, multiline);
}

/** The definition of `fn`, or one made from its body when it was defined without a source. */
const definitionOf = (fn: FunctionDef): FunctionDefinition =>
  fn.definition ?? { node: { type: 'Function', name: { type: 'Word', text: fn.name, expansion: [] }, body: fn.body } };

/** A defined function as `type` and `declare -f` print it; one defined without its source prints its words unquoted. */
export async function functionText(fn: FunctionDef, posix = false): Promise<string> {
  return await printFunction(fn.name, definitionOf(fn), posix);
}

/**
 * The environment variable an exported function travels in to the commands
 * the shell runs, `BASH_FUNC_name%%`, as bash names it. It being set is what
 * makes the function exported.
 */
export const functionEnvName = (name: string): string => `BASH_FUNC_${name}%%`;

/** The name of the function `variable` carries, when it is a `BASH_FUNC_name%%` one. */
export const exportedFunctionName = (variable: string): string | undefined => /^BASH_FUNC_(.+)%%$/.exec(variable)?.[1];

/** A function as it goes in the environment: `() {  body\n}`. */
export async function exportedFunctionText(fn: FunctionDef): Promise<string> {
  return await printFunction('', definitionOf(fn), false, false);
}
