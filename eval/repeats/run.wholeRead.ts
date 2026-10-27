/**
 * `npm run eval:whole-read` (README.md): Check against a Document… on long
 * agreements, with a real chat model and the app's real Library, and a report
 * of what each sentence got, how much was read and what it cost.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { ChatModelChoice, Core, DocumentCheckProgress } from "../../src/core";
import { connectToMind } from "../../tests/helpers/mindClient";
import { note, writeMind } from "../../tests/helpers/minds";
import { buildPdf } from "../../tests/helpers/pdf";
import { commitOf } from "../lib/commit";
import { chatProviderOf, readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder, prepareGpuFile } from "../lib/rerank";
import { watchPassages } from "./passagesHanded";
import { marksOf, type Outcome, outcomeOf } from "./repeat";
import { WHOLE_READ_SENTENCES, type WholeReadSentence } from "./wholeReadCases";
import {
  CLAUSE_WORDS,
  type WholeReadLanguage,
  type WholeReadSize,
  wholeReadDocument,
} from "./wholeReadDocuments";
import { report, type WholeReadRow } from "./wholeReadScore";

const ROOT = resolve(__dirname, "../..");

const spentOf = async (core: Core) =>
  (await core.getCostSummary()).spent
    .filter((each) => each.currency === "USD")
    .reduce((total, each) => total + each.amount, 0);

const CASES: readonly { id: string; language: WholeReadLanguage; size: WholeReadSize }[] = [
  { id: "en-40", language: "en", size: 40 },
  { id: "en-120", language: "en", size: 120 },
  { id: "zh-40", language: "zh-CN", size: 40 },
  { id: "zh-120", language: "zh-CN", size: 120 },
];

const squeezed = (text: string) => text.replace(/\s+/g, "");

const list = (name: string) =>
  process.env[name]
    ?.split(",")
    .map((each) => each.trim())
    .filter(Boolean) ?? null;

test("check against a Document, read whole", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const chat = config.chat;
  if (!chat) {
    log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY (README.md).");
    return;
  }
  const asked = Number(process.env.INCARNAMIND_EVAL_REPEATS ?? "10");
  const repeats = Number.isInteger(asked) && asked >= 0 ? asked : 10;
  const budget = Number(process.env.INCARNAMIND_EVAL_WHOLE_READ_BUDGET ?? "1") || 1;
  const cases = list("INCARNAMIND_EVAL_WHOLE_READ_CASES");
  const keys = list("INCARNAMIND_EVAL_WHOLE_READ_SENTENCES");
  const searched = process.env.INCARNAMIND_EVAL_WHOLE_READ_SEARCHED === "1";
  const model = `${chat.kind}/${chat.modelId}`;
  await prepareGpuFile(config, log);
  const reranker = createWorkerCrossEncoder(config.rerankOnCpu);
  const out = join(
    config.resultsDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-whole-read`,
  );
  await mkdir(out, { recursive: true });
  const rows: WholeReadRow[] = [];
  let spentBefore = 0;
  let stopped = false;
  try {
    for (const each of CASES.filter((one) => !cases || cases.includes(one.id))) {
      if (stopped) break;
      const document = wholeReadDocument(each.language, each.size);
      const sentences = WHOLE_READ_SENTENCES[each.language].filter(
        (one) => !keys || keys.includes(one.key),
      );
      const folder = await mkdtemp(join(tmpdir(), "incarnamind-whole-read-"));
      const path = join(folder, document.file);
      await writeFile(path, buildPdf(document.pages));
      const watch = watchPassages(sentences.map((one) => one.text));
      const library = await openLibrary({
        name: `whole-read-${each.id}`,
        embedder: createWorkerEmbedder(),
        modelCache: join(config.cacheDir, "models"),
        reranker,
        documents: [{ key: document.file, path }],
        keep: config.keepData,
        embeddings: false,
        chatModels: watch.chatModels,
        log,
      });
      try {
        const { core } = library;
        const added = library.documents.get(document.file);
        if (!added) throw new Error(`${document.file} was not added.`);
        // Setting the variables is the consent to send the sentences and the agreement to the model.
        core.on("consent.requested", (request) => {
          void core.respondToConsent(
            request.requestId,
            request.flow.id === "chat" || request.flow.id === "checks",
          );
        });
        await core.updateSettings({ user: { language: each.language } });
        const provider = await core.saveChatProvider(chatProviderOf(chat));
        if (provider.service) await core.allowDataFlow("document-check", provider.service.id);
        const choice: ChatModelChoice = { providerId: provider.id, modelId: chat.modelId };
        const heard: DocumentCheckProgress[] = [];
        core.on("documentCheck.progress", (event) => {
          heard.push(event);
        });
        const { id: mindId } = await core.createMind({ title: document.file, folderId: null });
        const client = await connectToMind(core, mindId);
        const blocks = sentences.map((one) => note(one.text));
        writeMind(client, blocks);
        await client.settled();
        const placeOf = (index: number) => {
          const blockId = String(blocks[index]?.attrs?.id);
          const length = sentences[index]?.text.length ?? 0;
          return { from: { blockId, offset: 0 }, to: { blockId, offset: length } };
        };
        const plan = await core.planDocumentCheck({
          mindId,
          within: { folderIds: [], tagIds: [], documentIds: [added.id] },
          model: choice,
        });
        log(
          `${model} · ${each.id}: ${document.pages.length} pages, clauses on ${JSON.stringify(document.targetPages)}; ${plan.kind === "ready" ? `${plan.tokens} tokens, about $${plan.estimate?.billing === "per-token" ? (plan.estimate.cost?.amount ?? 0).toFixed(3) : "0"} a read` : plan.kind}`,
        );
        const record = async (
          sentence: WholeReadSentence,
          index: number,
          repeat: number,
          how: "read" | "searched",
        ) => {
          heard.length = 0;
          watch.take();
          const before = await spentOf(core);
          const started = Date.now();
          const result = await core.checkSentences({
            requestId: `${mindId}-${how}-${index}-${repeat}`,
            mindId,
            ...placeOf(index),
            action: how === "read" ? "check-against-document" : "check-against-documents",
            ...(how === "read" && {
              within: { folderIds: [], tagIds: [], documentIds: [added.id] },
            }),
            model: choice,
          });
          const seconds = (Date.now() - started) / 1000;
          const spent = (await spentOf(core)) - before;
          const check = (await marksOf(core, mindId)).find(
            (mark) => mark.sentence === sentence.text,
          )?.check;
          const outcome: Outcome = result.kind === "checked" ? outcomeOf(check) : "not-checked";
          const handed = watch.take().get(sentence.text) ?? [];
          const read = heard.at(-1);
          const clause = sentence.place && CLAUSE_WORDS[each.language][sentence.place];
          rows.push({
            caseId: each.id,
            language: each.language,
            size: each.size,
            model,
            how,
            repeat,
            key: sentence.key,
            kind: sentence.kind,
            expected: sentence.expected,
            place: sentence.place,
            text: sentence.text,
            outcome,
            readAll: check?.read ? check.read.pages === check.read.of : false,
            pages: check?.read?.pages ?? read?.pages ?? null,
            of: check?.read?.of ?? read?.of ?? null,
            says: check?.says ?? check?.unsupported?.reason ?? null,
            quote: check?.evidence?.quote ?? check?.unsupported?.quoted?.quote ?? null,
            failure:
              result.kind !== "checked"
                ? result.kind
                : check?.state === "not-checked"
                  ? [check.reason, check.detail].filter(Boolean).join(": ")
                  : null,
            handedClause:
              how === "searched" && clause
                ? handed.some((passage) => squeezed(passage.text).includes(squeezed(clause)))
                : null,
            spent,
            seconds,
          });
          const total = spentBefore + (await spentOf(core));
          log(
            `  ${how} ${repeat} ${sentence.key}: ${outcome}${check?.read ? ` ${check.read.pages}/${check.read.of}` : ""} · $${spent.toFixed(4)} · ${seconds.toFixed(1)} s · $${total.toFixed(3)}`,
          );
          stopped = total >= budget;
          if (stopped) log(`Stopped at $${total.toFixed(2)}, past the budget of $${budget}.`);
        };
        if (searched) {
          for (const [index, sentence] of sentences.entries()) {
            if (stopped) break;
            await record(sentence, index, 1, "searched");
          }
        }
        for (let repeat = 1; repeat <= repeats && !stopped; repeat++) {
          for (const [index, sentence] of sentences.entries()) {
            if (stopped) break;
            await record(sentence, index, repeat, "read");
          }
        }
      } finally {
        try {
          spentBefore += await spentOf(library.core);
        } finally {
          await library.close();
          await rm(folder, { recursive: true, force: true });
        }
      }
    }
  } finally {
    await writeFile(
      join(out, "report.md"),
      report(rows, { commit: commitOf(ROOT), spent: spentBefore, repeats }),
    );
    await writeFile(
      join(out, "report.json"),
      JSON.stringify({ model, spent: spentBefore, rows }, null, 2),
    );
    log(`$${spentBefore.toFixed(2)} spent; report in ${out}`);
  }
});
