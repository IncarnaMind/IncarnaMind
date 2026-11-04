/**
 * The written check's fast paths (#1667): a sentence the assistant wrote with one Citation is
 * Supported without today's check when
 * - A: it is, word for word, the sentence its Citation quotes, at the Citation's Location, with
 *   no model at all; or
 * - C: the provider's quick-tasks model, shown the sentence, its paragraph, the quote and its
 *   Passage, answers a plain yes.
 *
 * Neither runs for a sentence another Document or period could contradict: one with a figure (a
 * court decision's citation has its numbers) or a record cite, one in a table's cell, one whose Citation's Document has
 * changed or is behind a wall, or one whose words another Document in the check's scope also
 * holds (an amendment, another edition), which today's check searches for. Everything else, and
 * anything but a plain yes, goes to today's check on the User's model.
 */
import { generateText } from "ai";
import { partWithResult, resultFromParts } from "../../../shared/claimParts";
import { SCALES, TENS, UNITS } from "../../../shared/numberWords";
import { sentenceSpans } from "../../../shared/sentences";
import { normaliseText } from "../../../shared/text";
import type { UnitText } from "../../../shared/units";
import type { Citation, CitationAttributes, ClaimCheckResult } from "../../api";
import type { CitationSource } from "../../documents";
import type { EvidenceScope } from "../../documents/evidence";
import type { PreparedChatModel } from "../../providers/chat";
import { outputTokens } from "../../providers/outputLimits";
import { recordCiteSpans } from "../../recordCites/parser";
import { inStep } from "../../timing/flows";
import { answerTemperature } from "../engine";

const HAN_NUMERALS = "〇零一二两三四五六七八九十百千万亿兆壹贰叁肆伍陆柒捌玖拾佰仟半双俩";
const NUMBER_WORDS = [...UNITS.keys(), ...TENS.keys(), ...SCALES.keys(), "hundred"];
const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";

// Only ever sends a sentence to today's check: a figure there is one an amendment, another
// period or another unit could contradict, and the copy test can't tell which.
const NUMBER = new RegExp(
  `\\p{N}|[${HAN_NUMERALS}]|\\b(?:${NUMBER_WORDS.join("|")}|half|twice|double|triple|dozen)\\b`,
  "iu",
);
// Capitalised only: "may" is a duty's word, "May" a month's.
const MONTH = new RegExp(`\\b(?:${MONTHS})\\b`, "u");

/** Whether `text` holds a figure, in digits, Chinese numerals or English words, or a month: if in doubt, it does. */
export const holdsFigure = (text: string): boolean => NUMBER.test(text) || MONTH.test(text);

const TERMINAL = /[.!?]["')\]]*$/u;

/** Text as the copy test compares it: as the Citation check does, and with no space beside a mark of punctuation. */
const comparable = (text: string) =>
  normaliseText(text).replace(/\s+(?=\p{P})|(?<=\p{P})\s+/gu, "");

/** A Location's text, its neighbouring Units on each side included so a sentence cut at a Unit's edge is whole. */
export interface LocationText {
  text: string;
  /** Where the Location's own Units are in `text`. */
  from: number;
  to: number;
  /** `text` starts where the Document does, so its first sentence isn't the end of one before it. */
  startsDocument: boolean;
}

/**
 * The Document's own sentence the last of `sentences` copies at its Location, or null. Each is
 * compared as the Citation check compares text (ADR-0009, `normaliseText`), so only spaces,
 * quotation marks, dashes and character forms may differ. The sentence must be a whole sentence
 * of the Document that holds the quote: one inside a longer sentence drops what the rest says. A
 * sentence after others in its paragraph must follow the Document's sentence by sentence, or what
 * its words refer to may not be what the Document's do.
 */
export function copiedSentence(
  sentences: readonly string[],
  quote: string,
  location: LocationText,
): string | null {
  const own = sentences.map(comparable);
  const target = own.at(-1);
  const quoted = comparable(quote);
  if (!target || !quoted || !TERMINAL.test(target)) return null;
  const text = location.text.replace(/[\r\n\u2028\u2029]/gu, " ");
  const spans = sentenceSpans(text);
  const read = spans.map((span) => comparable(text.slice(span.from, span.to)));
  // The first span may be the end of a sentence the text doesn't hold.
  const whole = (index: number) => index > 0 || location.startsDocument;
  for (const [index, span] of spans.entries()) {
    if (span.to <= location.from || span.from >= location.to) continue;
    if (!whole(index) || read[index] !== target || !read[index].includes(quoted)) continue;
    const before = own.slice(0, -1).reverse();
    const follows = before.every(
      (sentence, back) => whole(index - back - 1) && read[index - back - 1] === sentence,
    );
    if (follows) return text.slice(span.from, span.to).trim();
  }
  return null;
}

/** The Location of a Citation, its Units with one on each side; null when it can't be read as sentences. */
export function locationText(
  citation: Pick<CitationAttributes, "pageFrom" | "pageTo">,
  units: (from: number, to: number) => readonly UnitText[],
): LocationText | null {
  const { pageFrom, pageTo } = citation;
  if (pageFrom === null || pageTo === null || pageFrom < 1 || pageTo < pageFrom) return null;
  const read = units(Math.max(1, pageFrom - 1), pageTo + 1);
  // A sheet's rows are cells, not sentences.
  if (read.some((unit) => unit.kind === "rows")) return null;
  let text = "";
  let from = -1;
  let to = -1;
  for (const unit of read) {
    if (unit.page === null) return null;
    if (text) text += " ";
    if (unit.page === pageFrom) from = text.length;
    text += unit.text;
    if (unit.page === pageTo) to = text.length;
  }
  if (from < 0 || to < 0) return null;
  return { text, from, to, startsDocument: read[0]?.page === 1 };
}

/** Whether a sentence may take a fast path at all, read from its own words. */
export function mayTakeFastPath(claim: string, figures: number): boolean {
  return figures === 0 && !holdsFigure(claim) && recordCiteSpans(claim).length === 0;
}

export const QUICK_CHECK_INSTRUCTIONS = `You compare one sentence a writer wrote with the quote it cites from a Document. Reply with one word: yes or no.

Say yes only when the quote, read in its Passage, states everything the sentence says, so that a careful reader of the Document would accept the sentence as a faithful restatement of it.

Say no when anything differs or is missing, among them:
- who does it, and for or to whom: another party, or the parties the other way round;
- whether it must, may, should or must not happen;
- a condition, an exception or a limit that the quote or its Passage attaches and the sentence leaves out, or one the sentence adds;
- a negation, a time, a period, a place, an amount, a unit or a currency;
- a wider or narrower group, thing or scope than the Document's;
- what a word of the sentence refers to, read in its own paragraph, when that isn't what the quote's words refer to in the Passage.

When in doubt, say no.`;

const escaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function quickCheckPrompt(asked: QuickCheck): string {
  return [
    `<paragraph>${escaped(asked.paragraph)}</paragraph>`,
    `<sentence>${escaped(asked.sentence)}</sentence>`,
    `<document name="${escaped(asked.documentName).replaceAll('"', "&quot;")}">`,
    `<passage>${escaped(asked.passage)}</passage>`,
    `<quote>${escaped(asked.quote)}</quote>`,
    "</document>",
    "Does the quote, read in its Passage, state everything the sentence says? Reply yes or no.",
  ].join("\n");
}

export interface QuickCheck {
  /** The sentence's paragraph, for what its words refer to. */
  paragraph: string;
  sentence: string;
  documentName: string;
  passage: string;
  quote: string;
}

/** Whether the quick model's reply is a plain yes: anything else, a failure included, goes to today's check. */
export async function quickYes(
  prepared: PreparedChatModel,
  asked: QuickCheck,
  signal: AbortSignal,
): Promise<boolean> {
  // A reply that never comes, even once aborted, is given up on all the same.
  const givenUp = new Promise<never>((_, reject) => {
    const stop = () => reject(new Error("The quick model's first look was stopped."));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  try {
    const { text } = await Promise.race([
      inStep("written-quick-check", () =>
        generateText({
          model: prepared.model,
          instructions: QUICK_CHECK_INSTRUCTIONS,
          prompt: quickCheckPrompt(asked),
          temperature: answerTemperature(prepared.capabilities.facts.temperature),
          maxOutputTokens: outputTokens("quick-check"),
          maxRetries: 1,
          abortSignal: signal,
        }),
      ),
      givenUp,
    ]);
    return /^yes[.!]?$/iu.test(text.trim());
  } catch (error) {
    if (!signal.aborted) {
      console.warn(
        `The quick model's first look at a written sentence failed, so today's check reads it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return false;
  }
}

/** A Supported sentence's result from its own Citation, as today's check gives a one-fact sentence's. */
export function supportedByCitation(
  claim: string,
  source: CitationSource,
  citation: Pick<CitationAttributes, "pageFrom" | "pageTo" | "location"> & { quote: string },
  says: string,
): ClaimCheckResult {
  const evidence: Citation = {
    passageId: source.passageId,
    documentId: source.documentId,
    documentName: source.documentName,
    contentHash: source.contentHash,
    pageFrom: citation.pageFrom,
    pageTo: citation.pageTo,
    location: citation.location,
    quote: citation.quote,
    check: "found",
    checkReason: null,
  };
  const judged: ClaimCheckResult = {
    verdict: "supported",
    evidence,
    says,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [{ documentId: source.documentId, contentHash: source.contentHash }],
    excluded: [],
  };
  return resultFromParts([
    partWithResult({ kind: "fact", span: { start: 0, end: claim.length } }, judged),
  ]);
}

const UNCHECKED_OR_FOUND: ReadonlySet<CitationAttributes["check"] | undefined> = new Set([
  "found",
  "checking",
  "not-checked",
  undefined,
]);

/** Whether the Citation's Document may decide the sentence here: current, in scope, unwalled, readable. */
function citedHere(
  source: CitationSource | null,
  citation: Partial<CitationAttributes>,
  scope: EvidenceScope,
  { walled, versionNow }: Pick<FastPathDependencies, "walled" | "versionNow">,
): source is CitationSource {
  return (
    source !== null &&
    !source.documentDeleted &&
    !source.notCited &&
    source.yourNoteAt === null &&
    !citation.yourNoteAt &&
    UNCHECKED_OR_FOUND.has(citation.check) &&
    !citation.unsure?.length &&
    source.contentHash === citation.contentHash &&
    source.contentHash === versionNow(source.documentId) &&
    !walled(source.documentId) &&
    !scope.excluded.has(source.documentId) &&
    (scope.documentIds === null || scope.documentIds.includes(source.documentId))
  );
}

export interface FastPathDependencies {
  citationSource(passageId: string): CitationSource | null;
  pageTexts(documentId: string, contentHash: string, from: number, to: number): UnitText[];
  /** Whether a Passage of another Document in `scope` holds the sentence's key terms (../../documents). */
  othersHoldTerms(text: string, documentId: string, scope: EvidenceScope): boolean;
  /** Whether a Folder wall holds the Document: today's check says what a wall keeps out. */
  walled(documentId: string): boolean;
  /** The Document's version now; null once it's gone. */
  versionNow(documentId: string): string | null;
}

export interface FirstLook {
  claim: string;
  /** The figures the check reads in it. */
  figures: number;
  inCell: boolean;
  /** The sentences before it in its paragraph, as the Note reads them. */
  before: readonly string[];
  paragraph: string;
  citations: readonly Partial<CitationAttributes>[];
  scope: EvidenceScope;
  /** Whether the copy test may decide it (A). */
  copy: boolean;
  /** The quick model that may say yes to it (C); null: none. */
  quick: PreparedChatModel | null;
  signal: AbortSignal;
}

/** A Supported verdict given without today's check, with what gave it: null for the copy test, which uses no model. */
export interface FastVerdict {
  result: ClaimCheckResult;
  model: PreparedChatModel | null;
}

export function createFastPaths(deps: FastPathDependencies) {
  /** A Supported verdict for the sentence without today's check, or null: today's check reads it. */
  return async function firstLook(look: FirstLook): Promise<FastVerdict | null> {
    const [citation, ...more] = look.citations;
    if (!citation || more.length > 0 || look.inCell || (!look.copy && !look.quick)) return null;
    if (!mayTakeFastPath(look.claim, look.figures)) return null;
    const source = citation.passageId ? deps.citationSource(citation.passageId) : null;
    if (!citedHere(source, citation, look.scope, deps)) return null;
    const quote = citation.quote ?? "";
    const location = locationText(
      { pageFrom: citation.pageFrom ?? null, pageTo: citation.pageTo ?? null },
      (from, to) => deps.pageTexts(source.documentId, source.contentHash, from, to),
    );
    const onPage =
      location !== null &&
      comparable(location.text.slice(location.from, location.to)).includes(comparable(quote));
    if (!onPage || !quote.trim()) return null;
    if (deps.othersHoldTerms(look.claim, source.documentId, look.scope)) return null;
    const cited = {
      pageFrom: citation.pageFrom ?? null,
      pageTo: citation.pageTo ?? null,
      location: citation.location ?? null,
      quote,
    };
    const copied = look.copy ? copiedSentence([...look.before, look.claim], quote, location) : null;
    if (copied)
      return { result: supportedByCitation(look.claim, source, cited, copied), model: null };
    if (!look.quick || look.signal.aborted) return null;
    const yes = await quickYes(
      look.quick,
      {
        paragraph: look.paragraph,
        sentence: look.claim,
        documentName: source.documentName,
        passage: source.text,
        quote,
      },
      look.signal,
    );
    return yes
      ? { result: supportedByCitation(look.claim, source, cited, quote), model: look.quick }
      : null;
  };
}
