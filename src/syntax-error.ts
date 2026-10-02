/**
 * A syntax error as bash says it: the line it is on, and what it says there.
 */

import type { BashSyntaxError } from '@ein/bash-parser';

/**
 * The line bash names for a syntax error in `source`, and its message, one
 * line of output each: a token that cannot stand there, with the line it is
 * on quoted after it; the input ending in the middle of a command, on the line
 * after its last; a quote or substitution left open. An error the parser gave
 * no detail for is told in its own words.
 */
export function syntaxErrorLines(err: BashSyntaxError, source: string): { line: number; lines: string[] } {
  // A text parsed without locations, or one mapped from inside a substitution, may have none
  const row = Number.isFinite(err.location?.start?.row) ? err.location!.start!.row! : 1;
  const detail = err.detail;
  // The end of the input: one line past the last, whether or not it ends in a newline
  const newlines = source.match(/\n/g)?.length ?? 0;
  const endLine = source.endsWith('\n') ? newlines + 1 : newlines + 2;

  if (detail?.kind === 'token') {
    const text = source.split('\n')[row - 1] ?? '';

    return { line: row, lines: [`syntax error near unexpected token \`${detail.token}'`, `\`${text}'`] };
  }

  if (detail?.kind === 'eof') {
    return { line: endLine, lines: ['syntax error: unexpected end of file'] };
  }

  if (detail?.kind === 'unclosed') {
    // An open `$(` reads on to the end; a quote is named where it opened
    const line = detail.closer === ')' ? endLine : row;

    return { line, lines: [`unexpected EOF while looking for matching \`${detail.closer}'`] };
  }

  if (detail?.kind === 'arithmeticFor') {
    return { line: row, lines: [`syntax error: ${detail.problem}`, `syntax error: \`${detail.text}'`] };
  }

  return { line: row, lines: [`syntax error: ${err.message.split('\n')[0]}`] };
}

/**
 * What bash warns of before such an error: each here-document the input
 * ended inside of, said on the line the input ended on.
 */
export function syntaxErrorWarnings(err: BashSyntaxError): { line: number; text: string }[] {
  const documents = (err as BashSyntaxError & { unterminatedHereDocuments?: { delimiter: string; line: number; endLine: number }[] }).unterminatedHereDocuments ?? [];

  return documents.map((doc) => ({ line: doc.endLine, text: `warning: here-document at line ${doc.line} delimited by end-of-file (wanted \`${doc.delimiter}')` }));
}
