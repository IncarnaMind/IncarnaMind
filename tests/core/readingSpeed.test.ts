import { describe, expect, test } from "vitest";
import type { DocumentKind } from "../../src/core";
import { createReadingMeter } from "../../src/core/documents/readingSpeed";

/**
 * A meter on a clock only the test moves, keeping its device value as JSON, as SQLite does.
 * `read` reads a Document whose job starts on a warm worker and takes `ms`.
 */
function startMeter(kept?: string) {
  let time = 0;
  let embedding = "";
  let stored = kept;
  let writes = 0;
  let next = 0;
  const meter = createReadingMeter({
    clock: () => time,
    embedding: () => embedding,
    read: () => (stored === undefined ? undefined : JSON.parse(stored)),
    write: (speed) => {
      stored = JSON.stringify(speed);
      writes++;
    },
    reportError: (error) => {
      throw error;
    },
  });
  return {
    meter,
    kept: () => stored,
    writes: () => writes,
    advance(ms: number) {
      time += ms;
    },
    useEmbedding(model: string) {
      embedding = model;
    },
    read(kind: DocumentKind, bytes: number, ms: number) {
      const id = `document-${next++}`;
      meter.started(id, true);
      time += ms;
      meter.processed(id, kind, bytes, true);
    },
  };
}

const files = (count: number, kind: DocumentKind, size: number) =>
  Array.from({ length: count }, () => ({ kind, size }));

/** Small Markdown, text and CSV files, of 800 to 1,400 bytes. */
const smallFiles = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    kind: (["markdown", "text", "csv"] as const)[index % 3] ?? "text",
    size: 800 + (index % 7) * 100,
  }));

describe("How long reading takes on this computer (#1506)", () => {
  test("nothing is said until files of a kind have been read here, then it is what they took", () => {
    const { meter, read } = startMeter();
    expect(meter.seconds(smallFiles(2000))).toBeNull();

    // The issue's folder: 2,000 small files read in 25 s, between 9 and 16 ms each.
    for (const [index, file] of smallFiles(2000).entries()) {
      read(file.kind, file.size, 9 + (index % 8));
    }

    const again = meter.seconds(smallFiles(2000));
    expect(again).toBeGreaterThan(25 / 2);
    expect(again).toBeLessThan(25 * 2);
    // Fewer files, less time: twenty take a fraction of a second.
    expect(meter.seconds(smallFiles(20))).toBeLessThan(1);
    // A kind never read here: no time, rather than a guess.
    expect(meter.seconds([...smallFiles(20), { kind: "pdf", size: 2_000_000 }])).toBeNull();
  });

  test("a kind's time follows its files' sizes: so much per file, and so much per megabyte", () => {
    const { meter, read } = startMeter();
    // PDFs here take 40 ms each, and 2 s a megabyte.
    for (const size of [30_000, 120_000, 500_000, 2_000_000, 6_000_000, 15_000_000]) {
      read("pdf", size, 40 + (2 * size) / 1000);
    }

    expect(meter.seconds(files(500, "pdf", 100_000))).toBeCloseTo(500 * (0.04 + 0.2));
    expect(meter.seconds(files(3, "pdf", 40_000_000))).toBeCloseTo(3 * (0.04 + 80));
  });

  test("files all of one size can't tell what a file costs from what a megabyte does: near that size each costs what it took", () => {
    const { meter, read } = startMeter();
    for (let index = 0; index < 3; index++) read("text", 4_000, 10);

    expect(meter.seconds(files(10, "text", 4_000))).toBeCloseTo(0.1);
    expect(meter.seconds(files(10, "text", 12_000))).toBeCloseTo(0.1);
    expect(meter.seconds(files(10, "text", 1_500))).toBeCloseTo(0.1);
  });

  test("nothing is said for a file far from the sizes read: a line from big files says nothing about small ones (#1506)", () => {
    // 1.5 MB files took 0.8 s each; 800 files of 2 KB took 1.4 s in all, not 640 s.
    const big = startMeter();
    for (let index = 0; index < 8; index++) big.read("markdown", 1_500_000, 800);
    expect(big.meter.seconds(files(800, "markdown", 2_000))).toBeNull();
    expect(big.meter.seconds(files(8, "markdown", 1_500_000))).toBeCloseTo(6.4);

    // 2 KB files took 5 ms each; twelve of 1.5 MB took 6.7 s in all, not 0.06 s.
    const small = startMeter();
    for (let index = 0; index < 12; index++) small.read("markdown", 2_000, 5);
    expect(small.meter.seconds(files(12, "markdown", 1_500_000))).toBeNull();
    expect(small.meter.seconds(files(12, "markdown", 6_000))).toBeCloseTo(0.06);

    // One such file among many makes the whole folder's time unknown, and so does a size just
    // past the reach on either side.
    expect(
      small.meter.seconds([...files(100, "markdown", 2_000), ...files(1, "markdown", 1_500_000)]),
    ).toBeNull();
    expect(small.meter.seconds(files(1, "markdown", 9_000))).toBeNull();
    expect(small.meter.seconds(files(1, "markdown", 400))).toBeNull();
  });

  test("a wide spread of sizes read is trusted as far past them as it spreads", () => {
    const { meter, read } = startMeter();
    // 60 files of 1 to 200 KB, at 5 ms a file and 3 s a megabyte.
    for (let index = 0; index < 60; index++) {
      const size = 1_000 + index * 3_400;
      read("markdown", size, 5 + (3 * size) / 1000);
    }

    expect(meter.seconds(files(10, "markdown", 3_000_000))).toBeCloseTo(10 * (0.005 + 9), 1);
    expect(meter.seconds(files(10, "markdown", 300))).toBeCloseTo(10 * (0.005 + 0.0009), 2);
    expect(meter.seconds(files(1, "markdown", 500_000_000))).toBeNull();
  });

  test("an empty file has nothing to read, so it doesn't make the time unknown", () => {
    const { meter, read } = startMeter();
    for (let index = 0; index < 3; index++) read("markdown", 4_000, 10);

    expect(
      meter.seconds([...files(10, "markdown", 4_000), ...files(5, "markdown", 0)]),
    ).toBeCloseTo(0.1);
    expect(meter.seconds(files(5, "pdf", 0))).toBeNull();
  });

  test("a job on a worker new to its kind doesn't count: it starts the worker, or loads PDF.js", () => {
    const { meter, advance } = startMeter();
    meter.started("first", false);
    advance(400);
    meter.processed("first", "pdf", 50_000, true);
    expect(meter.seconds(files(1, "pdf", 50_000))).toBeNull();

    // Started again on a new worker (the last one crashed): only the new start counts.
    meter.started("again", true);
    advance(30);
    meter.started("again", false);
    advance(400);
    meter.processed("again", "pdf", 50_000, true);
    expect(meter.seconds(files(1, "pdf", 50_000))).toBeNull();
  });

  test("embedding is part of reading: a Document counts once embedded, without its wait for its turn", () => {
    const { meter, advance, useEmbedding } = startMeter();
    useEmbedding("multilingual-e5-small");
    meter.started("notes", true);
    advance(10);
    meter.processed("notes", "markdown", 2_000, false);
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeNull();

    advance(60_000);
    meter.embedded("notes", 90);

    expect(meter.seconds(files(1, "markdown", 2_000))).toBeCloseTo(0.1);
  });

  test("a Document whose embedding stopped part way doesn't count: its last turn took only the rest", () => {
    const { meter, advance, read, useEmbedding } = startMeter();
    useEmbedding("multilingual-e5-small");
    meter.started("held", true);
    advance(10);
    meter.processed("held", "markdown", 2_000, false);
    meter.embedded("held", null);
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeNull();

    read("markdown", 2_000, 100);
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeCloseTo(0.1);
  });

  test("a Document deleted before it is embedded is forgotten: its reading won't finish", () => {
    const { meter, advance, useEmbedding } = startMeter();
    useEmbedding("multilingual-e5-small");
    meter.started("deleted", true);
    advance(10);
    meter.processed("deleted", "markdown", 2_000, false);
    meter.forget("deleted");

    meter.embedded("deleted", 90);
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeNull();
  });

  test("a Document processed under one embedding model isn't counted for the next, when it is embedded", () => {
    const { meter, advance, useEmbedding } = startMeter();
    useEmbedding("multilingual-e5-small");
    meter.started("notes", true);
    advance(10);
    meter.processed("notes", "markdown", 2_000, false);

    useEmbedding("another-model");
    meter.embedded("notes", 90);

    expect(meter.seconds(files(1, "markdown", 2_000))).toBeNull();
  });

  test("a reading counts only for the embedding model it began under", () => {
    const { meter, advance, useEmbedding } = startMeter();
    // Begun with embeddings on, read once they were turned off: neither model's time.
    useEmbedding("multilingual-e5-small");
    meter.started("switched", true);
    advance(10);
    useEmbedding("");
    meter.processed("switched", "markdown", 2_000, true);
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeNull();

    // Begun once they were on again, before anything else noticed: that model's time.
    useEmbedding("multilingual-e5-small");
    meter.started("after", true);
    advance(30);
    meter.processed("after", "markdown", 2_000, false);
    meter.embedded("after", 70);
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeCloseTo(0.1);
  });

  test("a write that fails is tried again when the meter closes, and the failure is reported", () => {
    let time = 0;
    let stored: string | undefined;
    let failing = true;
    const failures: unknown[] = [];
    const meter = createReadingMeter({
      clock: () => time,
      embedding: () => "",
      read: () => (stored === undefined ? undefined : JSON.parse(stored)),
      write: (speed) => {
        if (failing) throw new Error("The disk is full.");
        stored = JSON.stringify(speed);
      },
      reportError: (error) => failures.push(error),
    });
    meter.started("notes", true);
    time += 10;
    meter.processed("notes", "text", 4_000, true);
    expect(failures).toHaveLength(1);
    expect(stored).toBeUndefined();

    failing = false;
    meter.close();
    expect(failures).toHaveLength(1);
    const restarted = startMeter(stored);
    expect(restarted.meter.seconds(files(10, "text", 4_000))).toBeCloseTo(0.1);
  });

  test("turning embeddings on or off, or another model, starts again: reading takes another time", () => {
    const { meter, read, useEmbedding } = startMeter();
    read("markdown", 2_000, 10);
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeCloseTo(0.01);

    useEmbedding("multilingual-e5-small");
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeNull();
    read("markdown", 2_000, 100);
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeCloseTo(0.1);

    useEmbedding("");
    expect(meter.seconds(files(1, "markdown", 2_000))).toBeNull();
  });

  test("it is kept on this computer, so a restart still knows; what it can't read counts as nothing read", () => {
    const first = startMeter();
    first.read("csv", 5_000, 20);
    // Kept at most every 5 s while Documents are read (each is a database write), and on closing.
    for (let index = 0; index < 100; index++) first.read("csv", 5_000, 20);
    expect(first.writes()).toBe(1);
    first.advance(5_000);
    first.read("csv", 5_000, 20);
    expect(first.writes()).toBe(2);
    first.read("csv", 5_000, 20);
    first.meter.close();
    expect(first.writes()).toBe(3);

    const restarted = startMeter(first.kept());
    expect(restarted.meter.seconds(files(3, "csv", 5_000))).toBeCloseTo(0.06);

    const unreadable = startMeter(
      JSON.stringify({ embedding: "", kinds: { csv: { count: "many" } } }),
    );
    expect(unreadable.meter.seconds(files(3, "csv", 5_000))).toBeNull();

    // Kept without the smallest and largest sizes read: that kind is measured again, from the
    // next file of it read.
    const older = startMeter(
      JSON.stringify({
        embedding: "",
        kinds: {
          csv: { count: 3, megabytes: 0.005, seconds: 0.02, sizeSquares: 0, products: 0 },
        },
      }),
    );
    expect(older.meter.seconds(files(3, "csv", 5_000))).toBeNull();
    older.read("csv", 5_000, 30);
    expect(older.meter.seconds(files(3, "csv", 5_000))).toBeCloseTo(0.09);
  });
});
