/**
 * Whether Check this Note works a figure out again from a data file's rows, on a real model: each
 * file of `rowsSentences.cases.ts` is added as a Document in a Folder of its own, and each right
 * sentence and its wrong twin is checked in a Note of its own, as Check this Note does, with the
 * app's Python helper for the Analysis (`../helpers/pyodideAnalysis`: build first, so
 * resources/python exists). A wrong twin is never to be Supported. The test measures and asserts
 * no verdict: one JSON line a sentence, and one for the run, to INCARNAMIND_LIVE_GATE_OUT.
 *
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by
 * default), or INCARNAMIND_LIVE_GATE_PROVIDER=deepseek with INCARNAMIND_LIVE_KEY and
 * INCARNAMIND_LIVE_MODEL. INCARNAMIND_LIVE_GATE_ARM labels the lines, INCARNAMIND_LIVE_GATE_CASES
 * picks pairs by the start of their ids ("orders,loans-03"), INCARNAMIND_LIVE_GATE_STOP_USD sends
 * no request once that much is spent, and INCARNAMIND_LIVE_GATE_REPLIES keeps every reply.
 */
import { appendFileSync } from "node:fs";
import type { LanguageModelV4CallOptions, LanguageModelV4Usage } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { type AnalysisRuntime, type Core, createAiSdkChatModel } from "../../src/core";
import { costOf, inCurrency } from "../../src/core/cost/price";
import { catalogModel } from "../../src/core/providers/catalog";
import { ANALYSIS_TOOLS } from "../../src/core/tools";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { pyodideAnalysisRuntime } from "../helpers/pyodideAnalysis";
import { ROWS_DATASETS, type RowsDataset, type RowsPair } from "./rowsSentences.cases";

const PROVIDER =
  process.env.INCARNAMIND_LIVE_GATE_PROVIDER === "deepseek" ? "deepseek" : "anthropic";
const KEY =
  PROVIDER === "deepseek"
    ? process.env.INCARNAMIND_LIVE_KEY
    : process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  (PROVIDER === "deepseek"
    ? process.env.INCARNAMIND_LIVE_MODEL
    : process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL) ?? "claude-haiku-5-5";
const OUT = process.env.INCARNAMIND_LIVE_GATE_OUT ?? "";
const REPLIES = process.env.INCARNAMIND_LIVE_GATE_REPLIES;
const ARM = process.env.INCARNAMIND_LIVE_GATE_ARM ?? "unnamed";
const CASES = process.env.INCARNAMIND_LIVE_GATE_CASES?.split(",").filter(Boolean);
const STOP = Number(process.env.INCARNAMIND_LIVE_GATE_STOP_USD ?? "Infinity");
const PRICE = catalogModel(PROVIDER, MODEL)?.price;
/** The Python runtime runs one job at a time, so more Notes at once only queue for it. */
const AT_ONCE = 3;

type Params = LanguageModelV4CallOptions;
type Usage = LanguageModelV4Usage;

/** What one sentence's check cost: its requests, their price, and the Analyses its model ran. */
interface Tally {
  requests: number;
  priced: number;
  analyses: number;
}

interface HeardCall {
  tool: string;
  input: unknown;
}

const heard = {
  requests: 0,
  refused: 0,
  failed: 0,
  timedOut: 0,
  inputTokens: 0,
  outputTokens: 0,
  spent: 0,
  held: 0,
  /** Requests whose prompt held none of the sentences being checked. */
  unattributed: 0,
};

/** The sentences being checked now, each with its tally. */
const checking = new Map<string, Tally>();

const textOf = (prompt: Params["prompt"], role?: string): string =>
  prompt
    .filter((message) => (role ? message.role === role : message.role !== "system"))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");

/** What the Tools answered since the model's last turn, each cut to its first words. */
function toolResults(prompt: Params["prompt"]): { tool: string; output: string }[] {
  const from = prompt.findLastIndex((message) => message.role === "assistant");
  return prompt
    .slice(from + 1)
    .flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result"
              ? [{ tool: part.toolName, output: JSON.stringify(part.output).slice(0, 600) }]
              : [],
          )
        : [],
    );
}

const dollarsOf = (usage: Usage): number => {
  if (!PRICE) return 0;
  const input = usage.inputTokens;
  return inCurrency(
    costOf(
      {
        inputTokens: input.total ?? 0,
        cachedInputTokens: input.cacheRead ?? 0,
        cacheWriteTokens: input.cacheWrite ?? 0,
        outputTokens: usage.outputTokens.total ?? 0,
      },
      PRICE,
      new Date(),
      { cacheWrites: PROVIDER === "anthropic" },
    ),
    PRICE.currency,
    "USD",
  );
};

/** Counts a request and finds the sentence it is for: the longest being checked that its prompt holds. */
function begin(params: Params): Tally | undefined {
  if (heard.spent >= STOP) {
    heard.held++;
    throw new Error("The spend stop is reached; no more requests are sent.");
  }
  heard.requests++;
  const prompt = textOf(params.prompt);
  const found = [...checking]
    .filter(([sentence]) => prompt.includes(sentence))
    .sort(([a], [b]) => b.length - a.length)[0];
  const tally = found?.[1];
  if (tally) tally.requests++;
  else heard.unattributed++;
  return tally;
}

function heardFailure(error: unknown): never {
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number(error.statusCode)
      : null;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") heard.timedOut++;
  else if (status !== null && status >= 400) heard.refused++;
  else heard.failed++;
  throw error;
}

/** Adds a finished reply to the run's and its sentence's counts, and keeps it when asked to. */
function heardReply(
  params: Params,
  tally: Tally | undefined,
  usage: Usage | undefined,
  text: string,
  calls: readonly HeardCall[],
) {
  if (usage) {
    const dollars = dollarsOf(usage);
    heard.inputTokens += usage.inputTokens.total ?? 0;
    heard.outputTokens += usage.outputTokens.total ?? 0;
    heard.spent += dollars;
    if (tally) tally.priced += dollars;
  }
  if (tally) tally.analyses += calls.filter((call) => call.tool === ANALYSIS_TOOLS.run).length;
  if (REPLIES && (text.length > 0 || calls.length > 0))
    appendFileSync(
      REPLIES,
      `${JSON.stringify({ arm: ARM, to: textOf(params.prompt, "system").slice(0, 80), prompt: textOf(params.prompt), results: toolResults(params.prompt), text, calls })}\n`,
    );
}

/** The real model, every request counted. */
const realModel: NonNullable<Parameters<typeof startCore>[1]>["createChatModel"] = (spec) =>
  wrapLanguageModel({
    model: createAiSdkChatModel(spec),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        const tally = begin(params);
        const result = await Promise.resolve(doGenerate()).catch(heardFailure);
        const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        const calls = result.content.flatMap((part) =>
          part.type === "tool-call" ? [{ tool: part.toolName, input: part.input }] : [],
        );
        heardReply(params, tally, result.usage, text.join(""), calls);
        return result;
      },
      wrapStream: async ({ doStream, params }) => {
        const tally = begin(params);
        const result = await Promise.resolve(doStream()).catch(heardFailure);
        let text = "";
        let usage: Usage | undefined;
        const calls: HeardCall[] = [];
        const stream = result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "text-delta") text += part.delta;
              if (part.type === "tool-call") calls.push({ tool: part.toolName, input: part.input });
              if (part.type === "error") heard.failed++;
              if (part.type === "finish") usage = part.usage;
              controller.enqueue(part);
            },
            flush() {
              heardReply(params, tally, usage, text, calls);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });

function write(row: Record<string, unknown>) {
  if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

async function coreFor(language: RowsDataset["language"], analysisRuntime: AnalysisRuntime) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: realModel,
    analysisRuntime,
    ...(PROVIDER === "deepseek" && {
      modelFacts: () => ({ calculates: true, analysisTool: true, checkCalculates: true }),
    }),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language } });
  await core.saveChatProvider({ kind: PROVIDER, apiKey: KEY ?? "", modelId: MODEL });
  return core;
}

async function checkSentence(
  core: Core,
  folderId: string,
  dataset: RowsDataset,
  pair: RowsPair,
  which: "right" | "wrong",
) {
  const sentence = pair[which];
  const mind = await core.createMind({ title: `${pair.id}-${which}`, folderId });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "paragraph", attrs: { id: "line-0" }, content: [{ type: "text", text: sentence }] },
  ]);
  await client.settled();
  const tally: Tally = { requests: 0, priced: 0, analyses: 0 };
  checking.set(sentence, tally);
  const started = performance.now();
  const run = await core
    .checkMind({ requestId: `${ARM}-${pair.id}-${which}`, mindId: mind.id, mode: "all" })
    .finally(() => checking.delete(sentence));
  const seconds = (performance.now() - started) / 1000;
  await client.settled();
  const check = claimSpans(readMind(client)).find(
    (each) => each.sentence.text.trim() === sentence,
  )?.check;
  write({
    arm: ARM,
    group: "rows",
    dataset: dataset.id,
    language: dataset.language,
    case: `${pair.id}-${which}`,
    way: pair.way,
    expected: which,
    sentence,
    run: run.kind,
    state: check?.state ?? "no-mark",
    reason: check?.state === "not-checked" ? check.reason : null,
    word: check?.unsupported?.word ?? check?.parts?.[0]?.unsupported?.word ?? null,
    by: check?.parts?.[0]?.modelId ?? check?.modelId ?? null,
    seconds: Number(seconds.toFixed(1)),
    requests: tally.requests,
    priced: Number(tally.priced.toFixed(5)),
    ranAnalysis: tally.analyses,
  });
}

/** Runs `work` on every item, `size` at a time. */
async function inPool<Item>(
  items: readonly Item[],
  size: number,
  work: (item: Item) => Promise<void>,
) {
  const queue = items[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let next = queue.next(); !next.done; next = queue.next()) await work(next.value);
    }),
  );
}

async function checkDataset(
  dataset: RowsDataset,
  pairs: readonly RowsPair[],
  analysisRuntime: AnalysisRuntime,
) {
  const core = await coreFor(dataset.language, analysisRuntime);
  const sources = await createSourceFolder();
  const [file] = await addAndProcess(
    core,
    [await writeSourceFile(sources, dataset.fileName, dataset.csv)],
    180_000,
  );
  if (file?.status !== "ready") throw new Error(`${dataset.fileName} didn't process.`);
  const folder = await core.createLibraryGroup({ name: dataset.id, description: "" });
  await core.moveToFolder({ documentIds: [file.id], folderId: folder.id });
  const probes = pairs.flatMap((pair) => [
    { pair, which: "right" as const },
    { pair, which: "wrong" as const },
  ]);
  await inPool(probes, AT_ONCE, async ({ pair, which }) => {
    if (heard.held === 0) await checkSentence(core, folder.id, dataset, pair, which);
  });
  core.close();
  return probes.length;
}

describe("sentences about a data file's rows", () => {
  test.skipIf(KEY === undefined)(
    "each sentence and its wrong twin, checked once",
    { timeout: 3_600_000 },
    async () => {
      if (!OUT) throw new Error("INCARNAMIND_LIVE_GATE_OUT must name the file the lines go to.");
      if (Number.isFinite(STOP) && !PRICE)
        throw new Error(`No price is known for ${MODEL}, so the stop can't be kept to.`);
      const started = performance.now();
      const wanted = ROWS_DATASETS.map(
        (dataset) =>
          [
            dataset,
            dataset.pairs.filter(
              (pair) => CASES?.some((start) => pair.id.startsWith(start)) ?? true,
            ),
          ] as const,
      ).filter(([, pairs]) => pairs.length > 0);
      let checked = 0;
      try {
        const analysisRuntime = await pyodideAnalysisRuntime();
        for (const [dataset, pairs] of wanted)
          checked += await checkDataset(dataset, pairs, analysisRuntime);
      } finally {
        write({
          group: "run",
          arm: ARM,
          model: MODEL,
          complete:
            heard.held === 0 &&
            checked === wanted.reduce((sum, [, pairs]) => sum + 2 * pairs.length, 0),
          requests: heard.requests,
          refused: heard.refused,
          failed: heard.failed,
          timedOut: heard.timedOut,
          inputTokens: heard.inputTokens,
          outputTokens: heard.outputTokens,
          priced: Number(heard.spent.toFixed(5)),
          held: heard.held,
          unattributed: heard.unattributed,
          seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
        });
      }
      expect(heard.requests).toBeGreaterThan(0);
    },
  );
});
