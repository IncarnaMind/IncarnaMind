import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import type { ClaimCheckResult, Core } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { connectToMind } from "../../tests/helpers/mindClient";
import { readMind, writeMind } from "../../tests/helpers/minds";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { watchRequests } from "../repeats/requests";
import { matchedRecordCites, type RecordCiteRunReport, writeRecordCiteReport } from "./report";
import { type RecordCaseResult, scoreRecordCase } from "./score";
import { loadRecordCiteSet, type RecordSetCase } from "./set";

const root = fileURLToPath(new URL("../..", import.meta.url));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

/**
 * A case with a Note is checked as the User checks a Note: written as its paragraphs, every
 * sentence checked, and the claim's sentence read back with its record cites.
 */
async function checkInNote(
  core: Core,
  test: RecordSetCase & { note: string[] },
): Promise<ClaimCheckResult | null> {
  const mind = await core.createMind({ title: test.id });
  const client = await connectToMind(core, mind.id);
  const blocks = test.note.map((text, index) => ({
    type: "paragraph",
    attrs: { id: `paragraph-${index}` },
    content: [{ type: "text", text }],
  }));
  writeMind(client, blocks);
  await client.settled();
  const last = test.note.length - 1;
  await core.checkSentences({
    requestId: `record-cites-${test.id}`,
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "paragraph-0", offset: 0 },
    to: { blockId: `paragraph-${last}`, offset: test.note[last]?.length ?? 0 },
  });
  await client.settled();
  const check = claimSpans(readMind(client)).find((span) => span.check.text === test.claim)?.check;
  if (!check || check.state === "checking") return null;
  return check.state === "not-checked"
    ? {
        verdict: "not-checked",
        reason: check.reason ?? "failed",
        detail: check.detail,
        versions: check.versions,
        excluded: check.excluded,
        ...(check.recordCites && { recordCites: check.recordCites }),
      }
    : {
        verdict: check.state,
        evidence: null,
        says: check.says,
        unsupported: check.unsupported,
        calculation: check.calculation,
        citedCaseUnchecked: check.citedCaseUnchecked,
        citedCaseFound: check.citedCaseFound,
        versions: check.versions,
        excluded: check.excluded,
        ...(check.recordCites && { recordCites: check.recordCites }),
      };
}

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
  const wanted = new Set(cases.flatMap((test) => test.documents));
  const documents = set.documents.filter((document) => wanted.has(document.key));
  if (documents.length !== wanted.size) throw new Error("A case names an unknown record Document.");
  const watch = watchRequests(cases.map((test) => test.claim));
  const library = await openLibrary({
    name: "record-cites",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(),
    documents: documents.map((document) => ({
      key: document.key,
      path: join(root, document.path),
    })),
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
    const results: RecordCaseResult[] = [];
    for (const test of cases) {
      const documentIds = test.documents.map((key) => {
        const document = library.documents.get(key);
        if (!document) throw new Error(`${test.id} names an unavailable record Document.`);
        return document.id;
      });
      await core.updateSettings({ user: { language: test.language } });
      let result: ClaimCheckResult | null = null;
      let failure: string | null = null;
      try {
        result = test.note
          ? await checkInNote(core, { ...test, note: test.note })
          : await core.checkClaim({
              claim: test.claim,
              scope: { folderIds: [], tagIds: [], documentIds },
            });
        if (!result) failure = "the Note's sentence was not checked";
        if (result?.verdict === "not-checked") {
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
        pipeline:
          "the app's public core: checkClaim, or checkSentences on a Note for a case with one, with record-cite resolution and judgement",
      },
      set: {
        documents: documents.length,
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
      `${matchedRecordCites(report)} of ${report.set.cites} cite results match; ${report.misses.length} misses; report ${dir}`,
    );
  } finally {
    await library.close();
  }
});
