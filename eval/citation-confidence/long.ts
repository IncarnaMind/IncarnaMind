/**
 * `node --import ./scripts/tsResolve.mjs eval/citation-confidence/long.ts --out <folder>` hides each quote of a sample of pairs
 * inside more and more unrelated text from the same language (as a Passage, a page or a section
 * would carry it) and asks the question again, to see where the answers stop being trustworthy and
 * where the server refuses. Prints Markdown. Needs JEV_API_KEY.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ask, type Server } from "./client";
import { auc } from "./metrics";
import { loadPairs } from "./pairs";
import { dice, hash, trigrams } from "./shared";
import type { Pair } from "./types";
import { VARIANTS } from "./variants";

const args = parseArgs({
  options: {
    out: { type: "string" },
    url: { type: "string", default: "https://api.typesafe.ai" },
    model: { type: "string", default: "jev-latest" },
    key: { type: "string" },
    variant: { type: "string", default: "yes-no-context" },
    each: { type: "string", default: "40" },
    threshold: { type: "string", default: "0.63" },
    filler: { type: "string", default: "unrelated" },
    concurrency: { type: "string", default: "6" },
  },
});
if (!args.values.out) throw new Error("--out <folder> is required");
mkdirSync(args.values.out, { recursive: true });
const key = args.values.key ?? process.env.JEV_API_KEY;
if (!key) throw new Error("Set JEV_API_KEY.");
const server: Server = { url: args.values.url ?? "", key, model: args.values.model ?? "" };
const variant = VARIANTS[args.values.variant ?? ""];
if (!variant) throw new Error("Unknown variant");

const pairs = loadPairs();
const short = pairs.filter(
  (each) => !each.caveat && each.source !== "labels" && each.source !== "mutation",
);
const each = Number(args.values.each);
const pick = (list: Pair[]) => [...list].sort((a, b) => hash(a.id) - hash(b.id)).slice(0, each);
const sample = [
  ...pick(short.filter((p) => p.label === "SUPPORTS")),
  ...pick(short.filter((p) => p.label !== "SUPPORTS")),
];
const similar = args.values.filler === "similar";
const filler = pairs.filter(
  (p) =>
    !p.caveat && (similar ? short.includes(p) : p.source === "labels" && p.label === "SUPPORTS"),
);

// Characters a token covers, roughly, to size the filler; the server reports the real count.
const CHARS_PER_TOKEN = { en: 4.2, zh: 1.5 };
const LENGTHS = similar ? [0, 500, 2000, 8000] : [0, 500, 2000, 8000, 24000, 36000];
const POSITIONS = ["start", "middle", "end"] as const;
type Position = (typeof POSITIONS)[number];

function surround(pair: Pair, tokens: number, position: Position): string {
  if (tokens === 0) return pair.quote;
  const budget = tokens * CHARS_PER_TOKEN[pair.language];
  const own = trigrams(pair.sentence);
  const pool = filler
    .filter(
      (p) => p.language === pair.language && p.id !== pair.id && dice(own, trigrams(p.quote)) < 0.4,
    )
    .sort((a, b) => hash(`${pair.id}${a.id}`) - hash(`${pair.id}${b.id}`));
  const parts: string[] = [];
  let size = pair.quote.length;
  for (let i = 0; size < budget; i++) {
    const next = pool[i % pool.length]?.quote ?? "";
    parts.push(next);
    size += next.length + 1;
  }
  const at =
    position === "start" ? 0 : position === "end" ? parts.length : Math.floor(parts.length / 2);
  parts.splice(at, 0, pair.quote);
  return parts.join(pair.language === "zh" ? "" : " ");
}

interface Result {
  pair: string;
  tokens: number;
  position: Position;
  supports: number | null;
  inputTokens: number;
  error?: string;
}

const file = join(args.values.out, "long.jsonl");
const done = new Map<string, Result>();
if (existsSync(file))
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const result = JSON.parse(line) as Result;
    done.set(`${result.pair}|${result.tokens}|${result.position}`, result);
  }

const jobs = sample
  .flatMap((pair) =>
    LENGTHS.flatMap((tokens) =>
      (tokens === 0
        ? (["middle"] as const)
        : tokens >= 8000
          ? POSITIONS
          : (["middle"] as const)
      ).map((position) => ({ pair, tokens, position })),
    ),
  )
  .filter((job) => !done.has(`${job.pair.id}|${job.tokens}|${job.position}`));

const worker = async () => {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const state = variant.state({
      ...job.pair,
      quote: surround(job.pair, job.tokens, job.position),
    });
    const result: Result = await ask(server, state, variant.question)
      .then((answer) => ({
        pair: job.pair.id,
        tokens: job.tokens,
        position: job.position,
        supports: answer.supports,
        inputTokens: answer.inputTokens,
      }))
      .catch((error: unknown) => ({
        pair: job.pair.id,
        tokens: job.tokens,
        position: job.position,
        supports: null,
        inputTokens: 0,
        error: error instanceof Error ? error.message : String(error),
      }));
    appendFileSync(file, `${JSON.stringify(result)}\n`);
    done.set(`${result.pair}|${result.tokens}|${result.position}`, result);
  }
};
await Promise.all(Array.from({ length: Number(args.values.concurrency) }, worker));

const threshold = Number(args.values.threshold);
const label = new Map(sample.map((p) => [p.id, p.label === "SUPPORTS"]));
console.log(
  `## Quotes inside longer text (${args.values.variant}, ${similar ? "other quotes of the same style" : "unrelated documents"}, ${sample.length} pairs: ${sample.filter((p) => p.label === "SUPPORTS").length} SUPPORTS)\n`,
);
console.log(
  "| Added text (tokens, about) | Quote at | Input tokens (mean) | Refused | AUC | SUPPORTS at or above the threshold | Others at or above |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const tokens of LENGTHS) {
  for (const position of tokens === 0
    ? (["middle"] as const)
    : tokens >= 8000
      ? POSITIONS
      : (["middle"] as const)) {
    const rows = [...done.values()].filter((r) => r.tokens === tokens && r.position === position);
    const answered = rows.filter((r) => r.supports !== null);
    const items = answered.map((r) => ({
      score: r.supports ?? 0,
      positive: label.get(r.pair) === true,
    }));
    const positives = items.filter((i) => i.positive);
    const negatives = items.filter((i) => !i.positive);
    const share = (list: typeof items) =>
      list.length === 0
        ? "n/a"
        : `${list.filter((i) => i.score >= threshold).length} of ${list.length}`;
    const mean =
      answered.length === 0
        ? 0
        : Math.round(answered.reduce((s, r) => s + r.inputTokens, 0) / answered.length);
    console.log(
      `| ${tokens} | ${tokens === 0 ? "-" : position} | ${mean} | ${rows.length - answered.length} of ${rows.length} | ${answered.length ? auc(items).toFixed(3) : "n/a"} | ${share(positives)} | ${share(negatives)} |`,
    );
  }
}
const errors = [
  ...new Set([...done.values()].flatMap((r) => (r.error ? [r.error.slice(0, 160)] : []))),
];
if (errors.length) console.log(`\nRefusals: ${errors.join(" | ")}`);
