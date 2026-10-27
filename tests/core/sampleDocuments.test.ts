/**
 * The sample PDFs in `data/` (data/README.md): each is the file
 * `npm run samples:generate` writes, and the processing pipeline stores the
 * text its tests and evaluations quote on the pages they cite, and nowhere
 * else. A change to a sample's content is a change to what those tests read.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { bytesOf, SAMPLE_DOCUMENTS } from "../../scripts/sampleDocuments/samples";
import { matchingOf } from "../../src/core/answers/citations";
import { processFile } from "../../src/core/documents/processing";
import { findQuote } from "../../src/shared/quoteMatch";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * SHA-256 (its first 12 hex characters) of every run of 12 words in the four third-party papers
 * this folder held before 2026-10-25, taken from their stored text. A Document that repeats a
 * sentence of those papers, or most of one, repeats one of these runs.
 */
const OLD_RUNS = new Set(
  readFileSync(join(ROOT, "tests/fixtures/old-paper-12-word-runs.txt"), "utf8")
    .split("\n")
    .filter(Boolean),
);
const RUN = 12;

/** Every run of `RUN` words in a text, as the digest the fixture holds, with the words themselves. */
function runsOf(text: string): { digest: string; words: string }[] {
  const words =
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const runs: { digest: string; words: string }[] = [];
  for (let at = 0; at + RUN <= words.length; at++) {
    const run = words.slice(at, at + RUN).join(" ");
    runs.push({ digest: createHash("sha256").update(run).digest("hex").slice(0, 12), words: run });
  }
  return runs;
}

describe("The sample Documents in data/", { timeout: 600_000 }, () => {
  for (const document of SAMPLE_DOCUMENTS) {
    test(`${document.file} is generated, and keeps its quoted text on its pages`, async () => {
      const bytes = bytesOf(document);
      const stored = readFileSync(join(ROOT, "data", document.file));
      expect(Buffer.from(bytes).equals(stored)).toBe(true);

      // The file must present its fictional organisation in its metadata too, not only on its pages.
      const source = Buffer.from(bytes).toString("latin1");
      for (const [key, value] of Object.entries(document.metadata)) {
        expect(source, `${key}: ${value}`).toContain(`/${key} (${value})`);
      }

      const result = await processFile({
        task: "process",
        documentId: document.file,
        kind: "pdf",
        file: join(ROOT, "data", document.file),
      });
      if (result.outcome !== "ready") throw new Error(`${document.file}: ${result.outcome}`);
      expect(result.pages.map((page) => page.page)).toEqual(
        Array.from({ length: document.pageCount }, (_, index) => index + 1),
      );

      const matching = matchingOf(result.pages);
      const quotes = document.pages.flatMap((page, index) =>
        (page.anchors ?? []).map((quote) => ({ quote, page: index + 1 })),
      );
      for (const { quote, page } of quotes) {
        const text = result.pages.find((each) => each.page === page)?.text ?? "";
        expect(findQuote(text, quote, matching), `p. ${page}: ${quote}`).not.toBeNull();
        for (const other of result.pages) {
          if (other.page === page) continue;
          expect(
            findQuote(other.text, quote, matching),
            `also p. ${other.page}: ${quote}`,
          ).toBeNull();
        }
      }
    });
  }

  test("no Document repeats 12 words of the papers this folder held before 2026-10-25", async () => {
    const shared: string[] = [];
    for (const document of SAMPLE_DOCUMENTS) {
      const result = await processFile({
        task: "process",
        documentId: document.file,
        kind: "pdf",
        file: join(ROOT, "data", document.file),
      });
      if (result.outcome !== "ready") throw new Error(`${document.file}: ${result.outcome}`);
      for (const page of result.pages) {
        for (const run of runsOf(page.text)) {
          if (OLD_RUNS.has(run.digest))
            shared.push(`${document.file}, p. ${page.page}: ${run.words}`);
        }
      }
    }
    expect(shared).toEqual([]);
  });
});
