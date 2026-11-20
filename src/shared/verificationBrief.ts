/**
 * The brief a Mind made to verify a document keeps (#3277): up to three lines on what the document
 * concludes and the claims its figures rest on, each pointing at a sentence of the document the way
 * a claim does, by its Block and words. It lives in the Mind's Yjs settings under a key of its own,
 * not in the verification record and never in the Blocks, so a Word file that goes back to its
 * writer carries none of it and an older version, which writes only the keys it knows, leaves it be.
 */
import type * as Y from "yjs";
import { MIND_SETTINGS_FIELD } from "../core/api";

const KEY = "verificationBrief";

/** The most conclusions a brief shows, each a short sentence: a brief that needs scrolling has failed. */
export const MOST_CONCLUSIONS = 3;
/** The most figures a brief names. */
export const MOST_BRIEF_FIGURES = 5;

/** A sentence of the verified document, as its claim is named: its Block and its words. */
export interface BriefSentence {
  blockId: string;
  text: string;
  occurrence?: number;
}

/** A figure the conclusions rest on: its sentence, and the model's line naming it (#3493). */
export interface BriefFigure extends BriefSentence {
  /** What the figure is and the figure, in the document's language: "2024 revenue: 2.9 million". */
  line?: string;
}

export interface BriefConclusion {
  /** The line the model wrote, in the document's language. */
  line: string;
  /** The sentence of the document it rests on, where pressing it goes. */
  at: BriefSentence;
}

export interface VerificationBrief {
  conclusions: readonly BriefConclusion[];
  /** The claims the conclusions rest on that are figures, in the order the model gave them. */
  figures: readonly BriefFigure[];
  /** The sentences it was written from, as `sortedText` names them: a brief of an older text is not shown. */
  sortedText: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function sentenceOf(value: unknown): BriefSentence | null {
  if (!isRecord(value) || typeof value.blockId !== "string" || typeof value.text !== "string") {
    return null;
  }
  const { occurrence } = value;
  return {
    blockId: value.blockId,
    text: value.text,
    ...(typeof occurrence === "number" &&
      Number.isInteger(occurrence) &&
      occurrence >= 0 && { occurrence }),
  };
}

/** What a Mind's settings keep of its brief; null when it has none. */
export function readBrief(settings: Y.Map<unknown>): VerificationBrief | null {
  const value = settings.get(KEY);
  if (!isRecord(value) || typeof value.sortedText !== "string") return null;
  const conclusions = Array.isArray(value.conclusions)
    ? value.conclusions.flatMap((each): BriefConclusion[] => {
        const at = isRecord(each) ? sentenceOf(each.at) : null;
        return isRecord(each) && typeof each.line === "string" && each.line !== "" && at
          ? [{ line: each.line, at }]
          : [];
      })
    : [];
  const figures = Array.isArray(value.figures)
    ? value.figures.flatMap((each): BriefFigure[] => {
        const sentence = sentenceOf(each);
        if (!sentence) return [];
        const line = isRecord(each) && typeof each.line === "string" ? each.line.trim() : "";
        return [line ? { ...sentence, line } : sentence];
      })
    : [];
  return conclusions.length === 0 && figures.length === 0
    ? null
    : {
        conclusions: conclusions.slice(0, MOST_CONCLUSIONS),
        figures: figures.slice(0, MOST_BRIEF_FIGURES),
        sortedText: value.sortedText,
      };
}

/** The brief of a Mind's document. */
export const briefOf = (doc: Y.Doc): VerificationBrief | null =>
  readBrief(doc.getMap(MIND_SETTINGS_FIELD));

/** Records a brief in place of the one recorded. */
export function writeBrief(settings: Y.Map<unknown>, brief: VerificationBrief): void {
  settings.set(KEY, {
    conclusions: brief.conclusions.map((each) => ({ line: each.line, at: { ...each.at } })),
    figures: brief.figures.map((each) => ({ ...each })),
    sortedText: brief.sortedText,
  });
}

/** Calls `listener` whenever the brief may have changed. Returns how to stop. */
export function observeBrief(doc: Y.Doc, listener: () => void): () => void {
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  settings.observe(listener);
  return () => settings.unobserve(listener);
}
