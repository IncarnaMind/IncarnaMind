/**
 * The checks evaluation's labels (eval/checks/labels.json, #86), checked
 * against the text processing stores, without a model: every evidence quote,
 * claim and conflicting quote is found, as the Citation check finds a quote,
 * on the Units its Location names, and that Location reads as labelled. A web
 * page is read as saving it reads it. The sets are the sizes #86 asks for.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type LabelledQuote, readChecksSet, type SetDocument } from "../../eval/checks/lib/set";
import { kindOf } from "../../src/core/documents/files";
import type { PageText } from "../../src/core/documents/passages";
import { processFile } from "../../src/core/documents/processing";
import { snapshotOf } from "../../src/core/documents/web/snapshot";
import { englishLocation, locationOf, quoteInUnits } from "../../src/shared/locations";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const set = await readChecksSet(ROOT);
let scratch: string;
const stored = new Map<string, PageText[]>();

/** A Document's Units as processing stores them; a web page's from its snapshot, as `saveWebPage` makes it. */
async function unitsOf(document: SetDocument): Promise<PageText[]> {
  let file = join(ROOT, document.path);
  let kind = kindOf(file);
  if (document.address) {
    const html = await readFile(file, "utf8");
    file = join(scratch, `${document.sha256}.xhtml`);
    await writeFile(file, snapshotOf(html, document.address, document.address).xhtml);
    kind = "web";
  }
  if (!kind) throw new Error(`${document.path} isn't a Document format.`);
  const result = await processFile({ task: "process", documentId: document.name, kind, file });
  if (result.outcome !== "ready") throw new Error(`${document.path} didn't process.`);
  return result.pages;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "check-set-"));
  for (const document of [...set.folder, ...set.received]) {
    stored.set(document.name, await unitsOf(document));
  }
}, 120_000);

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** Where a quote is found on the Units it names: the Location's label, or null when it isn't there. */
function foundAt({ document, units: [from, to], quote }: Omit<LabelledQuote, "location">) {
  const units = (stored.get(document) ?? []).filter(
    (unit) => unit.page !== null && unit.page >= from && unit.page <= to,
  );
  if (units.length !== to - from + 1) return null;
  const ranges = quoteInUnits(units, quote);
  const location = ranges ? locationOf(units, ranges) : null;
  return location ? englishLocation(location, { speaker: false }) : null;
}

describe("The checks evaluation's labels", () => {
  test.each(set.items.map((item) => [item.id, item] as const))(
    "%s: each quote is found at its Location",
    (_id, item) => {
      if (item.evidence) {
        expect(foundAt(item.evidence), "the evidence").toBe(item.evidence.location);
      }
      if (item.set === "verify") {
        const claim = { document: item.document, units: item.units, quote: item.claim };
        expect(foundAt(claim), "the claim").toBe(item.location);
      }
      if (item.contradiction) {
        expect(foundAt(item.contradiction), "the conflicting words").toBe(
          item.contradiction.location,
        );
      }
    },
  );

  test("Find support has 208 sentences in English and Chinese, at least 100 supported, over every kind of Document", () => {
    const sentences = set.items.filter((item) => item.set === "find-support");
    expect(sentences).toHaveLength(208);
    expect(sentences.filter((item) => item.label === "supported").length).toBeGreaterThanOrEqual(
      100,
    );
    for (const language of ["en", "zh"]) {
      expect(sentences.filter((item) => item.language === language).length).toBeGreaterThan(50);
    }
    const formats = new Set(
      sentences.map(
        (item) => set.folder.find((document) => document.name === item.document)?.format,
      ),
    );
    for (const format of ["pdf", "docx", "xlsx", "pptx", "web"]) expect(formats).toContain(format);
  });

  test("verify has 10 received documents in both languages and several formats, with at least 40 contradicted and 60 unsupported claims", () => {
    expect(set.received).toHaveLength(10);
    expect(new Set(set.received.map((document) => document.language))).toEqual(
      new Set(["en", "zh"]),
    );
    expect(new Set(set.received.map((document) => document.format)).size).toBeGreaterThanOrEqual(3);
    const claims = set.items.filter((item) => item.set === "verify");
    expect(claims.filter((item) => item.label === "contradicted").length).toBeGreaterThanOrEqual(
      40,
    );
    expect(claims.filter((item) => item.label === "unsupported").length).toBeGreaterThanOrEqual(60);
    for (const document of set.received) {
      expect(claims.some((item) => item.document === document.name)).toBe(true);
    }
  });

  test("every Document is freely licensed or synthetic, with its source", () => {
    for (const document of [...set.folder, ...set.received]) {
      expect(["Apache-2.0", "CC BY-SA 4.0"]).toContain(document.licence);
      expect(document.source === "synthetic" || document.source.startsWith("https://")).toBe(true);
    }
  });
});
