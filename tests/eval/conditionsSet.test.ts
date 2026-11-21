/**
 * The dropped-condition set (eval/checks/conditions/set.json, #3512), checked without a model: each
 * sentence that drops a condition, limit or qualifier has a faithful twin on the same Document, the
 * words it drops are in the Document's own words and not in the sentence, and the Document's words
 * are found in what processing stores for it. The set is frozen at the bars posted on the issue: a
 * changed file fails until new bars are posted for it.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readChecksSet } from "../../eval/checks/lib/set";
import { kindOf } from "../../src/core/documents/files";
import type { PageText } from "../../src/core/documents/passages";
import { processFile } from "../../src/core/documents/processing";
import { snapshotOf } from "../../src/core/documents/web/snapshot";
import { quoteInUnits } from "../../src/shared/locations";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SET = join(ROOT, "eval", "checks", "conditions");
const FROZEN = "ccab89e6ac7a184142c2c5b3e39531470c27c19dbf3e65f403eb06ebeebba97d";
const AGREEMENTS = [
  "Office lease - 14 Calder Street.docx",
  "Supply agreement - Harlow Freight.docx",
];

interface Item {
  id: string;
  language: "en" | "zh";
  document: string;
  sentence: string;
  kind: "drops" | "faithful" | "says-less";
  pair: string;
  dropped: string | null;
  quote: string;
}

const raw = await readFile(join(SET, "set.json"));
const items = (JSON.parse(raw.toString("utf8")) as { items: Item[] }).items;
const standing = await readChecksSet(ROOT);
const lower = (text: string) => text.toLowerCase();

let scratch: string;
const stored = new Map<string, PageText[]>();

async function unitsOf(name: string, path: string, address?: string): Promise<PageText[]> {
  let file = path;
  let kind = kindOf(file);
  if (address) {
    file = join(scratch, `${name}.xhtml`);
    await writeFile(file, snapshotOf(await readFile(path, "utf8"), address, address).xhtml);
    kind = "web";
  }
  if (!kind) throw new Error(`${path} isn't a Document format.`);
  const result = await processFile({ task: "process", documentId: name, kind, file });
  if (result.outcome !== "ready") throw new Error(`${path} didn't process.`);
  return result.pages;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "conditions-set-"));
  const wanted = new Set(items.map((item) => item.document));
  for (const document of standing.folder.filter((each) => wanted.has(each.name))) {
    stored.set(
      document.name,
      await unitsOf(document.name, join(ROOT, document.path), document.address),
    );
  }
  for (const name of AGREEMENTS)
    stored.set(name, await unitsOf(name, join(SET, "documents", name)));
}, 120_000);

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("The dropped-condition set", () => {
  test("is the file the bars on #3512 were posted for", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(FROZEN);
  });

  test("has English and Chinese sentences, each id once", () => {
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items.filter((item) => item.kind === "drops")).toHaveLength(25);
    for (const item of items) {
      expect(/\p{Script=Han}/u.test(item.sentence), item.id).toBe(item.language === "zh");
    }
  });

  test("each sentence that drops something has one faithful twin on the same Document", () => {
    for (const drop of items.filter((item) => item.kind === "drops")) {
      const twins = items.filter((item) => item.kind === "faithful" && item.pair === drop.pair);
      expect(twins, drop.pair).toHaveLength(1);
      expect(twins[0]?.document, drop.pair).toBe(drop.document);
      expect(twins[0]?.sentence, drop.pair).not.toBe(drop.sentence);
    }
  });

  test.each(items.map((item) => [item.id, item] as const))(
    "%s: the Document's words are found, and what a drop leaves out is in them and not in the sentence",
    (_id, item) => {
      const units = stored.get(item.document) ?? [];
      expect(units.length, `${item.document} was processed`).toBeGreaterThan(0);
      expect(quoteInUnits(units, item.quote), "the Document's words").not.toBeNull();
      if (item.kind === "drops") {
        expect(item.dropped).not.toBeNull();
        expect(lower(item.quote), "dropped words in the Document").toContain(
          lower(item.dropped ?? ""),
        );
        expect(lower(item.sentence), "dropped words in the sentence").not.toContain(
          lower(item.dropped ?? ""),
        );
      }
    },
  );
});
