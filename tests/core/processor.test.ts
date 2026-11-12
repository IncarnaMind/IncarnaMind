import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import type { ProcessingJob, ProcessingResult } from "../../src/core/documents/processing";
import { createProcessor, type ProcessorHandlers } from "../../src/core/documents/processor";
import { createSourceFolder, writeSourceFile } from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";

/** Handlers that do nothing, and read the password of the PDF named "locked" from `password`. */
const handlersWith = (
  password: Promise<string | undefined>,
  handlers: Partial<ProcessorHandlers>,
): ProcessorHandlers => ({
  onStart: () => undefined,
  onWaiting() {},
  onHead() {},
  onResult() {},
  onMetadata() {},
  onKeywords() {},
  onText() {},
  onProgress() {},
  read: async () => [],
  readFile: async () => {
    throw new Error("This test reads no pictures.");
  },
  onLog() {},
  isUnavailable: () => false,
  password: (job) => (job.documentId === "locked" ? password : Promise.resolve(undefined)),
  ...handlers,
});

const pdf = (documentId: string, file: string): ProcessingJob => ({
  task: "process",
  documentId,
  kind: "pdf",
  file,
});

/** A password the test hands over with `release`. */
function heldPassword() {
  let release = (_password: string | undefined) => {};
  const password = new Promise<string | undefined>((resolve) => {
    release = resolve;
  });
  return { password, release };
}

const tidesPdf = async () =>
  writeSourceFile(
    await createSourceFolder(),
    "tides.pdf",
    buildPdf([{ lines: ["Spring tides."] }]),
  );

describe("Processing jobs on workers", { timeout: 30_000 }, () => {
  test("a worker counts as warm for a kind only once it has read a file of it (#1506)", async () => {
    const { password, release } = heldPassword();
    const starts: [string, boolean][] = [];
    const finished = new Map<string, (result: ProcessingResult) => void>();
    const resultOf = (documentId: string) =>
      new Promise<ProcessingResult>((resolve) => finished.set(documentId, resolve));
    const processor = createProcessor(
      handlersWith(password, {
        onStart(job, warm) {
          starts.push([job.documentId, warm]);
          return undefined;
        },
        onResult(job, result) {
          finished.get(job.documentId)?.(result);
        },
      }),
    );
    onTestFinished(() => processor.close());
    const tides = await tidesPdf();
    const run = async (job: ProcessingJob) => {
      const result = resultOf(job.documentId);
      processor.enqueue(job);
      return (await result).outcome;
    };

    // Stopped while its password is read: it never reaches the worker.
    const stopped = resultOf("locked");
    processor.enqueue(pdf("locked", tides));
    await expect.poll(() => starts.length).toBe(1);
    processor.cancel("locked");
    release(undefined);
    expect((await stopped).outcome).toBe("stopped");
    // A file that can't be read is given up before PDF.js loads.
    expect(await run(pdf("missing", join(await createSourceFolder(), "missing.pdf")))).toBe(
      "file-unreadable",
    );
    // The first PDF read loads it; the next has nothing to load.
    expect(await run(pdf("first", tides))).toBe("ready");
    expect(await run(pdf("second", tides))).toBe("ready");

    expect(starts).toEqual([
      ["locked", false],
      ["missing", false],
      ["first", false],
      ["second", true],
    ]);
  });

  test("a check's read of a file runs after the file being processed, before the files waiting (#2216)", async () => {
    const { password, release } = heldPassword();
    const started: string[] = [];
    const ended: string[] = [];
    const processor = createProcessor(
      handlersWith(password, {
        onStart(job) {
          started.push(job.documentId);
          return undefined;
        },
        onResult(job) {
          ended.push(job.documentId);
        },
        onText(_job, result) {
          ended.push(`text: ${result.outcome}`);
        },
      }),
    );
    onTestFinished(() => processor.close());
    const tides = await tidesPdf();

    processor.enqueue(pdf("locked", tides));
    await expect.poll(() => started).toEqual(["locked"]);
    processor.enqueue(pdf("waiting 1", tides));
    processor.enqueue(pdf("waiting 2", tides));
    processor.enqueue({ task: "text", file: tides, kind: "pdf" });
    release(undefined);

    await expect.poll(() => ended.length).toBe(4);
    expect(ended).toEqual(["locked", "text: text", "waiting 1", "waiting 2"]);
  });
});
