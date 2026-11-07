/**
 * `npm run eval:ocr` (eval/ocr/README.md), the app's own path: the set's
 * pages as one scanned PDF, processed as the app processes a Document
 * (`processFile`: pdf.js finds the scanned pages and draws each one, the
 * built-in model reads it, its Unit and Passages are built), timed whole,
 * then each page's quotes looked for in its stored Unit with the Citation
 * check's matcher.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { processFile } from "../../src/core/documents/processing";
import { BUILT_IN_TEXT_RECOGNITION_MODEL } from "../../src/core/documents/scan/model";
import { createOnnxTextRecognizer } from "../../src/core/documents/scan/onnx";
import { downloadModel, isModelDownloaded } from "../../src/core/embedding/download";
import { findQuote } from "../../src/shared/quoteMatch";
import { buildPdf } from "../../tests/helpers/pdf";
import { evalCache } from "../lib/cache";
import { createLog } from "../lib/log";
import { quotesOf, type SetPage } from "./lib/score";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const setDir = join(root, "tests/fixtures/scans");
const cacheDir = evalCache();
const wanted = process.env.INCARNAMIND_OCR_ENGINES?.split(",").map((each) => each.trim());

test.runIf(!wanted || wanted.includes("pipeline"))(
  "the app reads the set as one scanned PDF",
  async () => {
    const log = createLog();
    const set = (
      JSON.parse(await readFile(join(setDir, "set.json"), "utf8")) as { pages: SetPage[] }
    ).pages;
    const model = BUILT_IN_TEXT_RECOGNITION_MODEL;
    const directory = join(cacheDir, "models", model.folder);
    if (!isModelDownloaded(directory, model.source.files)) {
      log(`Downloading ${model.name}…`);
      await downloadModel({
        directory,
        source: model.source,
        signal: new AbortController().signal,
        onProgress() {},
      });
    }
    const recognizer = createOnnxTextRecognizer();
    await recognizer.load({
      detector: join(directory, model.files.detector),
      recognizer: join(directory, model.files.recognizer),
    });
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-ocr-"));
    try {
      const file = join(folder, "Set.pdf");
      const pictures = await Promise.all(set.map((page) => readFile(join(setDir, page.file))));
      await writeFile(file, buildPdf(pictures.map((scan) => ({ scan }))));
      const started = performance.now();
      const result = await processFile(
        {
          task: "process",
          documentId: "set",
          kind: "pdf",
          file,
          scan: { reader: model.reader, keep: null },
        },
        {
          read: (page, picture) => recognizer.read(picture, page),
          readFile: (page, file) => recognizer.readFile(file, page),
          log: () => {},
          progress: () => {},
          head: () => {},
          signal: new AbortController().signal,
        },
      );
      const seconds = (performance.now() - started) / 1000;
      if (result.outcome !== "ready") throw new Error(`The PDF wasn't read: ${result.outcome}`);
      let found = 0;
      let quotes = 0;
      set.forEach((page, index) => {
        const unit = result.pages[index];
        for (const quote of quotesOf(page)) {
          quotes++;
          if (unit && findQuote(unit.text, quote)) found++;
        }
      });
      log(
        `The app read ${set.length} scanned pages in ${seconds.toFixed(1)} s (${(seconds / set.length).toFixed(2)} s a page, drawing included); quotes found in the stored text: ${found}/${quotes}`,
      );
      expect(found).toBeGreaterThan(quotes * 0.8);
    } finally {
      recognizer.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
);
