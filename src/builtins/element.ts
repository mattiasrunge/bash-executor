/**
 * The names a builtin assigns to — `read a[$k]`, `printf -v 'a[1]'` — as
 * bash's valid_array_reference reads them, and the assignment itself.
 *
 * The word has been expanded once already. Its subscript is expanded again,
 * as bash does, unless `assoc_expand_once` is on and the name is an
 * associative array's: then all between the first `[` and the last `]` is the
 * key, as it stands, so `read a[$k]` with k="80's" works only that way.
 */

import { contextVariables, evaluateArithmeticText, subscriptEnd } from '../arith.ts';
import { ArithmeticError } from '../errors.ts';
import type { ExecContextIf } from '../types.ts';
import type { BuiltinServices } from './types.ts';

export type NameReference = { name: string; subscript?: string; literal: boolean };

const isIdentifier = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/** A variable or element name a builtin can assign, or null for one bash says is not a valid identifier. */
export function nameReference(text: string, ctx: ExecContextIf): NameReference | null {
  const open = text.indexOf('[');

  if (open === -1) return isIdentifier(text) ? { name: text, literal: false } : null;

  const name = text.slice(0, open);

  if (!isIdentifier(name)) return null;

  const literal = ctx.getShellOption('assoc_expand_once') && ctx.getAssoc(name) !== undefined;
  const close = literal ? text.length - 1 : subscriptEnd(text, open);

  if (close <= open + 1 || text[close] !== ']' || close !== text.length - 1) return null;

  return { name, subscript: text.slice(open + 1, close), literal };
}

/** Assign what a builtin produced to a name `nameReference` read. */
export async function assignReference(ctx: ExecContextIf, ref: NameReference, value: string, services?: BuiltinServices): Promise<void> {
  if (ref.subscript === undefined) {
    ctx.assignVariable(ref.name, value);
    return;
  }

  if (ctx.getAssoc(ref.name)) {
    const key = ref.literal || !services ? ref.subscript : await services.expandSubscript(ref.subscript, true);

    ctx.setAssocElement(ref.name, key, value);
    return;
  }

  // `@` and `*` name every element, which no assignment can
  if (ref.subscript === '@' || ref.subscript === '*') {
    const error = new ArithmeticError(`${ref.name}[${ref.subscript}]: bad array subscript`);

    error.nameless = true;
    throw error;
  }

  const expanded = services ? await services.expandSubscript(ref.subscript, false) : ref.subscript;
  const index = Number(await evaluateArithmeticText(expanded, contextVariables(ctx, services?.expandSubscript)));
  const length = ctx.getArray(ref.name)?.length ?? 0;

  ctx.setArrayElement(ref.name, index < 0 ? length + index : index, value);
}
