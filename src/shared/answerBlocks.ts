/**
 * An Answer of the assistant's conversations as Blocks (ADR-0017): the Markdown
 * the model wrote made into the node types of Notes, each Citation marker made
 * into its Citation and each figure marker into its calculated figure
 * (ADR-0021), its words AI text, exactly as an Answer written into a Mind
 * is made. The assistant shows them, Copy copies them and Add to note puts
 * them into a note.
 */

import { markdownToBlocks } from "../core/answers/markdown";
import { forPage } from "../core/answers/pointersBack";
import {
  type AnswerAnalysis,
  CALCULATED_FIGURE_NODE,
  type CalculatedFigure,
  type CheckedVersion,
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimVerdict,
  type ConversationAnswer,
  type MarkedCitation,
  type SearchScope,
} from "../core/api";
import { asGenerated } from "./aiText";
import type { AnalysisValue } from "./analysis";
import { withAnalysisPictures } from "./analysisPictures";
import { withAnalysisTables } from "./analysisTables";
import { citationAttributesOf, citationNode, type NodeJSON, withCitations } from "./blockJson";
import { calculatedFigureNode, figureShownText } from "./calculatedFigures";
import { citedSentences } from "./citedSentences";
import { withFigures } from "./figureMarkers";
import { figureRunId } from "./figureRuns";
import { withoutFraming } from "./noteBlocks";
import { printedValue } from "./printedFigures";
import { comparableSentence, INLINE_NODE, sentenceSpans } from "./sentences";

/**
 * While it is written, what would still change how it looks is held back, and
 * a marker whose Citation hasn't come yet shows as being checked; once it has
 * ended, a marker with no Citation is left out. A figure marker with no
 * figure is left out.
 */
export function answerBlocks(
  answer: Pick<ConversationAnswer, "text" | "citations" | "figures" | "status"> &
    Partial<Pick<ConversationAnswer, "id" | "analyses">>,
): NodeJSON[] {
  const streaming = answer.status === "streaming";
  const cited = new Map(answer.citations.map(({ marker, ...citation }) => [marker, citation]));
  const figures = new Map(answer.figures.map((figure) => [figure.marker, figure]));
  const blocks = withCitations(markdownToBlocks(answer.text, { streaming }), (marker) => {
    const citation = cited.get(marker);
    if (citation) return citationNode(citation);
    return streaming ? citationNode(null) : null;
  });
  return asGenerated(
    closeUpCitations(
      withCalculatedFigures(
        withAnalysisTables(
          withAnalysisPictures(blocks, answer.analyses),
          (answer.analyses ?? []).map((analysis) => ({
            answerId: answer.id ?? "preview",
            analysis,
          })),
        ),
        (marker) => figures.get(marker) ?? null,
        answer,
      ),
    ),
  );
}

export function withCalculatedFigures(
  blocks: readonly NodeJSON[],
  figureOf: (marker: number) => CalculatedFigure | null,
  answer: { id?: string; analyses?: readonly AnswerAnalysis[] },
): NodeJSON[] {
  let occurrence = 0;
  return withFigures(blocks, figureOf, (figure, marker, written) => {
    const analysis = figure.analysis
      ? answer.analyses?.find((run) => run.number === figure.analysis?.analysis)
      : undefined;
    const backed = analysis && holdsFigure(analysis, figure) ? analysis : null;
    // A figure this answer can't back reads as its value, never as a figure an Analysis checks
    // when there is no record for it (#2378).
    if (figure.analysis && !backed) return figure.shown;
    return calculatedFigureNode(
      { ...figure, written },
      `${answer.id ?? "preview"}:figure:${marker}:${occurrence++}`,
      backed ? figureRunId(answer.id ?? "preview", backed) : null,
    );
  });
}

function holdsFigure(analysis: AnswerAnalysis, figure: CalculatedFigure): boolean {
  const name = figure.analysis?.result;
  if (name === undefined) return false;
  const gives = (result: AnalysisValue | null) =>
    result?.kind === "figure" && result.name === name && result.value === figure.value;
  return (
    (analysis.end.kind === "done" && analysis.output.results.some(gives)) ||
    gives(printedValue(analysis, name))
  );
}

/**
 * A whole Answer as Add to note puts it in a page, for someone who never saw
 * the conversation: without the model's framing, nor what points to an
 * earlier Answer unless `question` asked about one. The Answer in the panel
 * keeps both.
 */
export const pageBlocks = (
  answer: Pick<ConversationAnswer, "text" | "citations" | "figures"> &
    Partial<Pick<ConversationAnswer, "id" | "analyses" | "status">>,
  question: string,
): NodeJSON[] =>
  asQuoteChecked(
    withoutFraming(
      answerBlocks({ ...answer, text: forPage(answer.text, question), status: "done" }),
    ),
    answer.status ?? "done",
  );

/**
 * An ended Answer's blocks as a Note takes them (#2311). A Citation whose sentence the
 * conversation still judges, or couldn't judge, had its quote found: in a Note it is that, and the
 * Note's own checks judge the sentence. A stopped Answer's Citation still checking may never have
 * had its quote checked.
 */
export function asQuoteChecked(
  blocks: readonly NodeJSON[],
  status: ConversationAnswer["status"],
): NodeJSON[] {
  const settled = (node: NodeJSON): NodeJSON => {
    const check = node.type === CITATION_NODE ? node.attrs?.check : undefined;
    const found = check === "not-checked" || (check === "checking" && status === "done");
    const kept = Object.entries(node.attrs ?? {}).filter(([name]) => name !== "checkReason");
    return {
      ...node,
      ...(found && { attrs: { ...Object.fromEntries(kept), check: "found" } }),
      ...(node.content && { content: node.content.map(settled) }),
    };
  };
  return blocks.map(settled);
}

/**
 * The checks an Answer's own judgement made, which a Note made from it carries (#2313): one mark
 * per cited sentence the judgement settled, with its verdict, the Citation that decided it and the
 * Answer's model and time. A sentence only its quote check covered, a sentence of a calculated
 * figure, and a sentence the judgement didn't settle carry nothing, so a Note never reads Checked
 * for what the judgement didn't do. Old Answers have no `judgedAt`: their supported verdicts are
 * not carried, and their Note's check reads as it did.
 */
export function withAnswerChecks(
  blocks: readonly NodeJSON[],
  answer: Pick<ConversationAnswer, "text" | "citations" | "figures"> &
    Partial<Pick<ConversationAnswer, "model" | "status" | "id">>,
  question: string,
  /** What the Answer's Question searched: a Folder's, or the whole Library (null). */
  scope: SearchScope | null,
): NodeJSON[] {
  const checks = carriedChecks(answer, question);
  if (![...checks.values()].some((each) => each.some((check) => check !== null))) {
    return [...blocks];
  }
  const used = new Set<CarriedCheck>();
  const markFor = (identity: string, text: string): NodeJSON | null => {
    const candidates = checks.get(identity);
    if (!candidates) return null;
    // The same words, quotes and version twice, judged differently or judged only once: no one can
    // say which sentence the verdict belongs to, so neither carries it.
    const distinct = new Set(
      candidates.map((each) => (each ? `${each.state}\u0000${each.verdict ?? ""}` : "")),
    );
    if (distinct.size > 1) return null;
    const check = candidates.find((each) => each !== null && !used.has(each));
    if (!check) return null;
    used.add(check);
    return {
      type: CLAIM_CHECK_MARK,
      attrs: {
        id: crypto.randomUUID(),
        request: "",
        action: "check-against-documents",
        state: check.state,
        reason: null,
        detail: null,
        providerId: answer.model?.providerId ?? null,
        modelId: answer.model?.modelId ?? null,
        text,
        evidence: check.evidence,
        says: check.verdict,
        unsupported: null,
        calculation: null,
        citedCaseUnchecked: false,
        citedCaseFound: false,
        // What the Answer's Question searched, not where the Note sits: moving the Note changes
        // nothing the judgement read.
        scope:
          scope === null
            ? { folderId: null, widened: true }
            : {
                folderId: scope.folderIds.length === 1 ? scope.folderIds[0] : null,
                widened: false,
                chosen: scope,
              },
        versions: check.versions,
        excluded: [],
        checkedAt: check.checkedAt,
        ...(answer.id !== undefined && { fromAnswer: answer.id }),
      },
    };
  };
  const markedContent = (content: readonly NodeJSON[]): NodeJSON[] => {
    const widths = content.map((node) => (node.type === "text" ? (node.text ?? "").length : 1));
    const projected = content
      .map((node) => (node.type === "text" ? (node.text ?? "") : INLINE_NODE))
      .join("");
    const marks: { from: number; to: number; mark: NodeJSON }[] = [];
    const beforeMarker = new RegExp(`\\s+(?=${INLINE_NODE})`, "gu");
    for (const span of sentenceSpans(projected)) {
      const text = projected.slice(span.from, span.to);
      // The Answer's own reading drops the space a marker leaves before it: so does this key.
      const comparable = comparableSentence(text.replace(beforeMarker, ""));
      const cited: CitationIdentity[] = [];
      let offset = 0;
      for (const node of content) {
        const width = node.type === "text" ? (node.text ?? "").length : 1;
        if (node.type === CITATION_NODE && offset >= span.from && offset < span.to)
          cited.push(identityOfCitation(node.attrs ?? {}));
        offset += width;
      }
      const mark = markFor(identityOf(comparable, cited), text);
      if (mark) marks.push({ from: span.from, to: span.to, mark });
    }
    if (marks.length === 0) return [...content];
    const out: NodeJSON[] = [];
    let offset = 0;
    content.forEach((node, index) => {
      const width = widths[index] ?? 0;
      const from = offset;
      const to = offset + width;
      offset = to;
      if (node.type !== "text") {
        out.push(node);
        return;
      }
      const textValue = node.text ?? "";
      let at = 0;
      const pieces: { text: string; mark: NodeJSON | null }[] = [];
      for (const mark of marks) {
        const start = Math.max(mark.from, from) - from;
        const end = Math.min(mark.to, to) - from;
        if (end <= start) continue;
        if (start > at) pieces.push({ text: textValue.slice(at, start), mark: null });
        pieces.push({ text: textValue.slice(start, end), mark: mark.mark });
        at = end;
      }
      if (at < textValue.length) pieces.push({ text: textValue.slice(at), mark: null });
      for (const piece of pieces) {
        if (piece.text === "") continue;
        out.push({
          ...node,
          text: piece.text,
          ...(piece.mark
            ? { marks: [...(node.marks ?? []), piece.mark] }
            : node.marks && { marks: node.marks }),
        });
      }
    });
    return out;
  };
  const walk = (node: NodeJSON): NodeJSON =>
    node.content
      ? {
          ...node,
          content: node.content.some((child) => child.type === "text")
            ? markedContent(node.content)
            : node.content.map(walk),
        }
      : node;
  return blocks.map(walk);
}

interface CarriedCheck {
  state: ClaimVerdict;
  verdict: string | null;
  evidence: CitationAttributes;
  versions: CheckedVersion[];
  checkedAt: string;
}

interface CitationIdentity {
  passageId: string;
  quote: string;
  contentHash: string;
}

const identityOfCitation = (attrs: Record<string, unknown>): CitationIdentity => ({
  passageId: typeof attrs.passageId === "string" ? attrs.passageId : "",
  quote: typeof attrs.quote === "string" ? attrs.quote : "",
  contentHash: typeof attrs.contentHash === "string" ? attrs.contentHash : "",
});

/** A sentence and the Citations it quotes: the same words under different quotes are not the same claim. */
const identityOf = (sentence: string, citations: readonly CitationIdentity[]): string =>
  `${sentence}\u0000${citations
    .map((each) => `${each.passageId}\u0001${each.quote}\u0001${each.contentHash}`)
    .sort()
    .join("\u0002")}`;

/**
 * Each cited sentence of the Answer, in the order its text gives them, under its words and quotes:
 * the check its judgement settled, or null for one it didn't (a calculated figure's among them).
 */
function carriedChecks(
  answer: Pick<ConversationAnswer, "text" | "citations" | "figures">,
  question: string,
): Map<string, (CarriedCheck | null)[]> {
  const byMarker = new Map(answer.citations.map((citation) => [citation.marker, citation]));
  const found = new Map<string, (CarriedCheck | null)[]>();
  for (const cited of citedSentences(forPage(answer.text, question), answer.figures)) {
    const citations = cited.markers
      .map((marker) => byMarker.get(marker))
      .filter((citation): citation is MarkedCitation => citation !== undefined);
    const key = identityOf(
      comparableSentence(cited.sentence),
      citations.map((citation) => ({
        passageId: citation.passageId ?? "",
        quote: citation.quote ?? "",
        contentHash: citation.contentHash ?? "",
      })),
    );
    const check = cited.calculated ? null : judgementOf(cited.markers, citations);
    found.set(key, [...(found.get(key) ?? []), check]);
  }
  return found;
}

/** What the judgement settled of a sentence citing `citations` at `markers`; null when it settled nothing. */
function judgementOf(
  markers: readonly number[],
  citations: readonly MarkedCitation[],
): CarriedCheck | null {
  const judged = citations.filter(
    (citation) =>
      citation.judgedAt !== undefined ||
      citation.check === "unsupported" ||
      citation.check === "contradicted",
  );
  if (judged.length === 0) return null;
  const contradicted = judged.find((citation) => citation.check === "contradicted");
  const unsupported = judged.find((citation) => citation.check === "unsupported");
  const supported =
    markers.length === citations.length &&
    judged.length === citations.length &&
    citations.every((citation) => citation.check === "found" && citation.judgedAt !== undefined);
  const deciding = contradicted ?? unsupported ?? (supported ? judged[0] : undefined);
  if (!deciding) return null;
  const checkedAt = judged
    .map((citation) => citation.judgedAt)
    .filter((at): at is string => at !== undefined)
    .sort()
    .at(-1);
  if (checkedAt === undefined) return null;
  // Every judged Document/version pair, an old version beside its current one included.
  const versions = [
    ...new Map(
      judged
        .filter((citation) => (citation.documentId ?? "") !== "")
        .map((citation) => [
          `${citation.documentId ?? ""}\u0000${citation.contentHash ?? ""}`,
          { documentId: citation.documentId ?? "", contentHash: citation.contentHash ?? "" },
        ]),
    ).values(),
  ];
  return {
    state: contradicted ? "contradicted" : unsupported ? "unsupported" : "supported",
    verdict: deciding.verdict ?? null,
    evidence: citationAttributesOf(deciding),
    // Every judged Citation's version: a Document changed after the judgement asks again.
    versions,
    // The deciding Citation's own judgement time, not a later sentence's.
    checkedAt: deciding.judgedAt ?? checkedAt,
  };
}

/** The Citation markers an Answer's text shows, in order, one for each place: a marker used twice is two. */
export function markersIn(text: string): number[] {
  const markers: number[] = [];
  withCitations(markdownToBlocks(text), (marker) => {
    markers.push(marker);
    return null;
  });
  return markers;
}

/** The markers an Answer's text shows that no Citation of it has, each once. */
export function markersWithoutCitation(answer: {
  text: string;
  citations: readonly Pick<MarkedCitation, "marker">[];
}): number[] {
  const cited = new Set(answer.citations.map(({ marker }) => marker));
  return [...new Set(markersIn(answer.text))].filter((marker) => !cited.has(marker));
}

/** Where the stand-ins of `shownRanges` count from: higher than any marker an Answer writes. */
const STAND_IN = 9000;

/**
 * Which of the `ranges` of `text` (in order, apart) the Answer shows as text
 * rather than inside code or maths, read as `answerBlocks` reads it: each is
 * swapped for a marker, and the markers that come out are the shown ones.
 */
export function shownRanges(
  text: string,
  ranges: readonly { start: number; end: number }[],
): boolean[] {
  if (ranges.length === 0 || ranges.length > 999) return ranges.map(() => false);
  let swapped = "";
  let at = 0;
  ranges.forEach(({ start, end }, index) => {
    swapped += `${text.slice(at, start)}[^${STAND_IN + index}]`;
    at = end;
  });
  const shown = new Set(markersIn(swapped + text.slice(at)));
  return ranges.map((_, index) => shown.has(STAND_IN + index));
}

/** A space between two Citations, or between a Citation and the punctuation after it, is not kept (#612). */
const PUNCTUATION_AFTER = /^[ \t]+(?=[.,;:!?)\]。，、；：！？）])/u;

/**
 * Citations side by side stand together and punctuation touches the Citation
 * before it, whatever spaces the model wrote around the markers.
 */
function closeUpCitations(blocks: readonly NodeJSON[]): NodeJSON[] {
  return blocks.map((block) => {
    if (!block.content || block.type === "codeBlock") return block;
    const siblings = block.content;
    const content: NodeJSON[] = [];
    siblings.forEach((child, index) => {
      if (child.type !== "text" || !child.text) {
        content.push(...closeUpCitations([child]));
        return;
      }
      if (content.at(-1)?.type !== CITATION_NODE) {
        content.push(child);
        return;
      }
      const text = child.text.replace(PUNCTUATION_AFTER, "");
      const betweenCitations = text.trim() === "" && siblings[index + 1]?.type === CITATION_NODE;
      if (!betweenCitations) content.push({ ...child, text });
    });
    return { ...block, content };
  });
}

/**
 * Whether Blocks hold anything to read, words or a calculated figure: an Answer that failed
 * before writing any has nothing to keep.
 */
export const hasText = (blocks: readonly NodeJSON[]): boolean =>
  blocks.some(
    (block) =>
      (block.type === "text" && (block.text ?? "").trim() !== "") ||
      (block.type === CALCULATED_FIGURE_NODE && figureShownText(block.attrs).trim() !== "") ||
      hasText(block.content ?? []),
  );
