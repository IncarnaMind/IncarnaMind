/**
 * Whether the sentences of an Answer that carry a Citation are supported by
 * what they cite, as the app's own claim check (Check against Documents)
 * judges them, not a model of the evaluation's own.
 */
import type {
  ChatModelChoice,
  CitedQuote,
  Core,
  MarkedCitation,
  MarkedFigure,
} from "../../src/core";
import { FIGURE_MARKER } from "../../src/shared/figureMarkers";
import {
  comparableSentence,
  INLINE_NODE,
  isClaim,
  sentenceSpans,
} from "../../src/shared/sentences";

export interface CitedSentence {
  /** The sentence without its Citation markers. */
  sentence: string;
  /** Its paragraph, list item or table row, also without them. */
  context: string;
  /** What its markers cite: those the Answer has a Citation for. */
  cited: CitedQuote[];
}

export interface SentenceSupport {
  sentence: string;
  verdict: "supported" | "unsupported" | "contradicted" | "not-checked";
}

/** The share of the research requests' cited sentences the check must judge supported (#1073). */
export const SUPPORTED_TARGET = 0.95;

const MARKER = /\[\^(\d+)\]/g;
const FOOTNOTE_LINE = /^\s*\[\^\d+\]:/;
const BLOCK_MARKUP = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/;

const BEFORE_MARKER = /\s+(?=\uFFFC)/gu;

const inlineNodes = (text: string) => text.split(INLINE_NODE).length - 1;

/** A marker leaves nothing behind, not even the space before it: "is quadratic [^2]." reads "is quadratic.". */
const withoutMarkers = (text: string) => comparableSentence(text.replace(BEFORE_MARKER, ""));

/** The sentences of an Answer's Markdown that cite at least one Citation, with what they cite. */
export function citedSentences(
  text: string,
  citations: readonly Pick<
    MarkedCitation,
    "marker" | "documentName" | "documentId" | "contentHash" | "quote"
  >[],
  figures: readonly Pick<MarkedFigure, "marker" | "shown">[] = [],
): CitedSentence[] {
  const found: CitedSentence[] = [];
  for (const line of text.split("\n")) {
    if (FOOTNOTE_LINE.test(line)) continue;
    const markers: number[] = [];
    const marked = line
      .replace(BLOCK_MARKUP, "")
      .replace(
        FIGURE_MARKER,
        (marker, number: string) =>
          figures.find((each) => each.marker === Number(number))?.shown ?? marker,
      )
      .replace(MARKER, (_, number: string) => {
        markers.push(Number(number));
        return INLINE_NODE;
      })
      .replace(/[*_`]/g, "")
      .replace(/\|/g, " ");
    const context = withoutMarkers(marked);
    for (const { from, to } of sentenceSpans(marked)) {
      const before = inlineNodes(marked.slice(0, from));
      const inside = inlineNodes(marked.slice(from, to));
      const cited = markers.slice(before, before + inside).flatMap((marker) => {
        const citation = citations.find((each) => each.marker === marker);
        return citation
          ? [
              {
                documentName: citation.documentName,
                documentId: citation.documentId,
                contentHash: citation.contentHash,
                quote: citation.quote,
              },
            ]
          : [];
      });
      const sentence = withoutMarkers(marked.slice(from, to));
      if (cited.length > 0 && isClaim(sentence)) found.push({ sentence, context, cited });
    }
  }
  return found;
}

/**
 * Each cited sentence of an Answer, checked against the Documents as Check against Documents
 * does, on `model` (the default chat model when null).
 */
export async function checkCitedSentences(
  core: Pick<Core, "checkClaim">,
  answer: {
    text: string;
    citations: Parameters<typeof citedSentences>[1];
    figures?: Parameters<typeof citedSentences>[2];
  },
  model: ChatModelChoice | null = null,
): Promise<SentenceSupport[]> {
  const results: SentenceSupport[] = [];
  for (const each of citedSentences(answer.text, answer.citations, answer.figures)) {
    const result = await core.checkClaim({
      claim: each.sentence,
      context: each.context,
      cited: each.cited,
      model,
    });
    results.push({ sentence: each.sentence, verdict: result.verdict });
  }
  return results;
}

export interface SupportRate {
  model: string;
  language: "en" | "zh-CN";
  supported: number;
  /** The sentences the check gave a verdict for. */
  judged: number;
  notChecked: number;
}

/** Supported, judged and not-checked sentences, per model and language. */
export function supportRates(
  runs: readonly {
    model: string;
    language: "en" | "zh-CN";
    support: readonly SentenceSupport[];
  }[],
): SupportRate[] {
  const groups = new Map<string, SupportRate>();
  for (const run of runs) {
    const key = `${run.model}\n${run.language}`;
    const group = groups.get(key) ?? {
      model: run.model,
      language: run.language,
      supported: 0,
      judged: 0,
      notChecked: 0,
    };
    for (const each of run.support) {
      if (each.verdict === "not-checked") group.notChecked++;
      else group.judged++;
      if (each.verdict === "supported") group.supported++;
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The share of the sentences the check gave a verdict for that it judged supported, from 0 to 1; 1 when it judged none. */
export function supportedShare(sentences: readonly SentenceSupport[]): number {
  const judged = sentences.filter((each) => each.verdict !== "not-checked");
  if (judged.length === 0) return 1;
  return judged.filter((each) => each.verdict === "supported").length / judged.length;
}
