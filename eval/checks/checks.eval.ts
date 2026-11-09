/**
 * The checks evaluation (eval/checks/README.md, #86), part of `npm run eval`:
 * Find support's 208 sentences and verify's 10 received documents, run end to
 * end against one Folder of Documents and scored against the labels.
 *
 * It needs a chat model (INCARNAMIND_EVAL_CHAT_*), and skips without one or
 * when INCARNAMIND_EVAL_QUESTIONS asks for a short run of the others. The
 * library is a temporary data folder with the Folder's Documents and web
 * pages and the received documents, searched as the app searches by default
 * (keyword search reranked by the built-in model, embeddings off). Each
 * received document's claims are extracted from its stored text, and every
 * claim and sentence is checked against the Folder by the app's claim check,
 * the document itself left out.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { commitOf } from "../lib/commit";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { chatGenerate } from "../lib/rewrites";
import { watchRequests } from "../repeats/requests";
import { corePipeline } from "./lib/pipeline";
import { type ChecksReport, summaryLines, writeChecksReport } from "./lib/report";
import {
  gates,
  type SentenceResult,
  scoreFindSupport,
  scoreVerify,
  type VerifiedDocument,
} from "./lib/scoring";
import { type FindSupportItem, readChecksSet, type VerifyItem } from "./lib/set";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** The bars gate once verify's extraction (#97) replaces the baseline's too. */
const GATING = false;

test("checks evaluation: Find support and verify", async () => {
  const started = new Date();
  const log = createLog(started.getTime());
  const config = readConfig(root);
  const set = await readChecksSet(root);
  if (!config.chat) {
    log(
      "Checks: skipped, no chat model was given. Set INCARNAMIND_EVAL_CHAT_KIND, INCARNAMIND_EVAL_CHAT_MODEL and INCARNAMIND_EVAL_CHAT_KEY (eval/README.md).",
    );
    return;
  }
  if (config.questionIds) {
    log(
      "Checks: skipped, INCARNAMIND_EVAL_QUESTIONS asks for a short run. Run the checks alone with `npm run eval -- eval/checks`.",
    );
    return;
  }
  const findSupport = set.items.filter(
    (item): item is FindSupportItem => item.set === "find-support",
  );
  // A control of true claims runs Find support alone (INCARNAMIND_EVAL_CHECKS_SETS=find-support).
  const sets = process.env.INCARNAMIND_EVAL_CHECKS_SETS?.split(",") ?? ["find-support", "verify"];
  const verify = sets.includes("verify")
    ? set.items.filter((item): item is VerifyItem => item.set === "verify")
    : [];
  const watch = watchRequests(findSupport.map((item) => item.sentence));
  const files = [...set.folder.filter((document) => !document.address), ...set.received];
  const pages = set.folder.flatMap(({ name, path, address }) =>
    address ? [{ key: name, path, address }] : [],
  );
  const webPages = await Promise.all(
    pages.map(async ({ key, path, address }) => ({
      key,
      address,
      html: await readFile(join(root, path), "utf8"),
    })),
  );
  log(
    `Checks: ${findSupport.length} sentences and ${verify.length} claims, over ${set.folder.length} Folder Documents and ${set.received.length} received documents`,
  );
  const library = await openLibrary({
    name: "checks",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(),
    documents: files.map((document) => ({
      key: document.name,
      path: join(root, document.path),
    })),
    webPages,
    embeddings: false,
    keep: config.keepData,
    chatModels: watch.chatModels,
    log,
  });
  try {
    const { core, documents } = library;
    const idOf = (name: string) => {
      const document = documents.get(name);
      if (!document) throw new Error(`${name} wasn't added.`);
      return document.id;
    };
    const folder = await core.createLibraryGroup({
      name: "Checks evaluation",
      description: "The Documents Find support and verify check against.",
    });
    await core.moveToFolder({
      documentIds: set.folder.map((document) => idOf(document.name)),
      folderId: folder.id,
    });
    const names = new Map([...documents].map(([name, document]) => [document.id, name]));
    const { chat } = config;
    // Setting the variables is the consent to send the sentences and Passages to the chat model.
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
    const pipeline = corePipeline({
      core,
      generate: chatGenerate(chat),
      scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
      nameOf: (passage) => names.get(passage.documentId) ?? passage.documentName,
      citedName: (citation) => names.get(citation.documentId) ?? citation.documentName,
    });

    const sentences: SentenceResult[] = [];
    for (const item of findSupport) {
      watch.take();
      const outcome = await pipeline.check(item.sentence);
      sentences.push({ id: item.id, outcome, requests: watch.take().get(item.sentence) ?? [] });
      if (sentences.length % 25 === 0) {
        log(`Find support: ${sentences.length} of ${findSupport.length} checked`);
      }
    }

    const verified: VerifiedDocument[] = [];
    for (const received of verify.length > 0 ? set.received : []) {
      const id = idOf(received.name);
      const text = library
        .pageTexts(id)
        .map((unit) => unit.text)
        .join("\n\n");
      const extraction = await pipeline.extractClaims(text);
      const claims = [];
      for (const claim of extraction.claims) {
        claims.push({ ...claim, outcome: await pipeline.check(claim.text, { documentIds: [id] }) });
      }
      verified.push({ document: received.name, claims, failure: extraction.failure });
      log(
        `Verify: ${received.name}, ${claims.length} claims extracted${extraction.failure ? ` (${extraction.failure})` : ""}`,
      );
    }

    const findSupportScore = scoreFindSupport(
      findSupport,
      sentences,
      (name) => set.folder.find((document) => document.name === name)?.format ?? "unknown",
    );
    const verifyScore = scoreVerify(verify, verified);
    const report: ChecksReport = {
      run: {
        startedAt: started.toISOString(),
        seconds: (Date.now() - started.getTime()) / 1000,
        commit: commitOf(root),
        model: `${config.chat.kind}/${config.chat.modelId}`,
        pipeline:
          "the app's claim check (checkClaim); claim extraction: the evaluation's baseline (eval/checks/lib/pipeline.ts)",
      },
      set: {
        findSupport: findSupport.length,
        verify: verify.length,
        received: set.received.length,
        confirmed: set.items.filter((item) => item.confirmed).length,
        review: set.review,
      },
      gating: GATING,
      gates: gates(findSupportScore, verifyScore),
      findSupport: findSupportScore,
      verify: verifyScore,
      usage: pipeline.usage(),
      results: { findSupport: sentences, verify: verified },
    };
    const dir = await writeChecksReport(report, config.resultsDir);
    console.log(summaryLines(report, dir).join("\n"));
    if (GATING) {
      expect(
        report.gates.filter((gate) => !gate.met).map((gate) => gate.name),
        "The checks evaluation missed its bars (see the report).",
      ).toEqual([]);
    }
  } finally {
    await library.close();
  }
});
