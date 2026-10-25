import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

type Row = Record<string, unknown>;

/** Some columns of a Parquet file, for rows `from` up to `to`; byte columns come as bytes, not text. */
export async function readRows(
  path: string,
  columns: string[],
  range?: { from: number; to: number },
): Promise<Row[]> {
  const file = await asyncBufferFromFile(path);
  return parquetReadObjects({
    file,
    compressors,
    columns,
    utf8: false,
    rowStart: range?.from,
    rowEnd: range?.to,
  });
}

export const text = (value: unknown) =>
  value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);

export function audioOf(value: unknown): { bytes: Uint8Array; name: string } {
  const audio = value as { bytes: Uint8Array; path: Uint8Array | string };
  return { bytes: audio.bytes, name: text(audio.path) };
}
