/**
 * Citation quality: each Question asked through the core with a real chat
 * model, in a Mind of its own, and each Answer's Citations read back from the
 * Mind, as the editor shows them.
 *
 * For every Citation the core's check result is kept ("found" or why not),
 * and each "not found" quote is looked for again under a looser
 * normalisation, to tell the check's misses (the quote is on the cited
 * pages) from wrong pages and from quotes that aren't in the Document.
 */
import { randomUUID } from "node:crypto";
import { getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  ANSWER_BLOCK,
  type AnswerFinished,
  type AnswerUsage,
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type CitationAttributes,
  type CitationCheck,
  type CitationCheckReason,
  type CitationSupport,
  type Core,
  createOllamaModels,
  MIND_CONTENT_FIELD,
  type OllamaModels,
  type ProviderError,
  QUESTION_BLOCK,
  type QuoteRetry,
  type RejectedRecord,
} from "../../src/core";
import { outputTokensFor } from "../../src/core/providers/ollamaModels";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { SIMPLIFIED } from "../../src/shared/hanVariants";
import { normaliseText } from "../../src/shared/text";
import { type ChatSettings, chatProviderOf, type EvalConfig } from "./config";
import { type EvalLanguage, type EvalQuestion, isGating } from "./evaluationSet";
import { type ExpectedCounts, expectedCounts, type HandedSummary, summariseHanded } from "./handed";
import type { Library } from "./library";
import type { Log } from "./log";
import { type AnswerTiming, median, summariseTiming, type TimingSummary, timingOf } from "./timing";

/** The v1 design's targets, per language, over at least `EvalConfig.minCitations` Citations. */
export const CITATION_TARGETS = {
  /** At least this share of Citations show "Quote found". */
  found: 0.9,
  /** At most this share of Citations show "not found" for a quote that is on the cited pages. */
  falseNotFound: 0.05,
  /** At least this share of "found" quotes support their sentence, as a reviewer judges (the sheet). */
  supports: 0.8,
} as const;

/**
 * What became of a Citation:
 * - "found": the check found the quote on the cited pages;
 * - "false-not-found": "not found", yet the quote is on the cited pages under the looser normalisation;
 * - "wrong-page": "not found", and the quote is on other pages of the Document;
 * - "not-in-document": "not found", and the quote isn't in the Document at all (e.g. paraphrased);
 * - "page-range": "not found" because the cited pages break the page-range rule;
 * - "cant-check": the cited pages have no text.
 */
export type CitationOutcome =
  | "found"
  | "false-not-found"
  | "wrong-page"
  | "not-in-document"
  | "page-range"
  | "cant-check";

export const CITATION_OUTCOMES: readonly CitationOutcome[] = [
  "found",
  "false-not-found",
  "wrong-page",
  "not-in-document",
  "page-range",
  "cant-check",
];

export interface CitationRecord {
  /** The sentence of the Answer the Citation is anchored in, without its Citations. */
  sentence: string;
  quote: string;
  documentName: string;
  pageFrom: number | null;
  pageTo: number | null;
  check: CitationCheck;
  checkReason: CitationCheckReason | null;
  outcome: CitationOutcome;
  /** The pages (Units) of the Passage the Citation names; null when unknown. */
  passagePages: [number, number] | null;
  /**
   * Where the quote is in its Document under the looser normalisation: the
   * first page (Unit) that holds it, or two consecutive ones; null when it
   * isn't there, e.g. paraphrased (see `quotePages`).
   */
  quoteOn: [number, number] | null;
}

export interface AnswerRecord {
  questionId: string;
  language: EvalLanguage;
  crossLingual: boolean;
  /** Answers a paraphrase Question: a group of its own, never gating. */
  paraphrase?: boolean;
  round: number;
  question: string;
  status: "done" | "stopped" | "failed" | "timed-out";
  error: ProviderError | null;
  citationSupport: CitationSupport | null;
  /** What the model searched for. */
  searches: string[];
  droppedMarkers: number;
  droppedRecords: number;
  /** The records the core couldn't take, as the model gave them, and why. */
  rejectedRecords: RejectedRecord[];
  /**
   * The one request for exact quotes a local model in structured output
   * makes when the check doesn't find some of its quotes (ADR-0007): how many
   * records it asked about, how many it recovered, how long it took. Null or
   * absent: none was made.
   */
  quoteRetry?: QuoteRetry | null;
  /**
   * Citations the engine added for sentences written without markers (#760),
   * and whether the model was asked once more for them; absent in a result
   * file from before.
   */
  citedAfterChecking?: { count: number; asked: boolean } | null;
  /** The tokens the Answer's model calls counted (#343); absent in a result file from before. */
  usage?: AnswerUsage | null;
  /** Where the Answer's time went; absent without a recording (a result file from before, or no chat model). */
  timing?: AnswerTiming | null;
  /**
   * Of the Passages the Question needs: how many there are, how many a search
   * handed the model, how many the Answer cites with a found Citation. Null:
   * it needs none (unanswerable); absent without a recording.
   */
  expected?: ExpectedCounts | null;
  /** The Answer's full text, a block to a paragraph, each Citation as its marker ("[^1]"). */
  text: string;
  /**
   * Set only for an unanswerable Question: whether the phrase rule (./declines)
   * found the Answer saying the Documents don't answer it. A reviewer marks
   * the declines it missed on the sheet.
   */
  declines?: boolean;
  /** Each sentence of the Answer (headings and code left out), and whether a Citation is anchored in it. */
  sentences: { text: string; cited: boolean }[];
  citations: CitationRecord[];
  seconds: number;
}

/** "en" and "zh" are the gating Questions in each language; "crossLingual" and "paraphrase" the rest. */
export type CitationGroup = "en" | "zh" | "crossLingual" | "paraphrase";

export interface GroupSummary {
  answers: number;
  /** Answers that failed or timed out. */
  failedAnswers: number;
  /** Answers with at least one Citation. */
  citedAnswers: number;
  /** Share of Answers with at least one Citation; null without Answers. */
  citedAnswerShare: number | null;
  /** The median time an Answer took, in seconds; null without Answers. */
  medianSeconds: number | null;
  citations: number;
  outcomes: Record<CitationOutcome, number>;
  /** Share of Citations showing "Quote found"; null without Citations. */
  foundShare: number | null;
  /** Share of Citations that are "false-not-found"; null without Citations. */
  falseNotFoundShare: number | null;
  sentences: number;
  citedSentences: number;
  /** Share of sentences with a Citation; null without sentences. */
  coverage: number | null;
  droppedMarkers: number;
  droppedRecords: number;
  citationSupport: Partial<Record<CitationSupport | "unknown", number>>;
  /** What the requests for exact quotes cost and gave (see `AnswerRecord.quoteRetry`). */
  quoteRetries: QuoteRetrySummary;
  /** The tokens the group's Answers used and the share of the input the provider's prompt cache served. */
  usage: UsageSummary;
  /** Where the group's time went; null without recorded Answers (absent in a report from before). */
  timing?: TimingSummary | null;
  /** Whether searches handed the model the Passages the Questions need, beside whether the Answers cite them. */
  handed?: HandedSummary | null;
}

/** The tokens a group of Answers used (see `AnswerUsage`). */
export interface UsageSummary extends AnswerUsage {
  /** Cached input tokens over all input tokens; null when the provider reported no input tokens. */
  cacheHitRate: number | null;
}

/** The requests for exact quotes of a group of Answers. */
export interface QuoteRetrySummary {
  /** Answers that made one. */
  answers: number;
  /** Records they asked about. */
  records: number;
  /** Of those, records whose new quote the check found. */
  recovered: number;
  /** The time a request added to an Answer that made one, in seconds: the median and the most; null without any. */
  medianSeconds: number | null;
  maxSeconds: number | null;
  /** The time they added, in seconds, per Answer of the group, whether it made one or not; null without Answers. */
  secondsPerAnswer: number | null;
}

export interface CitationRun {
  /** e.g. "anthropic/claude-sonnet-4-6". */
  model: string;
  /** Where Questions went, e.g. "Anthropic"; null for a model on this computer. */
  service: string | null;
  /**
   * A cloud model gates; a model on this computer (Ollama) is only reported,
   * and so is a run that asked only some Questions (`subset`).
   */
  gating: boolean;
  /**
   * The ids of the Questions asked, when the run asked only some
   * (INCARNAMIND_EVAL_QUESTIONS): a short check, never gating. Null: all.
   */
  subset: string[] | null;
  /** What the run set instead of the app's choice ("ollama" only), e.g. "num_ctx 8192"; empty for none. */
  overrides: string[];
  minCitations: number;
  rounds: number;
  answers: AnswerRecord[];
  summary: Record<CitationGroup, GroupSummary>;
  /** Why the gating targets are missed; empty when met (or when not gating). */
  failures: string[];
}

/** The schema of the renderer's editor, to read Answers the way it shows them. */
const mindSchema = getSchema(noteExtensions());

/** Stands for a Citation in an Answer's text while it is split into sentences (a private-use character). */
const MARK = "\uE000";
const HAS_WORD = /[\p{L}\p{N}]/u;
const LEADING_MARKS = new RegExp(`^[\\s${MARK}]*`, "u");

const count = (text: string, character: string) => text.split(character).length - 1;

/**
 * Splits one text block of an Answer into sentences, each with the Citations
 * anchored in it (`text` holds a MARK for each, in order). A Citation placed
 * just after a sentence's full stop counts for that sentence.
 */
export function sentencesOf<T>(
  text: string,
  citations: readonly T[],
  language: string,
): { text: string; citations: T[] }[] {
  const sentences: { text: string; citations: T[] }[] = [];
  let next = 0;
  let carried: T[] = [];
  for (const { segment } of new Intl.Segmenter(language, { granularity: "sentence" }).segment(
    text,
  )) {
    const marks = citations.slice(next, next + count(segment, MARK));
    next += marks.length;
    const words = segment.replaceAll(MARK, "").replace(/\s+/g, " ").trim();
    const previous = sentences.at(-1);
    if (!HAS_WORD.test(words)) {
      if (previous) previous.citations.push(...marks);
      else carried.push(...marks);
      continue;
    }
    const leading = count(segment.match(LEADING_MARKS)?.[0] ?? "", MARK);
    if (previous && leading > 0) previous.citations.push(...marks.splice(0, leading));
    sentences.push({ text: words, citations: [...carried, ...marks] });
    carried = [];
  }
  return sentences;
}

/** The Answer's sentences, with the Citations anchored in each. Headings and code are left out. */
function answerSentences(
  answer: ProseMirrorNode,
  language: string,
): { text: string; citations: CitationAttributes[] }[] {
  const sentences: { text: string; citations: CitationAttributes[] }[] = [];
  answer.descendants((node) => {
    if (!node.isTextblock) return true;
    if (node.type.name === "heading" || node.type.name === "codeBlock") return false;
    let text = "";
    const citations: CitationAttributes[] = [];
    node.forEach((child) => {
      if (child.isText) text += child.text ?? "";
      else if (child.type.name === CITATION_NODE) {
        text += MARK;
        citations.push(child.attrs as CitationAttributes);
      } else text += " ";
    });
    sentences.push(...sentencesOf(text, citations, language));
    return false;
  });
  return sentences;
}

/** The Answer's text as the editor shows it: a paragraph per block, a Citation as its marker, in order. */
function answerText(answer: ProseMirrorNode): string {
  const blocks: string[] = [];
  let marker = 0;
  answer.descendants((node) => {
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child) => {
      if (child.isText) text += child.text ?? "";
      else if (child.type.name === CITATION_NODE) text += `[^${++marker}]`;
      else text += " ";
    });
    blocks.push(text.trim());
    return false;
  });
  return blocks.filter(Boolean).join("\n\n");
}

/** An f-ligature's letters: "ffi", "ffl", "ff", "fi" or "fl". */
const F_LIGATURE = /f(?:f[il]?|[il])/g;

/**
 * The looser normalisation: the shared one, then accents dropped, lower case,
 * and only letters and digits kept, so punctuation, spacing, hyphens and
 * quote marks can't stop a match. An f-ligature's letters are read as one
 * "f" too: some PDFs' text lost the letters after it, so a page shows
 * "finance" where its stored text reads "fnance" (Vantrell's ESG report),
 * and a quote of the page as it shows is still on it.
 */
function looseText(text: string): string {
  let loose = [
    ...normaliseText(text)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, ""),
  ]
    // As the check reads them: traditional Chinese characters as simplified ones.
    .map((char) => SIMPLIFIED.get(char) ?? char)
    .join("");
  // Until nothing changes: "fifty" reads "ffty", then "fty", as a lost ligature's "ffty" does.
  for (let before = ""; before !== loose; ) {
    before = loose;
    loose = loose.replace(F_LIGATURE, "f");
  }
  return loose;
}

type PageText = { page: number | null; text: string };

/** What became of a Citation (see `CitationOutcome`), given its Document's stored pages. */
export function outcomeOf(
  citation: Pick<CitationAttributes, "check" | "checkReason" | "quote" | "pageFrom" | "pageTo">,
  pages: readonly PageText[],
): CitationOutcome {
  if (citation.check === "found") return "found";
  if (citation.check !== "not-found") return "cant-check";
  if (citation.checkReason === "pages-outside-passage" || citation.checkReason === "too-many-pages")
    return "page-range";
  const quote = looseText(citation.quote ?? "");
  if (!quote) return "not-in-document";
  const { pageFrom, pageTo } = citation;
  const cited = pages.filter(
    ({ page }) =>
      pageFrom === null || pageTo === null || (page !== null && page >= pageFrom && page <= pageTo),
  );
  const onPages = (some: readonly PageText[]) =>
    looseText(some.map((page) => page.text).join("\n")).includes(quote);
  if (onPages(cited)) return "false-not-found";
  return onPages(pages) ? "wrong-page" : "not-in-document";
}

/** Each Document's pages under the looser normalisation, by the array `pageTexts` gave. */
const loosePagesOf = new WeakMap<readonly PageText[], { page: number | null; text: string }[]>();

/**
 * Where a quote is in its Document's stored pages under the looser
 * normalisation: the first page (Unit) that holds it, or else the first two
 * consecutive ones; null when it isn't there, e.g. paraphrased.
 */
export function quotePages(quote: string, pages: readonly PageText[]): [number, number] | null {
  const needle = looseText(quote);
  if (!needle) return null;
  let loose = loosePagesOf.get(pages);
  if (!loose) {
    loose = pages.map(({ page, text }) => ({ page, text: looseText(text) }));
    loosePagesOf.set(pages, loose);
  }
  for (const { page, text } of loose) {
    if (page !== null && text.includes(needle)) return [page, page];
  }
  for (let index = 0; index + 1 < loose.length; index++) {
    const first = loose[index] as PageText;
    const second = loose[index + 1] as PageText;
    if (first.page === null || second.page !== first.page + 1) continue;
    if (`${first.text}${second.text}`.includes(needle)) return [first.page, second.page];
  }
  return null;
}

const OUTCOME_WORDS: Record<CitationOutcome, string> = {
  found: "found",
  "false-not-found": 'false "not found"',
  "wrong-page": "wrong page",
  "not-in-document": "not in the Document",
  "page-range": "breaks the page-range rule",
  "cant-check": "can't check",
};

/** "p. 4" or "pp. 4–5" ("Unit 4", "Units 4–5" for any format); "–" for none. */
export function pagesLabel(range: readonly [number, number] | null, unit: "p." | "Unit"): string {
  if (!range) return "–";
  const [from, to] = range;
  const plural = from !== to;
  const span = plural ? `${from}–${to}` : `${from}`;
  return unit === "p."
    ? `${plural ? "pp." : "p."} ${span}`
    : `${plural ? "Units" : "Unit"} ${span}`;
}

/** A quote on one line, cut short. */
export const shortQuote = (quote: string, length = 160) => {
  const line = quote.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

/**
 * Why a Citation isn't "found", in a line: what the check said, the pages it
 * cites and its Passage's, where the quote is, and the quote. `unit` names
 * what the pages are: "p." for PDFs, "Unit" for any format.
 */
export function citationLine(citation: CitationRecord, unit: "p." | "Unit" = "p."): string {
  const cited =
    citation.pageFrom === null
      ? "the whole Document"
      : pagesLabel([citation.pageFrom, citation.pageTo ?? citation.pageFrom], unit);
  const reason = citation.checkReason ? ` (${citation.checkReason})` : "";
  const on = citation.quoteOn
    ? `the quote is on ${pagesLabel(citation.quoteOn, unit)}`
    : "the quote isn't in the Document";
  return `${OUTCOME_WORDS[citation.outcome]}${reason}: ${citation.documentName}, cites ${cited} of a Passage on ${pagesLabel(citation.passagePages, unit)}; ${on}: "${shortQuote(citation.quote)}"`;
}

/** The records the core couldn't take, as given: '[^1] "Vantrell…" (no such Passage)'. */
export function rejectedLine(records: readonly RejectedRecord[]): string {
  return records
    .map(
      (record) =>
        `${record.marker === null ? "[^?]" : `[^${record.marker}]`} "${shortQuote(record.passage, 60)}" (${record.reason === "marker" ? "no marker number" : "no such Passage"})`,
    )
    .join(", ");
}

/** Why an Answer has no Citation, in a line: how it cited, what was dropped, and how it begins. */
export function uncitedLine(answer: AnswerRecord): string {
  const begins = answer.sentences[0]?.text;
  return [
    `${answer.status}, ${answer.citationSupport ?? "unknown"}`,
    `${answer.droppedMarkers} markers without records removed, ${answer.droppedRecords} records dropped`,
    ...(answer.rejectedRecords.length > 0
      ? [`rejected: ${rejectedLine(answer.rejectedRecords)}`]
      : []),
    ...(answer.error ? [`${answer.error.kind}: ${answer.error.message}`] : []),
    begins ? `begins "${shortQuote(begins, 120)}"` : "no text",
  ].join("; ");
}

/**
 * "ollama" only: the app's lookup of models in Ollama, with the window and
 * the citing mode the run asks for (`ChatSettings.numCtx` and `citing`)
 * instead of the app's choice; the output cap follows the window, as in the
 * app. Null when the run asks for neither.
 */
export function evalOllamaModels(
  chat: ChatSettings | null,
  models: OllamaModels = createOllamaModels(),
): OllamaModels | null {
  if (!chat || (chat.numCtx === null && chat.citing === null)) return null;
  const { numCtx, citing } = chat;
  return {
    async describe(baseUrl, model) {
      const profile = await models.describe(baseUrl, model);
      if (!profile) return null;
      return {
        ...profile,
        ...(citing !== null && { support: citing }),
        ...(numCtx !== null && {
          settings: {
            ...profile.settings,
            numCtx,
            outputTokens: outputTokensFor(numCtx, profile.settings.think),
          },
        }),
      };
    },
    loaded: (baseUrl, model, numCtx) => models.loaded(baseUrl, model, numCtx),
    running: (baseUrl) => models.running(baseUrl),
  };
}

/** Writes a Question into the Mind, as the editor would store it, through the public interface. */
async function writeQuestion(core: Core, mindId: string, id: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await core.openMind(mindId)).state);
  const before = Y.encodeStateVector(doc);
  const question = new Y.XmlElement(QUESTION_BLOCK);
  question.setAttribute(BLOCK_ID_ATTRIBUTE, id);
  question.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([question]);
  await core.applyMindUpdate(mindId, Y.encodeStateAsUpdate(doc, before));
  doc.destroy();
}

/** The Answer as the editor reads it from the Mind. */
async function readAnswer(
  core: Core,
  mindId: string,
  answerId: string,
): Promise<ProseMirrorNode | null> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await core.openMind(mindId)).state);
  const root = yXmlFragmentToProseMirrorRootNode(
    doc.getXmlFragment(MIND_CONTENT_FIELD),
    mindSchema,
  );
  doc.destroy();
  let found: ProseMirrorNode | null = null;
  root.forEach((block) => {
    if (block.type.name === ANSWER_BLOCK && block.attrs[BLOCK_ID_ATTRIBUTE] === answerId) {
      found = block;
    }
  });
  return found;
}

type Ending = { finished: AnswerFinished } | { failed: ProviderError };

/** Asks one Question in a new Mind and reads its Answer back. */
export async function askOne(
  library: Library,
  question: EvalQuestion,
  round: number,
  timeoutMs: number,
): Promise<AnswerRecord> {
  const { core } = library;
  const started = Date.now();
  const mind = await core.createMind({ title: `Evaluation ${question.id}, round ${round}` });
  const questionId = randomUUID();
  await writeQuestion(core, mind.id, questionId, question.question);

  const searches: string[] = [];
  const ended = new Promise<Ending>((resolve) => {
    const stops = [
      core.on("answer.finished", (event) => {
        if (event.mindId !== mind.id) return;
        for (const stop of stops) stop();
        resolve({ finished: event });
      }),
      core.on("answer.failed", (event) => {
        if (event.mindId !== mind.id) return;
        for (const stop of stops) stop();
        resolve({ failed: event.error });
      }),
      core.on("answer.toolCallStarted", (event) => {
        const query = event.call.input.query;
        if (event.mindId === mind.id && typeof query === "string") searches.push(query);
      }),
    ];
  });
  library.timings?.begin();
  const askedAt = performance.now();
  const asked = await core.askQuestion({ mindId: mind.id, questionId });
  if (!asked.asked) {
    throw new Error(`${question.id} couldn't be asked: ${JSON.stringify(asked)}`);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void core.stopAnswer({ mindId: mind.id, answerId: asked.answerId });
  }, timeoutMs);
  const ending = await ended;
  clearTimeout(timer);
  const totalMs = performance.now() - askedAt;
  const recording = library.timings?.end();

  const answer = await readAnswer(core, mind.id, asked.answerId);
  await core.closeMind(mind.id);
  const sentences = answer ? answerSentences(answer, question.language) : [];
  const citations = sentences.flatMap((sentence) =>
    sentence.citations.map((citation): CitationRecord => {
      const pages = citation.documentId ? library.pageTexts(citation.documentId) : [];
      const checked = {
        quote: citation.quote ?? "",
        pageFrom: citation.pageFrom ?? null,
        pageTo: citation.pageTo ?? null,
        check: citation.check,
        checkReason: citation.checkReason ?? null,
      };
      return {
        sentence: sentence.text,
        documentName: citation.documentName ?? "",
        ...checked,
        outcome: outcomeOf(checked, pages),
        passagePages: citation.passageId ? library.passagePages(citation.passageId) : null,
        quoteOn: quotePages(checked.quote, pages),
      };
    }),
  );
  const finished = "finished" in ending ? ending.finished : null;
  const text = answer ? answerText(answer) : "";
  return {
    questionId: question.id,
    language: question.language,
    crossLingual: question.crossLingual,
    ...(question.paraphrase && { paraphrase: true }),
    round,
    question: question.question,
    status: timedOut ? "timed-out" : (finished?.status ?? "failed"),
    error: "failed" in ending ? ending.failed : null,
    citationSupport: finished?.citationSupport ?? null,
    searches,
    droppedMarkers: finished?.droppedMarkers ?? 0,
    droppedRecords: finished?.droppedRecords ?? 0,
    rejectedRecords: finished?.rejectedRecords ?? [],
    quoteRetry: finished?.quoteRetry ?? null,
    citedAfterChecking: finished?.citedAfterChecking ?? null,
    usage: finished?.usage ?? null,
    ...(recording && {
      timing: timingOf(recording, totalMs, text),
      expected: expectedCounts(
        question,
        (key) => library.documents.get(key),
        recording.handed,
        citations,
      ),
    }),
    text,
    sentences: sentences.map((sentence) => ({
      text: sentence.text,
      cited: sentence.citations.length > 0,
    })),
    citations,
    seconds: (Date.now() - started) / 1000,
  };
}

const groupOf = (
  answer: Pick<AnswerRecord, "crossLingual" | "paraphrase" | "language">,
): CitationGroup =>
  answer.crossLingual ? "crossLingual" : answer.paraphrase ? "paraphrase" : answer.language;

const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** The tokens a group of Answers used, and how much of the input was served from the provider's cache. */
export function summariseUsage(answers: readonly AnswerRecord[]): UsageSummary {
  const total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  for (const { usage } of answers) {
    if (!usage) continue;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cachedInputTokens += usage.cachedInputTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
  }
  return { ...total, cacheHitRate: share(total.cachedInputTokens, total.inputTokens) };
}

/** What a group of Answers' requests for exact quotes cost and gave. */
export function summariseQuoteRetries(answers: readonly AnswerRecord[]): QuoteRetrySummary {
  const retries = answers.flatMap((answer) => (answer.quoteRetry ? [answer.quoteRetry] : []));
  const seconds = retries.map((retry) => retry.durationMs / 1000);
  const total = seconds.reduce((sum, each) => sum + each, 0);
  return {
    answers: retries.length,
    records: retries.reduce((sum, retry) => sum + retry.records, 0),
    recovered: retries.reduce((sum, retry) => sum + retry.recovered, 0),
    medianSeconds: median(seconds),
    maxSeconds: seconds.length > 0 ? Math.max(...seconds) : null,
    secondsPerAnswer: answers.length > 0 ? total / answers.length : null,
  };
}

/** The requests for exact quotes in a line: '2 Answers, 1 of 3 records recovered, 2.1 s median, 3.0 s most, 0.4 s per Answer'. */
export function quoteRetryLine(summary: QuoteRetrySummary): string {
  if (summary.answers === 0) return "none";
  const seconds = (value: number | null) => (value === null ? "–" : `${value.toFixed(1)} s`);
  return `${summary.answers} Answer${summary.answers === 1 ? "" : "s"}, ${summary.recovered} of ${summary.records} records recovered, ${seconds(summary.medianSeconds)} median, ${seconds(summary.maxSeconds)} most, ${seconds(summary.secondsPerAnswer)} per Answer`;
}

export function summariseGroup(answers: readonly AnswerRecord[]): GroupSummary {
  const citations = answers.flatMap((answer) => answer.citations);
  const outcomes = Object.fromEntries(CITATION_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    CitationOutcome,
    number
  >;
  for (const citation of citations) outcomes[citation.outcome]++;
  const sentences = answers.flatMap((answer) => answer.sentences);
  const cited = sentences.filter((sentence) => sentence.cited).length;
  const citedAnswers = answers.filter((answer) => answer.citations.length > 0).length;
  const citationSupport: GroupSummary["citationSupport"] = {};
  for (const answer of answers) {
    const key = answer.citationSupport ?? "unknown";
    citationSupport[key] = (citationSupport[key] ?? 0) + 1;
  }
  return {
    answers: answers.length,
    failedAnswers: answers.filter(
      (answer) => answer.status === "failed" || answer.status === "timed-out",
    ).length,
    citedAnswers,
    citedAnswerShare: share(citedAnswers, answers.length),
    medianSeconds: median(answers.map((answer) => answer.seconds)),
    citations: citations.length,
    outcomes,
    foundShare: share(outcomes.found, citations.length),
    falseNotFoundShare: share(outcomes["false-not-found"], citations.length),
    sentences: sentences.length,
    citedSentences: cited,
    coverage: share(cited, sentences.length),
    droppedMarkers: answers.reduce((sum, answer) => sum + answer.droppedMarkers, 0),
    droppedRecords: answers.reduce((sum, answer) => sum + answer.droppedRecords, 0),
    citationSupport,
    quoteRetries: summariseQuoteRetries(answers),
    usage: summariseUsage(answers),
    timing: summariseTiming(answers),
    handed: summariseHanded(answers),
  };
}

const percent = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(1)}%`);

/** Why a gating run misses the targets, per language. */
function citationFailures(
  summary: Record<CitationGroup, GroupSummary>,
  minCitations: number,
): string[] {
  const failures: string[] = [];
  for (const [group, label] of [
    ["en", "English"],
    ["zh", "Chinese"],
  ] as const) {
    const { citations, foundShare, falseNotFoundShare } = summary[group];
    if (citations < minCitations) {
      failures.push(`Citations, ${label}: only ${citations}, needs at least ${minCitations}.`);
    }
    if (foundShare === null || foundShare < CITATION_TARGETS.found) {
      failures.push(
        `Citations, ${label}: ${percent(foundShare)} show "Quote found", target ${percent(CITATION_TARGETS.found)}.`,
      );
    }
    if (falseNotFoundShare === null || falseNotFoundShare > CITATION_TARGETS.falseNotFound) {
      failures.push(
        `Citations, ${label}: ${percent(falseNotFoundShare)} false "not found", target at most ${percent(CITATION_TARGETS.falseNotFound)}.`,
      );
    }
  }
  return failures;
}

/**
 * The Questions to ask: those `ids` names (INCARNAMIND_EVAL_QUESTIONS), in
 * the set's order, or all of them when `ids` is null.
 */
export function questionsToAsk(
  questions: readonly EvalQuestion[],
  ids: readonly string[] | null,
): EvalQuestion[] {
  return ids === null ? [...questions] : questions.filter((question) => ids.includes(question.id));
}

/** Throws when an id names no Question of the sets the run asks from. */
export function checkQuestionIds(
  ids: readonly string[],
  sets: readonly (readonly EvalQuestion[])[],
): void {
  const known = new Set(sets.flatMap((questions) => questions.map((question) => question.id)));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `INCARNAMIND_EVAL_QUESTIONS names Questions that aren't in the evaluation sets this run asks from: ${unknown.join(", ")}.`,
    );
  }
}

/**
 * Sets up the chat model on the library's core and asks the evaluation's
 * Questions: every Question once, then more rounds of the gating Questions in
 * a language with too few Citations, up to `maxRounds`. With `questionIds`,
 * only those Questions, each once: a short check, which never gates.
 */
export async function runCitations(
  library: Library,
  questions: readonly EvalQuestion[],
  chat: ChatSettings,
  config: Pick<EvalConfig, "minCitations" | "maxRounds" | "answerTimeoutMs"> &
    Partial<Pick<EvalConfig, "questionIds" | "rerankDepth" | "maxPassages">>,
  log: Log,
  /** What the set's pages are, in the log: "p." for PDFs, "Unit" for any format. */
  unit: "p." | "Unit" = "p.",
): Promise<CitationRun> {
  const subset = config.questionIds ?? null;
  const asked = questionsToAsk(questions, subset);
  // More rounds only gather Citations for the gating targets, which a subset doesn't meet.
  const maxRounds = subset ? 1 : config.maxRounds;
  const { core } = library;
  // Setting the variables is the consent to send Questions and Passages to the chat
  // model. Automatic tagging would send Document excerpts as well, so it is declined.
  const stopConsent = core.on("consent.requested", (request) => {
    core
      .respondToConsent(request.requestId, request.flow.id === "chat")
      .catch((error: unknown) => console.error(error));
  });
  try {
    const provider = await core.saveChatProvider(chatProviderOf(chat));
    const model = `${chat.kind}/${chat.modelId}`;
    const searchOverrides = [
      ...(config.rerankDepth != null
        ? [config.rerankDepth === "off" ? "reranking off" : `rerank depth ${config.rerankDepth}`]
        : []),
      ...(config.maxPassages != null ? [`${config.maxPassages} Passages a search`] : []),
    ];
    // A run that changes the search Tool is a comparison, not the gate.
    const gating = provider.service !== null && subset === null && searchOverrides.length === 0;
    const overrides = [
      ...searchOverrides,
      ...(chat.numCtx !== null ? [`num_ctx ${chat.numCtx}`] : []),
      ...(chat.citing !== null ? [`citing mode "${chat.citing}"`] : []),
    ];
    const where = provider.service ? `, sent to ${provider.service.name}` : " (local, not gating)";
    log(
      `Asking with ${model}${where}${overrides.length > 0 ? `, ${overrides.join(", ")}` : ""}${subset ? `; asking only ${asked.map((question) => question.id).join(", ")}, once each (not gating)` : ""}`,
    );

    const answers: AnswerRecord[] = [];
    const citationsIn = (group: CitationGroup) =>
      answers
        .filter((answer) => groupOf(answer) === group)
        .reduce((sum, answer) => sum + answer.citations.length, 0);
    let rounds = 0;
    for (let round = 1; round <= maxRounds; round++) {
      const asking =
        round === 1
          ? asked
          : asked.filter(
              (question) =>
                isGating(question) && citationsIn(question.language) < config.minCitations,
            );
      if (asking.length === 0) break;
      rounds = round;
      for (const question of asking) {
        const answer = await askOne(library, question, round, config.answerTimeoutMs);
        answers.push(answer);
        const found = answer.citations.filter((citation) => citation.outcome === "found").length;
        const retry = answer.quoteRetry;
        log(
          `${question.id} (round ${round}): ${answer.status}, ${answer.citationSupport ?? "unknown"}, ${answer.citations.length} Citations, ${found} found, ${answer.seconds.toFixed(0)} s${retry ? `; quotes asked again: ${retry.recovered} of ${retry.records} recovered in ${(retry.durationMs / 1000).toFixed(1)} s` : ""}`,
        );
        // Why, as it happens, so a run stopped before its report still says.
        if (answer.citations.length === 0) log(`  no Citation: ${uncitedLine(answer)}`);
        else if (answer.rejectedRecords.length > 0) {
          log(`  records rejected: ${rejectedLine(answer.rejectedRecords)}`);
        }
        for (const citation of answer.citations) {
          if (citation.outcome !== "found") log(`  ${citationLine(citation, unit)}`);
        }
      }
    }

    const summary: Record<CitationGroup, GroupSummary> = {
      en: summariseGroup(answers.filter((answer) => groupOf(answer) === "en")),
      zh: summariseGroup(answers.filter((answer) => groupOf(answer) === "zh")),
      crossLingual: summariseGroup(answers.filter((answer) => groupOf(answer) === "crossLingual")),
      paraphrase: summariseGroup(answers.filter((answer) => groupOf(answer) === "paraphrase")),
    };
    return {
      model,
      service: provider.service?.name ?? null,
      gating,
      subset: subset ? asked.map((question) => question.id) : null,
      overrides,
      minCitations: config.minCitations,
      rounds,
      answers,
      summary,
      failures: gating ? citationFailures(summary, config.minCitations) : [],
    };
  } finally {
    stopConsent();
  }
}
