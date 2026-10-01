/**
 * One record from a descriptor, up to a delimiter, as `read` and `mapfile`
 * take them: with the host's `pipeReadRecord` when it has one, which says
 * whether the delimiter or the end of the input ended it.
 */

import type { ShellIf } from '../types.ts';

export async function readRecord(shell: ShellIf, fd: string, delimiter: string): Promise<{ text: string; delimited: boolean } | null> {
  if (shell.pipeReadRecord) return await shell.pipeReadRecord(fd, delimiter);

  const text = await shell.pipeReadLine!(fd, delimiter);

  return text === null ? null : { text, delimited: true };
}
