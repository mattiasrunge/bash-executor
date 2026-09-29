/**
 * Variables written out as bash writes them: `declare -p`, `set`, `readonly -p`
 * and `export -p`, each in bash's own format, so the output reads back as the
 * commands that make the variables again.
 */

import { bashHashOrder } from '../hash-order.ts';
import { ansiCIfNeeded, doubleQuoted, quotedIfNeeded } from '../quote.ts';
import type { ExecContextIf, VariableInfo } from '../types.ts';

/** How many buckets bash gives an associative array, which decides the order its keys come in. */
const ASSOC_BUCKETS = 1024;

/** The keys of an associative array in the order bash walks them. */
export const assocKeys = (assoc: Record<string, string>): string[] => bashHashOrder(Object.keys(assoc), ASSOC_BUCKETS);

/** A value as print_array_assignment writes it: `$'…'` for a control character, else double quotes. */
const valueQuoted = (value: string): string => ansiCIfNeeded(value) ?? doubleQuoted(value);

/** An associative array's key, quoted only when the shell would read it otherwise. */
const keyQuoted = (key: string): string => ansiCIfNeeded(key) ?? (quotedIfNeeded(key) !== key || key === '@' || key === '*' ? doubleQuoted(key) : key);

/** The `( … )` of an array, or `()` when it has no elements: `([0]="a" [2]="c")`, `([k]="v" )`. */
export function compoundValue(info: VariableInfo): string {
  if (Array.isArray(info.value)) {
    const elements = Object.entries(info.value).map(([index, value]) => `[${index}]=${valueQuoted(value)}`);

    return `(${elements.join(' ')})`;
  }

  if (info.value && typeof info.value === 'object') {
    const assoc = info.value;

    return `(${assocKeys(assoc).map((key) => `[${keyQuoted(key)}]=${valueQuoted(assoc[key])} `).join('')})`;
  }

  return '()';
}

/** Attribute letters, kind first: `a`, `A`, then i n r t x c l u. */
export const attributeLetters = (info: VariableInfo): string => (info.kind === 'array' ? 'a' : info.kind === 'assoc' ? 'A' : '') + info.attributes.replace(/[aA]/g, '');

/**
 * One variable as show_var_attributes writes it: `declare -ar a=([0]="x")`,
 * `declare -- x="1"`, or just the name while it has no value. `readonly -p`
 * and `export -p` write their own name in posix mode, with only `-a`/`-A`.
 */
export function declareLine(name: string, info: VariableInfo, opts: { command?: string; posix?: boolean } = {}): string {
  const command = opts.command ?? 'declare';
  let prefix: string;

  if (command === 'declare' || !opts.posix) {
    prefix = `declare -${attributeLetters(info) || '-'} `;
  } else {
    const kind = info.kind === 'array' ? 'a' : info.kind === 'assoc' ? 'A' : '';
    prefix = kind ? `${command} -${kind} ` : `${command} `;
  }

  if (info.value === undefined) return `${prefix}${name}\n`;
  if (info.kind !== 'scalar') return `${prefix}${name}=${compoundValue(info)}\n`;

  return `${prefix}${name}=${valueQuoted(info.value as string)}\n`;
}

/** A name bash lists: an identifier. What the environment brought in under any other is left out. */
export const isListedName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/** Every variable, sorted by name as bash sorts them. */
export function sortedVariables(ctx: ExecContextIf): Array<[string, VariableInfo]> {
  return Object.entries(ctx.getVariables())
    .filter(([name]) => isListedName(name))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The variables as `set` lists them: those with a value, `name=value` quoted
 * only where it has to be, arrays as `a=([0]="x")`.
 */
export function setListing(ctx: ExecContextIf): string {
  let out = '';

  for (const [name, info] of sortedVariables(ctx)) {
    if (info.value === undefined) continue;

    out += info.kind === 'scalar' ? `${name}=${quotedIfNeeded(info.value as string)}\n` : `${name}=${compoundValue(info)}\n`;
  }

  return out;
}
