/**
 * The Citations an evaluation run recorded, checked again with today's
 * Citation check, without asking a model again.
 *
 * The run of 2026-10-07 (Ollama's mistral, eval/README.md) marked 3 of its 12
 * English Citations "not found" though their quotes are on the cited pages: a
 * capital letter at the start of a quote, a reference "[36]" written "[^36]",
 * and an ellipsis. Its Citations are copied in
 * tests/fixtures/eval-citations-2026-10-07.json, re-based on 2026-10-26 on the
 * fictional sample Documents' own text. Each is checked against the
 * cited pages' stored text, which the processing pipeline (`processFile`, as
 * the core runs it before writing `document_pages`) gives for the sample PDFs
 * in data/ and the Chinese fixtures in eval/retrieval/fixtures/, and its
 * outcome is classified as the evaluation classifies it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type CitationOutcome, outcomeOf } from "../../eval/lib/citations";
import { checkCitation, matchingOf } from "../../src/core/answers/citations";
import type { PageText } from "../../src/core/documents/passages";
import { processFile } from "../../src/core/documents/processing";

interface Recorded {
  questionId: string;
  round: number;
  group: "en" | "zh";
  documentName: string;
  pageFrom: number;
  pageTo: number;
  quote: string;
  check: "found" | "not-found";
  checkReason: "quote-not-on-pages" | null;
  outcome: CitationOutcome;
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RECORDED = (
  JSON.parse(readFileSync(join(ROOT, "tests/fixtures/eval-citations-2026-10-07.json"), "utf8")) as {
    citations: Recorded[];
  }
).citations;

/** A Document's stored page text, as processing gives it, by its name. */
async function storedPages(name: string): Promise<PageText[]> {
  const file = [
    join(ROOT, "data", `${name}.pdf`),
    join(ROOT, "eval/retrieval/fixtures", `${name}.pdf`),
  ].find((path) => existsSync(path));
  if (!file) throw new Error(`No sample Document is called "${name}".`);
  const result = await processFile({ task: "process", documentId: name, kind: "pdf", file });
  if (result.outcome !== "ready") throw new Error(`"${name}" couldn't be processed.`);
  return result.pages;
}

interface Rechecked extends Recorded {
  now: { check: string; outcome: CitationOutcome };
}

async function recheck(): Promise<Rechecked[]> {
  const pages = new Map<string, PageText[]>();
  for (const name of new Set(RECORDED.map((citation) => citation.documentName))) {
    pages.set(name, await storedPages(name));
  }
  return RECORDED.map((citation) => {
    const all = pages.get(citation.documentName) ?? [];
    const range = { pageFrom: citation.pageFrom, pageTo: citation.pageTo };
    const { check, checkReason } = checkCitation({
      quote: citation.quote,
      range,
      passage: range,
      documentDeleted: false,
      pages: all.filter(
        ({ page }) => page !== null && page >= citation.pageFrom && page <= citation.pageTo,
      ),
      ...matchingOf(all),
    });
    const outcome = outcomeOf({ ...citation, check, checkReason }, all);
    return { ...citation, now: { check, outcome } };
  });
}

const count = (citations: readonly Rechecked[], outcome: CitationOutcome) =>
  citations.filter((citation) => citation.now.outcome === outcome).length;

describe("The Citations recorded on 2026-10-07, checked again", { timeout: 120_000 }, () => {
  test("have no false 'not found', and nothing else changes", async () => {
    const rechecked = await recheck();
    const english = rechecked.filter((citation) => citation.group === "en");
    const chinese = rechecked.filter((citation) => citation.group === "zh");

    // The run's figures: English 3 of 12 false "not found" (25%), Chinese 0 of 7.
    expect(RECORDED.filter((citation) => citation.outcome === "false-not-found")).toHaveLength(3);
    // Now: none, in either language.
    expect({ citations: english.length, falseNotFound: count(english, "false-not-found") }).toEqual(
      { citations: 12, falseNotFound: 0 },
    );
    expect({ citations: chinese.length, falseNotFound: count(chinese, "false-not-found") }).toEqual(
      { citations: 7, falseNotFound: 0 },
    );

    for (const citation of rechecked) {
      const label = `${citation.questionId} (round ${citation.round}): ${citation.quote}`;
      if (citation.outcome === "found" || citation.outcome === "false-not-found") {
        // The three misses are found now, and what was found still is.
        expect(citation.now, label).toEqual({ check: "found", outcome: "found" });
      } else {
        // Quotes that aren't on the cited pages (paraphrased, or from other pages) still aren't found.
        expect(citation.now, label).toEqual({ check: "not-found", outcome: citation.outcome });
      }
    }
    expect([count(english, "found"), count(chinese, "found")]).toEqual([8, 1]);
  });
});

describe("The evaluation's PDFs whose stored text lost its f-ligatures", {
  timeout: 120_000,
}, () => {
  test("are Vantrell's report alone, of a short paper and a long code of practice too", async () => {
    const lost = async (name: string) => matchingOf(await storedPages(name)).lostLigatures;

    expect(await lost("Vantrell Financial Group 2022 ESG Report")).toBe(true);
    expect(await lost("Weighted Keys Shorter Paths")).toBe(false);
    expect(await lost("MPMA Code of Practice for the Pharmaceutical Industry 2021")).toBe(false);
  });

  test("so Vantrell's quotes as its pages show them are found there, also beside a ligature its text kept", async () => {
    const pages = await storedPages("Vantrell Financial Group 2022 ESG Report");
    const check = (page: number, quote: string) =>
      checkCitation({
        quote,
        range: { pageFrom: page, pageTo: page },
        passage: { pageFrom: page, pageTo: page },
        documentDeleted: false,
        pages: pages.filter((each) => each.page === page),
        ...matchingOf(pages),
      });

    expect(
      check(8, "with the goal to finance and facilitate more than $1.4 trillion over eight years"),
    ).toEqual({ check: "found", checkReason: null });
    // A quote of p. 9 whose words the page kept with lost ligatures ("fnanced").
    expect(
      check(
        9,
        "In 2022, our Firm financed and facilitated approximately $118 billion toward the Target; $41 billion toward green, $52 billion toward development finance and $25 billion toward community development.",
      ),
    ).toEqual({ check: "found", checkReason: null });
  });
});
