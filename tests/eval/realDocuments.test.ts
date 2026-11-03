/**
 * The real Documents in `data/real/` (data/README.md): each is listed with its source, the
 * licence and the day it was read, the basis in the licence's or the statute's own words and
 * its SHA-256; the gating set, the hard tier and the everyday reports library read the same
 * files; and the scanned page really has no text.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { reports } from "../../eval/everyday/asking";
import { loadManifest } from "../../eval/hard/lib/manifest";
import { processFile } from "../../src/core/documents/processing";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DATA = join(ROOT, "data");
/** The README's path, relative to data/, as a file. */
const dataPath = (file: string) => join(DATA, file);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const unquote = (cell: string) => cell.replace(/^`|`$/g, "");

interface RealDocument {
  file: string;
  source: string;
  licence: string;
  checked: string;
  basis: string;
  sha256: string;
}

/** The rows of the first table under `heading`, as cells. */
function rowsUnder(markdown: string, heading: string): string[][] {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`No ${heading} in data/README.md.`);
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(/\n#{1,6} /);
  const lines = (end < 0 ? rest : rest.slice(0, end)).split("\n");
  return lines
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

async function realDocuments(): Promise<RealDocument[]> {
  const markdown = await readFile(join(ROOT, "data", "README.md"), "utf8");
  return rowsUnder(markdown, "## Real Documents in `real/`").map((cells) => {
    const [file, title, pages, source, licence, basis, hash] = cells;
    if (!file || !title || !pages || !source || !licence || !basis || !hash) {
      throw new Error(
        `A row of data/README.md's real Documents table is short: ${cells.join(" | ")}`,
      );
    }
    const date = /\((\d{4}-\d{2}-\d{2})\)/.exec(licence)?.[1];
    if (!date) throw new Error(`${file}: its licence has no date read.`);
    return {
      file: unquote(file),
      source,
      licence,
      checked: date,
      basis,
      sha256: unquote(hash),
    };
  });
}

/** Every PDF under data/real, relative to data/. */
async function pdfsInReal(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".pdf"))
        found.push(`real/${path.slice(join(DATA, "real").length + 1)}`);
    }
  };
  await walk(join(DATA, "real"));
  return found.sort();
}

describe("The real Documents in data/real/", { timeout: 60_000 }, () => {
  test("each is listed with its source, licence, date, basis and SHA-256, and no file is unlisted", async () => {
    const documents = await realDocuments();
    expect(documents.length).toBeGreaterThanOrEqual(5);
    for (const document of documents) {
      expect(document.sha256, document.file).toMatch(/^[0-9a-f]{64}$/);
      const bytes = await readFile(dataPath(document.file));
      expect(sha256(bytes), document.file).toBe(document.sha256);
      expect(document.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(document.source, document.file).toMatch(/^https:\/\//);
      expect(document.basis.length, document.file).toBeGreaterThan(20);
    }
    expect((await pdfsInReal()).sort()).toEqual(documents.map((each) => each.file).sort());
  });

  test("the hard tier reads the same six, and the gating set the five with text", async () => {
    const documents = await realDocuments();
    const manifest = loadManifest(ROOT);
    expect(manifest.sources["repository-real"]?.terms).toBe("data/README.md");
    for (const document of documents) {
      const path = `data/${document.file}`;
      const entry = manifest.documents.find((each) => each.path === path);
      expect(entry, path).toBeDefined();
      expect(entry?.sha256, path).toBe(document.sha256);
    }
    const gating = JSON.parse(
      await readFile(join(ROOT, "eval", "retrieval", "questions.json"), "utf8"),
    ) as { documents: Record<string, string> };
    const inGating = new Set(Object.values(gating.documents));
    for (const document of documents) {
      const path = `data/${document.file}`;
      // The one-page scan has no text to search, so only the hard tier, which allows unread
      // Documents, takes it; the gating run requires every Document to be ready.
      expect(inGating.has(path), path).toBe(!document.file.includes("/scanned/"));
    }
  });

  test("the everyday reports library reads the five readable Documents, and the scanned page has no text", async () => {
    const documents = await realDocuments();
    const paths = new Set((await reports()).map((each) => each.path));
    for (const document of documents) {
      expect(paths.has(dataPath(document.file)), document.file).toBe(
        !document.file.includes("/scanned/"),
      );
    }
    const scan = documents.find((each) => each.file.includes("/scanned/"));
    if (!scan) return;
    const result = await processFile({
      task: "process",
      documentId: "real-scan",
      kind: "pdf",
      file: dataPath(scan.file),
    });
    if (result.outcome !== "no-text") throw new Error(`The scan has text: ${result.outcome}.`);
    expect(result.pageCount).toBe(1);
  });
});
