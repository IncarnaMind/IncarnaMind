/**
 * `INCARNAMIND_EVAL_SPEED_CHECK_TIMES=note,write,answer npm run eval:speed` (README.md › Where a
 * check's time goes): each kind of check timed from the User's action, on real models, in English
 * and Chinese, every request it made tied to its sentence (./checkTimes).
 *
 * - `note`: Check this Note on a Note of 10 sentences over an employment agreement (eval/repeats).
 * - `write`: the assistant writes 30 cited paragraphs into a new Note, scripted, and the first of
 *   them its check reads are checked before they land (src/core/answers/checks/written.ts).
 * - `answer`: an Answer of 30 cited sentences, scripted, judged once it ends (#2311).
 *
 * The writing and the Answer are scripted, so only the checks' requests reach the model under test.
 * INCARNAMIND_EVAL_SPEED_THINKING ("summary" or "off") sets how every model thinks, which only an
 * Answer's batches feel; and
 * INCARNAMIND_EVAL_SPEED_LIBRARY=mixed adds the mixed sample set to the Library, so a search
 * reranks as many Passages as it would in a real one.
 * The 30 sentences are the second held-out set's (./writtenHeldOut), over its membership rules.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { test, vi } from "vitest";
import * as Y from "yjs";
import {
  type ChatModelChoice,
  type ChatModelFactory,
  type ConversationMessage,
  type Core,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { SENTENCE_BATCH_INSTRUCTIONS } from "../../src/core/answers/checks/sentenceBatch";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { BUILT_IN_RERANKING_MODEL } from "../../src/core/reranking/model";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { findQuote } from "../../src/shared/quoteMatch";
import { shownPassages } from "../../tests/helpers/citations";
import { queryDatabase } from "../../tests/helpers/core";
import { connectToMind } from "../../tests/helpers/mindClient";
import { note, readMind, writeMind } from "../../tests/helpers/minds";
import { type ModelCall, scriptedModel } from "../../tests/helpers/models";
import { buildPdf } from "../../tests/helpers/pdf";
import { reports } from "../everyday/asking";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import type { EvalDocument } from "../lib/evaluationSet";
import { type Library, openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { SETS, writeDocuments } from "../repeats/cases";
import {
  checkRecorder,
  checkTimesReport,
  type FlowTimes,
  firstVerdictMs,
  type Landed,
  repeatCounter,
  shownMark,
} from "./checkTimes";
import { env, list, modelsAsked, spentUsd } from "./settings";
import { HELD_OUT_DOCUMENTS, HELD_OUT_ITEMS } from "./writtenHeldOut";

const ROOT = resolve(__dirname, "../..");
type Language = "en" | "zh-CN";

const noteOf = (...ids: string[]) =>
  ids.flatMap((id) => SETS.find((set) => set.id === id)?.sentences ?? []).slice(0, 10);

/** Ten sentences of a Note: what the agreement states, contradicts, partly states and doesn't. */
const NOTE_SENTENCES = {
  en: noteOf("en", "en-paraphrases"),
  "zh-CN": noteOf("zh", "zh-paraphrases"),
};
const NOTE: Record<Language, string[]> = {
  en: NOTE_SENTENCES.en.map((each) => each.text),
  "zh-CN": NOTE_SENTENCES["zh-CN"].map((each) => each.text),
};

/** Thirty sentences over the membership rules, each with the quote it cites. */
const CITED = (language: Language) =>
  HELD_OUT_ITEMS.filter((item) => item.language === language && item.library === "terms").slice(
    0,
    30,
  );

const marked = (sentence: string, marker: number) =>
  /[.。!?！？]$/u.test(sentence)
    ? `${sentence.slice(0, -1)}[^${marker}]${sentence.slice(-1)}`
    : `${sentence}[^${marker}]`;

/** Searches for each quote, cites them, then writes the sentences: an Answer, or a new Note. */
function scriptedTurn(call: ModelCall, items: ReturnType<typeof CITED>, into: "answer" | "note") {
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0)
    return {
      calls: [...new Set(items.map((each) => each.quote))].map((quote) => ({
        tool: "search_documents",
        input: { query: quote },
      })),
    };
  if (!call.results.some((result) => result.tool === "cite")) {
    const passages = searches.flatMap((search) => shownPassages(search.text));
    const citations = items.flatMap(({ quote }, index) => {
      const passage = passages.find((each) =>
        findQuote(each.text, quote, { numbers: "if-needed" }),
      );
      return passage ? [{ marker: index + 1, passage: passage.id, quote }] : [];
    });
    return { calls: [{ tool: "cite", input: { citations } }] };
  }
  const paragraphs = items.flatMap((each, index) => [
    ...(each.paragraphBefore ? [each.paragraphBefore] : []),
    [each.before, marked(each.sentence, index + 1)].filter(Boolean).join(" "),
  ]);
  if (into === "answer") return { text: paragraphs.join("\n\n") };
  if (!call.results.some((result) => result.tool === "create_mind"))
    return {
      calls: [
        {
          tool: "create_mind",
          input: { title: "Membership notes", content: ["## Notes", ...paragraphs].join("\n\n") },
        },
      ],
    };
  return { text: "Wrote them into a new note." };
}

/**
 * The chat models of a run: requests the script answers (an Answer's own turns, a write) never
 * reach the model under test, and every other request goes to it, recorded.
 */
function scripted(
  recorded: (inner: ChatModelFactory) => ChatModelFactory,
  current: () => { flow: string; items: ReturnType<typeof CITED> } | null,
) {
  const answers = scriptedModel((call) => {
    const flow = current();
    if (!flow) return { text: "Nothing to write." };
    return scriptedTurn(call, flow.items, flow.flow === "write" ? "note" : "answer");
  });
  const scriptsIt = (params: { tools?: readonly { name: string }[]; prompt: unknown }) => {
    const flow = current()?.flow;
    if (flow === "write") return params.tools?.some((tool) => tool.name === "create_mind") ?? false;
    if (flow !== "answer") return false;
    const prompt = params.prompt as { role: string; content: unknown }[];
    return !prompt.some(
      (message) => message.role === "system" && message.content === SENTENCE_BATCH_INSTRUCTIONS,
    );
  };
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) =>
      scriptsIt(params) ? answers.doStream(params) : doStream(),
    wrapGenerate: async ({ doGenerate, params }) =>
      scriptsIt(params) ? answers.doGenerate(params) : doGenerate(),
  };
  // Every model's thinking as one arm asks for it: only an Answer's batches reach the model with
  // anything but "off" (src/core/answers/checks/index.ts).
  const thinking = env("THINKING") as ChatModelSpec["thinking"] | null;
  return (inner: ChatModelFactory): ChatModelFactory =>
    (spec) =>
      wrapLanguageModel({
        model: recorded(inner)(thinking ? { ...spec, thinking } : spec) as LanguageModelV4,
        middleware,
      });
}

/** Each sentence's mark as it lands in a Note, as the page shows it: a mark no longer checking. */
function watchNote(
  doc: Y.Doc,
  sentences: readonly string[],
  since: () => number,
  versions: ReadonlyMap<string, string>,
) {
  const landed: Landed[] = [];
  let firstMarkMs: number | null = null;
  const read = () => {
    for (const span of claimSpans(readMind({ blocks: doc.getXmlFragment(MIND_CONTENT_FIELD) }))) {
      if (!span.check?.state) continue;
      firstMarkMs ??= since();
      const shown = shownMark(span.check, span.sentence.text, versions);
      if (shown.verdict === "checking") continue;
      const text = (span.check?.text ?? span.sentence.text).trim();
      const exact = sentences.indexOf(text);
      const index =
        exact >= 0
          ? exact
          : sentences.findIndex((sentence) => text.includes(sentence) || sentence.includes(text));
      if (index >= 0 && !landed.some((each) => each.sentence === index))
        landed.push({ sentence: index, ms: since(), ...shown });
    }
  };
  doc.on("update", read);
  return {
    landed,
    firstMarkMs: () => firstMarkMs,
    stop: () => doc.off("update", read),
  };
}

const seconds = (ms: number | null) => (ms === null ? "none" : `${(ms / 1000).toFixed(1)} s`);

/** Each Document's version, by id, which a mark's display reads to tell a stale verdict. */
const versionsOf = async (core: Core) =>
  new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));

async function noteFlow(
  core: Core,
  choice: ChatModelChoice,
  language: Language,
  recorder: ReturnType<typeof checkRecorder>,
  run: number,
) {
  const sentences = NOTE[language];
  const { id: mindId } = await core.createMind({ title: `Note check ${run}` });
  const client = await connectToMind(core, mindId);
  writeMind(
    client,
    sentences.map((sentence) => note(sentence)),
  );
  await client.settled();
  recorder.begin(sentences);
  const watch = watchNote(client.doc, sentences, recorder.since, await versionsOf(core));
  let earlyMs: number | null = null;
  const stopEarly = core.on("mindCheck.early", (event) => {
    if (event.mindId === mindId && event.sentences.length > 0) earlyMs ??= recorder.since();
  });
  let doneMs = 0;
  // Its end is taken when the check ends, not after a search asked during it.
  const checking = core
    .checkMind({
      requestId: `note-${run}-${Date.now()}`,
      mindId,
      mode: "all",
      model: choice,
    })
    .then(() => {
      doneMs = recorder.since();
    });
  const searchedDuring = await searchDuring(
    core,
    mindId,
    sentences[0] ?? "",
    watch,
    recorder,
    checking,
  );
  await checking;
  watch.stop();
  stopEarly();
  return {
    checkStartMs: watch.firstMarkMs() ?? doneMs,
    firstSignMs: earlyMs ?? watch.firstMarkMs() ?? doneMs,
    doneMs,
    landed: watch.landed,
    ...(searchedDuring && { searchedDuring }),
  };
}

/**
 * A search the User asks for while the Note is checked, when INCARNAMIND_EVAL_SPEED_SEARCH_DURING
 * says how many milliseconds after the claims are named: Cite…'s, which reranks as a model's
 * Answer without Tools does (an Answer's Tool searches don't rerank). Its time, asked to answered.
 */
async function searchDuring(
  core: Core,
  mindId: string,
  text: string,
  watch: ReturnType<typeof watchNote>,
  recorder: ReturnType<typeof checkRecorder>,
  checking: Promise<unknown>,
): Promise<{ atMs: number; ms: number } | null> {
  const after = env("SEARCH_DURING");
  if (after === null) return null;
  // A check that ends first, with no claim named or before the delay, has no search during it.
  let ended = false;
  checking.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  await vi.waitFor(
    () => {
      if (!ended && watch.firstMarkMs() === null) throw new Error("The claims aren't named yet.");
    },
    { timeout: 60_000, interval: 20 },
  );
  if (!ended) await new Promise((resolve) => setTimeout(resolve, Number(after)));
  if (ended) return null;
  const atMs = recorder.since();
  await core.findPassages({ text, mindId, scope: null });
  return { atMs, ms: recorder.since() - atMs };
}

async function writeFlow(
  core: Core,
  choice: ChatModelChoice,
  language: Language,
  recorder: ReturnType<typeof checkRecorder>,
) {
  const sentences = CITED(language).map((each) => each.sentence);
  const versions = await versionsOf(core);
  recorder.begin(sentences);
  const docs = new Map<string, Y.Doc>();
  const watches: ReturnType<typeof watchNote>[] = [];
  let pageChangeMs: number | null = null;
  const stop = core.on("mind.update", (event) => {
    pageChangeMs ??= recorder.since();
    let doc = docs.get(event.mindId);
    if (!doc) {
      const fresh = new Y.Doc();
      docs.set(event.mindId, fresh);
      doc = fresh;
      watches.push(watchNote(fresh, sentences, recorder.since, versions));
      void core.openMind(event.mindId).then(
        ({ state }) => Y.applyUpdate(fresh, state),
        (error: unknown) =>
          console.error(`Couldn't open Mind ${event.mindId} to watch its marks:`, error),
      );
    }
    Y.applyUpdate(doc, event.update);
  });
  const asked = await core.askInConversation({
    text: "Write these into a new note.",
    model: choice,
  });
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  await answerEnds(core, asked.conversation.id, asked.answerId);
  const doneMs = recorder.since();
  stop();
  for (const watch of watches) watch.stop();
  return {
    checkStartMs: pageChangeMs ?? doneMs,
    doneMs,
    landed: watches.flatMap((watch) => watch.landed),
  };
}

/** Resolves once the Answer has ended and none of its Citations is still being judged. */
function answerEnds(
  core: Core,
  conversationId: string,
  answerId: string,
  onMessage?: (message: ConversationMessage) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const check = async () => {
      const { messages } = await core.getConversation(conversationId);
      const found = messages.find((message) => message.id === answerId);
      if (found?.kind !== "answer" || found.status === "streaming") return;
      if (found.citations.some((citation) => citation.check === "checking")) return;
      clearInterval(poll);
      clearTimeout(late);
      stop();
      resolve();
    };
    const stop = core.on("conversation.message", (message) => {
      if (message.id === answerId) onMessage?.(message);
    });
    const poll = setInterval(() => void check().catch(reject), 100);
    const late = setTimeout(() => {
      clearInterval(poll);
      stop();
      reject(new Error("The check didn't end in 10 minutes."));
    }, 10 * 60_000);
  });
}

/**
 * Each Citation marker of an Answer by the sentence it closes: the Answer may number its
 * Citations otherwise than the script did, and some sentences are written twice, in order.
 */
function markersIn(text: string, sentences: readonly string[]): Map<number, number> {
  const placed = new Map<number, number>();
  const taken = new Set<number>();
  for (const match of text.matchAll(/\[\^(\d+)\]/gu)) {
    const marker = Number(match[1]);
    if (placed.has(marker)) continue;
    const before = text
      .slice(0, match.index)
      .replace(/\[\^\d+\]/gu, "")
      .trimEnd();
    const index = sentences.findIndex(
      (sentence, at) => !taken.has(at) && before.endsWith(sentence.replace(/[.。!?！？]$/u, "")),
    );
    if (index < 0) continue;
    placed.set(marker, index);
    taken.add(index);
  }
  return placed;
}

async function answerFlow(
  core: Core,
  choice: ChatModelChoice,
  language: Language,
  recorder: ReturnType<typeof checkRecorder>,
) {
  const sentences = CITED(language).map((each) => each.sentence);
  recorder.begin(sentences);
  const asked = await core.askInConversation({ text: "What do the rules say?", model: choice });
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  const landed: Landed[] = [];
  let endedMs: number | null = null;
  await answerEnds(core, asked.conversation.id, asked.answerId, (message) => {
    if (message.kind !== "answer") return;
    if (message.status !== "streaming") endedMs ??= recorder.since();
    // While it streams, a Citation shows its quote's check, which no judgement made.
    if (endedMs === null) return;
    const placed = markersIn(message.text, sentences);
    for (const citation of message.citations) {
      if (citation.check === "checking") continue;
      const sentence = placed.get(citation.marker);
      if (sentence === undefined) continue;
      const before = landed.find((each) => each.sentence === sentence);
      if (!before) landed.push({ sentence, ms: recorder.since(), verdict: citation.check });
      // A sentence with two Citations shows the worse of their results.
      else if (citation.check !== "found" && before.verdict === "found")
        before.verdict = citation.check;
    }
  });
  const doneMs = recorder.since();
  return { checkStartMs: endedMs ?? doneMs, doneMs, landed };
}

const wanted = list("CHECK_TIMES");
const timedChecks = wanted ? test : test.skip;

timedChecks("where a check's time goes, on each model and language", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  const models = modelsAsked();
  if (models.length === 0) throw new Error("Set INCARNAMIND_EVAL_SPEED_MODELS.");
  const flows = wanted ?? [];
  const languages = (list("LANGUAGES") ?? ["en", "zh-CN"]) as Language[];
  const runs = Number(env("RUNS") ?? "2");
  const stopUsd = Number(env("STOP_USD") ?? "3");
  const recorder = checkRecorder();
  let current: { flow: string; items: ReturnType<typeof CITED> } | null = null;
  const results: FlowTimes[] = [];
  let stopped: string | null = null;
  let spentBefore = 0;
  for (const language of languages) {
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-check-times-"));
    const documents: EvalDocument[] = await writeDocuments(folder, {
      id: language === "en" ? "en" : "zh",
      language,
    });
    // The mixed sample set beside them, for searches that rerank as many Passages as a real Library's.
    if (env("LIBRARY") === "mixed") documents.push(...(await reports()));
    for (const document of HELD_OUT_DOCUMENTS) {
      if (document.language !== language || !document.libraries.includes("terms")) continue;
      const path = join(folder, document.file);
      await writeFile(path, buildPdf(document.pages));
      documents.push({ key: document.file, path });
    }
    const repeats = repeatCounter(createWorkerCrossEncoder(config.rerankOnCpu));
    const library: Library = await openLibrary({
      name: "check-times",
      embedder: createWorkerEmbedder(),
      modelCache: join(config.cacheDir, "models"),
      reranker: repeats.crossEncoder,
      documents,
      embeddings: false,
      keep: config.keepData,
      log,
      chatModels: scripted(recorder.chatModels, () => current),
      examples: join(ROOT, "resources", "examples"),
    });
    try {
      const { core, dataDir } = library;
      core.on(
        "consent.requested",
        (request) => void core.respondToConsent(request.requestId, true),
      );
      await core.updateSettings({ user: { language } });
      // A first run's Library, as the paired checks set has it: the example's Documents beside.
      await core.createExamples();
      await vi.waitFor(
        async () => {
          const all = await core.listDocuments();
          if (
            all.length <= library.documents.size ||
            all.some((each) => !["ready", "failed", "no-text"].includes(each.status))
          )
            throw new Error("The example's Documents are still being read.");
        },
        { timeout: 10 * 60_000, interval: 1000 },
      );
      matrix: for (const model of models) {
        const name = `${model.kind}/${model.modelId}`;
        const saved = await core.saveChatProvider(model);
        const choice: ChatModelChoice = { providerId: saved.id, modelId: model.modelId };
        for (const flow of flows) {
          for (let run = 1; run <= runs; run++) {
            const spent = await spentUsd(core);
            if (spentBefore + spent >= stopUsd) {
              stopped = `Stopped at $${(spentBefore + spent).toFixed(2)}, before ${name} · ${flow} · ${language} · ${run}.`;
              log(stopped);
              break matrix;
            }
            const load = loadavg()[0] ?? 0;
            const load15 = loadavg()[2] ?? 0;
            log(
              `${name} · ${flow} · ${language} · ${run}/${runs} · load ${load.toFixed(1)}, ${load15.toFixed(1)} over 15 minutes`,
            );
            current = { flow, items: CITED(language) };
            const startedAt = new Date().toISOString();
            repeats.begin();
            const times: Pick<
              FlowTimes,
              "checkStartMs" | "firstSignMs" | "doneMs" | "landed" | "searchedDuring"
            > =
              flow === "note"
                ? await noteFlow(core, choice, language, recorder, run)
                : flow === "write"
                  ? await writeFlow(core, choice, language, recorder)
                  : await answerFlow(core, choice, language, recorder);
            current = null;
            const reranks = queryDatabase<{ started_at: string; end_ms: number }>(
              dataDir,
              "SELECT started_at, end_ms FROM ai_timings WHERE kind = 'local' AND model_id = ? AND started_at >= ? ORDER BY started_at",
              [BUILT_IN_RERANKING_MODEL.name, startedAt],
            ).map((row) => ({
              startMs: Date.parse(row.started_at) - Date.parse(startedAt),
              ms: row.end_ms,
            }));
            const after = await spentUsd(core);
            const landed = [...times.landed].sort((a, b) => a.ms - b.ms);
            results.push({
              flow,
              model: name,
              language,
              run,
              load,
              load15,
              checkStartMs: times.checkStartMs,
              ...(times.firstSignMs !== undefined && { firstSignMs: times.firstSignMs }),
              firstMarkMs: landed[0]?.ms ?? null,
              firstVerdictMs: firstVerdictMs(landed),
              doneMs: times.doneMs,
              landed,
              requests: recorder.end(),
              reranks,
              rerankRepeats: repeats.end(),
              ...(times.searchedDuring && { searchedDuring: times.searchedDuring }),
              ...(flow === "note" && {
                stated: NOTE_SENTENCES[language].map((each) => each.expected === "supported"),
              }),
              spentUsd: after - spent,
            });
            if (times.searchedDuring)
              log(
                `  a search asked at ${seconds(times.searchedDuring.atMs)} took ${seconds(times.searchedDuring.ms)}`,
              );
            log(
              `  first mark ${seconds(landed[0]?.ms ?? null)}, first verdict ${seconds(firstVerdictMs(landed))}, done ${(times.doneMs / 1000).toFixed(1)} s, ${landed.length} landed, $${(after - spent).toFixed(4)}`,
            );
          }
        }
      }
      spentBefore += await spentUsd(core);
    } finally {
      await library.close();
      await rm(folder, { recursive: true, force: true });
    }
    if (stopped) break;
  }
  const counts = new Map([
    ["note", 10],
    ["write", 30],
    ["answer", 30],
  ]);
  const report = [
    "# Where a check's time goes",
    "",
    `${new Date().toISOString()} · ${runs} runs a flow, model and language · seconds from the User's action, medians. Spent $${spentBefore.toFixed(3)}.${stopped ? ` ${stopped}` : ""}`,
    "",
    checkTimesReport(results, counts),
  ].join("\n");
  console.log(report);
  const out = join(
    config.resultsDir,
    `check-times-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.md"), report);
  await writeFile(join(out, "report.json"), JSON.stringify(results, null, 2));
  log(`Report in ${out}`);
});
