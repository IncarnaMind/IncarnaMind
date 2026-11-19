/**
 * The pair set through the rules that give an uncited sentence a Passage's Citation
 * (src/core/answers/unmarkedQuotes.ts), with no model: each pair's sentence as an Answer of one
 * sentence, beside its Document's text as the one Passage shown. A pair attached when a Citation
 * is added; it is right when the sentence says what the Passage says. Held-out pairs are counted,
 * never printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { matchUnmarked, mayDrawOn } from "../../src/core/answers/unmarkedQuotes";
import { normaliseText } from "../../src/shared/text";
import { DOCUMENTS, PAIRS, type PairKind } from "./pairs";

const root = fileURLToPath(new URL("../..", import.meta.url));

interface PairResult {
  id: string;
  kind: PairKind;
  language: "en" | "zh";
  same: boolean;
  heldOut: boolean;
  /** The quote of the Citation added, or null. */
  attached: string | null;
  /** With nothing attached: whether the product would ask the model once for this Answer's Citations. */
  asks: boolean;
}

function throughRules(): PairResult[] {
  return PAIRS.map((pair) => {
    const document = DOCUMENTS.find((each) => each.key === pair.document);
    if (!document) throw new Error(`${pair.id}: no Document "${pair.document}"`);
    if (!document.text.includes(pair.passage)) {
      throw new Error(`${pair.id}: its Passage sentence isn't in "${document.name}"`);
    }
    const passages = [{ id: "P1", text: document.text }];
    const held = normaliseText(document.text);
    const found = (_passage: string, quote: string) => held.includes(normaliseText(quote));
    const [match] = matchUnmarked(pair.sentence, passages, found);
    return {
      id: pair.id,
      kind: pair.kind,
      language: pair.language,
      same: pair.same,
      heldOut: pair.heldOut,
      attached: match?.quote ?? null,
      asks: !match && mayDrawOn(pair.sentence, passages),
    };
  });
}

const KINDS: readonly PairKind[] = [
  "same-words",
  "paraphrase",
  "party",
  "modal",
  "negation",
  "unit",
  "period",
  "condition",
  "direction",
  "quoted",
];

function table(results: readonly PairResult[]): string {
  const lines = [
    "| Kind | Should attach | en attached | zh attached | Would ask the model (of those not attached) |",
    "|---|---|--:|--:|--:|",
  ];
  for (const kind of KINDS) {
    const of = results.filter((each) => each.kind === kind);
    const count = (language: "en" | "zh") => {
      const mine = of.filter((each) => each.language === language);
      return `${mine.filter((each) => each.attached !== null).length} of ${mine.length}`;
    };
    const left = of.filter((each) => each.attached === null);
    lines.push(
      `| ${kind} | ${of[0]?.same ? "yes" : "no"} | ${count("en")} | ${count("zh")} | ${left.filter((each) => each.asks).length} of ${left.length} |`,
    );
  }
  const right = results.filter((each) => each.same && each.attached !== null).length;
  const wrong = results.filter((each) => !each.same && each.attached !== null).length;
  lines.push(
    "",
    `Right Citations added: ${right} of ${results.filter((each) => each.same).length}. Wrong Citations added: ${wrong} of ${results.filter((each) => !each.same).length}.`,
  );
  return lines.join("\n");
}

test("the pair set through today's rules", () => {
  const results = throughRules();
  console.log(table(results));
  for (const each of results.filter((result) => !result.heldOut)) {
    const pair = PAIRS.find((candidate) => candidate.id === each.id);
    console.log(
      `${each.id}: ${each.attached === null ? "none" : "attached"}${each.asks ? " (would ask)" : ""} | ${pair?.sentence}`,
    );
  }
  const out = join(root, "eval", "results", "uncited");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "rules.json"), `${JSON.stringify(results, null, 2)}\n`);
  expect(results).toHaveLength(PAIRS.length);
});
