export interface TarEntry {
  name: string;
  size: number;
  isFile: boolean;
  /** The file's bytes, in chunks; an entry the caller doesn't read is skipped. */
  content: AsyncIterable<Uint8Array>;
}

const BLOCK = 512;

class Reader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  private source: AsyncIterator<Uint8Array>;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.source = source[Symbol.asyncIterator]();
  }

  private async fill(wanted: number): Promise<void> {
    while (this.buffered < wanted && !this.done) {
      const next = await this.source.next();
      if (next.done) this.done = true;
      else if (next.value.length > 0) {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
  }

  async take(count: number): Promise<Uint8Array> {
    await this.fill(count);
    const size = Math.min(count, this.buffered);
    const out = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const head = this.chunks[0] as Uint8Array;
      const used = Math.min(head.length, size - at);
      out.set(head.subarray(0, used), at);
      at += used;
      if (used === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(used);
    }
    this.buffered -= size;
    return out;
  }

  async piece(limit: number): Promise<Uint8Array> {
    await this.fill(1);
    const head = this.chunks[0];
    if (!head) return new Uint8Array(0);
    const used = Math.min(head.length, limit);
    if (used === head.length) this.chunks.shift();
    else this.chunks[0] = head.subarray(used);
    this.buffered -= used;
    return head.subarray(0, used);
  }
}

const text = (bytes: Uint8Array, from: number, to: number) => {
  const field = bytes.subarray(from, to);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
};

async function whole(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of content) parts.push(part);
  return Buffer.concat(parts);
}

function paxPath(records: Uint8Array): string | null {
  const body = new TextDecoder().decode(records);
  for (const line of body.split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(line);
    if (match) return match[1] as string;
  }
  return null;
}

/**
 * The entries of an uncompressed tar stream, one at a time. Reads a ustar archive with GNU long
 * names and pax paths, which is what GNU tar and bsdtar write. The caller must be done with an
 * entry's content before asking for the next entry.
 */
export async function* tarEntries(input: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
  const reader = new Reader(input);
  let nextName: string | null = null;
  for (;;) {
    const header = await reader.take(BLOCK);
    if (header.length < BLOCK || header.every((byte) => byte === 0)) return;
    const size = Number.parseInt(text(header, 124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    let remaining = size;
    const content: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        while (remaining > 0) {
          const piece = await reader.piece(remaining);
          if (piece.length === 0) throw new Error("The archive ends inside a file.");
          remaining -= piece.length;
          yield piece;
        }
      },
    };
    if (type === "L" || type === "x") {
      const body = await whole(content);
      await reader.take(padding);
      nextName = type === "L" ? text(body, 0, body.length) : (paxPath(body) ?? nextName);
      continue;
    }
    const prefix = text(header, 345, 500);
    const name = nextName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    nextName = null;
    yield { name, size, isFile: type === "0" || type === "7", content };
    while (remaining > 0) {
      const piece = await reader.piece(remaining);
      if (piece.length === 0) throw new Error("The archive ends inside a file.");
      remaining -= piece.length;
    }
    await reader.take(padding);
  }
}
