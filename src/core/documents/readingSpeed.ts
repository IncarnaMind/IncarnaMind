/**
 * How fast this computer reads Documents (#1506), so "Link this folder?" can say how long
 * reading a folder takes here, and says nothing until files of its kinds have been read here.
 *
 * For each kind, a straight line through how long each Document took to read against its size:
 * its processing job, and its embedding when embeddings are on (not its wait for its turn).
 * Only a job on a worker that has run its kind before counts (see `ProcessorHandlers.onStart`),
 * and only a file read as text: scanned pages or pictures take as long as they are many, which
 * no size tells. A file far outside the sizes read for its kind gets no time, since the line
 * says nothing there. The line is this computer's, kept as a device value
 * (docs/agents/portability.md, rule 5), and starts again when the embedding model changes,
 * since embedding is part of reading.
 */
import type { DocumentKind } from "../api";
import { isRecord } from "../errors";

export const READING_SPEED = "readingSpeed";

const MEGABYTE = 1_000_000;

/** Measurements are kept at most this often while Documents are read: each is a database write. */
const KEEP_EVERY_MS = 5_000;

/**
 * A line is trusted this many times past the sizes it was fitted on, or as many as they
 * spread if more. Files of nearly one size can't say how cost grows with size: a line from
 * 1.5 MB files put 800 files of 2 KB at 435 s when they took 1.4 s.
 */
const REACH = 4;

/**
 * One kind's Documents read here: how many, their mean size in megabytes and mean time in
 * seconds, and the sums of the squares of their sizes' distances from the mean and of the
 * products of both distances (Welford's), from which the line is fitted; and the smallest and
 * largest sizes in megabytes, which bound where the line is trusted.
 */
interface KindReadings {
  count: number;
  megabytes: number;
  seconds: number;
  sizeSquares: number;
  products: number;
  smallest: number;
  largest: number;
}

export interface ReadingSpeed {
  /** The embedding model the Documents were read with; "" while embeddings are off. */
  embedding: string;
  kinds: Partial<Record<string, KindReadings>>;
}

const FIELDS = [
  "count",
  "megabytes",
  "seconds",
  "sizeSquares",
  "products",
  "smallest",
  "largest",
] as const;

const isKindReadings = (value: unknown): value is KindReadings =>
  isRecord(value) &&
  FIELDS.every((field) => Number.isFinite(value[field])) &&
  typeof value.count === "number" &&
  value.count >= 1;

function speedFor(stored: unknown, embedding: string): ReadingSpeed {
  const kinds: ReadingSpeed["kinds"] = {};
  if (isRecord(stored) && stored.embedding === embedding && isRecord(stored.kinds)) {
    for (const [kind, readings] of Object.entries(stored.kinds)) {
      if (isKindReadings(readings)) kinds[kind] = readings;
    }
  }
  return { embedding, kinds };
}

function withReading(
  speed: ReadingSpeed,
  kind: DocumentKind,
  bytes: number,
  seconds: number,
): ReadingSpeed {
  const size = Math.max(bytes, 1) / MEGABYTE;
  const before = speed.kinds[kind] ?? {
    count: 0,
    megabytes: 0,
    seconds: 0,
    sizeSquares: 0,
    products: 0,
    smallest: size,
    largest: size,
  };
  const count = before.count + 1;
  const apart = size - before.megabytes;
  const megabytes = before.megabytes + apart / count;
  const mean = before.seconds + (seconds - before.seconds) / count;
  const readings: KindReadings = {
    count,
    megabytes,
    seconds: mean,
    sizeSquares: before.sizeSquares + apart * (size - megabytes),
    products: before.products + apart * (seconds - mean),
    smallest: Math.min(before.smallest, size),
    largest: Math.max(before.largest, size),
  };
  return { ...speed, kinds: { ...speed.kinds, [kind]: readings } };
}

/**
 * Seconds per file and per megabyte: the least-squares line, through the means, held to costing
 * no less than nothing per megabyte and per file. Files all of one size can't tell the two
 * apart: they cost their mean per file.
 */
function line({ megabytes, seconds, sizeSquares, products }: KindReadings) {
  const slope = sizeSquares > 0 ? Math.max(0, products / sizeSquares) : 0;
  const perMegabyte = megabytes > 0 ? Math.min(slope, seconds / megabytes) : 0;
  return { perFile: seconds - perMegabyte * megabytes, perMegabyte };
}

function covers({ smallest, largest }: KindReadings, megabytes: number): boolean {
  const reach = Math.max(REACH, largest / smallest);
  return megabytes >= smallest / reach && megabytes <= largest * reach;
}

export interface ReadingMeterOptions {
  /** Milliseconds, from a clock that only moves forward. */
  clock(): number;
  /** The embedding model Documents are embedded with now; "" while embeddings are off. */
  embedding(): string;
  read(): unknown;
  write(speed: ReadingSpeed): void;
  reportError(error: unknown): void;
}

export function createReadingMeter(options: ReadingMeterOptions) {
  /**
   * When each Document's processing job started, for those whose time counts; then, processed,
   * how long that took while it waits to be embedded. Each with the embedding model it began
   * under: it counts only for that model, and only while it is still the one in use.
   */
  const started = new Map<string, { at: number; model: string }>();
  const embedding = new Map<
    string,
    { kind: DocumentKind; bytes: number; ms: number; model: string }
  >();
  /** What is measured for the embedding model in use; `unkept` until written to the device value. */
  let measured: ReadingSpeed | null = null;
  let unkept = false;
  let keptAt = Number.NEGATIVE_INFINITY;

  const keep = () => {
    if (!unkept || !measured) return;
    keptAt = options.clock();
    try {
      options.write(measured);
      unkept = false;
    } catch (error) {
      options.reportError(error);
    }
  };

  const speed = (): ReadingSpeed => {
    const model = options.embedding();
    if (measured?.embedding !== model) {
      keep();
      // Begun under another model, they can't count: let them go rather than keep them till quit.
      for (const readings of [started, embedding]) {
        for (const [id, { model: begun }] of readings) if (begun !== model) readings.delete(id);
      }
      measured = speedFor(options.read(), model);
    }
    return measured;
  };

  const add = (kind: DocumentKind, bytes: number, ms: number, model: string) => {
    const current = speed();
    if (current.embedding !== model) return;
    measured = withReading(current, kind, bytes, ms / 1000);
    unkept = true;
    if (options.clock() - keptAt >= KEEP_EVERY_MS) keep();
  };

  return {
    /** A Document's processing job starts; `warm` as `ProcessorHandlers.onStart` gives it. */
    started(documentId: string, warm: boolean): void {
      if (warm) started.set(documentId, { at: options.clock(), model: options.embedding() });
      else started.delete(documentId);
    },

    /**
     * Its job read its file's text, `bytes` of a `kind`. `ready`: it is read; otherwise it is
     * read once embedded, which takes its share of the time too.
     */
    processed(documentId: string, kind: DocumentKind, bytes: number, ready: boolean): void {
      const begun = started.get(documentId);
      started.delete(documentId);
      embedding.delete(documentId);
      if (begun === undefined) return;
      const ms = options.clock() - begun.at;
      if (ready) add(kind, bytes, ms, begun.model);
      else embedding.set(documentId, { kind, bytes, ms, model: begun.model });
    },

    /** `ms` as `EmbeddingQueueOptions.onEmbedded` gives it: null leaves the Document out. */
    embedded(documentId: string, ms: number | null): void {
      const processed = embedding.get(documentId);
      embedding.delete(documentId);
      if (processed && ms !== null) {
        add(processed.kind, processed.bytes, processed.ms + ms, processed.model);
      }
    },

    /** It was deleted, or its folder unlinked: its reading won't finish. */
    forget(documentId: string): void {
      started.delete(documentId);
      embedding.delete(documentId);
    },

    /**
     * How long reading these files takes here, in seconds. Null while a kind among them
     * hasn't been read here with the embedding model in use, or a file's size is far outside
     * the sizes read for its kind.
     */
    seconds(files: Iterable<{ kind: DocumentKind; size: number }>): number | null {
      const { kinds } = speed();
      let total = 0;
      for (const { kind, size } of files) {
        const readings = kinds[kind];
        if (!readings) return null;
        // Below every range of sizes, with nothing to read; note apps leave many empty files.
        if (size === 0) continue;
        const megabytes = size / MEGABYTE;
        if (!covers(readings, megabytes)) return null;
        const { perFile, perMegabyte } = line(readings);
        total += perFile + perMegabyte * megabytes;
      }
      return total;
    },

    close: keep,
  };
}
