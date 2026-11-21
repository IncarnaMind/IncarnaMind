/**
 * The dropped-condition set's run (#3512): sentences that state what a Document states but leave
 * out a condition, limit, exception or qualifier it attaches, each beside faithful twins and
 * controls that say less without claiming more, checked by the app's claim check against the
 * checks evaluation's Folder and two small agreements. A sentence that drops something should read
 * Needs a look; a twin or a control should not. Needs a chat model (INCARNAMIND_EVAL_CHAT_*,
 * eval/README.md); writes `conditions.json` to eval/results/<start time>-conditions/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { commitOf } from "../lib/commit";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { watchRequests } from "../repeats/requests";
import { type JudgeRequest, judgeRecord } from "./lib/judge";
import { readChecksSet } from "./lib/set";

const root = fileURLToPath(new URL("../..", import.meta.url));
const CONDITIONS = join(root, "eval", "checks", "conditions");

interface ConditionItem {
  id: string;
  language: "en" | "zh";
  document: string;
  sentence: string;
  kind: "drops" | "faithful" | "says-less";
  pair: string;
  dropped: string | null;
  quote: string;
}

interface Result {
  id: string;
  language: string;
  kind: string;
  pair: string;
  sentence: string;
  verdict: string;
  /** For an unsupported verdict, the word the check gave it: overstated, partly supported, not found, own view. */
  word: string | null;
  says: string | null;
  quote: string | null;
  seconds: number;
  judge: JudgeRequest[];
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0);
};

test("dropped conditions: sentences that leave out what a Document attaches, and their twins", async () => {
  const started = new Date();
  const log = createLog(started.getTime());
  const config = readConfig(root);
  if (!config.chat) {
    log("Conditions: skipped, no chat model was given (eval/README.md).");
    return;
  }
  if (config.questionIds) {
    log("Conditions: skipped, INCARNAMIND_EVAL_QUESTIONS asks for a short run.");
    return;
  }
  const { items } = JSON.parse(await readFile(join(CONDITIONS, "set.json"), "utf8")) as {
    items: ConditionItem[];
  };
  const set = await readChecksSet(root);
  const agreements = [
    "Office lease - 14 Calder Street.docx",
    "Supply agreement - Harlow Freight.docx",
  ];
  const files = [
    ...set.folder
      .filter((document) => !document.address)
      .map((document) => ({
        key: document.name,
        path: join(root, document.path),
      })),
    ...agreements.map((name) => ({ key: name, path: join(CONDITIONS, "documents", name) })),
  ];
  const webPages = await Promise.all(
    set.folder
      .flatMap(({ name, path, address }) => (address ? [{ key: name, path, address }] : []))
      .map(async ({ key, path, address }) => ({
        key,
        address,
        html: await readFile(join(root, path), "utf8"),
      })),
  );
  const watch = watchRequests([]);
  const library = await openLibrary({
    name: "conditions",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(),
    chatModels: watch.chatModels,
    documents: files,
    webPages,
    embeddings: false,
    keep: config.keepData,
    log,
  });
  try {
    const { core, documents } = library;
    const folder = await core.createLibraryGroup({
      name: "Conditions evaluation",
      description: "The Documents the dropped-condition sentences are checked against.",
    });
    await core.moveToFolder({
      documentIds: [...documents.values()].map((document) => document.id),
      folderId: folder.id,
    });
    const { chat } = config;
    core.on("consent.requested", (request) => {
      core
        .respondToConsent(request.requestId, request.flow.id === "checks")
        .catch((error: unknown) => console.error(error));
    });
    await core.saveChatProvider({
      kind: chat.kind,
      modelId: chat.modelId,
      ...(chat.apiKey !== null && { apiKey: chat.apiKey }),
      ...(chat.baseUrl !== null && { baseUrl: chat.baseUrl }),
    });
    const cap = Number(process.env.INCARNAMIND_EVAL_SPEND_CAP);
    if (cap > 0)
      await core.updateSettings({ user: { monthlyCap: { amount: cap, currency: "USD" } } });
    const scope = { folderIds: [folder.id], tagIds: [], documentIds: [] };

    const results: Result[] = [];
    for (const item of items) {
      const began = performance.now();
      const judged = await core.checkClaim({ claim: item.sentence, scope });
      const seconds = (performance.now() - began) / 1000;
      const unsupported = judged.verdict === "unsupported" ? judged.unsupported : null;
      results.push({
        id: item.id,
        language: item.language,
        kind: item.kind,
        pair: item.pair,
        sentence: item.sentence,
        verdict: judged.verdict,
        word: unsupported?.word ?? null,
        says:
          judged.verdict === "not-checked" ? null : (judged.says ?? unsupported?.reason ?? null),
        quote: judged.verdict === "not-checked" ? null : (judged.evidence?.quote ?? null),
        seconds,
        judge: judgeRecord(watch.take().get(item.sentence) ?? []),
      });
    }

    const flagged = (result: Result) =>
      result.verdict === "unsupported" || result.verdict === "contradicted";
    const drops = results.filter((result) => result.kind === "drops");
    const others = results.filter((result) => result.kind !== "drops");
    const requests = results.reduce((total, result) => total + result.judge.length, 0);
    const summary = {
      dropsFlagged: drops.filter(flagged).length,
      drops: drops.length,
      dropsOverstated: drops.filter((result) => result.word === "overstated").length,
      othersFlagged: others.filter(flagged).length,
      others: others.length,
      notChecked: results.filter((result) => result.verdict === "not-checked").length,
      requests,
      medianSeconds: median(results.map((result) => result.seconds)),
    };
    const dir = join(
      config.resultsDir,
      `${started.toISOString().replace(/[:.]/g, "-")}-conditions`,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "conditions.json"),
      `${JSON.stringify(
        {
          run: {
            startedAt: started.toISOString(),
            seconds: (Date.now() - started.getTime()) / 1000,
            commit: commitOf(root),
            model: `${chat.kind}/${chat.modelId}`,
          },
          summary,
          spent: (await core.getCostSummary()).spent,
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      [
        `Conditions: ${summary.dropsFlagged} of ${summary.drops} dropped conditions flagged (${summary.dropsOverstated} Overstated), ${summary.othersFlagged} of ${summary.others} twins and controls flagged, ${summary.notChecked} not checked.`,
        `${summary.requests} requests, median ${summary.medianSeconds.toFixed(1)} s a sentence. Written to ${dir}.`,
      ].join("\n"),
    );
    log(`Spent, at the app's own count: ${JSON.stringify((await core.getCostSummary()).spent)}`);
  } finally {
    await library.close();
  }
});
