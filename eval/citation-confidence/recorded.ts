/**
 * `node --import ./scripts/tsResolve.mjs eval/citation-confidence/recorded.ts <checks report.json> <out.json>` makes pairs of the
 * sentences of the checks evaluation (eval/checks) with the quote the check cited, as
 * `npm run eval -- eval/checks` records it: the Citations a model really chose. Each is labelled from the
 * checks labels and the check's verdict: a quote cited for a sentence the labels call supported, or
 * a "supported" the labels don't allow, or a contradicting quote.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { here, isRow, splitOf } from "./shared";
import type { Label, Language, Pair } from "./types";

interface Outcome {
  verdict: string;
  evidence?: { document: string; quote: string };
}

const [reportPath, outPath] = process.argv.slice(2);
if (!reportPath || !outPath) throw new Error("Usage: recorded.ts <report.json> <out.json>");

const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  results: { findSupport: { id: string; outcome: Outcome }[] };
};
const labels = JSON.parse(readFileSync(here("../checks/labels.json"), "utf8")) as {
  items: { id: string; language: Language; sentence?: string; label: string }[];
};
const byId = new Map(labels.items.map((each) => [each.id, each]));

const pairs: Pair[] = [];
for (const { id, outcome } of report.results.findSupport) {
  const item = byId.get(id);
  const evidence = outcome.evidence;
  if (!item?.sentence || !evidence?.quote) continue;
  let label: Label | null = null;
  if (outcome.verdict === "supported") label = item.label === "supported" ? "SUPPORTS" : "NOT";
  else if (item.label !== "supported") label = "NOT";
  if (!label) continue;
  pairs.push({
    id: `rec:${id}`,
    source: "recorded",
    kind: `${item.label}:${outcome.verdict}`,
    language: item.language,
    label,
    sentence: item.sentence,
    quote: evidence.quote,
    ...(/^fs-20[1-8]$/.test(id)
      ? { caveat: "calculated" as const }
      : isRow(evidence.document, evidence.quote) && { caveat: "table-row" as const }),
    split: splitOf(id),
  });
}
writeFileSync(outPath, `${JSON.stringify(pairs, null, 1)}\n`);
console.log(
  pairs.length,
  "recorded pairs",
  pairs.filter((each) => each.label === "SUPPORTS").length,
  "SUPPORTS",
);
