import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import type { ClaimCheckResult, Core } from "../../src/core";
import { waitForProcessing } from "../../tests/helpers/documents";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { watchRequests } from "../repeats/requests";
import { type RecordCiteRunReport, writeRecordCiteReport } from "./report";
import { type RecordCaseResult, scoreRecordCase } from "./score";
import { loadRecordCiteSet } from "./set";

const root = fileURLToPath(new URL("../..", import.meta.url));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

test("public record-cite evaluation", async () => {
  const started = new Date();
  const log = createLog(started.getTime());
  const config = readConfig(root);
  const chat = config.chat;
  if (!chat) {
    log("Record cites: skipped, no chat model. Set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY.");
    return;
  }
  const set = await loadRecordCiteSet(root);
  const only = process.env.INCARNAMIND_EVAL_RECORD_CITES_CASES?.split(",").map((id) => id.trim());
  const cases = set.cases.filter((test) => !only || only.includes(test.id));
  const regency = set.documents.find((document) => document.key === "regency-ecf-41");
  const robinson = set.documents.find((document) => document.key === "robinson-ecf-41");
  if (!regency || !robinson) throw new Error("The public record Documents are missing.");
  const watch = watchRequests(cases.map((test) => test.claim));
  const library = await openLibrary({
    name: "record-cites",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(),
    documents: [{ key: regency.key, path: join(root, regency.path) }],
    embeddings: false,
    keep: config.keepData,
    chatModels: watch.chatModels,
    log,
  });
  try {
    const { core } = library;
    core.on("consent.requested", (request) => {
      void core.respondToConsent(request.requestId, request.flow.id === "checks");
    });
    await core.saveChatProvider(chatProviderOf(chat));
    const ids = new Map([...library.documents].map(([key, document]) => [document.id, key]));
    let addedRobinson = false;
    const results: RecordCaseResult[] = [];
    for (const test of cases) {
      if (!addedRobinson && test.cites.some((cite) => cite.outcome === "choose")) {
        const added = await core.addDocuments([join(root, robinson.path)]);
        const processed = await waitForProcessing(
          core,
          added.documents.map((document) => document.id),
        );
        for (const document of processed) ids.set(document.id, robinson.key);
        addedRobinson = true;
        log("Added the second ECF No. 41 for the ambiguity case");
      }
      await core.updateSettings({ user: { language: test.language } });
      let result: ClaimCheckResult | null = null;
      let failure: string | null = null;
      try {
        result = await core.checkClaim({ claim: test.claim });
        if (result.verdict === "not-checked") {
          failure = [result.reason, result.detail].filter(Boolean).join(": ");
        }
      } catch (error) {
        failure = messageOf(error);
      }
      const requests = watch.take().get(test.claim) ?? [];
      const scored = scoreRecordCase(test, result, failure, requests, (id) =>
        id ? ids.get(id) : undefined,
      );
      results.push(scored);
      log(
        `${test.id}: ${(result?.recordCites ?? []).map((cite) => cite.outcome).join(", ") || failure || "no cites"}; ${scored.misses.length} misses`,
      );
    }
    const requests = results.flatMap((entry) => entry.requests);
    const report: RecordCiteRunReport = {
      run: {
        startedAt: started.toISOString(),
        seconds: (Date.now() - started.getTime()) / 1000,
        commit: commitOf(root),
        model: `${chat.kind}/${chat.modelId}`,
        pipeline: "the app's public core checkClaim, with record-cite resolution and judgement",
      },
      set: {
        documents: addedRobinson ? 2 : 1,
        cases: results.length,
        cites: results.reduce((total, entry) => total + entry.test.cites.length, 0),
      },
      usage: {
        requests: requests.length,
        inputTokens: requests.reduce((total, request) => total + request.inputTokens, 0),
        outputTokens: requests.reduce((total, request) => total + request.outputTokens, 0),
        requestSeconds: requests.reduce((total, request) => total + request.ms, 0) / 1000,
        spentUsd: await spentOf(core),
      },
      results,
      misses: results.flatMap((entry) => entry.misses),
    };
    const dir = await writeRecordCiteReport(report, config.resultsDir);
    log(
      `${report.set.cites - report.misses.length} of ${report.set.cites} cite results match; ${report.misses.length} misses; report ${dir}`,
    );
  } finally {
    await library.close();
  }
});
