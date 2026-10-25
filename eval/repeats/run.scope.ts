/**
 * `npm run eval:scope` (README.md): Check this Mind on a Mind that summarises
 * one Document, in Libraries of other sizes and with the Mind filed into the
 * Document's Folder or in none, with a real chat model and the app's real
 * search, and a report of what came back and what the model was handed.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { Core } from "../../src/core";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { type Library, openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder, prepareGpuFile } from "../lib/rerank";
import { watchPassages } from "./passagesHanded";
import { repeatChecks } from "./repeat";
import { SCOPE_CASES, SCOPE_SETS, type ScopeSet, writeScopeDocuments } from "./scopeCases";
import { report, type ScopeRow, summarise } from "./scopeScore";

const ROOT = resolve(__dirname, "../..");

const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

async function fileAgreement(library: Library, set: ScopeSet): Promise<string> {
  const agreement = library.documents.get(set.agreement.file);
  if (!agreement) throw new Error(`${set.agreement.file} was not added.`);
  const { core } = library;
  const folder = await core.createLibraryGroup({ name: set.folder, description: "" });
  await core.moveToFolder({ documentIds: [agreement.id], folderId: folder.id });
  return folder.id;
}

test("the scope of a check from a Mind", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (README.md).");
    return;
  }
  const repeats = Number(process.env.INCARNAMIND_EVAL_REPEATS ?? "10") || 10;
  const only = process.env.INCARNAMIND_EVAL_SCOPE_CASES?.trim();
  const budget = Number(process.env.INCARNAMIND_EVAL_SCOPE_BUDGET ?? "1") || 1;
  const cases = SCOPE_CASES.filter((each) => !only || only.split(",").includes(each.id));
  const model = `${chat.kind}/${chat.modelId}`;
  await prepareGpuFile(config, log);
  const reranker = createWorkerCrossEncoder(config.rerankOnCpu);
  const out = join(config.resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-scope`);
  await mkdir(out, { recursive: true });
  const rows: ScopeRow[] = [];
  let spentBefore = 0;
  let stopped = false;
  try {
    for (const scopeCase of cases) {
      if (stopped) break;
      const set = SCOPE_SETS[scopeCase.language];
      const watch = watchPassages(set.sentences.map((each) => each.text));
      const folder = await mkdtemp(join(tmpdir(), "incarnamind-scope-"));
      const library = await openLibrary({
        name: `scope-${scopeCase.id}`,
        embedder: createWorkerEmbedder(),
        modelCache: join(config.cacheDir, "models"),
        reranker,
        documents: await writeScopeDocuments(folder, scopeCase),
        keep: config.keepData,
        embeddings: false,
        chatModels: watch.chatModels,
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
        await core.updateSettings({ user: { language: scopeCase.language } });
        await writeFile(
          join(out, `passages-${scopeCase.id}.json`),
          JSON.stringify(library.passages(), null, 1),
        );
        const provider = await core.saveChatProvider(chatProviderOf(chat));
        const choice = { providerId: provider.id, modelId: chat.modelId };
        const folderId = scopeCase.placement === "filed" ? await fileAgreement(library, set) : null;
        const agreement = library.documents.get(set.agreement.file);
        const scope =
          scopeCase.placement === "scoped" && agreement
            ? { folderIds: [], tagIds: [], documentIds: [agreement.id] }
            : undefined;
        log(`${model} · ${scopeCase.id}: ${set.sentences.length} sentences, ${repeats} checks`);
        await repeatChecks(core, {
          mind: set.mind,
          folderId,
          ...(scope && { scope }),
          sentences: set.sentences.map((each) => each.text),
          repeats,
          model: choice,
          async onRepeat(done) {
            const handed = watch.take();
            for (const result of done) {
              const sentence = set.sentences.find((each) => each.text === result.sentence);
              if (!sentence) continue;
              rows.push({
                ...result,
                caseId: scopeCase.id,
                language: scopeCase.language,
                placement: scopeCase.placement,
                others: scopeCase.others,
                model,
                key: sentence.key,
                expected: sentence.expected,
                clause: sentence.clause,
                handed: handed.get(result.sentence) ?? [],
              });
            }
            const spent = spentBefore + (await spentOf(core));
            log(
              `  check ${done[0]?.repeat}: ${done.map((each) => each.outcome).join(" ")} · $${spent.toFixed(3)}`,
            );
            stopped = spent >= budget;
            if (stopped) log(`Stopped at $${spent.toFixed(2)}, past the budget of $${budget}.`);
            return !stopped;
          },
        });
        spentBefore += await spentOf(core);
      } finally {
        await library.close();
        await rm(folder, { recursive: true, force: true });
      }
    }
  } finally {
    await writeFile(
      join(out, "report.md"),
      report(summarise(rows), { commit: commitOf(ROOT), spent: spentBefore, repeats }),
    );
    await writeFile(
      join(out, "report.json"),
      JSON.stringify({ model, spent: spentBefore, rows }, null, 2),
    );
    log(`$${spentBefore.toFixed(2)} spent; report in ${out}`);
  }
});
