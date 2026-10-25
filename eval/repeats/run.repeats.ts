/**
 * `npm run eval:repeats` (README.md): Check this Mind on the sets in ./cases,
 * again and again on the same unchanged Minds, with a real chat model and the
 * app's real search, and a report of what came back.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, vi } from "vitest";
import type { Core } from "../../src/core";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder, prepareGpuFile } from "../lib/rerank";
import { documentsOf, type RepeatSet, SETS, writeDocuments } from "./cases";
import { repeatChecks } from "./repeat";
import { type RepeatRow, report, summarise } from "./score";

const ROOT = resolve(__dirname, "../..");
const FINISHED = new Set(["ready", "failed", "no-text"]);

const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

test("repeated checks of an unchanged Mind", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (README.md).");
    return;
  }
  const repeats = Number(process.env.INCARNAMIND_EVAL_REPEATS ?? "10") || 10;
  const only = process.env.INCARNAMIND_EVAL_REPEATS_SETS?.trim();
  const budget = Number(process.env.INCARNAMIND_EVAL_REPEATS_BUDGET ?? "5") || 5;
  const sets = SETS.filter((each) => !only || only.split(",").includes(each.id));
  const model = `${chat.kind}/${chat.modelId}`;
  await prepareGpuFile(config, log);
  const reranker = createWorkerCrossEncoder(config.rerankOnCpu);
  const rows: RepeatRow[] = [];
  let spentBefore = 0;
  let stopped = false;
  const libraries = new Map<string, RepeatSet[]>();
  for (const set of sets) {
    const key = [set.language, ...documentsOf(set).map((each) => each.file)].join("\n");
    libraries.set(key, [...(libraries.get(key) ?? []), set]);
  }
  for (const ofLibrary of libraries.values()) {
    const [first] = ofLibrary;
    if (!first || stopped) continue;
    const { language } = first;
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-repeats-"));
    // The Library of a first run: the example's Documents beside the User's own, so the search
    // weighs the agreement against others as it does for a newcomer.
    const library = await openLibrary({
      name: `repeats-${language}`,
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker,
      documents: await writeDocuments(folder, first),
      examples: join(ROOT, "resources", "examples"),
      keep: config.keepData,
      embeddings: false,
      log,
    });
    try {
      const { core } = library;
      // Setting the variables is the consent to send the sentences and Passages to the model.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(
          request.requestId,
          request.flow.id === "chat" || request.flow.id === "checks",
        );
      });
      await core.updateSettings({ user: { language } });
      await core.createExamples();
      const added = library.documents.size;
      await vi.waitFor(
        async () => {
          const documents = await core.listDocuments();
          if (documents.length <= added || documents.some((each) => !FINISHED.has(each.status))) {
            throw new Error("The example's Documents are still being read.");
          }
        },
        { timeout: 10 * 60_000, interval: 1000 },
      );
      const provider = await core.saveChatProvider(chatProviderOf(chat));
      const choice = { providerId: provider.id, modelId: chat.modelId };
      for (const set of ofLibrary) {
        if (stopped) break;
        log(`${model} · ${set.id}: ${set.sentences.length} sentences, ${repeats} checks`);
        const results = await repeatChecks(core, {
          mind: set.mind,
          sentences: set.sentences.map((each) => each.text),
          repeats,
          model: choice,
          async onRepeat(done) {
            const spent = spentBefore + (await spentOf(core));
            log(
              `  check ${done[0]?.repeat}: ${done.map((each) => each.outcome).join(" ")} · $${spent.toFixed(3)}`,
            );
            stopped = spent >= budget;
            if (stopped) log(`Stopped at $${spent.toFixed(2)}, past the budget of $${budget}.`);
            return !stopped;
          },
        });
        for (const result of results) {
          const sentence = set.sentences.find((each) => each.text === result.sentence);
          if (!sentence) continue;
          rows.push({
            ...result,
            set: set.id,
            model,
            key: sentence.key,
            kind: sentence.kind,
            expected: sentence.expected,
            ...(sentence.knownMiss !== undefined && { knownMiss: sentence.knownMiss }),
          });
        }
      }
      spentBefore += await spentOf(core);
    } finally {
      await library.close();
      await rm(folder, { recursive: true, force: true });
    }
  }
  const out = join(config.resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-repeats`);
  await mkdir(out, { recursive: true });
  const summaries = summarise(rows);
  await writeFile(
    join(out, "report.md"),
    report(summaries, { commit: commitOf(ROOT), spent: spentBefore, repeats }),
  );
  await writeFile(join(out, "report.json"), JSON.stringify({ model, rows }, null, 2));
  log(`$${spentBefore.toFixed(2)} spent; report in ${out}`);
});
