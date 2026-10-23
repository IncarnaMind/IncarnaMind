import { describe, expect, onTestFinished, test } from "vitest";
import type { ProcessingJob, ProcessingResult } from "../../src/core/documents/processing";
import { createProcessor, type ProcessorHandlers } from "../../src/core/documents/processor";
import { createSourceFolder, writeSourceFile } from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";

describe("Processing jobs on workers", { timeout: 30_000 }, () => {
  test("a PDF stopped while its password is read never reaches its worker: the next PDF there still starts cold (#1506)", async () => {
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
    const job = async (documentId: string): Promise<ProcessingJob> => ({
      task: "process",
      documentId,
      kind: "pdf",
      file: await writeSourceFile(
        folder,
        `${documentId}.pdf`,
        buildPdf([{ lines: ["Spring tides."] }]),
      ),
    });

    const stopped = resultOf("locked");
    processor.enqueue(await job("locked"));
    await expect.poll(() => starts.length).toBe(1);
    processor.cancel("locked");
    release(undefined);
    expect(await stopped).toEqual({ outcome: "stopped" });

    const next = resultOf("next");
    processor.enqueue(await job("next"));
    expect((await next).outcome).toBe("ready");
    expect(starts).toEqual([
      ["locked", false],
      ["next", false],
    ]);
  });
});
