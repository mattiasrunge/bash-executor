/**
 * PipeBuffer - Async pipe with proper backpressure and EOF signaling
 * Based on MURRiX implementation
 */
export class PipeBuffer {
  private buffer: Uint8Array;
  private readPos = 0;
  private writePos = 0;
  private size = 0;
  private _closed = false;

  private writeWaiters: Array<() => void> = [];
  private readWaiters: Array<() => void> = [];

  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(private capacity: number = 64 * 1024) {
    this.buffer = capacity > 0 ? new Uint8Array(capacity) : new Uint8Array(0);
  }

  get isClosed(): boolean {
    return this._closed;
  }

  close(): void {
    this._closed = true;
    // Wake all waiting readers so they can see EOF
    this.readWaiters.forEach((w) => w());
    this.readWaiters = [];
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (this._closed) {
      throw new Error('Cannot write to closed pipe');
    }

    if (this.capacity === 0) return;

    const input: Uint8Array = typeof data === 'string' ? this.encoder.encode(data) : data;

    let offset = 0;

    while (offset < input.length) {
      if (this._closed) {
        throw new Error('Cannot write to closed pipe');
      }

      if (this.size === this.capacity) {
        await new Promise<void>((res) => this.writeWaiters.push(res));
        continue;
      }

      const space = this.capacity - this.size;
      const toWrite = Math.min(space, input.length - offset);

      const end = this.writePos + toWrite;

      if (end <= this.capacity) {
        this.buffer.set(input.subarray(offset, offset + toWrite), this.writePos);
      } else {
        const firstPart = this.capacity - this.writePos;
        this.buffer.set(input.subarray(offset, offset + firstPart), this.writePos);
        const remaining = toWrite - firstPart;
        this.buffer.set(input.subarray(offset + firstPart, offset + firstPart + remaining), 0);
      }

      this.writePos = (this.writePos + toWrite) % this.capacity;
      this.size += toWrite;
      offset += toWrite;

      // Wake any waiting readers
      this.readWaiters.forEach((w) => w());
      this.readWaiters = [];
    }
  }

  /**
   * Up to `maxBytes`, waiting for some; empty at EOF. A reader that gives up
   * through `signal` gets nothing, and what comes later stays for the next one.
   */
  async read(maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.capacity === 0) {
      return new Uint8Array(0);
    }

    while (this.size === 0) {
      if (this._closed || signal?.aborted) {
        return new Uint8Array(0);
      }

      await new Promise<void>((res) => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          res();
        };

        this.readWaiters.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }

    const toRead = Math.min(maxBytes, this.size);
    const out = new Uint8Array(toRead);

    const end = this.readPos + toRead;

    if (end <= this.capacity) {
      out.set(this.buffer.subarray(this.readPos, this.readPos + toRead));
    } else {
      const firstPart = this.capacity - this.readPos;
      out.set(this.buffer.subarray(this.readPos, this.readPos + firstPart));
      const remaining = toRead - firstPart;
      out.set(this.buffer.subarray(0, remaining), firstPart);
    }

    this.readPos = (this.readPos + toRead) % this.capacity;
    this.size -= toRead;

    // Wake any writers waiting for space
    this.writeWaiters.forEach((w) => w());
    this.writeWaiters = [];

    return out;
  }

  async readAll(): Promise<string> {
    const chunks: Uint8Array[] = [];

    while (true) {
      const chunk = await this.read(16384);
      if (chunk.length === 0) {
        break;
      }
      chunks.push(chunk);
    }

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return this.decoder.decode(result);
  }

  writeString(data: string): Promise<void> {
    return this.write(data);
  }
}
