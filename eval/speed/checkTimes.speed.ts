/**
 * `INCARNAMIND_EVAL_SPEED_CHECK_TIMES=note,write,answer npm run eval:speed` (README.md › Where a
 * check's time goes): each kind of check timed from the User's action, on real models, in English
 * and Chinese, every request it made tied to its sentence (./checkTimes).
 *
 * - `note`: Check this Note on a Note of 10 sentences over an employment agreement (eval/repeats).
 * - `write`: the assistant writes 30 cited paragraphs into a new Note, scripted, and the first of
 *   them its check reads are checked before they land (src/core/answers/checks/written.ts).
 * - `answer`: an Answer of 30 cited sentences, scripted, judged once it ends (#2311).
 * - `asked`: the gating set's Questions (eval/retrieval), the `run`th of each language, answered
 *   by the model under test and judged once each ends, for how its check fares on its own Answers.
 *
 * The writing and the Answer are scripted, so only the checks' requests reach the model under test.
 * INCARNAMIND_EVAL_SPEED_THINKING ("summary" or "off") sets how every model thinks, which only an
 * Answer's batches feel; and
 * INCARNAMIND_EVAL_SPEED_LIBRARY=mixed adds the mixed sample set to the Library, so a search
 * reranks as many Passages as it would in a real one.
 * INCARNAMIND_EVAL_SPEED_ANSWER_SENTENCES (as `1,2,3`) has `answer` write Answers of so many
 * sentences instead, each run the set's next ones, so each is judged in one batch of that size; and
 * INCARNAMIND_EVAL_SPEED_BATCH_ROOM gives every batch that many output tokens instead of its own
 * limit, to measure what a whole reply takes. Neither is for a gate's arm of today's path.
 * INCARNAMIND_EVAL_SPEED_ANSWER_SET=room has `answer` write the short Answers of #2951's gate
 * (./checkRoomCases) instead, and INCARNAMIND_EVAL_SPEED_ROOM_ARMS (as `main,main,today`) checks
 * each of them once on each arm, the order turning from Answer to Answer: `main` gives each batch
 * the room main gave it, 300 tokens a sentence, and `today` the room it has. With
 * INCARNAMIND_EVAL_SPEED_JUDGE, the judge lists once which of the set's sentences their quotes
 * don't state (./unstated), into judged.json beside the report.
 * The 30 sentences are the second held-out set's (./writtenHeldOut), over its membership rules.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { isSentenceBatch } from "../../src/core/answers/checks/sentenceBatch";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { outputTokens } from "../../src/core/providers/outputLimits";
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
import { type EvalDocument, loadEvaluationSet } from "../lib/evaluationSet";
import { type Library, openLibrary } from "../lib/library";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { SETS, writeDocuments } from "../repeats/cases";
import { allowanceLeft } from "./allowance";
import { ROOM_DOCUMENTS, ROOM_ITEMS } from "./checkRoomCases";
import { roomGateSection } from "./checkRoomGate";
import {
  checkRecorder,
  checkTimesReport,
  type FlowTimes,
  firstVerdictMs,
  type Landed,
  repeatCounter,
  shownMark,
} from "./checkTimes";
import { dryRunModel } from "./dryRun";
import { judgeOf } from "./judge";
import { SEARCH_FIRST_DOCUMENTS, SEARCH_FIRST_ITEMS } from "./searchFirstCases";
import { searchFirstGateSection } from "./searchFirstGate";
import { LOW_RANK_CANDIDATES } from "./searchFirstLowRank";
import { env, list, modelsAsked, spentUsd } from "./settings";
import { unstatedSentences } from "./unstated";
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

/** #2532's held-out Note of 32 sentences in each language (./searchFirstCases). */
const HELD_NOTE = (language: Language) =>
  SEARCH_FIRST_ITEMS.filter((item) => item.language === language);

/** The sentences a Note flow checks. */
const noteSentences = (flow: string, language: Language) =>
  flow === "note-held" ? HELD_NOTE(language).map((item) => item.sentence) : NOTE[language];

/** A request's failure that leaves the run not counted (../evidence/2532-search-first/README.md). */
const VOIDING: ReadonlySet<string> = new Set([
  "failed",
  "timed-out",
  "rate-limit",
  "out-of-credit",
  "plan-limit",
  "cost-cap",
  "consent-revoked",
]);

/** Thirty sentences over the membership rules, each with the quote it cites; or the room gate's. */
const CITED = (language: Language) =>
  env("ANSWER_SET") === "room"
    ? ROOM_ITEMS.filter((item) => item.language === language)
    : HELD_OUT_ITEMS.filter((item) => item.language === language && item.library === "terms").slice(
        0,
        30,
      );

const marked = (sentence: string, marker: number) =>
  /[.。!?！？]$/u.test(sentence)
    ? `${sentence.slice(0, -1)}[^${marker}]${sentence.slice(-1)}`
    : `${sentence}[^${marker}]`;

/**
 * How a scripted turn writes its sentences: as an Answer; into a new Note; into a new Note with the
 * second half written with no Citation; or into three new Notes, one after another (#2830).
 */
type Into = "answer" | "note" | "note-mixed" | "notes";

const intoOf = (flow: string): Into =>
  flow === "write"
    ? "note"
    : flow === "write-mixed"
      ? "note-mixed"
      : flow === "writes"
        ? "notes"
        : "answer";

/** The held-out sentences a flow writes. */
const itemsOf = (flow: string, language: Language) =>
  flow === "write-mixed" ? CITED(language).slice(0, 20) : CITED(language);

/** Searches for each quote, cites them, then writes the sentences: an Answer, or new Notes. */
function scriptedTurn(call: ModelCall, items: ReturnType<typeof CITED>, into: Into) {
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
  const uncitedFrom = into === "note-mixed" ? items.length / 2 : items.length;
  const paragraphsOf = (part: ReturnType<typeof CITED>, offset: number) =>
    part.flatMap((each, at) => {
      const index = offset + at;
      const sentence = index < uncitedFrom ? marked(each.sentence, index + 1) : each.sentence;
      return [
        ...(each.paragraphBefore ? [each.paragraphBefore] : []),
        [each.before, sentence].filter(Boolean).join(" "),
      ];
    });
  if (into === "answer") return { text: paragraphsOf(items, 0).join("\n\n") };
  const parts =
    into === "notes" ? [0, 10, 20].map((start) => items.slice(start, start + 10)) : [items];
  const made = call.results.filter((result) => result.tool === "create_mind").length;
  const part = parts[made];
  if (part)
    return {
      calls: [
        {
          tool: "create_mind",
          input: {
            title: parts.length > 1 ? `Membership notes ${made + 1}` : "Membership notes",
            content: ["## Notes", ...paragraphsOf(part, made * 10)].join("\n\n"),
          },
        },
      ],
    };
  return { text: "Wrote them into new notes." };
}

/**
 * The chat models of a run: requests the script answers (an Answer's own turns, a write) never
 * reach the model under test, and every other request goes to it, recorded.
 */
function scripted(
  recorded: (inner: ChatModelFactory) => ChatModelFactory,
  current: () => { flow: string; items: ReturnType<typeof CITED>; arm?: string } | null,
) {
  const answers = scriptedModel((call) => {
    const flow = current();
    if (!flow) return { text: "Nothing to write." };
    return scriptedTurn(call, flow.items, intoOf(flow.flow));
  });
  const scriptsIt = (params: { tools?: readonly { name: string }[]; prompt: unknown }) => {
    const flow = current()?.flow;
    if (flow?.startsWith("write"))
      return params.tools?.some((tool) => tool.name === "create_mind") ?? false;
    if (flow !== "answer") return false;
    const prompt = params.prompt as { role: string; content: unknown }[];
    return !prompt.some((message) => message.role === "system" && isSentenceBatch(message.content));
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
  const room = env("BATCH_ROOM");
  middleware.transformParams = async ({ params }) => {
    const prompt = params.prompt as { role: string; content: unknown }[];
    const batch = prompt.some(
      (message) => message.role === "system" && isSentenceBatch(message.content),
    );
    if (!batch) return params;
    if (current()?.arm?.startsWith("main")) {
      const asked = JSON.stringify(prompt).match(/<sentence number=/g)?.length ?? 1;
      return { ...params, maxOutputTokens: outputTokens("sentence-batch-records", asked) };
    }
    return room ? { ...params, maxOutputTokens: Number(room) } : params;
  };
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
        landed.push({
          sentence: index,
          ms: since(),
          ...shown,
          ...(span.check.evidence && {
            evidence: {
              document: span.check.evidence.documentName,
              quote: span.check.evidence.quote,
            },
          }),
        });
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
  sentences: readonly string[],
  recorder: ReturnType<typeof checkRecorder>,
  title: string,
) {
  const { id: mindId } = await core.createMind({ title });
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
      requestId: `note-${mindId}`,
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
  await client.settled();
  return {
    anomalies: anomaliesIn(client.doc, sentences),
    checkStartMs: watch.firstMarkMs() ?? doneMs,
    firstSignMs: earlyMs ?? watch.firstMarkMs() ?? doneMs,
    doneMs,
    landed: watch.landed,
    ...(searchedDuring && { searchedDuring }),
  };
}

interface Ranked {
  id: string;
  language: Language;
  detail: string;
  /** A Passage of the search holds the sentence word for word: the check hands it over first. */
  stated: boolean;
  /** Where in the search's order each of its stating lines' Passages came, from 1; null when none held it. */
  ranks: (number | null)[];
  found: number;
}

/**
 * For each right sentence of the held-out Note, where the search of its own words ranks the
 * Passages that state it, as the check's search orders them (Cite…'s search, on the same Tool and
 * reranker). No model is asked.
 */
async function ranksOf(core: Core, language: Language, candidates: boolean): Promise<Ranked[]> {
  const { id: mindId } = await core.createMind({ title: `Ranks ${language}` });
  const ranked: Ranked[] = [];
  const held = HELD_NOTE(language);
  const asked = candidates
    ? [
        ...held,
        ...LOW_RANK_CANDIDATES.filter(
          (each) => each.language === language && !held.some((kept) => kept.id === each.id),
        ),
      ]
    : held;
  for (const item of asked) {
    if (item.kind !== "right" || !item.rests) continue;
    const found = await core.findPassages({ text: item.sentence, mindId, scope: null });
    // A table's row is read back as its cells, which its Passage lays out its own way.
    const holds = (text: string, line: string) =>
      findQuote(text, line) !== null || line.split(",").every((cell) => text.includes(cell.trim()));
    ranked.push({
      id: item.id,
      language,
      detail: item.detail,
      stated: found.some((passage) => findQuote(passage.text, item.sentence.trim()) !== null),
      ranks: item.rests.map((line) => {
        const at = found.findIndex((passage) => holds(passage.text, line));
        return at < 0 ? null : at + 1;
      }),
      found: found.length,
    });
  }
  return ranked;
}

/** The ranks as a table: whether the check hands each right sentence the Passages that state it. */
function ranksSection(ranked: readonly Ranked[]): string {
  const handed = (each: Ranked) =>
    each.stated || each.ranks.every((rank) => rank !== null && rank <= 4);
  return [
    "## Where each right sentence's stating Passages rank in its own search",
    "",
    `The check hands over the first four, a Passage that states the sentence word for word first. Handed in full: ${ranked.filter(handed).length} of ${ranked.length}.`,
    "",
    "| Sentence | How it is stated | Word for word in a Passage | Rank of each stating line's Passage | Passages found | All handed |",
    "|---|---|---|---|--:|---|",
    ...ranked.map(
      (each) =>
        `| ${each.id} | ${each.detail} | ${each.stated ? "yes" : ""} | ${each.ranks.map((rank) => rank ?? "none").join(", ")} | ${each.found} | ${handed(each) ? "yes" : "**no**"} |`,
    ),
  ].join("\n");
}

/** The states a checked Note must never be left in (`FlowTimes.anomalies`), counted. */
function anomaliesIn(doc: Y.Doc, sentences: readonly string[]) {
  const spans = claimSpans(readMind({ blocks: doc.getXmlFragment(MIND_CONTENT_FIELD) }));
  const marks = sentences.map(
    (sentence) =>
      spans.filter((span) => span.check?.state && span.sentence.text.trim() === sentence.trim())
        .length,
  );
  return {
    noMark: marks.filter((count) => count === 0).length,
    noQuote: spans.filter(
      (span) =>
        (span.check?.state === "supported" || span.check?.state === "contradicted") &&
        !span.check.evidence?.quote,
    ).length,
    twice: marks.filter((count) => count > 1).length,
    checking: spans.filter(
      (span) =>
        span.check?.state === "checking" ||
        (span.check?.parts ?? []).some((part) => part.verdict === "checking"),
    ).length,
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
  items: ReturnType<typeof CITED>,
  recorder: ReturnType<typeof checkRecorder>,
) {
  const sentences = items.map((each) => each.sentence);
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
  // What it wrote is checked after the reply (#2830): its check's end is the end.
  await writtenChecksEnd(core, asked.conversation.id, asked.answerId);
  const doneMs = recorder.since();
  stop();
  for (const watch of watches) watch.stop();
  return {
    checkStartMs: pageChangeMs ?? doneMs,
    doneMs,
    landed: watches.flatMap((watch) => watch.landed),
  };
}

/** Resolves once no check of what the Answer wrote still runs. */
async function writtenChecksEnd(core: Core, conversationId: string, answerId: string) {
  await vi.waitFor(
    async () => {
      const { messages } = await core.getConversation(conversationId);
      const found = messages.find((message) => message.id === answerId);
      if (found?.kind !== "answer") throw new Error("No Answer.");
      if (found.toolCalls.some((call) => call.mindChange?.selfCheck?.running))
        throw new Error("What it wrote is still being checked.");
    },
    { timeout: 10 * 60_000, interval: 100 },
  );
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
  recorder: ReturnType<typeof checkRecorder>,
  items: ReturnType<typeof CITED>,
) {
  const sentences = items.map((each) => each.sentence);
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

/** An Answer the model under test writes, judged once it ends. */
async function askedFlow(
  core: Core,
  choice: ChatModelChoice,
  recorder: ReturnType<typeof checkRecorder>,
  question: string,
) {
  recorder.begin([]);
  const asked = await core.askInConversation({ text: question, model: choice });
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  let endedMs: number | null = null;
  await answerEnds(core, asked.conversation.id, asked.answerId, (message) => {
    if (message.kind === "answer" && message.status !== "streaming") endedMs ??= recorder.since();
  });
  const doneMs = recorder.since();
  return { checkStartMs: endedMs ?? doneMs, doneMs, landed: [] };
}

/** The set's sentences from the `run`th Answer of `size` on, taking up after the last at the first. */
const windowOf = (all: ReturnType<typeof CITED>, size: number, run: number) =>
  Array.from({ length: size }, (_, at) => all[((run - 1) * size + at) % all.length]).filter(
    (each) => each !== undefined,
  );

/** The ids the judge listed, this run's or those of the run INCARNAMIND_EVAL_SPEED_JUDGED names. */
async function unstatedIdsFrom(
  judged: Record<string, string[] | null>,
): Promise<Set<string> | null> {
  const path = env("JUDGED");
  const read = path
    ? (JSON.parse(await readFile(path, "utf8")) as { unstated: Record<string, string[] | null> })
        .unstated
    : judged;
  const lists = Object.values(read);
  if (lists.length === 0 || lists.some((each) => each === null)) return null;
  return new Set(lists.flatMap((each) => each ?? []));
}

const wanted = list("CHECK_TIMES");
const timedChecks = wanted ? test : test.skip;

timedChecks("where a check's time goes, on each model and language", async () => {
  const log = createLog();
  const config = readConfig(ROOT);
  // A dry run sends nothing: its model is scripted (./dryRun), and its key a made-up one.
  const dryAs = env("DRY");
  const dry = dryAs !== null;
  if (dry && dryAs !== "1" && dryAs !== "yes")
    throw new Error(
      "INCARNAMIND_EVAL_SPEED_DRY: 1 checks by rote, yes calls everything Supported.",
    );
  const models = dry
    ? [{ kind: "anthropic" as const, modelId: "claude-haiku-5-5", apiKey: "sk-ant-dry-run" }]
    : modelsAsked();
  if (models.length === 0) throw new Error("Set INCARNAMIND_EVAL_SPEED_MODELS.");
  const dryModel = dry ? dryRunModel(dryAs === "yes" ? "yes" : "rote") : null;
  // #2532's gate: each pass runs on each check arm, the order turning from round to round.
  const checkArms = (list("CHECK_ARMS") ?? []).map((arm, at, all) => {
    const before = all.slice(0, at).filter((each) => each === arm).length;
    return before > 0 ? `${arm}#${before + 1}` : arm;
  });
  for (const arm of checkArms) {
    if (!arm.startsWith("main") && !arm.startsWith("search-first"))
      throw new Error(
        `INCARNAMIND_EVAL_SPEED_CHECK_ARMS: no arm "${arm}"; the arms are main and search-first.`,
      );
  }
  const rightMargin = env("RIGHT_MARGIN") === null ? null : Number(env("RIGHT_MARGIN"));
  let firstReplied: NonNullable<FlowTimes["firstReplied"]> = [];
  // Where the check's own search ranks each right sentence's stating Passages: `1`, then the run;
  // `only`, with no flow run at all.
  const ranksAsked = env("RANKS");
  const ranked: Ranked[] = [];
  const flows = wanted ?? [];
  const languages = (list("LANGUAGES") ?? ["en", "zh-CN"]) as Language[];
  const runs = Number(env("RUNS") ?? "2");
  // `1:24` asks 24 Answers of one sentence; a size alone asks RUNS of them.
  const answerSizes = (list("ANSWER_SENTENCES") ?? [null]).map((each) => {
    if (each === null) return { size: null, count: runs };
    const [size, count] = each.split(":").map(Number);
    return { size: size ?? null, count: count ?? runs };
  });
  // The second of two arms of one name is told apart as `<name>#2`.
  const arms = (list("ROOM_ARMS") ?? [null]).map((arm, at, all) => {
    const before = all.slice(0, at).filter((each) => each === arm).length;
    return arm && before > 0 ? `${arm}#${before + 1}` : arm;
  });
  const passesOf = (flow: string) =>
    (flow === "answer" ? answerSizes : [{ size: null, count: runs }])
      .flatMap(({ size, count }) =>
        Array.from({ length: count }, (_, at) => ({
          size,
          run: roundFrom + at,
          runs: roundFrom + count - 1,
        })),
      )
      .flatMap((pass, pair) => {
        const asked = flow === "answer" ? arms : [null];
        return asked.map((_, at) => ({ ...pass, arm: asked[(at + pair) % asked.length] ?? null }));
      })
      // The order turns with the round's own number, so rounds run apart take turns as one run would.
      .flatMap((pass) =>
        checkArms.length === 0
          ? [{ ...pass, checkArm: null }]
          : checkArms.map((_, at) => ({
              ...pass,
              checkArm: checkArms[(at + pass.run - 1) % checkArms.length] ?? null,
            })),
      );
  const stopUsd = Number(env("STOP_USD") ?? "3");
  const recorder = checkRecorder();
  let current: {
    flow: string;
    items: ReturnType<typeof CITED>;
    arm?: string;
    checkArm?: string;
  } | null = null;
  // A gate's later rounds run apart from its priced first: they number on from it, and the report
  // reads its rounds with theirs.
  const roundFrom = Number(env("ROUND_FROM") ?? "1");
  const results: FlowTimes[] = [];
  for (const prior of list("PRIOR") ?? [])
    results.push(...(JSON.parse(await readFile(prior, "utf8")) as FlowTimes[]));
  const judge = env("ANSWER_SET") === "room" && env("JUDGE") ? judgeOf(models) : null;
  const judged: Record<string, string[] | null> = {};
  const unstatedIds = () => unstatedIdsFrom(judged);
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
    const gating = flows.includes("asked") ? loadEvaluationSet(ROOT) : null;
    if (gating) documents.push(...gating.documents);
    const questions = (gating?.questions ?? []).filter(
      (each) => each.language === (language === "en" ? "en" : "zh"),
    );
    if (judge) {
      const items = CITED(language);
      const listed = await unstatedSentences(
        judge.model,
        items.map((item, at) => ({ at, sentence: item.sentence, quote: item.quote, found: true })),
      );
      judged[language] =
        listed?.flatMap(({ sentence }) =>
          items.filter((item) => item.sentence === sentence).map((item) => item.id),
        ) ?? null;
    }
    for (const document of env("ANSWER_SET") === "room" ? ROOM_DOCUMENTS : HELD_OUT_DOCUMENTS) {
      if (document.language !== language || !document.libraries.includes("terms")) continue;
      const path = join(folder, document.file);
      await writeFile(path, buildPdf(document.pages));
      documents.push({ key: document.file, path });
    }
    if (flows.includes("note-held")) {
      for (const document of SEARCH_FIRST_DOCUMENTS) {
        if (!document.libraries.includes(language)) continue;
        const path = join(folder, document.file);
        await writeFile(path, document.csv ?? buildPdf(document.pages ?? []));
        documents.push({ key: document.file, path });
      }
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
      chatModels: dryModel
        ? () => scripted(recorder.chatModels, () => current)(() => dryModel)
        : scripted(recorder.chatModels, () => current),
      examples: join(ROOT, "resources", "examples"),
      checkPaths: {
        searchFirst: () =>
          current?.checkArm === undefined ? undefined : current.checkArm.startsWith("search-first"),
        firstReplied: (heard) => firstReplied.push(heard),
      },
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
      if (ranksAsked) ranked.push(...(await ranksOf(core, language, ranksAsked === "candidates")));
      matrix: for (const model of ranksAsked === "only" || ranksAsked === "candidates"
        ? []
        : models) {
        const name = `${model.kind}/${model.modelId}`;
        const saved = await core.saveChatProvider(model);
        const choice: ChatModelChoice = { providerId: saved.id, modelId: model.modelId };
        for (const flow of flows) {
          for (const [at, { size, run, runs, arm, checkArm }] of passesOf(flow).entries()) {
            const spent = await spentUsd(core);
            if (spentBefore + spent >= stopUsd) {
              stopped = `Stopped at $${(spentBefore + spent).toFixed(2)}, before ${name} · ${flow} · ${language} · ${run}.`;
              log(stopped);
              break matrix;
            }
            // The core refuses any request past the stop, so a run never passes it between rounds.
            await core.updateSettings({
              user: {
                monthlyCap: { currency: "USD", amount: Math.max(0, stopUsd - spentBefore) },
              },
            });
            // A batch is a round of the arms: its key must have room for it before it starts.
            if (!dry && checkArm && at % Math.max(1, checkArms.length) === 0) {
              const left = await allowanceLeft(
                model.kind,
                model.apiKey ?? "",
                model.modelId,
                model.endpoint ?? null,
              );
              log(`  allowance before the round: ${left ? left.detail : "not stated"}`);
              if (left && left.share <= 0.9) {
                stopped = `Stopped before ${name} · ${flow} · ${language} · ${run}: the key's allowance was at ${(left.share * 100).toFixed(0)}%.`;
                log(stopped);
                break matrix;
              }
            }
            const load = loadavg()[0] ?? 0;
            const load15 = loadavg()[2] ?? 0;
            log(
              `${name} · ${flow}${size ? ` of ${size}` : ""}${arm ? ` · ${arm}` : ""}${checkArm ? ` · ${checkArm}` : ""} · ${language} · ${run}/${runs} · load ${load.toFixed(1)}, ${load15.toFixed(1)} over 15 minutes`,
            );
            const items = flow.startsWith("write")
              ? itemsOf(flow, language)
              : size
                ? windowOf(CITED(language), size, run)
                : CITED(language);
            current = { flow, items, ...(arm && { arm }), ...(checkArm && { checkArm }) };
            firstReplied = [];
            const startedAt = new Date().toISOString();
            repeats.begin();
            const times: Pick<
              FlowTimes,
              "checkStartMs" | "firstSignMs" | "doneMs" | "landed" | "searchedDuring" | "anomalies"
            > =
              flow === "note" || flow === "note-held"
                ? await noteFlow(
                    core,
                    choice,
                    noteSentences(flow, language),
                    recorder,
                    `Note check ${flow} ${run}${checkArm ? ` ${checkArm}` : ""}`,
                  )
                : flow.startsWith("write")
                  ? await writeFlow(core, choice, items, recorder)
                  : flow === "asked"
                    ? await askedFlow(core, choice, recorder, questions[run - 1]?.question ?? "")
                    : await answerFlow(core, choice, recorder, items);
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
            const requests = recorder.end();
            const failedRequest = requests.find((request) => request.error !== null);
            const failedMark = landed.find((each) => each.reason && VOIDING.has(each.reason));
            const voided = failedRequest
              ? `a ${failedRequest.kind} request failed`
              : failedMark
                ? `a sentence was not checked: ${failedMark.reason}`
                : null;
            if (voided) log(`  void: ${voided}`);
            results.push({
              flow,
              model: name,
              language,
              run,
              ...(size && { answerSentences: size }),
              ...(arm && { arm }),
              ...(checkArm && { checkArm }),
              ...(voided && { voided }),
              ...(times.anomalies && { anomalies: times.anomalies }),
              ...(checkArm && { firstReplied }),
              ...(flow === "note-held" && {
                stated: HELD_NOTE(language).map((each) => each.kind === "right"),
                items: HELD_NOTE(language).map((each) => ({
                  id: each.id,
                  kind: each.kind,
                  writer: each.writer,
                  lowRank: each.keptAt !== undefined,
                  figure: /\p{N}/u.test(each.sentence),
                })),
              }),
              load,
              load15,
              checkStartMs: times.checkStartMs,
              ...(times.firstSignMs !== undefined && { firstSignMs: times.firstSignMs }),
              firstMarkMs: landed[0]?.ms ?? null,
              firstVerdictMs: firstVerdictMs(landed),
              doneMs: times.doneMs,
              landed,
              requests,
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
    ["note-held", HELD_NOTE("en").length],
    ["write", 30],
    ["write-mixed", 20],
    ["writes", 30],
    ["answer", 30],
  ]);
  const report = [
    "# Where a check's time goes",
    "",
    `${new Date().toISOString()} · ${runs} runs a flow, model and language · seconds from the User's action, medians. Spent $${spentBefore.toFixed(3)}.${stopped ? ` ${stopped}` : ""}`,
    "",
    checkTimesReport(results, counts),
    ...(ranked.length > 0 ? ["", ranksSection(ranked)] : []),
    ...(checkArms.length > 0
      ? [
          "",
          searchFirstGateSection(
            results,
            (flow, language) =>
              flow === "note" || flow === "note-held"
                ? noteSentences(flow, language as Language)
                : itemsOf(flow, language as Language).map((each) => each.sentence),
            rightMargin,
          ),
        ]
      : []),
    ...(dry
      ? [
          "",
          "A dry run: its model was scripted, nothing left this computer, and its spend is the catalog's price of made-up token counts.",
        ]
      : []),
    ...(arms[0]
      ? [
          "",
          roomGateSection(results, (language) => CITED(language as Language), await unstatedIds()),
        ]
      : []),
  ].join("\n");
  console.log(report);
  const out = join(
    config.resultsDir,
    `check-times-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.md"), report);
  await writeFile(join(out, "report.json"), JSON.stringify(results, null, 2));
  if (ranked.length > 0) await writeFile(join(out, "ranks.json"), JSON.stringify(ranked, null, 2));
  if (judge) {
    await writeFile(
      join(out, "judged.json"),
      JSON.stringify({ judge: judge.name, spentUsd: judge.spent(), unstated: judged }, null, 2),
    );
  }
  log(`Report in ${out}`);
});
