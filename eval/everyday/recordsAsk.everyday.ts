/**
 * The gate for the ask for a check's missing records (`gates/records-ask.md`, README.md › The
 * records ask's gate), in three steps, each its own run of
 * `npx vitest run --config eval/everyday/vitest.config.ts recordsAsk`:
 *
 * - `INCARNAMIND_EVAL_EVERYDAY=records-ask`: one arm, from the folder whose `src` it runs. Both arms
 *   run at once, each in its own folder, and take turns item by item: `main`, then the branch.
 * - `records-ask-judge`: the judge reads every research ✓ of both arms, told no arm.
 * - `records-ask-bars`: the bars, with no request.
 *
 * `INCARNAMIND_EVAL_RECORDS_ASK_DRY=1` plays all three on the scripted chat model with no request
 * to any provider: no key may be set, and `fetch` throws.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { test } from "vitest";
import type { AnswerUsage } from "../../src/core";
import { costOf, inCurrency } from "../../src/core/cost/price";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { catalogFacts, modelsProviderOfKind } from "../../src/core/providers/catalog";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { watchCiting } from "../lib/citingRecord";
import { commitOf } from "../lib/commit";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { type Library, openLibrary } from "../lib/library";
import { createLog, type Log } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { type RequestTokens, watchTokens } from "../lib/tokens";
import { type CaseResult, reports, runCase } from "./asking";
import { CASES } from "./cases";
import { heardChecks } from "./checkRequests";
import { judgeStated } from "./judge";
import { watchReasks } from "./reasks";
import {
  ARMS,
  type Arm,
  GATE_JUDGE,
  GATE_MODEL,
  type Item,
  type ItemRecord,
  PAIRS,
  pilotItems,
  type Requests,
  recordFile,
  runItems,
  STOP_DOLLARS,
  sentenceOf,
  underTheStop,
  voidReasons,
} from "./recordsAsk";
import {
  type ArmInfo,
  emptyFields,
  type Judged,
  kindBSheet,
  readBars,
  reportLines,
  scoreOf,
  toJudge,
} from "./recordsAskBars";
import { DRY_RUN_PLACEHOLDER, dryChatModel, dryJudgeModel } from "./recordsAskDry";
import { sentenceSupport } from "./support";

const ROOT = resolve(__dirname, "../..");
const MODE = process.env.INCARNAMIND_EVAL_EVERYDAY?.trim();
const DRY = process.env.INCARNAMIND_EVAL_RECORDS_ASK_DRY === "1";
/** How many ✓ sentences the judge reads in one request. */
const JUDGE_BATCH = 10;

function runFolder(): string {
  const folder = process.env.INCARNAMIND_EVAL_RECORDS_ASK_RUN?.trim();
  if (!folder || !isAbsolute(folder))
    throw new Error(
      "Set INCARNAMIND_EVAL_RECORDS_ASK_RUN to the run's folder, an absolute path both arms share.",
    );
  return folder;
}

/** The plan fixes the models: a run that names others would be another run. */
function refuseOtherModels(): void {
  const named = Object.keys(process.env).filter(
    (name) =>
      /^INCARNAMIND_EVAL_(CHAT|JUDGE|SECOND_JUDGE)_/u.test(name) && process.env[name]?.trim(),
  );
  if (named.length > 0)
    throw new Error(
      `This gate's models are fixed, ${GATE_MODEL} with ${GATE_JUDGE} as judge: unset ${named.join(", ")}.`,
    );
}

/** The dry run loads no key, and any `fetch` throws, so nothing it does can reach a provider. */
function noProvider(): { calls: () => number } {
  const keys = Object.keys(process.env).filter(
    (name) =>
      /KEY|TOKEN/u.test(name) &&
      /^INCARNAMIND_|_API_KEY$|^ANTHROPIC_|^OPENAI_/u.test(name) &&
      process.env[name]?.trim(),
  );
  if (keys.length > 0) throw new Error(`The dry run loads no key: unset ${keys.join(", ")}.`);
  let calls = 0;
  globalThis.fetch = (input) => {
    calls++;
    console.error(`The dry run refused a fetch of ${String(input)}`, new Error().stack);
    throw new Error(`The dry run sends no request, but fetch was called for ${String(input)}.`);
  };
  return { calls: () => calls };
}

function keyOf(): string {
  const key = process.env.INCARNAMIND_EVAL_RECORDS_ASK_KEY?.trim();
  if (!key) throw new Error("Set INCARNAMIND_EVAL_RECORDS_ASK_KEY to the run's Anthropic key.");
  return key;
}

/** The SHA-256 of the files under `src`, so a record names the source each arm ran. */
async function sourceOf(root: string): Promise<string> {
  const folder = join(root, "src");
  const files = (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(folder, file)))
      .update("\0");
  return hash.digest("hex");
}

const PRICE = (modelId: string) => {
  const price = catalogFacts(modelsProviderOfKind("anthropic", null), modelId)?.price;
  return (usage: AnswerUsage): number | null =>
    price
      ? inCurrency(costOf(usage, price, new Date(), { cacheWrites: true }), price.currency, "USD")
      : null;
};

const usageOf = (request: RequestTokens): AnswerUsage => ({
  inputTokens: request.uncached + request.cacheRead + request.cacheWrite,
  outputTokens: request.output,
  cachedInputTokens: request.cacheRead,
  cacheWriteTokens: request.cacheWrite,
});

/** What an item's requests came to, the model's and the judge's, each priced at its own model. */
function requestsOf(
  asked: { requests: readonly RequestTokens[]; failed: readonly string[]; modelId: string }[],
): Requests {
  const usage: AnswerUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
  let dollars: number | null = 0;
  for (const { requests, modelId } of asked) {
    const priced = PRICE(modelId);
    for (const request of requests) {
      const each = usageOf(request);
      usage.inputTokens += each.inputTokens;
      usage.outputTokens += each.outputTokens;
      usage.cachedInputTokens += each.cachedInputTokens;
      usage.cacheWriteTokens += each.cacheWriteTokens;
      const cost = priced(each);
      dollars = dollars === null || cost === null ? null : dollars + cost;
    }
  }
  return {
    answered: asked.reduce((total, each) => total + each.requests.length, 0),
    failed: asked.flatMap((each) => each.failed),
    usage,
    dollars,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

async function armRecords(run: string, arm: Arm): Promise<ItemRecord[]> {
  const folder = join(run, arm);
  if (!existsSync(folder)) return [];
  const files = (await readdir(folder)).filter(
    (name) => name.endsWith(".json") && name !== "arm.json",
  );
  return Promise.all(files.map((name) => readJson<ItemRecord>(join(folder, name))));
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Waits until the other arm has finished the item before this one's turn: `main` goes first. */
async function waitForTurn(
  run: string,
  arm: Arm,
  index: number,
  keys: readonly string[],
): Promise<void> {
  const other: Arm = arm === "main" ? "branch" : "main";
  const before = arm === "main" ? index - 1 : index;
  if (before < 0) return;
  for (;;) {
    const stopped = join(run, other, "stopped");
    if (existsSync(stopped))
      throw new Error(`The ${other} arm stopped: ${await readFile(stopped, "utf8")}`);
    const info = join(run, other, "arm.json");
    if (existsSync(info)) {
      const theirs = await readJson<ArmInfo>(info);
      if (JSON.stringify(theirs.items) !== JSON.stringify(keys))
        throw new Error(`The ${other} arm runs other items: both arms must be started alike.`);
      if (existsSync(join(run, other, `turn-${before}`))) return;
    }
    await pause(500);
  }
}

interface Watches {
  tokens: ReturnType<typeof watchTokens>;
  judgeTokens: ReturnType<typeof watchTokens>;
  reasks: ReturnType<typeof watchReasks>;
  citing: ReturnType<typeof watchCiting>;
}

async function openReports(watches: Watches, log: Log): Promise<Library> {
  const config = readConfig(ROOT);
  const chat = DRY ? dryChatModel() : null;
  const { tokens, reasks, citing } = watches;
  const library = await openLibrary({
    name: "records-ask",
    chatModels: (inner) =>
      citing.chatModels(reasks.chatModels(tokens.chatModels(chat ? () => chat : inner))),
    embedder: DRY ? createFakeEmbedder() : createWorkerEmbedder(),
    ...(DRY
      ? { localModels: async () => [] }
      : {
          modelCache: join(config.cacheDir, "models"),
          reranker: createWorkerCrossEncoder(config.rerankOnCpu),
        }),
    documents: await reports(),
    examples: join(ROOT, "resources", "examples"),
    keep: config.keepData,
    embeddings: false,
    log,
  });
  const { core } = library;
  // Starting a run is the consent to send the requests and Passages to the model.
  core.on("consent.requested", (request) => {
    void core.respondToConsent(
      request.requestId,
      request.flow.id === "chat" || request.flow.id === "checks",
    );
  });
  await core.saveChatProvider({
    kind: "anthropic",
    modelId: GATE_MODEL,
    apiKey: DRY ? DRY_RUN_PLACEHOLDER : keyOf(),
  });
  return library;
}

function judgeModel(watch: ReturnType<typeof watchTokens>): LanguageModelV4 {
  return watch.wrap(
    DRY
      ? dryJudgeModel()
      : createAiSdkChatModel({
          kind: "anthropic",
          modelId: GATE_JUDGE,
          apiKey: keyOf(),
          baseUrl: null,
          endpoint: null,
          thinking: "off",
        }),
  );
}

async function runItem(
  library: Library,
  judge: LanguageModelV4,
  watches: Watches,
  arm: Arm,
  item: Item,
  attempt: number,
): Promise<ItemRecord> {
  const { core } = library;
  const { tokens, judgeTokens } = watches;
  tokens.take();
  tokens.takeFailures();
  judgeTokens.take();
  judgeTokens.takeFailures();
  const started = Date.now();
  const base = {
    arm,
    key: item.key,
    kind: item.kind,
    language: item.language,
    run: item.run,
    attempt,
  };
  let record: Omit<ItemRecord, "requests" | "seconds" | "void">;
  if (item.kind === "research") {
    const asked = CASES.find((each) => each.id === item.id);
    if (!asked) throw new Error(`No everyday request "${item.id}".`);
    const scoped = [...library.documents.values()].map(({ id, name, title }) => ({
      id,
      name,
      title,
    }));
    let answer: CaseResult | null = null;
    let error: string | null = null;
    try {
      answer = await runCase(library, scoped, judge, `anthropic/${GATE_MODEL}`, asked, {
        watch: watches.reasks,
        citing: watches.citing,
        hear: tokens.hear,
      });
    } catch (failure) {
      error = message(failure);
    }
    record = {
      ...base,
      name: item.id,
      pair: null,
      twin: null,
      sentences: answer?.support ?? [],
      answer,
      error,
    };
  } else {
    const pair = PAIRS.find((each) => each.pair === item.pair);
    if (!pair) throw new Error(`The plan has no pair ${item.pair}.`);
    const document = [...library.documents.values()].find((each) => each.name === pair.document);
    if (!document) throw new Error(`No Document “${pair.document}” in the Library.`);
    const sentence = sentenceOf(pair, item.twin);
    const cited = pair.cites.map((quote) => ({
      documentName: document.name,
      documentId: document.id,
      contentHash: document.contentHash,
      quote,
    }));
    let error: string | null = null;
    let support: ItemRecord["sentences"] = [];
    try {
      const heard = await tokens.hear(() =>
        core.checkClaim({ claim: sentence, context: sentence, cited, model: null }),
      );
      support = [
        {
          ...sentenceSupport({ sentence, cited }, heard.result),
          checks: heardChecks(heard.requests),
        },
      ];
    } catch (failure) {
      error = message(failure);
    }
    record = {
      ...base,
      name: `pair ${pair.pair}, ${item.twin}`,
      pair: pair.pair,
      twin: item.twin,
      sentences: support,
      answer: null,
      error,
    };
  }
  const requests = requestsOf([
    { requests: tokens.take(), failed: tokens.takeFailures(), modelId: GATE_MODEL },
    { requests: judgeTokens.take(), failed: judgeTokens.takeFailures(), modelId: GATE_JUDGE },
  ]);
  const seconds = (Date.now() - started) / 1000;
  return { ...record, requests, seconds, void: voidReasons({ ...record, requests }) };
}

function armOf(): Arm {
  const arm = ARMS.find((each) => each === process.env.INCARNAMIND_EVAL_RECORDS_ASK_ARM?.trim());
  if (!arm) throw new Error(`Set INCARNAMIND_EVAL_RECORDS_ASK_ARM to ${ARMS.join(" or ")}.`);
  return arm;
}

test.skipIf(MODE !== "records-ask")("the records ask's gate: one arm, item by item", async () => {
  refuseOtherModels();
  const fetched = DRY ? noProvider() : null;
  const run = runFolder();
  const arm = armOf();
  const before = spentBefore();
  const folder = join(run, arm);
  if (existsSync(folder) && (await readdir(folder)).length > 0)
    throw new Error(`${folder} holds an earlier run: start each run in a folder of its own.`);
  await mkdir(folder, { recursive: true });
  const log = createLog();
  const items =
    process.env.INCARNAMIND_EVAL_RECORDS_ASK_ITEMS?.trim() === "pilot" ? pilotItems() : runItems();
  const keys = items.map((item) => item.key);
  const info: ArmInfo = {
    arm,
    // A folder made from two commits, main's `src` under the branch's evaluation, names main's.
    commit: process.env.INCARNAMIND_EVAL_RECORDS_ASK_SOURCE?.trim() || commitOf(ROOT, [run]),
    source: await sourceOf(ROOT),
    model: `anthropic/${GATE_MODEL}`,
    judge: `anthropic/${GATE_JUDGE}`,
    dry: DRY,
    fetchCalls: 0,
    items: keys,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  await writeWhole(join(folder, "arm.json"), JSON.stringify(info, null, 2));
  const watches: Watches = {
    tokens: watchTokens(),
    judgeTokens: watchTokens(),
    reasks: watchReasks(),
    citing: watchCiting(),
  };
  try {
    const library = await openReports(watches, log);
    try {
      const judge = judgeModel(watches.judgeTokens);
      for (const [index, item] of items.entries()) {
        await waitForTurn(run, arm, index, keys);
        const theirs =
          arm === "branch"
            ? (await armRecords(run, "main")).filter((each) => each.key === item.key)
            : [];
        if (theirs.length >= 2 && theirs.every((each) => each.void.length > 0)) {
          log(`${arm} · ${item.key}: left out, void twice on main`);
        } else {
          for (let attempt = 1; attempt <= 2; attempt++) {
            await keepTheStop(run, before);
            log(`${arm} · ${item.key}, try ${attempt}`);
            const record = await runItem(library, judge, watches, arm, item, attempt);
            await writeFile(
              join(folder, recordFile(item.key, attempt)),
              JSON.stringify(record, null, 2),
            );
            log(
              record.void.length > 0
                ? `  void: ${record.void.join("; ")}`
                : `  ${record.sentences.map((each) => each.verdict).join(", ")}`,
            );
            if (record.void.length === 0) break;
          }
        }
        await writeFile(join(folder, `turn-${index}`), item.key);
      }
    } finally {
      await library.close();
    }
  } catch (error) {
    await writeFile(join(folder, "stopped"), message(error));
    throw error;
  }
  await writeWhole(
    join(folder, "arm.json"),
    JSON.stringify(
      { ...info, fetchCalls: fetched?.calls() ?? 0, endedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
});

async function allRecords(run: string): Promise<ItemRecord[]> {
  return (await Promise.all(ARMS.map((arm) => armRecords(run, arm)))).flat();
}

/** What the gate spent before this run, in US dollars: the pilot's, for the run. */
function spentBefore(): number {
  const raw = process.env.INCARNAMIND_EVAL_RECORDS_ASK_SPENT_BEFORE?.trim();
  if (!raw && DRY) return 0;
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value < 0)
    throw new Error(
      "Set INCARNAMIND_EVAL_RECORDS_ASK_SPENT_BEFORE to what the gate spent before this run, in US dollars: 0 for the pilot, the pilot's bars.md for the run.",
    );
  return value;
}

/**
 * Stops the arm before a try that could take the gate past the plan's stop: both arms' tries in
 * the run folder, the judge's spend and what was spent before are added up, as the arms take turns.
 */
async function keepTheStop(run: string, before: number, extra: readonly (number | null)[] = []) {
  const costs = [...(await allRecords(run)).map((record) => record.requests.dollars), ...extra];
  const kept = underTheStop(before, costs);
  if (!kept) throw new Error("A try's cost isn't known, so the plan's stop can't be kept.");
  if (!kept.within)
    throw new Error(
      `The plan's stop: US$${kept.spent.toFixed(4)} spent, and the next try may cost up to US$${kept.most.toFixed(4)}, past US$${STOP_DOLLARS.toFixed(2)}.`,
    );
}

/** Writes a file another process reads while this one runs: whole, or not at all. */
async function writeWhole(path: string, text: string): Promise<void> {
  await writeFile(`${path}.partial`, text);
  await rename(`${path}.partial`, path);
}

test.skipIf(MODE !== "records-ask-judge")(
  "the records ask's gate: the judge, told no arm",
  async () => {
    refuseOtherModels();
    const fetched = DRY ? noProvider() : null;
    const run = runFolder();
    const before = spentBefore();
    if (existsSync(join(run, "judged.json")))
      throw new Error(`The judge has read this run: ${join(run, "judged.json")} is kept.`);
    const { read } = scoreOf(await allRecords(run));
    const sentences = toJudge([...read.main, ...read.branch]);
    const watch = watchTokens();
    const model = judgeModel(watch);
    const judged: Judged["sentences"] = [];
    const batches: Requests[] = [];
    for (let at = 0; at < sentences.length; at += JUDGE_BATCH) {
      await keepTheStop(
        run,
        before,
        batches.map((each) => each.dollars),
      );
      const batch = sentences.slice(at, at + JUDGE_BATCH);
      const unstated = await judgeStated(model, batch);
      judged.push(...batch.map((each, index) => ({ ...each, unstated: unstated[index] ?? null })));
      batches.push(
        requestsOf([{ requests: watch.take(), failed: watch.takeFailures(), modelId: GATE_JUDGE }]),
      );
    }
    if (fetched && fetched.calls() > 0)
      throw new Error(`The dry run's judge called fetch ${fetched.calls()} times.`);
    const dollars = batches.reduce<number | null>(
      (total, each) => (total === null || each.dollars === null ? null : total + each.dollars),
      0,
    );
    await writeFile(
      join(run, "judged.json"),
      JSON.stringify(
        {
          model: `anthropic/${GATE_JUDGE}`,
          sentences: judged,
          failedTries: batches.flatMap((each) => each.failed),
          dollars,
        },
        null,
        2,
      ),
    );
    console.log(
      `The judge read ${judged.length} ✓ sentences in ${batches.reduce((total, each) => total + each.answered, 0)} requests.`,
    );
  },
);

/** Files a reader gets, written whole: none may be empty or hold a value that wasn't filled. */
function unfilled(name: string, text: string): string[] {
  if (text.trim() === "") return [`${name} is empty`];
  return /\bundefined\b|\bNaN\b|\[object Object\]/u.test(text)
    ? [`${name} holds an unfilled value`]
    : [];
}

test.skipIf(MODE !== "records-ask-bars")("the records ask's gate: the bars", async () => {
  const run = runFolder();
  const arms = await Promise.all(
    ARMS.flatMap((arm) => {
      const path = join(run, arm, "arm.json");
      return existsSync(path) ? [readJson<ArmInfo>(path)] : [];
    }),
  );
  const records = await allRecords(run);
  const judgedPath = join(run, "judged.json");
  const judged = existsSync(judgedPath)
    ? await readJson<Judged & { dollars: number | null }>(judgedPath)
    : null;
  const reading = readBars({ arms, records, judged, judgeDollars: judged?.dollars ?? null });
  const sheet = kindBSheet(scoreOf(records).read);
  const files = {
    "bars.md": reading.lines.join("\n"),
    "report.md": reportLines(records).join("\n"),
    "kind-b-sheet.md": sheet.sheet.join("\n"),
    "kind-b-key.json": JSON.stringify(sheet.key, null, 2),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(run, name), text);
  console.log(reading.lines.join("\n"));
  const problems = [
    ...emptyFields(records),
    ...Object.entries(files).flatMap(([name, text]) => unfilled(name, text)),
    ...(sheet.key.length === 0 && records.some((each) => each.kind === "research")
      ? ["kind-b-sheet.md lists no ✓ sentence"]
      : []),
  ];
  if (problems.length > 0)
    throw new Error(`Fields a reader needs are empty:\n${problems.join("\n")}`);
  if (reading.errors.length > 0)
    throw new Error(`The bars can't be read: ${reading.errors.join(" ")}`);
});
