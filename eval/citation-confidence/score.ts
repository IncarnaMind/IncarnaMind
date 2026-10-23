/**
 * `node --import ./scripts/tsResolve.mjs eval/citation-confidence/score.ts --out <folder> [--variants a,b] [--split dev|test|all]`
 * asks a decision model, for every pair (pairs.ts), whether the quote states the sentence, and
 * saves the probability it gives. Jev needs JEV_API_KEY (the key is never printed). A Jev-compatible
 * server on this computer (Tev1 in Ollama) takes `--url`, `--model` and `--key` instead; a request
 * already saved in the folder is not sent again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ask, type Server } from "./client";
import { loadPairs } from "./pairs";
import type { Pair, Score } from "./types";
import { VARIANTS, type Variant } from "./variants";

const args = parseArgs({
  options: {
    out: { type: "string" },
    variants: { type: "string" },
    split: { type: "string", default: "all" },
    url: { type: "string", default: "https://api.typesafe.ai" },
    model: { type: "string", default: "jev-latest" },
    key: { type: "string" },
    pairs: { type: "string" },
    concurrency: { type: "string", default: "6" },
    limit: { type: "string" },
  },
});

const out = args.values.out;
if (!out) throw new Error("--out <folder> is required");
mkdirSync(out, { recursive: true });
const apiKey = args.values.key ?? process.env.JEV_API_KEY;
if (!apiKey) throw new Error("Set JEV_API_KEY, or pass --key for a local server.");

const pairs = loadPairs(args.values.pairs);
const chosen = (args.values.variants ?? Object.keys(VARIANTS).join(",")).split(",");
const wanted = pairs
  .filter((each) => args.values.split === "all" || each.split === args.values.split)
  .slice(0, args.values.limit ? Number(args.values.limit) : undefined);

const server: Server = { url: args.values.url ?? "", key: apiKey, model: args.values.model ?? "" };

async function score(variant: Variant, pair: Pair): Promise<Score> {
  const answer = await ask(server, variant.state(pair), variant.question).catch(
    (error: unknown) => {
      throw new Error(`${pair.id}: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
  return { pair: pair.id, variant: variant.id, ...answer };
}

for (const id of chosen) {
  const variant = VARIANTS[id];
  if (!variant) throw new Error(`Unknown variant ${id}`);
  const file = join(out, `scores-${id}.jsonl`);
  const done = new Set(
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as Score).pair)
      : [],
  );
  const queue = wanted.filter((each) => !done.has(each.id));
  let sent = 0;
  const worker = async () => {
    for (let pair = queue.shift(); pair; pair = queue.shift()) {
      appendFileSync(file, `${JSON.stringify(await score(variant, pair))}\n`);
      sent++;
    }
  };
  await Promise.all(Array.from({ length: Number(args.values.concurrency) }, worker));
  console.log(`${id}: ${sent} requests sent, ${done.size} already saved`);
}
