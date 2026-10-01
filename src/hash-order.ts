/**
 * The order bash lists the keys of one of its hash tables in: an associative
 * array's `${!a[@]}`, the hashed commands. bash walks the buckets in order,
 * and a bucket from its newest key to its oldest, so the order follows from
 * the keys, the order they came in, and the table's size.
 */

const encoder = new TextEncoder();

/** bash's hash_string: 32-bit FNV-1 over the bytes, each as a signed char. */
function hashString(key: string): number {
  let hash = 2166136261;
  // ASCII is its own UTF-8, and needs no encoding
  const codes = Array.from(key, (c) => c.charCodeAt(0));
  const bytes = codes.every((code) => code < 128) ? codes : encoder.encode(key);

  for (const byte of bytes) {
    hash = Math.imul(hash, 16777619) >>> 0;
    hash = (hash ^ (byte < 128 ? byte : byte - 256)) >>> 0;
  }

  return hash;
}

/**
 * The keys, given in the order they were added, in bash's order for a table of
 * `buckets` buckets: 1024 for an associative array, 256 for hashed commands.
 * A table grows fourfold once it holds twice as many keys as buckets.
 */
export function bashHashOrder(keys: string[], buckets: number): string[] {
  // Without growing, a key's place is its bucket, and the newer of two in one bucket comes first
  if (keys.length <= buckets * 2) {
    const placed = keys.map((key, index) => ({ key, index, bucket: hashString(key) & (buckets - 1) }));

    return placed.sort((a, b) => a.bucket - b.bucket || b.index - a.index).map(({ key }) => key);
  }

  let table: string[][] = Array.from({ length: buckets }, () => []);
  let count = 0;

  for (const key of keys) {
    if (count >= table.length * 2) {
      // Rehashing walks the old buckets in order and puts each key at the head
      // of its new one
      const grown: string[][] = Array.from({ length: table.length * 4 }, () => []);

      for (const bucket of table) {
        for (const old of bucket) grown[hashString(old) & (grown.length - 1)].unshift(old);
      }

      table = grown;
    }

    table[hashString(key) & (table.length - 1)].unshift(key);
    count++;
  }

  return table.flat();
}
