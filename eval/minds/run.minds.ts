/**
 * `npm run eval:minds` (README.md): asks the assistant, on a real chat model,
 * for changes that reach several Minds, in a workspace of test Minds, and
 * holds every run to the checks in ./checks. It writes a report and fails when
 * a request is under the bar.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { OUT_OF_CREDIT, spendOf } from "../../scripts/nightlyRealModel";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { ask, judgeOf } from "../everyday/asking";
import { commitOf } from "../lib/commit";
import { type ChatSettings, chatModelSpecOf, chatProviderOf, readConfig } from "../lib/config";
import { openLibrary } from "../lib/library";
import { createLog, type Log } from "../lib/log";
import { CASES, DOCUMENTS, type MindsCase, WORKSPACES } from "./cases";
import { examine } from "./examine";
import { unbackedIn } from "./judge";
import { createRecorder, type Tokens } from "./record";
import { passedRun, type RunResult, report, rowsOf } from "./report";
import { readWorkspace, seedWorkspace } from "./state";

const ROOT = resolve(__dirname, "../..");

const TRANSIENT =
  /rate.?limit|overload|unavailable|too many requests|econnreset|etimedout|fetch failed|socket hang up|\b(?:429|500|502|503|504|529)\b/i;
const MAX_RETRIES = 2;

const providerOf = (kind: ChatSettings["kind"]) => (kind === "kimi" ? "kimi" : "anthropic");

function dollars(tokens: Tokens, modelId: string, kind: ChatSettings["kind"]): number {
  return spendOf(
    [
      {
        model: modelId,
        inputTokens: tokens.inputTokens,
        cachedInputTokens: tokens.cachedInputTokens,
        cacheWriteTokens: tokens.cacheWriteTokens,
        outputTokens: tokens.outputTokens,
      },
    ],
    providerOf(kind),
  ).dollars;
}

async function runOne(
  chat: ChatSettings,
  judging: ChatSettings,
  each: MindsCase,
  run: number,
  model: string,
  keepData: boolean,
): Promise<RunResult> {
  const started = Date.now();
  const recorder = createRecorder();
  const judge = recorder.counted(
    createAiSdkChatModel({ ...chatModelSpecOf(judging), thinking: "off" }),
  );
  const folder = each.documents ? await mkdtemp(join(tmpdir(), "incarnamind-eval-minds-")) : null;
  const removeFolder = () =>
    folder ? rm(folder, { recursive: true, force: true }) : Promise.resolve();
  const library = await (async () =>
    openLibrary({
      name: "minds",
      embedder: createFakeEmbedder(),
      documents: folder ? await writeDocuments(folder, each.language) : [],
      keep: keepData,
      embeddings: false,
      chatModels: recorder.chatModels,
      log: () => undefined,
    }))().catch(async (error: unknown) => {
    await removeFolder();
    throw error;
  });
  const empty = {
    id: each.id,
    language: each.language,
    request: each.request,
    model,
    run,
    reply: "",
    answeredSeconds: 0,
    retries: 0,
    calls: [],
    card: [],
  };
  try {
    const { core } = library;
    // Setting the variables is the consent to send the requests to the model.
    core.on("consent.requested", (request) => {
      void core.respondToConsent(
        request.requestId,
        request.flow.id === "chat" || request.flow.id === "checks",
      );
    });
    await core.saveChatProvider(chatProviderOf(chat));
    await seedWorkspace(core, WORKSPACES[each.language]);
    const before = await readWorkspace(core);
    const open = each.open === null ? null : before.find((mind) => mind.title === each.open);
    if (each.open !== null && !open) throw new Error(`No Mind “${each.open}” to open.`);

    const asked = Date.now();
    const answer = await ask(core, {
      text: each.request,
      mindId: open?.id ?? null,
      conversationId: null,
      focus: null,
    });
    const answeredSeconds = (Date.now() - asked) / 1000;
    const { failures, calls, card } = await examine(core, each, before, answer, (reply, record) =>
      unbackedIn(judge, reply, record),
    );
    return {
      ...empty,
      failures,
      error: answer.status === "failed" ? `${answer.errorKind}: ${answer.errorMessage}` : null,
      reply: answer.text,
      answeredSeconds,
      seconds: (Date.now() - started) / 1000,
      chat: recorder.chat,
      judging: recorder.judging,
      calls,
      card,
      transcript: recorder.transcript,
    };
  } catch (error) {
    return {
      ...empty,
      failures: [],
      error: error instanceof Error ? error.message : String(error),
      seconds: (Date.now() - started) / 1000,
      chat: recorder.chat,
      judging: recorder.judging,
      transcript: recorder.transcript,
    };
  } finally {
    await library.close();
    await removeFolder();
  }
}

async function writeDocuments(folder: string, language: MindsCase["language"]) {
  return Promise.all(
    DOCUMENTS[language].map(async ({ file, text }) => {
      const path = join(folder, file);
      await writeFile(path, text);
      return { key: file, path };
    }),
  );
}

function selected(only: string | undefined): readonly MindsCase[] {
  if (!only) return CASES;
  if (only === "en" || only === "zh-CN") return CASES.filter((each) => each.language === only);
  const ids = only.split(",").map((id) => id.trim());
  return CASES.filter((each) => ids.includes(each.id));
}

async function runAll(
  chat: ChatSettings,
  judging: ChatSettings,
  cases: readonly MindsCase[],
  {
    runs,
    parallel,
    budget,
    keepData,
  }: { runs: number; parallel: number; budget: number; keepData: boolean },
  log: Log,
) {
  const model = `${chat.kind}/${chat.modelId}`;
  const queue = cases.flatMap((each) =>
    Array.from({ length: runs }, (_, run) => ({ each, run: run + 1 })),
  );
  const results: RunResult[] = [];
  let spent = 0;
  let stopped: string | null = null;
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next || stopped) return;
      const cost = (each: RunResult) =>
        dollars(each.chat, chat.modelId, chat.kind) +
        dollars(each.judging, judging.modelId, judging.kind);
      let result = await runOne(chat, judging, next.each, next.run, model, keepData);
      spent += cost(result);
      // A busy provider says nothing of the assistant: the run is asked again, up to twice.
      while (
        result.error &&
        TRANSIENT.test(result.error) &&
        !OUT_OF_CREDIT.test(result.error) &&
        result.retries < MAX_RETRIES
      ) {
        log(
          `${model} · ${next.each.id} #${next.run}: asked again after "${result.error.slice(0, 120)}"`,
        );
        const again = await runOne(chat, judging, next.each, next.run, model, keepData);
        again.retries = result.retries + 1;
        spent += cost(again);
        result = again;
      }
      results.push(result);
      log(
        `${model} · ${next.each.id} #${next.run}: ${
          result.error
            ? `didn't run: ${result.error.slice(0, 160)}`
            : result.failures.length === 0
              ? "passed"
              : `failed (${[...new Set(result.failures.map((failure) => failure.kind))].join(", ")})`
        } · ${result.answeredSeconds.toFixed(0)} s · $${spent.toFixed(2)}`,
      );
      if (result.error && OUT_OF_CREDIT.test(result.error)) {
        stopped = "Stopped: the key is out of credit.";
      } else if (spent >= budget) {
        stopped = `Stopped at $${spent.toFixed(2)}, past the budget of $${budget}.`;
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  const order = new Map(cases.map((each, index) => [each.id, index]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.run - b.run);
  return { results, spent, stopped };
}

test("requests that change several Minds", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  if (!config.chat) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (README.md).");
    return;
  }
  const number = (name: string, fallback: number) =>
    Number(process.env[`INCARNAMIND_EVAL_MINDS_${name}`]) || fallback;
  const cases = selected(process.env.INCARNAMIND_EVAL_MINDS?.trim());
  const judging = judgeOf(config, config.chat);
  const { results, spent, stopped } = await runAll(
    config.chat,
    judging,
    cases,
    {
      runs: number("RUNS", 10),
      parallel: number("PARALLEL", 1),
      budget: number("BUDGET", 3),
      keepData: config.keepData,
    },
    log,
  );
  const rows = rowsOf(results);
  const folder = join(config.resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-minds`);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "report.md"),
    report(results, rows, {
      commit: commitOf(ROOT),
      judge: `${judging.kind}/${judging.modelId}`,
      spentDollars: spent,
      stopped,
    }),
  );
  await writeFile(join(folder, "report.json"), JSON.stringify({ rows, results }, null, 2));
  const under = rows.filter((row) => row.under);
  log(
    `${rows.length - under.length} of ${rows.length} requests at or above the bar, ${results.filter(passedRun).length} of ${results.length} runs passed, $${spent.toFixed(2)} spent; report in ${folder}`,
  );
  if (under.length > 0) {
    throw new Error(`Under the bar: ${under.map((row) => `${row.id} (${row.model})`).join(", ")}`);
  }
});
