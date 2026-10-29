/**
 * Asks the citation benchmark's Questions of one model through the app's own
 * Answers path, one Question at a time, each in a Note of its own, then checks
 * each Answer's Note as Check this Note does, and writes the run file after
 * every Answer. A run that stops (a crash, the cap, a refused key) is resumed
 * from its files: what was answered is never asked, or paid for, again.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { join } from "node:path";
import type {
  ChatProviderKind,
  Core,
  ProviderErrorKind,
  SaveChatProviderInput,
} from "../../src/core";
import { redactMessage } from "../../src/core/redact";
import { createFakeChatModel } from "../../src/main/fakeChatModel";
import { coveredPart } from "../../src/shared/claimChecks";
import { type AnswerRecord, askOne, evalOllamaModels } from "../lib/citations";
import { commitOf } from "../lib/commit";
import { type ChatSettings, chatProviderOf, type EvalConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import type { EvalQuestion } from "../lib/evaluationSet";
import { type Library, openLibrary } from "../lib/library";
import type { Log } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { createRecorder } from "../minds/record";
import { marksOf, outcomeOf } from "../repeats/repeat";
import { type CitationQuestion, loadCitationSet } from "./checkSet";
import { capProblem, estimate, labelOf, priceOf, reservationUsd, usdOf } from "./cost";
import {
  answerUsd,
  type CheckRun,
  type CitationsRun,
  keptAnswers,
  type Language,
  type RunAnswer,
  type RunModel,
  readRun,
  resumeProblem,
  runFileName,
  setIdentity,
  sha256,
  spentUsd,
  type Tokens,
  writeRun,
} from "./runs";

/** The smoke tests' scripted chat model (src/main/fakeChat): no model, no network, no cost. */
export const SCRIPTED = "scripted";

export interface HarnessOptions {
  root: string;
  /** Where the run files are, one per model and language. */
  runsDir: string;
  /** The model to ask, as `npm run eval` takes it, or the scripted one. */
  chat: ChatSettings | typeof SCRIPTED;
  languages: readonly Language[];
  /** Only these Questions, by id; null: all of each language. */
  questionIds: readonly string[] | null;
  /** Check each Answer's Note as Check this Note does. */
  check: boolean;
  /** The most the run may spend, in US dollars, its earlier spending included; null: no cap. */
  capUsd: number | null;
  config: Pick<
    EvalConfig,
    "answerTimeoutMs" | "rerankDepth" | "maxPassages" | "cacheDir" | "keepData" | "rerankOnCpu"
  >;
  log: Log;
}

/** A provider's answer no later Question would get past: stop, and say why. */
const STOPPING: ReadonlySet<ProviderErrorKind> = new Set([
  "auth",
  "out-of-credit",
  "region",
  "model",
  "consent-declined",
  "local-mode",
]);

const SCRIPTED_MODEL: RunModel = {
  kind: "ollama",
  modelId: SCRIPTED,
  endpoint: null,
  service: null,
  label: SCRIPTED,
};

/** As the gating set's Citation part takes a Question: its id, language and wording. */
export const asEvalQuestion = (question: CitationQuestion): EvalQuestion => {
  const [first, ...rest] = question.quotes;
  const expected = first ?? { document: "", pages: [1, 1] as [number, number], quote: "" };
  return {
    id: question.id,
    language: question.language,
    crossLingual: question.crossLingual,
    question: question.question,
    expected,
    ...(rest.length > 0 && { expectedAll: question.quotes }),
  };
};

const tokensSince = (now: Tokens, before: Tokens): Tokens => ({
  requests: now.requests - before.requests,
  inputTokens: now.inputTokens - before.inputTokens,
  cachedInputTokens: now.cachedInputTokens - before.cachedInputTokens,
  cacheWriteTokens: now.cacheWriteTokens - before.cacheWriteTokens,
  outputTokens: now.outputTokens - before.outputTokens,
});

/** Within `ms`, or "timed-out" after cancelling the check. */
async function withinTime<T>(
  work: Promise<T>,
  ms: number,
  cancel: () => Promise<void>,
): Promise<T | "timed-out"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => {
      void cancel().finally(() => resolve("timed-out"));
    }, ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Check this Note on the Answer's Note: the model names the claims, then each is checked. */
async function checkNote(
  core: Core,
  mindId: string,
  question: string,
  timeoutMs: number,
): Promise<CheckRun> {
  const requestId = randomUUID();
  const cancel = () => core.cancelCheck(requestId);
  const input = { mindId, mode: "changed" as const, allDocuments: true };
  const found = await withinTime(
    core.findMindClaims({ ...input, requestId: `${requestId}-claims` }),
    timeoutMs,
    () => core.cancelCheck(`${requestId}-claims`),
  );
  if (found === "timed-out") return { kind: "failed", reason: "naming the claims timed out" };
  if (found.kind !== "found") return { kind: "failed", reason: `naming the claims: ${found.kind}` };
  const checked = await withinTime(core.checkMind({ ...input, requestId }), timeoutMs, cancel);
  if (checked === "timed-out") return { kind: "failed", reason: "the check timed out" };
  if (checked.kind !== "checked") return { kind: "failed", reason: `the check: ${checked.kind}` };
  const marks = await marksOf(core, mindId);
  // A Citation stands in a mark's sentence as the object replacement character.
  const plain = (text: string) => text.replaceAll("\uFFFC", "").replace(/\s+/g, " ").trim();
  return {
    kind: "checked",
    sentences: marks
      .filter((mark) => plain(mark.sentence) !== question.trim() && plain(mark.sentence) !== "")
      .map(({ sentence, check }) => ({
        sentence: plain(sentence),
        outcome: outcomeOf(check),
        says: check?.says ?? check?.unsupported?.reason ?? null,
        quote: check?.evidence?.quote ?? coveredPart(check?.unsupported ?? null)?.quote ?? null,
        failure:
          check?.state === "not-checked"
            ? [check.reason, check.detail].filter(Boolean).join(": ")
            : null,
      })),
  };
}

function runAnswerOf(
  question: CitationQuestion,
  answer: AnswerRecord,
  askedAt: string,
  library: Pick<Library, "documents">,
  passageTexts: ReadonlyMap<string, string>,
  check: CheckRun,
  tokens: RunAnswer["tokens"],
  usd: RunAnswer["usd"],
  seconds: RunAnswer["seconds"],
  secrets: readonly string[],
): RunAnswer {
  const keyOf = new Map([...library.documents].map(([key, document]) => [document.id, key]));
  return {
    questionId: question.id,
    kind: question.kind,
    crossLingual: question.crossLingual,
    question: question.question,
    askedAt,
    status: answer.status,
    error: answer.error
      ? { kind: answer.error.kind, message: redactMessage(answer.error.message, secrets) }
      : null,
    text: answer.text,
    sentences: answer.sentences,
    citations: answer.citations.map((citation) => ({
      sentence: citation.sentence,
      quote: citation.quote,
      document: (citation.documentId && keyOf.get(citation.documentId)) || null,
      documentName: citation.documentName,
      pageFrom: citation.pageFrom,
      pageTo: citation.pageTo,
      check: citation.check,
      checkReason: citation.checkReason,
      passageText: (citation.passageId && passageTexts.get(citation.passageId)) || null,
      passagePages: citation.passagePages,
    })),
    figures: answer.figures ?? [],
    searches: answer.searches,
    check,
    tokens,
    usd,
    seconds,
  };
}

function modelOf(chat: HarnessOptions["chat"], service: string | null): RunModel {
  if (chat === SCRIPTED) return SCRIPTED_MODEL;
  return {
    kind: chat.kind,
    modelId: chat.modelId,
    endpoint: chat.endpoint,
    service,
    label: labelOf(chat),
  };
}

const appVersion = (root: string) =>
  (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

/** Runs the benchmark for one model; gives the run files it wrote, by language. */
export async function runBenchmark(options: HarnessOptions): Promise<Map<Language, string>> {
  const { root, chat, log, config } = options;
  const set = await loadCitationSet(root);
  const identity = setIdentity(root);
  const scripted = chat === SCRIPTED;
  const ref = scripted
    ? { kind: "ollama" as ChatProviderKind, modelId: SCRIPTED }
    : { kind: chat.kind, modelId: chat.modelId, endpoint: chat.endpoint };
  const price = scripted ? null : priceOf(ref);
  const secrets = scripted || chat.apiKey === null ? [] : [chat.apiKey];
  const settings: CitationsRun["settings"] = {
    check: options.check,
    answerTimeoutMs: config.answerTimeoutMs,
    rerankDepth: config.rerankDepth,
    maxPassages: config.maxPassages,
    numCtx: scripted ? null : chat.numCtx,
    citing: scripted ? null : chat.citing,
    price,
  };
  const app = { version: appVersion(root), commit: commitOf(root) };
  const label = scripted ? SCRIPTED : labelOf(chat);
  await mkdir(options.runsDir, { recursive: true });

  const plan = options.languages.map((language) => {
    const path = join(options.runsDir, runFileName(label, language));
    const earlier = readRun(path);
    const wanted = {
      set: identity,
      model: modelOf(chat, earlier?.model.service ?? null),
      language,
      settings,
      app,
    };
    const problem = earlier ? resumeProblem(earlier, wanted) : null;
    if (problem) {
      throw new Error(
        `${path} can't be resumed: ${problem}. Move it away, or give the run another folder.`,
      );
    }
    const kept = earlier ? keptAnswers(earlier) : [];
    const answered = new Set(kept.map((answer) => answer.questionId));
    const questions = set.questions.filter(
      (question) =>
        question.language === language &&
        (options.questionIds === null || options.questionIds.includes(question.id)) &&
        !answered.has(question.id),
    );
    return { language, path, earlier, questions };
  });
  if (options.questionIds) {
    const known = new Set(set.questions.map((question) => question.id));
    const unknown = options.questionIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`No such Questions in the set: ${unknown.join(", ")}`);
  }

  const toAsk = plan.reduce((sum, each) => sum + each.questions.length, 0);
  let spent = plan.reduce((sum, each) => sum + (each.earlier ? spentUsd(each.earlier) : 0), 0);
  const expected = estimate(ref, toAsk, { check: options.check, judges: [] });
  const refused = capProblem(options.capUsd, price, spent, expected.runUsd);
  if (refused) throw new Error(`The run doesn't start. ${refused}`);
  log(
    `${label}: ${toAsk} Questions to ask in ${plan.map((each) => `${each.language} (${each.questions.length})`).join(", ")}` +
      (price
        ? `; expected $${expected.runUsd.toFixed(2)}, spent $${spent.toFixed(2)}, cap $${options.capUsd?.toFixed(2)}`
        : "; no cost"),
  );
  const written = new Map(plan.map((each) => [each.language, each.path]));
  if (toAsk === 0) return written;

  const recorder = createRecorder();
  const ollamaModels = scripted
    ? { describe: async () => null, loaded: async () => null, running: async () => true }
    : evalOllamaModels(chat);
  const library = await openLibrary({
    name: "citations",
    embedder: createWorkerEmbedder(),
    modelCache: join(config.cacheDir, "models"),
    reranker: createWorkerCrossEncoder(config.rerankOnCpu),
    documents: set.documents.map((document) => ({
      key: document.key,
      path: join(root, document.path),
    })),
    keep: config.keepData,
    log,
    allowUnprocessed: true,
    embeddings: false,
    answerSearch: {
      ...(config.rerankDepth !== null && { rerankDepth: config.rerankDepth }),
      ...(config.maxPassages !== null && { maxPassages: config.maxPassages }),
    },
    chatModels: (inner) => recorder.chatModels(scripted ? createFakeChatModel : inner),
    ...(ollamaModels && { ollamaModels }),
  });
  const { core } = library;
  // Setting the model is the consent to send it the Questions, the Passages and the Notes' sentences.
  const stopConsent = core.on("consent.requested", (request) => {
    core
      .respondToConsent(
        request.requestId,
        request.flow.id === "chat" || request.flow.id === "checks",
      )
      .catch((error: unknown) => console.error(error));
  });
  try {
    const input: SaveChatProviderInput = scripted
      ? { kind: "ollama", modelId: SCRIPTED }
      : chatProviderOf(chat);
    const provider = await core.saveChatProvider(input);
    const model = modelOf(chat, provider.service?.name ?? null);
    const cpu = cpus();
    const passageTexts = new Map(
      library.passages().map((passage) => [passage.passageId, passage.text]),
    );
    const documents = [...library.documents].map(([key, document]) => {
      const pages = library.pageTexts(document.id);
      return {
        key,
        name: document.name,
        status: document.status,
        pages: pages.length,
        pagesSha256: sha256(JSON.stringify(pages)),
      };
    });

    run: for (const { language, path, earlier, questions } of plan) {
      const now = new Date().toISOString();
      const run: CitationsRun = earlier ?? {
        benchmark: "IncarnaMind citation benchmark",
        set: identity,
        model,
        language,
        settings,
        app,
        host: {
          platform: `${platform()} ${arch()}`,
          cpu: `${cpu[0]?.model.trim() ?? "unknown CPU"} (${cpu.length} cores)`,
          node: process.version,
        },
        startedAt: now,
        updatedAt: now,
        documents,
        answers: [],
        retriedUsd: 0,
        stopped: null,
      };
      run.stopped = null;
      for (const question of questions) {
        const capped = capProblem(
          options.capUsd,
          price,
          spent,
          reservationUsd(ref, price, options.check),
        );
        if (capped) {
          run.stopped = { reason: capped, at: new Date().toISOString() };
          writeRun(path, run);
          log(`Stopped before ${question.id}: ${capped}`);
          break run;
        }
        const askedAt = new Date().toISOString();
        const before = { ...recorder.chat };
        const answer = await askOne(library, asEvalQuestion(question), 1, config.answerTimeoutMs);
        const afterAnswer = { ...recorder.chat };
        const checkStarted = performance.now();
        const check: CheckRun =
          options.check && answer.status === "done" && answer.mindId
            ? await checkNote(core, answer.mindId, question.question, config.answerTimeoutMs)
            : { kind: "off" };
        const checkSeconds = (performance.now() - checkStarted) / 1000;
        const tokens = {
          answer: tokensSince(afterAnswer, before),
          check: tokensSince(recorder.chat, afterAnswer),
        };
        const usd = {
          answer: usdOf(tokens.answer, price, model.kind),
          check: usdOf(tokens.check, price, model.kind),
        };
        const record = runAnswerOf(
          question,
          answer,
          askedAt,
          library,
          passageTexts,
          check,
          tokens,
          usd,
          { answer: answer.seconds, check: checkSeconds },
          secrets,
        );
        const replaced = run.answers.findIndex((each) => each.questionId === question.id);
        if (replaced >= 0) {
          run.retriedUsd += answerUsd(run.answers[replaced] as RunAnswer);
          run.answers.splice(replaced, 1, record);
        } else run.answers.push(record);
        run.updatedAt = new Date().toISOString();
        spent += answerUsd(record);
        recorder.transcript.length = 0;
        writeRun(path, run);
        const flagged =
          check.kind === "checked"
            ? check.sentences.filter(
                (each) => !["supported", "not-checked", "no-mark"].includes(each.outcome),
              ).length
            : 0;
        log(
          `${question.id}: ${answer.status}, ${record.citations.length} Citations (${record.citations.filter((each) => each.check === "found").length} found), check ${check.kind}${check.kind === "checked" ? ` (${check.sentences.length} sentences, ${flagged} flagged)` : ""}, ${record.seconds.answer.toFixed(0)} + ${checkSeconds.toFixed(0)} s${price ? `, $${answerUsd(record).toFixed(4)} (spent $${spent.toFixed(2)})` : ""}`,
        );
        if (record.error && STOPPING.has(record.error.kind)) {
          run.stopped = {
            reason: `${record.error.kind}: ${record.error.message}`,
            at: new Date().toISOString(),
          };
          writeRun(path, run);
          log(
            `Stopped: the provider answered ${record.error.kind}, which no later Question gets past`,
          );
          break run;
        }
      }
      writeRun(path, run);
    }
    return written;
  } finally {
    stopConsent();
    await library.close();
  }
}
