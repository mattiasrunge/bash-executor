/**
 * Values written so that the shell reads them back as themselves: `${x@Q}`,
 * `printf %q`, `declare -p`.
 */

// deno-lint-ignore no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

// bash's own: the C escapes, ESC as \E, the rest in octal
const ESCAPES: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\x1b': '\\E',
  '\\': '\\\\',
  "'": "\\'",
};

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

/** `$'…'` when the value holds a control character (bash's ansic_shouldquote), else undefined. */
export function ansiCIfNeeded(value: string): string | undefined {
  return CONTROL.test(value) ? ansiC(value) : undefined;
}

/** As `declare -p` writes a value: in double quotes. */
export function doubleQuoted(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * As `set` writes a value: as it is, unless something in it means something
 * to the shell (bash's sh_contains_shell_metas); a `#` or `~` only at the start.
 */
export function quotedIfNeeded(value: string): string {
  if (CONTROL.test(value)) return ansiC(value);
  if (!/[ \t\n'"\\|&;()<>!{}*[?\]^$`]|^#|(?:^|[=:])~/.test(value)) return value;

  // A lone quote bash writes as \'
  return value === "'" ? "\\'" : `'${value.replaceAll("'", "'\\''")}'`;
}
