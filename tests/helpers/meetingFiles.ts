/** Small tar and WAV files for the tests of the meeting set. */

export interface TarFile {
  name: string;
  data: Uint8Array;
  /** The type flag: "0" for a file, "5" for a folder, "L" for a GNU long name. */
  type?: string;
  prefix?: string;
}

export function tarOf(files: readonly TarFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    header.write(file.name, 0, "utf8");
    header.write(file.data.length.toString(8).padStart(11, "0"), 124, "ascii");
    header.write(file.type ?? "0", 156, "ascii");
    header.write("ustar", 257, "ascii");
    if (file.prefix) header.write(file.prefix, 345, "utf8");
    blocks.push(
      header,
      Buffer.from(file.data),
      Buffer.alloc((512 - (file.data.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A WAV file of 16-bit integer samples, interleaved when there are several channels. */
export function pcmWav(samples: Int16Array, channels = 1, rate = 16_000, extensible = false) {
  const fmtSize = extensible ? 40 : 16;
  const out = Buffer.alloc(28 + fmtSize + samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(fmtSize, 16);
  out.writeUInt16LE(extensible ? 0xfffe : 1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  let at = 36;
  if (extensible) {
    out.writeUInt16LE(22, at);
    out.writeUInt16LE(16, at + 2);
    out.writeUInt32LE(0, at + 4);
    out.writeUInt16LE(1, at + 8);
    at += 24;
  }
  out.write("data", at, "ascii");
  out.writeUInt32LE(samples.length * 2, at + 4);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(out, at + 8);
  return out;
}

/** A mono 16 kHz WAV file of 32-bit float samples, as AMI's segments are. */
export function floatWav(samples: Float32Array) {
  const out = Buffer.alloc(44 + samples.length * 4);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(3, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24);
  out.writeUInt32LE(64_000, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(32, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples.length * 4, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(out, 44);
  return out;
}

/** The bytes in chunks of `size`, as a network delivers them. */
export async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}
