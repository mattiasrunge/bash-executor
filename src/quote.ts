/**
 * Values written so that the shell reads them back as themselves: `${x@Q}`,
 * `printf %q`, `declare -p`.
 */

// deno-lint-ignore no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

const ESCAPES: Record<string, string> = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\x1b': '\\E', '\\': '\\\\', "'": "\\'" };

/** `$'…'`, with a control character as its escape. */
function ansiC(value: string): string {
  return `$'${[...value].map((c) => ESCAPES[c] ?? (CONTROL.test(c) ? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}` : c)).join('')}'`;
}

/** As `${x@Q}` writes it: in single quotes, or as `$'…'` when it holds a control character. */
export function singleQuoted(value: string): string {
  return CONTROL.test(value) ? ansiC(value) : `'${value.replaceAll("'", "'\\''")}'`;
}

/** As `printf %q` writes it: a backslash before each special character, or `$'…'`. */
export function backslashQuoted(value: string): string {
  if (value === '') return "''";
  if (CONTROL.test(value)) return ansiC(value);

  return value.replace(/[^A-Za-z0-9_./,:@%+=^-]/g, '\\$&').replace(/^~/, '\\~');
}
