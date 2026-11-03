import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import type { ProcessingJob, ProcessingResult } from "../../src/core/documents/processing";
import { createProcessor, type ProcessorHandlers } from "../../src/core/documents/processor";
import { createSourceFolder, writeSourceFile } from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";

describe("Processing jobs on workers", { timeout: 30_000 }, () => {
  test("a worker counts as warm for a kind only once it has read a file of it (#1506)", async () => {
    let release = (_password: string | undefined) => {};
    const password = new Promise<string | undefined>((resolve) => {
      release = resolve;
    });
    const starts: [string, boolean][] = [];
    const finished = new Map<string, (result: ProcessingResult) => void>();
    const resultOf = (documentId: string) =>
      new Promise<ProcessingResult>((resolve) => finished.set(documentId, resolve));
    const handlers: ProcessorHandlers = {
      onStart(job, warm) {
        starts.push([job.documentId, warm]);
        return undefined;
      },
      onWaiting() {},
      onResult(job, result) {
        finished.get(job.documentId)?.(result);
      },
      onMetadata() {},
      onKeywords() {},
      onProgress() {},
      read: async () => [],
      readFile: async () => {
        throw new Error("This test reads no pictures.");
      },
      onLog() {},
      isUnavailable: () => false,
      password: (job) => (job.documentId === "locked" ? password : Promise.resolve(undefined)),
    };
    const processor = createProcessor(handlers);
    onTestFinished(() => processor.close());
    const folder = await createSourceFolder();
    const pdf = (documentId: string, file: string): ProcessingJob => ({
      task: "process",
      documentId,
      kind: "pdf",
      file,
    });
    const tides = await writeSourceFile(
      folder,
      "tides.pdf",
      buildPdf([{ lines: ["Spring tides."] }]),
    );
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
    expect(await run(pdf("missing", join(folder, "missing.pdf")))).toBe("file-unreadable");
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
});
