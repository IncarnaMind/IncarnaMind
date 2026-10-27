/**
 * The counts an AI use statement (#739) is made of, read from what a Mind
 * already records and nothing else: the AI use record (`ai_use`, #292) for the
 * models and what became of each insertion, the AI text marks in the Mind's
 * text (#95), its Answers' models and Tool calls, and the results of its
 * Citation checks and sentence checks (#96), with the files those checks
 * couldn't read when they started. A figure none of these holds is
 * not here, and nothing is estimated.
 */
import * as Y from "yjs";
import { citationState, type LiveDocument } from "../../shared/citations";
import { claimCheckShown, type SentenceResult, sentenceResultOf } from "../../shared/claimChecks";
import { mindScopeOf } from "../../shared/mindScope";
import { readProposalAttribute } from "../../shared/proposals";
import { comparableSentence } from "../../shared/sentences";
import { toolCallsOf } from "../../shared/toolCalls";
import { checkUnreadOf, unreadFileNamesOf } from "../../shared/unreadFiles";
import { countFor, countText, firstWords } from "../../shared/wordCount";
import { isEdited, textAttribute } from "../answers/blocks";
import { figuresInMind } from "../answers/checks/figureOccurrences";
import { checkedSentences } from "../answers/checks/sentences";
import {
  type AiUseEntry,
  type AiUseKind,
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  type CitationAttributes,
  type KeptCitationText,
  MIND_SETTINGS_FIELD,
  PROPOSAL_ATTRIBUTE,
  QUESTION_BLOCK,
  type UnreadFile,
} from "../api";
import {
  type Block,
  type Footnote,
  type Inline,
  plainText,
  readBlock,
  reviewReading,
} from "../mindText";
import { DOCUMENT_TOOLS, SOURCE_TOOLS, WEB_TOOLS } from "../tools";

/** What a model was used for. A proposal turned down wrote nothing, so it isn't one. */
export type Use =
  | Exclude<AiUseKind, "assistant-change-rejected">
  | "answer"
  | "search-documents"
  | "search-sources"
  | "search-web";

/** In the order the statement lists them. */
export const USES: readonly Use[] = [
  "answer",
  "answer-added",
  "edit-with-ai-accepted",
  "assistant-change-accepted",
  "comparison-table-accepted",
  "suggestion-accepted",
  "search-documents",
  "search-sources",
  "search-web",
  "sentence-checked",
];

/** How often one model was used for one thing. `model` is null when the record doesn't say. */
export interface UseCount {
  use: Use;
  model: string | null;
  times: number;
}

/**
 * One section of the text, from a heading to the next. A piece of AI text is one
 * Answer, one Answer added to the Mind, or one accepted change from the AI.
 */
export interface SectionCount {
  /** The heading's text; null for the text before the first heading, or for a Mind with no headings. */
  title: string | null;
  /** Pieces the User left as the AI wrote them. */
  kept: number;
  /** Pieces the User changed afterwards. */
  rewritten: number;
  /** The words still marked as AI text. */
  words: number;
}

export interface CitationCounts {
  found: number;
  notFound: number;
  cantCheck: number;
  unsupported: number;
  contradicted: number;
  checking: number;
}

export interface SentenceCounts {
  supported: number;
  unsupported: number;
  notFound: number;
  contradicted: number;
  needsRecheck: number;
  notChecked: number;
}

export const SENTENCE_WORDS = 12;

/** One sentence checked against the Documents, with the latest result of its check. */
export interface CheckedSentence {
  /** Its first words, with "…" when it goes on, as it reads in the Mind now. */
  sentence: string;
  result: SentenceResult;
  /** The model that checked it; null when the mark doesn't say, or when no check ran. */
  model: string | null;
  /** When it was checked, ISO 8601 UTC; null when no check ran. */
  checkedAt: string | null;
}

export interface AiUseFigures {
  uses: UseCount[];
  /** Whether the Mind has headings, which its sections follow. */
  headings: boolean;
  /** The sections that hold AI text, in order. */
  sections: SectionCount[];
  /** Pieces of AI text taken out of the Mind again. */
  removed: number;
  citations: CitationCounts;
  sentences: SentenceCounts;
  checked: CheckedSentence[];
  unread: UnreadFile[];
  /** Whether the statement names them: the Mind's own choice, off until the User ticks it. */
  unreadNames: boolean;
}

export interface FigureSources {
  fragment: Y.XmlFragment;
  /** The Mind's entries in the record of AI use. */
  entries: readonly AiUseEntry[];
  documents: readonly LiveDocument[];
  kept: readonly KeptCitationText[];
  folderId: string | null;
  /** The name to give a model, or null when the record names none. */
  modelName(providerId: string | null, modelId: string | null): string | null;
  /** What a heading with no text is called. */
  untitled: string;
}

const words = (text: string) => countFor(countText(text), "words");

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

export const totalCitations = (counts: CitationCounts) => sum({ ...counts });
export const totalSentences = (counts: SentenceCounts) => sum({ ...counts });

/** Every inline run of text in some Blocks, a run being what a paragraph, a heading or a cell holds. */
export function groupsOf(blocks: readonly Block[]): Inline[][] {
  return blocks.flatMap((block): Inline[][] => {
    if (block.inserted) return [];
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "question":
        return [block.content];
      case "list":
        return block.items.flatMap((item) => groupsOf(item));
      case "quote":
        return groupsOf(block.content);
      case "table":
        return block.rows.flatMap((row) => row.flatMap((cell) => groupsOf(cell.content)));
      case "chart":
        return [block.sources];
      default:
        return [];
    }
  });
}

/** A Block a change still waiting would add, which isn't the Mind's until it is accepted. */
export const isProposed = (element: Y.XmlElement) =>
  readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE))?.kind === "insert";

function placeIds(
  element: Y.XmlElement,
  section: SectionCount,
  places: Map<string, SectionCount>,
): void {
  const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  if (typeof id === "string") places.set(id, section);
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlElement) placeIds(child, section, places);
  }
}

export function readFigures(sources: FigureSources): AiUseFigures {
  const { fragment, entries, documents, kept } = sources;
  const lead: SectionCount = { title: null, kept: 0, rewritten: 0, words: 0 };
  const all = [lead];
  let current = lead;
  const places = new Map<string, SectionCount>();
  const uses: UseCount[] = [];
  const use = (what: Use, model: string | null) => {
    const found = uses.find((each) => each.use === what && each.model === model);
    if (found) found.times++;
    else uses.push({ use: what, model, times: 1 });
  };
  const citations: CitationCounts = {
    found: 0,
    notFound: 0,
    cantCheck: 0,
    unsupported: 0,
    contradicted: 0,
    checking: 0,
  };
  const checkKeys = {
    found: "found",
    "not-found": "notFound",
    "cant-check": "cantCheck",
    unsupported: "unsupported",
    contradicted: "contradicted",
    checking: "checking",
  } as const;
  const attributesOf = new Map<Footnote, Partial<CitationAttributes>>();
  const readOptions = {
    includeQuestions: false,
    footnote: (attributes: Record<string, unknown>): Footnote => {
      const note: Footnote = { source: "", unverified: false };
      attributesOf.set(note, attributes as Partial<CitationAttributes>);
      return note;
    },
    trimBeforeCitation: false,
    review: reviewReading(fragment),
  };

  /** Counts the words and Citations in some Blocks; the words, as AI text and as the User's. */
  const tally = (blocks: readonly Block[]) => {
    let ai = 0;
    let other = 0;
    const read = (group: readonly Inline[], inFootnote: boolean) => {
      let aiText = "";
      let otherText = "";
      for (const inline of group) {
        if (inline.inserted) continue;
        if (inline.kind === "text") {
          if (inline.ai) aiText += inline.text;
          else otherText += inline.text;
        } else if (inline.kind === "figure") {
          otherText += inline.figure.shown;
        } else if (inline.kind === "citation") {
          const attributes = attributesOf.get(inline.footnote);
          if (attributes) citations[checkKeys[citationState(attributes, documents, kept).check]]++;
        } else if (inline.kind === "footnote") {
          read(inline.content, true);
        }
      }
      if (!inFootnote) {
        ai += words(aiText);
        other += words(otherText);
      }
    };
    for (const group of groupsOf(blocks)) read(group, false);
    return { ai, other };
  };

  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement) || child.nodeName === QUESTION_BLOCK) continue;
    if (isProposed(child)) continue;
    if (child.nodeName === "heading") {
      current = {
        title: plainText(child).trim() || sources.untitled,
        kept: 0,
        rewritten: 0,
        words: 0,
      };
      all.push(current);
    }
    placeIds(child, current, places);
    const counted = tally(readBlock(child, readOptions));
    current.words += counted.ai;
    const status = textAttribute(child, "status");
    if (
      child.nodeName === ANSWER_BLOCK &&
      (status === "done" || status === "stopped") &&
      counted.ai + counted.other > 0
    ) {
      if (isEdited(child)) current.rewritten++;
      else current.kept++;
      const model = sources.modelName(
        textAttribute(child, "providerId"),
        textAttribute(child, "modelId"),
      );
      use("answer", model);
      for (const call of toolCallsOf(child.getAttribute("toolCalls"))) {
        if (call.status !== "done") continue;
        if (call.source === "documents" && call.tool === DOCUMENT_TOOLS.search) {
          use("search-documents", model);
        } else if (call.source === "sources" && call.tool === SOURCE_TOOLS.find) {
          use("search-sources", model);
        } else if (call.source === "web" && call.tool === WEB_TOOLS.search) {
          use("search-web", model);
        }
      }
    }
  }

  let removed = 0;
  for (const entry of entries) {
    if (entry.kind === "assistant-change-rejected") continue;
    use(entry.kind, sources.modelName(entry.providerId, entry.modelId));
    if (entry.blockIds.length === 0) continue;
    if (entry.outcome === "deleted") {
      removed++;
      continue;
    }
    const section = entry.blockIds.map((id) => places.get(id)).find((each) => each) ?? lead;
    if (entry.outcome === "edited") section.rewritten++;
    else section.kept++;
  }

  const sentences: SentenceCounts = {
    supported: 0,
    unsupported: 0,
    notFound: 0,
    contradicted: 0,
    needsRecheck: 0,
    notChecked: 0,
  };
  const versions = new Map(documents.map((document) => [document.id, document.contentHash]));
  const figureContexts = new Map(
    figuresInMind(fragment).map((figure) => [figure.id, figure.context]),
  );
  const checked: CheckedSentence[] = [];
  const requests: string[] = [];
  for (const { check, sentence, cited } of checkedSentences(fragment)) {
    requests.push(check.request);
    const shown = claimCheckShown(check, {
      text: sentence,
      figureContexts,
      versions,
      folderId: sources.folderId,
      scope: fragment.doc ? mindScopeOf(fragment.doc) : null,
    });
    const result = sentenceResultOf(shown, check, cited.length);
    if (!result) continue;
    sentences[result === "changed" ? "needsRecheck" : result]++;
    const quoted = firstWords(comparableSentence(sentence), SENTENCE_WORDS);
    const ran = result !== "notChecked";
    checked.push({
      sentence: quoted.cut ? `${quoted.text}…` : quoted.text,
      result,
      model: ran ? sources.modelName(check.providerId, check.modelId) : null,
      checkedAt: ran ? check.checkedAt : null,
    });
  }
  // A Mind whose record holds no check (made before checks were recorded, or cleared) still used the model.
  if (!uses.some((each) => each.use === "sentence-checked")) {
    for (const { result, model } of checked) {
      if (result !== "notChecked") use("sentence-checked", model);
    }
  }

  const order = (use: Use) => USES.indexOf(use);
  return {
    uses: uses.sort(
      (a, b) =>
        order(a.use) - order(b.use) ||
        (a.model === null ? 1 : 0) - (b.model === null ? 1 : 0) ||
        (a.model ?? "").localeCompare(b.model ?? ""),
    ),
    headings: all.length > 1,
    sections: all.filter((each) => each.kept + each.rewritten + each.words > 0),
    removed,
    citations,
    sentences,
    checked,
    unread: fragment.doc ? checkUnreadOf(fragment.doc, requests) : [],
    unreadNames: fragment.doc ? unreadFileNamesOf(fragment.doc.getMap(MIND_SETTINGS_FIELD)) : false,
  };
}
