/**
 * The elements of an associative array's `( … )` as bash assigns them:
 * `[key]=value` ones, or, since bash 5.1, when the first is not one, keys and
 * values in turn — `(a 1 b 2)`, the last key without a value taking ''.
 */

/**
 * Stands round the key of a `[key]=value` element whose key the executor has
 * expanded already, so a `]` or `=` in the key is the key's.
 */
export const KEY_MARK = '\uFDD4';

export type KeyedElement = { key: string; value: string; append: boolean };

/** A `[key]=value` element as the executor hands it on, key already expanded. */
export const keyedText = (key: string, value: string, append: boolean): string => `${KEY_MARK}${key}${KEY_MARK}${append ? '+' : ''}=${value}`;

/** The key and value of a `[key]=value` (or `[key]+=value`) element, or null for a plain one. */
export function keyedElement(element: string): KeyedElement | null {
  if (element.startsWith(KEY_MARK)) {
    const close = element.indexOf(KEY_MARK, 1);
    const append = element[close + 1] === '+';

    return { key: element.slice(1, close), value: element.slice(close + (append ? 3 : 2)), append };
  }

  const match = element.match(/^\[(.*?)\](\+?)=(.*)$/s);

  return match ? { key: match[1], value: match[3], append: match[2] === '+' } : null;
}

/** Whether a list is keys and values in turn: its first element is no `[key]=value`. */
export const isKeyValueList = (elements: string[]): boolean => elements.length > 0 && keyedElement(elements[0]) === null;

/**
 * What a list assigns to an associative array, and what bash complains of:
 * an element with no subscript in a `[key]=value` list, an empty key in a
 * key-value one.
 */
export function assocEntries(name: string, elements: string[]): { entries: KeyedElement[]; errors: string[] } {
  const entries: KeyedElement[] = [];
  const errors: string[] = [];

  if (isKeyValueList(elements)) {
    for (let i = 0; i < elements.length; i += 2) {
      const key = elements[i];

      if (key === '') errors.push(`${key}: bad array subscript`);
      else entries.push({ key, value: elements[i + 1] ?? '', append: false });
    }

    return { entries, errors };
  }

  for (const element of elements) {
    const keyed = keyedElement(element);

    if (keyed) entries.push(keyed);
    else errors.push(`${name}: ${element}: must use subscript when assigning associative array`);
  }

  return { entries, errors };
}
