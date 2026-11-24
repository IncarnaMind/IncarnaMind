import { crc32, deflateSync } from "node:zlib";

/** A picture of a size a person sees: a gradient, as a PNG, written without a library. */
export function gradientPng(size = 64, tint = 0): Buffer {
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 3 + 1);
    rows[at] = 0;
    for (let x = 0; x < size; x++) {
      rows[at + 1 + x * 3] = (x * 4) % 256;
      rows[at + 2 + x * 3] = (y * 4) % 256;
      rows[at + 3 + x * 3] = (128 + tint) % 256;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
