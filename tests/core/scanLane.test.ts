import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Core, Document, TextRecognizer } from "../../src/core";
import { type ReadingChannel, runJob } from "../../src/core/documents/processing";
import { scansAtOnce } from "../../src/core/documents/processor";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { createTempDataFolder, NO_MODEL_FILES, startCore } from "../helpers/core";
import {
  createSourceFolder,
  waitForDocuments,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";

const SCANS = join(import.meta.dirname, "../fixtures/scans");
const picture = readFileSync(join(SCANS, "en-clean.jpg"));
const set = JSON.parse(readFileSync(join(SCANS, "set.json"), "utf8")) as {
  pages: { id: string; lines: string[] }[];
};
const lines = set.pages.find((page) => page.id === "en-clean")?.lines ?? [];

/** The model, slowed: no page is read until `release`. It counts the pages it was asked for. */
function slowRecognizer() {
  const fake = createFakeTextRecognizer({
    script: { pages: { 1: { lines }, 2: { lines } } },
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked = { pages: 0 };
  const recognizer: TextRecognizer = {
    load: (files) => fake.load(files),
    async read(page, number) {
      asked.pages++;
      await released;
      return fake.read(page, number);
    },
    readFile: (file, number) => fake.readFile(file, number),
    close: () => fake.close(),
  };
  return { recognizer, release, asked };
}

const scanPdf = () => buildPdf([{ scan: picture }, { scan: picture }]);
const textPdf = (pages: number) =>
  buildPdf(
    Array.from({ length: pages }, (_, index) => ({
      lines: [`Page ${index + 1}. The senior facilities end on 14 February 2029.`],
    })),
  );

async function addFiles(core: Core, files: [string, Uint8Array | string][]): Promise<Document[]> {
  const sources = await createSourceFolder();
  const paths = [];
  for (const [name, contents] of files) paths.push(await writeSourceFile(sources, name, contents));
  const { documents } = await core.addDocuments(paths);
  return documents;
}

const byName = (documents: readonly Document[], file: string) => {
  const name = file.replace(/\.\w+$/, "");
  const found = documents.find((document) => document.name === name);
  if (!found) throw new Error(`${file} isn't listed.`);
  return found;
};

// The waits are for states, with room for a busy runner: four PDFs on worker threads at once.
const WAIT_MS = 45_000;

describe("A text file is never held behind a scan (#1502)", { timeout: 180_000 }, () => {
  // protects=a Document that needs no text recognition is ready while a scan added before it is still read, and the scan finishes after; fails_when=the text PDF or the Markdown file waits until the scan's pages are read; no_claim=how long the real model takes.
  test("a text PDF and a Markdown file added after a scan are ready while its pages are still read", async () => {
    const dataDir = await createTempDataFolder();
    const slow = slowRecognizer();
    const core = startCore(dataDir, {
      textRecognizer: slow.recognizer,
      textRecognitionModelSource: NO_MODEL_FILES,
      scansAtOnce: 1,
    });
    try {
      const [scan, text, notes] = await addFiles(core, [
        ["Lease scan.pdf", scanPdf()],
        ["Facilities agreement.pdf", textPdf(60)],
        ["Notes.md", "# Notes\n\nThe deposit is returned within 30 days.\n"],
      ]);
      if (!scan || !text || !notes) throw new Error("The files weren't added.");

      const ready = await waitForProcessing(core, [text.id, notes.id], WAIT_MS);
      expect(ready.map((document) => document.status)).toEqual(["ready", "ready"]);
      const [stillReading] = (await core.listDocuments()).filter((each) => each.id === scan.id);
      expect(stillReading).toMatchObject({
        status: "extracting",
        scan: { pages: 2, read: 0, of: "scanned-pages" },
      });

      slow.release();
      const [read] = await waitForProcessing(core, [scan.id], WAIT_MS);
      expect(read?.status).toBe("ready");
      const [found] = await core.searchPassages("undisputed invoice", { mode: "keyword" });
      expect(found?.documentId).toBe(scan.id);
    } finally {
      core.close();
    }
  });

  // protects=scans found while the scan lane is full wait their turn, queued with their scan progress (what the sidebar's "2 waiting" counts), and are read in the order they were added, while a text file after them is ready at once; with room for two, two are read at once; fails_when=a waiting scan holds the text file, shows as being read, or is read out of order; no_claim=the sidebar's wording, which the smoke test shows.
  test.each([
    [1, ["extracting", "queued", "queued"]],
    [2, ["extracting", "extracting", "queued"]],
  ])(
    "with room for %i scan(s) at once, the others wait their turn, in order",
    async (room, states) => {
      const dataDir = await createTempDataFolder();
      const slow = slowRecognizer();
      const core = startCore(dataDir, {
        textRecognizer: slow.recognizer,
        textRecognitionModelSource: NO_MODEL_FILES,
        scansAtOnce: room,
      });
      const order: string[] = [];
      core.on("document.status", (document) => {
        if (document.status === "ready" && !order.includes(document.name))
          order.push(document.name);
      });
      try {
        const added = await addFiles(core, [
          ["Scan A.pdf", scanPdf()],
          ["Scan B.pdf", scanPdf()],
          ["Scan C.pdf", scanPdf()],
          ["Board minutes.pdf", textPdf(3)],
        ]);
        const text = byName(added, "Board minutes.pdf");
        await waitForProcessing(core, [text.id], WAIT_MS);
        const documents = await waitForDocuments(
          core,
          (each) => {
            const scans = ["Scan A.pdf", "Scan B.pdf", "Scan C.pdf"].map((name) =>
              byName(each, name),
            );
            expect(scans.map((scan) => scan.status)).toEqual(states);
            for (const scan of scans) expect(scan.scan).toMatchObject({ pages: 2, read: 0 });
          },
          WAIT_MS,
        );
        expect(byName(documents, "Board minutes.pdf").status).toBe("ready");

        slow.release();
        await waitForProcessing(
          core,
          added.map((document) => document.id),
          WAIT_MS,
        );
        // One at a time, they are read in order; two at once may finish in any order.
        expect(order[0]).toBe("Board minutes");
        expect([...order].sort()).toEqual(["Board minutes", "Scan A", "Scan B", "Scan C"]);
        if (room === 1) expect(order).toEqual(["Board minutes", "Scan A", "Scan B", "Scan C"]);
        for (const document of await core.listDocuments()) expect(document.scan).toBeNull();
      } finally {
        core.close();
      }
    },
  );

  // protects=a scan waiting its turn keeps its place when its unchanged file is looked at again (opening it does, as does each retry once a folder's watcher has failed), so scans are still read in the order they were added (#1664); fails_when=the look sends it back through the queue, behind a scan added after it; no_claim=a new version of the file, which goes to the back of the queue as new work.
  test("a scan waiting its turn keeps its place when the User opens it", async () => {
    const dataDir = await createTempDataFolder();
    const slow = slowRecognizer();
    const core = startCore(dataDir, {
      textRecognizer: slow.recognizer,
      textRecognitionModelSource: NO_MODEL_FILES,
      scansAtOnce: 1,
    });
    const order: string[] = [];
    core.on("document.status", (document) => {
      if (document.status === "ready" && !order.includes(document.name)) order.push(document.name);
    });
    try {
      const first = await addFiles(core, [
        ["Scan A.pdf", scanPdf()],
        ["Scan B.pdf", scanPdf()],
      ]);
      await waitForDocuments(
        core,
        (each) => {
          expect(byName(each, "Scan A.pdf").status).toBe("extracting");
          expect(byName(each, "Scan B.pdf")).toMatchObject({
            status: "queued",
            scan: { pages: 2, read: 0 },
          });
        },
        WAIT_MS,
      );
      // B is opened while it waits for the lane and C, added after it, is read from the queue.
      const later = await addFiles(core, [["Scan C.pdf", scanPdf()]]);
      const opened = await core.openDocumentFile(byName(first, "Scan B.pdf").id);
      await opened.stream.cancel();

      await waitForDocuments(
        core,
        (each) => {
          const scans = ["Scan A.pdf", "Scan B.pdf", "Scan C.pdf"].map((name) =>
            byName(each, name),
          );
          expect(scans.map((scan) => scan.status)).toEqual(["extracting", "queued", "queued"]);
          for (const scan of scans) expect(scan.scan).toMatchObject({ pages: 2, read: 0 });
        },
        WAIT_MS,
      );
      slow.release();
      await waitForProcessing(
        core,
        [...first, ...later].map((document) => document.id),
        WAIT_MS,
      );
      expect(order).toEqual(["Scan A", "Scan B", "Scan C"]);
    } finally {
      core.close();
    }
  });

  // protects=a waiting scan that is deleted leaves nothing behind and the lane goes on; fails_when=it is read anyway, or the next scan never starts; no_claim=none beyond protects.
  test("a waiting scan that is deleted is never read, and the next one is", async () => {
    const dataDir = await createTempDataFolder();
    const slow = slowRecognizer();
    const core = startCore(dataDir, {
      textRecognizer: slow.recognizer,
      textRecognitionModelSource: NO_MODEL_FILES,
      scansAtOnce: 1,
    });
    try {
      const added = await addFiles(core, [
        ["Scan A.pdf", scanPdf()],
        ["Scan B.pdf", scanPdf()],
        ["Scan C.pdf", scanPdf()],
      ]);
      await waitForDocuments(
        core,
        (each) => {
          expect(byName(each, "Scan B.pdf").status).toBe("queued");
          expect(byName(each, "Scan C.pdf").scan).not.toBeNull();
        },
        WAIT_MS,
      );
      await core.deleteDocument(byName(added, "Scan B.pdf").id);
      slow.release();
      const [a, c] = await waitForProcessing(
        core,
        [byName(added, "Scan A.pdf").id, byName(added, "Scan C.pdf").id],
        WAIT_MS,
      );
      expect([a?.status, c?.status]).toEqual(["ready", "ready"]);
      // Two pages each for A and C: a scan waiting for its turn asks for none.
      expect(slow.asked.pages).toBe(4);
    } finally {
      core.close();
    }
  });

  // protects=quitting while one scan is read and another waits: the waiting one is still queued, so the next start reads it rather than counting it as what stopped the app; fails_when=the waiting scan fails with "The app stopped while it was being read"; no_claim=the scan being read when the app quit (#1504).
  test("a scan that waited when the app quit is read at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const first = slowRecognizer();
    const core = startCore(dataDir, {
      textRecognizer: first.recognizer,
      textRecognitionModelSource: NO_MODEL_FILES,
      scansAtOnce: 1,
    });
    const added = await addFiles(core, [
      ["Scan A.pdf", scanPdf()],
      ["Scan B.pdf", scanPdf()],
    ]);
    await waitForDocuments(
      core,
      (each) => {
        expect(byName(each, "Scan A.pdf").status).toBe("extracting");
        expect(byName(each, "Scan B.pdf").status).toBe("queued");
      },
      WAIT_MS,
    );
    core.close();

    const again = slowRecognizer();
    again.release();
    const restarted = startCore(dataDir, {
      textRecognizer: again.recognizer,
      textRecognitionModelSource: NO_MODEL_FILES,
      scansAtOnce: 1,
    });
    try {
      const [b] = await waitForProcessing(restarted, [byName(added, "Scan B.pdf").id], WAIT_MS);
      expect(b).toMatchObject({ status: "ready", failure: null });
    } finally {
      restarted.close();
    }
  });
});

describe("A scan told to stop (#1502)", () => {
  // protects=a scan stopped while its page is being drawn stops, instead of asking for a read nobody answers; fails_when=it asks once stopped and the job never ends, which leaves the scan lane waiting for it; no_claim=the lane, which the tests above cover.
  test("one stopped while its page is drawn ends as stopped, and asks for no read", async () => {
    const sources = await createSourceFolder();
    const file = await writeSourceFile(sources, "Scan.pdf", scanPdf());
    const stop = new AbortController();
    const asked: number[] = [];
    const channel: ReadingChannel = {
      signal: stop.signal,
      // The stop lands as the page is drawn, a moment after the first progress.
      progress: (_hash, read) => {
        if (read === 0) queueMicrotask(() => stop.abort());
      },
      log: () => undefined,
      read: (page) => {
        asked.push(page);
        return new Promise(() => undefined);
      },
      readFile: () => new Promise(() => undefined),
    };

    const result = await runJob(
      {
        task: "process",
        documentId: "scan",
        kind: "pdf",
        file,
        scan: { reader: "fake", keep: null },
      },
      channel,
    );

    expect(result.outcome).toBe("stopped");
    expect(asked).toEqual([]);
  });
});

describe("How many scans are read at once", () => {
  // protects=two at once only where the computer has the cores and memory for it; fails_when=a small computer reads two scans at once; no_claim=how fast either is.
  test.each([
    [12, 32, 2],
    [8, 16, 2],
    [8, 8, 1],
    [4, 32, 1],
  ])("%i cores and %i GB: %i", (cores, gigabytes, expected) => {
    expect(scansAtOnce(cores, gigabytes * 2 ** 30)).toBe(expected);
  });
});
