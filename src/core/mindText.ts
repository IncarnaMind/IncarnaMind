/**
 * The one reader that turns a Mind's Blocks, in the Yjs document, into plain
 * data. Question context and the Markdown and .docx exports all read through
 * `readBlocks` and `readBlock`, and each only decides how to write what was
 * read; whatever copies a Mind's text out reads the same way. A rule about
 * what counts as the Mind's text is made here, once, and applies to all of
 * them. Exports read once, so the two formats always agree on what is
 * exported, and on the order (and so the numbers) of the footnotes: a
 * Citation's and those the User wrote are numbered together, in the order
 * they appear.
 *
 * Node types are those the editor stores (Tiptap's names, see `noteSchema`),
 * plus Tiptap's tables and images, which are read when a Mind has them. What a
 * Word import kept as it is reads as the text it holds or shows (a text box's,
 * a field's result), a Word footnote as a footnote, and a deletion, a comment
 * and the invisible marks as nothing (`wordAtomText`).
 *
 * What this version doesn't know:
 *
 * - A node type it doesn't know is read as the Blocks inside it, or, when it
 *   holds only inline content, as a paragraph of that text. Nothing a Mind
 *   holds is lost by a node it can't name, and nothing is invented.
 * - A mark it doesn't know (one that isn't in `Marks`) is dropped: the text
 *   under it is kept, unmarked. To carry another mark, add it to `Marks` and
 *   `marksOf`, and every writer can see it (each writer shows the marks it
 *   has a way to show).
 * - An inline node it doesn't know is read as its text, without marks.
 * - An attribute that is missing or of the wrong type reads as its default:
 *   a heading is level 1, a list starts at 1, a text attribute is "".
 *
 * Proposals still waiting (see `PROPOSAL_INSERT_MARK`) aren't the Mind's text
 * yet: what one adds is left out, and what one removes is read as it is. A
 * Word export reads them too, for review (`ReadOptions.review`, #107).
 */
import * as Y from "yjs";
import { originOf } from "../shared/blockOrigins";
import { figureShownText, readCalculatedFigureAttributes } from "../shared/calculatedFigures";
import { type ChartAttributes, chartSources, chosenSeries, readChart } from "../shared/charts";
import { type RecheckReason, readClaimCheck } from "../shared/claimChecks";
import {
  cellProblemMessage,
  comparisonCellOf,
  comparisonNameOf,
  comparisonQuestionsOf,
  visibleComparisonQuestions,
} from "../shared/comparisons";
import { type CalculatedSources, calculatedSources, labelledCitations } from "../shared/figureRuns";
import { type MessageKey, type MessageParams, translate } from "../shared/i18n";
import { citationLocation } from "../shared/locations";
import type { TableAlign } from "../shared/markdownTables";
import { cutTitle } from "../shared/naming";
import {
  readParagraphFormat,
  readTextColor,
  readTextFont,
  readTextSize,
} from "../shared/paragraphFormat";
import {
  outOfDateProposals,
  proposalRequestOf,
  readProposalAttribute,
  readProposalRef,
} from "../shared/proposals";
import type { ScopeKind } from "../shared/searchScope";
import { comparisonCellTarget } from "../shared/signOffs";
import { readWordAtom, wordAtomText } from "../shared/wordFiles";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  type CalculatedFigure,
  type CalculatedFigureAttributes,
  CHART_NODE,
  CITATION_NODE,
  type Citation,
  type CitedWork,
  CLAIM_CHECK_MARK,
  type ClaimCalculation,
  COMPARISON_ROW_NODE,
  COMPARISON_TABLE_NODE,
  type ComparisonQuestion,
  DOCUMENT_CHIP_NODE,
  FOOTNOTE_NODE,
  GENERATED_MARK,
  PARAGRAPH_FORMAT_ATTRIBUTE,
  type ParagraphFormat,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type ProposalRequest,
  QUESTION_BLOCK,
  type RecordCiteResult,
  type SignOffNow,
  type SignOffTarget,
  type StyledRun,
  SUBSCRIPT_MARK,
  SUPERSCRIPT_MARK,
  TEXT_COLOR_MARK,
  TEXT_FONT_MARK,
  TEXT_SIZE_MARK,
  WORD_ATOM_NODE,
  WORD_BLOCK_NODE,
  WORD_CHANGE_ID,
} from "./api";
import { isRecord } from "./errors";

export interface Marks {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
  highlight: boolean;
  code: boolean;
  /** The link's target, or null. */
  link: string | null;
  /** Hex "RRGGBB". */
  color?: string;
  font?: string;
  /** In points. */
  size?: number;
  vertical?: "superscript" | "subscript";
}

/** A Citation's footnote: one per Citation, in the order they appear. */
export interface Footnote {
  /** The Document's name and the Citation's Location, e.g. "Tides, p. 12–13" or "Deck, slide 4". */
  source: string;
  /** The quote wasn't found, or can't be checked: the footnote gets the "[unverified]" marker. */
  unverified: boolean;
  /** A web page's address, which `source` names: a format with links makes it one. */
  link?: string;
  /** Its check failed, which a Word file can say in a comment (#107). */
  failed?: FailedCheck;
  /**
   * People's own checks of it (#1933), each a line under its source: "Checked by Ada · 28 Oct
   * 2026", or "… before it changed" for one made before its text, quote or version did.
   */
  checked?: readonly string[];
}

/** How a Citation's check failed (#107). */
export interface FailedCheck {
  check: "not-found" | "unsupported" | "contradicted";
  /** The quote the check looked for. */
  quote: string | null;
  /** What the evidence says, when the check of the claim has a line on it. */
  verdict: string | null;
}

export interface RecordCiteComment {
  raw: string;
  outcome: RecordCiteResult["outcome"];
  source: string | null;
  passage: string | null;
  covered: string | null;
  uncovered: string | null;
  candidates: string[];
  nearby: { source: string; passage: string } | null;
}

/** A sentence whose check has a Word comment, with what the comment says. */
export type FailedSentence = { id: string; recordCites?: RecordCiteComment[] } & (
  | { check: "record-cites" }
  | {
      check: "contradicted";
      says: string | null;
      worked: (Pick<ClaimCalculation, "stated" | "relation"> & { shown: string }) | null;
    }
  | {
      check: "unsupported";
      /** Where it looked, as `scopeName` names it; null for every Document. */
      scope: { kind: ScopeKind; name: string | null; more: number } | null;
      nearest: { quote: string; source: string } | null;
      covers: { covered: string; uncovered: string; quote: string; source: string } | null;
      /** What the sentence's own Citations support and don't, as its card says. */
      citations: { count: number; covered: string; uncovered: string } | null;
      /** Nothing in its scope was about it, as its card says (`saysNotFound`): "Not found". */
      notFound: boolean;
      /** Why it is unsupported, in the check's words; null when it gave none. */
      reason: string | null;
    }
  | { check: "own-workings" }
  | { check: "needs-recheck"; why: RecheckReason }
  | { check: "cited-case-unchecked"; unsupported: boolean }
);

/** Part of a change still waiting to be accepted (a Proposal), read for review (#107). */
export interface Pending {
  /** The Proposal it is part of. */
  id: string;
  /** When it was asked for, or made, ISO 8601; null when the Mind doesn't say. */
  at: string | null;
  /** Who made it, for someone's change in a Word file (#108); otherwise IncarnaMind's. */
  by?: string;
}

/**
 * What changes still waiting do to some content, read for review
 * (`ReadOptions.review`): it is what one adds, or what one removes, or both
 * (words one adds that another removes).
 */
export interface Pendings {
  inserted?: Pending;
  deleted?: Pending;
}

export interface Image {
  src: string;
  alt: string;
}

/**
 * A Citation a calculated figure is worked out from (`labelledCitations`), with the input's label
 * or the range's name. A writer makes its footnote with `ReadOptions.footnote` only when it
 * writes it: Question context gives an id to each Citation it reads, and shows none of these.
 */
export interface FigureSource {
  label: string;
  citation: Citation;
  work: CitedWork;
}

export type Inline = (
  | {
      kind: "text";
      text: string;
      marks: Marks;
      /** AI text (`GENERATED_MARK`), when read for review. */
      ai?: true;
      sentenceCheck?: FailedSentence;
    }
  | { kind: "math"; latex: string }
  | { kind: "break" }
  | { kind: "citation"; footnote: Footnote; work: CitedWork }
  /**
   * A calculated figure (ADR-0021), written as `figure.shown` where a writer has nothing more to
   * show; `analysis` is the title of the saved Analysis it came from (#447). Its sources are null
   * when that Analysis isn't saved in the Note.
   */
  | {
      kind: "figure";
      figure: CalculatedFigure;
      sources: FigureSource[] | null;
      analysis: string | null;
    }
  /**
   * A footnote the User wrote, at its marker: its text. A Citation in it is
   * part of that text (written as its source), not a footnote of its own.
   */
  | { kind: "footnote"; content: Inline[] }
  | { kind: "image"; image: Image }
  /**
   * Citations written in a citation style (#289) by the exports (./exports/citations), never
   * read from a Mind: one Citation, or several side by side, in the text, or as a note.
   */
  | {
      kind: "cite";
      runs: StyledRun[];
      note: boolean;
      unverified: boolean;
      /** What it cites, as one key: the sources and places of its Citations. */
      of?: string;
      /** The footnotes of its Citations whose check failed. */
      failed?: Footnote[];
      /** As a note: its Citations' people's checks (`Footnote.checked`). */
      checked?: readonly string[];
    }
) &
  Pendings;

/** A Bibliography entry, as a citation style writes it: its number set apart, if any, then its text. */
export interface BibliographyItem {
  label: StyledRun[] | null;
  runs: StyledRun[];
  /** People's own checks of the source's Citations, a line each (`Footnote.checked`). */
  checked?: readonly string[];
}

export interface TableCell {
  header: boolean;
  /** How many columns the cell spans, from 1. */
  colspan: number;
  /** How many rows the cell spans, from 1. */
  rowspan: number;
  /** How its text is aligned; null: as the text flows. */
  align: TableAlign;
  content: Block[];
}

/**
 * One place in a row of a table laid out as Word and Markdown lay one out:
 * a cell where it starts, the cell again where it spans down from a row
 * above (`continued`), or null for a place no cell fills. A cell over
 * several columns takes one place: its `colspan` covers the rest.
 */
export interface TableSlot {
  cell: TableCell | null;
  continued: boolean;
}

export type Block = (
  | { kind: "paragraph"; content: Inline[]; format?: ParagraphFormat }
  | { kind: "heading"; level: number; content: Inline[]; format?: ParagraphFormat }
  | { kind: "code"; language: string; code: string }
  | { kind: "math"; latex: string }
  | {
      kind: "list";
      ordered: boolean;
      start: number;
      items: Block[][];
      /** A checklist's state, in the same order as its items; absent on ordinary lists. */
      checked?: boolean[];
    }
  | { kind: "quote"; content: Block[] }
  | { kind: "rule" }
  /**
   * A plain table, or a comparison table: `widths` gives each column's share
   * of the width in a writer that lays columns out unevenly, the Document
   * column first, as the User sized the columns on the page.
   */
  | { kind: "table"; rows: TableCell[][]; widths?: number[] }
  | { kind: "image"; image: Image }
  /**
   * A chart (#436): what it draws, for a picture of it; its values as a table,
   * the heading row first, without their Citations; and the places they were
   * quoted from, one Citation each, side by side, numbered with the Mind's
   * other footnotes. An export that draws its picture adds it as `picture`.
   */
  | {
      kind: "chart";
      chart: ChartAttributes;
      table: TableCell[][];
      sources: Inline[];
      uncited: number;
      picture?: Image;
    }
  | { kind: "question"; content: Inline[] }
  /** The Bibliography a citation style adds at the end of an export (./exports/citations). */
  | { kind: "bibliography"; heading: string; items: BibliographyItem[]; hangingIndent: boolean }
) &
  Pendings;

export interface ReadOptions {
  includeQuestions: boolean;
  /** The footnote for a Citation, from its node's attributes. */
  footnote(attributes: Record<string, unknown>): Footnote;
  /**
   * Drop the space the editor keeps before a Citation, or the User left before
   * a footnote, so that a footnote's number goes right after the word it
   * follows, as in print. Inside a footnote's text, spaces stay.
   */
  trimBeforeCitation: boolean;
  /**
   * Drop the space before a footnote but not before a Citation, whatever `trimBeforeCitation`
   * says: in a citation style (#289), a Citation may be words in the text, and the style
   * decides (./exports/citations).
   */
  trimBeforeFootnote?: boolean;
  /**
   * A comparison table's own words (#98): its first column's heading, and what a cell
   * without an Answer says. Absent: in English.
   */
  comparisonText?(key: MessageKey, params?: MessageParams): string;
  /** Whether a Document was deleted: its comparison table row says its source was removed. */
  documentRemoved?(documentId: string): boolean;
  /**
   * Whether a comparison table's hidden columns are read. An export leaves
   * them out, as the file is for someone who shouldn't see them; every other
   * reader keeps them, as hiding is display only.
   */
  leaveOutHiddenColumns?: boolean;
  /** People's marks on a comparison table's cell, as each shows now (#1933). Absent: none are read. */
  cellSignOffs?(target: SignOffTarget, cell: Y.XmlElement): SignOffNow[];
  /**
   * Read for a Word file's review (#107, see `reviewReading`): what changes still
   * waiting add is read too, and each part of one is marked (`Pendings`), and
   * AI text is marked `ai`. One of the AI's out of date is read as if it
   * weren't there, as accepting every change leaves it; someone's change from
   * the Word file stays theirs to resolve (#108). Or read with someone's
   * changes from a Word file as changes, and the AI's as everywhere else
   * (`theirChangesReading`, #734). Absent everywhere else: a change's words
   * aren't the Mind's until it is accepted.
   */
  review?: ReviewReading;
  /** The sentence checks that aren't good, by check id: their text is read with `sentenceCheck`. */
  sentenceChecks?: ReadonlyMap<string, FailedSentence>;
  /** Set by the reader in an Answer from before AI text was marked, which is the AI's as a whole. */
  wholeAnswerAi?: boolean;
}

/** What reading for review needs to know of a Mind's changes (`reviewReading`). */
export interface ReviewReading {
  /** Whether a change, by id, is read as if it weren't there: one of the AI's out of date. */
  skips(id: string): boolean;
  /** When a request's changes were made, and by whom if not by IncarnaMind. */
  made(request: string): Omit<Pending, "id">;
}

/** What a Mind's Blocks need for reading them for review (`ReadOptions.review`). */
export function reviewReading(blocks: Y.XmlFragment): ReviewReading {
  const { doc } = blocks;
  const stale = new Set(
    [...outOfDateProposals(blocks)].filter((id) => !id.startsWith(WORD_CHANGE_ID)),
  );
  return {
    skips: (id) => stale.has(id),
    made: (request) => madeBy(doc ? proposalRequestOf(doc, request) : null),
  };
}

/**
 * Reading a Mind with someone's changes from a Word file as changes (#734):
 * each part of one marked (`Pendings`), with who made it and when, for what
 * a model or a reader of an export is shown. The AI's changes still waiting
 * are read as everywhere else, as if they weren't there.
 */
export function theirChangesReading(doc: Y.Doc): ReviewReading {
  return {
    skips: (id) => !id.startsWith(WORD_CHANGE_ID),
    made: (request) => madeBy(proposalRequestOf(doc, request)),
  };
}

/** When a request's changes were made, and by whom if not by IncarnaMind: someone's from a Word file. */
export function madeBy(made: ProposalRequest | null): Omit<Pending, "id"> {
  if (made?.source === "word-change") return { at: made.date, by: made.author ?? "" };
  return { at: made?.createdAt ?? null };
}

/** The change a mark's or an attribute's value is part of, read for review; none if it is out of date. */
export function pendingOf(value: unknown, review: ReviewReading | undefined): Pending | undefined {
  const ref = review ? readProposalRef(value) : null;
  if (!review || !ref || review.skips(ref.id)) return undefined;
  return { id: ref.id, ...review.made(ref.request) };
}

/** Whether two things have the same changes still waiting. */
export const samePendings = (a: Pendings, b: Pendings): boolean =>
  a.inserted?.id === b.inserted?.id && a.deleted?.id === b.deleted?.id;

/** Whether a change is someone's, from the Word file the Mind was imported from (#108). */
export const isWordChange = (pending: Pending | undefined): pending is Pending =>
  pending?.id.startsWith(WORD_CHANGE_ID) === true;

const pendingIn = (value: unknown, options: ReadOptions) => pendingOf(value, options.review);

/**
 * What a change does to an element: null for one it adds that isn't read
 * (never, read for review, unless it is out of date).
 */
function changeOf(element: Y.XmlElement, options: ReadOptions): Pendings | null {
  const attribute = readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE));
  if (!attribute) return {};
  const pending = pendingIn(attribute, options);
  if (attribute.kind === "insert") return pending ? { inserted: pending } : null;
  return pending ? { deleted: pending } : {};
}

const withChange = <T extends object>(items: T[], change: Pendings): T[] =>
  change.inserted || change.deleted ? items.map((item) => ({ ...item, ...change })) : items;

/** A stretch of text with one set of marks, as `Y.XmlText.toDelta()` gives it. */
interface Run {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

/**
 * The Blocks in a Mind (or inside any element of it, such as an Answer), in
 * order. Answers are unwrapped into their Blocks.
 */
export function readBlocks(parent: Y.XmlFragment | Y.XmlElement, options: ReadOptions): Block[] {
  return readChildren(parent.toArray(), options);
}

/**
 * One Block (a Note, a Question, an Answer…) as the Blocks it reads as: an
 * Answer as its Blocks, and none for a Question that `includeQuestions` leaves out.
 */
export function readBlock(element: Y.XmlElement, options: ReadOptions): Block[] {
  const change = changeOf(element, options);
  return change ? withChange(readBlockElement(element, options), change) : [];
}

const hasTextChild = (children: readonly unknown[]): boolean =>
  children.some(
    (child) =>
      child instanceof Y.XmlText ||
      (child instanceof Y.XmlElement && child.nodeName === CALCULATED_FIGURE_NODE),
  );

/** The first stretch of text in an element: a list's first item, not all its items run together. */
function firstText(element: Y.XmlElement): string {
  const children = element.toArray();
  if (hasTextChild(children)) return plainText(element);
  for (const child of children) {
    if (!(child instanceof Y.XmlElement)) continue;
    const text = firstText(child);
    if (text.trim() !== "") return text;
  }
  return "";
}

/**
 * What a Mind without a title is called: its first line of text, cut as a title, whether
 * the User wrote it or the assistant did. Never an instruction typed to the assistant,
 * which the Blocks it wrote remember as their origin (#1174).
 * An Answer's text, or a comparison table's, is not the User's, so it isn't read.
 */
export function firstLineOf(blocks: Y.XmlFragment): string {
  for (const block of blocks.toArray()) {
    if (
      !(block instanceof Y.XmlElement) ||
      block.nodeName === ANSWER_BLOCK ||
      block.nodeName === COMPARISON_TABLE_NODE
    ) {
      continue;
    }
    const written = cutTitle(firstText(block));
    if (written !== "") return written;
  }
  return "";
}

/**
 * What a Mind's export file is called (#1945): the words of its first Block that has any, as it
 * reads, and the Question that made them when an Answer wrote them — a sentence from an Answer
 * says less about the note than the Question did. A heading is a title, so it names the file
 * itself. Neither is cut here: a file name is cut only where a file name can't hold it.
 */
export function namedLineOf(blocks: Y.XmlFragment): { line: string; question: string } {
  for (const block of blocks.toArray()) {
    if (
      !(block instanceof Y.XmlElement) ||
      block.nodeName === ANSWER_BLOCK ||
      block.nodeName === COMPARISON_TABLE_NODE
    ) {
      continue;
    }
    const line = firstText(block).trim();
    if (line === "") continue;
    const id = block.getAttribute(BLOCK_ID_ATTRIBUTE);
    const doc = blocks.doc;
    const question =
      block.nodeName === "heading" || typeof id !== "string" || doc === null
        ? ""
        : (originOf(doc, id)?.question.trim() ?? "");
    return { line, question };
  }
  return { line: "", question: "" };
}

/** How many Question Blocks the Mind has. */
export function countQuestions(blocks: Y.XmlFragment): number {
  return blocks
    .toArray()
    .filter((child) => child instanceof Y.XmlElement && child.nodeName === QUESTION_BLOCK).length;
}

/**
 * Every Citation's footnote in the Blocks, in order, those inside the User's footnotes too
 * unless `inFootnotes` is false: there a Citation is words of the note, with no marker.
 */
export function footnotesIn(
  blocks: readonly Block[],
  { inFootnotes = true }: { inFootnotes?: boolean } = {},
): Footnote[] {
  const found: Footnote[] = [];
  const inInline = (content: readonly Inline[]) => {
    for (const inline of content) {
      if (inline.kind === "citation") found.push(inline.footnote);
      else if (inline.kind === "footnote" && inFootnotes) inInline(inline.content);
    }
  };
  const visit = (block: Block) => {
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "question":
        inInline(block.content);
        break;
      case "list":
        for (const item of block.items) item.forEach(visit);
        break;
      case "quote":
        block.content.forEach(visit);
        break;
      case "table":
        for (const row of block.rows) for (const cell of row) cell.content.forEach(visit);
        break;
      case "chart":
        inInline(block.sources);
        break;
    }
  };
  blocks.forEach(visit);
  return found;
}

function readChildren(
  children: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[],
  options: ReadOptions,
): Block[] {
  const blocks: Block[] = [];
  for (const child of children) {
    if (child instanceof Y.XmlElement) {
      const change = changeOf(child, options);
      if (change) blocks.push(...withChange(readBlockElement(child, options), change));
    } else if (child instanceof Y.XmlText) {
      // Text straight in a Block container: keep it as a paragraph.
      const content = readInline([child], options);
      if (content.length > 0) blocks.push({ kind: "paragraph", content });
    }
  }
  return blocks;
}

/** A Block or inline node a Proposal adds, which isn't the Mind's until it is accepted. */
const proposedOnly = (element: Y.XmlElement) =>
  readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE))?.kind === "insert";

const INLINE_TYPES: ReadonlySet<string> = new Set([
  "inlineMath",
  "hardBreak",
  "image",
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  WORD_ATOM_NODE,
  DOCUMENT_CHIP_NODE,
]);

const hasBlockChildren = (element: Y.XmlElement) =>
  element
    .toArray()
    .some((child) => child instanceof Y.XmlElement && !INLINE_TYPES.has(child.nodeName));

function readBlockElement(element: Y.XmlElement, options: ReadOptions): Block[] {
  switch (element.nodeName) {
    case "paragraph":
      return [
        {
          kind: "paragraph",
          content: readInline(element.toArray(), options),
          ...formatOf(element),
        },
      ];
    case "heading": {
      const level = Math.min(Math.max(Number(element.getAttribute("level")) || 1, 1), 6);
      return [
        {
          kind: "heading",
          level,
          content: readInline(element.toArray(), options),
          ...formatOf(element),
        },
      ];
    }
    case "codeBlock":
      return [
        { kind: "code", language: stringAttribute(element, "language"), code: plainText(element) },
      ];
    case "blockMath":
      return [{ kind: "math", latex: stringAttribute(element, "latex") }];
    case "bulletList":
    case "taskList":
    case "orderedList": {
      const ordered = element.nodeName === "orderedList";
      const start = ordered
        ? Math.max(Math.trunc(Number(element.getAttribute("start"))) || 1, 0)
        : 1;
      const items = element
        .toArray()
        .filter((item): item is Y.XmlElement => item instanceof Y.XmlElement)
        .flatMap((item) => {
          const change = options.review ? changeOf(item, options) : undefined;
          if (options.review && !change) return [];
          const attributes: Record<string, unknown> = item.getAttributes();
          const checked = attributes.checked === true;
          const content = readChildren(item.toArray(), options);
          return [{ content: change ? withChange(content, change) : content, checked }];
        });
      return [
        {
          kind: "list",
          ordered,
          start,
          items: items.map((item) => item.content),
          ...(element.nodeName === "taskList" && { checked: items.map((item) => item.checked) }),
        },
      ];
    }
    case "blockquote":
      return [{ kind: "quote", content: readChildren(element.toArray(), options) }];
    case "horizontalRule":
      return [{ kind: "rule" }];
    case "table":
      return [{ kind: "table", rows: readTable(element, options) }];
    case COMPARISON_TABLE_NODE: {
      const comparison = readComparison(element, options);
      return [
        {
          kind: "table",
          rows: comparison.rows,
          ...(comparison.widths && { widths: comparison.widths }),
        },
      ];
    }
    case "image":
      return [{ kind: "image", image: readImage(element) }];
    case CHART_NODE:
      return [readChartBlock(element, options)];
    case WORD_BLOCK_NODE: {
      // Kept as is from a Word file: its text, a paragraph a line.
      const text = wordAtomText(readWordAtom(element.getAttributes() as Record<string, unknown>));
      return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => ({
          kind: "paragraph",
          content: [{ kind: "text", text: line, marks: NO_MARKS }],
        }));
    }
    case QUESTION_BLOCK:
      return options.includeQuestions
        ? [{ kind: "question", content: readInline(element.toArray(), options) }]
        : [];
    case ANSWER_BLOCK:
      return readChildren(
        element.toArray(),
        options.review &&
          (element.getAttributes() as Record<string, unknown>).generatedMarks !== true
          ? { ...options, wholeAnswerAi: true }
          : options,
      );
    default:
      // A node type this version doesn't know: its Blocks, or its text.
      if (hasBlockChildren(element)) return readChildren(element.toArray(), options);
      return [{ kind: "paragraph", content: readInline(element.toArray(), options) }];
  }
}

function readTable(table: Y.XmlElement, options: ReadOptions): TableCell[][] {
  const rows: TableCell[][] = [];
  const span = (cell: Y.XmlElement, name: string) =>
    Math.max(Math.trunc(Number(cell.getAttribute(name))) || 1, 1);
  for (const row of table.toArray()) {
    if (!(row instanceof Y.XmlElement)) continue;
    const cells: TableCell[] = [];
    for (const cell of row.toArray()) {
      if (!(cell instanceof Y.XmlElement)) continue;
      const align = cell.getAttribute("align");
      cells.push({
        header: cell.nodeName === "tableHeader",
        colspan: span(cell, "colspan"),
        rowspan: span(cell, "rowspan"),
        align: align === "left" || align === "center" || align === "right" ? align : null,
        content: readChildren(cell.toArray(), options),
      });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** A comparison table's cell as read: its Answer, or what it says in the Answer's place. */
export type ComparisonCellReading = (
  | { kind: "answer"; content: Block[]; failure?: string }
  | { kind: "words"; text: string }
  | { kind: "empty" }
) & { edited?: boolean; signOffs?: SignOffNow[] };

/** A comparison table as read (#98): its Questions, then a row per Document, a cell per Question. */
export interface ComparisonReading {
  /** The columns read, in their order: an export leaves out the hidden ones. */
  questions: ComparisonQuestion[];
  rows: {
    documentId: string;
    /** The Document's name, or that its source was removed. */
    name: string;
    cells: ComparisonCellReading[];
  }[];
}

export function readComparisonTable(table: Y.XmlElement, options: ReadOptions): ComparisonReading {
  const say = options.comparisonText ?? ((key, params) => translate("en", key, params));
  const columns = comparisonQuestionsOf(table.getAttributes());
  const questions = options.leaveOutHiddenColumns ? visibleComparisonQuestions(columns) : columns;
  const tableId = stringAttribute(table, "id");
  const rows: ComparisonReading["rows"] = [];
  for (const row of table.toArray()) {
    if (!(row instanceof Y.XmlElement) || row.nodeName !== COMPARISON_ROW_NODE) continue;
    const name = stringAttribute(row, "documentName");
    const documentId = stringAttribute(row, "documentId");
    const removed = options.documentRemoved?.(documentId) ?? false;
    const cells = new Map<string, Y.XmlElement>();
    for (const each of row.toArray()) {
      if (each instanceof Y.XmlElement) cells.set(stringAttribute(each, "questionId"), each);
    }
    rows.push({
      documentId,
      name: removed ? say("comparison.row.removed", { name }) : name,
      cells: questions.map((question): ComparisonCellReading => {
        const element = cells.get(question.id);
        if (!element) return { kind: "empty" };
        const state = comparisonCellOf(element.getAttributes());
        const signOffs =
          options.cellSignOffs?.(comparisonCellTarget(tableId, documentId, question.id), element) ??
          [];
        const marks = {
          ...(state.edited && { edited: true }),
          ...(signOffs.length > 0 && { signOffs }),
        };
        if (
          state.status === "done" ||
          (state.status === "failed" && plainText(element).trim() !== "")
        ) {
          const problem = state.problem ? cellProblemMessage(state.problem, state.message) : null;
          return {
            kind: "answer",
            content: readChildren(element.toArray(), options),
            ...marks,
            ...(state.status === "failed" &&
              problem && { failure: say(problem.key, problem.params) }),
          };
        }
        if (!state.problem) return { kind: "words", text: "…", ...marks };
        const { key, params } = cellProblemMessage(state.problem, state.message);
        return { kind: "words", text: say(key, params), ...marks };
      }),
    });
  }
  return { questions, rows };
}

/** How wide a comparison table's Document column and its default columns weigh in a file. */
const COMPARISON_DOCUMENT_WEIGHT = 150;
const COMPARISON_COLUMN_WEIGHT = 240;

/**
 * A comparison table as a table: a heading row ("Document", then its
 * Questions), then a row per Document, its name first, each cell its Answer,
 * or what it says in the Answer's place, and the widths it shows on the page.
 */
function readComparison(
  table: Y.XmlElement,
  options: ReadOptions,
): { rows: TableCell[][]; widths: number[] | undefined } {
  const say = options.comparisonText ?? ((key, params) => translate("en", key, params));
  const cell = (content: Block[], header = false): TableCell => ({
    header,
    colspan: 1,
    rowspan: 1,
    align: null,
    content,
  });
  const words = (text: string): Block[] => [
    { kind: "paragraph", content: [{ kind: "text", text, marks: NO_MARKS }] },
  ];
  const { questions, rows } = readComparisonTable(table, options);
  const widths = questions.some((question) => question.width !== undefined)
    ? [
        COMPARISON_DOCUMENT_WEIGHT,
        ...questions.map((question) => question.width ?? COMPARISON_COLUMN_WEIGHT),
      ]
    : undefined;
  return {
    widths,
    rows: [
      [
        cell(words(say("comparison.document")), true),
        ...questions.map((question) => cell(words(comparisonNameOf(question)), true)),
      ],
      ...rows.map((row) => [
        cell(words(row.name)),
        ...row.cells.map((each) =>
          cell(
            each.kind === "answer"
              ? [...each.content, ...(each.failure ? words(each.failure) : [])]
              : each.kind === "words"
                ? words(each.text)
                : [],
          ),
        ),
      ]),
    ],
  };
}

/**
 * A table's rows laid out (see `TableSlot`), and how many columns it has. A
 * cell that spans rows takes its place again in each row it reaches down to,
 * at its column; a row with too few cells to reach that column gets empty
 * places before it. Rows are as wide as their cells and continued cells make
 * them: a writer pads the rest out to `columns`.
 */
export function tableLayout(rows: readonly (readonly TableCell[])[]): {
  rows: TableSlot[][];
  columns: number;
} {
  /** The cells from rows above that still reach down, by the column they start at. */
  let reaching = new Map<number, { cell: TableCell; rows: number }>();
  const laidOut: TableSlot[][] = [];
  let columns = 1;
  for (const row of rows) {
    const slots: TableSlot[] = [];
    const next = new Map<number, { cell: TableCell; rows: number }>();
    let column = 0;
    /** Puts in the cells from above that reach down at `column`, or before `until`. */
    const continueFromAbove = (until: number) => {
      for (;;) {
        const above = reaching.get(column);
        const later = [...reaching.keys()].filter((at) => at >= column && at < until);
        if (!above && later.length === 0) return;
        if (!above) {
          slots.push({ cell: null, continued: false });
          column++;
          continue;
        }
        slots.push({ cell: above.cell, continued: true });
        if (above.rows > 1) next.set(column, { cell: above.cell, rows: above.rows - 1 });
        column += above.cell.colspan;
      }
    };
    for (const cell of row) {
      continueFromAbove(column + 1);
      slots.push({ cell, continued: false });
      if (cell.rowspan > 1) next.set(column, { cell, rows: cell.rowspan - 1 });
      column += cell.colspan;
    }
    continueFromAbove(Number.POSITIVE_INFINITY);
    reaching = next;
    laidOut.push(slots);
    columns = Math.max(columns, column);
  }
  return { rows: laidOut, columns };
}

function readChartBlock(element: Y.XmlElement, options: ReadOptions): Block {
  const chart = readChart(element.getAttributes() as Record<string, unknown>);
  const drawn = chosenSeries(chart);
  const cell = (text: string, header: boolean, align: TableAlign): TableCell => ({
    header,
    colspan: 1,
    rowspan: 1,
    align,
    content: [
      { kind: "paragraph", content: text ? [{ kind: "text", text, marks: NO_MARKS }] : [] },
    ],
  });
  const table: TableCell[][] = [
    [
      cell(chart.data.labelHeading, true, null),
      ...drawn.map((series) => cell(chart.data.series[series] ?? "", true, "right")),
    ],
    ...chart.data.rows.map((row) => [
      cell(row.label, false, null),
      ...drawn.map((series) => cell(row.values[series]?.shown ?? "", false, "right")),
    ]),
  ];
  const { places, uncited } = chartSources(chart);
  const sources: Inline[] = places.map(({ citation }) => {
    const attributes = citation as unknown as Record<string, unknown>;
    return {
      kind: "citation",
      footnote: options.footnote(attributes),
      work: citedWork(attributes),
    };
  });
  return { kind: "chart", chart, table, sources, uncited };
}

function readImage(element: Y.XmlElement): Image {
  return { src: stringAttribute(element, "src"), alt: stringAttribute(element, "alt") };
}

export const NO_MARKS: Marks = {
  bold: false,
  italic: false,
  strike: false,
  underline: false,
  highlight: false,
  code: false,
  link: null,
};

function formatOf(element: Y.XmlElement): { format?: ParagraphFormat } {
  const format = readParagraphFormat(element.getAttribute(PARAGRAPH_FORMAT_ATTRIBUTE));
  return Object.keys(format).length > 0 ? { format } : {};
}

const attributeOf = (mark: unknown, name: string): unknown =>
  isRecord(mark) ? mark[name] : undefined;

function marksOf(attributes: Record<string, unknown> = {}): Marks {
  const link = attributes.link as { href?: unknown } | undefined;
  const color = readTextColor(attributeOf(attributes[TEXT_COLOR_MARK], "color"));
  const font = readTextFont(attributeOf(attributes[TEXT_FONT_MARK], "family"));
  const size = readTextSize(attributeOf(attributes[TEXT_SIZE_MARK], "size"));
  const vertical = Object.hasOwn(attributes, SUPERSCRIPT_MARK)
    ? "superscript"
    : Object.hasOwn(attributes, SUBSCRIPT_MARK)
      ? "subscript"
      : null;
  return {
    bold: Object.hasOwn(attributes, "bold"),
    italic: Object.hasOwn(attributes, "italic"),
    strike: Object.hasOwn(attributes, "strike"),
    underline: Object.hasOwn(attributes, "underline"),
    highlight: Object.hasOwn(attributes, "highlight"),
    code: Object.hasOwn(attributes, "code"),
    link: link && typeof link.href === "string" && link.href !== "" ? link.href : null,
    ...(color && { color }),
    ...(font && { font }),
    ...(size && { size }),
    ...(vertical && { vertical }),
  };
}

/** Inline nodes as a paragraph's content reads: what a Word export writes new into an imported paragraph (#105). */
export const readInlineNodes = (
  children: readonly (Y.XmlElement | Y.XmlText)[],
  options: ReadOptions,
): Inline[] => readInline(children, options);

function readInline(
  children: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[],
  options: ReadOptions,
  inFootnote = false,
): Inline[] {
  const content: Inline[] = [];
  for (const child of children) {
    if (child instanceof Y.XmlText) {
      for (const run of child.toDelta() as Run[]) {
        const attributes = run.attributes ?? {};
        const inserted = pendingIn(attributes[PROPOSAL_INSERT_MARK], options);
        if (PROPOSAL_INSERT_MARK in attributes && !inserted) continue;
        if (typeof run.insert === "string" && run.insert !== "") {
          const deleted = pendingIn(attributes[PROPOSAL_DELETE_MARK], options);
          const ai =
            options.review !== undefined &&
            (options.wholeAnswerAi === true || GENERATED_MARK in attributes);
          const checkId = readClaimCheck(attributes[CLAIM_CHECK_MARK])?.id;
          const sentenceCheck =
            checkId === undefined ? undefined : options.sentenceChecks?.get(checkId);
          content.push({
            kind: "text",
            text: run.insert,
            marks: marksOf(run.attributes),
            ...(ai && { ai: true }),
            ...(sentenceCheck && { sentenceCheck }),
            ...(inserted && { inserted }),
            ...(deleted && { deleted }),
          });
        }
      }
    } else if (child instanceof Y.XmlElement) {
      const change = changeOf(child, options);
      if (change) readInlineElement(child, options, inFootnote, content, change);
    }
  }
  return content;
}

/** An inline node, read into `content`, with what a change still waiting does to it. */
function readInlineElement(
  child: Y.XmlElement,
  options: ReadOptions,
  inFootnote: boolean,
  content: Inline[],
  change: Pendings,
): void {
  const add = (inline: Inline) => content.push({ ...inline, ...change });
  switch (child.nodeName) {
    case CALCULATED_FIGURE_NODE: {
      const attributes = readCalculatedFigureAttributes(child.getAttributes());
      if (attributes) add(readFigure(attributes, child.doc));
      break;
    }
    case "inlineMath":
      add({ kind: "math", latex: stringAttribute(child, "latex") });
      break;
    case "hardBreak":
      add({ kind: "break" });
      break;
    case "image":
      add({ kind: "image", image: readImage(child) });
      break;
    case WORD_ATOM_NODE: {
      const atom = readWordAtom(child.getAttributes() as Record<string, unknown>);
      // A Word file's footnote reads as a footnote, as one the User wrote does.
      if ((atom.kind === "footnote" || atom.kind === "endnote") && !inFootnote && atom.text) {
        if (options.trimBeforeFootnote ?? options.trimBeforeCitation) trimTrailingSpace(content);
        add({ kind: "footnote", content: [{ kind: "text", text: atom.text, marks: NO_MARKS }] });
        break;
      }
      const text = wordAtomText(atom);
      if (text) add({ kind: "text", text, marks: NO_MARKS });
      break;
    }
    case CITATION_NODE: {
      if (options.trimBeforeCitation && !inFootnote) trimTrailingSpace(content);
      const attributes = child.getAttributes() as Record<string, unknown>;
      add({
        kind: "citation",
        footnote: options.footnote(attributes),
        work: citedWork(attributes),
      });
      break;
    }
    case FOOTNOTE_NODE: {
      // A footnote in a footnote, which the editor never makes, is read as its text.
      if (inFootnote) {
        const text = plainText(child, true);
        if (text) add({ kind: "text", text, marks: NO_MARKS });
        break;
      }
      if (options.trimBeforeFootnote ?? options.trimBeforeCitation) trimTrailingSpace(content);
      add({ kind: "footnote", content: readInline(child.toArray(), options, true) });
      break;
    }
    case DOCUMENT_CHIP_NODE: {
      // A Document the User named: its name, as text.
      const name = stringAttribute(child, "name");
      if (name) add({ kind: "text", text: name, marks: NO_MARKS });
      break;
    }
    default: {
      // Inline content this version doesn't know: its text.
      const text = plainText(child);
      if (text) add({ kind: "text", text, marks: NO_MARKS });
    }
  }
}

function readFigure(attributes: CalculatedFigureAttributes, doc: Y.Doc | null): Inline {
  const { figure } = attributes;
  let sources: CalculatedSources;
  try {
    sources = calculatedSources(attributes, doc);
  } catch {
    // Its saved Analysis is gone: it still reads as its text, and an export that would write its
    // sources says they aren't available, as the editor does (`error.figure.evidenceMissing`).
    return { kind: "figure", figure, sources: null, analysis: null };
  }
  return {
    kind: "figure",
    figure,
    sources: labelledCitations(sources).map(({ label, citation }) => ({
      label,
      citation,
      work: citedWork({ ...citation }),
    })),
    analysis: sources.analysis?.title ?? null,
  };
}

/** What a citation style needs of a Citation: its Document, its Location and the version quoted. */
function citedWork(attributes: Record<string, unknown>): CitedWork {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  return {
    documentId: text(attributes.documentId),
    documentName: text(attributes.documentName),
    location: citationLocation(attributes),
    contentHash: text(attributes.contentHash),
  };
}

/** Drops the space the editor keeps before a Citation (see `ReadOptions.trimBeforeCitation`). */
export function trimTrailingSpace(content: Inline[]): void {
  const last = content.at(-1);
  if (last?.kind !== "text") return;
  const text = last.text.replace(/[ \t ]+$/, "");
  if (text) content[content.length - 1] = { ...last, text };
  else content.pop();
}

function stringAttribute(element: Y.XmlElement, name: string): string {
  const value = element.getAttribute(name);
  return typeof value === "string" ? value : "";
}

/**
 * A Block's words, as search reads them: each paragraph, heading, list item or
 * cell on a line of its own, so words of two lines never run together, and a
 * footnote's text on the line after the one its marker is in. What a Proposal
 * adds is left out, as everywhere.
 */
export function blockText(element: Y.XmlElement): string {
  const lines: string[] = [];
  const visit = (node: Y.XmlElement) => {
    if (proposedOnly(node)) return;
    const children = node.toArray();
    if (!hasTextChild(children)) {
      for (const child of children) if (child instanceof Y.XmlElement) visit(child);
      return;
    }
    lines.push(plainText(node));
    for (const child of children) {
      if (child instanceof Y.XmlElement && child.nodeName === FOOTNOTE_NODE && !proposedOnly(child))
        lines.push(plainText(child, true));
    }
  };
  visit(element);
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** The start of a Mind's text, Block by Block, at least `length` characters of it when it has them. */
export function textStart(blocks: Y.XmlFragment, length: number): string {
  let text = "";
  for (const block of blocks.toArray()) {
    if (text.length >= length) break;
    if (block instanceof Y.XmlElement) text += `${blockText(block)}\n`;
  }
  return text;
}

/**
 * All the text in an element, without marks or structure. A footnote's text
 * isn't part of the line its marker is in, so it is left out, unless `footnotes`.
 */
export function plainText(element: Y.XmlElement | Y.XmlText, footnotes = false): string {
  if (element instanceof Y.XmlText) {
    return (element.toDelta() as Run[])
      .map((run) =>
        typeof run.insert === "string" &&
        !(run.attributes && PROPOSAL_INSERT_MARK in run.attributes)
          ? run.insert
          : "",
      )
      .join("");
  }
  if (!footnotes && element.nodeName === FOOTNOTE_NODE) return "";
  if (element.nodeName === CALCULATED_FIGURE_NODE) return figureShownText(element.getAttributes());
  if (element.nodeName === WORD_ATOM_NODE || element.nodeName === WORD_BLOCK_NODE) {
    return wordAtomText(readWordAtom(element.getAttributes() as Record<string, unknown>));
  }
  // A Document chip is the User's words for a Document: its name is part of the line.
  if (element.nodeName === DOCUMENT_CHIP_NODE) return stringAttribute(element, "name");
  return element
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText || (child instanceof Y.XmlElement && !proposedOnly(child))
        ? plainText(child, footnotes)
        : "",
    )
    .join("");
}
