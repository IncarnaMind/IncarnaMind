/**
 * The every-format evaluation set (eval/retrieval/formats.json, #70),
 * checked against what processing stores, without the models: each quote is
 * on its expected Units and on no other Unit of its Document, those Units can
 * be cited together, and a Passage that covers them holds the quote, so a hit
 * and a "found" Citation are both possible: a Word comment's too, read into
 * the section its mark is in since #76, and a Web page's, read from its
 * snapshot as `saveWebPage` makes it (#155). A known gap's quote, a scanned
 * page's, is in none of its Document's Units. Every format has at least 3
 * hard places; each of the big formats has 3 Questions per place in each
 * language, and a Web page's 4 pages have 2, one per page.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type EvalDocument, FORMATS_SET, loadEvaluationSet } from "../../eval/lib/evaluationSet";
import { FORMATS, type FormatId, formatOf } from "../../eval/lib/formats";
import { kindOf } from "../../src/core/documents/files";
import type { BuiltPassage, PageText } from "../../src/core/documents/passages";
import { processFile } from "../../src/core/documents/processing";
import { snapshotOf } from "../../src/core/documents/web/snapshot";
import { quoteInUnits } from "../../src/shared/locations";
import { findQuote } from "../../src/shared/quoteMatch";
import { sameRun } from "../../src/shared/units";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SET = loadEvaluationSet(ROOT, FORMATS_SET);

interface Stored {
  outcome: string;
  units: PageText[];
  passages: BuiltPassage[];
}

const stored = new Map<string, Stored>();
let scratch: string;

/** The file processing reads: a Web page's snapshot, as `saveWebPage` makes it from its HTML. */
async function processedFile(document: EvalDocument) {
  const kind = document.kind ?? kindOf(document.path);
  if (!kind) throw new Error(`${document.path} isn't a Document format.`);
  if (kind !== "web") return { file: document.path, kind };
  const address = `http://127.0.0.1/${document.key}`;
  const xhtml = snapshotOf(await readFile(document.path, "utf8"), address, address).xhtml;
  const file = join(scratch, `${document.key}.xhtml`);
  await writeFile(file, xhtml);
  return { file, kind };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "format-set-"));
  for (const document of SET.documents) {
    const { file, kind } = await processedFile(document);
    const result = await processFile({ task: "process", documentId: document.key, kind, file });
    stored.set(document.key, {
      outcome: result.outcome,
      units: result.outcome === "ready" ? result.pages : [],
      passages: result.outcome === "ready" ? result.passages : [],
    });
  }
}, 120_000);

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const inRange = (unit: PageText, [from, to]: [number, number]) =>
  unit.page !== null && unit.page >= from && unit.page <= to;

describe("The every-format evaluation set", () => {
  test.each(
    SET.questions
      .filter((question) => !question.knownGap)
      .map((question) => [question.id, question] as const),
  )(
    "%s: the quote is on its expected Units only, and in a Passage that covers them",
    (_id, question) => {
      const { document, pages, quote } = question.expected;
      const { outcome, units, passages } = stored.get(document) as Stored;
      expect(outcome).toBe("ready");
      const expected = units.filter((unit) => inRange(unit, pages));
      expect(expected.map((unit) => unit.page)).toEqual(
        Array.from({ length: pages[1] - pages[0] + 1 }, (_, index) => pages[0] + index),
      );
      // A Citation names one Unit, or two consecutive ones of one run.
      expect(expected.length).toBeLessThanOrEqual(2);
      if (expected.length === 2)
        expect(sameRun(expected[0] as PageText, expected[1] as PageText)).toBe(true);
      expect(quoteInUnits(expected, quote), "on its Units").not.toBeNull();
      for (const unit of units.filter((each) => !inRange(each, pages))) {
        expect(quoteInUnits([unit], quote), `also on Unit ${unit.page}`).toBeNull();
      }
      const covering = passages.filter(
        (passage) =>
          passage.pageFrom !== null &&
          passage.pageTo !== null &&
          passage.pageFrom <= pages[0] &&
          passage.pageTo >= pages[1],
      );
      expect(covering.some((passage) => findQuote(passage.text, quote) !== null)).toBe(true);
    },
  );

  test("a known gap's quote is in none of its Document's Units: a scan has no text", () => {
    const gaps = SET.questions.filter((question) => question.knownGap);
    expect(gaps.length).toBeGreaterThan(0);
    // Word comments are read since #76: their Questions are checked as the others are, above.
    expect(gaps.filter((question) => question.place === "comment")).toEqual([]);
    for (const question of gaps) {
      const { outcome, units } = stored.get(question.expected.document) as Stored;
      if (question.place === "scanned") expect(outcome, question.id).toBe("no-text");
      else expect(quoteInUnits(units, question.expected.quote), question.id).toBeNull();
    }
  });

  test("every format has at least 3 hard places, and each has 2 or 3 Questions in each language", () => {
    const counts = new Map<string, number>();
    for (const question of SET.questions.filter((each) => !each.crossLingual)) {
      const document = SET.documents.find((each) => each.key === question.expected.document);
      const format = formatOf(document?.path ?? "", document?.kind);
      const key = `${format} ${question.place} ${question.language}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Two pages in each language, one Question per page in each of the Web page's places.
    const perPlace = (format: FormatId) => (format === "web" ? 2 : 3);
    for (const format of FORMATS) {
      const places = new Set(
        [...counts.keys()]
          .filter((key) => key.startsWith(`${format.id} `))
          .map((key) => key.split(" ")[1]),
      );
      expect(places.size, format.label).toBeGreaterThanOrEqual(3);
      for (const place of places) {
        for (const language of ["en", "zh"]) {
          expect(
            counts.get(`${format.id} ${place} ${language}`) ?? 0,
            `${format.label}, ${place}, ${language}`,
          ).toBeGreaterThanOrEqual(perPlace(format.id));
        }
      }
    }
  });

  test("every cross-lingual Question has a translated query, and only those do", () => {
    for (const question of SET.questions) {
      expect(question.translatedQuery !== undefined, question.id).toBe(question.crossLingual);
    }
  });
});
