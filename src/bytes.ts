/**
 * Bytes made by escapes — `\351`, `\xc3` in printf, echo -e and `$'…'` — in a
 * shell whose text is JavaScript strings.
 *
 * bash deals in bytes: `\303\251` is the two bytes of é in UTF-8, `\351` one
 * byte that is no character at all. Here an escape's byte of 0x80 and up is
 * first a stand-in character, U+DC80 to U+DCFF (as Python's surrogateescape),
 * and once the escapes are done a run of them that is UTF-8 becomes the text
 * it spells. What is left is the bytes themselves, which a host writing bytes
 * writes as they are (`encodeShellText`).
 */

const BYTE_BASE = 0xdc00;
const BYTES = /[\udc80-\udcff]+/g;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** The character an escape's byte value stands as. */
export function escapedByte(value: number): string {
  const byte = value & 0xff;

  return byte < 0x80 ? String.fromCharCode(byte) : String.fromCharCode(BYTE_BASE + byte);
}

/** Runs of escaped bytes that are UTF-8, as the text they spell; the rest stay bytes. */
export function decodeEscapedBytes(text: string): string {
  return text.replace(BYTES, (run) => {
    const bytes = Uint8Array.from(run, (char) => char.charCodeAt(0) - BYTE_BASE);

    try {
      return decoder.decode(bytes);
    } catch {
      return run;
    }
  });
}

/** Shell text as bytes: UTF-8, but an escaped byte that was no character is that byte. */
export function encodeShellText(text: string): Uint8Array {
  if (!/[\udc80-\udcff]/.test(text)) {
    return new TextEncoder().encode(text);
  }

  const parts: number[] = [];
  const encoder = new TextEncoder();

  for (const piece of text.split(/([\udc80-\udcff])/)) {
    if (piece.length === 1 && /[\udc80-\udcff]/.test(piece)) {
      parts.push(piece.charCodeAt(0) - BYTE_BASE);
    } else if (piece) {
      parts.push(...encoder.encode(piece));
    }
  }

  return Uint8Array.from(parts);
}
