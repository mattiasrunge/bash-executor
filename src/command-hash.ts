/**
 * bash's table of hashed commands: the file a command name runs, found once and
 * then remembered until PATH changes. bash shows the table as the BASH_CMDS
 * associative array, and here it is that array, so `BASH_CMDS[x]=/bin/x`
 * hashes `x` as it does in bash. How often each was used is kept beside it.
 */

import { bashHashOrder } from './hash-order.ts';
import type { ExecContextIf } from './types.ts';

const TABLE = 'BASH_CMDS';

/** The hits of each table, by the table's object, so a new table starts at none. */
const hits = new WeakMap<Record<string, string>, Map<string, number>>();

function hitsOf(table: Record<string, string>): Map<string, number> {
  let counts = hits.get(table);

  if (!counts) hits.set(table, counts = new Map());

  return counts;
}

/**
 * The file a hashed command runs, or undefined when it is not hashed. Each
 * look counts as a hit, as bash's phash_search counts it, unless `count` is false.
 */
export function hashedCommand(ctx: ExecContextIf, name: string, count = true): string | undefined {
  const table = ctx.getAssoc(TABLE);

  if (!table || !Object.hasOwn(table, name)) return undefined;

  if (count) hitsOf(table).set(name, (hitsOf(table).get(name) ?? 0) + 1);

  return table[name];
}

/** Hash a command, keeping its hits when it was hashed already. */
export function hashCommand(ctx: ExecContextIf, name: string, path: string): void {
  ctx.setAssocElement(TABLE, name, path);
}

/** Forget a command; false when it was not hashed. */
export function unhashCommand(ctx: ExecContextIf, name: string): boolean {
  const table = ctx.getAssoc(TABLE);

  if (!table || !Object.hasOwn(table, name)) return false;

  ctx.unsetAssocElement(TABLE, name);
  hitsOf(table).delete(name);

  return true;
}

/** The hashed commands, in the order bash lists them. */
export function hashedCommands(ctx: ExecContextIf): { name: string; path: string; hits: number }[] {
  const table = ctx.getAssoc(TABLE) ?? {};

  return bashHashOrder(Object.keys(table), 256).map((name) => ({ name, path: table[name], hits: hitsOf(table).get(name) ?? 0 }));
}
