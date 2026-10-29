/**
 * `npm run eval:claims` (README.md): the request that names a Mind's claims, asked again and
 * again on new Minds of the same sentences, so each request is independent of the others, with
 * a real chat model, and a report of how often it leaves out each kind of claim (#1682).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { Core } from "../../src/core";
import { connectToMind } from "../../tests/helpers/mindClient";
import { note, writeMind } from "../../tests/helpers/minds";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { claimKindOf, documentsOf, KIND_SETS, type KindSet, SETS, writeDocuments } from "./cases";
import {
  type CallCost,
  type ClaimRow,
  claimsReport,
  costOfCall,
  decisionOf,
  decisionsIn,
  isWrong,
  summariseClaims,
} from "./claimsScore";
import { watchRequests } from "./requests";

const ROOT = resolve(__dirname, "../..");
const DEFAULT_SETS = "en-conflicts,zh-conflicts,en-kinds,zh-kinds";

const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

const REPEAT_SETS: readonly KindSet[] = SETS.map((set) => ({
  id: set.id,
  language: set.language,
  mind: set.mind,
  sentences: set.sentences.map((sentence) => ({
    key: sentence.key,
    claim: claimKindOf(set, sentence),
    text: sentence.text,
  })),
}));

/** Every sentence of a language's sets in one long Mind, as a long Note gives the request many at once. */
const longSet = (language: KindSet["language"], id: string, mind: string): KindSet => {
  const sentences = [...KIND_SETS, ...REPEAT_SETS]
    .filter((set) => set.language === language)
    .flatMap((set) =>
      set.sentences.map((sentence) => ({ ...sentence, key: `${set.id}:${sentence.key}` })),
    );
  return {
    id,
    language,
    mind,
    sentences: sentences.filter(
      (sentence, index) => sentences.findIndex((each) => each.text === sentence.text) === index,
    ),
  };
};

/** Every set the request can be asked on: the claim kinds Minds, the repeats sets with their sentences' kinds, and a long Mind of each language. */
const CLAIM_SETS: readonly KindSet[] = [
  ...KIND_SETS,
  ...REPEAT_SETS,
  longSet("en", "en-long", "Everything about the agreements"),
  longSet("zh-CN", "zh-long", "合同的全部要点"),
];

test("the claims request, asked again and again", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (README.md).");
    return;
  }
  const calls = Number(process.env.INCARNAMIND_EVAL_REPEATS ?? "20") || 20;
  const only = (process.env.INCARNAMIND_EVAL_REPEATS_SETS?.trim() || DEFAULT_SETS).split(",");
  const budget = Number(process.env.INCARNAMIND_EVAL_REPEATS_BUDGET ?? "2") || 2;
  const sets = CLAIM_SETS.filter((each) => only.includes(each.id));
  const model = `${chat.kind}/${chat.modelId}`;
  const rows: ClaimRow[] = [];
  const costs = new Map<string, CallCost[]>();
  const replies: { set: string; call: number; replies: string[] }[] = [];
  const spent = new Map<string, number>();
  const total = () => [...spent.values()].reduce((sum, each) => sum + each, 0);

  // Each set in a Library of its own, all at once: the requests of one never reach another's watch.
  await Promise.all(
    sets.map(async (set) => {
      const folder = await mkdtemp(join(tmpdir(), "incarnamind-claims-"));
      const watch = watchRequests([]);
      const library = await openLibrary({
        name: `claims-${set.id}`,
        embedder: createWorkerEmbedder(),
        modelCache: join(config.cacheDir, "models"),
        documents: await writeDocuments(folder, set),
        keep: config.keepData,
        embeddings: false,
        chatModels: watch.chatModels,
        log,
      });
      try {
        const { core } = library;
        // Setting the variables is the consent to send the sentences to the model.
        core.on("consent.requested", (request) => {
          void core.respondToConsent(
            request.requestId,
            request.flow.id === "chat" || request.flow.id === "checks",
          );
        });
        await core.updateSettings({ user: { language: set.language } });
        const provider = await core.saveChatProvider(chatProviderOf(chat));
        const choice = { providerId: provider.id, modelId: chat.modelId };
        log(
          `${model} · ${set.id}: ${set.sentences.length} sentences, ${documentsOf(set).length} Documents, ${calls} requests`,
        );
        for (let call = 1; call <= calls; call++) {
          if (total() >= budget) {
            log(`Stopped at $${total().toFixed(2)}, past the budget of $${budget}.`);
            break;
          }
          // A new Mind each time: the app never sends a sentence it has sorted again (#973).
          const { id: mindId } = await core.createMind({ title: set.mind, folderId: null });
          const client = await connectToMind(core, mindId);
          writeMind(
            client,
            set.sentences.map((sentence) => note(sentence.text)),
          );
          await client.settled();
          const result = await core.findMindClaims({
            requestId: `${mindId}-claims`,
            mindId,
            mode: "changed",
            model: choice,
          });
          const requests = watch.takeClaims();
          // A call that couldn't name the claims says nothing of any sentence: it counts as unreadable.
          const ran = result.kind === "found" || result.kind === "nothing";
          if (!ran) log(`  ${set.id} request ${call}: ${result.kind}`);
          const found = decisionsIn(ran ? requests : []);
          replies.push({ set: set.id, call, replies: requests.map((each) => each.reply) });
          costs.set(`${set.id}\n${model}`, [
            ...(costs.get(`${set.id}\n${model}`) ?? []),
            costOfCall(requests),
          ]);
          for (const sentence of set.sentences) {
            rows.push({
              set: set.id,
              model,
              call,
              key: sentence.key,
              claim: sentence.claim,
              text: sentence.text,
              decision: ran ? decisionOf(found, sentence.text) : "unread",
            });
          }
          spent.set(set.id, await spentOf(core));
          const wrong = rows.filter(
            (row) => row.set === set.id && row.call === call && isWrong(row),
          );
          log(
            `  ${set.id} request ${call}: ${found.decided === null ? "unreadable" : `${wrong.length} wrong${wrong.length > 0 ? ` (${wrong.map((row) => row.key).join(", ")})` : ""}`} · $${total().toFixed(3)}`,
          );
        }
      } finally {
        await library.close();
        await rm(folder, { recursive: true, force: true });
      }
    }),
  );
  const out = join(config.resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-claims`);
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "report.md"),
    claimsReport(summariseClaims(rows, costs), {
      commit: commitOf(ROOT),
      spent: total(),
      calls,
    }),
  );
  await writeFile(join(out, "report.json"), JSON.stringify({ model, rows, replies }, null, 2));
  log(`$${total().toFixed(2)} spent; report in ${out}`);
});
