import type { Extensions, NodeViewRenderer } from "@tiptap/core";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Highlight from "@tiptap/extension-highlight";
import { TaskList } from "@tiptap/extension-list";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import UniqueID from "@tiptap/extension-unique-id";
import StarterKit from "@tiptap/starter-kit";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  COMPARISON_TABLE_NODE,
  FOOTNOTE_NODE,
  GENERATED_MARK,
  NOTE_BLOCK_TYPES,
  QUESTION_BLOCK,
} from "../../../core/api";
import { translate } from "../../../shared/i18n";
import { Generated } from "./aiText";
import { CalculatedFigure, FigureTableRoles } from "./calculatedFigureSchema";
import { Chart } from "./chartSchema";
import { checklistItem } from "./checklistItem";
import { Citation } from "./citationSchema";
import { ClaimCheck } from "./claimChecks";
import { lowlight } from "./codeLanguages";
import { ComparisonCell, ComparisonRow, ComparisonTable } from "./comparisonSchema";
import { ComparisonStructureLock } from "./comparisonStructureLock";
import { DocumentChip } from "./documentChipSchema";
import { Footnote } from "./footnoteSchema";
import {
  ParagraphFormatAttribute,
  Subscript,
  Superscript,
  TextColor,
  TextFont,
  TextSize,
} from "./formatSchema";
import { Numbering } from "./numbering";
import { PageBreak } from "./pageBreakSchema";
import { Picture } from "./pictureSchema";
import { ProposalAttributes, ProposalDelete, ProposalInsert } from "./proposalSchema";
import { Answer, MindDocument, Question, QuestionContextFlag } from "./questionSchema";
import { TableOfContents } from "./tableOfContents";
import {
  InlineImage,
  WordAtom,
  WordBlock,
  WordLookAttribute,
  WordLookTableView,
  WordRun,
} from "./wordSchema";
import { WordTab } from "./wordTabs";

/** The attribute each Block keeps its UUID in. It is stored in the Mind's Yjs document. */
export { BLOCK_ID_ATTRIBUTE };

/**
 * The node types a top-level Block can be: a Note's, a Question or an Answer.
 * UniqueID gives every node of these types a UUID as it is created, and keeps
 * it when the Block is edited, turned into another type or dragged. It can't
 * tell top-level nodes from nested ones, so paragraphs inside lists, quotes
 * and Answers get an ID too; only top-level IDs name Blocks. Footnotes and
 * calculated figures get one too, across edits and sync; a pasted copy gets a new one.
 */
const BLOCK_TYPES: readonly string[] = [
  ...NOTE_BLOCK_TYPES,
  QUESTION_BLOCK,
  ANSWER_BLOCK,
  COMPARISON_TABLE_NODE,
];

/** The node types that hold a formula, written in LaTeX. */
export const MATH_TYPES: readonly string[] = ["blockMath", "inlineMath"];

export interface NoteSchemaOptions {
  checklistLabel?: (text: string) => string;
  /** Called with a formula's position when it is clicked, to edit it. */
  onEditMath?: (pos: number) => void;
  /** Draws code blocks, e.g. with a language picker. */
  codeBlockView?: NodeViewRenderer;
  /** Draws Questions, e.g. with a model picker. */
  questionView?: NodeViewRenderer;
  /** Draws Answers, e.g. with their status and a stop button. */
  answerView?: NodeViewRenderer;
  /** Draws Citations, e.g. as badges that open the cited page. */
  citationView?: NodeViewRenderer;
  /** Draws calculated figures and their numbered markers. */
  calculatedFigureView?: NodeViewRenderer;
  /** Draws the markers of the User's footnotes, e.g. as numbers that open their text. */
  footnoteView?: NodeViewRenderer;
  /** Draws Document chips, e.g. as names that open the Document. */
  documentChipView?: NodeViewRenderer;
  /** Draws charts, with their menus and their points' cards. */
  chartView?: NodeViewRenderer;
  /** Draw comparison tables (#98): the table with its heading row, each row's Document, each cell's state. */
  comparisonViews?: {
    table: NodeViewRenderer;
    row: NodeViewRenderer;
    cell: NodeViewRenderer;
  };
  /** Draws what a Word import kept as it is (#104): in the text, and as Blocks. */
  wordAtomView?: NodeViewRenderer;
  wordBlockView?: NodeViewRenderer;
  /** Draws page breaks as a line across the text (#746). */
  pageBreakView?: NodeViewRenderer;
  /** Draws a table of contents (#1935). */
  tableOfContentsView?: NodeViewRenderer;
  /** Draws a picture pasted into the Note, with the alt text the User writes (#1937). */
  pictureView?: NodeViewRenderer;
}

/**
 * What a Mind can hold, and how it is stored. Notes: headings, bold, italic,
 * underline, links, strikethrough, highlight, lists, code blocks highlighted
 * by lowlight, inline and block math rendered by KaTeX, and tables, each with
 * an "include in Question context" flag. Questions and Answers, top-level
 * only. Document chips the User writes with "@". Citations, inline in Answers and in whatever they are copied into,
 * table cells included. Calculated figures, inline, each keeping its inputs and result.
 * Footnotes the User writes, inline, each holding its
 * text. Charts, drawn from a table or from cited figures, each value with its
 * Citation (#436). Pictures the User pasted or dropped, as Blocks of their own, with their alt
 * text (#1937). Comparison tables, top-level only (#98). What a Word
 * import kept as it is, and its inline pictures (#104), and the file's look
 * (see `wordSchema`). Page breaks (#746). Paragraph formatting, and text colour, font, size and raise (see
 * `formatSchema`).
 * Proposals the AI made, waiting for the User (see `proposalSchema`).
 * AI text, the words the AI wrote that the User hasn't made their own (see `aiText`).
 * The checks of the User's own sentences, on their text (see `claimChecks`).
 * Every Block, footnote and calculated figure has a UUID. The editor adds its interface on
 * top (collaboration, menus, the drag handle, smart typography); tests use
 * this alone.
 */
export function noteExtensions({
  checklistLabel = (text) => text.trim() || translate("en", "editor.checklist.empty"),
  onEditMath,
  codeBlockView,
  questionView,
  answerView,
  citationView,
  calculatedFigureView,
  footnoteView,
  documentChipView,
  chartView,
  comparisonViews,
  wordAtomView,
  wordBlockView,
  pageBreakView,
  tableOfContentsView,
  pictureView,
}: NoteSchemaOptions = {}): Extensions {
  const onClick = onEditMath && ((_node: unknown, pos: number) => onEditMath(pos));
  const CodeBlock = CodeBlockLowlight.extend({
    // No formatting in code, but code the AI wrote is AI text all the same.
    marks: GENERATED_MARK,
    ...(codeBlockView && { addNodeView: () => codeBlockView }),
  });

  return [
    StarterKit.configure({
      // MindDocument takes Questions and Answers as well as Notes.
      document: false,
      codeBlock: false,
      // Collaboration brings its own undo, which only undoes this client's changes.
      undoRedo: false,
      // It would add a paragraph to Minds that end in another Block just by opening them.
      trailingNode: false,
      // A click puts the cursor in a link and shows its address with Open, Edit and Remove (LinkBubble).
      link: { openOnClick: false },
      // Shows where a dragged Block will land.
      dropcursor: { color: "rgb(14 165 233)", width: 2 },
    }),
    MindDocument,
    ComparisonStructureLock,
    Numbering,
    // One colour: a `highlight` mark with no attributes. Mod-Shift-H, or `==text==` typed or pasted.
    Highlight,
    CodeBlock.configure({ lowlight }),
    BlockMath.configure({ katexOptions: { displayMode: true, throwOnError: false }, onClick }),
    InlineMath.configure({ katexOptions: { throwOnError: false }, onClick }),
    // Columns size to their text: dragging their edges would need a way by keyboard too.
    // Tab and Shift-Tab move between cells; Tab in the last cell adds a row.
    // A checklist: its items hold a box and Blocks, as list items do.
    TaskList,
    checklistItem(checklistLabel),
    Table.configure({ resizable: false, View: WordLookTableView }),
    TableRow,
    TableHeader,
    TableCell,
    Question.configure({ view: questionView ?? null }),
    Answer.configure({ view: answerView ?? null }),
    Citation.configure({ view: citationView ?? null }),
    CalculatedFigure.configure({ view: calculatedFigureView ?? null }),
    FigureTableRoles,
    Footnote.configure({ view: footnoteView ?? null }),
    DocumentChip.configure({ view: documentChipView ?? null }),
    Chart.configure({ view: chartView ?? null }),
    TableOfContents.configure({ view: tableOfContentsView ?? null }),
    Picture.configure({ view: pictureView ?? null }),
    ComparisonTable.configure({ view: comparisonViews?.table ?? null }),
    ComparisonRow.configure({ view: comparisonViews?.row ?? null }),
    ComparisonCell.configure({ view: comparisonViews?.cell ?? null }),
    WordAtom.configure({ view: wordAtomView ?? null }),
    WordBlock.configure({ view: wordBlockView ?? null }),
    InlineImage,
    PageBreak.configure({ view: pageBreakView ?? null }),
    WordLookAttribute,
    WordRun,
    WordTab,
    ParagraphFormatAttribute,
    TextColor,
    TextFont,
    TextSize,
    Superscript,
    Subscript,
    QuestionContextFlag,
    // Proposals waiting for the User: words struck and added, and whole Blocks (#93).
    ProposalInsert,
    ProposalDelete,
    ProposalAttributes,
    Generated,
    ClaimCheck,
    UniqueID.configure({
      attributeName: BLOCK_ID_ATTRIBUTE,
      types: [...BLOCK_TYPES, FOOTNOTE_NODE, CALCULATED_FIGURE_NODE],
    }),
  ];
}
