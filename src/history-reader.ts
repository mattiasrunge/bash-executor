/**
 * What bash's parser knows, as it reads the next line of a command, that
 * history needs: whether the line goes on a quoted string or a here-document,
 * and what it should be joined to the command's history entry with
 * (parse.y's history_delimiting_chars), from the tokens before it.
 *
 * A small scanner of the command's text so far stands in for bash's parser
 * state; it knows quotes, substitutions, comments, here-documents and the
 * reserved words that decide the joining.
 */

type Token = { kind: 'word' | 'reserved' | 'op' | 'newline'; text: string };

/** What the lines read so far leave open for the next one. */
export type LineState = {
  /** The quote or substitution still open: `'`, `"`, `` ` ``, `)` or `}`; empty at top level */
  delimiter: string;
  /** The next line is in a here-document's body */
  hereDocument: boolean;
  /** …and the first line of it */
  hereDocumentFirstLine: boolean;
  /** A here-document was asked for and its body has not started */
  needHereDocument: boolean;
  /** Inside a compound assignment `a=(…` */
  compoundAssignment: boolean;
  /** Inside a case statement */
  caseStatement: boolean;
  /** The token before the newline that ended the last line, and the one before that */
  tokenBefore?: Token;
  twoTokensAgo?: Token;
};

const RESERVED = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  '{',
  '}',
  '!',
  '[[',
  ']]',
  'time',
]);

/** After these a word is in command position, and may be a reserved word. */
const COMMAND_STARTERS = new Set([
  '\n',
  ';',
  '&',
  '|',
  '&&',
  '||',
  '(',
  ')',
  ';;',
  ';&',
  ';;&',
  '|&',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '{',
  '}',
  '!',
  'time',
  'fi',
  'done',
  'esac',
]);

const OPERATORS = [';;&', '<<-', '<<<', '&>>', ';;', ';&', '&&', '||', '|&', '<<', '>>', '>&', '<&', '>|', '<>', '&>', ';', '&', '|', '(', ')', '<', '>'];

/** Scan the text of a command read so far, each line ending in a newline. */
export function scanLines(text: string): LineState {
  const tokens: Token[] = [];
  const stack: string[] = [];
  const pendingHereDocs: { word: string; strip: boolean }[] = [];
  let hereDoc: { word: string; strip: boolean } | undefined;
  let hereDocLines = 0;
  let expectHereWord: boolean | undefined;
  let caseDepth = 0;
  let compound = false;
  let i = 0;

  const commandPosition = () => tokens.length === 0 || COMMAND_STARTERS.has(tokens[tokens.length - 1].text) && tokens[tokens.length - 1].kind !== 'word';

  /** Skip a quoted or substituted stretch from `i` (at its opening), or as far as the text goes. */
  const skipQuoted = (): void => {
    const top = stack[stack.length - 1];

    while (i < text.length) {
      const c = text[i];

      if (top === "'") {
        if (c === "'") {
          stack.pop();
          i++;
          return;
        }
        i++;
        continue;
      }

      if (c === '\\') {
        i += 2;
        continue;
      }

      if (c === top || (top === ')' && c === ')') || (top === '}' && c === '}')) {
        stack.pop();
        i++;
        return;
      }

      if (top !== '`' && c === '$' && text[i + 1] === '(') {
        stack.push(')');
        i += 2;
        skipQuoted();
        continue;
      }

      if (c === '$' && text[i + 1] === '{') {
        stack.push('}');
        i += 2;
        skipQuoted();
        continue;
      }

      if (top !== '"' && top !== '`' && c === '(') {
        // A nested parenthesis in a command substitution
        stack.push(')');
        i++;
        skipQuoted();
        continue;
      }

      if (c === '`' && top !== '`') {
        stack.push('`');
        i++;
        skipQuoted();
        continue;
      }

      if (top !== '"' && (c === "'" || c === '"')) {
        stack.push(c);
        i++;
        skipQuoted();
        continue;
      }

      if (top === ')' && c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
        // A here-document inside a command substitution: its body is the substitution's
        i += 2;
        if (text[i] === '-') i++;
        while (text[i] === ' ' || text[i] === '\t') i++;
        const start = i;
        while (i < text.length && !' \t\n;&|<>()'.includes(text[i])) i++;
        pendingHereDocs.push({ word: text.slice(start, i).replace(/['"\\]/g, ''), strip: text[start - 1] === '-' });
        continue;
      }

      if (top === ')' && c === '\n' && pendingHereDocs.length > 0) {
        i++;
        readHereDocs();
        continue;
      }

      i++;
    }
  };

  /** The bodies of the here-documents asked for on the line just ended. */
  const readHereDocs = (): void => {
    while (pendingHereDocs.length > 0) {
      const doc = pendingHereDocs[0];
      let lines = 0;

      for (;;) {
        if (i >= text.length) {
          hereDoc = doc;
          hereDocLines = lines;
          return;
        }

        const end = text.indexOf('\n', i);
        const line = text.slice(i, end === -1 ? text.length : end);

        if (end === -1) {
          // An unfinished line: the body goes on
          hereDoc = doc;
          hereDocLines = lines;
          i = text.length;
          return;
        }

        i = end + 1;
        lines++;

        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.word) break;
      }

      pendingHereDocs.shift();
    }
  };

  while (i < text.length) {
    const c = text[i];

    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }

    if (c === '\\' && text[i + 1] === '\n') {
      i += 2;
      continue;
    }

    if (c === '\n') {
      tokens.push({ kind: 'newline', text: '\n' });
      i++;
      if (pendingHereDocs.length > 0) {
        readHereDocs();
        if (hereDoc) break;
      }
      continue;
    }

    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    const op = OPERATORS.find((o) => text.startsWith(o, i));

    if (op && !((op === '<' || op === '>') && text[i + 1] === '(')) {
      i += op.length;
      tokens.push({ kind: 'op', text: op });

      if (op === '<<' || op === '<<-') expectHereWord = op === '<<-';
      if (op === ')' && compound) compound = false;
      continue;
    }

    // A word, its quotes and substitutions with it
    const start = i;

    while (i < text.length && !' \t\n'.includes(text[i])) {
      const ch = text[i];

      if (ch === '\\') {
        i += 2;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        stack.push(ch);
        i++;
        skipQuoted();
      } else if (ch === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) {
        stack.push(text[i + 1] === '(' ? ')' : '}');
        i += 2;
        skipQuoted();
      } else if ('@?*+!'.includes(ch) && text[i + 1] === '(') {
        // An extended pattern
        stack.push(')');
        i += 2;
        skipQuoted();
      } else if ((ch === '<' || ch === '>') && text[i + 1] === '(' && i === start) {
        // A process substitution
        stack.push(')');
        i += 2;
        skipQuoted();
      } else if (OPERATORS.some((o) => text.startsWith(o, i))) {
        // a=( … ): a compound assignment, its words to the closing parenthesis
        if (ch === '(' && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(text.slice(start, i))) {
          i++;
          compound = true;
        }
        break;
      } else {
        i++;
      }

      if (stack.length > 0) break;
    }

    const word = text.slice(start, i);

    if (expectHereWord !== undefined) {
      pendingHereDocs.push({ word: word.replace(/['"\\]/g, ''), strip: expectHereWord });
      expectHereWord = undefined;
      tokens.push({ kind: 'word', text: word });
      continue;
    }

    const reserved = RESERVED.has(word) && (commandPosition() || reservedAfter(word, tokens));

    if (reserved && word === 'case') caseDepth++;
    if (reserved && word === 'esac') caseDepth--;

    tokens.push({ kind: reserved ? 'reserved' : 'word', text: word });
  }

  // The tokens before the newline that ended the text
  const last = tokens.length - 1;
  const ended = last >= 0 && tokens[last].kind === 'newline';

  return {
    delimiter: stack[stack.length - 1] ?? '',
    hereDocument: hereDoc !== undefined,
    hereDocumentFirstLine: hereDoc !== undefined && hereDocLines === 0,
    needHereDocument: pendingHereDocs.length > 0 && hereDoc === undefined,
    compoundAssignment: compound,
    caseStatement: caseDepth > 0,
    tokenBefore: ended ? tokens[last - 1] : tokens[last],
    twoTokensAgo: ended ? tokens[last - 2] : tokens[last - 1],
  };
}

/** `in` after `for name` or `case word`, `do` after `for name`: reserved where a command could not start. */
function reservedAfter(word: string, tokens: Token[]): boolean {
  const before = tokens[tokens.length - 2];
  const last = tokens[tokens.length - 1];

  if (word === 'in') return last?.kind === 'word' && (before?.text === 'for' || before?.text === 'select' || before?.text === 'case') && before.kind === 'reserved';
  if (word === 'do') return last?.kind === 'word' && (before?.text === 'for' || before?.text === 'select') && before.kind === 'reserved';
  if (word === 'esac' || word === '}' || word === ']]') return last?.text === ';;' || last?.text === ';&' || last?.text === ';;&';

  return false;
}

const NO_SEMI_SUCCESSORS = new Set(['\n', '{', '(', ')', ';', '&', '|', 'case', 'do', 'else', 'if', ';;', ';&', ';;&', 'then', 'until', 'while', '&&', '||', 'in']);

/**
 * history_delimiting_chars: what goes between the command's entry so far and
 * `line`, its next line, given what scanning the lines before it left.
 */
export function delimitingChars(line: string, state: LineState, lineCount: number): string {
  if (state.delimiter !== '') return '\n';
  if (state.hereDocument) return state.hereDocumentFirstLine ? '\n' : '';
  if (state.compoundAssignment) return ' ';

  const before = state.tokenBefore;
  const twoAgo = state.twoTokensAgo;
  const is = (token: Token | undefined, text: string) => token !== undefined && token.text === text && token.kind !== 'word';

  if (is(before, ')')) {
    if (is(twoAgo, '(')) return ' ';
    if (state.caseStatement) return ' ';
    return '; ';
  }

  if (before?.kind === 'word' && is(twoAgo, 'function')) return ' ';
  if (lineCount > 1 && line.includes('<<')) return '\n';
  if (lineCount > 1 && state.needHereDocument) return '\n';

  if (before?.kind === 'word' && (is(twoAgo, 'for') || is(twoAgo, 'select'))) {
    return /^[ \t]*in/.test(line) ? ' ' : ';';
  }

  if (is(twoAgo, 'case') && before?.kind === 'word' && state.caseStatement) return ' ';

  if (before && before.kind !== 'word' && NO_SEMI_SUCCESSORS.has(before.text)) return ' ';

  if (/^[ \t]*$/.test(line)) return lineCount > 1 && before?.kind !== 'newline' ? '; ' : '';

  return '; ';
}

/**
 * shell_comment: 1 when the line is a comment, 2 when a comment follows
 * something on it, 0 when it has none.
 */
export function shellComment(line: string, state?: LineState): 0 | 1 | 2 {
  if (state && (state.delimiter !== '' || state.hereDocument)) return 0;

  const text = line.trimStart();

  if (text.startsWith('#')) return 1;

  let quote = '';

  for (let i = 0; i < line.length; i++) {
    const c = line[i];

    if (quote) {
      if (c === '\\' && quote !== "'") i++;
      else if (c === quote) quote = '';
    } else if (c === '\\') {
      i++;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '#' && (i === 0 || ' \t;&|()<>'.includes(line[i - 1]))) {
      return 2;
    }
  }

  return 0;
}
