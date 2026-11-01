import type {
  AssignmentChange,
  AssignmentState,
  DocumentBatch,
  DocumentGroupAssignment,
  LibraryClassifier,
  LibraryGroup,
  LibraryGroupInput,
  LibrarySettings,
  LibrarySnapshot,
  TaggingClassifier,
  TaggingFlow,
  TaggingModels,
  TaggingRoute,
} from "./library/types";
import type { Localized } from "./providers/catalog/types";
import type { UiUsageEvent } from "./usageEvents";

export type {
  AssignmentChange,
  AssignmentState,
  AutomaticTaggingReason,
  ClassificationStatus,
  DocumentBatch,
  DocumentGroupAssignment,
  DocumentTagging,
  LibraryClassifier,
  LibraryGroup,
  LibraryGroupInput,
  LibrarySettings,
  LibrarySnapshot,
  TaggingClassifier,
  TaggingCost,
  TaggingDestination,
  TaggingFlow,
  TaggingModelGroup,
  TaggingModelOption,
  TaggingModels,
  TaggingRoute,
} from "./library/types";

/**
 * The core's public interface: the only API the UI uses.
 *
 * The preload script exposes it to the renderer over IPC, and the tests drive it
 * directly. Everything that crosses it is plain data, so it survives IPC.
 *
 * This file must stay free of imports with side effects: the preload script and
 * the renderer import it.
 */
import type {
  AnalysisEnd,
  AnalysisLanguage,
  AnalysisOutput,
  AnalysisRecalculation,
  AnalysisUnavailableReason,
  AnalysisValue,
  AnalysisVersions,
} from "../shared/analysis";
import type { CitationForm, CitationStyleId, StyleCatalogue } from "../shared/citationStyles";
import type { DrawnPage } from "../shared/citedPage";
import type { ClaimCheckShown } from "../shared/claimChecks";
import type { CommandId, CommandTarget, OfferedCommand, Yours } from "../shared/commands";
import type { FigureFooting } from "../shared/figureFooting";
import type { Figure } from "../shared/figures";
import type { FormulaInput, FormulaLiteral, ResultUnit, ShowAs } from "../shared/formula";
import type { HelpKeys, MeetingHelpKind, MeetingHelpTemplate } from "../shared/meetingHelp";
import type { ChineseScript } from "../shared/meetingWords";
import type { MindStyle } from "../shared/mindStyle";
import type { TagColour } from "../shared/tagColours";
import type { Anchor, UnitKind, UnitLabel } from "../shared/units";
import type { ErrorWording } from "./errors";
import type { Language, LanguagePreference } from "./language";

export interface Mind {
  /** A random UUID generated on this device. */
  id: string;
  /** The title the User typed. May be empty: the Mind is then named by `autoTitle`. */
  title: string;
  /** The Mind's first line of text, cut as a title; empty for a Mind with no text. */
  autoTitle: string;
  /**
   * What the Mind is: a `MindKind` this version knows, or the name of a kind a
   * newer version wrote, which is listed but not opened (see `MindAccess`).
   */
  kind: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
  /**
   * The Folder (an in-app one, a `LibraryGroup`) the Mind belongs to, or null:
   * Not in a Folder. A Mind in a Folder starts each Question with the Folder
   * as its Search scope while the Folder holds a Document, and searches every
   * Document while it holds none, as one in no Folder does (#1359).
   */
  folderId: string | null;
}

/**
 * The kinds of Mind this version opens. Sheets, decks and boards may come later; the
 * assistant's conversations are not Minds (ADR-0017).
 */
export const MIND_KINDS = ["mind"] as const;
export type MindKind = (typeof MIND_KINDS)[number];

/** The kind of every Mind made before kinds existed, and of a new Mind by default. */
export const DEFAULT_MIND_KIND: MindKind = "mind";

export interface CreateMindInput {
  title?: string;
  /**
   * Its text starts with its title as a Heading 1, as a Mind made with its
   * name does (#908); with no title, an empty one, its title to be typed.
   */
  headed?: boolean;
  /** Defaults to `"mind"`. */
  kind?: MindKind;
  /** The Folder to make it in; none, or null: Not in a Folder. */
  folderId?: string | null;
}

/**
 * The newest content schema this version understands: the node types, marks
 * and attributes a Mind's Yjs document may hold. Raise it when a change would
 * make an older version lose or misread content (a new node type or mark, a
 * new attribute); a Mind without a recorded version is version 1.
 *
 * - 1: Notes, Questions, Answers and Citations.
 * - 2: tables (`table`, `tableRow`, `tableHeader` and `tableCell`, whose cells
 *   keep `colspan`, `rowspan`, `colwidth` and `align`). Version 1 content is
 *   version 2 content as it is: nothing is rewritten, and a Mind records 2
 *   once this version writes to it.
 * - 3: footnotes the User writes (`FOOTNOTE_NODE`, with an `id`). Version 2
 *   content is version 3 content as it is: nothing is rewritten, and a Mind
 *   records 3 once this version writes to it.
 * - 4: Proposals waiting for the User (#93): the `proposalInsert` and
 *   `proposalDelete` marks on text, and the `proposal` attribute on Blocks and
 *   on inline nodes (see `PROPOSAL_ATTRIBUTE`). Older content is version 4
 *   content as it is: nothing is rewritten.
 * - 5: a Proposal records the text it changes (#94): `target` on its marks
 *   and its `proposal` attributes (see `ProposalRef`), so it goes out of date
 *   once that text changes. Version 4 Proposals have none and never go out
 *   of date: nothing is rewritten.
 * - 7: charts (`CHART_NODE`, #436): a Block that draws values from a table
 *   or from cited figures, each kept with its Citation. Older content is
 *   version 7 content as it is: nothing is rewritten. A version before 7
 *   opens a Mind with a chart read-only, as its editor would drop the chart.
 * - 8: a Document chip the User writes with "@" (`DOCUMENT_CHIP_NODE`), and
 *   checklists (`taskList` and `taskItem`, whose items keep `checked`). Older
 *   content is version 8 content as it is: nothing is rewritten.
 * - 11: AI text (#95): the `generated` mark on the words the AI wrote, in
 *   code blocks too, and `generatedMarks` on Answers whose words carry it
 *   (see `GENERATED_MARK`). Older content is version 11 content as it is:
 *   nothing is rewritten, and an Answer without `generatedMarks` is the AI's
 *   as a whole, as it always was.
 * - 14: a chart value's scale (#579): `scale` beside `unit` on each value in
 *   a chart's `data`, so a number with no unit or scale isn't drawn among
 *   "$… million". An older version keeps it while it changes a chart's kind,
 *   columns or title, but its Update writes the values again without it.
 *   Older charts are version 14 content as they are: a value with no `scale`
 *   is one whose scale isn't known, and nothing is rewritten.
 * - 15: what a Word import keeps as it is (`WORD_ATOM_NODE`, `WORD_BLOCK_NODE`,
 *   #104) and pictures in the text (`IMAGE_NODE`). Older content is version 15
 *   content as it is: nothing is rewritten.
 * - 16: the rows a cut chart doesn't draw (#503): `cutRows` beside `rows`
 *   in a chart's `data`, which Show as table lists. An older version keeps
 *   them while it changes a chart's kind, columns or title, but its Update
 *   writes the data again without them. Older charts are version 16 content
 *   as they are: one with no `cutRows` lists the rows it draws, and nothing
 *   is rewritten.
 * - 17: comparison tables (#98): `COMPARISON_TABLE_NODE`, `COMPARISON_ROW_NODE`
 *   and `COMPARISON_CELL_NODE`. Older content is version 17 content as it is:
 *   nothing is rewritten.
 * - 18: checks of the User's own sentences (#96): the `claimCheck` mark on a
 *   sentence's text, which holds its result (see `CLAIM_CHECK_MARK`). Older
 *   content is version 18 content as it is: nothing is rewritten.
 * - 19: contradiction watch (#112): "contradiction-watch", a third `action`
 *   of the `claimCheck` mark. An older version reads it as Find support, so
 *   its Check again would check the sentence against the very Documents it
 *   cites. Older content is version 19 content as it is: nothing is rewritten.
 * - 20: someone's tracked changes in an imported Word file, as Proposals
 *   (#108): their requests are `WordChangeRequest`s, which name the change's
 *   author and date. A version before 20 would take them for the
 *   assistant's, and count what accepting one keeps as AI text. Older
 *   content is version 20 content as it is: nothing is rewritten.
 * - 21: a Word file's look (#746): the `wordLook` attribute and the
 *   `wordRun` mark, which an older version's editor would strip. Older
 *   content is version 21 content as it is.
 * - 22: the assistant's own waiting Blocks a revision replaced, kept in
 *   `MIND_REVISIONS_FIELD` so rejecting the revision brings them back. An
 *   older version would reject it and lose them. Older content is version
 *   22 content as it is.
 * - 23: the `wordTab` mark on a Word file's tab characters (#746), which an
 *   older version's editor would strip. Older content is version 23 content
 *   as it is.
 * - 24: paragraph formatting (#912): the `paragraphFormat` attribute
 *   (`ParagraphFormat`), and the `textColor`, `textFont`, `textSize`,
 *   `superscript` and `subscript` marks, which an older version's editor
 *   would strip. A Word file's direct formatting is read into them (the look
 *   keeps what its styles give, `WORD_LOOK_VERSION` 6). Older content is
 *   version 24 content as it is.
 * - 25: a check the User keeps as their own view (#1111): `kept` on the
 *   `claimCheck` mark, and the `unsupported` reason a check gives (#1072),
 *   which an older version's editor would strip, so the sentence would count
 *   and be checked again. Older content is version 25 content as it is.
 * - 26: a check made in the Search scope the User set for the Mind (#1623):
 *   `chosen` in the `claimCheck` mark's `scope`. An older version would read
 *   it as made in the Mind's Folder or in every Document, and say so on its
 *   card. Older content is version 26 content as it is.
 * - 27: a numbered list's scheme, start level and continuation (#1419): the
 *   `numbering`, `startLevel` and `continues` attributes on an ordered list,
 *   which an older version's editor would strip, so it would draw the list as
 *   a "1. a. i." list from level 0 that starts again. Older content is
 *   version 27 content as it is.
 * - 28: a Citation the User keeps on the version it quotes though its
 *   Document changed (#99): `keptOver` on the Citation, which an older
 *   version's editor would strip, so it would ask again to be checked. Older
 *   content is version 28 content as it is.
 * - 29: whether a check found a Passage about the sentence that doesn't back
 *   it (#1608): `found` in the `claimCheck` mark's `unsupported` reason, which
 *   an older version's editor would strip, so its card would say Not found.
 *   Older content is version 29 content as it is.
 * - 30: a comparison table's columns have a `label` of their own, beside
 *   their Question (#1833), and room for their `width` and whether they are
 *   `hidden`. An older version's editor writes the columns back without
 *   these when it changes one, so it opens these Minds read-only. Older
 *   content is version 30 content as it is.
 * - 31: Notes own calculated figure nodes, bounded Analysis run dependencies
 *   and the figures within their sentence's Check (#439, #1932). Older
 *   editors would discard those nodes and check attributes, so they open
 *   these Notes read-only. Existing content needs no conversion.
 * - 32: a Citation has an `id` of its own, given as it is written (an older
 *   one on its Note's first edit), and the Note holds people's "Checked by me"
 *   marks on Citations and figures (`MIND_SIGN_OFFS_FIELD`, #1933). An older
 *   editor would strip the ids and leave the marks on nothing, so it opens
 *   these Notes read-only. Existing content needs no conversion.
 * - 33: a comparison table has a `title` of its own (#1837), its name in the
 *   title line and on its Excel file and sheet. An older version's editor
 *   writes the table back without it when it changes it, so it opens these
 *   Notes read-only. Older content is version 33 content as it is, its table
 *   called "Comparison table" until the User names it.
 * - 34: a comparison cell records a hand edit (`edited`) and the refill pass
 *   allowed to write it (`fillId`, #1836); people's "Checked by me" marks on
 *   cells are records of kind "cell" in `MIND_SIGN_OFFS_FIELD`. An older editor
 *   would strip the attributes, so it opens these Notes read-only. Older
 *   content is version 34 content as it is.
 * - 35: ordered factual and opinion parts inside a sentence's `claimCheck`
 *   mark, the opinions a check left out (`opinionSentences`) and the parts in
 *   the verification record (#2002). Older editors strip the part ranges and
 *   their evidence when saving marked words, so these Notes open read-only
 *   there. Older content is version 35 content as it is.
 * - 36: the individual record cites in a sentence's check (#1709): their raw
 *   text, outcome, resolved Document/version/Location, passage and any
 *   candidates or nearby suggestion. An older editor would drop them, so it
 *   opens these Notes read-only. Existing content needs no conversion.
 * - 37: `readDocuments` on a `claimCheck` mark (#1443): the whole Documents
 *   read to decide an absence sentence, which an older editor would strip,
 *   losing both the card's Locations and the dependency that makes a changed
 *   Document need a re-check. Older content is version 37 content as it is.
 * - 38: a table of contents Block (#1935). An older editor would drop it when
 *   it saves the Note, so it opens these Notes read-only. Existing content is
 *   version 38 content as it is.
 * - 39: a check against a Document the User picked, read whole (#1554):
 *   "check-against-document" and `read` on its mark, recording exactly how
 *   much was read. An older version would treat it as a search and check it
 *   again. Older content is version 39 content as it is.
 * - 40: `currencyClause` on a `claimCheck` mark's `parts` (#2226): the card's
 *   one line naming the Document clause that says which dollar a bare "$" is,
 *   which an older editor would strip, losing the line the card shows. Older
 *   content is version 40 content as it is.
 * - 41: the `picture` Block (#1937), a picture the User pasted or dropped,
 *   kept in the Note's data with its size and alt text. An older editor would
 *   drop it when it saves the Note, so it opens these Notes read-only. Older
 *   content is version 41 content as it is.
 * - 42: a Word file's footnotes and endnotes are the Note's own footnotes
 *   (#746): `FOOTNOTE_NODE` gains `source` and `endnote`, and its text may hold
 *   what the import keeps as is (`WORD_ATOM_NODE`); page breaks are
 *   `PAGE_BREAK_NODE`, in every Note; a column break is an atom of its own
 *   kind. An older version's editor would strip the attributes and the node,
 *   so it opens these Notes read-only. A Note imported before keeps its
 *   read-only notes and breaks until it is opened, when they are converted
 *   from its kept package (`convertWordParts`). What the import keeps as is
 *   gains `hash`, of the file's XML at its place.
 * - 43: a chart's value drawn from a calculated figure keeps the figure, its
 *   formula and every Input with its Citation (`figure` on the value in the
 *   chart's `data`, #2307). An older version's editor reads chart data without
 *   it and writes it back so when it changes the chart, leaving bare numbers,
 *   so it opens these Notes read-only. Older content is version 43 content as
 *   it is: a chart drawn before holds no figure, and its values read as
 *   quoted until Update draws it again from its table.
 * - 44: a confirmed contradiction's correction (#1481): `correction` on a
 *   contradicted part of a `claimCheck` mark (and on its figure or remainder)
 *   holds the exact old words and up to two Document wordings with their
 *   Citations, which an older editor would strip. Older content is version 44
 *   content as it is.
 * - 45: a calculated figure worked out from a workbook's own formulas keeps
 *   `workbook` (#2347): its cell, formula chain, saved value and a what-if's
 *   changed input, with no formula of its own. An older version's reader
 *   refuses a figure with no formula and no Analysis, so it opens these
 *   Notes read-only. Older content is version 45 content as it is.
 * - 46: an Analysis figure's kept value names the rows of the input it was
 *   worked out from (`of` on a value of the Note's Analysis records, #2346):
 *   which rows and columns, and for `figure()` how IncarnaMind worked it out
 *   again. An older version would keep the record again without it, so it
 *   opens these Notes read-only.
 *   Older content is version 46 content as it is: a figure kept before names
 *   no rows.
 */
export const CONTENT_SCHEMA_VERSION = 46;

/**
 * The key, in the Mind's settings map (`MIND_SETTINGS_FIELD`), of the content
 * schema version the Mind was last written with. The core records it on every
 * write; it is never lowered.
 */
export const CONTENT_SCHEMA_VERSION_KEY = "schemaVersion";

/**
 * How a Mind opens:
 * - "edit": as usual.
 * - "read-only": a newer version wrote its content (`CONTENT_SCHEMA_VERSION`).
 *   The editor's Yjs binding deletes node types, marks and attributes its
 *   schema doesn't know, so the Mind is shown but never written to, by the
 *   editor or the core, until IncarnaMind is updated.
 * - "update-required": its kind is one this version doesn't know. It is not
 *   shown in the editor, only a prompt to update.
 */
export type MindAccess = "edit" | "read-only" | "update-required";

/** A place in a Mind that a reference points to: a Block. Sheets, decks and boards add their own. */
export interface BlockAnchor {
  kind: "block";
  /** The Block's stable UUID (`BLOCK_ID_ATTRIBUTE`), never its position. */
  blockId: string;
}

/** A place in a conversation that a reference points to: one of its messages, a Question or an Answer. */
export interface MessageAnchor {
  kind: "message";
  messageId: string;
}

/**
 * One reference from one artifact to another (ADR-0003, ADR-0017): a Block's
 * origin, or the link back from a Note to the Answer in the conversation it
 * came from. A Mind's anchor is a Block, a conversation's a message.
 */
export type ArtifactReference =
  | { artifactKind: "mind"; artifactId: string; anchor: BlockAnchor }
  | { artifactKind: "conversation"; artifactId: string; anchor: MessageAnchor };

/**
 * Where a reference leads now (`CoreApi.resolveReference`): to its artifact, there to
 * open (a Mind's Block isn't looked for: it may have been removed since); to one in
 * Recently deleted, which restoring brings back; or nowhere, when it was deleted
 * permanently, or its message is gone, or it was never on this computer. `name` is the
 * artifact's name, "" when it has none (the UI says "Untitled" or "New chat").
 */
export type ReferenceTarget =
  | { status: "available"; reference: ArtifactReference; name: string }
  | { status: "deleted"; reference: ArtifactReference; name: string; deletedAt: string }
  | { status: "gone"; reference: ArtifactReference };

/**
 * What to move into a Folder, or out of every Folder (`folderId` null: Not
 * in a Folder): Minds, Documents and conversations, any number of each, in one go.
 */
export interface FolderMoveInput {
  mindIds?: string[];
  documentIds?: string[];
  conversationIds?: string[];
  folderId: string | null;
  /**
   * The Folder wall the assistant moves for, given by its commands (null: outside every wall). The
   * walls are judged again here, at the move, so a Folder that gained a wall since the command was
   * checked takes nothing; left out, the User moves anywhere (#2250).
   */
  wall?: string | null;
}

/** One thing a move moved, and the Folder it was in before (null: none), so the move can be undone. */
export interface MovedItem {
  id: string;
  from: string | null;
}

/**
 * What a move did: each Mind, Document and conversation it moved, with where it
 * was. Those already in the Folder are listed too, with the Folder as `from`.
 * Undoing moves each Mind and conversation back to its `from`, and puts back
 * each Document's `change`.
 */
export interface FolderMove {
  folderId: string | null;
  minds: MovedItem[];
  documents: MovedDocument[];
  conversations: MovedItem[];
}

/** A Document a move moved, with its place and tagging before and after, for `restoreAssignment`. */
export interface MovedDocument extends MovedItem {
  change: AssignmentChange;
}

/**
 * The name of the Y.XmlFragment that holds a Mind's Blocks in its Yjs document
 * (ADR-0003). The editor binds to it, and the core reads it.
 */
export const MIND_CONTENT_FIELD = "blocks";

/**
 * The name of the Y.Map that holds a Mind's own choices in its Yjs document,
 * beside its Blocks, so they go wherever the Mind goes: the model its next
 * Questions are asked with (see `src/shared/mindModel.ts`). A Mind written
 * before has none, and uses the defaults.
 */
export const MIND_SETTINGS_FIELD = "settings";

export const MIND_FIGURE_RUNS_FIELD = "figureRuns";

/**
 * The name of the Y.Map, beside a Mind's Blocks, that holds the User's own "Checked by me"
 * marks (#1933), by record id: what a person checked, apart from the app's check, so the
 * marks go and sync with the Note. See src/shared/signOffs.ts.
 */
export const MIND_SIGN_OFFS_FIELD = "signOffs";

/** What a person checked (#1933): a Citation by its own id, a figure by its id, a comparison cell. */
export interface SignOffTarget {
  kind: "citation" | "figure" | "cell";
  id: string;
}

/** A person's own "Checked by me" on an item (#1933), as it shows now: never a check result. */
export interface SignOffNow {
  /** Changed: what they checked changed since, so it no longer counts as checked. */
  state: "checked" | "changed";
  /** When they checked it (ISO 8601, UTC). */
  at: string;
  /** Their name as it was when they checked it. */
  name: string | null;
  /** The User's own, not another person's. */
  mine: boolean;
  /** What the mark was made on: for a figure an edit gave a new id, its id before. */
  target: SignOffTarget;
}

/**
 * The name of the Y.Map, beside a Mind's Blocks, that says where Blocks came
 * from: by Block id, a `BlockOrigin`. A Note added from an Answer in the
 * assistant (#201) keeps its link back to that Answer here, not in the Block's
 * attributes, which an older version's editor would strip. A Block deleted
 * since leaves its entry unused. See src/shared/blockOrigins.ts.
 */
export const MIND_ORIGINS_FIELD = "origins";

/** Where a Block came from: a Note added from an Answer links back to it. */
export interface BlockOrigin {
  /** The Answer, in its conversation (`messageReference`). */
  from: ArtifactReference;
  /** The Question it answered, as asked: shown with the link, even once the conversation is gone. */
  question: string;
}

/** The attribute every Block keeps its UUID in, in the Mind's Yjs document. */
export const BLOCK_ID_ATTRIBUTE = "id";

/**
 * Proposals (CONTEXT.md): changes the AI made to a Mind that wait for the
 * User to accept or reject them, stored in the Mind's Yjs document so they
 * survive sync and reload (see `src/shared/proposals.ts`, which reads and
 * resolves them). Each Proposal is one change in one place, and carries
 * `ProposalRef`:
 *
 * - words it adds are text under the `proposalInsert` mark, and words it
 *   removes stay, under the `proposalDelete` mark, until it is resolved;
 * - a whole Block it adds or removes, and an inline node (a Citation, a
 *   formula, a line break) it adds or removes, has the `proposal` attribute,
 *   a `ProposalAttribute` (the editor's binding keeps no marks on nodes).
 *
 * Until it is accepted a Proposal isn't part of the Mind: what reads the
 * Mind's text (Question context, exports, copying, the word count) leaves its
 * new words out and keeps the words it would remove. It is out of date once
 * the text it changes has changed (`target`): the words it removes were
 * edited, partly deleted, or had words typed between them, or the Block it
 * removes was edited. One out of date can't be accepted, only rejected or
 * made again (regenerated) from the text as it is now.
 */
export const PROPOSAL_INSERT_MARK = "proposalInsert";
export const PROPOSAL_DELETE_MARK = "proposalDelete";
export const PROPOSAL_ATTRIBUTE = "proposal";

/**
 * AI text (CONTEXT.md): the words the AI wrote into a Mind that the User
 * hasn't made their own, under this mark, with no attributes. Answers,
 * Answers added to a note, the words a Proposal adds (kept once it is
 * accepted) and accepted suggestions carry it; Citations, formulas, charts
 * and inline code can't. It isn't inclusive, and what the User types is never
 * under it, even inside AI text; "Mark as mine" takes it off. An Answer
 * carries it only when `AnswerAttributes.generatedMarks` says so: an older
 * Answer is AI text as a whole. Readers and exports treat it as no mark.
 */
export const GENERATED_MARK = "generated";

/**
 * A check of a sentence the User wrote (#96): Check against Documents puts
 * this mark on the sentence's text, with the result as its
 * attributes (`ClaimCheckAttributes`). It isn't inclusive, so words typed
 * after the sentence aren't under it. Whether it still holds is worked out
 * from what it records (`claimCheckShown` in src/shared/claimChecks.ts).
 * Readers and exports treat it as no mark.
 */
export const CLAIM_CHECK_MARK = "claimCheck";

/** Which Proposal a mark or attribute belongs to. */
export interface ProposalRef {
  /** The Proposal's random UUID: what is accepted or rejected on its own. */
  id: string;
  /**
   * What asked for it: one Edit with AI, one Regenerate of an Answer the User
   * edited, or (later) one reply of the assistant. Its Proposals are accepted
   * or rejected together from there, and `MIND_PROPOSAL_REQUESTS_FIELD` says
   * which model made them.
   */
  request: string;
  /**
   * A hash of the text it changes as it was when it was made (`targetHash` in
   * src/shared/proposals.ts): its removed words, an inline node as U+FFFC, or
   * the whole Block it removes; the hash of "" for one that only adds. Every
   * part of the Proposal carries it. Absent on Proposals made before version 5,
   * which are never out of date.
   */
  target?: string;
}

/** The `proposal` attribute of a Block or an inline node: it adds it, or removes it. */
export interface ProposalAttribute extends ProposalRef {
  kind: "insert" | "delete";
}

/**
 * The name of the Y.Map, beside a Mind's Blocks, that says what made each
 * request's Proposals (`ProposalRequest`, by `ProposalRef.request`): kept
 * once written, so accepting a Proposal on any device can say which model
 * wrote it.
 */
export const MIND_PROPOSAL_REQUESTS_FIELD = "proposalRequests";

/**
 * The name of the Y.Map, beside a Mind's Blocks, that keeps the top-level
 * Blocks each revision of the assistant's own waiting changes replaced, and
 * the id of the Block before them, by the revising request: rejecting all of
 * that request, or writing its Answer again, puts them back as they were
 * (`restoreRevised`); accepting any of it lets them go.
 */
export const MIND_REVISIONS_FIELD = "revisions";

/**
 * The name of the Y.Map, beside a Mind's Blocks, that keeps by request the origin
 * (`MIND_ORIGINS_FIELD`) each Block had before that request's change gave it its own: a change
 * written over Blocks keeps their ids, so rejecting it in a Block puts that origin back
 * (`restoreOrigins`). Entries are kept for good: History can bring back a version from
 * before any decision. An older version leaves it as it is and keeps the new origin (ADR-0003).
 */
export const MIND_REPLACED_ORIGINS_FIELD = "replacedOrigins";

/**
 * What a change the assistant made in a Mind was (#880, #1559): text changed
 * ("make it longer") or written ("write a summary page"); such a change applies
 * at once, with Undo. Absent: one that waits for the User, such as a revision
 * of the assistant's own changes still waiting.
 */
export type RequestedChange = "edit" | "write";

/**
 * What made a request's Proposals: Edit with AI (#93), with what it was asked
 * so a change can be made again (regenerated) once it is out of date;
 * Regenerate of an Answer the User had edited (#94); an Answer from the
 * assistant added to a new Mind, as changes to accept (#201); or Compare
 * Documents, whose comparison table is one change (#98); or a Research
 * Task's cited draft (#130). The assistant (#202) and Enhance (#114) add theirs.
 */
export type ProposalRequest =
  | (ProposalMaker & {
      source: "edit-with-ai";
      requested?: RequestedChange;
      /** Absent on requests made before #94: their changes can't be regenerated. */
      action?: EditAction;
      /** What the User asked for ("translate", "instruction"); "" for none. */
      instruction?: string;
      /** Why the model changed the text, in its few words (#202); absent when it didn't say. */
      reason?: string;
    })
  | (ProposalMaker & { source: "answer"; answerId: string })
  | (ProposalMaker & {
      source: "answer-added";
      requested?: RequestedChange;
      action?: EditAction;
      instruction?: string;
    })
  | (ProposalMaker & { source: "comparison-table"; tableId: string })
  | (ProposalMaker & { source: "research"; taskId: string })
  | OutsideAgentRequest
  | WordChangeRequest;

/**
 * Changes an outside agent proposed over MCP on its own (#352, ADR-0026 decision 4a): the
 * agent's name as the User named its pairing, and the pairing. No model is named: IncarnaMind
 * can't tell which one the agent used.
 */
export interface OutsideAgentRequest {
  source: "outside-agent";
  agent: string;
  pairingId: string;
  /** ISO 8601, UTC. */
  createdAt: string;
}

/** The start of the id of someone's tracked change imported from a Word file (`WordChangeRequest`). */
export const WORD_CHANGE_ID = "word:";

/**
 * Someone's tracked change in a Word file, imported as a Proposal (#108):
 * who made it and when, as the file says. Its Proposal's id is "word:" and
 * the place of the change's element in the main part ("word:w:del#4"), the
 * same each time the file is read, so export finds it in the file again.
 */
export interface WordChangeRequest {
  source: "word-change";
  /** The author the file names; null when it names none. */
  author: string | null;
  /** When it was made, ISO 8601; null when the file doesn't say. */
  date: string | null;
}

/** The model that made a request's Proposals, and when. */
export interface ProposalMaker {
  providerId: string;
  modelId: string;
  /** ISO 8601, UTC. */
  createdAt: string;
}

/**
 * Why a Checkpoint (CONTEXT.md) was saved: just before an AI change
 * (accepting changes, Regenerate, Enhance, a comparison table going in,
 * accepting someone else's changes from a Word file), just before restoring
 * another one, as the Note was sent as Word or PDF ("export", #1933), or once
 * the Mind had been left alone for `CHECKPOINT_IDLE_MS` ("idle"). Only idle
 * ones the User hasn't named thin out as they age (all for a day, then one an
 * hour for a week, one a day for 90 days, then one a week); the others are
 * kept for good.
 */
export const CHECKPOINT_REASONS = [
  "accept",
  "regenerate",
  "enhance",
  "compare",
  "others",
  "restore",
  "export",
  "idle",
] as const;
export type CheckpointReason = (typeof CHECKPOINT_REASONS)[number];

/** How long a Mind goes unchanged before an idle Checkpoint is saved. */
export const CHECKPOINT_IDLE_MS = 5 * 60_000;

/** A saved copy of a Mind (CONTEXT.md, Checkpoint). Its content stays in the core. */
export interface Checkpoint {
  id: string;
  mindId: string;
  reason: CheckpointReason;
  /** When it was saved (ISO 8601, UTC). */
  createdAt: string;
  /** The name the User gave it ("Filed draft"); null for none. */
  name: string | null;
  /** For one saved as the Note was sent ("export"): the file's name, "Credit paper.docx". */
  file: string | null;
}

/** A Checkpoint just named, and the name it had until then, which Undo gives back. */
export interface RenamedCheckpoint {
  checkpoint: Checkpoint;
  was: string | null;
}

/** A Mind's Checkpoints, as History lists them. */
export interface CheckpointList {
  /** Newest first. */
  checkpoints: Checkpoint[];
  /** The Checkpoint that holds the Mind exactly as it is now, if one does: only the newest can. */
  current: string | null;
}

/** Two versions of a Mind to compare: a Checkpoint, and another one or (`to` null) the Mind now. */
export interface CompareCheckpointsInput {
  mindId: string;
  from: string;
  to: string | null;
}

/** Whether a part of a version is in both, only in the earlier one, or only in the later one. */
export type ComparedChange = "same" | "removed" | "added";

/**
 * A part of a Block as History compares it: words, a Citation (named by its
 * Document and Location), or a footnote the User wrote (its text). Marks such
 * as bold aren't compared.
 */
export type ComparedPart =
  | { kind: "text"; text: string; change: ComparedChange }
  | { kind: "citation"; work: CitedWork; change: ComparedChange }
  | { kind: "footnote"; text: string; change: ComparedChange };

/**
 * A Block of one version, as History shows it. An Answer is its Blocks; a list
 * is its items; a table or a chart is its text, row by row (a line each, its
 * cells split by " · "). Empty paragraphs aren't compared.
 */
export interface ComparedBlock {
  kind:
    | "paragraph"
    | "heading"
    | "question"
    | "item"
    | "quote"
    | "code"
    | "math"
    | "rule"
    | "table"
    | "chart"
    | "image";
  /** A heading's level, from 1; a list item's depth, from 1; else 0. */
  level: number;
  /** A list item's bullet ("•") or number ("3."); "" for anything else, a later paragraph of an item too. */
  marker: string;
  parts: ComparedPart[];
}

/**
 * One row of a comparison: a Block of the earlier version beside its
 * counterpart in the later one. A Block only one version has leaves the other
 * side null. `changed` rows are those whose sides differ.
 */
export interface ComparisonRow {
  left: ComparedBlock | null;
  right: ComparedBlock | null;
  changed: boolean;
}

/** Two versions of a Mind side by side, in the order of their Blocks. */
export interface MindComparison {
  rows: ComparisonRow[];
  /** How many rows changed: none when the two versions read the same. */
  changes: number;
}

/** What restoring a Checkpoint did: it saved the Mind as it was, which restoring takes the restore back. */
export interface RestoredCheckpoint {
  before: Checkpoint;
  /** How many Citations the User checked the restored text doesn't hold (#1933). */
  checkedLeftOut: number;
}

/**
 * The node types of a Note: any top-level Block that isn't a Question or an
 * Answer. Answers hold the same types, nested.
 */
export const NOTE_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "codeBlock",
  "blockMath",
  "bulletList",
  "orderedList",
  "blockquote",
  "taskList",
  "horizontalRule",
  "table",
  "chart",
  "tableOfContents",
  "picture",
  "wordBlock",
] as const;

/** A table of contents (#1935): a Block drawn from the Note's headings, and Word's own in a .docx. */
export const TABLE_OF_CONTENTS_NODE = "tableOfContents";

/** The node type of a Question Block. Its content is the User's text (inline). */
export const QUESTION_BLOCK = "question";

/** The node type of an Answer Block. Its content is rich text (Note node types), which the User can edit. */
export const ANSWER_BLOCK = "answer";

/**
 * A comparison table (CONTEXT.md, #98): a top-level Block holding one row per
 * Document and, in each row, one cell per Question (`ComparisonTableAttributes`).
 */
export const COMPARISON_TABLE_NODE = "comparisonTable";
/** A comparison table's row: one Document (`ComparisonRowAttributes`), its cells in the columns' order. */
export const COMPARISON_ROW_NODE = "comparisonRow";
/**
 * A comparison table's cell: the Answer to its column's Question from its
 * row's Document alone, Citations and all (Note node types), or why there is
 * none (`ComparisonCellAttributes`).
 */
export const COMPARISON_CELL_NODE = "comparisonCell";

/** A comparison table's column: its Question, and its own heading when it has one. */
export interface ComparisonQuestion {
  /** A random UUID: what each row's cell for this column names. */
  id: string;
  text: string;
  /** Its heading, which starts as its Question shortened; absent: the Question shortened. */
  label?: string;
  /** Its width in the table, in pixels; absent: the table's own. */
  width?: number;
  /** Whether the table draws it; absent: it does. */
  hidden?: boolean;
}

/** Attributes of a comparison table's Block, as stored in the Mind's Yjs document. */
export interface ComparisonTableAttributes {
  id: string | null;
  /** Its own name, kept with the Mind and naming the Excel file and sheet; absent: "Comparison table". */
  title?: string | null;
  /** Its columns, in order. */
  questions: ComparisonQuestion[];
  /** The model its cells are written with; both null: the default model. */
  providerId: string | null;
  modelId: string | null;
  /** What else the User asked the table to show, for every cell; null for nothing. */
  instruction: string | null;
}

/** Attributes of a comparison table's row. */
export interface ComparisonRowAttributes {
  documentId: string;
  /** The Document's name when the table was made: shown once the Document is deleted. */
  documentName: string;
}

/**
 * Where a cell is: waiting for its turn, being written, written (its content
 * is its Answer), or without an Answer (`problem` says why). A cell left
 * "waiting" or "writing" by a fill that ended (a quit, or the table rejected
 * and brought back) is stopped: filling the table again writes it.
 */
export type ComparisonCellStatus = "waiting" | "writing" | "done" | "failed";

/**
 * Why a cell has no Answer: its Document doesn't answer the Question
 * ("not-found"), has no text to search, was deleted, is a file
 * IncarnaMind wrote, which checks leave out (#80), or is one the User keeps as
 * their own workings, which Answers never cite; its Answer gave an amount at
 * another scale than its Citation's Document ("scale-changed", #1798; `message`
 * is the amount as the Document gives it); or why its model didn't write one
 * (a `ProviderErrorKind`). "cost-cap" and "plan-limit" stopped the fill
 * (`RunStop`): the cell wasn't checked.
 */
export type ComparisonProblem =
  | "not-found"
  | "scale-changed"
  | "nothing-to-search"
  | "source-removed"
  | "left-out"
  | "not-cited"
  | ProviderErrorKind;

/** Attributes of a comparison table's cell. */
export interface ComparisonCellAttributes {
  questionId: string;
  status: ComparisonCellStatus;
  /** The User changed this Answer by hand; absent: written by the model. */
  edited?: boolean | null;
  /** Derived from the Note's cell sign-off records; never stored on the cell. */
  reviewed?: boolean | null;
  /** The refill pass allowed to write this cell; absent: the ordinary initial fill. */
  fillId?: string;
  problem: ComparisonProblem | null;
  /** The provider's own message for a failure, or what the model said when the Document doesn't answer. */
  message: string | null;
  /** "plan-limit": when the plan's limit resets (ISO 8601), when the provider says. */
  resetsAt: string | null;
}

/**
 * A Note's "include in Question context" flag. Absent (or null) means on, the
 * default; `false` means the User switched the Note off, so Questions don't see it.
 */
export const INCLUDE_IN_CONTEXT_ATTRIBUTE = "includeInContext";

/**
 * Where text someone other than the User wrote came from (third-party text,
 * CONTEXT.md; ADR-0013, #78):
 * - "imported": imported from a file someone else wrote, such as a .docx
 *   carrying their tracked changes (#104);
 * - "web-page": a saved web page (#261): Passages a search found in one, or a
 *   quote added from one (#101);
 * - "checked-document": the document a check reads to check it (#97, #110);
 * - "outside-agent": text an outside agent proposed for a Note (#352).
 */
export type ThirdPartySource = "imported" | "web-page" | "checked-document" | "outside-agent";

/**
 * Third-party text a Run reads itself: a saved web page a search found, the
 * document a check checks, or what another Mind holds that came from them
 * (`read_mind`, #202).
 */
export type ReadThirdPartySource = ThirdPartySource;

/**
 * Why a Run counts as having read third-party text: it read some itself, or
 * its Question context holds some (a Block or an Answer with a third-party
 * origin), in the Mind a Question in a conversation read ("mind") or
 * otherwise ("context"). Such a Run asks before a write or a send that a
 * Tool-level "always" would otherwise let through (see `ApprovalRequest.thirdParty`).
 */
export type ThirdPartyReason =
  | { via: "read"; source: ReadThirdPartySource }
  | { via: "context" | "mind"; source: ThirdPartySource };

/**
 * The name of the Y.Map, beside a Mind's Blocks, that says which Blocks hold
 * third-party text: a `ThirdPartySource` by Block id (`BLOCK_ID_ATTRIBUTE`),
 * for top-level Blocks and Blocks nested in them alike. An Answer written in
 * a Run that had read third-party text is in it too. Kept beside the Blocks,
 * not in their attributes, so an older version's editor, which strips
 * attributes it doesn't know, leaves it as it is (see `src/shared/textOrigins.ts`).
 * A Block deleted since leaves its entry unused.
 */
export const MIND_TEXT_ORIGINS_FIELD = "textOrigins";

/**
 * The name of the Y.Map, beside a Mind's Blocks, that says when in its Meeting
 * each line was written (#139): the Meeting's time in ms, by Block id. A map
 * rather than a Block attribute, for the reason `MIND_TEXT_ORIGINS_FIELD` is
 * (see `src/shared/blockTimes.ts`), so the content schema version stays as it is.
 */
export const MIND_BLOCK_TIMES_FIELD = "blockTimes";

/**
 * The name of the Y.Map, beside a Mind's Blocks, that lists the files a
 * check's scope couldn't read when it started, by the request that made the
 * checks (`ClaimCheckAttributes.request`). A request that read everything has
 * no entry (ADR-0003).
 */
export const MIND_CHECK_UNREAD_FIELD = "checkUnread";

/**
 * A Question's Search scope (CONTEXT.md): the Folders, Tags and individual
 * Documents its Document search is limited to. It covers every Document in
 * one of the Folders or their sub-Folders (at any depth), every Document with
 * one of the Tags, and each of the Documents. Those deleted since are ignored.
 * With all three empty there is no Search scope: every Document is searched.
 */
export interface SearchScope {
  folderIds: string[];
  tagIds: string[];
  documentIds: string[];
}

/**
 * Attributes of a Question Block, as stored in the Mind's Yjs document.
 */
export interface QuestionAttributes {
  id: string | null;
  /** The model picked for this Question, overriding the default. Both null: the default model. */
  providerId: string | null;
  modelId: string | null;
  /**
   * Its Search scope (see `SearchScope`), as lists of ids: the User types "@"
   * in the Question to choose them. Null (or empty) for none of that kind;
   * all three null: no Search scope.
   */
  scopeFolderIds: string[] | null;
  scopeTagIds: string[] | null;
  scopeDocumentIds: string[] | null;
  /**
   * The name of the Skill the User forced on this Question from the slash
   * menu: its instructions are loaded up front. Null: the model picks Skills
   * itself. A name rather than an id, so a Skill removed and imported again
   * still matches.
   */
  forcedSkill: string | null;
}

/** Where an Answer is: being written, finished, stopped by the User, or failed (see `errorKind`). */
export type AnswerStatus = "streaming" | "done" | "stopped" | "failed";

/**
 * How the model behind an Answer gives the records of its Citations:
 * - "tools": through the `cite` Tool, in a Tool-calling loop that searches the Documents;
 * - "structured-output": the model can't call Tools, so the core searches once with the
 *   Question's text and the model returns the Answer and its records as one JSON object;
 * - "none": the model can do neither, so its Answers have no Citations, and say so.
 */
export type CitationSupport = "tools" | "structured-output" | "none";

/** Attributes of an Answer Block, as stored in the Mind's Yjs document. */
export interface AnswerAttributes {
  id: string | null;
  /** The Question it answers. */
  questionId: string | null;
  /** The model that wrote it. */
  providerId: string | null;
  modelId: string | null;
  status: AnswerStatus;
  /** Why it failed, when `status` is "failed". */
  errorKind: ProviderErrorKind | null;
  /** The provider's own message about the failure, for details. */
  errorMessage: string | null;
  /** When the plan's limit that stopped it resets (ISO 8601), when the provider said. */
  errorResetsAt: string | null;
  errorSignInRoute: SignInRouteProblem | null;
  /** A fingerprint of the content as it was generated: it differs once the User edits the Answer. */
  generatedHash: string | null;
  /**
   * True on an Answer written since content schema version 11: its AI text
   * carries `GENERATED_MARK`, and the rest is the User's. Null on an older
   * Answer, which is AI text as a whole.
   */
  generatedMarks: boolean | null;
  /**
   * How the model could give Citations (see `CitationSupport`). Null until the
   * model has answered, when there were no Documents to search, and on Answers
   * written before Citations.
   */
  citationSupport: CitationSupport | null;
  /** The Tools the Answer called, in order: a JSON array of `AnswerToolCall`. Null when none. */
  toolCalls: string | null;
}

/** A Tool the model called while writing an Answer, e.g. a search of the User's Documents. */
export interface AnswerToolCall {
  /** Unique within its Answer. */
  id: string;
  /**
   * "search_documents": the document-search Tool. "use_skill": loading a
   * Skill's instructions (`{ name }`). "read_skill_file": reading one of a
   * Skill's files (`{ skill, path }`). "run_skill_script": running one of a
   * Skill's scripts (`{ skill, script, args }`, see `script`). A Connector's
   * Tool: its name as the Connector gives it, e.g. "search_issues".
   */
  tool: string;
  /**
   * Where the Tool comes from: "documents" is IncarnaMind's own document
   * search; "skill", the Skill Tools; "connector", one of the User's
   * Connectors (see `connector`); "sources", Find sources (`find_sources`,
   * `{ query, from_year?, to_year?, open_access_only? }`); "web", web search
   * (`search_web`, `{ query }`, and `read_web_page`, `{ url, query }`; #128);
   * "minds", the Minds' Tools of an Answer in the assistant (#202:
   * `read_mind`, `edit_mind`, `add_to_mind`, `create_mind`, see `mindChange`); "commands",
   * the commands it runs for the User (#1110: `list_commands`, `run_command`, see `command`);
   * "asks", a question it asked the User (#1374: `ask_user`, see `asked`).
   * "analysis", `run_analysis` (#447, see `analysis`).
   */
  source:
    | "documents"
    | "skill"
    | "connector"
    | "sources"
    | "web"
    | "minds"
    | "commands"
    | "asks"
    | "analysis";
  /** A Connector's Tool: which Connector, with its name when the call was made. */
  connector?: { id: string; name: string };
  /** What the model asked, e.g. `{ query }` for a search, or the arguments sent to a Connector. */
  input: Record<string, unknown>;
  /**
   * "failed" also covers a call the User didn't allow (see `approval`): it
   * never ran. A Skill script is "done" only when it ran and exited with 0.
   */
  status: "running" | "done" | "failed";
  /**
   * A call that asked the User first (see `ApprovalRequest`): a Connector's
   * Tool, or a Skill script. "waiting" while the Answer waits for them;
   * "allowed" once they allowed it (once, or always); "denied" when they
   * denied it, or the Answer stopped (or IncarnaMind closed) before they
   * decided, so it never ran. Absent when it didn't ask: its Connector says
   * it only reads, the User always allows the Tool, or always runs the Skill's scripts.
   */
  approval?: ToolCallApproval;
  /** A search: how many Passages it gave the model. Null otherwise, and while running. */
  resultCount: number | null;
  /**
   * A search: the Passages it found, by id (`Citation.passageId`), so the
   * Citations it led to can be told. Absent on searches made before #391.
   */
  passages?: string[];
  /** A search that failed: why, sorted as an Answer's own failure is. Absent otherwise. */
  error?: ProviderError;
  /**
   * "use_skill" only: the Question forced this Skill, so the core loaded it up
   * front instead of the model calling the Tool. Absent otherwise.
   */
  forced?: boolean;
  /**
   * Not a call: the note that a remote Connector waits for the User to sign
   * in again, so its Tools weren't offered to this Answer (`tool` is
   * "sign_in", `status` "failed"). Absent otherwise.
   */
  signInRequired?: boolean;
  /**
   * "run_skill_script" only: how the run went once it ended, or why the
   * script couldn't run. Absent while it runs, and when it never did (denied).
   */
  script?: SkillScriptRun;
  /**
   * "read_web_page" only, once it ended: the page saved as a Document, or
   * why it couldn't be ("Couldn't save <url>: <reason>").
   */
  webPage?: WebPageCall;
  /**
   * "calculate" only, one call for all of an Answer's figures: `resultCount`
   * is how many it shows; this, how many of its figure markers had none, and
   * were left out of its text. Absent: none.
   */
  uncalculated?: number;
  /** A Minds' Tool that changed a Mind or made one, once it ended (#202). Absent otherwise. */
  mindChange?: MindChange;
  /** A Minds' Tool that changed nothing: why, as its card says. Absent otherwise. */
  mindProblem?: MindProblem;
  /** "run_analysis" only, once it ran: which of the Answer's Analyses, and what its step says. */
  analysis?: AnalysisCall;
  /** `list_commands`, once it ended: the Documents or Minds it found (#1110). Absent otherwise. */
  found?: CommandsFound;
  /** `run_command`, once it ran: what it changed, from what the command returned (#1110). */
  command?: CommandDone;
  /** `run_command` that changed nothing: why (#1110). Absent otherwise. */
  commandProblem?: CommandProblem;
  /** `ask_user`: the question, and the User's answer once they gave it (#1374). */
  asked?: UserQuestion;
}

/** One of the choices in a question the assistant asks the User (#1374). */
export interface UserQuestionOption {
  label: string;
  /** One line that says what choosing it means; empty: none. */
  description: string;
  /** The one the assistant would go with; at most one option is. */
  recommended: boolean;
  /** Ticked already when the question shows, for the User to change. */
  preselected: boolean;
}

/**
 * The User's answer to a question: the labels of the options chosen, in their
 * order, and what they wrote under Other… (null: nothing); or that they
 * skipped it.
 */
export type UserAnswer =
  | { skipped: false; chosen: string[]; wrote: string | null }
  | { skipped: true };

/** A question the assistant asks the User with options (#1374), as its Answer keeps it. */
export interface UserQuestion {
  question: string;
  /** One line under the question, such as what is ticked already and why; null: none. */
  detail: string | null;
  /** 2 to 4, the recommended one first. */
  options: UserQuestionOption[];
  /** More than one option may be chosen. */
  multiple: boolean;
  /** The User may write their own answer, under Other…. */
  other: boolean;
  /** Null while it waits for the User. */
  answer: UserAnswer | null;
}

/** A question waiting in the tray for the User's answer (#1374). */
export interface UserQuestionRequest extends AnswerPlace {
  requestId: string;
  answerId: string;
  /** The call's id among the Answer's `toolCalls`. */
  toolCallId: string;
  question: UserQuestion;
}

export type { CommandTarget, OfferedCommand, Yours };

/**
 * What `list_commands` found (#1110): how many, and what matched them, each as given; for
 * "window", how many of the window's commands act on the window in front (#1421).
 */
export interface CommandsFound {
  kind: CommandTarget | "window";
  count: number;
  by: { name?: string; tag?: string; folder?: string };
}

/** A Document or Mind a command changed, by its name before; `renamed`: the name it took. */
export interface CommandItem {
  kind: CommandTarget;
  id: string;
  name: string;
  renamed?: string;
}

/** How a Word export settled whether to mark the text IncarnaMind wrote (#1535): `how` says where the choice came from. */
export interface ExportMarking {
  choice: MarkAiTextChoice;
  /** For this file only, as the request named it; the choice saved before; or the default (#1945). */
  how: "this-file" | "earlier" | "default";
}

/** What a call of `run_command` did (#1110), from what its command returned. */
export interface CommandDone {
  command: CommandId;
  /** The Run it was part of: one Undo takes back every change of the Run (`undoCommands`). */
  run: string;
  items: CommandItem[];
  /** The Folder or Tag it put them in, as named then; `made`: the command made it. */
  into?: { kind: "folder" | "tag"; id: string; name: string; made: boolean };
  /** The file an export saved. */
  file?: Pick<SavedFile, "path" | "name" | "folder" | "inDefaultFolder">;
  /** For a file saved: whether it is in the Output location itself, not a folder the request named. */
  inOutputLocation?: boolean;
  /** For a Word file: how its marking of the text IncarnaMind wrote was settled. */
  marking?: ExportMarking;
  /**
   * Run by the window that asked, as ⌘K runs it (#1421); `changed`: it changed something the
   * window's Undo takes back, which then goes with the Run's other changes. `running`: it started
   * and goes on in the window, a Check for one; this call is updated when it ends.
   */
  window?: { changed: boolean; running?: true };
  /** It is the User's alone: nothing ran, and the card says where they change it (#1421). */
  yours?: Yours;
  /** With `yours` "wall": the Folder whose wall the request is about, which the card names (#1934). */
  folder?: { id: string; name: string };
  /** A setting it changed (#1421), with its value before and now, each as the setting names it. */
  setting?: { name: string; from: string; to: string };
}

/** Why a call of `run_command` changed nothing (#1110). */
export interface CommandProblem {
  command: string;
  /** In English, for the log; `wording` says it in the interface language when there is one. */
  message: string;
  wording: ErrorWording | null;
}

/** What a `run_analysis` call's step says of its Analysis (#447): "Ran an analysis on Sales.xlsx". */
export interface AnalysisCall {
  /** Its number among the Answer's Analyses (`ConversationAnswer.analyses`). */
  number: number;
  title: string;
  /** The Documents its inputs read, by name, each once. */
  documents: string[];
  end: AnalysisEnd["kind"];
  /** Why it couldn't run, when `end` is "unavailable". */
  reason?: AnalysisUnavailableReason;
  /** Its time limit, when `end` is "timed-out". */
  limitMs?: number;
}

/**
 * Why a call of a Minds' Tool changed nothing. "waiting": changes
 * still wait in the text it was to change, which the assistant can't revise
 * (someone else's, or the User's own requests), `count` of them in the Mind;
 * "mixed": its own waiting text sits beside the User's there. "model": the
 * model failed, as `message` says. "no-table": a table it wrote couldn't be
 * made, so none of its text went in (#961). "unplaced": text it marked to take
 * out isn't in the Mind word for word, so none of its text went in (#2180).
 */
export type MindProblem =
  | { kind: "waiting"; mindId: string; count: number; mixed: boolean }
  | { kind: "no-mind" }
  | { kind: "not-found"; name: string }
  | { kind: "several"; name: string }
  /** Minds of close titles, and the User didn't pick which one was meant (#1865). */
  | { kind: "not-picked"; name: string }
  | { kind: "no-heading"; mindId: string; heading: string }
  | { kind: "no-place"; mindId: string; place: string }
  | { kind: "several-places"; mindId: string; name: string; adding: boolean }
  | {
      kind:
        | "no-text"
        | "too-long"
        | "changed"
        | "content-not-own"
        | "stopped"
        | "no-table"
        | "unplaced"
        | "uncited"
        // Only in Answers written before #1559.
        | "new-mind";
      mindId: string;
    }
  | { kind: "local-mode" | "not-ready" }
  | { kind: "model"; mindId: string; message: string }
  | { kind: "copy" | "new-version"; mindId: string; text: string }
  /** A chart of a table already in the Mind (#1091): "several" tables, and the cursor in none. */
  | { kind: "no-chart"; mindId: string; problem: ChartProblem | "several" };

/**
 * Where the assistant writes next in a Mind, as its changes come in (#202):
 * a new Block after the Block `after` (null: at the Mind's end), or the
 * paragraph or heading `over`, which it is writing anew.
 */
export type WritingPlace = { after: string | null } | { over: string };

/** Where the assistant is writing a Mind's changes as they come (#202); `place` null once it has stopped. */
export interface MindWriting {
  mindId: string;
  place: WritingPlace | null;
}

/**
 * Why a chart the User asked the assistant for wasn't drawn (#1091): no table to draw it from,
 * no column of numbers, one column for a scatter chart, or figures with no Citation and no
 * calculation.
 */
export type ChartProblem = "noTable" | "noNumbers" | "needsTwo" | "uncited";

/**
 * What a call of a Minds' Tool did (#202): the changes it proposed in one
 * Mind, which wait there for the User to accept or reject them.
 */
export interface MindChange {
  mindId: string;
  /** The call made the Mind. */
  created: boolean;
  /** It wrote into a Mind that held nothing yet: the empty Mind in front (#1559). Absent: it held text, or the call made it. */
  filled?: true;
  /** The request its Proposals belong to (`ProposalRef.request`). */
  request: string;
  /** How many Proposals it made there. */
  proposals: number;
  /** How many paragraphs they change, add or remove, each once (`changedParagraphs`). Absent: none. */
  changed?: number;
  /** How many paragraphs the whole Blocks it wrote hold (a heading or a table holds none). Absent: none. */
  paragraphs?: number;
  /** How many tables it added. Absent: none. */
  tables?: number;
  /** How many charts it added (#1091). Absent: none. */
  charts?: number;
  /** Why the chart asked for wasn't drawn, the table kept (#1091). Absent: none was asked for, or it was drawn. */
  chartNotDrawn?: ChartProblem;
  /** Sources in its tables' cells written as a name in brackets that matched no Citation, kept as text. Absent: none. */
  unlinkedSources?: number;
  /** Sources the assistant wrote as a name in brackets that matched no Citation it recorded, so left out. Absent: none. */
  droppedSources?: number;
  /** Cells beyond its tables' columns, their text kept in their row's last cell. Absent: none. */
  extraCells?: number;
  /**
   * It revised the assistant's own changes still waiting there: they
   * are gone, and its request holds the new text and the rest of them.
   */
  revised?: true;
  /**
   * Of the text it revised, what earlier calls of the same Answer had written: their counts
   * already hold it, so the Answer's card counts it once. Absent: none, or the text was an
   * earlier Answer's.
   */
  replacedOwn?: { paragraphs: number; tables: number; charts: number };
  /** How many Citations the text it wrote there holds. Absent: none, or it rewrote text keeping its own. */
  cited?: number;
  /** It wrote new text there with no Citation at all, once its Answer had searched and found Passages (#1415). */
  uncited?: true;
  /** How many of its text's markers had no Citation recorded, and were left out. Absent: none. */
  unrecorded?: number;
  /**
   * How many of the sentences it wrote are being checked against their Citations now, before
   * they land (#1111). Absent: none, or the check is over.
   */
  checking?: number;
  /**
   * The check of the sentences it wrote that a check reads (#1909: every claim,
   * cited or not), once over: how many there were (`checkable`), how many have a
   * Citation (`cited`), how many it sent to be checked (`sent`), how many got a
   * verdict (`checked`) and how many couldn't be checked (`failed`), and what
   * stopped it, if anything did. Those it couldn't check, or didn't, are marked
   * not checked, under `request`; `blocked` says how many of them the User's own
   * choice kept from being sent (the flow turned off, or Local mode), which
   * checking again can't change. Absent: none was checked.
   */
  selfCheck?: {
    request: string;
    /** The write's top-level Blocks; absent on a check recorded before #1909. */
    blocks?: string[];
    /** Absent on a check recorded before #1909: `cited` was what it checked then. */
    checkable?: number;
    cited: number;
    sent: number;
    checked: number;
    failed: number;
    stop?: RunStop;
    blocked?: { reason: "consent-revoked" | "local-mode"; count: number };
  };
}

/** What a call of `read_web_page` came to (see `AnswerToolCall.webPage`). */
export type WebPageCall =
  | { address: string; documentId: string; name: string }
  | { address: string; failure: WebPageFailureReason };

/** Where the User's approval of a Tool call stands (see `AnswerToolCall.approval`). */
export type ToolCallApproval = "waiting" | "allowed" | "denied";

/**
 * A run of a Skill script, as its Tool-call card shows it: what the model was
 * given back. Each output is cut to `SKILL_SCRIPT_LIMITS.maxOutputBytes`: the
 * start of the standard output, the end of the error output.
 */
export interface SkillScriptRun {
  /** Its exit code; null when it couldn't start (see `error`), or was stopped. */
  exitCode: number | null;
  /** It ran longer than the timeout, so it was stopped with every process it started. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** It wrote more to its standard output than is kept. */
  stdoutTruncated: boolean;
  /** It wrote more to its error output than is kept. */
  stderrTruncated: boolean;
  /**
   * Why it didn't run, in plain language: e.g. its interpreter isn't
   * installed ("python3 not found: install Python 3."), it is a shell script
   * on Windows, or a kind of script IncarnaMind can't run. Null when it ran.
   */
  error: string | null;
}

/**
 * The node type of a Citation: an inline node anchored in the text of an
 * Answer (or of a Note it was copied into), so it moves with edits and goes
 * when its text is deleted.
 */
export const CITATION_NODE = "citation";

export const CALCULATED_FIGURE_NODE = "calculatedFigure";

/**
 * The node type of a footnote the User writes: an inline node at its marker,
 * holding the footnote's text (text with marks, line breaks and Citations, but
 * no footnote of its own), with a UUID in `BLOCK_ID_ATTRIBUTE` that names it
 * across edits. User footnotes and Citations share one numbering, in the
 * order they appear: a Citation's footnote is its reference, and a Citation
 * inside a footnote is part of that footnote's text, with no number of its own.
 *
 * A Word file's footnote or endnote is one too (#746): `source` names its
 * reference in the main document part ("w:footnoteReference#2"), as an atom's
 * does, and its text may hold what the import keeps as is (`WORD_ATOM_NODE`).
 * An endnote (`endnote: true`) is numbered on its own, as the file numbers
 * them, and export writes it back as an endnote.
 */
export const FOOTNOTE_NODE = "footnote";

/**
 * The node type of a page break, in any Note (#746): an inline node, drawn as
 * a line across the text, which export writes as Word's page break. One
 * imported from a Word file names its XML in `source`, as an atom does.
 */
export const PAGE_BREAK_NODE = "pageBreak";

/**
 * The node type of a Document chip, which the User writes with "@" in a Note:
 * an inline node that names a Document (`documentId`, and its `name` as it was
 * when the chip was made, shown if the Document is gone) and opens it in the
 * viewer. It is the User's own text, not a Citation: it checks nothing.
 */
export const DOCUMENT_CHIP_NODE = "documentChip";

/**
 * The node type of a chart (#436): a Block with no text of its own, whose
 * attributes hold what it draws (see `ChartAttributes` in
 * src/shared/charts.ts): its kind, its title, the series drawn, and its
 * values, each with where it came from and the Citation that was there.
 */
export const CHART_NODE = "chart";

/**
 * What a Mind imported from a Word file (#104) keeps as it is: content the
 * editor can't represent, shown in place, never edited inside, which export
 * writes back as the original XML (#105). `WORD_ATOM_NODE` sits inside a
 * paragraph's text (a field, a content control, a text box, a bookmark…),
 * `WORD_BLOCK_NODE` is a Block of its own (a block content control, a nested
 * table, a header or footer). Both hold `WordAtomAttributes`.
 */
export const WORD_ATOM_NODE = "wordAtom";
export const WORD_BLOCK_NODE = "wordBlock";

/** A picture in a paragraph's text, as Tiptap names it: a .docx's inline pictures (#104). */
export const IMAGE_NODE = "image";

/**
 * A picture the User pasted or dropped into a Note (#1937): a Block of its
 * own, kept as a `data:` URL of the Note's data (the app's
 * Content-Security-Policy allows no other kind), resized to fit, with the alt
 * text the User writes for it. Unlike an `IMAGE_NODE` it sits between Blocks,
 * never inside a paragraph's text.
 */
export const PICTURE_NODE = "picture";

/**
 * What a kept-as-is atom is. Bookmarks, other ranges (a comment's, an
 * editing permission's, a move's) and column breaks are invisible; a section
 * break is a line across the text; the rest show their text, or a mark of
 * their own. "pageBreak", "footnote" and "endnote" are what a Note imported
 * before #746 holds until it is converted (`PAGE_BREAK_NODE`, `FOOTNOTE_NODE`),
 * and a note the Note's footnote can't hold (a table, someone's tracked
 * change) stays one.
 */
export type WordAtomKind =
  | "field"
  | "control"
  | "textBox"
  | "shape"
  | "smartArt"
  | "chart"
  | "picture"
  | "object"
  | "equation"
  | "symbol"
  | "footnote"
  | "endnote"
  | "comment"
  | "insertion"
  | "deletion"
  | "bookmark"
  | "range"
  | "sectionBreak"
  | "pageBreak"
  | "columnBreak"
  | "table"
  | "header"
  | "footer"
  | "other";

/**
 * The attributes of a kept-as-is atom (`WORD_ATOM_NODE`, `WORD_BLOCK_NODE`).
 *
 * `source` says where its XML is in the Mind's stored Word package
 * (`WordFileInfo.part` unless it names a part): an element by its qualified
 * name and its place among the elements of that name in the part, from 0, in
 * document order, nested ones and those in `mc:Fallback` counted ("w:sdt#3"),
 * or a run of elements from one to another ("w:r#40..w:r#44", a field), or a
 * whole part ("word/header1.xml").
 */
export interface WordAtomAttributes {
  kind: WordAtomKind;
  /** What it shows: a field's result, a control's text, a footnote's number. */
  label: string;
  /** Its text, read for Questions and search: a text box's, a comment's, a footnote's. */
  text: string;
  source: string | null;
  /**
   * What the file has at its place, as the import found it (#746): a hash of
   * its XML there, which no later import reads otherwise, so export tells the
   * file's own atom from a copy. Null for one imported before it was recorded.
   */
  hash: string | null;
  /** More about it: a change's or a comment's author and date, a field's type. */
  info: WordAtomInfo | null;
}

export interface WordAtomInfo {
  author?: string;
  /** As the file has it, ISO 8601. */
  date?: string;
  /** A field's type, the first word of its instruction: "DATE", "REF", "TOC". */
  field?: string;
  /** Shown on a line of its own: a display equation, a drawing in a paragraph by itself. */
  display?: boolean;
  /** A bookmark's name. */
  name?: string;
  /**
   * For a Block kept as is that the file draws as paragraphs (a table of
   * contents, a field over several paragraphs): each line's paragraph look,
   * by its key in the Mind's Word look, so the look draws it at the file's height.
   */
  looks?: string[];
}

/**
 * Why a Word file isn't imported, said before any Mind is made:
 * - "legacy": a Word 97–2003 file (.doc);
 * - "macros": a macro-enabled file (.docm): IncarnaMind never runs macros;
 * - "encrypted": protected with a password;
 * - "strict": saved as Strict Open XML;
 * - "damaged": not a Word document that can be read (a broken package or XML);
 * - "too-large": over the size limits for Office files (ADR-0011, #77);
 * - "unreadable": the file couldn't be read (moved, or not allowed).
 */
export type WordRefusalReason =
  | "legacy"
  | "macros"
  | "encrypted"
  | "strict"
  | "damaged"
  | "too-large"
  | "unreadable";

/** Whose document an imported Word file is: someone else's makes its Blocks third-party text (#78). */
export type WordOrigin = "own" | "someone-else";

/** What the import screen needs to know about a Word file before it is imported (`checkWordFile`). */
export interface WordFileCheck {
  /** The file's name, as the User sees it ("Lease, draft 4.docx"). */
  fileName: string;
  /** Why it can't be imported; null when it can. */
  refusal: WordRefusalReason | null;
  /** What the import screen starts on: someone else's when the file carries tracked changes or comments. */
  origin: WordOrigin;
  /** Who wrote its tracked changes and comments, in the order they first appear. */
  authors: string[];
  /** Its tracked changes, of every kind (paragraph marks, formatting and moves too). */
  changes: number;
  comments: number;
  /**
   * An earlier file of the same name imported into the same Folder whose original is a
   * Document (#720), which this one can become a new version of; null for none.
   */
  earlierDraft: { documentId: string; name: string } | null;
}

export interface ImportWordFileInput {
  /** The .docx's absolute path. */
  path: string;
  origin: WordOrigin;
  /** The Folder to make the Mind in; none, or null: Not in a Folder. */
  folderId?: string | null;
  /**
   * Also adds the original file to the Library as a Document, in the Mind's Folder, so
   * Answers can cite it (#720). Absent: false, the Mind alone.
   */
  addOriginal?: boolean;
  /**
   * With `addOriginal`, makes the file a new version of this Document (the check's
   * `earlierDraft`) instead of a Document of its own; one that can't take it is added as new.
   */
  newVersionOf?: string | null;
}

/**
 * How an import went: the new Mind, which goes on filling in with the
 * file's content (`WordImportProgress`), or why the file was refused, with
 * no Mind made.
 */
export type ImportWordFileResult =
  | {
      ok: true;
      mind: Mind;
      /**
       * With `addOriginal`: whether the original became a Document. False when the Library
       * couldn't take it, which the User is told, with a way to try again (`addWordOriginal`).
       */
      originalAdded?: boolean;
    }
  | { ok: false; refusal: WordRefusalReason };

/**
 * What a Word import did with the file, by count, so nothing is dropped
 * without a word: what became editable, and what is kept as is, by kind.
 */
export interface WordImportReport {
  paragraphs: number;
  headings: number;
  listItems: number;
  tables: number;
  images: number;
  links: number;
  kept: Partial<Record<WordAtomKind, number>>;
  /** Tracked changes, of every kind, and comments, whoever made them. */
  changes: number;
  comments: number;
  sections: number;
  /**
   * Someone's tracked changes that can't be accepted or rejected here, by
   * kind: they stay in the file as they are, for Word to resolve (#108).
   * Absent on reports from before #108.
   */
  keptChanges?: Partial<Record<KeptChangeKind, number>>;
  /** Footnotes, endnotes and page breaks made the Note's own (#746); absent on reports from before. */
  footnotes?: number;
  endnotes?: number;
  pageBreaks?: number;
}

/**
 * How a Word file numbers its footnotes and endnotes (#746), from its
 * settings: Word's number format ("decimal", "lowerRoman", "chicago"…) and
 * the number the first one takes.
 */
export interface WordNoteNumbering {
  footnote: { format: string; start: number };
  endnote: { format: string; start: number };
}

/**
 * A kind of tracked change a Word import keeps as is (#108): a change to a
 * run's or a paragraph's formatting, a paragraph mark added or removed
 * without its paragraph's text, a move, a table row's or cell's change, or
 * an insertion or deletion holding more than text (a field, a picture, a
 * note's mark).
 */
export type KeptChangeKind = "format" | "paragraphMark" | "move" | "row" | "cell" | "content";

/**
 * The name of the Y.Map, beside the Blocks of a Mind imported from a Word
 * file, that says what it was imported from (see src/shared/wordFiles.ts):
 * the file (`WordFileInfo`), how far the import has got
 * (`WordImportProgress`), and what it did (`WordImportReport`).
 */
export const MIND_WORD_FIELD = "word";

/**
 * The name of the Y.Map that says which paragraph or table of the stored Word
 * package each of the Mind's nodes was imported from, by node id
 * (`WordSource`), for export to write into the original (#105).
 */
export const MIND_WORD_SOURCES_FIELD = "wordSources";

/** The Word file a Mind was imported from. Its package is kept in the data folder by `sha256`. */
export interface WordFileInfo {
  /** As the User named it, with its extension. */
  name: string;
  sha256: string;
  size: number;
  /** The package's main document part: "word/document.xml". */
  part: string;
  /** The Document the original was also added as (#720); null or absent: none. */
  documentId?: string | null;
}

/** How far an import has got, in top-level Blocks. While `done` is under `total`, the Mind can't be edited. */
export interface WordImportProgress {
  done: number;
  total: number;
}

/**
 * A Y.Map beside the Blocks of a Mind imported from Word, holding the file's
 * styles (`WordLook`) once each; Blocks and text name them by key.
 */
export const MIND_WORD_LOOK_FIELD = "wordLook";

/** On paragraphs, headings, tables and cells: a key in the Mind's `WordLook`. */
export const WORD_LOOK_ATTRIBUTE = "wordLook";

/** A mark on text whose attribute `k` is a key in `WordLook.runs`. */
export const WORD_RUN_MARK = "wordRun";

/** A mark on each tab character of a Word file's text, so each is drawn to its tab stop. */
export const WORD_TAB_MARK = "wordTab";

/**
 * On paragraphs and headings: how the User formatted the paragraph
 * (`ParagraphFormat`), over its Word look and the Mind's style. A Word file's
 * direct paragraph formatting is read into it too, so export writes it back
 * as the file's own `w:pPr`.
 */
export const PARAGRAPH_FORMAT_ATTRIBUTE = "paragraphFormat";

/** Text in a colour (`color`, hex "RRGGBB"); without it, text is in the automatic colour. */
export const TEXT_COLOR_MARK = "textColor";
/** Text in a font (`family`, as the system names it); without it, in its paragraph's. */
export const TEXT_FONT_MARK = "textFont";
/** Text in a size (`size`, in points); without it, in its paragraph's. */
export const TEXT_SIZE_MARK = "textSize";
export const SUPERSCRIPT_MARK = "superscript";
export const SUBSCRIPT_MARK = "subscript";

/**
 * Lengths are in points, which a Mind draws in proportion to its text size
 * (its body text is 11 pt, as Word export writes it; a Word file's, its own).
 * What is left out is as the paragraph's look or the Mind's style has it.
 */
export interface ParagraphFormat {
  align?: "left" | "center" | "right" | "justify" | "distribute";
  left?: number;
  right?: number;
  /** Negative for a hanging indent. */
  firstLine?: number;
  /**
   * The first line's indent in characters of the paragraph's text, as Word
   * keeps it (`w:firstLineChars`, in hundredths); negative for a hanging
   * indent. It wins over `firstLine`.
   */
  firstLineChars?: number;
  before?: number;
  after?: number;
  line?: WordParagraphLook["line"];
}

/** Lengths are in points and colours hex "RRGGBB"; unset properties are left out. */
export interface WordLook {
  version: number;
  /** The most common run size; null with no text. */
  body: number | null;
  /** The text width on the first page; null when the file doesn't say. */
  width: number | null;
  /** How far apart Word's default tab stops are (`w:defaultTabStop`); null when the file doesn't say. */
  defaultTab: number | null;
  /**
   * In compatibility mode 14 and lower, Word draws a table's left edge its
   * left cell margin into the margin, so the cells' text lines up with the page's.
   */
  tablesHang?: true;
  /**
   * The document grid's line pitch, in points, when the first section puts
   * lines on it (`w:docGrid` of type "lines", "linesAndChars" or
   * "snapToChars"), as Chinese and Japanese files do: each line then takes a
   * whole number of pitches.
   */
  linePitch?: number;
  /** The file's text has Chinese, Japanese or Korean in it, so its East Asian fonts are drawn. */
  eastAsian?: true;
  paragraphs: Record<string, WordParagraphLook>;
  runs: Record<string, WordRunLook>;
  tables: Record<string, WordTableLook>;
  cells: Record<string, WordCellLook>;
}

export interface WordBorder {
  /** As Word names it: "single", "double"… */
  style: string;
  width: number;
  /** Null for automatic. */
  color: string | null;
  space: number;
}

export interface WordRunLook {
  font?: string;
  eastAsia?: string;
  size?: number;
  color?: string;
  /** As Word names it: "yellow"… */
  highlight?: string;
  shade?: string;
  bold?: true;
  italic?: true;
  /** As Word names it: "single", "dotted"… */
  underline?: string;
  strike?: true;
  doubleStrike?: true;
  caps?: true;
  smallCaps?: true;
  vertical?: "superscript" | "subscript";
  letterSpacing?: number;
  widthPercent?: number;
  hidden?: true;
}

export interface WordTabStop {
  at: number;
  align: "left" | "center" | "right" | "decimal" | "bar";
  leader: "none" | "dot" | "hyphen" | "underscore" | "heavy" | "middleDot";
}

export type WordBorders<Side extends string> = Partial<Record<Side, WordBorder>>;

export interface WordParagraphLook {
  /**
   * The run look of the paragraph's text that has no `WORD_RUN_MARK`: the
   * most common one, or the paragraph mark's when there is no text. Marking
   * only the text that differs keeps long files quick to open. Never one
   * that is underlined, struck, highlighted, shaded or raised: drawn on the
   * paragraph, those would cover text that doesn't have them.
   */
  run?: string;
  /** The paragraph look Enter gives the paragraph after, when the style names another (`w:next`). */
  next?: string;
  /**
   * The size, in points, a character indent of the paragraph's own
   * (`ParagraphFormat.firstLineChars`) is measured in: its style's, as Word
   * draws it. Without it, the paragraph's text size.
   */
  characterSize?: number;
  align?: "left" | "center" | "right" | "justify" | "distribute";
  left?: number;
  right?: number;
  /** Negative for a hanging indent. */
  firstLine?: number;
  before?: number;
  after?: number;
  /** "auto": a multiple of the font's line height; "exact" and "atLeast": a height. */
  line?: { rule: "auto" | "exact" | "atLeast"; value: number };
  /** No space between paragraphs of the same style. */
  contextual?: true;
  tabs?: WordTabStop[];
  shade?: string;
  borders?: WordBorders<"top" | "bottom" | "left" | "right" | "between">;
  keepNext?: true;
  keepLines?: true;
  pageBreakBefore?: true;
  widowControl?: boolean;
  /** Off: the paragraph's lines keep their own height on a document grid (`w:snapToGrid`). */
  snapToGrid?: false;
}

export interface WordWidth {
  value: number;
  unit: "pt" | "percent";
}

export interface WordTableLook {
  width?: WordWidth;
  align?: "left" | "center" | "right";
  indent?: number;
  borders?: WordBorders<"top" | "bottom" | "left" | "right" | "insideH" | "insideV">;
  /** Cell padding, unless a cell has its own. */
  margins?: Partial<Record<"top" | "bottom" | "left" | "right", number>>;
  /** Column widths as given, whatever the text in them. */
  fixed?: true;
  columns?: number[];
}

export interface WordCellLook {
  width?: WordWidth;
  shade?: string;
  borders?: WordBorders<"top" | "bottom" | "left" | "right">;
  vertical?: "top" | "center" | "bottom";
  margins?: Partial<Record<"top" | "bottom" | "left" | "right", number>>;
  noWrap?: true;
}

/**
 * Where a node of a Mind imported from a Word file came from, in the main
 * document part: `p`, the paragraph's `w14:paraId`, when it has one no other
 * paragraph shares; else `n`, the element's place, as in
 * `WordAtomAttributes.source` ("w:p#12", "w:tbl#3"). `f` is the node's
 * fingerprint as imported (`wordFingerprint`): one that differs now was edited.
 */
export interface WordSource {
  n: string;
  p?: string;
  f: string;
}

/**
 * Something exporting a Mind back into its Word file can't keep (#105), said
 * before the file is saved:
 * - "comment": someone's comment on text the User deleted;
 * - "change": someone's tracked change in text the User deleted;
 * - "copy": a copy of something kept from Word, written as its text;
 * - "note": a copy of a note kept as is that holds no text the Note knows, written as an empty footnote;
 * - "edit": an edit next to a field, which is written as it was;
 * - "signature": the file's digital signature, which no longer matches once it changes.
 */
export interface WordExportLoss {
  /** The same for the same thing at the next export, so going ahead applies to what the User saw. */
  key: string;
  kind: "comment" | "change" | "copy" | "note" | "edit" | "signature";
  /** Whose comment or change it is. */
  author: string | null;
  /** Its text, shortened; "" for none. */
  text: string;
}

/** What exporting a Mind imported from a Word file does with the original (#105). */
export interface WordExportReport {
  /** What can't be kept: the User sees it before the file is saved. */
  notKept: WordExportLoss[];
  /** Parts of the package IncarnaMind doesn't know, kept as they are. */
  unknownParts: string[];
  /** The header and the footer, kept in the file though their Blocks were deleted from the Mind. */
  keptFurniture: ("header" | "footer")[];
}

/**
 * Where a Citation's check stands. The check compares the model's quote with
 * the text of the cited Units (its Location: one or two pages, slides,
 * sections, blocks of rows or of lines; see src/shared/units.ts), once, when
 * the Answer finishes. "found" means the quote is there, not that it supports
 * the sentence.
 * - "checking": the Answer is still being written, or, once it ends, its sentence is judged.
 * - "found", "not-found": see `checkReason` for why it wasn't found.
 * - "cant-check": there is no text to look in (see `checkReason`).
 * - "not-checked": an Answer's sentence whose judgement couldn't run (no model the chat flow may
 *   use now, no verdict, an error) or was stopped (#2311): its Citation shows neither found nor a
 *   problem until Check again judges it.
 * - "unsupported", "contradicted": the verdict of checking the claim itself against
 *   the Documents, not only its quote (`verdict` says what the evidence says). An Answer in the
 *   assistant has each cited sentence judged so after it ends, on the chat flow, its tables' rows
 *   too (#2311): "found" then also means supported. A sentence showing a Calculated figure is
 *   judged by the figure's Calculation check instead, so its "found" means the quote is there.
 */
export type CitationCheck =
  | "checking"
  | "found"
  | "not-found"
  | "cant-check"
  | "not-checked"
  | "unsupported"
  | "contradicted";

export type CitationCheckReason =
  /** Not found: the quote isn't in the text of the cited Units (pages, slides…). */
  | "quote-not-on-pages"
  /** Not found: the words the Answer put in quotation marks aren't in the text of the cited Units (#483). */
  | "quoted-words-not-on-pages"
  /** Not found: the cited Units aren't all among the Units of the cited Passage. */
  | "pages-outside-passage"
  /** Not found: a Citation covers one Unit, or two consecutive ones of one sheet, at most. */
  | "too-many-pages"
  /**
   * Not found: words selected in a Document are in several places, and the words around them
   * don't tell which (`citeSelection`, #101).
   */
  | "in-several-places"
  /** Can't check: the cited Units have no text, e.g. scanned pages. */
  | "no-text"
  /** Can't check from this Note: the Document stays inside a walled Folder. */
  | "kept-inside"
  /** Can't check: the Document was deleted. */
  | "document-removed"
  /** Not checked: judging the Answer's sentences reached its own limit before this one's (#2311). */
  | "answer-limit"
  /** Not checked: judging the Answer's sentences reached the monthly cap before this one's (#2311). */
  | "monthly-limit"
  /**
   * Not checked: the model that wrote the Answer runs on this computer and is too small to judge
   * its sentences, so their check never ran (#2375).
   */
  | "small-model";

/**
 * What to re-check a Citation with against its Document's current version
 * (see `CoreApi.recheckCitation`): its Document, cited Units and quote.
 */
/** A Citation to look for again in its Document (see `RecheckCitationInput`). */
export interface CitationToRecheck {
  documentId: string;
  /** The cited Units (pages, slides…), from 1; null for a whole TXT or Markdown file. */
  pageFrom: number | null;
  pageTo: number | null;
  quote: string;
  /**
   * The version the Citation quotes. When the Document has a newer one, the result also says
   * how the Citation stands in this version (`inQuotedVersion`) and how its words changed
   * (`changed`).
   */
  contentHash?: string | null;
}

/** Where a Question is asked: its Note, else its conversation; null for none. */
export interface TurnPlace {
  mindId: string | null;
  conversationId: string | null;
}

/**
 * A Citation looked for again for a Note outside the walled Folder that keeps its Document (#1934):
 * nothing was read, so nothing is known of the new version, and the result it was made with stands.
 */
export interface CitationKeptInside {
  /** The walled Folder's name. */
  keptInside: string;
}

/** What looking for a Citation again for a Note came to: checked, or kept inside a wall. */
export type RecheckResult = CitationRecheck | CitationKeptInside;

export interface RecheckCitationInput extends CitationToRecheck {
  /**
   * The Note the Citation is in, or going into; null for one shown in no Note (an Answer in the
   * assistant, the Document's viewer), which is read as browsing is. A Document kept inside a
   * walled Folder isn't read again for a Note outside it: the check it was made with stands
   * (#1934). Never left out.
   */
  mindId: string | null;
}

/**
 * A Citation checked again against its Document's current version: the
 * attributes to store on its node in place of the old ones. The quote is
 * checked in its cited Units in the current version. A quote elsewhere never
 * changes the Citation's Unit bounds; a whole-Document Citation stays whole.
 */
export interface CitationRecheck {
  check: Exclude<CitationCheck, "checking">;
  checkReason: CitationCheckReason | null;
  /** The version checked: the Document's current `contentHash`; null when it can't be checked. */
  contentHash: string | null;
  /** A Passage of the current version that holds the Units, or null. */
  passageId: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  location: CitationLocation | null;
  /**
   * Asked with the version the Citation quotes, which is no longer the current one: its check
   * in that version, at the Units it cites (ADR-0017's amendment); null once that version's
   * text is no longer kept.
   */
  inQuotedVersion?: Pick<CitationRecheck, "check" | "checkReason"> | null;
  /**
   * Asked with the version the Citation quotes, which is no longer the current one, and the
   * quote isn't in the current one as cited: its words as they changed at its place; null
   * when nothing there is like them any more.
   */
  changed?: ChangedQuote | null;
}

/** A Citation's quote as its words changed in its Document's current version (#99). */
export interface ChangedQuote {
  /** From the quote to the words at its place now, in order: kept, taken out or put in. */
  parts: { kind: "same" | "removed" | "added"; text: string }[];
  /** The words at its place now, cited in the current version: what Update the sentence… cites. */
  now: CitedSelection;
}

/** Words the User selected in a Document's viewer, on one of its Units (`citeSelection`). */
export interface SelectedPart {
  /** The Unit they are on, from 1: a PDF's page. Null where the viewer doesn't know it. */
  unit: number | null;
  /** As the viewer shows them, a line break between lines. */
  text: string;
  /**
   * How many of the Unit's lines with text come before and after them: a
   * running header or footer sits at a page's edge.
   */
  linesBefore?: number;
  linesAfter?: number;
  /**
   * The Document's words right before the first part, and after the last, as
   * the viewer shows them: they tell one place of the same words from another.
   */
  before?: string;
  after?: string;
}

/** A Citation of what the User selected: the attributes to store on its node, and its quote. */
export interface CitedSelection extends CitationRecheck {
  /** The words selected, read as words, without a running header or footer selected with them. */
  quote: string;
}

/** At most this many `AskedQuote`s go with a Question: each brings the Passages of its pages. */
export const MOST_ASKED_QUOTES = 10;

/**
 * Words the User selected in a Document to ask about ("Ask about this", #101), as
 * `citeSelection` found them, kept with the Question.
 */
export interface AskedQuote {
  documentId: string;
  /** As the User saw it when they asked: it stays readable once the Document is deleted. */
  documentName: string;
  quote: string;
  pageFrom: number | null;
  pageTo: number | null;
  location: CitationLocation | null;
}

/**
 * Text kept of a Document that left the index with its Linked folder: the
 * Units of one version that Citations pointed to when the folder was
 * unlinked. Kept so the Citations that quote it can still be checked (see
 * `citationState` in src/shared/citations.ts), until no Citation quotes it.
 */
export interface KeptCitationText {
  documentId: string;
  /** The version it is of. */
  contentHash: string;
  /** The numbers of the Units kept (pages, slides…), from 1, in order. */
  units: number[];
}

/** At most this many consecutive Units (pages, slides…) per Citation (the Location rule). */
export const MAX_CITED_PAGES = 2;

/**
 * Where in a Document a Citation points, as its short label shows it
 * (ADR-0011), stored with it so the label still reads after the Document is
 * gone. Language-neutral: the label is worded when shown ("p. 4", "slide 4",
 * "Revenue, rows 12–14", "§ 2.1 Sensitivity", "§ 2 Costs, comment by
 * Reviewer", "lines 120–134").
 * - "page", "slide": the cited pages or slides. A PDF's `printed` names the
 *   first and last page as they call themselves ("xii", "68") when that
 *   isn't their number in the PDF; `from` and `to` stay the PDF's, which
 *   open the viewer (#901).
 * - "rows": the rows the quote covers in a sheet (a CSV's has no name), or
 *   the cited block's when it wasn't found.
 * - "section": the heading of the section the quote sits under; null before
 *   the first heading. `start`: the quote is before the first heading of a
 *   Document that has headings, the only null heading that names a place.
 *   `notes`: a Word file's footnotes and endnotes.
 *   `comment`: the quote is in a Word comment anchored in that section, by
 *   its author (null when the file names none) (#76). `paragraphs`: in a
 *   web page, the paragraphs of the section the quote covers, from 1 (#261);
 *   in a Word file with no headings, its paragraphs, from the start of the file.
 * - "lines": the lines the quote covers, or the cited block's.
 * - "time": in a Transcript, from the start of the cue the quote starts in to
 *   the end of the one it ends in, in ms from the Transcript's start (#136);
 *   `speaker`: who said the cue it starts in, where the Transcript says (#941).
 */
export type CitationLocation =
  | {
      kind: "page";
      from: number;
      to: number;
      printed?: { from: string; to: string };
      /** The printed line on the first printed page and on the last (#1709). */
      lines?: { from: number; to: number };
    }
  | { kind: "slide"; from: number; to: number }
  | { kind: "rows"; sheet: string | null; from: number; to: number }
  | { kind: "lines"; from: number; to: number }
  | { kind: "time"; from: number; to: number; speaker?: string }
  | {
      kind: "section";
      heading: string | null;
      start?: boolean;
      notes?: boolean;
      comment?: { author: string | null };
      paragraphs?: { from: number; to: number };
      /** A web page's picture the quote was read from, numbered in the page from 1. */
      figure?: number;
    };

/** A stretch of words, and whether the Document has it where the Answer's quoted words were looked for. */
export interface QuotedPiece {
  text: string;
  found: boolean;
}

/**
 * Words an Answer put in quotation marks that aren't in the text its Citation
 * points to (#483), for the card to set beside the Document's own: each in
 * pieces, so the card washes what matches and what doesn't.
 */
export interface QuotedWords {
  /** The Answer's words, whole; the pieces the Document doesn't have are `found: false`. */
  answer: QuotedPiece[];
  /** The Document's words nearest them, the matching stretch `found: true`; null when none is near. */
  closest: QuotedPiece[] | null;
}

/**
 * A Citation's attributes, as stored on its node in the Mind's Yjs document.
 * Everything a footnote or a message needs is stored here, so it still reads
 * after the Document is deleted.
 */
export interface CitationAttributes {
  passageId: string | null;
  documentId: string | null;
  /** The Document's name when the Citation was made: shown only when the Document can't be found (see `shownDocumentName`). */
  documentName: string | null;
  /**
   * The version of the Document the Citation quotes: the SHA-256 of its file
   * as it was then (`Document.contentHash`). The check reads that version's
   * text, which is kept for as long as a Citation quotes it. When it differs
   * from the Document's `contentHash` now, the Document changed after it was
   * cited (see `citationState` in src/shared/citations.ts).
   */
  contentHash: string | null;
  /**
   * The cited Units, from 1: pages of a PDF, slides of a deck, and otherwise
   * the Units' numbers in the version quoted (see src/shared/units.ts). Both
   * null for a whole TXT or Markdown file, cited before Units.
   */
  pageFrom: number | null;
  pageTo: number | null;
  /**
   * Where the Citation points, for its label (see `CitationLocation`). Null
   * for Citations made before Locations: their label comes from the pages.
   */
  location: CitationLocation | null;
  /** The quote the model gave, which it was asked to copy word for word from the Passage. */
  quote: string | null;
  check: CitationCheck;
  checkReason: CitationCheckReason | null;
  /** One line on what the evidence says, when a claim check has one ("The agreement says 31 October 2026, p. 7"). */
  verdict?: string | null;
  /** The Answer's quoted words the check didn't find, when that is why `check` is "not-found" (#483). */
  quotedWords?: QuotedWords | null;
  /**
   * The Document's version the User chose to keep citing the old one over (Keep citing the old
   * version, #99): while it is the current one, the Citation doesn't ask to be checked again.
   */
  keptOver?: string | null;
  /**
   * Its own id, given once the User marks it checked by them (#1933), so the mark stays on it
   * as the text around it changes. A copy pasted beside it has none.
   */
  id?: string | null;
}

/** A Citation, as the Answer event stream reports it. */
export interface Citation {
  passageId: string;
  documentId: string;
  documentName: string;
  contentHash: string;
  pageFrom: number | null;
  pageTo: number | null;
  location: CitationLocation | null;
  quote: string;
  check: CitationCheck;
  checkReason: CitationCheckReason | null;
  quotedWords?: QuotedWords;
  /** "unsupported" and "contradicted": what the Documents say of its sentence, in one plain sentence. */
  verdict?: string | null;
}

/**
 * A number an Answer worked out from numbers in Passages (ADR-0021): the model
 * named each input's number in a quote and a formula over them, and
 * IncarnaMind read the numbers, checked the quotes and did the arithmetic
 * (src/shared/formula.ts). The Answer shows it where its marker ("[=1]") is.
 */
export interface CalculatedFigure {
  /** What it is, as the model labelled it: "Revenue growth 2025". */
  label: string;
  /** In Excel's formula syntax, over the inputs' names: "rev2025 / rev2024 - 1". */
  formula: string;
  inputs: FigureInput[];
  /** As worked out, a double, as Excel computes it; true or false for a comparison. */
  value: number | boolean;
  unit: ResultUnit;
  /** Worked out from an approximate input, so approximate too. */
  approximate: boolean;
  /** As the Answer writes it, in its language: "20.4%", "2.3个百分点". */
  shown: string;
  /** How it was shown, so it can be shown again the same way and compared. */
  show: FigureShowOptions;
  /** Numbers written in the formula itself, which no quote backs: the 4 in "^ (1 / 4)". */
  literals: FormulaLiteral[];
  /** The rules it was worked out and shown by (`FORMULA_VERSION`): a check runs the same ones. */
  engine: number;
  /**
   * What the Answer wrote beside its marker when that isn't this figure: a
   * number right before it ("26%" where IncarnaMind calculated 25.0%), or a
   * scale or currency right after it ("亿元" after a figure in 万元), which
   * the text leaves out. Null when it wrote nothing there, or the same
   * figure, which the text then shows once.
   */
  written: string | null;
  /** Given by an Analysis of the Answer, not worked out from a formula (#447). */
  analysis?: FigureFromAnalysis;
  /** Worked out from a workbook's own formulas (#2347): its `formula` is empty. */
  workbook?: FigureFromWorkbook;
}

/** Why a workbook's cell keeps the value the workbook saved rather than one worked out again (#2347). */
export type WorkbookKeptReason =
  | "volatile"
  | "finds-cells"
  | "function"
  | "add-in"
  | "data-table"
  | "external"
  | "table"
  | "three-d"
  | "unreadable"
  | "circular"
  | "iterative"
  | "not-read"
  | "array"
  | "no-saved-value"
  | "differs"
  | "too-large"
  | "too-many"
  | "unsorted"
  | "early-date"
  | "criterion"
  | "text-order"
  | "date-text";

export interface WorkbookKeptCell {
  sheet: string;
  /** "C5"; null for a whole sheet that wasn't read. */
  ref: string | null;
  reason: WorkbookKeptReason;
  /** The function it uses (NOW, OFFSET), the sheet it reads that wasn't read, or the most formulas worked out at once. */
  name: string | null;
}

/** A cell of a workbook as a figure's formula chain shows it (#2347). */
export interface WorkbookFigureStep {
  sheet: string;
  /** "E5". */
  ref: string;
  /** Its row's heading and its column's, as the sheet writes them: "EBITDA 2027". */
  label: string;
  /** As the workbook writes it, without "=". */
  formula: string;
  /** As worked out, a number, text or TRUE or FALSE; null when empty. */
  value: number | string | boolean | null;
}

/**
 * A figure worked out from a workbook's own formulas (#2347): a cell of it, or
 * that cell worked out again with one input changed (what-if), in memory,
 * never in the User's file. Its inputs are the cells holding numbers that
 * drive it, each cited to its cell.
 */
export interface FigureFromWorkbook {
  /**
   * The figure's cell, with its formula and the number it shows read as an input is, cited to
   * the cell: a Check reads it again there.
   */
  cell: WorkbookFigureStep & { input: FigureInput };
  /** The formulas it is worked out through, nearest first, its own excluded. */
  steps: WorkbookFigureStep[];
  /** How many formula cells were worked out for it, and its inputs past those listed. */
  formulaCells: number;
  moreInputs: number;
  /** The value the workbook saved for the cell, which IncarnaMind's own result matched. */
  saved: number;
  /** That value as the cell shows it: "254.7". */
  savedShown: string;
  /** A what-if's one changed input: its name among the inputs, and the value it was given. */
  change: { input: string; value: number; shown: string } | null;
  /**
   * The cells it depends on that can't be worked out here, so they and it keep the values the
   * workbook saved, the first few; empty when every formula was worked out again.
   */
  kept: WorkbookKeptCell[];
  /** The rules it was worked out by (`WORKBOOK_ENGINE_VERSION`). */
  engine: number;
}

/** How a calculated figure's result was shown (see `showResult` in src/shared/formula.ts). */
export interface FigureShowOptions {
  language: Language;
  as: ShowAs | null;
  decimals: number | null;
  /** A scale word in `language`: "million", "亿". */
  scale: string | null;
}

/** A calculated figure of an Answer: where it goes is its marker ("[=2]") in the text. */
export interface MarkedFigure extends CalculatedFigure {
  marker: number;
}

export interface CalculatedFigureAttributes {
  id: string;
  figure: CalculatedFigure;
  analysisId: string | null;
}

export interface FigureFromAnalysis {
  /** The Answer's Analysis, by its number. */
  analysis: number;
  /** The result's name in the code: "total_revenue". */
  result: string;
}

/** A range of a sheet or CSV an Analysis read (#447), in one version of its Document (ADR-0010). */
export interface AnalysisRangeInput {
  kind: "range";
  /** The name the code reads it by: `inputs["sales"]`. */
  name: string;
  /** Where it is: the rows read, under the Passage the model named, quoting the headings. */
  citation: Citation;
  /** As read, headings included: "A1:F1240". */
  range: string;
  /** Rows read under the headings, and columns. */
  rows: number;
  columns: number;
  /** Rows the range has under its headings: more than `rows` when only its first ones were read. */
  rowCount: number;
  /** Only part of the range was read: it has more than an Analysis reads, or its sheet was cut when indexed. */
  cut: boolean;
  /** SHA-256 of its headings and rows as read. */
  sha256: string;
}

/** A number an Analysis read from a quote (#447), as `calculate` reads one. */
export interface AnalysisFigureInput {
  kind: "figure";
  name: string;
  input: FigureInput;
  sha256: string;
}

export type AnswerAnalysisInput = AnalysisRangeInput | AnalysisFigureInput;

/**
 * An Analysis an Answer ran (#447, ADR-0023): the code the model wrote, what
 * it read, what it came to, and what that was recorded with, so it can be
 * shown, checked and run again.
 */
export interface AnswerAnalysis {
  /** From 1, in the order the Answer ran them: "Analysis 2". */
  number: number;
  title: string;
  language: AnalysisLanguage;
  code: string;
  inputs: AnswerAnalysisInput[];
  versions: AnalysisVersions | null;
  /** SHA-256 of the code, and of what it came to (its end and output). */
  codeSha256: string;
  outputSha256: string;
  end: AnalysisEnd;
  output: AnalysisOutput;
  ms: number;
  ranAt: string;
  /**
   * The markers the Answer writes its results with: each figure's "[=3]", and
   * each table's, chart's and picture's number, "[=table 1]", "[=chart 1]",
   * "[=picture 1]", counted across the Answer. A `figure()` figure has one only
   * when IncarnaMind worked it out again to the same number. `pictures` is
   * absent in an Analysis run before pictures came back (#2346).
   */
  markers: {
    figures: { result: string; marker: number }[];
    tables: { result: string; marker: number }[];
    charts: number[];
    pictures?: number[];
  };
  /** What IncarnaMind made of each `figure()` figure, by its result's name (ADR-0025). */
  recalculations?: { result: string; check: AnalysisRecalculation }[];
}

/** A successful run kept once by a Note, with only the results its figures still use (ADR-0021). */
export interface RetainedFigureAnalysis
  extends Pick<
    AnswerAnalysis,
    "title" | "language" | "code" | "inputs" | "versions" | "codeSha256" | "ranAt"
  > {
  id: string;
  values: Extract<AnalysisValue, { kind: "figure" }>[];
}

/** A number a calculated figure is worked out from: one read from a Citation's quote. */
export interface FigureInput {
  /** The formula's name for it: "rev2024". */
  name: string;
  /** What it is, with its period, as the model labelled it: "Revenue 2024". */
  label: string;
  /** The Citation it reads the number from, with its own check. */
  citation: Citation;
  number: InputNumber;
  /**
   * In a workbook's rows: the cell the number is in, and the number the cell
   * stores when its shown text isn't that number written plainly (#435),
   * which is the one the formula used. Null for other kinds.
   */
  cell: { sheet: string | null; ref: string; stored: number | null } | null;
  /**
   * The line of the same Passage that states the number's scale or currency
   * ("单位：万元", or "Sale price £385,000.00" above bare figures), given as
   * `unitQuote` when the number has none of its own; null when none was needed.
   */
  unitStatement: {
    citation: Citation;
    scale: number;
    scaleWord: string | null;
    currency: string | null;
    /** The currency's characters as the line writes them ("£", "US$") when it writes them on a figure; absent for a heading's. */
    currencyChars?: string | null;
  } | null;
}

/** A number as an input read it from its quote (see `Figure` in src/shared/figures.ts). */
export interface InputNumber {
  /** As written in the quote: "1.2亿", "(1,250)", "$1,482.6 million". */
  chars: string;
  /** Its UTF-16 offset in the quote: a check reads it there again. */
  at: number;
  /** What the formula used: its scale applied, and the cell's stored number where there is one. */
  value: number;
  scale: number;
  scaleWord: string | null;
  unit: FormulaInput["unit"];
  /** Digits written after its decimal mark. */
  decimals: number;
  approximate: boolean;
  /**
   * The reading the model chose, from 1, when the reader could read the
   * number more than one way (its separator or sign, a range's end, points);
   * null when there was one.
   */
  reading: number | null;
}

/** A Mind opened for editing. */
export interface OpenedMind {
  mind: Mind;
  /** How to show it. Anything but "edit" must not be written to; the core refuses. */
  access: MindAccess;
  /**
   * The Mind's whole Yjs document, encoded as one update: apply it to an empty
   * `Y.Doc`. Empty when `access` is "update-required".
   */
  state: Uint8Array;
}

/** A change to one Mind's Yjs document. */
export interface MindUpdate {
  mindId: string;
  /** A Yjs update (the default v1 encoding). */
  update: Uint8Array;
  /** The edit the User asked for that wrote it (#880). */
  cause?: EditCause;
}

/** An edit the User asked for (#880): the window that asked takes its updates in as its own change, one step of Undo. */
export interface EditCause {
  /** `EditWithAiInput.requestId`. */
  requestId: string;
  /** Its Proposals' `ProposalRef.request`. */
  request: string;
  /** Drawn as applied while it streams in; false until its new text maps onto the selection. */
  apply: boolean;
}

/**
 * What kind of Block a paragraph of a selection is, as the model reads it and
 * writes it back: a heading of a level ("heading:2"), a bullet, a numbered
 * item, a quote, or a plain paragraph.
 */
export type BlockKind = "paragraph" | "bullet" | "numbered" | "quote" | `heading:${number}`;

/** Part of the selection an edit's new text left out, kept (#880): `from`..`to` of a Block's text. */
export interface LeftOutPart {
  blockId: string;
  from: number;
  to: number;
  whole: boolean;
  kind: BlockKind;
}

/** Settings that belong to the User and will sync across their devices (ADR-0003). */
export interface UserSettings {
  language: LanguagePreference;
  /** The default model for Answers, or null before a chat provider is set up. */
  chatModel: ChatModelChoice | null;
  /**
   * The model for the calls that don't write the Answer: an Answer's
   * search query and its translation, and automatic tagging where the
   * provider names no tagging model. Null: the quick-tasks model of the
   * Answers model's provider, from the catalog, or the Answers model itself.
   */
  quickTasksModel: ChatModelChoice | null;
  /**
   * The model that reads a scan's pages when the Answers model can't read
   * images. Null: the image model of the Answers model's provider,
   * from the catalog, when it has one.
   */
  imageModel: ChatModelChoice | null;
  /**
   * Suggest as the User writes, from their Documents (see `suggestNext`): off
   * until they turn it on. Turning it on asks for consent to the "suggestions"
   * flow first, when the default chat model sends to a service.
   */
  suggestWhileWriting: boolean;
  /**
   * Checks and comparison tables leave the files IncarnaMind wrote out of
   * their evidence (#80, see `OwnFile`): on by default. Off, they count
   * everywhere. Copies of the document being checked are left out either way.
   */
  leaveOutOwnFiles: boolean;
  /** How Export and ⇧⌘E export a Mind: the choices last saved in Export options (#100). */
  exportOptions: ExportPreferences;
  /**
   * The name the User's edits go under as tracked changes in a Word file
   * (#107), or null: the name the computer knows them by (`Settings.author`).
   */
  authorName: string | null;
  /**
   * The person, by a random id made once for them and kept with their settings, so their
   * "Checked by me" marks (#1933) are theirs on every device. Null until it is first needed.
   */
  personId: string | null;
  /** The monthly cap on models billed per token: off (null) by default. */
  monthlyCap: MonthlyCap | null;
  /**
   * Answers may search the web through their model's provider, saving the
   * pages they use as Documents (#128): off until the User turns it on.
   */
  webSearch: boolean;
  /**
   * Web pages are kept as they look when saved (`WebPageLook`), unless the
   * save says otherwise: off until the User turns it on.
   */
  keepWebPageLook: boolean;
  /**
   * The system's notifications when a Task needs the User or finishes, unless
   * its Mind is on screen (DESIGN.md, Finding Tasks): on until they turn it
   * off in Settings.
   */
  taskNotifications: boolean;
  /**
   * The citation styles last chosen for a Mind, newest first, up to five
   * (`RECENT_CITATION_STYLES`): the picker's Recently used.
   */
  recentCitationStyles: CitationStyleId[];
  /**
   * The font and text size a new Mind starts in: "Make this the default for new Minds" in a
   * Mind's Style. Minds already made keep theirs.
   */
  newMindStyle: MindStyle;
  /**
   * Words to know (#1031): names and terms the User wants Meetings' Transcripts to get right,
   * newest first. The transcriber on this computer is told them at each Meeting's start.
   */
  meetingWords: string[];
  /** The script Transcripts write Chinese in; null follows the interface (#1031). */
  transcriptScript: ChineseScript | null;
}

/**
 * The "Get started" checklist of a first run, at the bottom of the sidebar:
 * add Documents or connect an app, ask a Question of one's own, and check a
 * Citation. Each step ticks itself as the User does it.
 */
export interface GettingStarted {
  /** Shown: the examples were made on this device's first run. */
  started: boolean;
  /** The User opened a Citation's card. */
  citationChecked: boolean;
  /** The User opened a red ≠ mark, a mistake the check caught, in the example or in a Mind of their own. */
  mistakeSeen: boolean;
  /** A Document of the User's own has been read, not only added, or the User connected an app. */
  indexed: boolean;
  /** The User asked a Question of their own, not the example's. */
  askedOwn: boolean;
  /** The User asked the first open's ready Question (`readyQuestion`). */
  askedReady: boolean;
  /** An own note was exported successfully on this device. */
  exported: boolean;
  /** The User hid the checklist. */
  hidden: boolean;
  /** The first-run card was shown on this device: an empty note keeps no second guide after that (#1940). */
  seen: boolean;
}

/** Settings that belong to this device and never sync (ADR-0003). */
export interface DeviceSettings {
  /** Width of the left sidebar, in CSS pixels. */
  sidebarWidth: number;
  /** The User hid the sidebar (the shortcut, the button, View menu, or dragging it shut). Its width is kept. */
  sidebarHidden: boolean;
  /** The User dismissed the sidebar's line saying the app runs without its sandbox (#1179). */
  sandboxNoticeDismissed: boolean;
  /** The app has opened on this device before: from its second launch it opens on Home. */
  openedBefore: boolean;
  /** The "Get started" checklist's progress on this device (see `GettingStarted`). */
  gettingStarted: GettingStarted;
  /**
   * Skill scripts may run on this device: on by default, and each run still
   * asks first unless the Skill's scripts always run. Off, Answers aren't
   * offered `run_skill_script` at all, scripts running are stopped, and runs
   * waiting for approval are denied.
   */
  skillScriptsEnabled: boolean;
  /**
   * How long a Skill script may run, in seconds, before it is stopped with
   * every process it started: from `SKILL_SCRIPT_LIMITS.minTimeoutSeconds` to
   * `maxTimeoutSeconds`, `defaultTimeoutSeconds` by default.
   */
  skillScriptTimeoutSeconds: number;
  /**
   * How many times the offer to turn on suggestions as the User writes has
   * shown on this device: it shows at most twice (docs/agents/interaction.md, rule 14).
   */
  suggestionOffers: number;
  /**
   * How many times each tip has shown on this device, by its id: a tip shows at most twice, and
   * a closed or used one is counted as shown twice (docs/agents/interaction.md, rule 14).
   */
  tips: Record<string, number>;
  /** What a Meeting records unless the start block says otherwise: the computer's sound too ("Me and them"), or only the microphone. */
  meetingSystemAudio: boolean;
  /**
   * The source a failed model download's line picked on this device (#1578), leading the others.
   * "auto" by default: the probe orders them.
   */
  modelSource: ModelSourceChoice;
  /**
   * Where meeting audio is transcribed, once the User has chosen: at first run (Change on the
   * Meetings job) or in Settings. Null: not chosen, so this computer, and a first Meeting may
   * ask once cloud routes exist (#141).
   */
  transcriptionRoute: TranscriptionRoute | null;
  /**
   * The User has read, once on this device, what a recording captures and
   * that the other people should be told. Recording waits for it.
   */
  meetingNoticeAccepted: boolean;
  /** Settings › Meetings › "Show the call help panel": it appears while a Meeting records. */
  meetingPanel: boolean;
  /** Settings › Meetings › "Keep the panel out of my screen share", where the system honours it. */
  meetingPanelHidden: boolean;
  /** The help buttons' global shortcuts the User changed; the others keep their defaults. */
  meetingHelpKeys: HelpKeys;
  /** How the window moves here (Settings → General → Motion): see `MotionPreference`. */
  motion: MotionPreference;
  /**
   * The model the User last chose here, in a composer or as the Answers default: a Mind with no
   * pick of its own and the assistant with no Mind in focus use it (`modelInUse`). Null until
   * they choose, and again once its provider is removed: they follow `UserSettings.chatModel` then.
   */
  lastChatModel: ChatModelChoice | null;
}

/**
 * Where a Meeting's audio is turned into text: on this computer, or by a cloud service with the
 * User's own key (#141): OpenAI and Qwen (Alibaba Cloud Model Studio, for mainland China) with
 * the key of their provider in Settings › Models, Soniox with a key of its own.
 */
export const TRANSCRIPTION_ROUTES = ["local", "openai", "soniox", "qwen"] as const;
export type TranscriptionRoute = (typeof TRANSCRIPTION_ROUTES)[number];
export type CloudTranscriptionRoute = Exclude<TranscriptionRoute, "local">;

/** A cloud transcription service, as Settings and the first-meeting sheet offer it. */
export interface TranscriptionServiceStatus {
  route: CloudTranscriptionRoute;
  name: string;
  /** Who gets the audio, as the consent line names it ("Alibaba Cloud" for Qwen). */
  recipient: Localized;
  model: string;
  perHour: Money;
  /** The region the key is for, named as in Settings › Models. */
  region: Localized | null;
  dataUse: { summary: Localized; url: Localized } | null;
  /** "provider": it uses the key of the chat provider of the same name in Settings › Models. */
  key: "provider" | "own";
  hasKey: boolean;
  liveSpeakers: boolean;
  keyUrl: string | null;
  /**
   * It was chosen, and set back to this computer when its key began to send the audio somewhere
   * the User hadn't chosen (a Qwen key for another region): choosing it again sends it there.
   */
  chooseAgain: boolean;
}

/**
 * The transcription services and the core's revision of what they say. The revision grows with
 * every committed change (a key kept or forgotten, a provider saved or deleted). A list is
 * stamped with the revision it began at, so of two answers the one to keep is the one with the
 * higher revision, whichever was asked first.
 */
export interface TranscriptionServices {
  revision: number;
  services: TranscriptionServiceStatus[];
}

export interface SetTranscriptionKeyInput {
  route: CloudTranscriptionRoute;
  apiKey: string;
}

/**
 * How the window moves on a device (DESIGN.md, Motion): as the system's own
 * Reduce motion setting says ("system", until the User chooses), on,
 * reduced (movement becomes short fades) or off (every change is instant).
 */
export const MOTION_PREFERENCES = ["system", "on", "reduced", "off"] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

/**
 * How the programs Tools start (Skill scripts) are confined:
 * - "none": not at all; they run as the User, with the User's permissions
 *   (Windows; Linux without bubblewrap).
 * - "os": in the OS sandbox (macOS Seatbelt, Linux bubblewrap): they can't
 *   read the User's home or IncarnaMind's data folder, write only their
 *   working folder, and have no network.
 * - "container": in a container or virtual machine on this computer.
 * - "remote": on another machine (the hosted version).
 */
export type SandboxLevel = "none" | "os" | "container" | "remote";

export interface Settings {
  user: UserSettings;
  device: DeviceSettings;
  /** The interface language in effect: the User's choice, or the OS language for "system". */
  language: Language;
  /**
   * How Skill scripts run on this device, found out when the app starts: not
   * a setting. The approval card and Settings say what a script can reach by it.
   */
  scriptSandbox: SandboxLevel;
  /**
   * What this copy can record for a Meeting, found out when the app starts:
   * not a setting. "both": the microphone and the computer's sound; "microphone":
   * the microphone only (Linux, for now); "none": nothing (no capture).
   */
  meetingAudio: "both" | "microphone" | "none";
  /**
   * The name the User's edits go under as tracked changes in a Word file
   * (#107): `UserSettings.authorName`, or the name the computer knows them by.
   */
  author: string;
  /** The script Transcripts write Chinese in: `UserSettings.transcriptScript`, or the interface's. */
  chineseScript: ChineseScript;
}

export interface SettingsPatch {
  user?: Partial<UserSettings>;
  device?: Partial<DeviceSettings>;
}

// ---------------------------------------------------------------------------
// Tabs and groups: everything that opens is a tab, in up to three groups side
// by side, as VS Code's editor groups. Each window keeps its own layout.

/** At most this many groups sit side by side. */
export const MAX_TAB_GROUPS = 3;

/** What a tab shows. The Library has one tab per window. */
export type TabItem =
  | { kind: "mind"; mindId: string }
  | { kind: "figures"; mindId: string }
  | { kind: "library" }
  | { kind: "home" }
  | { kind: "document"; documentId: string };

/** What the viewer knows of the Citation a Document was opened from. */
export interface TabCitation {
  check: CitationCheck;
  /** The number the Citation shows in its Answer, from 1. */
  number?: number;
  /** Its Location's short label, e.g. "slide 4" or "Revenue, rows 12–14": the mark shows it. */
  label?: string;
  /**
   * The version of the Document it quotes: with the Document gone, the viewer
   * tells whether that text was kept because its Linked folder was unlinked.
   */
  contentHash?: string;
  /** Where in the Document it points, as it shows ("Revenue, rows 12–14"): its label, narrower than the Units. */
  location?: CitationLocation;
  /** The Units the Citation itself cites, when the tab was opened at another place: a quote that moved. */
  pageFrom?: number;
  pageTo?: number;
}

/** Where in its Document a Document tab was opened: a Citation's Units and quote. */
export interface DocumentPlace {
  /**
   * The first Unit to show, from 1 (ADR-0011): a PDF's page, a deck's slide,
   * otherwise the number of a section, block of rows or block of lines.
   */
  pageFrom?: number;
  /** The last Unit the quote may be in. Defaults to `pageFrom`. */
  pageTo?: number;
  /**
   * Text to highlight if it is found: in the Units from `pageFrom` to
   * `pageTo` (the viewer scrolls to it), or without them, anywhere in a
   * TXT or Markdown file.
   */
  quote?: string;
  /** A saved web page's picture the quote was read from, numbered in the page from 1: it is outlined. */
  figure?: number;
  /** The Citation this was opened from, if a Citation opened it. */
  citation?: TabCitation;
  /**
   * The Document as it is now, not the version its Citation quotes (#2159): "Open the
   * current version" from the cited version's view, which keeps the Citation so the
   * viewer still says the Document changed, as it did before the version was shown.
   */
  currentVersion?: true;
  /**
   * In a Word file: the paragraph or table to go to, by its place in the main document
   * part ("w:p#12", "w:tbl#3"), as a Mind imported from it records (`WordSource.n`, #736).
   */
  wordPlace?: string;
}

export interface LayoutTab {
  id: string;
  item: TabItem;
  /**
   * A preview (its title in italics): the next Document opened as a preview
   * in its group replaces it, until the User keeps it. Only Documents open as previews.
   */
  preview: boolean;
  /** Kept at the left of its group; ⌘W and a middle click leave it open. */
  pinned: boolean;
  /** A Document tab: where it was last opened with a place, if it was. */
  place: DocumentPlace | null;
  /** How many times it was opened with a place: each time, the viewer goes there again. */
  opened: number;
}

export interface LayoutGroup {
  id: string;
  /** In order, the pinned ones first. */
  tabs: LayoutTab[];
  /** The tab it shows: null only in an empty window's one group. */
  activeTabId: string | null;
  /** Its share of the width, above 0; the groups' shares add up to 1. */
  width: number;
}

export interface WindowLayout {
  /** From left to right: one to `MAX_TAB_GROUPS`. Only a window's one group may be empty. */
  groups: LayoutGroup[];
  /** The group the User is in: shortcuts such as ⌘W act on it. */
  focusedGroupId: string;
  /** How many closed tabs ⇧⌘T can reopen, most recent first. */
  reopenable: number;
  /** Where the window's one assistant sits, outside the groups, and its sizes. */
  assistant: AssistantPlace;
}

/**
 * Where the assistant sits (#253): docked on the window's right, left or
 * bottom edge, beside the card, or floating over it.
 */
export type AssistantDock = "right" | "left" | "bottom" | "float";

/** A window's corner: a floating assistant keeps its distance to the one nearest it. */
export type AssistantCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** A floating assistant's size and place, in CSS pixels. */
export interface AssistantFloat {
  width: number;
  height: number;
  /** The window's corner nearest to it. */
  corner: AssistantCorner;
  /** From the corner's side of the window (its left or right edge) to the box's. */
  x: number;
  /** From the corner's top or bottom edge of the window to the box's. */
  y: number;
}

/**
 * The User's choices for the assistant, kept with the window's layout. A side
 * dock shows at the bottom while the window is narrow, without changing `dock`.
 */
export interface AssistantPlace {
  dock: AssistantDock;
  /** Folded: a 44px rail on a side, or only its header at the bottom or floating. */
  folded: boolean;
  /** A side dock's width, in CSS pixels. */
  width: number;
  /** A bottom dock's height, in CSS pixels. */
  height: number;
  float: AssistantFloat;
}

/** A new window's assistant: docked on the right, at its default sizes (#253). */
export const DEFAULT_ASSISTANT: AssistantPlace = {
  dock: "right",
  folded: false,
  width: 320,
  height: 300,
  float: { width: 380, height: 520, corner: "top-right", x: 24, y: 56 },
};

/**
 * Where `open` puts what it opens:
 * - "place" (the default): revealed where it is open, else a new tab in the focused group;
 * - "side": in the group right of `from` (the focused group by default), made if
 *   there are fewer than three, else the one to its left; revealed instead if it
 *   is open in another group than `from`;
 * - "beside": revealed where it is open, else in the focused group if that shows a
 *   Document, else to the side of it (Documents opened from a list);
 * - "group": a new tab in that group (the focused one by default), before `before`
 *   (at the end for null; after the active tab when left out).
 */
export type OpenWhere =
  | { in: "place" }
  | { in: "side"; from?: string }
  | { in: "beside" }
  | { in: "group"; groupId?: string; before?: string | null };

/** A change to a window's layout (see `CoreApi.changeLayout`). */
export type LayoutChange =
  | {
      type: "open";
      item: TabItem;
      where?: OpenWhere;
      /** A Document as a preview, replacing the group's preview if it has one. */
      preview?: boolean;
      /** A Document already open as a preview is kept, as a double-click on its tab does. */
      keep?: boolean;
      /** Its group becomes the focused one: true unless false. */
      focus?: boolean;
      /**
       * Opened behind the tab shown, which stays in front with the focus, as a middle click opens
       * a browser's tab; several in a row keep the order they were opened in.
       */
      behind?: boolean;
      /** A Document: where in it, e.g. a Citation's quote. */
      place?: DocumentPlace;
    }
  /** Shows a tab in its group, which takes the focus. */
  | { type: "show"; tabId: string }
  | { type: "close"; tabId: string }
  /** Closes the other tabs of its group, except pinned ones. */
  | { type: "closeOthers"; tabId: string }
  /** Closes the tabs after it in its group, except pinned ones. */
  | { type: "closeToTheRight"; tabId: string }
  | { type: "closeGroup"; groupId: string }
  /** Reopens the tab closed last, where it was. */
  | { type: "reopen" }
  /** Moves a tab before another one (to the end for null), in its group or another; it stops being a preview. */
  | { type: "move"; tabId: string; groupId: string; before: string | null }
  /**
   * Puts a tab in a new group to the `side` of `groupId` (its own group by
   * default): a copy of it (⌥⌘\), or the tab itself (a drag). Nothing happens
   * with `MAX_TAB_GROUPS` groups already.
   */
  | { type: "split"; tabId: string; side: "left" | "right"; copy: boolean; groupId?: string }
  /** A preview becomes a normal tab. */
  | { type: "keep"; tabId: string }
  | { type: "pin"; tabId: string; pinned: boolean }
  | { type: "focus"; groupId: string }
  /** The groups' widths, left to right, in any unit: they are made shares of 1. */
  | { type: "resize"; widths: number[] }
  /** Every group as wide as the others. */
  | { type: "equalize" }
  /** Moves, resizes, folds or unfolds the assistant: what is given changes, the rest stays. */
  | { type: "assistant"; place: Partial<AssistantPlace> };

/**
 * The kinds of Document (ADR-0011): files of PDF, plain text, Markdown, Word
 * (.docx), PowerPoint (.pptx), Excel (.xlsx) and CSV, web pages saved by
 * their address (#261), and Transcripts, WebVTT files (#136).
 */
export type DocumentKind =
  | "pdf"
  | "text"
  | "markdown"
  | "docx"
  | "pptx"
  | "xlsx"
  | "csv"
  | "web"
  | "transcript";

/**
 * Where a Document is in processing: "queued", then "extracting" its text,
 * then "ready": its Passages are in the keyword index, and search finds them.
 * Embeddings are off by default; while the User has them on, a Document is
 * "embedding" its Passages with the embedding model (the built-in one unless
 * the User chose another) between "extracting" and "ready". Documents are
 * embedded one at a time: one waiting its turn is "queued" again. Before the
 * model has been downloaded, or while the chosen provider can't be used, a
 * Document waits after extracting as "waiting-for-model", and carries on by
 * itself once it can; keyword search already finds its Passages. Turning
 * embeddings on, or switching the model, takes every Document without the
 * model's vectors through "embedding" (see `EmbeddingRebuild`).
 * The other end states are "failed" (see `failure`) and "no-text": the file
 * has no text to extract, e.g. a scan without a text layer. When a new
 * version of a file fails (a sync client wrote it half-way, it is corrupt),
 * the last good version stays indexed: its text is still searched and read,
 * `contentHash` is still its, and the Document is "failed" until a later
 * change of the file, or a retry, is read.
 */
export type DocumentStatus =
  | "queued"
  | "extracting"
  | "waiting-for-model"
  | "embedding"
  | "ready"
  | "failed"
  | "no-text";

export type DocumentFailureReason =
  /** The file isn't valid (a broken PDF or Office file), or a text file holds binary data. */
  | "unreadable"
  | "password-protected"
  /**
   * A Word, PowerPoint or Excel file too large to open: over 500 MB, or with
   * parts that inflate past 1 GB together. The message names the limit.
   */
  | "too-large"
  /**
   * No longer given: a file that has gone is a "missing" Document (see
   * `DocumentFileStatus`), not a failed one. Kept so older data still reads.
   */
  | "file-missing"
  /** Anything else, e.g. the processing worker crashed. */
  | "processing-error"
  /**
   * Scanned pages couldn't be read (#397): the text recognition model
   * couldn't be downloaded or failed on them. The pages that were read are
   * searched; Retry reads the others.
   */
  | "pages-unread"
  | "forms-unread"
  /**
   * The app stopped while it was being read, not closed in good order: it
   * isn't read again by itself, as it could stop the app again. Retry reads it.
   */
  | "app-stopped";

export interface DocumentFailure {
  reason: DocumentFailureReason;
  /** Technical detail in English, for logs and tooltips. */
  message: string;
  /** "pages-unread": the scanned pages that couldn't be read, from 1; empty when none could be. */
  pages?: number[];
}

/** Where reading a PDF's scanned pages, or a saved web page's pictures, is while it is processed. */
export interface DocumentScanProgress {
  /** How many of its pages are scans to read, or of a saved web page's pictures. */
  pages: number;
  /** How many of them are read so far. */
  read: number;
  of: "scanned-pages" | "pictures";
}

/**
 * Where automatic tagging is for a Document. It runs once the Document is
 * "ready", and never holds that up: a Document is searchable as soon as it is
 * embedded, tagged or not. The tagger is Jev when a Jev key is set up on this
 * device (see `getJevSettings`), otherwise the default chat model.
 * - "pending": tagged once processing finishes, or about to be.
 * - "waiting-for-provider": no tagger can be used yet (no chat model is set
 *   up, a key or sign-in is missing, or the User declined sending excerpts to
 *   the tagger's service). Tagging resumes by itself once one can.
 * - "tagging": the tagger is deciding the Document's Tags.
 * - "tagged": its automatic Tags are up to date. With none, the tagger asked
 *   and none fit.
 * - "no-tags": there were no Tags to choose from and the tagger only chooses
 *   (Jev, a decision model), so no model was asked. It is tagged once a Tag
 *   exists. The chat model names Tags of its own, so it is asked anyway; a
 *   Document it gives none is "no-tags" too.
 * - "failed": the tagger's provider failed (see `taggingError`); a re-tag, a
 *   change of model or a restart tries again.
 * - "skipped": the Document has no text to tag (processing failed, or found none).
 * - "stopped": Tagging with AI is stopped where it is, in its Folder or Not in
 *   a Folder (see `stopTagging`): nothing is sent until it is turned back on.
 * - "off": the Document came in while automatic tagging and sorting was off
 *   (`LibrarySettings.automatic`, off for a cloud model until the User turns
 *   it on): nothing is sent for it, and turning the switch on, or reading
 *   it again (a newer pipeline, its file changed), doesn't tag it. Organize,
 *   or a re-tag the User asks for, does.
 */
export type TaggingState =
  | "pending"
  | "waiting-for-provider"
  | "tagging"
  | "tagged"
  | "no-tags"
  | "failed"
  | "skipped"
  | "stopped"
  | "off";

/** Who put a Tag on a Document: automatic tagging, or the User. */
export type TagSource = "automatic" | "user";

/** A Tag on a Document. */
export interface DocumentTag {
  tagId: string;
  /**
   * "automatic": automatic tagging applied it, and a re-tag may take it away.
   * "user": the User added it; automatic tagging never changes it.
   */
  source: TagSource;
  /**
   * How likely automatic tagging found it that the Tag applies, from 0 to 1,
   * when its tagger says (Jev does). Null for the chat model and for the User's Tags.
   */
  confidence: number | null;
  /**
   * Automatic tagging wasn't sure (Jev's probability fell in the review band),
   * so the Tag is applied and marked for the User to check: `addDocumentTag`
   * confirms it, making it theirs, and `removeDocumentTag` takes it off.
   */
  needsReview: boolean;
}

/**
 * Where a Document's file is (ADR-0010), separately from `status`:
 * - "available": at its path, as last seen.
 * - "missing": gone from its path, and no file elsewhere matched it as moved.
 *   Its Linked folder (or, for a file added on its own, the folder it was in)
 *   is still there. It keeps its text, Passages, Tags and Citations, but new
 *   searches leave it out. If the file comes back, it isn't missing any more.
 * - "unavailable": can't be reached right now: its Linked folder (an
 *   unplugged drive, an unmounted share), or the folder a single file was in,
 *   is gone, or the file can't be read. It stays searchable from its stored
 *   text; only opening the file fails. Checked again later.
 */
export type DocumentFileStatus = "available" | "missing" | "unavailable";

export interface Document {
  /** A random UUID generated on this device. */
  id: string;
  /** The display name. It starts as the file name without its extension and can be renamed. */
  name: string;
  kind: DocumentKind;
  /**
   * The version whose text is indexed: the SHA-256 of the file's bytes as
   * they were read, in hex. When the file changes, the new version is
   * processed, and this changes once its text is indexed (not if it fails:
   * see `DocumentStatus`). A file found at a
   * new path with the hash of a Document whose file went is that Document,
   * moved. The same content at two paths is two Documents.
   */
  contentHash: string;
  /**
   * The file, where the User keeps it on this computer: an absolute path.
   * IncarnaMind never changes the file. A web page's is its snapshot, in the
   * data folder. Not what the Document is known by (ADR-0020): that is its
   * Linked folder and its path inside it, its place in the data folder, or,
   * for a file added on its own, its id; so it can be elsewhere on another
   * computer, or after its Linked folder is located somewhere else.
   */
  path: string;
  /** Where the file is: see `DocumentFileStatus`. */
  fileStatus: DocumentFileStatus;
  /**
   * Its file is IncarnaMind's own, inside the data folder: a saved web page's
   * snapshot, or a Meeting's Transcript. It is not a file the User keeps on
   * this computer, so it has no path to show and no app to open it in (#763).
   */
  keptByApp: boolean;
  /** The Linked folder the file is in, or null for a file added on its own ("Other Documents"). */
  linkedFolderId: string | null;
  /** In bytes. */
  size: number;
  /** PDFs only, once their text has been extracted. */
  pageCount: number | null;
  status: DocumentStatus;
  /** While `status` is "embedding": the share of its Passages embedded so far, from 0 to 1. Null otherwise. */
  progress: number | null;
  /**
   * While `status` is "extracting" and its scanned pages are read (#397): how far that is.
   * While "queued" after its scanned pages were found, waiting its turn to be read beside the
   * other Documents (#1502): how many there are. Null otherwise.
   */
  scan: DocumentScanProgress | null;
  /** Set when `status` is "failed": why the latest version read failed. */
  failure: DocumentFailure | null;
  /**
   * What of it wasn't read when the rest was (#740): a workbook's hidden sheets and the sheets
   * the reading limit cut short. Null when all of it was, and for every other kind.
   */
  unreadParts: UnreadParts | null;
  /**
   * Its stored `unreadParts` couldn't be read (damaged data): what it left unread is unknown,
   * never taken for everything read. The unread list says so, and the log names the Document.
   */
  unreadPartsUnknown: boolean;
  /**
   * A workbook is read with its hidden and very hidden sheets (#740), because the User asked,
   * so the viewer shows them too and every version read after keeps reading them.
   */
  readHiddenSheets: boolean;
  /**
   * The Folder its file is in: the Linked folder's own Folder, or one inside
   * it. Null for a file added on its own.
   */
  folderId: string | null;
  /** The Tags on the Document, in Tag name order (ignoring case). */
  tags: DocumentTag[];
  /** Where automatic tagging is, separately from `status`. */
  tagging: TaggingState;
  /**
   * Set when `tagging` is "failed", and when it is "waiting-for-provider" for
   * a reason worth saying, such as the ChatGPT plan's limit ("plan-limit") or
   * a model's rate limit ("rate-limit", with `resetsAt`).
   */
  taggingError: ProviderError | null;
  /**
   * When the Document itself was created, as its file tells, for the
   * Library's year: the creation date in its metadata (a PDF's Info
   * dictionary or XMP, the core properties of a Word, PowerPoint or Excel
   * file), or else the latest year written in its first Unit. Never a
   * modification date. ISO 8601 at the precision the file gives, with the
   * offset from UTC it gives, so its first four characters are the year:
   * "2019-03-04T10:30:00+01:00", "2019-03-04", or "2019" from text. Null if
   * nothing gives one from 1900 to this year, or until it is read: as the
   * Document is processed, or for one indexed before dates were read, once,
   * in the background. Not to be confused with `createdAt`.
   */
  creationDate: string | null;
  /**
   * When the file was last modified, as the file system says, as last seen
   * when it was indexed or its folder rescanned. ISO 8601, UTC. Null for a
   * Document with no file of its own, and until a scan has seen it.
   */
  modifiedAt: string | null;
  /**
   * The Document's own title (#213), for when its file name is machine-made
   * (a UUID, "Untitled"): the title in its properties, else its first
   * heading, else its first line. Null if it has none, or until it is read.
   */
  title: string | null;
  /** A web page's address and what it says of itself; null for a file. */
  web: WebPageInfo | null;
  /**
   * What a Citation of it needs to say (#286): its reference record, read
   * from its file and edited by the User. Null until its file has been read.
   */
  reference: ReferenceRecord | null;
  /**
   * Set when IncarnaMind wrote the Document's file (#80): see `OwnFile`.
   * Null for the User's own files, and for the sources IncarnaMind saves
   * (web pages, Transcripts), which count as evidence as usual.
   */
  ownFile: OwnFile | null;
  /**
   * The User keeps it as their own workings: a spreadsheet of figures copied from a
   * report, with their own ratios. Answers search and read it to understand a Question but
   * never cite it, and checks never use it as evidence (`setNotCited`).
   */
  notCited: boolean;
  /** Where its text came from, when Find sources added it (#296); null for any other Document. */
  found: DocumentFoundSource | null;
  /**
   * The Mind this file was last imported as, still there (#720): the User's working copy of
   * it, which is never cited. Null for a file never imported.
   */
  importedAs: string | null;
  /** When the Document was added to IncarnaMind. ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

/** What IncarnaMind writes that checks leave out of their evidence (#80): a Mind's export, or a source pack. */
export const ownFileKinds = ["export", "source-pack"] as const;
export type OwnFileKind = (typeof ownFileKinds)[number];

/**
 * A Document whose file IncarnaMind wrote (#80): an export or a source pack
 * it saved, found by the file's content fingerprint, e.g. once saved into a
 * Linked folder. It stays one when the User edits the file, since what it
 * says still came from the Mind. Checks and comparison tables leave it out of
 * their evidence, so a note can't support itself, unless the User counts it
 * ("Count it"), its Folder counts IncarnaMind's files (`LibraryGroup.countsOwnFiles`),
 * or Settings does (`UserSettings.leaveOutOwnFiles` off). Ordinary Answers search it as usual.
 */
export interface OwnFile {
  kind: OwnFileKind;
  /** The User counts it as evidence all the same, until they take that back (`setCountedAsEvidence`). */
  counted: boolean;
}

/**
 * Why a check leaves a Document out of its evidence (#80):
 * - "own-file": IncarnaMind wrote it (see `OwnFile`). Counting it lets it count.
 * - "own-workings": the User keeps it as their own workings (`Document.notCited`).
 *   Never evidence, counted or not, until the User cites it again.
 * - "checked-document": it is the document being checked, an earlier version
 *   of it, or a copy of either (the same content fingerprint, at any path).
 *   Never evidence for that check.
 */
export type EvidenceExclusion = "own-file" | "own-workings" | "checked-document";

/** The document a check verifies (#97, #110): it, its earlier versions and their copies are never its evidence. */
export interface CheckedDocument {
  /** Its Documents. */
  documentIds?: string[];
  /** The content fingerprints (SHA-256, hex) of a checked file that isn't a Document, e.g. an imported .docx. */
  contentHashes?: string[];
}

export interface SearchEvidenceOptions {
  /** The check's Search scope. None: every Document. */
  scope?: SearchScope;
  checked?: CheckedDocument;
}

/** A Document a check left out of its evidence, where it matched: a result names it, never hides it. */
export interface ExcludedEvidence {
  documentId: string;
  documentName: string;
  reason: EvidenceExclusion;
  /** Its Passages that matched, in reading order: where it would have been evidence. */
  passages: PassageSearchResult[];
}

/** What a check's search found (`searchEvidence`). */
export interface EvidenceSearchResult {
  /** The evidence: what the search Tool gives an Answer, from the Documents a check may use. */
  passages: PassageSearchResult[];
  /** The Documents left out that matched too, the best first. */
  excluded: ExcludedEvidence[];
}

/**
 * A web page saved as a Document (#261): its snapshot is the Document's file,
 * kept in the data folder, and each fetch that changed it is a new version.
 */
export interface WebPageInfo {
  /** The address it was saved from: http or https, without a fragment. */
  address: string;
  /**
   * Who saved it: "user" (Add a web page, Save page, a source the User chose to add) or "search"
   * (read by an Answer's web search). A page from before this was kept reads as "search" until
   * the User saves its address again.
   */
  origin: WebPageOrigin;
  /** The site's name, as the page gives it, else its host. */
  siteName: string;
  author: string | null;
  /** When the page says it was published, as it gives it; null if it doesn't. */
  published: string | null;
  /** When it was last fetched. ISO 8601, UTC. */
  fetchedAt: string;
  /** When each version kept was last fetched, for the Citations that quote an older one. */
  versions: { contentHash: string; fetchedAt: string }[];
  /**
   * The article's pictures the last fetch didn't keep because of the caps
   * (#756): over 60, over 5 MB, or past 25 MB for the page.
   */
  picturesLeftOut: number;
  /** The last fetch kept as it looks; null when it wasn't asked to be. */
  look: WebPageLook | null;
}

export type WebPageOrigin = "user" | "search";

/** What `saveWebPage` takes. */
export interface SaveWebPageInput {
  /** An http or https address; one without a scheme ("example.com/page") is read as https. */
  address: string;
  /** The page's HTML, when the caller has it already (a page open in the app): nothing is fetched. */
  html?: string;
  /** The Library Folder to file a new Document in; none or null: Unsorted. */
  folderId?: string | null;
  /**
   * Keep the page as it looks too (see `WebPageLook`), whose full load may
   * reach the other sites the page draws from. Absent: as
   * `UserSettings.keepWebPageLook` says. Ignored with `html`.
   */
  keepLook?: boolean;
  /**
   * Local mode is on and the User let this one page be fetched ("Fetch this
   * page once"): without it, an address that isn't saved yet isn't fetched in
   * Local mode, and the result says why ("local-mode"). It doesn't turn Local
   * mode off.
   */
  localModeOnce?: boolean;
}

/** What `fetchWebPageAgain` takes besides the Document. */
export interface FetchWebPageAgainOptions {
  /** As `SaveWebPageInput.localModeOnce`. */
  localModeOnce?: boolean;
}

/**
 * A web page's version kept as it looks: a PDF of the page as a browser
 * showed it, made once, in the background, in a hidden page that reaches
 * only the public internet (src/main/pageLook.ts).
 * - "saving": being made.
 * - "saved": made at `savedAt` (ISO 8601, UTC), served at
 *   `documentImageUrl(documentId, path)`.
 * - "failed": it couldn't be made.
 */
export type WebPageLook =
  | { status: "saving" }
  | { status: "saved"; savedAt: string; path: string }
  | { status: "failed"; failure: WebPageLookFailure };

/**
 * Why a page's look couldn't be kept: "timed-out", it didn't load in 30
 * seconds; "unreachable", it couldn't be loaded; "too-large", its PDF is over
 * 50 MB; "stopped", IncarnaMind stopped while making it, twice; "local-mode",
 * "Keep everything on this computer" is on, so the page wasn't loaded; "failed",
 * anything else.
 */
export type WebPageLookFailure =
  | "timed-out"
  | "unreachable"
  | "too-large"
  | "stopped"
  | "local-mode"
  | "failed";

/**
 * Why a web page wasn't saved, or wasn't fetched again:
 * - "invalid-address": not an http or https address.
 * - "unreachable": the site couldn't be reached (offline, no such site, a
 *   connection refused or a certificate that isn't valid).
 * - "timed-out": the site took too long to answer.
 * - "not-found": the site has no such page (404, 410).
 * - "needs-sign-in": the page is behind a sign-in (401, 403, a login form).
 * - "too-large": the page is larger than IncarnaMind fetches.
 * - "site-error": the site answered with another error.
 * - "not-a-page": the address is a file (a PDF, an image), not a web page.
 * - "video": the page is a video, with little text to read.
 * - "not-text": the page has too little text to read, such as an app.
 * - "not-public": web search's fetcher refused it: the address is on this
 *   computer or a local network, or redirects there (#128).
 * - "too-many-redirects": it redirected more than web search's fetcher follows.
 * - "not-from-search": web search fetches only the pages its search returned
 *   in the same Answer, and this wasn't one.
 * - "local-mode": "Keep everything on this computer" is on, so nothing was
 *   fetched: the site would have seen the request, and the address can name
 *   a matter. The User can let this one page go (`localModeOnce`).
 * - "kept-inside": the Answer's work stays inside a walled Folder that can't
 *   be found now, so the page wasn't saved anywhere (#1934).
 */
export type WebPageFailureReason =
  | "invalid-address"
  | "unreachable"
  | "timed-out"
  | "not-found"
  | "needs-sign-in"
  | "too-large"
  | "site-error"
  | "not-a-page"
  | "video"
  | "not-text"
  | "not-public"
  | "too-many-redirects"
  | "not-from-search"
  | "local-mode"
  | "kept-inside";

export interface WebPageFailure {
  reason: WebPageFailureReason;
  /** Technical detail in English, for logs and tooltips. */
  message: string;
}

/** What saving a web page, or fetching it again, came to. */
export type WebPageResult =
  | {
      outcome: "saved";
      document: Document;
      /** The address was saved already: `saveWebPage` returns its Document as it is. */
      existing: boolean;
      /**
       * `saveWebPage` only: the page was saved, but not into `folderId`, which gained a wall
       * meanwhile, so it is in the Library outside it (#2250).
       */
      notFiled?: true;
    }
  | { outcome: "failed"; address: string; failure: WebPageFailure };

/**
 * The kinds of work a reference record describes (#286), by their Citation
 * Style Language names, so citation styles (#289) and CSL JSON (#287, #302)
 * read them as they are: a journal article, a conference paper, a book
 * chapter, a book, a thesis, a report, a web page, a preprint ("article").
 * "document" is Other: nothing more is known.
 */
export const referenceTypes = [
  "article-journal",
  "paper-conference",
  "chapter",
  "book",
  "thesis",
  "report",
  "webpage",
  "article",
  "document",
] as const;

export type ReferenceType = (typeof referenceTypes)[number];

/**
 * A name in a reference record, as CSL JSON writes it: a person's family and
 * given names, or a name kept whole, as written: a Chinese, Japanese or
 * Korean name (family name first, never split as a Western name is) or an
 * organisation.
 */
export type ReferenceName = { family: string; given: string } | { literal: string };

/**
 * A reference record's fields (#286): what a citation style needs to cite a
 * Document. An empty string, or no names, is an empty field.
 */
export interface ReferenceFields {
  type: ReferenceType;
  title: string;
  /** In the order the work gives them; never re-ordered. */
  authors: ReferenceName[];
  /** When it was published, ISO 8601 at the precision known: "2010", "2010-08" or "2010-08-04". */
  issued: string;
  /** Where it was published: the journal, the book a chapter is in, the conference, the website. */
  containerTitle: string;
  volume: string;
  issue: string;
  /** Its pages in that: "456" or "456–470". */
  pages: string;
  publisher: string;
  /** Without "https://doi.org/": "10.1186/1471-2458-10-456". */
  doi: string;
  /** A web page's address, or a preprint's ("https://arxiv.org/abs/1706.03762"). */
  url: string;
  /** What it is written in, as a BCP 47 tag: "en", "zh". */
  language: string;
}

export type ReferenceField = keyof ReferenceFields;

/**
 * Where a field's value came from:
 * - "file": read from the file (its properties, or a DOI or arXiv id in its
 *   first pages). Reading the file again, as a new version is processed,
 *   replaces it.
 * - "lookup": filled by Look up (Crossref or arXiv), into a field that was empty.
 * - "import": from a reference export (Zotero, EndNote, BibTeX, RIS, CSL JSON,
 *   #287). Importing again replaces it; reading the file doesn't. It replaces a
 *   value read from the file, and fills empty fields; Look up's and the User's stay.
 * - "user": the User typed it, or cleared it. Nothing replaces it.
 */
export type ReferenceSource = "file" | "lookup" | "import" | "user";

/** A reference record: a Document's fields as a citation style needs them (#286). */
export interface ReferenceRecord {
  /** A random UUID generated on this device. */
  id: string;
  fields: ReferenceFields;
  /** Where each field's value came from; a field with no value and no source is empty. */
  sources: Partial<Record<ReferenceField, ReferenceSource>>;
  /** When Look up last filled it. ISO 8601, UTC. Null if never. */
  lookedUpAt: string | null;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

/** Fields the User typed: each replaces its value, and is theirs ("user"). "" or no names clears one. */
export type ReferencePatch = Partial<ReferenceFields>;

/**
 * Why Look up didn't fill a reference record:
 * - "no-identifier": it has no DOI, and no arXiv address, to look up.
 * - "local-mode": "Keep everything on this computer" is on.
 * - "declined": the User didn't allow sending the identifier.
 * - "not-found": the service has no record for it.
 * - "unreachable": the service couldn't be reached, or took too long.
 * - "service-error": the service answered with an error, or with something unreadable.
 */
export type ReferenceLookupFailureReason =
  | "no-identifier"
  | "local-mode"
  | "declined"
  | "not-found"
  | "unreachable"
  | "service-error";

/** A service a reference is looked up in. */
export type ReferenceService = "crossref" | "openalex" | "arxiv";

/**
 * How a reference in a Mind's reference list checks, looked up in
 * Crossref, then OpenAlex, and an arXiv number on arXiv:
 * - "found": the work exists, as written;
 * - "mismatch": a record exists, but its title, year or first author differ;
 * - "not-found": the DOI or arXiv number it gives leads nowhere: no agency
 *   registered it, or arXiv has no such preprint;
 * - "not-listed": searched for as written, neither Crossref nor OpenAlex has
 *   a record like it. It may still exist: neither holds every conference
 *   paper, preprint or Chinese journal;
 * - "not-checked": it couldn't be asked about (`ReferenceCheck.reason`).
 */
export type ReferenceCheckMark = "found" | "mismatch" | "not-found" | "not-listed" | "not-checked";

/**
 * Why a reference wasn't checked; "registered-elsewhere": its DOI exists,
 * but another agency than Crossref registered it and OpenAlex has no record
 * of it either, so its details couldn't be compared.
 */
export type ReferenceCheckReason =
  | "local-mode"
  | "declined"
  | "unreachable"
  | "rate-limited"
  | "service-error"
  | "registered-elsewhere";

/** How a reference differs from the record of the work it names. */
export interface ReferenceDifference {
  field: "title" | "authors" | "year";
  /** As the record has it: the authors as "Hochreiter, Schmidhuber". */
  found: string;
  /** As the reference has it, when it can be read alone (its year). */
  cited: string | null;
}

export interface ReferenceCheck {
  /** As written, its white space collapsed. */
  reference: string;
  mark: ReferenceCheckMark;
  /** Whose record it is, which said its identifier leads nowhere, or which couldn't be asked. */
  service: ReferenceService | null;
  /** The record of the work it names; null when none was found, or it wasn't checked. */
  record: {
    title: string;
    authors: ReferenceName[];
    year: number | null;
    doi: string | null;
  } | null;
  /** For "mismatch": how it differs. */
  differences: ReferenceDifference[];
  /** For "not-checked": why. */
  reason: ReferenceCheckReason | null;
  /** "rate-limited": when the service takes requests again, as it said (ISO 8601). */
  resetsAt?: string;
}

export type CheckReferencesResult =
  | {
      kind: "checked";
      /** Each entry of the reference list, in order, with the Block it is in. */
      references: (ReferenceCheck & { blockId: string })[];
    }
  /** The Mind has no reference list: no heading such as "References" or "参考文献". */
  | { kind: "no-references" }
  /** Stopped by `stopReferenceCheck`, or the Mind went. */
  | { kind: "cancelled" };

/** What Look up came to. */
export type ReferenceLookupResult =
  | {
      outcome: "filled";
      /** The Document, its record filled. */
      document: Document;
      /** The fields filled, which were empty: none if the service had nothing new. */
      filled: ReferenceField[];
      /** Where the record came from. */
      service: ExternalService;
    }
  | {
      outcome: "failed";
      reason: ReferenceLookupFailureReason;
      /** Technical detail in English, for logs and tooltips. */
      message: string;
    };

// ---------------------------------------------------------------------------
// Find sources (#296, ADR-0018)

/**
 * A Source provider (CONTEXT.md): a public service Find sources searches for
 * works to add, as Documents when their full text is open, else as reference
 * records. OpenAlex, arXiv and PubMed search; Crossref looks a DOI up;
 * openFDA, DailyMed and ClinicalTrials.gov find drug labels and trials; the
 * eCFR searches US federal regulations, and GovInfo looks up the US Code and
 * the CFR's official edition by citation.
 */
export interface SourceProviderInfo {
  /**
   * "openalex", "arxiv", "pubmed", "crossref", "openfda", "dailymed",
   * "clinicaltrials", "ecfr", "govinfo". The UI says what each covers and what
   * its records are licensed under (`sources.provider.<id>.about`).
   */
  id: string;
  /** As its operator names it. */
  name: string;
  /** Where searches go: consent is asked per service, once ("find-sources" flow). */
  service: ExternalService;
  /** It searches by words; false for one that only looks a work up by its identifier (Crossref, by DOI). */
  searches: boolean;
  /** The User's decision on sending it searches. */
  consent: DataFlowStatus["consent"];
  /** Where its operator states its terms and limits. */
  termsUrl: string;
  /** Searched when a search names no providers: false for drug labels and trials, which are asked only when chosen. */
  searchedByDefault: boolean;
  /** An optional key of the User's: "none" for a provider that takes none, else whether one is set. The key itself is never given out. */
  key: "none" | "unset" | "set";
  /** It works only with that key (GovInfo): without one it is off, and `keySignUp` is where to get one. */
  keyNeeded: boolean;
  keySignUp: string | null;
}

/**
 * What an Answer's search can ask for besides papers (`find_sources`' `kind`),
 * and the providers each is looked up in. Drug labels, trials and US law
 * aren't searched with a search for papers.
 */
export const SOURCE_KIND_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  drug_labels: ["openfda", "dailymed"],
  clinical_trials: ["clinicaltrials"],
  us_law: ["ecfr", "govinfo"],
};

/** What Find sources looks for. */
export interface FindSourcesInput {
  /**
   * Words, a title, or an identifier: a DOI, an arXiv ID, a PubMed ID, a
   * label's set id, an NCT number, or a citation ("17 CFR 240.10b-5", "42
   * U.S.C. § 1983").
   */
  query: string;
  /** Only works published in or after this year. */
  fromYear?: number | null;
  /** Only works published in or before this year. */
  toYear?: number | null;
  /** Only works whose full text is open. */
  openAccessOnly?: boolean;
  /** The providers to ask, by id; every one that searches by default (not drug labels or trials), when left out. */
  providers?: string[];
}

/**
 * Why a provider gave no results:
 * - "declined": the User didn't allow sending it searches;
 * - "unreachable": it couldn't be reached, or took too long;
 * - "rate-limited": it asked IncarnaMind to slow down (429), or its free daily allowance is used up;
 * - "service-error": it answered with an error, or with something unreadable;
 * - "needs-key": it works only with the User's own key, and none is set: nothing was sent;
 * - "key-rejected": it didn't accept the User's key.
 */
export type SourceFailureReason =
  | "declined"
  | "unreachable"
  | "rate-limited"
  | "service-error"
  | "needs-key"
  | "key-rejected";

/** How one provider's part of a search went. */
export interface SourceProviderOutcome {
  id: string;
  name: string;
  /** How many works it gave, before they were merged with the others'. */
  count: number;
  /** Null when it answered. */
  failure: { reason: SourceFailureReason; message: string } | null;
}

/** The versions an open full text can be, as repositories label them. */
export type SourceVersion = "published" | "accepted" | "submitted";

/** The licence an open text is under, and whether it allows commercial use. */
export interface SourceLicence {
  /** As the provider writes it, in lower case: "cc-by", "cc-by-nc-nd", "public-domain". */
  id: string;
  /** "CC BY", "CC BY-NC-ND", "CC0"; the id for any other, which the UI names. */
  label: string;
  /** False for a licence that rules out commercial use (an NC licence); null when unknown. */
  commercial: boolean | null;
}

/**
 * How a found work's full text can be had: "open", downloaded and processed
 * into a Document when added (a PDF, text the provider gives by section, or a
 * "web-page" at its publisher's, saved as `saveWebPage` saves one); or
 * "closed" when no open copy is known, so adding keeps its reference record
 * only. Nothing is ever downloaded from behind a paywall.
 */
export type SourceAccess =
  | {
      kind: "open";
      format: "pdf" | "text" | "web-page";
      /** Which version the open copy is: a preprint can differ from what was published. */
      version: SourceVersion | null;
      licence: SourceLicence | null;
    }
  | { kind: "closed" };

/** A work Find sources found: a paper now; later a law, a filing or a label. */
export interface FoundSource {
  /**
   * Its identity across providers, for `addFoundSource`: "doi:10.1038/…", else
   * "arxiv:1706.03762", "pmid:36970624" or "openalex:W4362665266".
   */
  key: string;
  /** Its reference record, as the providers give it. */
  fields: ReferenceFields;
  /** The providers that found it, best first. */
  foundBy: { id: string; name: string }[];
  /** How many works cite it, when a provider counts them. */
  citedBy: number | null;
  /**
   * The date of the version described, ISO 8601 at the precision known: what
   * a Document added from it holds, as laws and preprints change.
   */
  versionDate: string | null;
  access: SourceAccess;
  /** Its page at its publisher or registry, for "Get the PDF…" in the User's browser. */
  landingUrl: string | null;
  /** What the source says about relying on it, when it says (openFDA's disclaimer); shown with the result. */
  notice: string | null;
  /** Its text is an unofficial compilation (the eCFR), not the official edition: the result says so. */
  unofficial: boolean;
  /** Already in the Library: as a Document, or as a reference record without one. */
  inLibrary: { documentId: string | null; recordId: string } | null;
}

export type FindSourcesResult =
  | {
      outcome: "found";
      /** Best first: found by more providers, and higher in each, ranks higher. */
      works: FoundSource[];
      /** Each provider asked, in the order asked. */
      providers: SourceProviderOutcome[];
    }
  /** "Keep everything on this computer" is on: nothing was sent. */
  | { outcome: "local-mode" };

export interface AddFoundSourceInput {
  /** `FoundSource.key`, from a search this session. */
  key: string;
  /** The Folder to add it to; Not in a Folder when null or left out. */
  folderId?: string | null;
}

/** What adding a found work came to. */
export type AddFoundSourceResult =
  | {
      outcome: "document";
      /** The Document, being processed; or the one added before (`existing`). */
      document: Document;
      existing: boolean;
    }
  | {
      outcome: "reference";
      /** The reference record kept, with no Document. */
      recordId: string;
      /** Why no Document: "closed", no open full text; "download-failed", no open copy could be had. */
      reason: "closed" | "download-failed";
      /** For the User's browser: the open copy that couldn't be had, else the work's page at its publisher. */
      landingUrl: string | null;
      existing: boolean;
    }
  | {
      outcome: "failed";
      /**
       * "local-mode": nothing may be sent; "declined": the provider isn't allowed; "not-found": search
       * again; "rate-limited": the provider asked to slow down, try later; "needs-key" and
       * "key-rejected": the provider works only with the User's own key, and none is set or it was refused.
       */
      reason:
        | "local-mode"
        | "declined"
        | "not-found"
        | "rate-limited"
        | "needs-key"
        | "key-rejected";
      /** Technical detail in English, for logs and tooltips. */
      message: string;
    };

/** An entry of a reference export that couldn't be imported. The rest of the file still is. */
export interface ReferenceImportProblem {
  /** The entry's cite key or id, else its place in the file ("line 12", "item 3"). */
  label: string;
  /** "broken": it is cut off or not valid. "no-title": it has no title. "not-a-reference": it isn't an item. */
  reason: "broken" | "no-title" | "not-a-reference";
}

/** One reference of an export, and what the import did with it. */
export interface ReferenceImportEntry {
  /** Its reference record. */
  recordId: string;
  title: string;
  /** The Document it was matched to, or null: kept as a record with no Document yet. */
  documentId: string | null;
  /** How it was matched: its DOI, its arXiv id, or its title with the year and first author. */
  matchedBy: "doi" | "arxiv" | "title" | null;
  /** "added": a new record. "updated": an existing one gained or changed fields. "unchanged": it had all of this already. */
  change: "added" | "updated" | "unchanged";
}

/** What `importReferences` came to. */
export type ReferenceImportResult =
  | {
      outcome: "imported";
      /** For `undoReferenceImport` and `addImportedReferenceFiles`. */
      importId: string;
      format: "csl-json" | "bibtex" | "ris";
      /** References read, with duplicates in the file merged into one. */
      total: number;
      /** Matched to a Document. */
      matched: number;
      /** Kept as records with no Document yet. */
      unmatched: number;
      /** Records made or changed; the rest were already as the file has them. */
      changed: number;
      /** Duplicates in the file that were merged into another reference. */
      merged: number;
      problems: ReferenceImportProblem[];
      entries: ReferenceImportEntry[];
      /** Files the export attaches to unmatched references that exist on this computer and can be added as Documents. */
      files: number;
    }
  | {
      outcome: "failed";
      /**
       * "unreadable": the file can't be read. "too-large": over 50 MB.
       * "unknown-format": it isn't CSL JSON, BibTeX or RIS. "empty": it holds no references.
       */
      reason: "unreadable" | "too-large" | "unknown-format" | "empty";
      /** Technical detail in English, for logs and tooltips. */
      message: string;
    };

/** Where a Document Find sources added came from: what its text is, and when it was fetched. */
export interface DocumentFoundSource {
  /** The provider whose open copy it is. */
  provider: { id: string; name: string };
  /** The address its text was fetched from. */
  address: string;
  licence: SourceLicence | null;
  version: SourceVersion | null;
  /** The date of the version its text is, ISO 8601 at the precision known. */
  versionDate: string | null;
  /** When it was fetched. ISO 8601, UTC. */
  fetchedAt: string;
}

/** What `addImportedReferenceFiles` added. */
export interface ReferenceFilesResult {
  /** The Documents added or found, each with its reference record. */
  documents: Document[];
  /** Files that couldn't be added. */
  skipped: SkippedFile[];
}

export interface ListDocumentsOptions {
  /** Only Documents in this Folder. Omitted: every Document, in a Folder or not. */
  folderId?: string;
  /** With `folderId`, also Documents in its sub-Folders, at any depth. Defaults to false. */
  includeSubfolders?: boolean;
  /** Only Documents that carry this Tag. Combines with `folderId`: both must match. */
  tagId?: string;
  /**
   * Only the Documents of this Linked folder, or, with null, only the files
   * added on their own (the sidebar's "Other Documents"). Omitted: all.
   */
  linkedFolderId?: string | null;
}

/** The text IncarnaMind kept of a Document's current version, Unit by Unit. */
export interface DocumentText {
  documentId: string;
  /** The version the text is of. */
  contentHash: string;
  fileStatus: DocumentFileStatus;
  /**
   * Its Units (pages, slides, sections, blocks of rows or lines) in order,
   * `page` being the Unit's number, from 1. Empty if no text is indexed.
   */
  pages: { page: number; text: string; kind: UnitKind; label: UnitLabel | null }[];
}

/**
 * The text kept of one version of a Document, and when it was made: the
 * version a Citation was made from, which the viewer shows after the
 * Document changed (#2159).
 */
export interface DocumentVersionText {
  documentId: string;
  contentHash: string;
  /**
   * When that version was made: a saved page's fetch of it, else its file's
   * last change, in ISO 8601 UTC. The view of it says "As cited, {date}".
   */
  versionAt: string;
  /** Its Units, `page` from 1, as `DocumentText.pages`. */
  pages: DocumentText["pages"];
}

/** A version of a Document to read the kept text of (see `CoreApi.readVersionText`). */
export interface ReadVersionTextInput {
  documentId: string;
  /** The version cited: the SHA-256 of its file, as a Citation stores it. */
  contentHash: string;
  /**
   * The cited Units, from 1; both null for every Unit kept (a whole TXT or
   * Markdown file cited before Units).
   */
  pageFrom: number | null;
  pageTo: number | null;
}

/** A Citation's place, as its saved page is found (#133): where it stood in the version it quotes. */
export interface ReadCitedPageInput {
  documentId: string;
  /** The version cited: the SHA-256 of its file, as a Citation stores it. */
  contentHash: string;
  /** The cited Units, from 1; null for a Citation made before Units. */
  pageFrom: number | null;
  /** The last cited Unit; null for the same Unit as `pageFrom`. */
  pageTo: number | null;
  /** Where in its Document it points, which says what the page shows; null for a Citation made before Locations. */
  location: CitationLocation | null;
}

/**
 * The scanned pages of a Document's current version (#397): the text read
 * from each page's picture, and where each of its lines is on the page
 * (`Anchor.quad`), so the viewer can lay the text over the picture and wash
 * a quote there.
 */
export interface ScannedText {
  documentId: string;
  contentHash: string;
  pages: { page: number; text: string; label: UnitLabel | null; anchors: Anchor[] }[];
}

/**
 * Where a Citation's quote was read from a scan (#397), for its card: the
 * words the text recognition wasn't sure of within it, as the page's text has
 * them, in order (empty when it was sure of every one).
 */
export interface ScannedQuote {
  unsure: string[];
  from: "scan" | "picture";
}

/** A Citation's quote, as `readScannedQuote` looks it up: its Document, version, Units and quote. */
export interface ScannedQuoteInput {
  documentId: string;
  /** The version it quotes; null for a Citation that doesn't say (the current one is read). */
  contentHash: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  quote: string;
}

/**
 * A label with a short description that Documents can carry. IncarnaMind
 * applies Tags automatically, choosing them by their names and descriptions,
 * and the User can add or remove them.
 */
export interface Tag {
  /** A random UUID generated on this device. */
  id: string;
  /** Never empty; unique among Tags, ignoring case. */
  name: string;
  /** What the Tag means, for the User and for automatic tagging. May be empty. */
  description: string;
  /** Created on first run as one of the preset Tags, rather than by the User. Editing one keeps it a preset. */
  preset: boolean;
  /** Its colour, from a small fixed palette (src/shared/tagColours.ts); the User can change it. */
  colour: TagColour;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

export interface CreateTagInput {
  /** Trimmed; must not be empty, nor another Tag's name (ignoring case). */
  name: string;
  /** Trimmed. Defaults to empty. */
  description?: string;
  /** Defaults to the colour fewest Tags have. */
  colour?: TagColour;
}

/** The fields to change; the others are kept. */
export interface UpdateTagInput {
  name?: string;
  description?: string;
  colour?: TagColour;
}

/**
 * A folder inside a Linked folder, as it is on disk (CONTEXT.md), or the
 * Linked folder itself. Folders follow the disk: the User doesn't create,
 * rename or move them in IncarnaMind.
 */
export interface Folder {
  /**
   * Derived from its Linked folder and `relativePath`, so the same folder has
   * the same id at every scan. A folder renamed on disk is a new Folder.
   */
  id: string;
  /** The folder's name on disk. */
  name: string;
  /** The Folder this one is in, or null for a Linked folder's own Folder. */
  parentId: string | null;
  linkedFolderId: string;
  /** Relative to the Linked folder, "/" between names: "" for the Linked folder itself. */
  relativePath: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

/**
 * How the sidebar shows a Linked folder: "tree", with its folders as
 * Folders, or "flat", every Document in one list. Flat suits folders such as
 * Zotero's storage, where nearly every folder holds one file.
 */
export type LinkedFolderLayout = "tree" | "flat";

/**
 * - "scanning": being compared with the index, or indexed for the first time.
 * - "watching": up to date, and watched for changes while the app runs.
 * - "paused": the User paused it: nothing in it is read or processed until resumed.
 * - "unavailable": the folder can't be reached (an unplugged drive, an
 *   unmounted share). Its Documents stay searchable; it is checked again later.
 */
export type LinkedFolderStatus = "scanning" | "watching" | "paused" | "unavailable";

/**
 * The groups that have an example Mind (onboarding, see src/core/examples.ts):
 * "credit", a credit committee paper, is the first-run default (#802); the
 * others are closer to a kind of work (papers, reports, contracts, meetings),
 * and open from the default's banner.
 */
export const EXAMPLE_GROUPS = ["credit", "papers", "reports", "contracts", "meetings"] as const;
export type ExampleGroup = (typeof EXAMPLE_GROUPS)[number];

/**
 * An example Mind (onboarding, see src/core/examples.ts): "Draft: credit
 * committee paper", or one of a group, with its example Documents in their own
 * Linked folder, written in advance so it works before any chat model is set up.
 */
export interface Examples {
  /**
   * Which example this is. "tea": "Where tea comes from", which a first run of
   * an earlier version made; it is shown as the example, and removed, while
   * there is no credit paper, but no longer made (#802).
   */
  group: ExampleGroup | "tea";
  /** Whether this copy of IncarnaMind ships the examples. */
  available: boolean;
  /** The example Mind, while it exists. */
  mindId: string | null;
  /** The Linked folder of the example Documents, while it exists. */
  linkedFolderId: string | null;
  /** The example Answer, written in advance, while the example Mind exists. */
  answerId: string | null;
  more: ExampleGroup[];
}

/**
 * The first open's ready Question: the one its card offers to ask in one click. One reader
 * decides it (`readyQuestion`), for every place that shows it.
 */
export interface ReadyQuestion {
  /** What to ask, in the interface's language. */
  question: string;
  /**
   * What its Answer reads, as the Question's Search scope: the User's own Document it is about,
   * asked with a model. Null for the example's, whose Answer is written in advance.
   */
  scope: SearchScope | null;
  /**
   * The Document still being read before the Answer can be written, named; null when asking it
   * answers now. Asking waits for it, saying so, rather than doing nothing (#2218).
   */
  waitingFor: string | null;
}

/**
 * What asking the example's ready Question did: the conversation its Question and Answer are in.
 * `stopped`: Stop came while it waited for the example's Documents to be read, so its Answer says
 * "Stopped" and has no text.
 */
export interface ExampleReadyAsked {
  conversationId: string;
  answerId: string;
  stopped: boolean;
}

/**
 * A folder on the User's computer that IncarnaMind keeps in sync, read only:
 * every supported file in it, at any depth, is a Document indexed where it
 * is. Hidden files and folders, .git and node_modules are left out, and cloud
 * placeholders (online-only files) aren't read unless the User asks.
 */
export interface LinkedFolder {
  /** A random UUID generated on this device: the same wherever the folder is (ADR-0020). */
  id: string;
  /** Where it is on this computer: absolute, symbolic links resolved. `locateLinkedFolder` changes it. */
  path: string;
  /** Its own Folder, the root of its Folders. */
  folderId: string;
  status: LinkedFolderStatus;
  layout: LinkedFolderLayout;
  progress: {
    /** Supported files in it that are or will be Documents (missing ones and online-only files not counted). */
    files: number;
    /** Of those, the ones processed to the end: ready, with no text, or failed. */
    indexed: number;
  };
  /**
   * Cloud placeholders found in it (iCloud Drive, Dropbox, Google Drive or
   * OneDrive files not downloaded), which aren't indexed: reading one would
   * download it. `downloadOnlineOnlyFiles` downloads and indexes them.
   */
  onlineOnly: { files: number; bytes: number; downloading: boolean };
  /** Files in it in a format IncarnaMind doesn't read (.doc, .xls, .ppt, .wps, .caj…), found at its last look: not Documents (#740). */
  unsupportedFiles: number;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

/** A file in a Linked folder in a format IncarnaMind doesn't read: it is left out of every search (#740). */
export interface UnsupportedFile {
  /** Absolute. */
  path: string;
  /** The file's name, with its extension. */
  name: string;
  /** Lower case, with the dot: ".xls". */
  extension: string;
  linkedFolderId: string;
  /** The folder it is in, relative to its Linked folder: "" at the top. */
  relativeFolder: string;
}

/**
 * Why a file in a search's scope wasn't read, and what the User can do:
 * - "format": a format not read yet (.doc, .xls, .ppt, .wps, .caj…): convert it;
 * - "scan": a scan in which text recognition found no text (handwriting, a picture);
 * - "password": password-protected: a PDF is unlocked with its password
 *   (`unlockDocument`, #763); another kind needs its password removed;
 * - "damaged": the file is broken, or couldn't be read;
 * - "too-large": too large to open;
 * - "pages": a PDF with page content that couldn't be read;
 * - "parts": a workbook read in part, whose hidden sheets or rows past the reading limit were
 *   left out (`UnreadFile.parts` says which). The rest of it is searched.
 */
export type UnreadReason =
  | "format"
  | "scan"
  | "password"
  | "damaged"
  | "too-large"
  | "pages"
  | "parts";

/** What of a Document wasn't read when the rest was (#740). */
export interface UnreadParts {
  /** Hidden and very hidden sheets left out, by name, in the file's order. */
  hiddenSheets: string[];
  /** Sheets with rows left out at the reading limit: the first row not read, from 1. */
  rowsCut: { sheet: string; from: number }[];
  /** Sheets after the limit was reached, from which nothing was read. */
  sheetsNotRead: string[];
}

/** A file in a Search scope that couldn't be read, with why (#740). */
export interface UnreadFile {
  /** The Document's id, or the file's path for a file in a format not read. */
  id: string;
  /** The file's name, with its extension. */
  name: string;
  reason: UnreadReason;
  /** For "format": its extension, lower case with the dot. Null otherwise. */
  extension: string | null;
  /** The Document, or null for a file in a format not read. */
  documentId: string | null;
  /** For "pages": the scanned pages that couldn't be read, from 1; empty when none could be, and for every other reason. */
  pages: number[];
  /** For "pages" with unread PDF form fields, whose marker needs explaining to the model (#1818). */
  forms?: true;
  /** For "parts": what wasn't read; absent for every other reason. */
  parts?: UnreadParts;
}

/**
 * What linking a folder would take, so the User can confirm first: found
 * from the files' metadata, nothing read.
 */
export interface LinkedFolderPreview {
  /** Absolute, symbolic links resolved: the path `addLinkedFolder` would link. */
  path: string;
  /** Supported files that would be indexed now, and their total size in bytes. */
  files: number;
  bytes: number;
  /** Cloud placeholders, left out until the User asks to download them. */
  onlineOnly: { files: number; bytes: number };
  /**
   * Roughly how long reading them takes, in seconds, at the speed files of their kinds were
   * read on this computer. Null until files of each of their kinds have been read here, with
   * the embedding model in use, and when a file's size is far from the sizes read.
   */
  estimatedSeconds: number | null;
  /** The layout it would get. */
  layout: LinkedFolderLayout;
  /** The folder is inside a Linked folder already: linking it adds nothing. Its id, or null. */
  insideLinkedFolderId: string | null;
  /** Linked folders inside it, which linking it would merge into it (their Documents keep their ids). */
  containsLinkedFolderIds: string[];
}

export interface SkippedFile {
  path: string;
  /** "unsupported-type": not PDF, TXT or Markdown. "unreadable": missing, a folder, or not readable. */
  reason: "unsupported-type" | "unreadable";
}

export interface AddDocumentsResult {
  /** One per added file, in the order given. A file already added gives its existing Document. */
  documents: Document[];
  /** Files that were not added. */
  skipped: SkippedFile[];
  /** The Documents this call made new, in order. A file in the Library already is in `documents` and not here. */
  added: string[];
  /** The batch of the new Documents: "documents.batch" events report its progress. */
  batchId: string;
}

/** Where `addDocuments` and `addLinkedFolder` put the Documents they add. */
export interface AddDocumentsOptions {
  /**
   * The Folder they were dropped on: each new Document is filed there as the
   * User's choice, and Organize suggests only its Tags. Omitted: Organize
   * suggests their Folders.
   */
  groupId?: string;
}

/** A Linked folder just linked, with the batch of the Documents its first scan adds. */
export interface AddedLinkedFolder extends LinkedFolder {
  batchId: string;
}

/**
 * How `searchPassages` finds Passages (ADR-0009):
 * - "keyword": FTS5 over the words of each Passage and its Document's name,
 *   ranked by BM25. Finds nothing without a word in common.
 * - "vector": the current embedding model's vectors (see `EmbeddingSettings`),
 *   by cosine similarity. Always ranks every Passage embedded with that model,
 *   however unrelated; Passages embedded with another model are never compared.
 *   Refused while embeddings are off.
 * - "hybrid": both, each list's top 50 fused by reciprocal rank fusion
 *   (k = 60); a Passage with no vector yet counts its keyword rank for both
 *   lists. Keyword only while embeddings are off (the default), and until the
 *   embedding model is ready.
 */
export type SearchMode = "hybrid" | "keyword" | "vector";

export interface SearchPassagesOptions {
  /** Defaults to "hybrid". */
  mode?: SearchMode;
  /** The most results to return, from 1 to 200. Defaults to 20. */
  limit?: number;
  /** Only Passages of these Documents (a Search scope). Omitted: every Document. */
  documentIds?: string[];
}

export interface PassageSearchResult {
  passageId: string;
  documentId: string;
  documentName: string;
  /**
   * The first Unit the Passage covers, from 1: a PDF's page, a deck's slide,
   * otherwise a Unit's number (see src/shared/units.ts). Null only for
   * Passages built before Units, of a TXT or Markdown file.
   */
  pageFrom: number | null;
  /** The last Unit the Passage covers. A Passage can cross from one Unit to the next. */
  pageTo: number | null;
  /** The Passage's position in its Document, from 0. */
  position: number;
  text: string;
}

// ---------------------------------------------------------------------------
// The built-in embedding model (ADR-0009)

/**
 * The built-in embedding model, which Document search uses on this computer.
 * Its files are downloaded once into the data folder (about 135 MB). The
 * download sends nothing of the User's, so it needs no consent.
 * - "not-downloaded": nothing has asked for it yet.
 * - "downloading": see the byte counts.
 * - "ready": downloaded and checked. Embedding works offline from here on.
 * - "failed": see `error`; `downloadEmbeddingModel` tries again.
 */
export type EmbeddingModelState = "not-downloaded" | "downloading" | "ready" | "failed";

export interface EmbeddingModelError {
  /**
   * "network": the download stopped, e.g. offline; a retry resumes it.
   * "integrity": a downloaded file didn't match its recorded size and SHA-256, so it was thrown away.
   * "storage": the files couldn't be written to the data folder, e.g. the disk is full.
   * "load": the files are there, but the model couldn't start on this computer.
   */
  kind: "network" | "integrity" | "storage" | "load";
  /** Technical detail in English, for logs and tooltips. */
  message: string;
  /** A download every source failed (#1578): what each one said, in the order tried. */
  sources?: { source: ModelSourceId; message: string }[];
}

/**
 * Where the built-in models download from (#1578): Hugging Face, IncarnaMind's copy on
 * ModelScope, hf-mirror.com, IncarnaMind's copy on Cloudflare R2.
 */
export type ModelSourceId = "huggingface" | "modelscope" | "hf-mirror" | "r2";

/** The source the User picked on a failed download's line; "auto" tries them all in the probe's order. */
export type ModelSourceChoice = "auto" | "huggingface" | "modelscope";
export const MODEL_SOURCE_CHOICES: readonly ModelSourceChoice[] = [
  "auto",
  "huggingface",
  "modelscope",
];

export interface EmbeddingModelStatus {
  /** The model's name, e.g. "multilingual-e5-small". */
  name: string;
  /** Where the files are downloaded from, e.g. "huggingface.co": traffic that carries no User content. */
  host: string;
  state: EmbeddingModelState;
  /** Bytes downloaded and checked so far. */
  downloadedBytes: number;
  totalBytes: number;
  /** Set when `state` is "failed". */
  error: EmbeddingModelError | null;
}

// ---------------------------------------------------------------------------
// Embedding providers (ADR-0005)

/**
 * Where Passages and search queries are embedded. "off", the default: nothing
 * is embedded, and search finds Passages by their words, reranked (ADR-0009,
 * 2026-10-10). "built-in" is the model above, on this computer. The others
 * trade privacy for quality: a cloud provider receives the text of every
 * Document, and every search query. "ollama" is Ollama's embeddings, normally
 * on this computer too. An install from before embeddings could be off keeps
 * them on only if the User had chosen a provider other than the built-in model.
 */
export const embeddingProviderKinds = [
  "off",
  "built-in",
  "openai",
  "google",
  "openai-compatible",
  "ollama",
] as const;

export type EmbeddingProviderKind = (typeof embeddingProviderKinds)[number];

/**
 * Prefilled when a provider is picked; any embedding model the account has
 * can be typed instead. Ollama's is multilingual (bge-m3, the best model in
 * ADR-0009's comparison); it must be pulled first.
 */
export const SUGGESTED_EMBEDDING_MODELS: Readonly<
  Record<Exclude<EmbeddingProviderKind, "off" | "built-in">, string>
> = {
  openai: "text-embedding-3-small",
  google: "gemini-embedding-001",
  "openai-compatible": "",
  ollama: "bge-m3",
};

/** The embedding model search uses on this device, or "off". */
export interface EmbeddingProvider {
  kind: EmbeddingProviderKind;
  /** The server's URL for "openai-compatible" and "ollama"; null for the others. */
  baseUrl: string | null;
  /** The model, e.g. "text-embedding-3-small"; for "built-in", the built-in model's name; empty for "off". */
  modelId: string;
  /** Whether an API key is stored for it. Keys live in the keychain, never in the database. */
  hasApiKey: boolean;
  /** How many numbers the model's vectors have: known once it has made one (384 for the built-in model). */
  dimensions: number | null;
  /** Where Document text and search queries go, or null when they stay on this computer. */
  service: ExternalService | null;
}

export interface SaveEmbeddingProviderInput {
  kind: EmbeddingProviderKind;
  /** Required for "openai-compatible"; optional for "ollama" (Ollama's local port); not allowed otherwise. */
  baseUrl?: string;
  /** A new API key. Leave it out to keep the one stored for the same provider and server. */
  apiKey?: string;
  /** The embedding model. Required, except for "off" and "built-in", which take none. */
  modelId?: string;
}

/** Settings to test, which need not be saved. Without a key, the one stored for the same provider and server. */
export type TestEmbeddingConnectionInput = SaveEmbeddingProviderInput;

export type EmbeddingConnectionTestResult =
  /** The model made a vector of this many numbers. */
  { ok: true; dimensions: number } | { ok: false; error: ProviderError };

/**
 * Documents being embedded after embeddings were turned on, or again after
 * the embedding model changed. Each one goes through the usual statuses
 * ("embedding", then "ready"); until it is done, keyword search still finds
 * its Passages, but vector search doesn't: vectors from different models are
 * never compared. Turning embeddings off ends it: nothing is embedded.
 */
export interface EmbeddingRebuild {
  /**
   * "provider-changed": the User turned embeddings on, or chose another embedding model.
   * "local-mode": local mode switched a cloud provider back to the built-in model.
   */
  reason: "provider-changed" | "local-mode";
  /** Documents with Passages to search. */
  total: number;
  /** Of those, the ones whose Passages are all embedded with the current model. */
  done: number;
}

/** Document search's embedding model on this device, and local mode. */
export interface EmbeddingSettings {
  provider: EmbeddingProvider;
  /**
   * "Keep everything on this computer": only embedding providers on this
   * computer can be chosen, and search results aren't reranked by a cloud
   * service. Turned on in Settings, or by choosing local models with one
   * click (`selectOllama`, when the User asks for it).
   */
  localOnly: boolean;
  /** Set while Documents are embedded again after a switch. */
  rebuild: EmbeddingRebuild | null;
  /**
   * Why the provider can't embed right now, e.g. its key was refused or the
   * User declined sending it data; null when it can. Documents wait
   * ("waiting-for-model") until `retryEmbedding`, and search finds Passages by
   * their words meanwhile. The built-in model reports its download in
   * `getEmbeddingModel` instead.
   */
  error: ProviderError | null;
}

// ---------------------------------------------------------------------------
// Rerank (ADR-0005)

/**
 * Where document search reranks its best matches. "built-in", the default, is
 * a small multilingual reranking model on this computer: nothing is sent, it
 * needs no key, and local mode doesn't pause it; its files are downloaded
 * once, when the first Documents are ready to search. The others are
 * reranking services, used with a key.
 */
export const rerankProviderKinds = ["built-in", "cohere", "voyage"] as const;

export type RerankProviderKind = (typeof rerankProviderKinds)[number];

/** The reranking services: the search query and the Passages it found are sent to them. */
export type RerankServiceKind = Exclude<RerankProviderKind, "built-in">;

/** The model each service reranks with unless the User names another: both are multilingual. */
export const DEFAULT_RERANK_MODELS: Readonly<Record<RerankServiceKind, string>> = {
  cohere: "rerank-v3.5",
  voyage: "rerank-2.5",
};

/**
 * The built-in reranking model's files, downloaded once into the data folder:
 * the same states as the built-in embedding model's.
 */
export type RerankingModelStatus = EmbeddingModelStatus;

/**
 * Rerank on this device. On by default, with the built-in model: the User can
 * choose a service instead, or turn it off, and search is then as it was.
 */
export interface RerankSettings {
  /** Reranking is on, built in or with a key: document search reranks its candidates. False: the User turned it off. */
  enabled: boolean;
  /** The User hasn't chosen on this device: reranking is on with the built-in model, the default. */
  byDefault: boolean;
  kind: RerankProviderKind | null;
  /** The model, e.g. "rerank-v3.5" or the built-in model's name; null when rerank isn't set up. */
  modelId: string | null;
  /** Whether a service's key can be read on this device. Keys live in the keychain, never in the database. Always false for "built-in". */
  hasApiKey: boolean;
  /** Where the Question and candidate Passages go, while a service is set up; null for "built-in". */
  service: ExternalService | null;
  /** Local mode is on and a service is set up: nothing is reranked, though the settings are kept. */
  paused: boolean;
  /**
   * The built-in model (its name and download size), whichever is chosen, and
   * its download. While "built-in" is chosen and it isn't "ready", search
   * keeps its own order.
   */
  model: RerankingModelStatus;
  /**
   * Where the built-in model runs on this computer: on the GPU, or on the CPU
   * where no GPU can run it. Null until it has run since IncarnaMind started.
   */
  runsOn: "gpu" | "cpu" | null;
}

export interface SaveRerankSettingsInput {
  kind: RerankProviderKind;
  /** A new key, for a service. Leave it out to keep the stored one (for the same kind); the first save needs one. */
  apiKey?: string;
  /** Null or empty: the service's default model (`DEFAULT_RERANK_MODELS`). Left out: unchanged. Not for "built-in". */
  modelId?: string | null;
}

/** Settings to test, which need not be saved; those left out are the saved ones. Services only. */
export interface TestRerankConnectionInput {
  kind?: RerankServiceKind;
  apiKey?: string;
  modelId?: string | null;
}

// ---------------------------------------------------------------------------
// Chat providers (ADR-0005)

/**
 * Where Answers can come from. "ollama" is an OpenAI-compatible server run by
 * Ollama, normally on this computer; it also offers one-click model downloads.
 * "chatgpt" is the User's ChatGPT plan, used through Sign in with ChatGPT
 * instead of an API key (see `ChatGptPlanStatus`); "claude-account" the
 * User's Claude plan, signed in with their Claude account (see `ClaudeAccountStatus`);
 * "copilot" the User's GitHub Copilot plan, signed in with GitHub (see `CopilotStatus`).
 */
export const chatProviderKinds = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "qwen",
  "kimi",
  "glm",
  "siliconflow",
  "mistral",
  "xai",
  "openrouter",
  "openai-compatible",
  "ollama",
  "chatgpt",
  "claude-account",
  "copilot",
] as const;

export type ChatProviderKind = (typeof chatProviderKinds)[number];

/** A service outside this computer that IncarnaMind can send data to. */
export interface ExternalService {
  /** The API's origin, e.g. "https://api.openai.com". Consent is recorded per service. */
  id: string;
  /** What the User sees, e.g. "OpenAI" or "api.deepseek.com". */
  name: string;
  /** The catalog entry for this service when another API shares the provider, such as reranking. */
  catalogId?: string;
}

export interface ChatProvider {
  /** A random UUID generated on this device. */
  id: string;
  kind: ChatProviderKind;
  /**
   * The provider in the catalog of providers and models (`src/core/providers/catalog`);
   * null for one it doesn't have, the ChatGPT plan.
   */
  catalogId: string | null;
  /** A hosted provider's endpoint, by its id in the catalog (e.g. "global"); null for a server's. */
  endpoint: string | null;
  /** The server's URL for "openai-compatible" and "ollama"; null for the others. */
  baseUrl: string | null;
  /** Whether an API key is stored for it. Keys live in the keychain, never in the database. */
  hasApiKey: boolean;
  /** Where Questions go, or null when the server runs on this computer and nothing leaves it. */
  service: ExternalService | null;
}

export interface SaveChatProviderInput {
  kind: ChatProviderKind;
  /**
   * A preset of the "openai-compatible" kind, by its catalog id, e.g. "groq":
   * its endpoint and name come from the catalog. Left out: the kind's own.
   */
  catalogId?: string;
  /**
   * A hosted provider's endpoint (its region), by its id in the catalog, e.g.
   * "intl" for Qwen. Left out: its first. Each endpoint is its own provider
   * with its own key, as keys and model lists differ by region.
   */
  endpoint?: string;
  /** Required for "openai-compatible"; optional for "ollama" (Ollama's local port); not allowed otherwise. */
  baseUrl?: string;
  /**
   * The value an endpoint's address is built from, for an endpoint that needs
   * one (an AWS region, a Cloudflare account). Each value is its own provider.
   */
  endpointValue?: string;
  /** A new API key. Leave it out to keep the stored one; null removes it. */
  apiKey?: string | null;
  /** The model to make the default, e.g. "gpt-5.4-mini". */
  modelId: string;
  /** The default model stays as it is when there is one; `modelId` becomes it only when there is none. */
  keepDefault?: boolean;
}

export interface TestChatConnectionInput {
  kind: ChatProviderKind;
  catalogId?: string;
  /** The endpoint to test (see `SaveChatProviderInput`). */
  endpoint?: string;
  baseUrl?: string;
  endpointValue?: string;
  /** The key to test. Leave it out to test the key stored for the same provider. */
  apiKey?: string;
  modelId: string;
}

/** Why a request to a model provider failed, so the UI can say what to fix. */
export type ProviderErrorKind =
  | "auth"
  | "model"
  | "rate-limit"
  | "network"
  | "provider"
  /**
   * The provider refused the request as it was sent (an HTTP 4xx other than a refused key, an
   * unknown model, a timeout or a rate limit): sent again, it would be refused again.
   */
  | "refused"
  /** The provider says the account is out of credit (or its billing is stuck): only adding credit, or another model, helps. */
  | "out-of-credit"
  /** The provider doesn't serve the country or region the request came from, whatever the key. */
  | "region"
  | "consent-declined"
  /** The User turned off the flow to the model's service while the work was under way: nothing more was sent. */
  | "consent-revoked"
  /** "Keep everything on this computer" is on and the model isn't on this computer: nothing was sent, or the Answer was stopped. */
  | "local-mode"
  /** The model is in Ollama on this computer, and Ollama isn't running: found before anything was sent. */
  | "ollama-not-running"
  /** Anthropic: a model that requires 30-day data retention (Fable 5.1), asked by an organization or workspace that has it off. */
  | "data-retention"
  /** ChatGPT plan: there is no sign-in on this device, or it expired: sign in again. */
  | "not-signed-in"
  /** ChatGPT plan: the plan's usage limit, or the one the User set for IncarnaMind, is reached. */
  | "plan-limit"
  /**
   * ChatGPT plan: OpenAI refused a valid sign-in, e.g. the plan isn't one that
   * can be used in other apps, or the request came from a region it doesn't serve.
   */
  | "blocked"
  /**
   * A local model: the request doesn't fit its context window, even with the
   * oldest Question context left out. Nothing is cut silently.
   */
  | "too-long"
  /** The request could pass the User's monthly cap (`UserSettings.monthlyCap`): nothing was sent. */
  | "cost-cap"
  /** The model's reply ended with no text, or none that could be read. */
  | "no-answer"
  /** The model's reply reached its call's output limit and was cut off (#2275). */
  | "cut-short"
  | "unknown";

export interface ProviderError {
  kind: ProviderErrorKind;
  /** The provider's own message, for details. */
  message: string;
  /** The provider's HTTP status, when it gave one, for the log. */
  status?: number;
  /** The message as a key of the dictionary, when the core worded it, to say in the interface language. */
  wording?: ErrorWording;
  /**
   * "plan-limit": when the plan's limit resets (ISO 8601), when the provider says.
   * "rate-limit" on a Document waiting to be tagged: when Tagging resumes.
   */
  resetsAt?: string;
  /** A sign-in route's request (a Claude account, Copilot): which of its problems it is, for its own line. */
  signInRoute?: SignInRouteProblem;
  /**
   * "cost-cap" from a Run's own budget rather than the monthly cap (#1554): that budget, and what
   * the Run had spent when it stopped.
   */
  budget?: { most: Money; spent: Money };
}

/**
 * How a model's requests are paid for (src/core/providers/catalog/billing.ts):
 * per token on an API key, from a plan's own limits (the ChatGPT plan), or
 * not at all (a model on this computer).
 */
export type Billing = "per-token" | "plan" | "free";

export type Currency = "USD" | "CNY";

export interface Money {
  currency: Currency;
  amount: number;
}

export const MAX_MONTHLY_CAP = 1_000_000;

/**
 * The most IncarnaMind may spend in a calendar month on models billed per
 * token. Before each such request its most (its prompt and its output limit)
 * is reserved, and a request whose reservation would pass the cap isn't sent.
 * What is spent and what is still reserved both count against it. Spending
 * in the other currency counts at a fixed rate.
 */
export interface MonthlyCap {
  amount: number;
  currency: Currency;
}

/** One saved provider's use this month. */
export interface ProviderCost {
  providerId: string;
  billing: Billing;
  requests: number;
  /** What its settled requests cost, in each currency they were priced in. */
  spent: Money[];
  /** Reserved for its open requests, per currency. */
  setAside: Money[];
  /** Tokens of requests to models with no known price: counted here, not toward the cap. */
  unpricedTokens: number;
  /** Requests a quit cut short with no usage known: counted as costing nothing (#636). */
  interrupted: number;
}

/** Settings' month-to-date cost: recorded on this computer, never sent. */
export interface CostSummary {
  /** When the counted month began (ISO 8601), in the computer's time zone. */
  monthStart: string;
  /** What per-token requests cost this month once settled, per currency. */
  spent: Money[];
  /** Reserved for open requests, per currency. */
  setAside: Money[];
  /** `spent` in the cap's currency (the other at a fixed rate), when a cap is set. */
  spentTowardCap: Money | null;
  /** `setAside` in the cap's currency; it counts against the cap too. */
  setAsideTowardCap: Money | null;
  cap: MonthlyCap | null;
  /** The providers used this month. */
  providers: ProviderCost[];
}

/**
 * Why a Run stopped before its work was done, so that a Task can resume from
 * it later: the monthly cap, or a plan's limit (with when it resets, when the
 * provider says). Its unfinished items say "not checked" with the reason.
 */
export type RunStop = { reason: "cost-cap" } | { reason: "plan-limit"; resetsAt: string | null };

/**
 * Why a full watch of a Mind ended before it finished: a stop a Run gives way
 * to, or the User stopping it. A cancelled watch is never a complete one: the
 * next Check sweeps every cited sentence again (#1941).
 */
export type WatchStop = RunStop | { reason: "cancelled" };

/** What Compare Documents makes a comparison table of (#98). */
export interface CompareDocumentsInput {
  mindId: string;
  /** The rows, in order: Documents IncarnaMind wrote that checks leave out are dropped (#80). */
  documentIds: string[];
  /** The columns, in order. */
  questions: string[];
  /** What else the table should show, for every cell. */
  instruction?: string | null;
  /** The model its cells are written with; the default model when left out. */
  model?: ChatModelChoice | null;
  /**
   * The Block it goes after (the one the cursor is in), or before, when that
   * Block is an empty paragraph, which stays to write on. None: the Mind's end.
   */
  afterBlockId?: string | null;
}

/** A comparison table, by its Mind and its Block's id. */
export interface ComparisonTableRef {
  mindId: string;
  tableId: string;
}

/** What to stop of a table's fill: all of it, or one refill pass alone, as its Undo asks. */
export interface ComparisonStopRequest extends ComparisonTableRef {
  /** The refill pass to take back; the rest of the table's fill goes on. Absent: the whole fill. */
  pass?: string;
}

/**
 * A comparison table to fill: the whole table, or some of its columns alone,
 * so a column just added or reworded never writes its neighbours again; or
 * some of its rows alone, so Documents added later fill without touching the
 * Answers already there.
 */
export type ComparisonFillMode = "fill" | "refill" | "refill-all" | "refill-problems";

export interface ComparisonCellRef {
  documentId: string;
  questionId: string;
}

export interface ComparisonFillRequest extends ComparisonTableRef {
  /** The columns to fill, by their Questions' ids; absent with documentIds: every cell to fill. */
  questionIds?: readonly string[];
  /** The rows to fill, by their Documents' ids; absent with questionIds: every cell to fill. */
  documentIds?: readonly string[];
  /** Exact cells to fill, in addition to any row/column scope. */
  cells?: readonly ComparisonCellRef[];
  /** Refill Answers, override protection, or retry only failures; absent: cells with no Answer. */
  mode?: ComparisonFillMode;
  /** The cell identities this pass may write; a later User change or pass refuses late writes. */
  pass?: string;
}

/** A comparison table's column to move, and where it lands. */
export interface ComparisonColumnMove extends ComparisonTableRef {
  /** The window that made it, so only that window's Undo can take it back. */
  clientId: string;
  /** The column's Question. */
  questionId: string;
  /** Where it lands among all the columns, hidden ones counted: the second column is 1. */
  to: number;
}

/** Where a moved column now is, and whether it moved at all. */
export interface ComparisonColumnMoveResult {
  /** Among all the columns, hidden ones counted: the second column is 1. */
  index: number;
  moved: boolean;
  /** The core's record of this change, for its Undo and Redo. */
  step: string;
}

/** A column's label and Question, edited on the Mind's own content by the core. */
export interface ComparisonColumnEditRequest extends ComparisonTableRef {
  clientId: string;
  questionId: string;
  text: string;
  label: string;
}

/** What editing a column did: a new Question gives it new cells, to fill. */
export interface ComparisonColumnEdited {
  changed: boolean;
  refilled: boolean;
  questionId: string;
  label: string;
  step: string;
}

/** A column put beside another. */
export interface ComparisonColumnInsertRequest extends ComparisonTableRef {
  clientId: string;
  /** The column it goes beside. */
  questionId: string;
  side: "left" | "right";
  text: string;
  label?: string;
}

/** A column copied beside itself. */
export interface ComparisonColumnDuplicateRequest extends ComparisonTableRef {
  clientId: string;
  questionId: string;
}

/** What a new or copied column left for the window: whether to fill it. */
export interface ComparisonColumnAdded {
  questionId: string;
  label: string;
  /** Its cells wait for an Answer, so the window fills it. */
  fill: boolean;
  step: string;
}

/** A column taken out whole. */
export interface ComparisonColumnRemoveRequest extends ComparisonTableRef {
  clientId: string;
  questionId: string;
}

/** What removing a column left: the column to focus. */
export interface ComparisonColumnRemoved {
  label: string;
  focusId: string | null;
  step: string;
}

/** A column's width in pixels, within the table's bounds. */
export interface ComparisonColumnWidthRequest extends ComparisonTableRef {
  clientId: string;
  questionId: string;
  width: number;
}

export interface ComparisonColumnWidthSet {
  label: string;
  width: number;
  step: string;
}

/** A column hidden from the table, or shown again. */
export interface ComparisonColumnHiddenRequest extends ComparisonTableRef {
  clientId: string;
  questionId: string;
  hidden: boolean;
}

export interface ComparisonColumnHiddenSet {
  label: string;
  questionId: string;
  hidden: boolean;
  focusId: string | null;
  step: string;
}

/** Documents added as rows to a table that exists. */
export interface ComparisonRowsAddRequest extends ComparisonTableRef {
  clientId: string;
  /** The Documents to add, in order; ones the table already has, or checks leave out, are dropped. */
  documentIds: readonly string[];
}

/** What adding Documents left: the rows there now, and whether any fill waits for an Answer. */
export interface ComparisonRowsAdded {
  documentIds: string[];
  labels: string[];
  /** Their cells wait for an Answer, so the window fills those rows. */
  fill: boolean;
  step: string;
}

/** A row taken out of a table. */
export interface ComparisonRowRemoveRequest extends ComparisonTableRef {
  clientId: string;
  documentId: string;
}

/** What removing a row left: its name for the undo line, and the row to focus. */
export interface ComparisonRowRemoved {
  label: string;
  focusDocumentId: string | null;
  step: string;
}

/** A row of a table moved, by its Document, to a place among the rows. */
export interface ComparisonRowMoveRequest extends ComparisonTableRef {
  clientId: string;
  documentId: string;
  /** Where it lands among the rows: the second row is 1. */
  to: number;
}

export interface ComparisonRowMoveResult {
  /** Among the rows: the second row is 1. */
  index: number;
  moved: boolean;
  step: string;
}

/** A structure change of a table, by the core's record of it and the window that made it. */
export interface ComparisonStructureRef extends ComparisonTableRef {
  clientId: string;
  step: string;
}

/** Taking back, or doing again, a structure change of a table, by the core's record of it. */
export interface ComparisonStructureUndoResult {
  moved: boolean;
  /** It isn't the table's latest structure change, or another window made it. */
  reason?: "changed";
}

/** A window watching a Mind's comparison tables, for the flush and lock around a structure change. */
export interface ComparisonWatch {
  mindId: string;
  clientId: string;
}

/** A window saying its changes for the Mind have reached the core. */
export interface ComparisonStructureAck {
  requestId: string;
  clientId: string;
}

/** A window that is gone, or no longer answers: the core stops waiting for it. */
export interface ComparisonWindow {
  clientId: string;
}

/**
 * What asking for a comparison table, or for its cells to be filled, did: it
 * is in the Mind (a change to accept, the first time) and its cells are being
 * filled; or nothing was written or sent, because the model can't be used yet
 * (`readiness` says why) or the User didn't allow it to be sent to.
 */
export type ComparisonResult =
  | { started: true; tableId: string }
  | { started: false; reason: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  | { started: false; reason: "consent-declined" }
  | { started: false; reason: "nothing-to-fill" };

/** What saving a comparison table as an Excel workbook did (`CoreApi.saveComparisonExport`). */
export type SavedComparisonExport =
  /** Saved, with how many of the workbook's Citations aren't "Quote found", which the result line says. */
  | {
      status: "saved";
      file: SavedFile;
      unverifiedCitations: number;
      /** The columns the file leaves out, for the app to say so. */
      hiddenColumns: number;
    }
  | Exclude<SavedExport, { status: "saved" }>;

/** A comparison table whose cells are being filled ("comparison.filling"). */
export interface ComparisonFilling extends ComparisonTableRef {
  filling: boolean;
}

/** A comparison table whose structure the core is writing ("comparison.structure"). */
export interface ComparisonStructureWriting extends ComparisonTableRef {
  requestId: string;
  writing: boolean;
}

/**
 * Where a Task (CONTEXT.md, #126) is:
 * - "running": doing its steps, or waiting for its turn behind an Answer or a
 *   recording; with an `ask`, waiting for the User;
 * - "paused": waiting until it is resumed (`pausedReason` says why);
 * - "done", "stopped" (by the User, or its table or Mind went) or "failed":
 *   finished, kept in Recent for 7 days.
 */
export type TaskStatus = "running" | "paused" | "done" | "stopped" | "failed";

/**
 * Why a Task is paused: the User paused it; IncarnaMind was closed while it
 * waited for the User; the monthly cap or a plan's limit stopped it; or its
 * model can't be used now (a key removed, local mode). All but "user" need
 * the User to act.
 */
export type TaskPausedReason = "user" | "closed" | "cost-cap" | "plan-limit" | "not-ready";

/**
 * A step of a Task that changes something outside IncarnaMind's database,
 * journalled before and after it runs, so that after a crash its outcome is
 * checked before anything is done again: a whole file written (the SHA-256
 * of what it writes, and of what was there before, null for no file), or a
 * call of a Connector's Tool, which IncarnaMind can't check afterwards.
 */
export type TaskEffect =
  | { kind: "file-write"; path: string; sha256: string; previous: string | null }
  | { kind: "connector"; connectorId: string; connectorName: string; tool: string };

/**
 * What a Task waits for the User to answer, one at a time:
 * - "approval": a call that asks first; the request itself is among
 *   `listApprovalRequests` with this Task's `taskId`, answered with
 *   `respondToApproval`, and asked again if IncarnaMind was closed meanwhile;
 * - "unknown-outcome": IncarnaMind was closed in the middle of an Effect and
 *   can't tell whether it happened; `answerTaskAsk` does it again or skips it.
 * `number` counts the Task's asks so far, this one included.
 */
export type TaskAsk =
  | { kind: "approval"; stepKey: string; number: number }
  | { kind: "unknown-outcome"; stepKey: string; number: number; effect: TaskEffect };

/** How far a Task is: so many of its items settled, of so many. */
export interface TaskProgress {
  done: number;
  total: number;
}

/** What the User can ask of a Task from its progress in the thread, as its kind allows (#657). */
export type TaskAction = "plan" | "tell" | "pause" | "stop";

/**
 * A step of a Task, as its progress shows it: what it does, in the Task's own
 * words ("Corvane Agreement · Termination notice"), and how it went. "failed":
 * it ended without its result (a cell with no Answer); "skipped": the User
 * chose to go on without it.
 */
export interface TaskStep {
  key: string;
  text: string;
  status: "running" | "done" | "failed" | "skipped";
}

/**
 * A Task (CONTEXT.md): a Run that goes on in the background and keeps its
 * place when IncarnaMind is quit. Its journal (`runs`, `run_steps`) records
 * each step as started and completed.
 */
export interface Task {
  id: string;
  /** What runs it: "comparison" fills a comparison table. A kind this version doesn't know stays as it is. */
  kind: string;
  /** The Mind it works in, if any. */
  mindId: string | null;
  /** The Block in that Mind it works on (a comparison table), if any: where opening it goes. */
  blockId: string | null;
  /** What the User asked it, in their words (a Research Task's topic): its Question in the thread. */
  question: string | null;
  /**
   * Where Review opens when it isn't the Task's own place: the Mind it wrote
   * into, at the first change it proposed there (a Research Task's draft).
   */
  review: { mindId: string; proposalId: string | null } | null;
  status: TaskStatus;
  pausedReason: TaskPausedReason | null;
  /** "plan-limit": when the plan's limit resets (ISO 8601), when the provider says. */
  resetsAt: string | null;
  ask: TaskAsk | null;
  progress: TaskProgress | null;
  /** "failed": why, as a `ProviderErrorKind` or another short kind. */
  problem: string | null;
  /** What its model requests have cost once settled; null with none billed. */
  cost: Money | null;
  /** What its kind lets the User ask of it, whatever it is doing now. */
  actions: TaskAction[];
  /** Its latest steps, oldest first (`listTaskSteps` has them all). */
  steps: TaskStep[];
  /** How many steps it has started in all. */
  stepCount: number;
  /** What the User told it that it hasn't read yet (`tellTask`), oldest first: read when its next step starts. */
  queued: TaskMessage[];
  /** Paused at a limit (the monthly cap, a plan's), the steps it has still to do, in its kind's words. */
  remaining: string[];
  /** Done, what it did in a few words ("3 sources saved · 2 changes proposed"); null otherwise. */
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

/** What answering a Task's "unknown-outcome" ask does: the step again, or on without it. */
export type TaskAskAnswer = "redo" | "skip";

/** Something the User told a running Task (Tell it…), waiting for its next step. */
export interface TaskMessage {
  id: string;
  text: string;
}

/** A Research Task's plan (Plan): each step with how far it is, or how it ended. */
export interface ResearchPlanView {
  title: string;
  steps: { text: string; status: "waiting" | "running" | "done" | "failed" }[];
  sources: ResearchSources;
  /** The Mind it writes into, or null for a new one. */
  writeInto: string | null;
}

/** Where a Research Task looks (#130): the web, and the Library within the composer's Search scope. */
export interface ResearchSources {
  web: boolean;
  library: boolean;
}

/** What to plan a Research Task for. */
export interface PlanResearchInput {
  /** The Mind the assistant reads, where the Task will be; null with no Mind in focus. */
  mindId: string | null;
  topic: string;
  /** Where it will look, as the plan card's toggles stand. */
  sources: ResearchSources;
  /** The composer's model; the default model when left out. */
  model?: ChatModelChoice | null;
  /** "Change the plan…": the steps as they stand, and what the User said to change in them. */
  change?: { steps: string[]; text: string } | null;
}

/** A Research Task's plan: its topic as a question, and the steps it takes before it writes. */
export interface ResearchPlan {
  title: string;
  steps: string[];
}

/** What planning did: a plan, or why there is none (nothing was sent unless it failed). */
export type ResearchPlanResult =
  | { planned: true; plan: ResearchPlan }
  | { planned: false; reason: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  | { planned: false; reason: "consent-declined" }
  | { planned: false; reason: "failed"; error: ProviderError };

/** Where a Research Task writes its cited draft: a Mind, or a new one it makes. */
export type ResearchTarget = { mindId: string } | { newMind: true };

/** A Research Task to start, from its plan card. */
export interface StartResearchInput {
  /**
   * The Mind the assistant reads: the Task shows in its thread. Null with no
   * Mind in focus: the Task gets the new Mind its draft goes into.
   */
  mindId: string | null;
  topic: string;
  plan: ResearchPlan;
  sources: ResearchSources;
  writeInto: ResearchTarget;
  /** What the Library is searched within: the composer's Search scope. */
  scope: SearchScope;
  /** The composer's model; the default model when left out. */
  model?: ChatModelChoice | null;
}

/** What starting a Research Task did: it runs, or nothing was sent and why. */
export type ResearchStartResult =
  | { started: true; task: Task }
  | { started: false; reason: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  | { started: false; reason: "consent-declined" };

/** Open a Task's place: its Mind, with its progress in the thread (`showTask`, a notification's click). */
export interface TaskShown {
  taskId: string;
  mindId: string | null;
  blockId: string | null;
}

/** A large run to estimate: so many items (a comparison table's cells, verify's sentences…). */
export interface RunEstimateInput {
  items: number;
  /** What each item is: about an Answer (the default), or a sentence checked against Documents (#973). */
  each?: "answer" | "check";
  /** The web searches it makes (#128), each billed by the model's provider, on top of its items. */
  searches?: number;
  /** The model it would use; the default model when left out. */
  model?: ChatModelChoice;
}

/**
 * The one estimate shown before a large run on a model billed per token,
 * never asked: its calls, tokens and price, with the month so far. A plan or
 * a model on this computer gets none: a plan's price is fixed, and none of
 * the plans IncarnaMind uses says how much of its window is left.
 */
export type RunEstimate =
  | {
      billing: "per-token";
      calls: number;
      tokens: number;
      /** Null for a model with no known price. */
      cost: Money | null;
      /**
       * The most it may come to, with the requests it sends only when what it reads asks for
       * them: in a whole read (#1554), every other call each check's Run may make, what a check
       * may ask after its Run, the looks at a quote a window's judgement gives, and a judgement
       * its sentence's last check said it wouldn't need. A whole read's `cost` here is its
       * budget, which the meter holds it to (../shared/readBudget).
       */
      upTo?: { calls: number; tokens: number; cost: Money | null };
      spentTowardCap: Money | null;
      setAsideTowardCap: Money | null;
      cap: MonthlyCap | null;
    }
  | { billing: "plan" | "free" };

export type ConnectionTestResult = { ok: true } | { ok: false; error: ProviderError };

/** A model on a saved chat provider. */
export interface ChatModelChoice {
  providerId: string;
  modelId: string;
}

/**
 * Whether Questions can be asked, and if not, what the User has to do.
 *
 * When `consent` is "needed", the first Question asks the User to accept the
 * chat data flow before anything is sent.
 */
export type ChatReadiness =
  | {
      ready: true;
      provider: ChatProvider;
      modelId: string;
      consent: "accepted" | "needed" | "not-required";
    }
  | { ready: false; reason: "no-provider" }
  | {
      ready: false;
      /**
       * "missing-api-key": the provider needs a key and none is stored.
       * "consent-declined": the User declined sending data to its service.
       * "sign-in-required": the provider uses a sign-in (the ChatGPT plan) and
       * this device has none, e.g. the User signed out or it expired.
       * "local-mode": "Keep everything on this computer" is on and the model isn't
       * on this computer, so no Question is sent to it (each other flow checks
       * local mode itself).
       */
      reason: "missing-api-key" | "consent-declined" | "sign-in-required" | "local-mode";
      provider: ChatProvider;
      modelId: string;
    };

/**
 * Why a listed model isn't in the menu by default: "unknown" (the catalog
 * doesn't know it), "older" (deprecated, or on its way out), or
 * "cannot-answer" (it needs another API than chat, for `reason`; it can't be
 * added).
 */
export interface OtherModel {
  id: string;
  why: "unknown" | "older" | "cannot-answer";
  reason?: CannotAnswerReason;
}

/** Which API, other than chat, a model needs. */
export type CannotAnswerReason = "completion" | "audio" | "deep-research" | "computer-use";

/** What a typical Answer (`TYPICAL_ANSWER`) costs with a model, in the provider's own currency. */
export type ModelCost =
  | { kind: "estimate"; currency: Currency; amount: number }
  | { kind: "free" }
  | { kind: "plan" };

export interface ModelAbout {
  /** Null where nothing says. */
  tools: boolean | null;
  readsImages: boolean;
  /** Null where nothing says. */
  reasoning: boolean | null;
  /** In tokens; null when unknown. */
  context: number | null;
  /** Null when its price isn't known. */
  cost: ModelCost | null;
}

/** `step` says which request failed: the model list, or the one word from `modelId`. */
export type ProviderTestResult =
  | { ok: true; modelId: string; ms: number }
  | { ok: false; step: "list" | "answer"; modelId: string | null; error: ProviderError };

/** The quick-tasks and image models as `UserSettings` leaves them to be worked out, worked out now. */
export interface ModelRoles {
  /** Null with no Answers model. */
  quickTasks: ChatModelChoice | null;
  /** Null when no model reads images. */
  images: ChatModelChoice | null;
}

export interface SetChatModelInMenuInput {
  providerId: string;
  modelId: string;
  inMenu: boolean;
}

/** A saved chat provider and the models a Question's model picker offers on it. */
export interface ChatModelGroup {
  provider: ChatProvider;
  /**
   * Model ids in the menu: the default model if it is on this provider, first;
   * then the provider's role models, then the rest of the catalog's current chat
   * models it lists (every model a server lists, for Ollama and other servers),
   * then those the User added.
   */
  models: string[];
  /** The names the provider's own list gives, by model id, where it gives them. */
  names: Record<string, string>;
  /**
   * What the provider lists that the menu leaves out (see `OtherModel`), for
   * Settings → Models → Other models, including ids the User has added.
   */
  other: OtherModel[];
  /** The ids in `models` that the User added from `other`; "In the menu" is on for them. */
  added: string[];
  /** The ids in the menu unless taken out, in the menu's order, those taken out (`hidden`) in place. */
  offered: string[];
  /** Never the default model. */
  hidden: string[];
  /** For each id in `offered`, `added` and `other`. */
  about: Record<string, ModelAbout>;
  /** `checked` is when the prices were checked (YYYY-MM-DD); null where nothing is priced. */
  prices: { url: string; checked: string } | null;
  /**
   * The ids in `models` whose capabilities are unknown: neither the catalog
   * nor the provider says what they can do. They still work; an Answer finds
   * out as it goes.
   */
  unknown: string[];
  /**
   * The ids in `models` that run in the cloud although the provider is on this
   * computer: an Ollama cloud model, which Ollama forwards to ollama.com. Asking
   * with one needs consent to send to that service, and local mode refuses it.
   */
  cloud: string[];
}

// ---------------------------------------------------------------------------
// Questions and Answers (ADR-0007)

export interface AskQuestionInput {
  mindId: string;
  /** The Question Block's id. */
  questionId: string;
}

export interface RegenerateAnswerInput {
  mindId: string;
  answerId: string;
}

export interface StopAnswerInput {
  mindId: string;
  answerId: string;
}

/** Where the User paused writing, for a suggestion of how their paragraph goes on (#282). */
export interface SuggestionRequest {
  /** Chosen by the caller, so it can cancel the request (`cancelSuggestion`). */
  requestId: string;
  mindId: string;
  /** The paragraph's text, up to the caret at its end. */
  paragraph: string;
  /** What the Mind's next Question would search: the composer's Search scope. */
  scope: SearchScope;
}

/** How the User's paragraph may go on, from one Passage of their Documents, with its Citation. */
export interface Suggestion {
  suggestionId: string;
  requestId: string;
  /** The words to add after the paragraph: the rest of its sentence, or its next one. */
  text: string;
  /** Checked when it was made, and its quote found: no other suggestion is given. */
  citation: Citation;
  /** The model that wrote it. */
  providerId: string;
  modelId: string;
}

/** What a pause at the end of a paragraph gives. */
export type SuggestionOutcome =
  | { kind: "suggestion"; suggestion: Suggestion }
  /**
   * Suggestions are off. `scopeHasDocuments`: the Search scope has Documents
   * to suggest from, so offering to turn them on could help.
   */
  | { kind: "off"; scopeHasDocuments: boolean }
  /**
   * Nothing to suggest: the Documents don't support a continuation strongly
   * enough, the quote wasn't found, the model can't be used now (see
   * `SuggestionStatus.paused`) or failed, or the request was cancelled.
   */
  | { kind: "none" };

/** Suggestions on this device: today's counts, and why they can't be made now. */
export interface SuggestionStatus {
  /** Today (the computer's day): suggestions shown, and those accepted. Counted here only. */
  today: { shown: number; accepted: number };
  /**
   * Why suggestions that are on can't be made now, or null: no chat model;
   * the "suggestions" flow to its service isn't allowed (turning suggestions
   * on again asks); or local mode, with a model that isn't on this computer.
   */
  paused:
    | { reason: "no-model" }
    | { reason: "consent"; service: ExternalService }
    | { reason: "local-mode" }
    | null;
}

/** A suggestion the User accepted into a Mind: for today's count, and the record of AI use. */
export interface SuggestionAccepted {
  suggestionId: string;
  mindId: string;
  providerId: string;
  modelId: string;
  /** How much was accepted, in characters. */
  characters: number;
  /** When, ISO 8601, UTC. */
  acceptedAt: string;
  /** The suggestion's Citation, now in the Mind. */
  citation: Citation;
}

/**
 * A place in a Mind's text: a paragraph or a heading, by its Block id, and a
 * character offset into its text, where an inline node (a Citation, a
 * formula, a line break, a footnote with all its text) counts as one
 * character.
 */
export interface TextPlace {
  blockId: string;
  offset: number;
}

/**
 * What Edit with AI does with the selected text (#93): improve the writing,
 * shorten it, translate it, explain it in a new paragraph under it, what the
 * User asked for in their own words, or take out the part of a cited sentence
 * its Citations don't support (#1111), or make the sentence agree with the words its Citations
 * now quote in a new version of their Document (#99).
 */
export const editActions = [
  "improve",
  "shorten",
  "translate",
  "explain",
  "instruction",
  "cut-unsupported",
  "follow-citation",
] as const;
export type EditAction = (typeof editActions)[number];

export interface EditWithAiInput {
  /** Chosen by the caller, so it can stop the request (`cancelEdit`). */
  requestId: string;
  mindId: string;
  /** Where the selection starts, and where it ends, after it. */
  from: TextPlace;
  to: TextPlace;
  /**
   * The selected text as the editor read it: an inline node as U+FFFC, and
   * each paragraph on a line of its own. The core edits it only while the
   * Mind still holds it.
   */
  text: string;
  action: EditAction;
  /**
   * For "translate", the language to translate into, as the User would name
   * it ("English", "简体中文"); for "instruction", what the User asked for;
   * for "cut-unsupported", the part the check found unsupported
   * (`UnsupportedReason.uncovered`).
   */
  instruction?: string;
  /** The model to use: the Mind's own; none, or null, the default chat model. */
  model?: ChatModelChoice | null;
}

/**
 * Regenerate of a change from Edit with AI (#94), usually one out of date:
 * the same request is made again from the text the change covers as it is
 * now, and its new changes replace it.
 */
export interface RegenerateProposalInput {
  /** Chosen by the caller, so it can stop the request (`cancelEdit`). */
  requestId: string;
  mindId: string;
  /** The Proposal to make again (`ProposalRef.id`). */
  proposalId: string;
  /** The model to use: the Mind's own; none, or null, the default chat model. */
  model?: ChatModelChoice | null;
}

/** What Edit with AI did. */
export type EditWithAiResult =
  /**
   * The changes are in the Mind as Proposals: `proposals` of them, all from
   * `request`. `droppedCitations`: how many Citations they would remove.
   * `outOfDate`: how many were out of date as they arrived, because the User
   * edited their text while the model worked.
   */
  | {
      kind: "proposed";
      request: string;
      proposals: number;
      droppedCitations: number;
      outOfDate: number;
      /** Markers the text had for none of the passage's Citations, left out. Absent: none. */
      unmatchedMarkers?: number;
      /** Sources in a table's cells written as a name in brackets that matched none of its Citations, kept as text (#961). Absent: none. */
      unlinkedSources?: number;
      /** Cells beyond a table's columns, their text kept in their row's last cell. Absent: none. */
      extraCells?: number;
      /** An edit the User asked for that waits for them instead of applying (#880). */
      held?: true;
      /** What its new text left out of the selection, kept; absent when nothing. */
      leftOut?: LeftOutPart[];
      /**
       * The Mind's Yjs state vector once the Proposals were written. This reply can reach a
       * window before the last `"mind.update"` that wrote them, so a window waits until its
       * copy has all of this before it applies or holds them.
       */
      stateVector: Uint8Array;
    }
  /** The model gave the text back as it was: there is nothing to propose. */
  | { kind: "unchanged" }
  /** Nothing was sent: the model can't be used now, and `readiness` says why. */
  | { kind: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  /** Nothing was sent: local mode is on, and the model isn't on this computer. */
  | { kind: "local-mode" }
  /**
   * The selected text isn't in the Mind any more (its paragraphs were deleted
   * meanwhile), or the change to regenerate has gone: nothing was written.
   */
  | { kind: "changed" }
  /** Nothing was sent: the selection holds Proposals that are still waiting. */
  | { kind: "has-proposals" }
  /** Nothing was sent: the selected text is more than the model can take at once. */
  | { kind: "too-long" }
  /** The User stopped it (`cancelEdit`). */
  | { kind: "cancelled" }
  /**
   * The model wrote lines that read as a table's rows but make no table
   * (#961): nothing was written. `text`: the passage's new text, as it wrote it.
   */
  | { kind: "no-table"; text: string }
  /**
   * The model marked text to take out that the passage doesn't have word for word in one
   * place (#2180): nothing was written. `quotes`: that text, as it wrote it.
   */
  | { kind: "unplaced"; quotes: string[] }
  /** The model failed, or gave nothing back. */
  | { kind: "failed"; error: ProviderError };

/**
 * The checks of the User's own sentences (#96). Check against Documents
 * checks a sentence's claim against the Documents, telling the model what
 * the sentence already cites, so the claim is checked and not only the
 * quote. "find-support" is that check as an older version named it, and
 * runs as Check against Documents does. Contradiction watch (#112) checks a
 * cited sentence against the other Documents in its Mind's Folder, the ones
 * it cites left out, and keeps a mark only where one contradicts it.
 */
export const claimCheckActions = [
  "find-support",
  "check-against-documents",
  "contradiction-watch",
  "check-against-document",
] as const;
export type ClaimCheckAction = (typeof claimCheckActions)[number];

/** What a claim check found (CONTEXT.md: supported, unsupported, contradicted). */
export type ClaimVerdict = "supported" | "unsupported" | "contradicted";

/**
 * Why a sentence wasn't checked. It is never shown as supported.
 * - "refused": the model declined to check it.
 * - "malformed": its reply held no verdict that could be read.
 * - "empty": its reply was empty.
 * - "no-evidence": it gave a verdict, but no quote the Citation check finds in the Passage it named.
 * - "unread": it gave a verdict without searching the Documents, even when asked once more.
 * - "rate-limit": the model's service refused more requests for now.
 * - "cost-cap": it could pass the monthly cap, so nothing was sent.
 * - "plan-limit": the plan's usage limit is reached.
 * - "out-of-credit": the model's service says the credit balance is too low.
 * - "failed": the model or its service failed otherwise (`detail` says how).
 * - "stopped": the User stopped the check, or IncarnaMind quit, before this sentence was checked.
 * - "too-many": the assistant wrote more sentences with Citations than one write has checked (#1111).
 * - "consent-revoked": the User turned off sending checks to the model's service while it ran.
 * - "local-mode": "Keep everything on this computer" came on while it ran.
 * - "kept-inside": the existing Citation is outside this wall, so it was not read again.
 * - "absence-unconfirmed": a whole read's window said what the sentence calls absent is there,
 *   but a look at its quote found it doesn't state that (#1554).
 * - "read-budget": a whole read reached the most it may spend before this part was judged, so
 *   nothing more was sent (`detail`: that most and what it had spent, as JSON of
 *   `{ most: Money; spent: Money }`).
 * - "workbook-changed": a figure worked out from a workbook's formulas (#2347) no longer reads the
 *   same from its cells, or no longer works out the same from them.
 * - "workbook-differs", "-external", "-volatile", "-circular", "-not-read", "-no-saved-value" and
 *   "-unsupported": a figure the workbook gives depends on a cell IncarnaMind can't work out (its
 *   saved value differs from its formulas, it links to another file, it changes each time, its
 *   formulas refer to each other, it reads a sheet or rows that weren't read, Excel saved no value
 *   for it, or any other formula IncarnaMind can't work out), so its cell's number backs nothing.
 */
export type ClaimCheckFailure =
  | "refused"
  | "malformed"
  | "empty"
  | "no-evidence"
  | "unread"
  | "rate-limit"
  | "cost-cap"
  | "plan-limit"
  | "out-of-credit"
  | "failed"
  | "stopped"
  | "too-many"
  | "consent-revoked"
  | "local-mode"
  | "absence-read-limit"
  | "absence-unconfirmed"
  | "kept-inside"
  | "cut-short"
  | "read-budget"
  | "workbook-changed"
  | "workbook-differs"
  | "workbook-external"
  | "workbook-volatile"
  | "workbook-circular"
  | "workbook-not-read"
  | "workbook-no-saved-value"
  | "workbook-unsupported";

/** Why a sentence was found unsupported, as the check gave it. */
export interface UnsupportedReason {
  kind?: "forecast-certainty" | "unbacked-cause";
  /** One plain sentence on what no Passage states; null when the reply gave none. */
  reason: string | null;
  /** A short phrase for what the Passages do state of the sentence ("the speed comparison"); null when none. */
  covered: string | null;
  /** A short phrase for what they don't ("memory and robustness"); null when none. */
  uncovered: string | null;
  /**
   * True when the check found a Passage about the sentence that doesn't back it: its card says
   * Unsupported, never Not found (#1608). Absent when nothing in its scope was about it, and on
   * checks made before it was kept.
   */
  found?: true;
  /**
   * The Passage the check quoted for what is covered, as a Citation whose quote the
   * Citation check found; absent when it quoted none.
   */
  quoted?: CitationAttributes;
}

/** A Document an absence check read whole, with every Location read. */
export interface ClaimReadDocument {
  documentId: string;
  documentName: string;
  contentHash: string;
  locations: readonly CitationLocation[];
}

/** A Document version a check read, which it no longer holds for once the Document changes. */
export interface CheckedVersion {
  documentId: string;
  contentHash: string;
}

/** A Document left out of a check's evidence that matched (#80): the result names it, with Count it. */
export interface LeftOutDocument {
  documentId: string;
  documentName: string;
  reason: EvidenceExclusion;
}

/** How a sentence's number bounds a figure: it is a limit the figure stays within, or above. */
export type LimitRelation = "at most" | "at least";

/**
 * How a check worked out a figure the sentence states but the Documents don't
 * (#707): the figure, calculated from numbers they state (ADR-0021), and the
 * number the sentence writes for it. They agree to the sentence's rounding;
 * agreement settles only that number, never the whole sentence by itself.
 */
export interface ClaimCalculation {
  figure: CalculatedFigure;
  /** The number as the sentence writes it: "1.1x". */
  stated: string;
  /**
   * The sentence's number is a limit the figure stays within ("inside a 3.25x covenant": at most)
   * or above (at least), rather than the figure itself (#1908). Absent: it is the figure.
   */
  relation?: LimitRelation;
  /**
   * Whether they agree. One that doesn't contradicts the sentence; one that
   * does settles only that number, and a Passage may still contradict the rest.
   */
  agrees: boolean;
}

/** One Document's wording that can replace the contradicted part of a sentence. */
export interface ClaimCorrectionChoice {
  wording: string;
  evidence: CitationAttributes;
}

/** A confirmed contradiction's exact old substring and the Document wording choices for it. */
export interface ClaimCorrection {
  from: string;
  choices: ClaimCorrectionChoice[];
}

/** UTF-16 offsets into the checked sentence; end is exclusive. */
export interface ClaimPartSpan {
  start: number;
  end: number;
}

export interface ClaimPartPlan {
  span: ClaimPartSpan;
  kind: "fact" | "opinion";
}

export interface ClaimPartCoverageMember {
  label: string;
  verdict: ClaimVerdict | "not-checked";
  evidence: CitationAttributes[];
}

export interface ClaimPartCoverage {
  unit: string;
  quantifier: "all" | "most";
  complete: boolean;
  members: ClaimPartCoverageMember[];
  domainEvidence: CitationAttributes[];
}

export interface ClaimCheckPart extends ClaimPartPlan {
  verdict: ClaimVerdict | "not-checked" | "checking" | null;
  kept?: true;
  figures?: ClaimPartFigure[];
  remainder?: ClaimPartJudgment | null;
  evidence: CitationAttributes[];
  decidingEvidence?: number | null;
  says: string | null;
  unsupported: UnsupportedReason | null;
  calculation: ClaimCalculation | null;
  reason: ClaimCheckFailure | null;
  detail: string | null;
  versions: CheckedVersion[];
  excluded: LeftOutDocument[];
  citedCaseUnchecked: boolean;
  citedCaseFound: boolean;
  coverage?: ClaimPartCoverage;
  /** The Documents read whole to decide this part's absence (#1443): what backs it in place of a quote. */
  readDocuments?: readonly ClaimReadDocument[];
  /**
   * For "supported": the Document's own line that says which currency a bare "$" in the part is,
   * and where it is (#2226).
   */
  currencyClause?: string;
  /**
   * For "contradicted": the Document's wording for the part, `from` occurring exactly once in the
   * part's own words.
   */
  correction?: ClaimCorrection;
}

export type ClaimPartJudgment = (
  | ClaimJudgment
  | {
      verdict: "checking";
      versions: CheckedVersion[];
      excluded: LeftOutDocument[];
      kept?: true;
    }
) &
  Partial<
    Pick<
      ClaimCheckBasis,
      "id" | "request" | "action" | "text" | "scope" | "checkedAt" | "providerId" | "modelId"
    >
  >;

export type ClaimPartFigure = FigureFinding & { result: ClaimPartJudgment };

export interface OpinionSentence {
  id: string;
  blockId: string;
  text: string;
  occurrence: number;
  parts: ClaimCheckPart[];
}

/** A password-protected PDF Document, and the password to open it with (#763). */
export interface UnlockDocumentInput {
  documentId: string;
  password: string;
}

/** What unlocking a locked PDF did (#763). */
export type UnlockDocumentResult =
  | { kind: "unlocked"; document: Document }
  | { kind: "wrong-password" };

/** One record cite's own result inside a sentence's check (#1709). */
export interface RecordCiteResult {
  /**
   * The cite as written and its UTF-16 span, when it has one, in the sentence as the Note holds it:
   * each Citation there is one U+FFFC, which the mark's `text` leaves out.
   */
  raw: string;
  from?: number;
  to?: number;
  outcome: "supported" | "partly" | "unsupported" | "choose" | "not-found" | "not-checked";
  /** For "not-checked": why this cite's auxiliary judgement could not be read. */
  reason?: ClaimCheckFailure;
  detail?: string | null;
  documentId?: string;
  documentName?: string;
  contentHash?: string;
  location?: CitationLocation;
  /** The physical PDF Units the passage and viewer open, when it is one. */
  pageFrom?: number;
  pageTo?: number;
  passage?: string;
  /** For "partly": the parts the cited Location does and does not cover. */
  covered?: string;
  uncovered?: string;
  /** Documents the User must choose between; never a silent first match. */
  candidates?: { id: string; name: string }[];
  /**
   * For an `Id.` or `supra`: what its reading rests on, as written: the nearest cite before it that
   * names a place, when it names none itself, then the record cite its chain ends at; empty when it
   * referred to none. When they read otherwise now, the sentence needs re-check.
   */
  via?: string[];
  nearby?: {
    location: CitationLocation;
    pageFrom: number;
    pageTo: number;
    passage: string;
  };
}

/** What one claim check found: the claim-check function's result (`checkClaim`). */
export type ClaimJudgment =
  | {
      verdict: ClaimVerdict;
      kept?: true;
      parts?: ClaimCheckPart[];
      /**
       * For "supported" and "contradicted": the Passage that decides it, as a
       * Citation whose quote the Citation check found; for a figure worked out,
       * its first input's. For "unsupported": null, or the nearest line when it
       * states another value for the very thing the sentence says: "the
       * Documents say something different" (#770).
       */
      evidence: Citation | null;
      /** A finally confirmed contradiction's exact replacement choices; absent for every other result. */
      correction?: ClaimCorrection;
      /** For "supported" and "contradicted": what the Document says, in one plain sentence. */
      says: string | null;
      /** For "unsupported": why. Null for the other verdicts. */
      unsupported: UnsupportedReason | null;
      /** A figure worked out that decided it; null when a Passage did. */
      calculation: ClaimCalculation | null;
      /**
       * The sentence cites a court decision that none of the Documents holds: the citation itself
       * isn't checked, whatever else backs the sentence.
       */
      citedCaseUnchecked: boolean;
      /** The Passage that decides it is in the opinion of the court decision it cites, among the Documents. */
      citedCaseFound: boolean;
      /** The versions of the Documents it read, each once. */
      versions: CheckedVersion[];
      excluded: LeftOutDocument[];
      recordCites?: RecordCiteResult[];
      /** Documents read whole to decide an absence sentence, with every Location read. */
      readDocuments?: readonly ClaimReadDocument[];
    }
  | {
      verdict: "not-checked";
      kept?: true;
      parts?: ClaimCheckPart[];
      reason: ClaimCheckFailure;
      /** "failed": the provider's message. */
      detail: string | null;
      versions: CheckedVersion[];
      excluded: LeftOutDocument[];
      recordCites?: RecordCiteResult[];
      /** Documents read whole before the outcome, when an absence check needed them. */
      readDocuments?: readonly ClaimReadDocument[];
    };

export type FigureLocator =
  | ({ kind: "text" } & TextStretch)
  | { kind: "chart"; blockId: string; row: number; series: number };

export interface CheckFigure {
  id: string;
  locator: FigureLocator;
  reading: Figure;
  calculated: CalculatedFigureAttributes | null;
  context?: string;
  label?: string;
}

export interface FigureFinding extends CheckFigure {
  sourceInput: FigureInput | null;
  source?: Citation | null;
  roundedFrom: number | null;
  /** Note minus Source, in base units. */
  difference: number | null;
  footing: (FigureFooting & { axis: "row" | "column" })[];
  sourceFooting?: FigureSourceFooting[];
}

export interface FigureSourceFooting {
  axis: "row" | "column";
  componentIds: string[];
  /** Source rows the Note leaves out; only their used, checked inputs are retained. */
  inputs: FigureInput[];
  sum: number | null;
  agrees: boolean | null;
}

export type FigureScheduleReason =
  | "contradicted"
  | "unsupported"
  | "not-found"
  | "quote-not-found"
  | "needs-recheck"
  | "doesnt-add-up";

export interface FigureScheduleRow extends FigureFinding {
  number: number;
  sentence: TextStretch | null;
  shown: ClaimCheckShown;
  reason: FigureScheduleReason | null;
  sourceValue: number | null;
  sourceShown: string | null;
  checkedAt: string | null;
  model: ChatModelChoice | null;
  /** A Citation already follows the figure in the note, so Add as Citation has nothing to add. */
  cited: boolean;
  /** The User's own check of it (#1933), apart from IncarnaMind's. */
  signOff: SignOffNow | null;
  place: {
    heading: string | null;
    paragraph: number;
    table?: { row: number; column: number; rowLabel: string; columnLabel: string };
    chart?: { rowLabel: string; seriesLabel: string };
  };
}

export interface FigureSchedule {
  analyses: RetainedFigureAnalysis[];
  mindId: string;
  name: string;
  /** Fingerprint of the exact Note state used for this projection, including deletions. */
  basis: string;
  rows: FigureScheduleRow[];
  counts: {
    total: number;
    supported: number;
    needsLook: number;
    notChecked: number;
    checking: number;
    kept: number;
  };
  checkedAt: string | null;
  model: ChatModelChoice | null;
  progress: { done: number; total: number } | null;
}

/**
 * A Figure schedule as a change to one the caller holds (`since`, that one's `token`): its rows
 * `from` to `to` give way to `rows`. With no `since`, `rows` are all of them.
 */
export interface FigureScheduleChange extends Omit<FigureSchedule, "rows"> {
  /** Names this schedule, for asking for the next as a change to it. */
  token: string;
  since: string | null;
  from: number;
  to: number;
  /** How many paragraphs the rows after `to` moved down; their numbers move with `rows`. */
  shift: number;
  rows: FigureScheduleRow[];
}

export type FigureCheckResult = FigureFinding & { result: ClaimJudgment };

export type ClaimCheckResult = ClaimJudgment & {
  figures?: FigureCheckResult[];
  /** Undefined is a missing decomposition; null explicitly means no other assertion. */
  remainder?: ClaimJudgment | null;
  /**
   * For "supported": the Document's own line that says which currency a bare "$" in the claim is,
   * and where it is (#2226).
   */
  currencyClause?: string | null;
};

/**
 * What a sentence already cites: a Citation's quote, and its Document as it was cited. With
 * `documentId` (or `contentHash`) the check names the Document as it is named now; with
 * `passageId`, of the version it quotes, the check reads that Passage itself (#1459).
 */
export interface CitedQuote {
  documentName: string;
  quote: string;
  documentId?: string;
  contentHash?: string;
  passageId?: string;
}

export interface ChooseRecordCiteSourceInput {
  mindId: string;
  /** The sentence check whose one record cite is resolved again. */
  checkId: string;
  raw: string;
  from?: number;
  to?: number;
  documentId: string;
}

export interface ChooseRecordCiteSourceResult {
  cite: RecordCiteResult;
}

/** What the claim-check function checks (`checkClaim`). */
export interface CheckClaimInput {
  /** The sentence, or claim, to check: the User's own words. */
  claim: string;
  figures?: CheckFigure[];
  /** The paragraph it is in, for what its words refer to. */
  context?: string;
  /** What the sentence already cites, for Check against Documents. */
  cited?: CitedQuote[];
  /** Where to look. None: every Document. */
  scope?: SearchScope | null;
  /** The document being checked, which is never its own evidence (#97). */
  checked?: CheckedDocument;
  /** The model to check with; none, or null, the default chat model. */
  model?: ChatModelChoice | null;
}

/**
 * Where a sentence's check searched: the Search scope the User set for the
 * Mind (`chosen`, #1623), else the Mind's Folder (null for a Mind in none,
 * which searches every Document), or every Document (`widened`) because the
 * User asked ("Search all Documents") or the Mind's Folder held no Document
 * (#1359). A Mind moved to another Folder since needs its sentences checked
 * again, unless they were checked in its chosen scope or widened.
 */
export interface ClaimCheckScope {
  folderId: string | null;
  widened: boolean;
  chosen?: SearchScope;
}

/**
 * A sentence's check, as its `CLAIM_CHECK_MARK` stores it in the Mind: the
 * result and what it was made from, so it is known to need a re-check once
 * the sentence, a Document it read or the Mind's Folder changes.
 */
export interface ClaimCheckBasis {
  /** The result's random UUID: checking the sentence again gives it a new one. */
  id: string;
  /** The `checkSentences` request that made it. A "checking" mark of a request that ended was stopped. */
  request: string;
  action: ClaimCheckAction;
  state: "checking" | ClaimVerdict | "not-checked";
  parts?: ClaimCheckPart[];
  /** "not-checked": why. */
  reason: ClaimCheckFailure | null;
  /** "failed": the provider's message. */
  detail: string | null;
  /** The model that checked it; null on a mark made before it was kept. */
  providerId: string | null;
  modelId: string | null;
  /** The sentence as checked; part ranges index this exact text. */
  text: string;
  /** "supported" and "contradicted": the Passage that decides it, as a Citation found. */
  evidence: CitationAttributes | null;
  /** A confirmed contradiction's correction; absent for every other result. */
  correction?: ClaimCorrection;
  /** "supported" and "contradicted": what the Document says, in one plain sentence. */
  says: string | null;
  /** "unsupported": why. */
  unsupported: UnsupportedReason | null;
  /** A figure worked out that decided it; null when a Passage did. */
  calculation: ClaimCalculation | null;
  citedCaseUnchecked: boolean;
  citedCaseFound: boolean;
  scope: ClaimCheckScope;
  versions: CheckedVersion[];
  excluded: LeftOutDocument[];
  /** The individual record cites checked in this sentence, when it has any. */
  recordCites?: RecordCiteResult[];
  /** Documents read whole to decide an absence sentence, with every Location read. */
  readDocuments?: readonly ClaimReadDocument[];
  /** When it was checked, or started. ISO 8601, UTC. */
  checkedAt: string;
  /**
   * The User keeps the sentence as their own view (#1111): while its words
   * stay as they were checked, it isn't shown, counted or checked again.
   */
  kept?: true;
  /** "check-against-document": how much of the picked Document or Folder was read. */
  read?: WholeRead;
}

/** Pages read of a whole-read pick's total pages; a page without text cannot be read. */
export interface WholeRead {
  pages: number;
  of: number;
}

export interface FigureCheckAttributes extends ClaimCheckBasis, FigureFinding {}

export interface ClaimCheckAttributes extends ClaimCheckBasis {
  figures?: FigureCheckAttributes[];
  remainder?: ClaimCheckBasis | null;
}

export interface CheckSentencesInput {
  /** Chosen by the caller, so it can stop the request (`cancelCheck`). */
  requestId: string;
  mindId: string;
  part?: { id: string; span: ClaimPartSpan };
  /** Where the selection starts, and where it ends: each sentence it touches is checked, whole. */
  from: TextPlace;
  to: TextPlace;
  /** More stretches checked with `from`..`to`, each sentence once. */
  more?: TextStretch[];
  action: ClaimCheckAction;
  /** Search every Document, not the Mind's Folder ("Search all Documents"). */
  allDocuments?: boolean;
  /**
   * "check-against-document": the Document or Folder to read whole, on the Note's side of any
   * Folder wall. With `part`, only that part is read; without, each part not yet Supported or
   * Contradicted is.
   */
  within?: SearchScope;
  /**
   * With `within`, required: the `planDocumentCheck` it was asked from. Refused, sending nothing,
   * unless it is still the Note's latest plan and was made for this pick and these sentences; a
   * newer plan stops a read already running.
   */
  plan?: string;
  /** The model to use: the Mind's own; none, or null, the default chat model. */
  model?: ChatModelChoice | null;
}

/** What `checkSentences` will read whole: its sentences, or one part, and its pick. */
export interface PlanDocumentCheckInput {
  mindId: string;
  from: TextPlace;
  to: TextPlace;
  more?: TextStretch[];
  part?: { id: string; span: ClaimPartSpan };
  within: SearchScope;
  model?: ChatModelChoice | null;
}

export interface DocumentToRead {
  documentId: string;
  name: string;
  pages: number;
  readable: number;
}

/** What an explicit whole read takes; planning never sends text to a model. */
export type DocumentCheckPlan =
  | {
      kind: "ready";
      /** What a read of this plan names as its `plan`. */
      id: string;
      /**
       * The parts the read checks against the pick, each through every window: the estimate's
       * count. Null when a sentence's parts are sorted only as it is read: then at least one.
       */
      parts: number | null;
      documents: DocumentToRead[];
      pages: number;
      readable: number;
      tokens: number;
      estimate: RunEstimate | null;
    }
  | { kind: "too-large"; tokens: number; most: number }
  | { kind: "too-many"; documents: number; most: number }
  | { kind: "nothing-to-read" };

/** Progress through an explicit whole read, sent as it goes and never persisted. */
export interface DocumentCheckProgress {
  requestId: string;
  mindId: string;
  pages: number;
  of: number;
}

/** What `checkSentences` did. */
export type CheckSentencesResult =
  /**
   * Each sentence has its mark: `checked` of them with a verdict, the rest not
   * checked. `smallModel`: a model on this computer too small to judge
   * reliably made the verdicts (#680), so they carry a notice.
   */
  | {
      kind: "checked";
      sentences: number;
      checked: number;
      smallModel: boolean;
      /** Sentences left out because they hold changes still waiting; absent when none. */
      waiting?: WaitingSentences;
    }
  /** Nothing was sent: the model can't be used now, and `readiness` says why. */
  | { kind: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  /** Nothing was sent: local mode is on, and the model isn't on this computer. */
  | { kind: "local-mode" }
  /**
   * Nothing was sent: the scope holds no Document with text to check against. `chosen`: that
   * scope is the Search scope the User set for the Mind, while other Documents are there; its
   * items may be deleted, or, `onlyLeftOut`, hold only what the check leaves out (the file the
   * Mind was made from).
   */
  | {
      kind: "no-documents";
      folderId: string | null;
      chosen?: { scope: SearchScope; onlyLeftOut: boolean };
    }
  /** The selection holds no sentence to check, or isn't in the Mind any more. */
  | { kind: "nothing" }
  /** Nothing was sent: every sentence of the selection holds changes still waiting. */
  | { kind: "waiting"; waiting: WaitingSentences }
  /** The User stopped it (`cancelCheck`): the sentences not checked yet say "stopped". */
  | { kind: "cancelled" }
  /** Contradiction watch, nothing sent: the Mind is in no Folder, so there is none to check against. */
  | { kind: "no-folder" }
  /** Contradiction watch, nothing sent: the Folder holds no Documents but those its claims cite. */
  | { kind: "only-cited"; folderId: string }
  /** "check-against-document": the pick cannot be read whole, and the plan says why. */
  | { kind: "cannot-read"; plan: Exclude<DocumentCheckPlan, { kind: "ready" }> };

/** Contradiction watch (#112) on a whole Mind, on demand. */
export interface CheckContradictionsInput {
  /** Chosen by the caller, so it can stop the request (`cancelCheck`). */
  requestId: string;
  mindId: string;
  /** The model to use; none, or null: the Mind's own, else the default chat model. */
  model?: ChatModelChoice | null;
}

/** What a check for contradictions would check, before anything is sent. */
export type ContradictionCheckPlan =
  /**
   * `claims` cited sentences, each checked against the other Documents in the
   * Folder, with `model`: the Mind's own, or null for the default.
   */
  | { kind: "ready"; claims: number; model: ChatModelChoice | null }
  | Extract<
      CheckSentencesResult,
      { kind: "no-folder" | "only-cited" | "no-documents" | "nothing" }
    >;

/** What a check for contradictions found, on demand or after a new version (`ContradictionWatchRun`). */
export interface ContradictionCheckOutcome {
  /** The cited sentences checked: a contradicted one has its mark, the others none. */
  claims: number;
  /** Of them, those the model gave a verdict for. */
  checked: number;
  contradicted: number;
  /** What its requests billed per token cost; null when none was priced. */
  cost: Money | null;
  /** The monthly cap or a plan's limit stopped it; the claims after it weren't checked. */
  stop: RunStop | null;
  /** The verdicts came from a model too small to judge reliably (#680). */
  smallModel: boolean;
}

/** What `checkContradictions` did. */
export type CheckContradictionsResult =
  | ({ kind: "checked" } & ContradictionCheckOutcome)
  | Exclude<CheckSentencesResult, { kind: "checked" | "waiting" | "cannot-read" }>;

/**
 * The last check for contradictions a new version of a Document in the Mind's
 * Folder started (#112), kept in the Mind's settings so its line can show
 * what it found and cost (`src/shared/contradictionWatch.ts`).
 */
export interface ContradictionWatchRun {
  /** The cited sentences checked: a contradicted one has its mark, the others none. */
  claims: number;
  /** Of them, those the model gave a verdict for. */
  checked: number;
  contradicted: number;
  /** What its requests billed per token cost; null when none was priced. */
  cost: Money | null;
  /** The monthly cap or a plan's limit stopped it, or the User stopped it: the claims after it weren't checked. */
  stop: WatchStop | null;
  /** The verdicts came from a model too small to judge reliably (#680). */
  smallModel: boolean;
  /** When it ended. ISO 8601, UTC. */
  at: string;
  /**
   * The Document whose new version started it, by name; null when a Document
   * joining the Folder, the Mind joining it, or an on-demand check started it.
   */
  documentName: string | null;
}

/**
 * What "Check this Mind" checks (#737): "all", every sentence that makes a
 * claim, found afresh; "changed", the checks that need a re-check and the
 * sentences never checked since, found among those the last run didn't
 * leave out; "added", only the checks Documents added since could change
 * (`documentsAddedSinceChecks`), each in the scope it used.
 */
export type CheckMindMode = "all" | "changed" | "added";

/**
 * A sentence's check that Documents added since could change (#993): one
 * found unsupported or not checked, and the Documents added to the scope it
 * used after it was made. Supported and contradicted checks already have
 * their evidence, and contradiction watch checks its own marks.
 */
export interface DocumentsAddedSince {
  checkId: string;
  documentIds: string[];
}

export interface CheckMindInput {
  /** Only these current figures; sibling judgments and personal-view choices are kept. */
  figureIds?: string[];
  requestId: string;
  mindId: string;
  mode: CheckMindMode;
  /** Every Document, not only the Mind's Folder, as for `checkSentences`. */
  allDocuments?: boolean;
  /** The model; the Mind's own, else the default, when absent. */
  model?: ChatModelChoice | null;
}

/** A Note kept for one Check from its planning until it runs or is dropped (#2240). */
export interface HoldMindCheckInput {
  /** The request that plans and runs the Check; `cancelCheck` drops its hold. */
  requestId: string;
  mindId: string;
  /** The window holding it: the core frees the Note if that window goes before the Check runs. */
  clientId: string;
}

/** What `checkMind` would send, before it sends anything, so a cloud model's estimate can show first. */
export type MindCheckPlan =
  | {
      kind: "ready";
      /** The sentences it sends: to find the claims among, and the checks to make again. */
      sentences: number;
      /** Whether the model first names the claims among them; only checks made again don't need it. */
      findsClaims: boolean;
      /** Every sentence searches only the Mind's Folder; false also for mixed scopes. */
      inFolder: boolean;
      /** The Mind's own model; null for the default. */
      model: ChatModelChoice | null;
    }
  /**
   * "Changed" mode with nothing to send: every claim has a check that still holds, made no
   * earlier than `since` (ISO 8601 UTC; the oldest of them, else the last whole-Mind check;
   * null when neither says).
   */
  | { kind: "unchanged"; since: string | null }
  | Extract<CheckSentencesResult, { kind: "no-documents" | "nothing" }>;

/** The claims a Check this Mind run would check, once the model has named them (`findMindClaims`). */
export type FindMindClaimsResult =
  /** The fresh sentences it named as claims, and the checks to make again. */
  { kind: "found"; claims: number } | Exclude<CheckMindResult, { kind: "checked" }>;

export type CheckMindResult =
  /**
   * Each claim has its mark: `checked` of the `sentences` with a verdict, the
   * rest not checked. The monthly cap or a plan's limit stopped it (`stop`):
   * the claims after it say "not checked: cost cap".
   */
  | {
      kind: "checked";
      sentences: number;
      checked: number;
      smallModel: boolean;
      stop: RunStop | null;
    }
  /** The model couldn't name the claims: nothing was checked. */
  | { kind: "failed"; error: ProviderError }
  /** A Check of this Note is running already, asked from this window or another: none started. */
  | { kind: "running" }
  | Exclude<
      CheckSentencesResult,
      { kind: "checked" | "no-folder" | "only-cited" | "waiting" | "cannot-read" }
    >;

/**
 * The last whole-Mind check (#737), in the Mind's settings
 * (`src/shared/mindCheck.ts`), for the line under its title: "Checked 48
 * sentences, 2 Oct, 15:20".
 */
export interface MindCheckRun {
  /** When it finished. ISO 8601, UTC. */
  at: string;
  /** The Mind's sentences with a check then. */
  sentences: number;
  stop: RunStop | null;
  /** The sentences it found make no claim, by `sentenceKey`, so a later run doesn't send them again. */
  skipped: string[];
  /**
   * The sentences the model decided nothing about, even asked twice (#1682), by `sentenceKey`:
   * not examined, so they stay to check and a later run asks about them again.
   */
  unexamined: string[];
}

/**
 * A document someone else wrote, to verify claim by claim (#97): the window offers PDFs and Word
 * files (#110).
 */
export interface VerifyDocumentInput {
  /** The file's absolute path: a PDF, a Word file, or any other file the Library reads. */
  path: string;
  /** The Folder the Mind goes in, and the file too if it is new to the Library; none, or null, for none. */
  folderId?: string | null;
}

/** What `verifyDocument` did. */
export type VerifyDocumentResult =
  /** The Mind holds the document's text, a paragraph to a Block: its claims can be found. */
  | { ok: true; mind: Mind; documentId: string }
  /** No Mind was made: the file can't be read, or holds no text (a scan nothing could read). */
  | { ok: false; reason: "unreadable" | "no-text" }
  /** No Mind was made: a Word file that can't be imported, for the reason Word import gives. */
  | { ok: false; reason: "word"; refusal: WordRefusalReason };

/** Finding, or checking, the claims of a Mind made by `verifyDocument`. */
export interface VerifyClaimsInput {
  /** Chosen by the caller, so it can stop the request (`cancelCheck`). */
  requestId: string;
  mindId: string;
  /** Check against every Document, not the Mind's Folder. */
  allDocuments?: boolean;
  /** The model to use: the Mind's own; none, or null, the default chat model. */
  model?: ChatModelChoice | null;
}

export interface WaitingSentences {
  sentences: TextStretch[];
  changeIds: string[];
}

export interface TextStretch {
  from: TextPlace;
  to: TextPlace;
}

/** Why finding or checking a document's claims sent nothing. */
type VerifyRefusal =
  | Exclude<
      CheckSentencesResult,
      { kind: "checked" } | { kind: "waiting" } | { kind: "cannot-read" }
    >
  /** Another document's claims are being found or checked, in that Mind: one run at a time. */
  | { kind: "busy"; mindId: string };

/** What `findClaims` did. */
export type FindClaimsResult =
  /** The Mind records which of its sentences make claims: `claims` of them. */
  | { kind: "found"; claims: number }
  /** The model failed, or its reply named no sentences that could be read. */
  | { kind: "failed"; error: ProviderError }
  | VerifyRefusal;

/** What `verifyClaims` did. */
export type VerifyClaimsResult =
  /**
   * Each claim has its mark: `checked` of them with a verdict, the rest not
   * checked. `stop`: the monthly cap or a plan's limit stopped the run, and the
   * claims after it say so.
   */
  | { kind: "checked"; claims: number; checked: number; stop: RunStop | null }
  | { kind: "failed"; error: ProviderError }
  | VerifyRefusal;

/** What asking a Question (or regenerating its Answer) did. */
export type AskResult =
  /** The Answer is being written into the Mind, right after its Question. */
  | { asked: true; answerId: string }
  /** Nothing was sent: Questions can't be asked yet, and `readiness` says why. */
  | { asked: false; reason: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  /**
   * Nothing was sent: the Question forces a Skill (`skill`, its name) that is
   * turned off or no longer there. Turn it on, or take it off the Question.
   */
  | { asked: false; reason: "skill-unavailable"; skill: string; state: SkillAvailability };

/**
 * Where an Answer the events are about is written: in a Mind, or in one of the
 * assistant's conversations (ADR-0017).
 */
export interface AnswerPlace {
  /** The Mind it is written into; null for an Answer in a conversation. */
  mindId: string | null;
  /** The conversation it is in; absent for an Answer in a Mind. */
  conversationId?: string;
}

/** An Answer started: it is in its Mind or conversation with status "streaming". */
export interface AnswerStarted extends AnswerPlace {
  answerId: string;
  questionId: string;
  /** The model writing it. */
  model: ChatModelChoice;
}

/** More of an Answer's text arrived, as the model wrote it (Markdown). */
export interface AnswerDelta extends AnswerPlace {
  answerId: string;
  text: string;
}

/**
 * What an Answer being written is doing, for its meta line:
 * "waiting-for-consent", the User is asked whether to send the Question to
 * the model's service, and nothing is sent until they say; "loading", Ollama
 * is loading the local model; "searching", the User's Documents are being
 * searched; "writing", the model is at work; "checking-quotes", a local model
 * that answered with structured output is asked once more for the quotes of
 * its Citations that the check didn't find (ADR-0007), or an Answer in the
 * assistant checks its sentences against what they cite (#2311); "checking-figures", it
 * is asked once more for the calculated figures it gave that couldn't be
 * worked out (ADR-0021); "checking-claims", the quick model is checking the
 * reply's claims of changes against what the Tools did.
 */
export type AnswerPhase =
  | "waiting-for-consent"
  | "loading"
  | "searching"
  | "writing"
  | "checking-quotes"
  | "checking-figures"
  | "checking-claims";

/** An Answer being written moved to another phase. */
export interface AnswerPhaseEvent extends AnswerPlace {
  answerId: string;
  phase: AnswerPhase;
}

/**
 * More of the model's reasoning, as its provider summarized it (#391): only
 * from a provider whose reasoning is a summary (`AnswerSteps.reasoning`),
 * never raw chain of thought.
 */
export interface AnswerReasoning extends AnswerPlace {
  answerId: string;
  text: string;
}

/**
 * How an Answer in a conversation was reached, beside its Tool calls and
 * Citations (#391). Times are ISO 8601, UTC.
 */
export interface AnswerSteps {
  /** When its Question went to the model; null when none did (its Search scope had no Documents). */
  sentAt: string | null;
  /** When it ended; null while it is being written. */
  finishedAt: string | null;
  /** What it was doing, and from when, oldest first. */
  phases: { phase: AnswerPhase; at: string }[];
  /**
   * The model's reasoning as its provider summarized it (Anthropic's
   * summarized thinking, the Responses API's reasoning summary), and how long
   * it thought, in ms: from its first reasoning to the Answer's first text.
   * Null when the model gave no summary. Raw chain of thought is never kept.
   */
  reasoning: { summary: string; ms: number } | null;
  /**
   * How much of the Mind it read (`ConversationAnswer.read`) it read, from 0
   * to 1, when that was part of it (#564).
   */
  readShare?: number;
  /**
   * How many of its Citations were added after it was written, for sentences
   * it wrote without markers that match the Passages it read (#760).
   */
  citedAfterChecking?: number;
  /**
   * The model was asked once for the Citations its reply left out, and none came of it that
   * could be checked (#1415). Absent: it wasn't asked, or Citations came of it.
   */
  notCitedAfterAsking?: true;
  /**
   * How long, in ms, the Question was with the model before the Answer had
   * words: its text, or a Mind its Tool call began to change. Absent while
   * there are none, and for an Answer written before #899.
   */
  firstWordMs?: number;
  /** Its Question asked to check or calculate, so it was written with the larger thinking budget. */
  careful?: true;
  /**
   * The changes its reply says it made to a Mind that none of its Tool calls
   * made, even once the model was asked again with what they did.
   * Absent: none.
   */
  unbackedClaims?: ClaimedChange[];
  /**
   * What its reply says a Tool did that none of its calls did (#1796): a figure calculated or
   * checked, or a search. Absent: none.
   */
  unrunTools?: ClaimedTool[];
  /** With `unrunTools`: its model isn't offered the calculation Tool. */
  calculateUnavailable?: true;
  /** Its first reply said so, and the model was asked once more with what its calls did. */
  askedAgainFor?: ClaimedTool[];
  /** Written in advance for the example (`askExampleReadyQuestion`): no model wrote it, and nothing was searched. */
  example?: true;
  /**
   * It covered only some of the Documents in scope, or one of those a name fits, and offers the
   * rest. Absent: all of them.
   */
  coverage?: AnswerCoverage;
  /**
   * Documents in its Search scope were still being read (Queued or Extracting) when it ended, so
   * no search could find their text yet (#1503): how many, and the name when there is one.
   * Absent: none.
   */
  stillReading?: { count: number; name?: string };
  /**
   * A request to write, written from a Search scope that holds `documents` of the User's
   * `total` Documents (#1149). Absent: from all of them, or not a request to write.
   */
  writtenFrom?: { documents: number; total: number };
  /**
   * What its request held besides the Mind it read (`ConversationAnswer.read`), by id: the
   * Documents whose whole text went with the Question, and whether the live transcript of a
   * meeting did. Absent: an Answer written before this was kept, or one that isn't in the assistant.
   */
  sent?: { documents: string[]; transcript?: true };
  /**
   * A help button was pressed while its Meeting's live text was behind (#1366): the lines it had,
   * if any, went with the Question, and the reply says so first. Absent: it wasn't behind, or this
   * isn't a help Answer.
   */
  textBehind?: true;
}

/**
 * What an Answer covered of the Documents in scope, when not all of them: the
 * main few the Question asked for ("main"), the largest of more than one
 * summary covers well ("largest"), or the one Document it read by a name the
 * Question gives that other Documents' names or titles have too ("named",
 * #1512); by name as they were then. `rest`: the others' ids, which a second
 * Question can be asked from: for "named", the others the name fits.
 */
export interface AnswerCoverage {
  kind: "main" | "largest" | "named";
  used: { id: string; name: string }[];
  rest: string[];
}

/**
 * The changes an Answer's reply can say it made to a Mind: made one,
 * added text to one, changed text in one, or removed or replaced text in one.
 */
export const CLAIMED_CHANGES = ["made", "added", "changed", "removed"] as const;
export type ClaimedChange = (typeof CLAIMED_CHANGES)[number];

/** What an Answer's reply can say a Tool did (#1796): calculated or checked a figure, or searched. */
export const CLAIMED_TOOLS = ["calculate", "search"] as const;
export type ClaimedTool = (typeof CLAIMED_TOOLS)[number];

/** A Tool call of an Answer started, or finished (see `call.status`). */
export interface AnswerToolCallEvent extends AnswerPlace {
  answerId: string;
  call: AnswerToolCall;
}

export interface ApplyAskedChangesInput {
  answerId: string;
  mindId: string;
  requests: readonly string[];
}

export interface AskedChangeTransition {
  /** The clocks after Undo or Redo, for matching updates still arriving. */
  vector: Uint8Array;
  /** The content after Undo or Redo, which also changes when a deletion advances no clock. */
  fingerprint: string;
  /** The complete Undo or Redo as one Yjs update, for the renderer to apply before judging staleness. */
  update: Uint8Array;
}

export interface AskedChangeApplication {
  /** Identifies this application's in-session Undo in the core. */
  undoId: string;
  /** The original text with the turn's Proposals still marked, for Review. */
  reviewBefore: Uint8Array;
  /** The version after acceptance; Review is offered only while the editor is still at it. */
  afterVector: Uint8Array;
  /** The content after acceptance, including deletions that advance no clock. */
  afterFingerprint: string;
  /** The Proposal ids actually accepted; stale ones were left waiting. */
  accepted: readonly string[];
  requests: readonly string[];
  held: boolean;
}

/**
 * The model gave the record for a Citation marker in the Answer: the marker
 * becomes this Citation, "checking" until the Answer finishes.
 */
export interface AnswerCitationAdded extends AnswerPlace {
  answerId: string;
  /** The number of the marker the model wrote in the text, e.g. 1 for "[^1]". */
  marker: number;
  citation: Citation;
}

/** A Citation record the core couldn't take: its marker and the Passage it named, as given (cut to 200 characters). */
export interface RejectedRecord {
  /** Null when it wasn't a number. */
  marker: number | null;
  passage: string;
  /** "marker": invalid marker. "passage": unknown Passage. "quote-context": more than one place in its cited Units. */
  reason: "marker" | "passage" | "quote-context";
}

/** An Answer is complete ("done") or the User stopped it ("stopped"), keeping what was written. */
export interface AnswerFinished extends AnswerPlace {
  answerId: string;
  status: "done" | "stopped";
  /** The Answer's Citations, checked, in the order of their markers in the text, each once. */
  citations: Citation[];
  /** Markers the model wrote with no valid record: removed, leaving their sentences uncited. */
  droppedMarkers: number;
  /** Records with an invalid marker, unknown Passage or ambiguous quote: dropped. */
  droppedRecords: number;
  /**
   * The records among those that the core couldn't take, as the model gave
   * them, and why: for looking into how a model cites (the evaluation reports them).
   */
  rejectedRecords: RejectedRecord[];
  /**
   * How many of the Question context's Citations the model wrote as ids in text rather than
   * citing them (#1800), each made that Citation or taken out: the evaluation counts them.
   */
  idsAsText: number;
  /** Markers the model left out of its text for records it gave, which the engine put in. */
  placedMarkers: number;
  /**
   * Citations added for sentences the Answer wrote without markers, matched
   * to the Passages it read (#760), and whether the model was asked once
   * more for its Citations. The evaluation counts these.
   */
  citedAfterChecking: { count: number; asked: boolean };
  /** How the model could give Citations; null when there were no Documents to search. */
  citationSupport: CitationSupport | null;
  /**
   * The one request for exact quotes a local model in structured output gets
   * when the check doesn't find some of its quotes (ADR-0007); null when none
   * was made. The evaluation counts these.
   */
  quoteRetry: QuoteRetry | null;
  /** Its calculated figures (ADR-0021), in the order of their markers in the text, each once. */
  figures: MarkedFigure[];
  analyses: AnswerAnalysis[];
  /** Figure markers in its text that had no figure: left out, so their numbers are missing. */
  uncalculated: number;
  /**
   * The one request a local model in structured output gets to fix the
   * figures it gave that couldn't be worked out; null when none was made.
   */
  figureRetry: FigureRetry | null;
  /** The tokens its model calls counted (#343). */
  usage: AnswerUsage;
}

/**
 * The tokens an Answer's model calls used, added up. `inputTokens` counts all
 * input, the cached tokens too, so the share served from the provider's prompt
 * cache is `cachedInputTokens / inputTokens`; the estimate of cost (#83) prices
 * the cached and the written tokens at their own rates. All 0 for a provider
 * that reports no counts (a local model).
 */
export interface AnswerUsage {
  inputTokens: number;
  outputTokens: number;
  /** Of the input, the tokens read from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Of the input, the tokens written to it (Anthropic bills these above the base price). */
  cacheWriteTokens: number;
}

/** What an Answer's one request for exact quotes did (see `AnswerFinished.quoteRetry`). */
export interface QuoteRetry {
  /** The records whose quotes it asked for again. */
  records: number;
  /** Those whose new quote the check found on the pages it cites: it replaced theirs. */
  recovered: number;
  /** How long it took, in milliseconds, from the request to the records taken. */
  durationMs: number;
}

/** What an Answer's one request to fix its figures did (see `AnswerFinished.figureRetry`). */
export interface FigureRetry {
  /** The figures it asked about. */
  figures: number;
  /** Those it then worked out. */
  recovered: number;
  /** How long it took, in milliseconds. */
  durationMs: number;
}

/** An Answer failed; the Answer shows the error by kind. */
export interface AnswerFailed extends AnswerPlace {
  answerId: string;
  error: ProviderError;
}

// ---------------------------------------------------------------------------
// Conversations (CONTEXT.md, ADR-0017): the assistant's own history

/** The Mind a Question was asked from, by its name now; `deleted` once it is deleted. */
export interface AskedFrom {
  mindId: string;
  /** Its title, else its first line; "" when it has neither (the UI says "Untitled"). */
  name: string;
  /** Deleted (in Recently deleted, or for good), or not on this computer. */
  deleted: boolean;
}

/**
 * Where the User was in the Mind in focus when they asked (#544): the text
 * they selected, and the Mind's top-level Blocks it is in, by Block id, in
 * order; with nothing selected, the Block the cursor is in.
 */
export interface MindFocus {
  /** The selected text as the editor reads it; "" with nothing selected. */
  selection: string;
  blockIds: string[];
  /**
   * The pictures the User selected in the Note to ask about (#1937), by Block
   * id: only these go to the model, and only with this Question.
   */
  pictures?: string[];
}

/** The Mind an Answer in a conversation read (#544), as it was then: what the Answer is based on. */
export interface MindRead extends AskedFrom {
  /** Its version as read: a fingerprint of its text, as the model read it before any cut. */
  version: string;
  /** It was too long for the model's window, so only part of it was read. */
  partial: boolean;
}

/** A conversation, as History lists it. It exists once it has a Question; it is never a Mind. */
export interface Conversation {
  /** A random UUID generated on this device. */
  id: string;
  /** The title the User typed; "" when they haven't. A name it gives itself never replaces it. */
  title: string;
  /** Its name from what was asked: the first Question, cut (`cutTitle`). */
  autoTitle: string;
  /**
   * The Folder (an in-app one, a `LibraryGroup`) it belongs to, or null: Not in
   * a Folder. It is the Folder of the Mind its first Question was asked from.
   */
  folderId: string | null;
  /** The Minds its Questions were asked from, each once, in the order first asked from. */
  askedFrom: AskedFrom[];
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC: moves when a Question is asked, and when it is renamed, moved or restored. */
  updatedAt: string;
}

/** A Question in a conversation. */
export interface ConversationQuestion {
  kind: "question";
  id: string;
  conversationId: string;
  /** What the User asked. */
  text: string;
  /** The Mind in focus when it was asked; null: none (Home, or no Mind in focus). */
  askedFrom: AskedFrom | null;
  /** Where the User was in that Mind, which its Answer reads first; null: nowhere known. */
  focus: MindFocus | null;
  /** Its Search scope; null: none, every Document. */
  scope: SearchScope | null;
  /**
   * The Folder it was asked in, which its Folder wall is judged by now (#1934): its Note's, else
   * its Search scope's one Folder, else its conversation's; "" for none. Left out: not recorded.
   */
  folderAskedIn?: string;
  /** The model picked for it; null: the default. */
  model: ChatModelChoice | null;
  /** The Skill forced on it, by name; null: none. */
  forcedSkill: string | null;
  /** Asked with "Analyse data…" (#447): its Answer may run an Analysis whatever its Search scope holds. */
  analyse: boolean;
  /** The words the User selected in Documents to ask about, in order; empty: none. */
  quotes: AskedQuote[];
  /** ISO 8601, UTC. */
  createdAt: string;
}

/** A Citation of an Answer in a conversation: where it goes is its marker ("[^2]") in the text. */
export interface MarkedCitation extends Citation {
  marker: number;
}

/**
 * An Answer in a conversation: the Markdown the model wrote, with a Citation
 * marker ("[^2]") where each Citation goes and a figure marker ("[=1]") where
 * each calculated figure goes, and the Citations and figures by marker
 * (ADR-0017, ADR-0021). A marker with neither is left out when it is shown.
 * It is written as it streams.
 */
export interface ConversationAnswer {
  kind: "answer";
  id: string;
  conversationId: string;
  questionId: string;
  text: string;
  /** In the order of their markers in the text, each once. */
  citations: MarkedCitation[];
  /** Its calculated figures (ADR-0021), in the order of their markers ("[=1]") in the text, each once. */
  figures: MarkedFigure[];
  /** The Analyses it ran (#447), in order: a figure "From Analysis 2" names one by its number. */
  analyses: AnswerAnalysis[];
  /** The model that wrote it; null for one that says its Search scope has no Documents. */
  model: ChatModelChoice | null;
  status: AnswerStatus;
  /** Why it failed, when `status` is "failed". */
  errorKind: ProviderErrorKind | null;
  errorMessage: string | null;
  errorSignInRoute: SignInRouteProblem | null;
  citationSupport: CitationSupport | null;
  /** The Tools it called, in order: its searches, Skills and Connectors' Tools. */
  toolCalls: AnswerToolCall[];
  /**
   * Written in a Run that had read third-party text (#78): where that text
   * came from, so a later Question in the conversation counts as having read
   * it too, and so does a Mind it is added to. Null: none.
   */
  textOrigin: ThirdPartySource | null;
  /**
   * The Mind its Question was asked from, which it read (#544); null when it
   * read none: none was in focus, it had been deleted, nothing of it fitted the
   * model's window, or the Answer was written before.
   */
  read: MindRead | null;
  /** How it was reached; null for an Answer written before #391. */
  steps: AnswerSteps | null;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

/** A message of a conversation: a Question or an Answer. */
export type ConversationMessage = ConversationQuestion | ConversationAnswer;

/** A conversation and its messages, in order. */
export interface ConversationContent {
  conversation: Conversation;
  messages: ConversationMessage[];
}

/** Which conversations to list: those of one Folder (null: Not in a Folder), or all of them. */
export interface ListConversationsOptions {
  folderId?: string | null;
}

/** Asking a Question in the assistant. */
export interface AskInConversationInput {
  /** The conversation to ask in; none or null starts one, which exists once it has this Question. */
  conversationId?: string | null;
  /** What the User asked. */
  text: string;
  /**
   * The Mind in focus, which the Question records and its Answer reads; none
   * or null: none (Home). A new conversation belongs to its Folder.
   */
  mindId?: string | null;
  /** Where the User is in that Mind; ignored with no Mind. */
  focus?: MindFocus | null;
  /**
   * The Documents open on screen, by id, the focused group's first: what "this document"
   * means (#1334). Read for this Answer only, never kept with the Question; those outside
   * its Search scope are left out.
   */
  onScreen?: string[] | null;
  /**
   * Words the User selected in Documents to ask about, which the Answer cites. Each is
   * checked again where it was selected first: one not found there is neither kept nor
   * sent (`leftOut`).
   */
  quotes?: AskedQuote[] | null;
  /** Its Search scope; none or null: every Document. */
  scope?: SearchScope | null;
  /** The model to answer with; none or null: the default. */
  model?: ChatModelChoice | null;
  /** A Skill to load up front, by name. */
  forcedSkill?: string | null;
  /** "Analyse data…" was chosen (#447): its Answer may run an Analysis whatever its Search scope holds. */
  analyse?: boolean;
  /**
   * The commands of the asking window's list the assistant may run there, as ⌘K offers them now
   * (#1421). None or null, or no `clientId`: only the core's own.
   */
  commands?: OfferedCommand[] | null;
  /** The asking window, which runs those commands: its id for as long as it is open. */
  clientId?: string | null;
}

/** An Answer in a conversation, for regenerating or stopping it. */
export interface ConversationAnswerInput {
  conversationId: string;
  answerId: string;
  /**
   * Regenerating: first clears the Question's Search scope, so the Answer
   * is written from every Document ("Search all Documents", #748).
   */
  clearScope?: boolean;
  /** Regenerating: the Documents open on screen now, as `AskInConversationInput.onScreen`. */
  onScreen?: string[] | null;
  /**
   * Regenerating: write it with this model, and keep the Question on it, as when the model it was
   * asked with failed and the User chose another (#1848). Absent: the Question's own.
   */
  model?: ChatModelChoice;
  /** Regenerating: the window's commands, as `AskInConversationInput.commands`. */
  commands?: OfferedCommand[] | null;
  /** Regenerating: the asking window, as `AskInConversationInput.clientId`. */
  clientId?: string | null;
}

/** What asking in a conversation (or regenerating an Answer there) did. */
export type ConversationAskResult =
  /**
   * The Answer is being written into the conversation, right after its Question.
   * `leftOut`: the Question's quotes not sent, as their Document no longer has them where
   * they were selected, or was deleted; absent: none.
   */
  | {
      asked: true;
      conversation: Conversation;
      questionId: string;
      answerId: string;
      leftOut?: AskedQuote[];
    }
  /** Nothing was kept or sent: Questions can't be asked yet, and `readiness` says why. */
  | { asked: false; reason: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  /** Nothing was kept or sent: the Question forces a Skill (`skill`) that is off or gone. */
  | { asked: false; reason: "skill-unavailable"; skill: string; state: SkillAvailability };

/** Blocks from an Answer to put into a Mind's note ("Add to note", #201). */
export interface AddToNoteInput {
  mindId: string;
  /**
   * The Blocks, as the editor writes them in JSON: Notes only (`NOTE_BLOCK_TYPES`)
   * at the top level, with whatever they hold, Citations included. Their ids are
   * given anew.
   */
  blocks: unknown[];
  figureRuns?: RetainedFigureAnalysis[];
  /** Their link back to the Answer they came from; null for none. */
  origin: BlockOrigin | null;
  /** The model that wrote the Answer, for the record of AI use; null when unknown. */
  model: ChatModelChoice | null;
  /** They wait as changes to accept or reject, each Block one (a new Mind made from an Answer). */
  proposed?: boolean;
}

/** What "Add to note" put into a Mind: the ids of its new top-level Blocks, in order. */
export interface AddedToNote {
  mindId: string;
  blockIds: string[];
}

/** Takes an "Add to note" back: its Blocks leave the Mind, with their links back. */
export interface UndoAddToNoteInput {
  mindId: string;
  blockIds: string[];
}

/**
 * What taking an "Add to note" back kept: the Blocks whose words the User changed
 * since they went in, which Undo leaves rather than take away their edit (#1962).
 */
export interface UndoAddToNoteResult {
  kept: number;
}

/**
 * A Conversation a note's Blocks came from (#1940), kept while the note is closed: the note it
 * made, and the Conversation, whose own name is its first Question (#2310).
 */
export interface NoteConversation {
  mindId: string;
  conversationId: string;
}

/** Where words of a search are in a piece of text: `start` to `end`, in UTF-16 code units. */
export interface TextRange {
  start: number;
  end: number;
}

/** A message that matches a search: a short excerpt of it as plain text, with the words found. */
export interface MessageMatch {
  messageId: string;
  kind: ConversationMessage["kind"];
  excerpt: string;
  highlights: TextRange[];
}

/**
 * A conversation that matches a search: every word searched for is in its name
 * or its messages. `titleHighlights` marks the words in its name (its title,
 * else its `autoTitle`), and `messages` the messages that match, in order.
 */
export interface ConversationMatch {
  conversation: Conversation;
  titleHighlights: TextRange[];
  messages: MessageMatch[];
}

// ---------------------------------------------------------------------------
// The words inside Minds and Documents (⌘K, #116)

/** A Mind's first line of text that isn't its name (`CoreApi.listMindSnippets`). */
export interface MindSnippet {
  mindId: string;
  text: string;
}

/** A Mind's whole Yjs document, as stored (`CoreApi.readMindContents`), for Home's state line (D266). */
export interface MindContentSnapshot {
  mindId: string;
  state: Uint8Array;
  /** Where its table cells hold figures the one Check reads, so a reader judges them as the editor does (#1459). */
  cellFigures: CellFigurePlace[];
}

/** A figure's place in a table's cell: its paragraph's Block, and where it starts and ends there. */
export interface CellFigurePlace {
  blockId: string;
  from: number;
  to: number;
}

/**
 * A Mind whose Blocks hold every word searched for (`CoreApi.searchMinds`): its best Block, one
 * that holds them all if there is one, as a short excerpt with the words found, and the heading
 * it sits under.
 */
export interface MindTextMatch {
  mindId: string;
  blockId: string;
  /** The text of the nearest heading above the Block, "" when there is none. */
  heading: string;
  excerpt: string;
  highlights: TextRange[];
}

/**
 * A Document whose Passages hold every word searched for (`CoreApi.searchDocumentText`), at
 * least one of them in the Passage's text rather than only in the Document's name: its best
 * Passage, as a short excerpt with the words found.
 */
export interface DocumentTextMatch {
  documentId: string;
  passageId: string;
  /** The first Unit the Passage covers, from 1, as in `PassageSearchResult`; null: none. */
  pageFrom: number | null;
  pageTo: number | null;
  excerpt: string;
  highlights: TextRange[];
}

// ---------------------------------------------------------------------------
// Skills (CONTEXT.md: Skill)

/**
 * A Skill: a packaged description of how to do a particular task, in the
 * standard `SKILL.md` format (https://agentskills.io/specification), with
 * optional reference files and scripts. Its files are stored in the data
 * folder, under `skills/<id>/`. The system prompt of every Answer lists the
 * enabled Skills' names and descriptions; the model loads a Skill's full
 * instructions when it needs them, or the User forces one on a Question.
 *
 * Built-in Skills ship with the app and are installed on first run. A newer
 * version of the app updates them; whether each is on, or removed, is kept.
 */
export interface Skill {
  /** A random UUID generated on this device. Importing a Skill of the same name again keeps it. */
  id: string;
  /** From the frontmatter: lowercase letters, digits and hyphens. Unique among Skills. */
  name: string;
  /** From the frontmatter: what the Skill does and when to use it. */
  description: string;
  /** From the frontmatter, if given: a licence name, or the name of a bundled licence file. */
  license: string | null;
  /** From the frontmatter, if given: what the Skill needs, e.g. "Requires Python 3.14+". */
  compatibility: string | null;
  /** Turned on, Answers can use it. New Skills start on. */
  enabled: boolean;
  /**
   * Ships with the app. Its files can't be replaced by importing a Skill of
   * its name; `duplicateSkill` makes a copy that is the User's own.
   */
  builtIn: boolean;
  /** Every file in the Skill: SKILL.md first, then the others in path order. */
  files: SkillFile[];
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

export interface SkillFile {
  /** Relative to the Skill's folder, with "/" between folders, e.g. "references/guide.md". */
  path: string;
  /** In bytes. */
  size: number;
  /**
   * A script: in the Skill's `scripts/` folder, or a script's file type. The
   * model can read it and, unless the User turned Skill scripts off, run it
   * with `run_skill_script`, which asks the User first. Python (.py),
   * JavaScript (.js, .mjs, .cjs) and shell (.sh, .bash; not on Windows)
   * scripts run; any other kind gives an error saying so.
   */
  script: boolean;
}

/** Whether a Skill can be used: on, turned off, or not there (removed, or never imported). */
export type SkillAvailability = "enabled" | "disabled" | "removed";

/** What importing a Skill would add, for the User to check before importing it. */
export interface SkillImportPreview {
  /** Pass to `importSkill` to import exactly this, or to `cancelSkillImport`. */
  importId: string;
  /** The folder or zip it was read from. */
  source: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  /** SKILL.md first, then the others in path order. */
  files: SkillFile[];
  /** The files' sizes added up, in bytes. */
  totalBytes: number;
  /** The Skill of the same name that importing replaces (keeping its id and whether it's on), or null. */
  replaces: Skill | null;
}

/**
 * Why a folder or zip can't be imported as a Skill.
 * - "unreadable": it (or a file in it, see `path`) can't be read.
 * - "not-a-skill": there is no SKILL.md at its top, nor in its one top-level folder.
 * - "invalid-zip": not a zip file, or one IncarnaMind can't read (encrypted, ZIP64, damaged).
 * - "invalid-frontmatter": SKILL.md's frontmatter is missing or breaks the format (see `field`).
 * - "path-traversal": a zip entry's path leads outside the Skill (see `path`).
 * - "link-outside": a symbolic link points outside the Skill (see `path`).
 * - "too-large": its files add up to more than `SKILL_LIMITS.maxBytes`, or SKILL.md
 *   is over `SKILL_LIMITS.maxInstructionsBytes`.
 * - "too-many-files": more than `SKILL_LIMITS.maxFiles` files.
 * - "built-in-name": a built-in Skill has its name, and a built-in Skill's files
 *   can't be replaced (`field` is "name").
 */
export type SkillImportErrorKind =
  | "unreadable"
  | "not-a-skill"
  | "invalid-zip"
  | "invalid-frontmatter"
  | "path-traversal"
  | "link-outside"
  | "too-large"
  | "too-many-files"
  | "built-in-name";

export interface SkillImportError {
  kind: SkillImportErrorKind;
  /** The file at fault, relative to the Skill (or as named in the zip), when there is one. */
  path: string | null;
  /** "invalid-frontmatter": the field at fault, e.g. "name", when there is one. */
  field: string | null;
  /** Technical detail in English, for logs and tooltips. */
  message: string;
}

export type SkillImportCheck =
  | { ok: true; preview: SkillImportPreview }
  | { ok: false; error: SkillImportError };

/** What a Skill says in words: its name, when to use it, and its steps (SKILL.md's instructions). */
export interface SkillDraft {
  /** As typed: it is written in the format's characters (lowercase letters, digits, hyphens) when saved. */
  name: string;
  /** When to use the Skill: what Answers read to choose it. At most 1,024 characters. */
  description: string;
  /** What to do, in Markdown, as typed. */
  steps: string;
}

/**
 * Why a Skill wasn't saved, for the field to say.
 * - "invalid-name": nothing of the name is left in the format's characters.
 * - "name-taken": another Skill, built-in or the User's, has that name.
 * - "no-description" and "description-too-long": when to use it is empty, or over 1,024 characters.
 * - "no-steps": there are no steps.
 * - "too-large": the steps are over `SKILL_LIMITS.maxInstructionsBytes`.
 */
export type SkillSaveProblem =
  | "invalid-name"
  | "name-taken"
  | "no-description"
  | "description-too-long"
  | "no-steps"
  | "too-large";

export type SkillSaveResult = { ok: true; skill: Skill } | { ok: false; problem: SkillSaveProblem };

export interface DraftSkillInput {
  /** Chosen by the caller, so it can stop the request (`cancelSkillDraft`). */
  requestId: string;
  /** The Mind the User just worked in. Its own chat model drafts the Skill, else the default. */
  mindId: string;
}

/** What drafting a Skill from a Mind did. */
export type DraftSkillResult =
  /** The model's draft, for the User to edit before it is saved. */
  | { kind: "drafted"; draft: SkillDraft }
  /** Nothing was sent: the Mind has no Notes, Questions or Answers to learn from. */
  | { kind: "empty" }
  /** Nothing was sent: the model can't be used now (local mode included), and `readiness` says why. */
  | { kind: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  /** The User stopped it (`cancelSkillDraft`), or declined to send the Mind's text. */
  | { kind: "cancelled" }
  /** The model failed, or gave a draft that couldn't be read. */
  | { kind: "failed"; error: ProviderError };

/** How Skill scripts run. */
export const SKILL_SCRIPT_LIMITS = {
  /** How long a script may run when the User hasn't chosen (`DeviceSettings.skillScriptTimeoutSeconds`). */
  defaultTimeoutSeconds: 60,
  minTimeoutSeconds: 1,
  maxTimeoutSeconds: 3600,
  /** Of each of the standard output and the error output: what the model and the card get. */
  maxOutputBytes: 20_000,
  /** Arguments one run may have, and characters in all of them together. */
  maxArgs: 100,
  maxArgsChars: 20_000,
} as const;

/** How big a Skill may be. Checked before anything is imported. */
export const SKILL_LIMITS = {
  /** All its files together, uncompressed; a zip file itself may be no larger either. */
  maxBytes: 20 * 1024 * 1024,
  maxFiles: 1000,
  /** SKILL.md alone: its instructions are sent whole to the model. */
  maxInstructionsBytes: 256 * 1024,
} as const;

// ---------------------------------------------------------------------------
// ChatGPT plan

/** A model the User's ChatGPT plan can be used with. */
export interface ChatGptPlanModel {
  id: string;
  /** What the User sees, e.g. "GPT-6.1 Sol". */
  name: string;
}

/** The ChatGPT sign-in on this device. */
export type ChatGptAccount =
  | { state: "signed-out" }
  /** Refreshing the sign-in failed (or the User disconnected IncarnaMind in ChatGPT): sign in again. */
  | { state: "expired" }
  /** A sign-in is kept here, but it can't be read: signing in again replaces it once it completes. */
  | { state: "unreadable" }
  | {
      state: "signed-in";
      /** From the sign-in's ID token, when it carries one. */
      email: string | null;
    };

/**
 * The ChatGPT plan provider, "Continue with ChatGPT": Sign in with ChatGPT,
 * OpenAI's way for an open-source app on the User's computer to use their
 * Plus or Pro plan instead of an API key. What it sends goes to OpenAI under
 * the User's ChatGPT account and counts against the plan's limits.
 */
export interface ChatGptPlanStatus {
  account: ChatGptAccount;
  signingIn: boolean;
  /**
   * The models Questions can use with the plan, the default first: the
   * account's own list once signed in, else the ones OpenAI usually offers.
   */
  models: ChatGptPlanModel[];
  limits: ChatGptPlanLimits;
}

/**
 * What this session knows of the plan's usage limits, kept in memory
 * only: the models whose limit is used up, and the model Questions go to
 * meanwhile, which only the User's click on "Answer with …" sets.
 */
export interface ChatGptPlanLimits {
  /** `resetsAt` (ISO 8601) when the plan said; null: it lasts until the model answers again. */
  usedUp: { modelId: string; resetsAt: string | null }[];
  /**
   * Questions for `insteadOf` are answered by `modelId` until `insteadOf`'s
   * limit resets (`until`, ISO 8601). With no reset time (`until` null),
   * `insteadOf` is tried again once an hour, and answers again once it can.
   */
  standIn: { insteadOf: string; modelId: string; until: string | null } | null;
}

/** "Answer with {model}" on an Answer stopped by the plan's limit: `insteadOf` is the model that stopped it. */
export interface AnswerWithPlanModelInput {
  insteadOf: string;
  modelId: string;
}

export type ChatGptSignInErrorKind =
  /** The User didn't finish in the browser within a few minutes. */
  | "timed-out"
  /** The User cancelled in IncarnaMind. */
  | "cancelled"
  /** OpenAI refused the sign-in, e.g. the User declined in the browser. */
  | "denied"
  /** This device can't store the sign-in securely (see `getSecretStorage`). */
  | "secret-storage"
  /** The User signed in but didn't allow IncarnaMind to use their plan; signing in again asks again. */
  | "plan-not-allowed"
  /** The User signed in to another ChatGPT account than the one this device uses; `anotherAccount` switches. */
  | "other-account"
  /** A sign-in is kept here but can't be read; signing in again replaces it once it completes. */
  | "record-unreadable"
  /** The file that keeps sign-ins can't be read at all; signing in again can't fix it. */
  | "store-unreadable"
  | "failed";

export type ChatGptSignInResult =
  | {
      ok: true;
      /** The first sign-in on this device: the UI says once that Questions now use the plan. */
      firstTime: boolean;
      status: ChatGptPlanStatus;
    }
  | { ok: false; error: { kind: ChatGptSignInErrorKind; message: string } };

export interface ChatGptSignOutResult {
  /**
   * Whether OpenAI confirmed the session ended. When it couldn't be reached,
   * the tokens are gone from this device anyway, and the User can disconnect
   * IncarnaMind in ChatGPT's settings.
   */
  revoked: boolean;
  status: ChatGptPlanStatus;
}

/** Why an address pasted into a waiting sign-in (ChatGPT, Claude) wasn't taken. */
export type PastedAddressProblem =
  /** It isn't the address the sign-in sends the browser back to, with a code and a state. */
  | "not-sign-in-address"
  /** It is, but for another sign-in, e.g. from an older tab. */
  | "other-sign-in"
  /** The sign-in already finished, or none is waiting. */
  | "finished";

export type PastedAddressResult = { ok: true } | { ok: false; problem: PastedAddressProblem };

// ---------------------------------------------------------------------------
// Claude account

/** Each said where it happened, with a way back (./providers/signInRoutes.ts). */
export type SignInRouteProblem =
  /** The User cancelled the sign-in, or didn't finish it in time: nothing was kept. */
  | "sign-in-cancelled"
  | "signed-out"
  /** The sign-in can't be renewed any more: sign in again. */
  | "sign-in-expired"
  /** The provider refused the sign-in, or a request made with it. */
  | "refused"
  /** The plan's usage limit is reached, until `ProviderError.resetsAt` when the provider says. */
  | "plan-limit"
  /** The provider answered in a way this route doesn't know. */
  | "unexpected-response"
  /** The account has no plan this route can use. */
  | "no-plan"
  /** The account's organization doesn't allow it. */
  | "policy-blocked"
  /** The plan doesn't offer the model to IncarnaMind. */
  | "model-unavailable"
  /** The provider asked to slow down for a while, short of the plan's limit. */
  | "rate-limited";

export type ClaudeAccount =
  | { state: "signed-out" }
  /** Refreshing the sign-in failed: sign in again. */
  | { state: "expired" }
  /** The account and organization as Anthropic named them at sign-in, when it did. */
  | { state: "signed-in"; email: string | null; organization: string | null };

/** The User's Claude plan for Answers instead of an API key; not offered where this build has no profile for it. */
export interface ClaudeAccountStatus {
  available: boolean;
  /** An experimental sign-in route, which the User is told about before signing in. */
  experimental: boolean;
  account: ClaudeAccount;
  /** A browser sign-in is waiting for the User. */
  signingIn: boolean;
}

export type ClaudeSignInErrorKind =
  | Extract<SignInRouteProblem, "sign-in-cancelled" | "refused" | "unexpected-response">
  /** This build has no client profile for the route. */
  | "unavailable"
  /** This device can't store the sign-in securely (see `getSecretStorage`). */
  | "secret-storage"
  /** The sign-in didn't work, e.g. a code pasted incompletely: sign in again. */
  | "failed";

export type ClaudeSignInResult =
  | { ok: true; status: ClaudeAccountStatus }
  | { ok: false; error: { kind: ClaudeSignInErrorKind; message: string } };

// ---------------------------------------------------------------------------
// GitHub Copilot

export const copilotProfileIds = ["own", "editor"] as const;

export type CopilotProfileId = (typeof copilotProfileIds)[number];

export interface CopilotModel {
  id: string;
  /** What the User sees, e.g. "GPT-5.5". */
  name: string;
}

export type CopilotPlan = "free" | "pro" | "pro-plus" | "business" | "enterprise";

/** The User's Copilot plan for Answers instead of an API key; it counts toward the plan's limits. */
export interface CopilotStatus {
  account:
    | { state: "signed-out" }
    /** Renewing the sign-in failed, or GitHub refused its token: sign in again. */
    | { state: "expired" }
    /** The GitHub login and the plan, as GitHub named them at sign-in, when it did. */
    | {
        state: "signed-in";
        profile: CopilotProfileId;
        login: string | null;
        plan: CopilotPlan | null;
      };
  /** A sign-in is waiting for the User on GitHub's page. */
  signingIn: boolean;
  /** While a sign-in waits, once GitHub has given it: the code the User types, and where. */
  deviceCode: { userCode: string; verificationUri: string; expiresIn: number } | null;
  /** The ways to sign in, the default first; an experimental one is said so before sign-in. */
  profiles: { id: CopilotProfileId; experimental: boolean }[];
  /** The models the plan offers for the token, once signed in. */
  models: CopilotModel[];
}

export type CopilotSignInErrorKind =
  | Extract<
      SignInRouteProblem,
      "sign-in-cancelled" | "refused" | "no-plan" | "policy-blocked" | "unexpected-response"
    >
  /** The code on GitHub's page expired before the User approved it. */
  | "code-expired"
  /** The User declined on GitHub's page. */
  | "declined"
  | "unreachable"
  /** GitHub answered with a server error. */
  | "service-error"
  /** This build doesn't offer that way to sign in. */
  | "unavailable"
  /** This device can't store the sign-in securely (see `getSecretStorage`). */
  | "secret-storage"
  | "failed";

export type CopilotSignInResult =
  | { ok: true; status: CopilotStatus }
  | { ok: false; error: { kind: CopilotSignInErrorKind; message: string } };

// ---------------------------------------------------------------------------
// Secrets

/**
 * How API keys are protected on this device.
 * - "os": encrypted with a key held by the OS secret store.
 * - "plain-text": Linux with no keyring running (safeStorage's "basic_text"
 *   backend). Keys would be stored effectively in plain text.
 * - "unavailable": keys can't be encrypted at all.
 */
export type SecretProtection = "os" | "plain-text" | "unavailable";

export interface SecretStorageStatus {
  protection: SecretProtection;
  /** The User accepted storing keys without keyring protection on this device. */
  plainTextAccepted: boolean;
  /** Whether keys can be saved now. */
  canSave: boolean;
}

// ---------------------------------------------------------------------------
// Ollama

export type OllamaStatus =
  | {
      running: false;
      /**
       * Nothing can be said: the probe didn't answer within its time. It may well run, slowly;
       * only a refused address means it doesn't.
       */
      unknown?: true;
      baseUrl: string;
      /** Whether `openOllama` can open its app: false too where this computer can't tell. */
      installed: boolean;
      recommendedModel: string;
    }
  | {
      running: true;
      baseUrl: string;
      /** Models already pulled that run on this computer, e.g. "qwen3:4b". */
      models: string[];
      /** Cloud models Ollama lists (e.g. "gpt-oss:120b-cloud"): they run on ollama.com, so they are never offered as local. */
      cloudModels: string[];
      /** The model one click pulls and selects. */
      recommendedModel: string;
    };

/** What runs at a local preset's address: `address` is its host and port, `models` the language models it lists. */
export type LocalServerStatus =
  | { running: false; address: string }
  | { running: true; address: string; models: string[] };

export interface DetectLocalServerInput {
  catalogId: string;
  apiKey?: string;
  /** A host and port; the preset's default when left out. */
  address?: string;
}

export interface SelectOllamaInput {
  /** Defaults to Ollama's local port. */
  baseUrl?: string;
  /** Defaults to the recommended model. */
  model?: string;
  /**
   * "Also keep everything on this computer": Local mode is turned on or off
   * to match. Left out, Local mode stays as it was.
   */
  localOnly?: boolean;
  /** As `SaveChatProviderInput.keepDefault`. */
  keepDefault?: boolean;
}

export interface OllamaPullProgress {
  model: string;
  /** Ollama's status line, e.g. "pulling manifest" or "success". */
  status: string;
  /** Bytes of the current layer, when Ollama reports them. */
  completed: number | null;
  total: number | null;
}

// ---------------------------------------------------------------------------
// Data-flow consent

/**
 * Kinds of data a flow can send. The UI describes each one
 * (`consent.data.<kind>`). Later tickets add theirs.
 */
export const dataKinds = [
  "blocks",
  "passages",
  "tool-results",
  "tags",
  "groups",
  "document-excerpts",
  "page-images",
  "tool-arguments",
  "document-text",
  "queries",
  "writing",
  "writing-passages",
  "identifiers",
  "search-terms",
  "work-ids",
  "provider-key",
  "selection",
  "scoped-passages",
  "scoped-minds",
  "answers",
  "web-searches",
  "verified-document",
  "whole-document",
  "references",
  "connector-search",
  "meeting-audio",
  "document-names",
  "other-minds",
  "live-transcript",
  "pictures",
] as const;

export type DataKind = (typeof dataKinds)[number];

/**
 * External data flows. The UI names each one (`consent.flow.<id>`). Later tickets add theirs.
 * - "chat": Questions, to the chat provider they are asked with.
 * - "tagging": automatic tagging, to Jev's service when a Jev key is set up,
 *   otherwise to the default chat model's provider.
 * - "connectors": the arguments of the Tool calls an Answer makes, to the
 *   Connector it calls: one service per local Connector (it runs on this
 *   computer but can reach the internet itself), and one per server origin
 *   for remote ones, e.g. "https://mcp.example.com".
 * - "embeddings": every Document's text and every search query, to a cloud
 *   embedding provider, when the User chose one instead of the built-in model.
 * - "rerank": each search query and its candidate Passages, to Cohere or
 *   Voyage, when a rerank key is set up. The built-in reranking model sends
 *   nothing: with it, the flow has no service.
 * - "suggestions": while the User has suggestions on, the paragraph they are
 *   writing and up to 8 Passages that match it, to the default chat model's
 *   provider, at a pause at the paragraph's end (#282).
 * - "reference-lookup": a Document's DOI to Crossref, or its arXiv id to
 *   arXiv, when the User asks Look up to fill its reference record (#286).
 *   Nothing else: no file, text or name. None in local mode.
 * - "reference-check": each entry of a Mind's reference list, as written,
 *   to Crossref, then to OpenAlex when Crossref has no record of it or one
 *   that differs, and an arXiv number to arXiv, when the User checks the
 *   list's references. Nothing else of the Mind. None in local mode.
 * - "find-sources": what the User (or an Answer, for them) searches for, with
 *   its filters, to each Source provider searched, and the identifier of a
 *   work they add, to the provider that gives its full text or record (#296).
 *   Nothing from their Documents or Minds. Asked once per provider; none in
 *   local mode.
 * - "edits": when the User asks Edit with AI (#93), the text they selected
 *   and the paragraphs it is in, to the chat model's provider. None in local mode.
 * - "checks": when the User asks Check against Documents (#96), each sentence
 *   they selected, with its paragraph and what it cites, and the Passages the
 *   check's searches find, to the chat model's provider;
 *   when they verify a document (#97), its sentences, to find its claims, then
 *   each claim with its paragraph and the Passages found. None in local mode.
 * - "agents": what an outside agent reads (#351), to that agent, which sends
 *   it on to the AI model it uses, out of IncarnaMind's sight: one service
 *   per pairing ("agent:<id>"), named as the User named the agent. Passages
 *   of the Documents in its Folders, those Folders' Minds, and the Answers it
 *   asks for. None in local mode.
 * - "web-search": what an Answer searches the web for, written by the model
 *   from the Question, to the provider of the model it is asked with, whose
 *   own web search runs it (#128). None in local mode.
 * - "connector-registry": the words the User types in Settings › Connectors'
 *   search, to the official MCP Registry, which finds community Connectors
 *   (#148). Asked the first time they search; none in local mode.
 * - "transcription": a Meeting's audio while it records, other people's
 *   voices included, to the cloud transcription service the User chose in
 *   Settings › Meetings or on the first-meeting sheet (#141). Choosing it
 *   allows it; none in local mode.
 * - "scan-images": when Organize or the Library's automatic grouping meets a
 *   PDF with no text after reading and OCR (a scan), up to 3 of its page
 *   images, to the service of the model that reads them (the chosen model's,
 *   else the image model's). Not allowed by choosing the provider (#1613):
 *   the User allows it here, in Settings › Privacy, and without it the scan
 *   stays unsorted. A model on this computer needs no consent.
 * - "document-check": when the User asks Check against a Document… (#1554),
 *   the sentence with its paragraph and the whole text of the Document or
 *   Folder they pick, to the chat model's provider. Asked where it is used;
 *   none in local mode.
 */
export const dataFlowIds = [
  "chat",
  "tagging",
  "classification",
  "connectors",
  "embeddings",
  "rerank",
  "suggestions",
  "reference-lookup",
  "reference-check",
  "find-sources",
  "edits",
  "checks",
  "agents",
  "web-search",
  "connector-registry",
  "transcription",
  "scan-images",
  "document-check",
] as const;

export type DataFlowId = (typeof dataFlowIds)[number];

/**
 * The flows choosing the chat model's provider allows (ADR-0022): what runs
 * by itself, as the line above "Use this provider" says. That line is made from
 * this list, so a flow added here needs its words (`chosenFlowLines`). Tagging and
 * sorting Documents aren't in it: the User turns them on (Settings › Tagging) or
 * asks for them, and that is their consent (#1617).
 */
export const CHOSEN_PROVIDER_FLOWS = [
  "chat",
  "checks",
  "suggestions",
  "edits",
] as const satisfies readonly DataFlowId[];

export type ChosenProviderFlow = (typeof CHOSEN_PROVIDER_FLOWS)[number];

/** Data leaving this computer: what one flow sends to one service. */
export interface DataFlow {
  id: DataFlowId;
  service: ExternalService;
  /** Everything the flow sends to the service. */
  sends: DataKind[];
}

/** The core is waiting for the User to accept or decline a data flow. Nothing is sent until they do. */
export interface ConsentRequest {
  requestId: string;
  flow: DataFlow;
  /** What the User hasn't accepted yet: everything the first time, only the new kinds when a flow starts sending more. */
  newKinds: DataKind[];
}

export interface DataFlowStatus {
  flow: DataFlow;
  /** "not-asked" also covers a flow that started sending a new kind of data since the User accepted it. */
  consent: "accepted" | "declined" | "not-asked";
  /**
   * When the User decided, ISO 8601, UTC. Null when never asked; set with
   * "not-asked" when they allowed the flow before it started sending more.
   */
  decidedAt: string | null;
  /**
   * Allowed when the User chose the service, where a line said what goes to
   * it (ADR-0022), rather than in a dialog or in Settings › Privacy.
   */
  chosen: boolean;
}

/** A registered external data flow, for the Privacy page: what it sends, and where. */
export interface RegisteredDataFlow {
  id: DataFlowId;
  /** Everything the flow sends. */
  sends: DataKind[];
  /**
   * The flow to each service it currently goes to and each service the User
   * has decided on, with that decision. Empty when nothing is sent on it now,
   * e.g. chat with a model on this computer.
   */
  services: DataFlowStatus[];
}

// ---------------------------------------------------------------------------
// Page setup
// ---------------------------------------------------------------------------

/** How a page number is written: Word's `decimal`, `lowerRoman`, `upperRoman`, `lowerLetter` and `upperLetter`. */
export type PageNumberFormat =
  | "decimal"
  | "lowerRoman"
  | "upperRoman"
  | "lowerLetter"
  | "upperLetter";

/** One run in a header or footer: text, a tab to a position the page sets, or a field that the page it is drawn on fills in. */
export type PageFurnitureRun =
  | { kind: "text"; text: string; bold?: true; italic?: true }
  | {
      kind: "field";
      /** The page's number, the pages in the document, or the pages in the section. */
      field: "PAGE" | "NUMPAGES" | "SECTIONPAGES";
      /** The field's own `\* roman`-style switch; null: the section's number format. */
      format: PageNumberFormat | null;
      bold?: true;
      italic?: true;
    }
  /** Word's absolute position tab (`w:ptab`): the text after it starts at the margin's left, centre or right. */
  | {
      kind: "alignedTab";
      align: "left" | "center" | "right";
      relativeTo: "margin" | "indent";
    };

/** A tab stop of a paragraph, from its style and itself as Word resolves them: `position` is from the text area's left edge, in twips. */
export interface PageTabStop {
  position: number;
  align: "left" | "center" | "right" | "decimal" | "bar";
  leader?: "dot" | "hyphen" | "underscore" | "heavy" | "middleDot";
}

export interface PageFurnitureParagraph {
  /** From the paragraph or its style, as Word resolves it. */
  align: "left" | "center" | "right" | "justify";
  runs: PageFurnitureRun[];
  /** Where the tabs ("\t") in the runs stop. Absent: none are set, so Word's default stops. */
  tabStops?: PageTabStop[];
  /** It is in a text box anchored in the paragraph before it, as a page number often is. */
  inTextBox?: true;
  /** It is a frame (`w:framePr`), which Word places beside the text, such as a page number at the margin: where is not read yet. */
  framed?: true;
}

/** A header or a footer: its paragraphs, tables flattened to their paragraphs, a text box's after the one it is anchored in. */
export interface PageFurniture {
  paragraphs: PageFurnitureParagraph[];
  /** How many pictures and shapes it holds that are not read yet (a logo): none is drawn. Absent: none. */
  pictures?: number;
}

/** A header or footer for each kind of page: most pages, the first, and the even ones. */
export interface PageFurnitureSet {
  default: PageFurniture | null;
  /** Used where the section has a different first page. */
  first: PageFurniture | null;
  /** Used where the document has different odd and even pages. */
  even: PageFurniture | null;
}

/** One section of a document's pages. Lengths are in twips (twentieths of a point, 1,440 to the inch). */
export interface PageSection {
  /**
   * The place ("w:sectPr#3") of the section break atom that ends it in the Mind,
   * as `WordAtomAttributes.source` has it; null for the last section, which ends with the document.
   */
  breakPlace: string | null;
  /** Where its first page starts: on a new page, on the same page, or on the next odd or even one. */
  start: "nextPage" | "continuous" | "evenPage" | "oddPage";
  width: number;
  height: number;
  /** From the box: landscape where it is wider than tall, as Word draws it, whatever `w:orient` says. */
  orientation: "portrait" | "landscape";
  margins: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    gutter: number;
    /** From the page's top edge to its header, and from its bottom edge to its footer. */
    header: number;
    footer: number;
  };
  /** The first page has its own header and footer. */
  differentFirstPage: boolean;
  pageNumbers: {
    /** The number the section's first page takes; null: it carries on from the section before. */
    start: number | null;
    format: PageNumberFormat;
  };
  /** As this section has them: a header or footer the file doesn't give it is the section before's. */
  headers: PageFurnitureSet;
  footers: PageFurnitureSet;
}

/**
 * How a Mind's pages are set up, for Page view: what the Word file it was imported
 * from says, or, for a Mind that wasn't, the size and margins of the native export. Pages are
 * layout only: none of this is in the Mind's content, its sync or its Questions.
 */
export interface PageSetup {
  source: "word" | "native";
  /** Odd and even pages have different headers and footers. */
  oddAndEven: boolean;
  sections: PageSection[];
}

// ---------------------------------------------------------------------------
// Privacy

/**
 * Network traffic that carries no User content: it needs no consent, and the
 * Privacy page lists it. The UI names and describes each one
 * (`privacy.traffic.<id>`). Features register theirs; later tickets add ids.
 * - "update-check": asks GitHub Releases for a newer version, when IncarnaMind starts.
 * - "embedding-model": downloads the built-in embedding model's files, once.
 * - "reranking-model": downloads the built-in reranking model's files, once,
 *   when the first Documents are ready to search, unless reranking is off or
 *   uses a service.
 * - "text-recognition-model": downloads the built-in text recognition
 *   model's files (#397), once, when the first scanned page needs reading.
 * - "transcription-model": downloads the speech-to-text model and Silero VAD,
 *   once, when a Meeting is first transcribed on this computer (#136), and the
 *   two models that tell its speakers apart (#138), when one is first recorded.
 * - "model-source-modelscope", "model-source-hf-mirror", "model-source-copy": where else a
 *   built-in model's files may come from when Hugging Face doesn't give them (#1578):
 *   IncarnaMind's copy on ModelScope (whose front page the probe asks whenever a model
 *   downloads), hf-mirror.com, and IncarnaMind's own copy on Cloudflare R2, once it exists.
 * - "ollama-pull": Ollama downloads a model from its registry, when the User picks local models.
 * - "chatgpt-sign-in": Sign in with ChatGPT, refreshing it, signing out, and
 *   reading OpenAI's signing keys; listed once the User has signed in.
 * - "claude-sign-in": signing in with a Claude account and refreshing it;
 *   listed once the User has started signing in.
 * - "copilot-sign-in": signing in with GitHub for Copilot, renewing it, and
 *   reading the account's name and the plan's models; listed once the User
 *   has started signing in.
 * - "remote-connectors": connecting to each remote Connector that is on, and
 *   signing in to it: its server, and the authorization server it names
 *   (discovery, registration, tokens). One entry per server. Tool calls, which
 *   carry the User's content, are the "connectors" data flow.
 * - "usage-data": anonymous product events (src/core/usageEvents.ts), only
 *   while the User agrees, and only from a copy built with an analytics
 *   project (see `PrivacySettings.usageData`).
 */
export const networkTrafficIds = [
  "update-check",
  "embedding-model",
  "reranking-model",
  "text-recognition-model",
  "transcription-model",
  "model-source-modelscope",
  "model-source-hf-mirror",
  "model-source-copy",
  "ollama-pull",
  "chatgpt-sign-in",
  "claude-sign-in",
  "copilot-sign-in",
  "remote-connectors",
  "usage-data",
] as const;

export type NetworkTrafficId = (typeof networkTrafficIds)[number];

export interface NetworkTraffic {
  id: NetworkTrafficId;
  /** Where it goes. */
  service: ExternalService;
  /** False while the User has turned it off, e.g. automatic update checks. */
  enabled: boolean;
}

/**
 * Usage data (#187): anonymous product events, such as "a Question was asked
 * with a local model", never the User's files, Questions or Answers. Every
 * event and field is listed in src/core/usageEvents.ts.
 */
export interface UsageDataSettings {
  /**
   * Whether this copy of IncarnaMind can send usage data: only a build made
   * with an analytics project can. Without one, nothing is sent or asked.
   */
  available: boolean;
  /** Usage data is being sent now. */
  enabled: boolean;
  /**
   * A test build (for invited testers): usage data is on until the User turns it off,
   * and the first run says so. Otherwise it is off until the User agrees.
   */
  testerBuild: boolean;
  /**
   * The User has answered the first run's question about usage data (in a
   * test build, closed its notice), or chosen on the Privacy page.
   */
  asked: boolean;
  /** Local mode ("Keep everything on this computer") is on, which keeps usage data off. */
  localMode: boolean;
}

/** The privacy choices on this device. */
export interface PrivacySettings {
  crashReports: {
    /**
     * Whether this copy of IncarnaMind can send crash reports: only a build
     * made with a crash-report address (a Sentry DSN) can. Without one, they
     * aren't offered.
     */
    available: boolean;
    /** The User opted in to sending scrubbed crash reports. Off by default. */
    enabled: boolean;
  };
  /** IncarnaMind checks GitHub Releases for a new version when it starts. On by default. */
  automaticUpdateChecks: boolean;
  usageData: UsageDataSettings;
}

/** The choices to change; the others are kept. */
export interface PrivacySettingsPatch {
  crashReports?: boolean;
  automaticUpdateChecks?: boolean;
  /**
   * Sends usage data, or stops at once, dropping what is queued. Either
   * answers the first run's question. Refused if this copy can't send usage
   * data, and turning it on while local mode is on.
   */
  usageData?: boolean;
}

// ---------------------------------------------------------------------------
// The record of AI use (#292)

/**
 * What the AI put into a Mind, or proposed and the User turned down. A new kind
 * is a change here, in `src/core/aiUse.ts` and in docs/privacy.md.
 */
export const aiUseKinds = [
  /** An Answer added to a note ("Add to note", #201). */
  "answer-added",
  /** A writing suggestion accepted as the User writes (#282). */
  "suggestion-accepted",
  /** One Block of a change the assistant proposed, accepted (#202). */
  "assistant-change-accepted",
  /** One Block of a change the assistant proposed, rejected (#202). Nothing was inserted. */
  "assistant-change-rejected",
  /** A change from Edit with AI accepted (#93). */
  "edit-with-ai-accepted",
  /** A comparison table from Compare Documents accepted (#98). */
  "comparison-table-accepted",
  /** A change an outside agent proposed, accepted (#352): recorded with the agent's name. */
  "outside-agent-change-accepted",
  /** A sentence of the Mind's checked against the Documents (#906). */
  "sentence-checked",
] as const;
export type AiUseKind = (typeof aiUseKinds)[number];

/**
 * What became of an insertion, as far as the record can tell. `kept`: its Blocks
 * are in the Mind as inserted; `edited`: the User changed their text, or some
 * but not all are gone; `deleted`: all are gone; `rejected`: proposed, never inserted.
 */
export const aiUseOutcomes = ["kept", "edited", "deleted", "rejected"] as const;
export type AiUseOutcome = (typeof aiUseOutcomes)[number];

/**
 * One AI insertion. It holds no text: the record is about how the AI was
 * used, and stays on this computer whatever the usage-data setting (ADR-0014).
 */
export interface AiUseEntry {
  id: string;
  mindId: string;
  kind: AiUseKind;
  outcome: AiUseOutcome;
  /** The model that wrote it; null when it isn't known. */
  providerId: string | null;
  modelId: string | null;
  /** The outside agent that wrote it, by its name then (#352); null for IncarnaMind's own AI. */
  agent: string | null;
  /** How much the AI wrote, in characters. */
  characters: number;
  /** The Blocks it made, by their stable ids; none for a rejected proposal, a suggestion or a check. */
  blockIds: string[];
  /** When the User accepted or rejected it, ISO 8601 UTC. */
  occurredAt: string;
}

export interface RecordAiUseInput {
  mindId: string;
  kind: AiUseKind;
  providerId?: string | null;
  modelId?: string | null;
  /** The outside agent that wrote it (`AiUseEntry.agent`). */
  agent?: string | null;
  characters: number;
  /**
   * The Blocks the insertion made, already in the Mind (send the Mind's update
   * first). Their later edits and deletions update the entry's outcome.
   */
  blockIds?: string[];
  /** Defaults to now. */
  occurredAt?: string;
}

export interface AiUseStatus {
  /** How many entries the record holds. */
  entries: number;
}

/** What `clearAiUse` removed; `restoreAiUse` takes it back. */
export interface AiUseCleared {
  clearedAt: string;
  count: number;
}

// ---------------------------------------------------------------------------
// TypeSafe Jev, the optional tagger (ADR-0005)

/** The model Jev requests name unless the User changes it: TypeSafe's latest stable Jev. */
export const JEV_DEFAULT_MODEL = "jev-latest";

/**
 * Where Jev's probability that a Tag applies counts as unsure. Below `low` the
 * Tag isn't applied; from `low` up to (not including) `high` it is applied and
 * marked "needs review"; from `high` it is applied. 0 < low ≤ high ≤ 1.
 */
export interface JevReviewBand {
  low: number;
  high: number;
}

export const JEV_DEFAULT_REVIEW_BAND: Readonly<JevReviewBand> = { low: 0.35, high: 0.65 };

/**
 * TypeSafe Jev on this device: a hosted classifier that decides each Tag with
 * a probability, faster and cheaper than a chat model. Optional: without it,
 * the chat model tags Documents. Its settings and key stay on this device.
 */
export interface JevSettings {
  /** Jev is set up on this device: automatic tagging uses it instead of the chat model. */
  enabled: boolean;
  /**
   * Whether its key can be read on this device. Keys live in the keychain,
   * never in the database. Enabled without a key, Documents wait for one.
   */
  hasApiKey: boolean;
  /** A Jev-compatible server's base URL, or null for TypeSafe's hosted Jev. */
  endpoint: string | null;
  /** The model each request names, e.g. "jev-latest". */
  model: string;
  reviewBand: JevReviewBand;
  /** Where tagging requests go, or null when the server runs on this computer. */
  service: ExternalService | null;
}

export interface SaveJevSettingsInput {
  /** A new key. Leave it out to keep the stored one; the first save needs one. */
  apiKey?: string;
  /**
   * A Jev-compatible server's base URL, e.g. "https://jev.example.com"
   * (requests go to its `/v1/systemone`). Null or empty: TypeSafe's hosted
   * Jev. Left out: unchanged.
   */
  endpoint?: string | null;
  /** Null or empty: "jev-latest". Left out: unchanged. */
  model?: string | null;
  /** Left out: unchanged (at first, `JEV_DEFAULT_REVIEW_BAND`). */
  reviewBand?: JevReviewBand;
}

/** Settings to test, which need not be saved; those left out are the saved ones. */
export interface TestJevConnectionInput {
  apiKey?: string;
  endpoint?: string | null;
  model?: string | null;
}

// ---------------------------------------------------------------------------
// Connectors (MCP servers)

/**
 * Where a Connector is:
 * - "off": the User turned it off, so its process isn't running (or, for a
 *   remote one, IncarnaMind isn't connected to it).
 * - "connecting": its process is starting, or IncarnaMind is connecting to it.
 * - "signing-in": remote: the User is signing in to it in their browser.
 * - "needs-sign-in": remote: the server wants a sign-in IncarnaMind doesn't
 *   have on this device: the User hasn't signed in, signed out, or renewing
 *   the sign-in failed (`signIn.expired`). Answers skip its Tools.
 * - "ready": connected; Answers can use its Tools (see `ApprovalPolicy` for which ask first).
 * - "error": it couldn't start or be reached, or it stopped (see `error`).
 * - "paused": remote: its server isn't on this computer, and "Keep everything
 *   on this computer" is on, so IncarnaMind isn't connected to it and Answers
 *   don't use it. It connects again once that is off.
 */
export type ConnectorState =
  | "off"
  | "paused"
  | "connecting"
  | "signing-in"
  | "needs-sign-in"
  | "ready"
  | "error";

export type ConnectorErrorKind =
  /**
   * Its command, or the runtime the command needs, isn't installed or isn't
   * on the PATH of the User's login shell (see `command` and `install`).
   */
  | "missing-command"
  /** Its environment variables are kept in the keychain, and can't be read on this device. */
  | "missing-secrets"
  /** Its process started but didn't answer in time; or a remote server didn't. */
  | "timed-out"
  /** Its process exited, or closed the connection. */
  | "stopped"
  /** Remote: its server can't be reached, e.g. no network, or nothing answers at its URL. */
  | "unreachable"
  | "key-refused"
  /** Anything else, e.g. it doesn't speak MCP. */
  | "failed";

export interface ConnectorError {
  kind: ConnectorErrorKind;
  /** "missing-command": the command that wasn't found, e.g. "npx". Null otherwise. */
  command: string | null;
  /** "missing-command": what to install to get it, when known, e.g. "Node.js". */
  install: string | null;
  /** Technical detail in English, e.g. the last lines the process wrote to its error output. */
  message: string;
  /** IncarnaMind will start it again by itself shortly, waiting longer after each failure. */
  retrying: boolean;
}

/** A Tool a Connector offers. */
export interface ConnectorTool {
  /** As the Connector names it, e.g. "search_issues". */
  name: string;
  /** A display name, when the Connector gives one. */
  title: string | null;
  description: string;
  /**
   * The Connector says the Tool only reads and changes nothing (its
   * `readOnlyHint` annotation). That is the Connector's claim, a hint, not
   * something IncarnaMind can check. Answers call such a Tool without asking
   * unless the User switched it to "ask"; every other Tool asks first, unless
   * the User always allows it (see `ApprovalPolicy`).
   */
  readOnly: boolean;
}

interface ConnectorBase {
  /** A random UUID generated on this device. */
  id: string;
  /** Unique among Connectors, ignoring case. Answers see its Tools under this name. */
  name: string;
  /** The User turned it on. Off, it isn't running or connected, and Answers don't use it. */
  enabled: boolean;
  state: ConnectorState;
  /** Set when `state` is "error". */
  error: ConnectorError | null;
  /** Its Tools, as of when it last connected; null before it has. Null while it is off. */
  tools: ConnectorTool[] | null;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

/**
 * A local Connector: a program on this computer, started with the User's
 * login-shell environment and spoken to over its standard input and output.
 */
export interface LocalConnector extends ConnectorBase {
  transport: "stdio";
  /** The program to run, e.g. "npx", found on the PATH of the User's login shell. */
  command: string;
  args: string[];
  /**
   * The names of the environment variables it is started with, e.g. API keys.
   * Their values are kept in the keychain, never in the database, and never shown.
   */
  env: string[];
}

export type ConnectorSignInErrorKind =
  /** Another program took the local port the browser comes back to. */
  | "port-in-use"
  /** The User didn't finish in the browser within a few minutes. */
  | "timed-out"
  /** The User cancelled in IncarnaMind. */
  | "cancelled"
  /** The service refused the sign-in, e.g. the User declined in the browser. */
  | "denied"
  /**
   * The service can't register IncarnaMind by itself: the User registers an
   * OAuth app with it and enters its client ID (`setConnectorClient`).
   */
  | "client-id-required"
  /** This device can't store the sign-in securely (see `getSecretStorage`). */
  | "secret-storage"
  /** "Keep everything on this computer" is on and the sign-in's server isn't on this computer: nothing was sent. */
  | "held-back"
  | "failed";

export interface ConnectorSignInError {
  kind: ConnectorSignInErrorKind;
  /** Technical detail in English. */
  message: string;
}

/** A remote Connector's sign-in on this device. Its tokens are kept in the keychain, never the database. */
export interface RemoteConnectorSignIn {
  /** Tokens for it are stored on this device. */
  signedIn: boolean;
  /** Renewing the last sign-in failed, so its tokens were removed: the User signs in again. */
  expired: boolean;
  /**
   * "Keep everything on this computer" is on, and the server this sign-in is
   * with isn't on this computer (the MCP server's own is, or the Connector
   * would be "paused"): it isn't renewed or started, its Tools aren't offered,
   * and its tokens are kept for when that is off.
   */
  heldBack: boolean;
  /** Why the last browser sign-in didn't work; null once one works or starts again. */
  error: ConnectorSignInError | null;
}

/**
 * A remote Connector using Streamable HTTP or older SSE, with device-only
 * header secrets or browser sign-in (OAuth 2.1 with PKCE).
 */
export interface RemoteConnector extends ConnectorBase {
  transport: "http";
  connection?: "http" | "sse";
  headers?: string[];
  /** Its MCP endpoint, e.g. "https://mcp.example.com/mcp". */
  url: string;
  /**
   * The client ID of an OAuth app the User registered with the service, for
   * one that can't register IncarnaMind by itself. Null otherwise.
   */
  clientId: string | null;
  signIn: RemoteConnectorSignIn;
}

/** An external service the User has connected: an MCP server, local or remote. */
export type Connector = LocalConnector | RemoteConnector;

export interface AddLocalConnectorInput {
  /** Trimmed; must not be empty, nor another Connector's name (ignoring case). */
  name: string;
  /** The program to run, e.g. "npx", or a full path. */
  command: string;
  /** Defaults to none. */
  args?: string[];
  /** Environment variables to start it with, e.g. API keys. Their values go to the keychain, never the database. */
  env?: Record<string, string>;
}

/** The OAuth app a User registered with a service that can't register IncarnaMind by itself. */
export interface ConnectorClientInput {
  clientId: string;
  /** Only if the service gave the app one. It goes to the keychain, never the database. */
  clientSecret?: string;
}

export interface AddRemoteConnectorInput {
  /** Trimmed; must not be empty, nor another Connector's name (ignoring case). */
  name: string;
  /**
   * Its MCP endpoint: an https URL, or http on this computer (e.g.
   * "http://127.0.0.1:8000/mcp"). Its sign-in, if any, starts with `signInToConnector`.
   */
  url: string;
  connection?: "http" | "sse";
  headers?: Record<string, string>;
  /** Only for a service that can't register IncarnaMind by itself (see `ConnectorClientInput`). */
  client?: ConnectorClientInput;
}

/** A local Connector by its command, or a remote one by its `url`. */
export type AddConnectorInput = AddLocalConnectorInput | AddRemoteConnectorInput;

export type ConnectorSignInResult =
  | { ok: true; connector: Connector }
  | { ok: false; error: ConnectorSignInError };

/**
 * One server of an `mcpServers` configuration (from Claude Desktop or
 * Cursor), and what importing it would do:
 * - "add": it is added as a Connector;
 * - "exists": a Connector with its name already exists (or the configuration
 *   lists the name twice), so it is skipped;
 * - "remote": it uses a transport IncarnaMind can't connect to;
 * - "invalid": it has neither a command nor a URL, or its arguments,
 *   environment or URL aren't valid.
 */
export interface ConnectorImportEntry {
  name: string;
  /** A local server's command; null for a remote one. */
  command: string | null;
  args: string[];
  /** The names of its environment variables. Their values go to the keychain. */
  env: string[];
  /** A remote server's URL. Absent for a local one. */
  url?: string;
  connection?: "http" | "sse";
  headers?: string[];
  action: "add" | "exists" | "remote" | "invalid";
}

export interface ConnectorImportResult {
  /** The Connectors added, in the configuration's order. They start right away. */
  added: Connector[];
  /** The servers that weren't added, with why. */
  skipped: ConnectorImportEntry[];
}

/** Words in each interface language, for data shipped beside the code, such as the Connectors directory. */
export type LocalizedText = Record<Language, string>;

/**
 * The directory's groups, by use, in the order Settings › Connectors shows
 * them: where the User's files are, financial data, legal research, medicine
 * and research, and work.
 */
export const connectorDirectoryGroups = [
  "files",
  "financial-data",
  "legal-research",
  "medicine-and-research",
  "work",
] as const;
export type ConnectorDirectoryGroup = (typeof connectorDirectoryGroups)[number];

/**
 * How a Connector in the directory signs in:
 * - "browser": in the User's browser, IncarnaMind registering itself with the service;
 * - "own-app": in the browser too, but the service registers only the apps it
 *   knows: the User registers an OAuth app with it and enters its client ID
 *   (`ConnectorClientInput`) before signing in;
 * - "none": it needs no sign-in.
 */
export type ConnectorDirectorySignIn = "browser" | "own-app" | "none";

/**
 * A remote Connector IncarnaMind has reviewed, listed in Settings ›
 * Connectors before the User connects it. The list ships with the app as
 * data (src/core/connectors/directory.json).
 */
export interface ConnectorDirectoryEntry {
  /** Stable across versions of the list, e.g. "factset". */
  id: string;
  /** The service's name, which the Connector takes when it is added, e.g. "FactSet". */
  name: string;
  /** Who runs the server, e.g. "FactSet". */
  publisher: string;
  group: ConnectorDirectoryGroup;
  /** One line on what it reads. */
  summary: LocalizedText;
  /**
   * What the User needs from the service: their own subscription to a
   * product (`{ product: "FactSet" }`), nothing ("free"), or null when that
   * depends on their account, e.g. a free tier.
   */
  subscription: { product: string } | "free" | null;
  /** Its MCP endpoint, an https URL. A Connector at this URL is this entry, connected. */
  url: string;
  signIn: ConnectorDirectorySignIn;
  /**
   * Its Tools as IncarnaMind reviewed them, shown before the User connects
   * it: each one's name and whether it may change things. Absent when the
   * service lists them only once signed in; its page then says they appear
   * once it's connected.
   */
  tools?: { title: LocalizedText; changes: boolean }[];
  /** Listed only in these interface languages, e.g. a service for Chinese Users. Absent: in every language. */
  languages?: Language[];
}

/** How a community server from the MCP Registry runs on this computer: its package, through npx or uvx. */
export interface ConnectorRegistryCommand {
  command: string;
  args: string[];
  /** The environment variables it reads, e.g. an API key, for the User to fill in. */
  env: string[];
}

/** A community server found in the official MCP Registry. Not reviewed by IncarnaMind. */
export interface ConnectorRegistryServer {
  /** Its name in the Registry, e.g. "io.github.example/zotero-mcp". */
  id: string;
  /** Its title, or else its name's last part. */
  name: string;
  /** Who published it: its name's namespace, e.g. "io.github.example". */
  publisher: string;
  description: string;
  /** Its MCP endpoint, when it runs remotely at an https URL IncarnaMind can use as it is. */
  url: string | null;
  /** How it runs on this computer, when it has a package IncarnaMind can start. */
  command: ConnectorRegistryCommand | null;
  /** Its website or repository, to read about it. */
  link: string | null;
}

/**
 * A search of the MCP Registry: the servers found, or why nothing was:
 * - "local-mode": Local mode is on, so nothing was sent;
 * - "declined": the User declined sending their search to the Registry;
 * - "unreachable": it couldn't be reached, e.g. no network;
 * - "service-error": it answered with an error, or something IncarnaMind can't read.
 */
export type ConnectorRegistrySearch =
  | { outcome: "found"; servers: ConnectorRegistryServer[] }
  | { outcome: "failed"; reason: "local-mode" | "declined" | "unreachable" | "service-error" };

// ---------------------------------------------------------------------------
// Approvals (#38)

/**
 * What an approval policy is about:
 * - "tool": one Tool of one Connector;
 * - "skill-script": the scripts of one Skill;
 * - "command": a command the assistant runs for the User (#1110), which no policy covers: it
 *   asks every time it reaches outside IncarnaMind.
 */
export type ApprovalSubject =
  | {
      kind: "tool";
      connectorId: string;
      /** The Tool's name as the Connector gives it. */
      tool: string;
    }
  | { kind: "skill-script"; skillId: string }
  | { kind: "command"; command: CommandId };

export type ApprovalSubjectKind = ApprovalSubject["kind"];

/**
 * What the User chose for a subject, replacing the default:
 * - "always": it runs without asking ("always allow" a Tool; "always run" a Skill's scripts).
 * - "ask": it asks every time, even a Tool its Connector says only reads.
 * - "off": a Connector's Tool only: Answers aren't offered it, so it never runs.
 *
 * Without a policy, a Tool asks first unless its Connector says it only reads
 * (`ConnectorTool.readOnly`), and a Skill script always asks.
 */
export type ApprovalPolicyValue = "always" | "ask" | "off";

/** One of the User's approval policies, as the approvals page lists it. */
export interface ApprovalPolicy {
  /** A random UUID generated on this device. */
  id: string;
  subject: ApprovalSubject;
  policy: ApprovalPolicyValue;
  /** What the subject belongs to, as named now: the Connector (for a Tool) or the Skill. */
  ownerName: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  updatedAt: string;
}

export interface SetApprovalPolicyInput {
  /** A Connector that exists, or a Skill that exists. */
  subject: ApprovalSubject;
  /** Null goes back to the default, removing the User's policy. A Skill script takes "always" or null. */
  policy: ApprovalPolicyValue | null;
  /**
   * "Always run" a Skill's scripts only: the User has seen the warning that
   * its scripts will then run on this computer without asking (in the OS
   * sandbox where `Settings.scriptSandbox` is "os", with none otherwise), and
   * confirmed it. Without it, that policy is refused.
   */
  riskAccepted?: boolean;
}

/**
 * What the User decides about a Tool call that asks first:
 * - "allow-once": this call runs;
 * - "always-allow": this call runs, and so will every later call of the Tool
 *   without asking (the policy becomes "always"), except a call that writes
 *   or sends data in a Run that has read third-party text
 *   (`ApprovalRequest.thirdParty`). For a Skill script this is "always run":
 *   every script of the Skill runs from now on without asking, with the same
 *   exception, which needs `ApprovalResponseOptions.riskAccepted`;
 * - "deny": the call doesn't run; the model is told the User denied it, and
 *   the Answer carries on without it.
 */
export type ApprovalDecision = "allow-once" | "always-allow" | "deny";

export interface ApprovalResponseOptions {
  /**
   * "always-allow" of a Skill script ("always run") only: the User has seen
   * the warning that the Skill's scripts will then run on this computer
   * without asking (in the OS sandbox where `Settings.scriptSandbox` is "os",
   * with none otherwise), and confirmed it. Without it, that decision is
   * refused and the request keeps waiting.
   */
  riskAccepted?: boolean;
}

/**
 * A call waiting for the User's approval: of a Connector's Tool, or a run of
 * a Skill script (`subject.kind` tells which). Its Answer is paused until they
 * decide; stopping the Answer, or closing IncarnaMind, denies it.
 */
export type ApprovalRequest =
  | ToolApprovalRequest
  | SkillScriptApprovalRequest
  | CommandApprovalRequest;

interface ApprovalRequestBase extends AnswerPlace {
  requestId: string;
  /** The Answer whose call this is; for a Task's call, the Task's id, as `taskId`. */
  answerId: string;
  /** A Task's call (#126): it waits in the Task's row in the tray, and outlasts a quit. */
  taskId?: string;
  /** The call's id among the Answer's `toolCalls`. */
  toolCallId: string;
  /** What the call can do, as its Tool declares it: why it asks. */
  effects: Effect[];
  /**
   * Its Answer had read content the User didn't write before this call, such
   * as Passages of their Documents or a Connector's reply
   * (docs/designs/agent-extensibility.md §4.6). On its own it doesn't change
   * whether a call asks: `thirdParty` does.
   */
  tainted: boolean;
  /**
   * Why its Answer counts as having read third-party text (#78, ADR-0013): it
   * read a saved web page or the document being checked, or its Question
   * context holds third-party text. Then a Tool-level "always" (always allow,
   * always run) no longer covers a call that writes or sends data, so the
   * call asks, and the card says why. Absent when there is none.
   */
  thirdParty?: ThirdPartyReason[];
  /**
   * For a command of the assistant's (#1421, #2240): what its Answer read that the User didn't
   * write, by the kinds the card names, in the card's order. It never says which of them asked
   * for the command. Absent: it read none of them.
   */
  readText?: ApprovalReadText;
}

/**
 * What an approval card names the Answer read (#2240). A web page is its host, never its
 * title: a page writes its own, and could pass for the User's file. A page whose title alone
 * reached the Answer is its title, by host; a page both title and text reached is a web page.
 * Other text is every read the kinds here cannot name, so a kind added later is still on the card.
 */
export interface ApprovalReadText {
  /** One entry per Document, by its id: two Documents with one name are two. */
  documents: string[];
  /** Web pages read, by host, one entry for each page. */
  webPages: string[];
  /** Pages whose title alone was seen, by host, one entry for each page. */
  webPageTitles: string[];
  /** Web search's results, Find sources' included. */
  webSearchResults: boolean;
  /** One entry per Connector whose results the Answer read, by its id. */
  connectors: string[];
  /** A Skill script's or an Analysis's output. */
  scriptOutput: boolean;
  transcript: boolean;
  /** Some text the kinds here cannot name. */
  otherText: boolean;
}

/**
 * An Effect (CONTEXT.md): something a Tool call can do beyond the
 * conversation it is part of, and where. Whether a call asks the User first
 * depends on its Effects, and on the User's policy for it.
 */
export interface Effect {
  /**
   * "read": takes data in. "write": changes something. "execute": runs code
   * on this computer. "network": sends data off this computer.
   */
  action: "read" | "write" | "execute" | "network";
  scope: EffectScope;
}

/** Where an Effect happens. "anywhere" when IncarnaMind can't tell, e.g. for an unconfined script. */
export type EffectScope =
  | { kind: "documents" } // IncarnaMind's index of the User's Documents
  | { kind: "skill"; skillId: string } // a Skill's own folder
  | { kind: "folder"; path: string } // absolute; covers what is inside
  | { kind: "service"; serviceId: string; name: string } // an external service, as consent names it
  | { kind: "host"; host: string } // a web host
  | { kind: "mind"; mindId: string } // one of the User's Minds
  | { kind: "sandbox" } // the analysis sandbox, with no files and no network (ADR-0023)
  | { kind: "library" } // the Library: its Documents' names, Folders and Tags, Recently deleted
  | { kind: "output" } // the Output location, the folder the User chose for new files
  | { kind: "anywhere" };

/**
 * A run of a Skill script waiting for the User's approval: which Skill, which
 * of its scripts, and its arguments. Scripts run on this computer: in the OS
 * sandbox on macOS and Linux (#65, `Settings.scriptSandbox` "os"), and with
 * none on Windows, where they can do whatever the User can (`effects` says which).
 */
export interface SkillScriptApprovalRequest extends ApprovalRequestBase {
  subject: Extract<ApprovalSubject, { kind: "skill-script" }>;
  /** The Skill the script belongs to, as named when the run was asked for. */
  skill: { id: string; name: string };
  tool: "run_skill_script";
  /** The script's path inside the Skill, e.g. "scripts/convert.py". */
  script: string;
  /** The arguments it would run with, in order. */
  args: string[];
}

/** A call of a Connector's Tool waiting for the User's approval. */
export interface ToolApprovalRequest extends ApprovalRequestBase {
  subject: Extract<ApprovalSubject, { kind: "tool" }>;
  /** The Connector the Tool belongs to, as named when the call was made. */
  connector: { id: string; name: string };
  /** The Tool's name as its Connector gives it, e.g. "create_issue". */
  tool: string;
  /** The Tool's display name, when the Connector gives one. */
  title: string | null;
  /** The arguments the model wants to send. */
  input: Record<string, unknown>;
  /**
   * The Connector says this Tool only reads: it asks only because the User
   * switched it to "ask". False: the Tool may change something.
   */
  readOnly: boolean;
}

/**
 * Why a change inside IncarnaMind waits for the User (#1110): it would take the Answer's changes
 * past `COMMAND_AT_ONCE`, or it deletes, which the assistant never does without asking.
 */
export type CommandAskReason = "many" | "delete";

/** How many things one Answer's commands may change before the next change asks the User first (#1110). */
export const COMMAND_AT_ONCE = 20;

/**
 * What a command the assistant runs for the User would do, as its approval shows it (#1110):
 * save a Mind as a file in a folder other than the Output location; read a folder's files
 * (`files`, by name, nothing outside it) and add them to the Library; change things inside
 * IncarnaMind that need the User's say (`reason`); run a command of the window's that can't be
 * taken back ("final", #1421); start a recording or turn the microphone on ("listen"); or make a
 * folder the Output location, where files are then saved without asking ("output", #1421). `items` are the first of them, each by the name the User knew
 * it by, with `renamed` when the Conversation's commands renamed it.
 */
export type CommandAsk =
  | {
      kind: "change";
      command: CommandId;
      reason: CommandAskReason;
      count: number;
      items: CommandItem[];
      /** The Folder or Tag it would put them in, by name. */
      into: string | null;
      /** How many things the Answer changed without asking before this call. */
      changed: number;
    }
  | {
      kind: "export";
      mind: { id: string; name: string };
      format: ExportFormat;
      /** Absolute, links followed. */
      folder: string;
      /** The name it would be saved under; the next free one if that is taken. */
      fileName: string;
    }
  | { kind: "add"; folder: string; files: string[] }
  | { kind: "final"; command: CommandId; items: CommandItem[] }
  | { kind: "listen"; command: CommandId }
  | {
      kind: "output";
      /** Absolute, links followed. */
      folder: string;
    };

/** A Folder or Tag the commands of a Run made, left in place by their Undo: the User filed things in it since. */
export interface CommandKept {
  kind: "folder" | "tag";
  name: string;
}

/** What `undoCommands` took back (#1110). */
export interface CommandsUndone {
  /** The Folders and Tags the Run made that its Undo left in place, from every try so far. */
  kept: CommandKept[];
  /**
   * Why some of its changes weren't taken back, each in English; null: all of them were.
   * `again`: trying again may take back the rest, once the User fixed the cause (restored a
   * Document, say). False once a try again took back nothing more.
   */
  failed: { reasons: string[]; again: boolean } | null;
}

/**
 * A command the assistant runs for the User (#1110) waiting for their approval: it would
 * write outside IncarnaMind, read a folder of theirs, delete, or change more than an Answer
 * changes at once. It offers no "always allow". `tainted`: its Run had read text the User didn't
 * write: Passages, a Connector's reply, a web page or a web page's title.
 */
export interface CommandApprovalRequest extends ApprovalRequestBase {
  subject: Extract<ApprovalSubject, { kind: "command" }>;
  tool: "run_command";
  ask: CommandAsk;
}

/**
 * A command of the window's list the assistant runs (#1421), sent to the window whose Question
 * asked for it: that window runs it as ⌘K does, on `targets` (none: the window in front), and
 * answers with `answerWindowCommand`.
 */
export interface WindowCommandRequest {
  requestId: string;
  answerId: string;
  toolCallId: string;
  /** The Run the call is part of: a change the window's Undo takes back goes with its other changes. */
  run: string;
  command: CommandId;
  /**
   * What it acts on. For a suggestion To review's Accept all takes, `into` is the Suggested Folder
   * the core checked it against (null: none): it is accepted only while it waits for that one.
   */
  targets: { kind: CommandTarget; id: string; into?: string | null }[];
  /**
   * The Folder wall the core checked it behind (null: outside every wall): what it files is filed
   * by the walls judged again when it is filed, never across this one (#2250).
   */
  wall: string | null;
  /** The Note the Question was asked from, which a command with no `targets` acts on; null: none. */
  mindId: string | null;
  /** The window whose Question it is, which alone runs it. */
  clientId: string;
}

/** How a window command ended: run (`changed`: its Undo takes something back), or not. */
export type WindowCommandEnd =
  | { ran: true; changed: boolean }
  | { ran: false; why: string; wording: ErrorWording | null };

/**
 * What the window says of a command it was asked to run: that it started, as soon as it has, and
 * then how it ended; or only how it ended, when it couldn't start. Why it didn't run is in English
 * for the model and in the interface's words (`wording`) where the window has them.
 */
export type WindowCommandResult = WindowCommandEnd | { started: true };

// ---------------------------------------------------------------------------
// Recently deleted (CONTEXT.md)

/** How many days deleted things wait in Recently deleted before they are deleted permanently. */
export const RECENTLY_DELETED_DAYS = 30;

/** What deleting puts in Recently deleted. A conversation is the assistant's (ADR-0017); a Folder is an in-app one. */
export const DELETED_KINDS = ["mind", "conversation", "document", "folder", "tag"] as const;
export type DeletedKind = (typeof DELETED_KINDS)[number];

export interface DeletedRef {
  kind: DeletedKind;
  id: string;
}

export interface RestoreRef extends DeletedRef {
  /** Tag links to put back as they were with it: what `mergeTags` changed in the other Tag. */
  links?: TagLinkState[];
}

/** What a restore couldn't bring back as it was. */
export interface RestoreResult {
  /**
   * The Notes whose Meeting came back without the audio it had kept: it was no longer on this
   * computer, deleted by an earlier version with the Note, or by something outside IncarnaMind.
   */
  audioLost: string[];
  /**
   * The Notes whose Meeting came back without its audio because its day ended while the Note
   * waited in Recently deleted, and it was deleted then, as any Meeting's audio is (#1253).
   */
  audioExpired: ExpiredAudio[];
}

/** A Note whose Meeting's audio was deleted, its day over, while the Note waited in Recently deleted. */
export interface ExpiredAudio {
  mindId: string;
  /** A voice memo, recorded rather than a call. */
  memo: boolean;
  /** Its Transcript came back with it. */
  transcript: boolean;
}

/** What Undo of a Restore puts back in Recently deleted: an item, at the time it was deleted before it came back. */
export interface DeletedAgainRef extends DeletedRef {
  /** ISO 8601, UTC. */
  deletedAt: string;
}

export interface DeletedItem {
  kind: DeletedKind;
  id: string;
  /** Its name when deleted. May be empty for a Mind: the UI shows "Untitled". */
  name: string;
  /** ISO 8601, UTC. */
  deletedAt: string;
  /** A Document's kind; null for the others. */
  documentKind: DocumentKind | null;
  /**
   * The in-app Folder (`LibraryGroup`) a Mind, conversation or Document was in, or null: none, and
   * for the others. One deleted after it still counts, until that Folder is deleted permanently.
   */
  groupId: string | null;
  /** A Document's Linked folder, or null: a file added on its own, and for the others. */
  linkedFolderId: string | null;
  /**
   * A Note's Meeting, when it keeps its recording or its Transcript here with the Note: both go
   * when the Note is deleted permanently (#1253). Absent for the others.
   */
  meeting?: { recording: boolean; transcript: boolean };
}

/**
 * What a deleted Folder held: its Documents, as they were filed, its Minds and its
 * conversations. Restoring it puts back each one still in no Folder.
 */
export interface FolderDeletion {
  assignments: DocumentGroupAssignment[];
  mindIds: string[];
  conversationIds: string[];
}

/** How a Document carried a Tag before a change, for `revertDocumentTags`. */
export interface TagLinkState {
  documentId: string;
  tagId: string;
  /** As `Document.tags` listed it, or null: the Document didn't carry the Tag. */
  link: Pick<DocumentTag, "source" | "confidence" | "needsReview"> | null;
  /**
   * With `link` null: whether the User had taken the Tag off, so automatic tagging left it
   * off. False forgets a removal recorded since; left out, every removal stays.
   */
  removedByUser?: boolean;
}

export interface TagMerge {
  /** The Tag merged into, unchanged. */
  tag: Tag;
  /** Restoring it undoes the merge: the merged Tag comes back, and both Tags' links are as they were. */
  merged: RestoreRef;
}

// ---------------------------------------------------------------------------
// Export

/**
 * What a Mind exports to: Markdown, for an archive, or Word (.docx), PDF or HTML, for the
 * deliverable; a source pack, a PDF of the pages the Mind cites (#134); or a web page to share,
 * an HTML file whose readers open each Citation's quote. Formats are listed in the order the
 * options sheet offers them.
 */
export const EXPORT_FORMATS = [
  "docx",
  "pdf",
  "source-pack",
  "html",
  "share-page",
  "markdown",
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** What a Mind's check record (#738) is saved as: a PDF to file with the work, and a CSV for the User's own records. */
export const CHECK_RECORD_FORMATS = ["pdf", "csv"] as const;
export type CheckRecordFormat = (typeof CHECK_RECORD_FORMATS)[number];

/** A file of the check record that could not be saved, and why (`message` is English; `wording` says it in the interface language). */
export interface CheckRecordFailure {
  format: CheckRecordFormat;
  message: string;
  wording: ErrorWording | null;
}

/**
 * What `saveCheckRecord` did. Saved: `file` is the PDF, or the CSV when the PDF could not be made;
 * `withCsv` says the CSV is beside it; each file that failed is in `failures`, and the other was kept.
 * When neither could be saved, it throws the first failure.
 */
export type SavedCheckRecord =
  | { status: "saved"; file: SavedFile; withCsv: boolean; failures: CheckRecordFailure[] }
  | Exclude<SavedExport, { status: "saved" }>;

/**
 * The User's export choices (`UserSettings.exportOptions`): the format Export uses, and each
 * format's own options. Markdown, the archive, always keeps the Questions; a source pack has
 * none.
 */
export interface ExportPreferences {
  format: ExportFormat;
  docx: WordExportPreferences;
  pdf: { includeQuestions: boolean };
  html: { includeQuestions: boolean };
  "share-page": SharePagePreferences;
  /** How a PDF, an HTML file or Markdown shows someone's changes still waiting (#734). Absent: shown. */
  theirChanges?: TheirChangesShown;
  /** Where Word and PDF put a Numbered Mind's Citations. Absent until an export writes them: footnotes, and that choice is then saved. */
  citationPlace?: CitationPlace;
}

export interface SharePagePreferences {
  includeQuestions: boolean;
  citationCards: boolean;
  checkedLine: boolean;
}

/**
 * How an export other than Word's shows someone's changes from a Word file
 * still waiting (#734): marked as changes, with who made each and when, or
 * as if every one were accepted. A Word file keeps them as tracked changes.
 */
export type TheirChangesShown = "shown" | "accepted";

/** Where a Word or PDF export puts the Citations of a Mind in the Numbered style: a footnote each, or a list at the end. */
export const CITATION_PLACES = ["footnotes", "list"] as const;

export type CitationPlace = (typeof CITATION_PLACES)[number];

/** What a Word file does with the text IncarnaMind wrote: marks it with a comment, or leaves it out. */
export const MARK_AI_TEXT_CHOICES = ["mark", "leave"] as const;

export type MarkAiTextChoice = (typeof MARK_AI_TEXT_CHOICES)[number];

/**
 * A Word export's own choices (#107). The switches are on until the User turns them off; marking
 * AI text is on until an export writes a file (or the User changes it), and then saved.
 */
export interface WordExportPreferences {
  includeQuestions: boolean;
  trackChanges: boolean;
  markAiText: MarkAiTextChoice | null;
  commentFailedChecks: boolean;
}

export interface ExportMindOptions {
  format: ExportFormat;
  /**
   * Whether Questions are exported, marked as Questions. Defaults to true for
   * Markdown, an archive of everything, and to false for .docx, PDF and HTML: the
   * deliverable leaves the working material out. A source pack has no Questions.
   */
  includeQuestions?: boolean;
  /**
   * For a Mind imported from a Word file, exported to Word (#105): the keys of
   * what can't be kept (`WordExportLoss.key`) that the User has seen and
   * exports anyway. `saveMindExport` saves nothing while anything else can't be kept.
   */
  accept?: string[];
  /**
   * Word only (#107): for a Mind imported from a Word file, the User's edits
   * since the import go in as tracked changes under their name
   * (`Settings.author`). Changes still waiting to be accepted always go into
   * a Word file as tracked changes by IncarnaMind. Absent: off.
   */
  trackChanges?: boolean;
  /** Word only: AI text gets a comment by IncarnaMind, "Written by IncarnaMind". Absent: off. */
  markAiText?: boolean;
  /** PDF, HTML and Markdown: how someone's changes still waiting are shown (#734). Absent: shown. */
  theirChanges?: TheirChangesShown;
  /**
   * Word and PDF, for a Mind in the Numbered style (another style decides for itself): a footnote
   * for each Citation, or a list of the Documents cited at the end, with `[1]` markers in the text.
   * Absent: footnotes.
   */
  citationPlace?: CitationPlace;
  /**
   * Word only: a Citation whose check failed (its quote wasn't found, or its
   * claim is unsupported or contradicted), and a sentence checked
   * Contradicted, Unsupported or Needs re-check, gets a comment by
   * IncarnaMind saying so. Absent: off. A Mind made by Verify from someone
   * else's file keeps its own choice instead (`setCheckComments`).
   */
  commentFailedChecks?: boolean;
  /**
   * A web page to share only: each Citation's marker opens a card with
   * its quote, the part of its Document around it, and its check. Off, the
   * file is the HTML export. Absent: on.
   */
  citationCards?: boolean;
  /** A web page to share only: its foot says "Citations checked with IncarnaMind". Absent: off. */
  checkedLine?: boolean;
}

/** What exporting a Mind will write, for the User to see before the file is written. */
export interface MindExportPreview {
  /** A file name for the export, from the Mind's title, e.g. "Tides.docx". */
  fileName: string;
  /**
   * The Citations in the exported text. Each becomes its own footnote, even
   * when several cite the same page.
   */
  citations: number;
  /** The Documents those Citations cite, each counted once. */
  citedDocuments: number;
  /** Whether the Mind's citation style is Numbered, the one whose Citations go where the User chooses. */
  numbered: boolean;
  /**
   * Of those, the ones not shown as "Quote found": the quote wasn't found on
   * the cited pages, or it can't be checked (the pages have no text, or the
   * Document was deleted), or it is still being checked. Their footnotes carry
   * an "[unverified]" marker.
   */
  unverifiedCitations: number;
  /** The Question Blocks in the Mind, whether the export includes them or not. */
  questions: number;
  /** The comparison-table columns a file leaves out, for the app to say so. */
  hiddenColumns: number;
  /** The Mind was imported from a Word file, which a Word export writes back into (#105). */
  fromWord: boolean;
  /** Someone's changes from that Word file still waiting (#734), shown or accepted as `theirChanges` says. */
  theirChanges: number;
  /**
   * Where the file puts its Citations, for the Saved line (#1945): footnotes or a list at the end,
   * for a Numbered Mind with Citations that Word or PDF writes. Null when nothing placed them.
   */
  citationPlace: CitationPlace | null;
  /** Whether a Word file marks the text IncarnaMind wrote (#107), for the Saved line (#1945); null for a format that can't mark it. */
  markAiText: boolean | null;
  /** The Mind was made by Verify from someone else's file (#110): its Word file is named after the original, and its comments are its own choice. */
  othersFile: boolean;
  /** For someone else's file: whether its Word export gets check comments (`setCheckComments`); false otherwise. */
  othersComments: boolean;
}

/** The sentences an export holds whose check isn't good, by result (`MindExport.sentenceChecks`). */
export interface SentenceChecksExported {
  contradicted: number;
  /** Nothing in its scope was about it, as its card says (`saysNotFound`): its comment says Not found. */
  notFound: number;
  unsupported: number;
  needsRecheck: number;
  /** They went into the file as comments: a Word file, with `commentFailedChecks` on. Otherwise they went out unmarked. */
  commented: boolean;
  /** The comments on what needs a look the file holds, on these sentences and on Citations; 0 unless `commented`. */
  comments: number;
}

/** A file an export writes beside its main file, e.g. a picture a Markdown export links (#1937). */
export interface ExportFile {
  name: string;
  data: Uint8Array;
}

/** What a Mind's web page to share would hold, for the sheet to show before it is made. */
export interface SharePagePreview {
  /** Every Document the Mind cites, in the order it is first cited. */
  documents: SharedDocument[];
  /** The file's size with every Citation's card as text, in bytes. */
  textBytes: number;
}

export interface SharedDocument {
  documentId: string;
  name: string;
  /** The Citations that cite it. */
  quotes: number;
  /** The page pictures they carry: none for a Document without pages, or whose pages weren't saved. */
  pictures: number;
  /** About what those pictures add to the file, in bytes. */
  pictureBytes: number;
  /** Its Citations' cards stay text, as the User chose (`setSharePageTextOnly`). */
  textOnly: boolean;
}

/** A Mind exported as a file, for the host to save where the User chooses. */
export interface MindExport extends MindExportPreview {
  /** The file's contents: UTF-8 text for Markdown and HTML, a ZIP package for .docx, a PDF for PDF and a source pack. */
  data: Uint8Array;
  /**
   * Files the export writes beside its main file, in the same folder: the
   * pictures a Markdown export links (#1937). Empty or absent for a format
   * that holds its pictures itself.
   */
  files?: readonly ExportFile[];
  /** For a Mind imported from a Word file, exported back into it: what it kept and couldn't keep. */
  word: WordExportReport | null;
  sentenceChecks: SentenceChecksExported;
  /** Changes still waiting that a Word file holds as tracked changes. */
  trackedChanges: number;
  /**
   * The Documents whose Bibliography entries are too thin to cite (`BibliographyEntry.needsDetails`),
   * for the result line's count. None in Numbered, which lists Documents by name.
   */
  needsDetails: string[];
  /**
   * The footnotes in the file, for the Saved line (#1945): the User's own and the Citations', a
   * Citation of a source and place already footnoted repeating that footnote (#1381), so five
   * Citations across two pages are 2 footnotes and one beside a footnote the User wrote is 3.
   * A Word file counts the notes its document refers to, an imported file's own included; a PDF
   * counts the notes printed with it. 0 for a format whose line counts none: Markdown, HTML, a
   * share page, a source pack.
   */
  footnotes: number;
}

/** What `saveMindExport` did. */
export type SavedMindExport =
  /** Saved, with what it holds, so the result line can say how many quotes weren't found. */
  | ({
      status: "saved";
      file: SavedFile;
      word: WordExportReport | null;
      /**
       * For Word and PDF, whether History kept the Note as it was sent (#1933); false when it
       * couldn't, which the result line says. True for the other formats.
       */
      sentKept: boolean;
      /** Written again beside the file of this name, which the User had changed (#110). */
      changedFile?: string;
    } & Omit<MindExportPreview, "fileName" | "fromWord" | "theirChanges"> &
      Pick<
        MindExport,
        | "sentenceChecks"
        | "trackedChanges"
        | "needsDetails"
        | "citations"
        | "citedDocuments"
        | "citationPlace"
        | "markAiText"
        | "footnotes"
      >)
  /**
   * Not saved: a Mind imported from Word can't keep something in its file
   * (`WordExportReport.notKept`) the User hasn't accepted (`ExportMindOptions.accept`).
   */
  | { status: "review"; word: WordExportReport }
  | Exclude<SavedExport, { status: "saved" }>;

/** What `rewriteMindExport` did: as `saveMindExport` says, and once saved, the step its Undo names. */
export type RewrittenMindExport =
  | (Extract<SavedMindExport, { status: "saved" }> & { step: string })
  | Exclude<SavedMindExport, { status: "saved" }>;

/** What saving an export did: a Skill's zip (`saveSkillExport`), and the base of a Mind's. */
export type SavedExport =
  | { status: "saved"; file: SavedFile }
  /** The User didn't choose where new files go, so nothing was saved. */
  | { status: "cancelled" }
  /** The Output location is inside a Linked folder the User said IncarnaMind may not add files to. */
  | { status: "not-allowed"; linkedFolderId: string; linkedFolderPath: string };

// ---------------------------------------------------------------------------
// Citation styles (#289, ADR-0016)

/**
 * A run of text a citation style formatted: text with formatting flags, never markup, so
 * nothing from a reference's fields is ever parsed as HTML or XML.
 */
export interface StyledRun {
  text: string;
  italic?: boolean;
  bold?: boolean;
  smallCaps?: boolean;
  underline?: boolean;
  script?: "sup" | "sub";
  link?: string;
}

/** One Citation as a style needs it: the Document it cites, and where. */
export interface CitedWork {
  documentId: string | null;
  /** The Document's name when it was cited, which still names a Document deleted since. */
  documentName: string | null;
  location: CitationLocation | null;
  /**
   * The version quoted (`CitationAttributes.contentHash`): a web page's tells the day that
   * version was fetched, which styles print as "accessed". Left out, a web page has no such day.
   */
  contentHash?: string | null;
}

/**
 * Citations next to each other in the text, which a style writes as one:
 * "(Bowler et al., 2010; Oke, 1982)" or "[1, 3]". One Citation on its own is a cluster too.
 */
export interface CitationCluster {
  works: CitedWork[];
}

export interface CitationFormatRequest {
  style: CitationStyleId;
  /** In the order they appear in the Mind. */
  clusters: CitationCluster[];
  /**
   * The language of the Mind's text, which a style with no language of its own formats in:
   * Chinese terms for a Chinese Mind. English when left out.
   */
  language?: Language;
}

/** One cluster in the style: its runs, each marked with the work it belongs to. */
export interface FormattedCluster {
  /**
   * Each run's `work` is the index, in the cluster's `works`, of the Citation it writes;
   * none for what the style puts around and between them ("(", "; ", ")"). A style may sort
   * the works, and may write some as part of a range ("[1–3]"), with no run of their own.
   */
  runs: (StyledRun & { work?: number })[];
}

/** One entry of the Bibliography. */
export interface BibliographyEntry {
  /** The Document it lists; null for a Citation's Document deleted since. */
  documentId: string | null;
  /**
   * The Document the Citation names, kept after it leaves the Library: a person's check line
   * belongs to the cited work's own record, never to a live Document.
   */
  workDocumentId: string | null;
  /** The number the style sets apart before the entry ("[1]"), or null. */
  label: StyledRun[] | null;
  runs: StyledRun[];
  /**
   * Its reference record (#286) is too thin to cite well: it has none, or lacks its title,
   * authors or date, so the style printed what little it has.
   */
  needsDetails: boolean;
}

/** A Mind's Citations and Bibliography in a citation style. */
export interface FormattedCitations {
  style: CitationStyleId;
  form: CitationForm;
  /** One per cluster of the request, in its order. */
  clusters: FormattedCluster[];
  /** In the style's order; each cited Document once. */
  bibliography: BibliographyEntry[];
  /** The style hangs its entries: the first line starts further left than the rest. */
  hangingIndent: boolean;
  /** The style isn't in this version: the Mind keeps it, and is formatted as Numbered. */
  unavailable?: true;
}

/** The citation style a Mind is in. */
export interface MindCitationStyle {
  style: CitationStyleId;
  /** The Mind chose it; otherwise it is Numbered, the default. */
  chosen: boolean;
  /**
   * The style new Minds in the Mind's Folder start in: the one last chosen for a Mind there.
   * Null when none was, or the Mind isn't in a Folder.
   */
  folderDefault: CitationStyleId | null;
}

/** What `setMindCitationStyle` changes besides the Mind's own choice. */
export interface SetMindCitationStyleOptions {
  /**
   * The style new Minds in the Mind's Folder start in, exactly (null: none). Left out, a style
   * chosen becomes it, and forgetting the choice leaves it as it is. Undo passes the one before.
   */
  folderDefault?: CitationStyleId | null;
}

// ---------------------------------------------------------------------------
// Files IncarnaMind creates

/**
 * Where the files IncarnaMind creates go (exports, and later transcripts,
 * saved web pages and what Tasks make): the Output location, and the Linked
 * folders the User has said it may or may not add files to. It never changes,
 * renames or deletes a file that is already there.
 */
export interface OutputSettings {
  /**
   * The folder new files go in, absolute, symbolic links resolved; null until
   * the first save, which takes `suggested` without asking.
   */
  location: string | null;
  /** The default: "IncarnaMind" in the User's Documents folder (文稿 on a Chinese Mac). */
  suggested: string;
  /** The Linked folders the User has answered about, oldest answer first. */
  linkedFolders: LinkedFolderWriting[];
}

/** Whether IncarnaMind may add new files inside a Linked folder, which it otherwise only reads. */
export interface LinkedFolderWriting {
  linkedFolderId: string;
  /** The Linked folder's path. */
  path: string;
  allowed: boolean;
  /** ISO 8601, UTC: when the User last answered. */
  decidedAt: string;
}

/**
 * A save waiting for the User's answer (`respondToFileWrite`), asked once:
 * - "output-location": none is chosen and the default, `suggested`, can't
 *   take new files (`problem`). `setOutputLocation` answers with another
 *   folder; accepting makes the default the Output location all the same.
 * - "linked-folder": the file would go inside a Linked folder. Accepting lets
 *   IncarnaMind add files there from now on; declining stops it, until the
 *   User changes it in Settings (`setLinkedFolderWriting`).
 */
export type FileWriteRequest =
  | {
      requestId: string;
      kind: "output-location";
      suggested: string;
      fileName: string;
      /** Why `suggested` can't take it. */
      problem: OutputFolderProblem;
    }
  | {
      requestId: string;
      kind: "linked-folder";
      linkedFolderId: string;
      linkedFolderPath: string;
      fileName: string;
    };

/** Why a folder can't take new files: it can't be made (a file is in the way), or IncarnaMind may not write in it. */
export type OutputFolderProblem = "missing" | "not-writable";

/** A new file IncarnaMind saved. */
export interface SavedFile {
  /** Absolute. */
  path: string;
  /** Its name: the one asked for, or, when that was taken, the next free one ("Tides 2.docx"). */
  name: string;
  /** The folder it is in, absolute, symbolic links resolved. */
  folder: string;
  /**
   * This save took the default Output location, Documents › IncarnaMind,
   * none being chosen yet: what shows it says where, with a way to change it.
   */
  defaulted: boolean;
  /** The folder is the default Output location, which a line names as this computer names Documents. */
  inDefaultFolder: boolean;
}

// ---------------------------------------------------------------------------
// Meetings

/** Where a Meeting's audio comes from: the microphone, or the computer's own sound (the other people in the Meeting). */
export type AudioSource = "microphone" | "system";

/**
 * A Meeting's state:
 * - "ready": its Mind shows the start block; nothing is recorded yet.
 * - "recording": its audio goes to disk as it is captured, in 10-second parts.
 * - "paused": by the User, or because IncarnaMind closed while it was recording.
 * - "stopped": over. Its audio is kept until it expires.
 */
export type MeetingStatus = "ready" | "recording" | "paused" | "stopped";

/**
 * What is recorded: a call ("meeting"), or a voice memo (#1568), the User alone, with the
 * microphone only, no help during the call and no Speakers, whose note after Stop is the speech
 * tidied under a title line.
 */
export type MeetingKind = "meeting" | "memo";

/**
 * How one source is recorded right now:
 * - "off": not asked for ("Only me"), or the Meeting isn't recording.
 * - "starting": asked for, not heard from yet.
 * - "recording": its audio is coming in.
 * - "silent": the computer's sound has been nothing but silence for a minute,
 *   which is what macOS gives when IncarnaMind isn't allowed to record it.
 * - "denied": this computer doesn't allow IncarnaMind to record it.
 * - "unavailable": there is none (no microphone), or this computer can't
 *   record it (the computer's sound on Linux, for now).
 * - "ended": it stopped part way, e.g. its device went, and couldn't start again.
 */
export type MeetingSourceState =
  | "off"
  | "starting"
  | "recording"
  | "silent"
  | "denied"
  | "unavailable"
  | "ended";

/**
 * A stretch the User didn't choose not to record: IncarnaMind wasn't running
 * (it closed or crashed while recording), or the computer slept.
 */
export interface MeetingGap {
  /** Where it falls, in the Meeting's time: ms of recording before it (pauses and gaps take none). */
  atMs: number;
  /** How long nothing was recorded, in ms. */
  missedMs: number;
  reason: "interrupted" | "sleep";
}

export interface Meeting {
  id: string;
  /** The Mind it belongs to, where its notes are written. */
  mindId: string;
  kind: MeetingKind;
  status: MeetingStatus;
  /** Why it is paused: the User did, or IncarnaMind closed while it was recording. Null unless paused. */
  pausedBy: "user" | "interrupted" | null;
  /** The computer's sound is recorded too ("Me and them"), not only the microphone ("Only me"). */
  systemAudio: boolean;
  sources: Record<AudioSource, MeetingSourceState>;
  /**
   * How much has been recorded, in ms: in all, or, while `recordingSince` is
   * set, up to then. The Meeting's time now is `recordedMs` plus the time
   * since `recordingSince`. Pauses and gaps don't count.
   */
  recordedMs: number;
  /** While audio is being captured, when this stretch began (ISO 8601); otherwise null. */
  recordingSince: string | null;
  gaps: MeetingGap[];
  /** When recording first started, and when it was stopped (ISO 8601). */
  startedAt: string | null;
  stoppedAt: string | null;
  /** Its audio on this computer, which is deleted at most a day after the Meeting. */
  audio: MeetingAudio;
  /** Why the latest audio couldn't be saved (e.g. the disk is full), until a part is saved again. */
  saveError: string | null;
  /** Its Transcript, made on this computer (#136); null before it starts, or where this copy can't transcribe. */
  transcript: MeetingTranscript | null;
  /** How well its capture went, so a bad recording can be explained (#161). */
  health: CaptureHealth;
  /**
   * While the User has paused their microphone: where in the Meeting's time that began, in ms of
   * recording before it; otherwise null. The computer's sound is still recorded.
   */
  microphonePausedAtMs: number | null;
  /** The help asked for last during the call, whose Answer the floating panel shows; null before any and after Stop. */
  help: MeetingHelp | null;
  /** The kind of meeting the help buttons are for, as the User chose it; null: the general buttons only. */
  helpTemplate: MeetingHelpTemplate | null;
  /** Its notes filled in from the Transcript after Stop (#142); null before Stop. */
  fill: MeetingFill | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The Mind's notes filled in from the Transcript after Stop (#142), with no question first:
 * under each of the User's lines, or, with none, in sections. Every addition is AI text citing
 * the Transcript's times; the User's own text never changes.
 * - "waiting": for the Transcript to be finished and saved;
 * - "filling": the model is writing;
 * - "filled": written, and one Undo takes it all back;
 * - "undone": taken back;
 * - "failed": nothing was written, and `problem` says why; Try again fills it in;
 * - "off": not run, and `problem` says why: "Keep everything on this computer" is on and the
 *   Mind's model isn't on this computer, or the model isn't ready or allowed yet.
 *
 * A voice memo's note (#1568) is its speech tidied into paragraphs under a title line, each citing
 * its time ("memo"), at the start of a Mind with no text yet, so the title line names it. With no
 * model to tidy it, or when the tidied note had words that weren't said, the Transcript goes in as
 * it is instead, a line a paragraph ("transcript"), and `problem` says why.
 */
export interface MeetingFill {
  state: "waiting" | "filling" | "filled" | "undone" | "failed" | "off";
  /**
   * Under the User's lines ("notes"), or in sections because they wrote none; a voice memo's
   * note tidied ("memo") or its Transcript as it is ("transcript"). Null before it knows.
   */
  mode: "notes" | "sections" | "memo" | "transcript" | null;
  /** The model that wrote it runs on this computer. */
  local: boolean;
  problem: MeetingFillProblem | null;
}

/**
 * Why the notes weren't filled in:
 * - "model": the model failed (`message`: its words, or a provider error's);
 * - "stopped": IncarnaMind closed while they were being filled in;
 * - "local-mode": "Keep everything on this computer" is on and the Mind's model isn't local;
 * - "not-allowed": the User hasn't allowed sending to the model's service yet (`service`);
 * - "no-model": no model is set up, or it needs a key or a sign-in;
 * - "no-transcript": the Transcript has no lines;
 * - "added": a voice memo's tidied note had words that weren't said.
 */
export interface MeetingFillProblem {
  kind: "model" | "stopped" | "local-mode" | "not-allowed" | "no-model" | "no-transcript" | "added";
  message: string;
  /** For "not-allowed": the service's name, as the User knows it. */
  service?: string;
}

export type { HelpKeys, MeetingHelpKind, MeetingHelpTemplate };

/** Help asked for during a call: its button, and its Answer in a conversation. */
export interface MeetingHelp {
  kind: MeetingHelpKind;
  conversationId: string;
  answerId: string;
  /**
   * The line it answers, for its heading: the other side's newest ("Them"), the User's own for
   * "Am I leading them?", or the newest of all where speakers aren't told apart. `speaker` as
   * the Transcript has it ("Me", "Them", "Speaker ?"). Null for the buttons about the whole call.
   */
  heard: { text: string; speaker: string | null } | null;
}

export interface AskMeetingHelpInput {
  meetingId: string;
  kind: MeetingHelpKind;
  /**
   * The conversation to ask in, as the assistant shows it; null: a new one. Absent: the one
   * this meeting's help went to last, or a new one.
   */
  conversationId?: string | null;
}

export interface SetMeetingTemplateInput {
  meetingId: string;
  template: MeetingHelpTemplate | null;
}

export interface SetMeetingMicrophoneInput {
  meetingId: string;
  paused: boolean;
}

/** How loud each source of a recording Meeting is now, from 0 (silence) to 1. */
export interface MeetingLevel {
  meetingId: string;
  microphone: number;
  system: number;
}

/**
 * How well a Meeting's capture went (#161): only numbers, times and kinds,
 * never a word of its Transcript or any of its audio. It goes into the log as
 * it happens, too.
 */
export interface CaptureHealth {
  /**
   * Live transcription on this computer: the time decoding took over the
   * length of the speech it decoded, so under 1 keeps up with the Meeting.
   * Null until some speech has been transcribed live.
   */
  realTimeFactor: number | null;
  /** How much speech `realTimeFactor` is measured on, in ms. */
  measuredMs: number;
  /** Whether that is fast enough for live text; null until measured. */
  keepsUp: boolean | null;
  /** What happened to the capture, in the order it happened. */
  events: CaptureHealthEvent[];
}

export type CaptureHealthEvent = {
  /** When it happened (ISO 8601). */
  at: string;
  /** Where it happened, in the Meeting's time. */
  atMs: number;
} & CaptureEvent;

/**
 * What happened to a Meeting's capture:
 * - "audioLost": a source's audio is missing for `durationMs` (see `AudioLossCause`).
 * - "audioRecovered": IncarnaMind closed or crashed while recording, at
 *   `atMs`, and the `durationMs` saved before then since recording last
 *   started, in `parts`, was found at the next start.
 * - "restarted": the transcription process stopped and was started again;
 *   the speech it had not finished is a gap, transcribed again after the
 *   Meeting stops while its audio is kept.
 * - "behind": live text fell behind; the rest is transcribed after the Meeting stops.
 * - "notTranscribed": a stretch of speech the engine couldn't read has no text.
 * - "switched": transcription moved from one engine to another (#141, #462).
 */
export type CaptureEvent =
  | { kind: "audioLost"; source: AudioSource; cause: AudioLossCause; durationMs: number }
  | { kind: "audioRecovered"; parts: number; durationMs: number }
  | { kind: "restarted"; gapMs: number }
  | { kind: "behind" }
  | { kind: "notTranscribed"; durationMs: number }
  | {
      kind: "switched";
      from: TranscriptionEngine;
      to: TranscriptionEngine;
      reason: EngineSwitchReason;
    };

/**
 * Why audio is missing: a part couldn't be saved because the disk was full
 * ("full"), IncarnaMind wasn't allowed to write it ("denied") or something
 * else went wrong ("error"); IncarnaMind closed while a part was being saved
 * ("closed"); or no audio came in for a while ("stalled"), as when a device changes.
 */
export type AudioLossCause = "full" | "denied" | "error" | "closed" | "stalled";

/** Where a Meeting's speech is turned into text: on this computer, or by a cloud service (#141). */
export type TranscriptionEngine = "local" | "cloud";

/**
 * Why transcription moved to another engine: the one before fell behind or failed, the User
 * chose, or the cloud service's audio reached the monthly cap.
 */
export type EngineSwitchReason = "behind" | "failed" | "user" | "cap";

/**
 * Where a Meeting's Transcript is (#136):
 * - "waiting": nothing has been transcribed or is waiting to be: no audio has come yet.
 * - "preparing": the speech-to-text model is downloading or starting. The
 *   audio is kept meanwhile, and transcribed once it can be.
 * - "live": lines arrive a few seconds behind the Meeting.
 * - "behind": live text fell behind, or couldn't go on: the meeting bar says
 *   "Recording…", and the rest is transcribed once the Meeting stops.
 * - "finishing": stopped; what is left is being transcribed.
 * - "saved": finished, and kept in the Library as a Document (`savedPath` is its own file, inside the data folder).
 * - "empty": stopped with nothing said that could be transcribed: no file is saved.
 * - "failed": it couldn't be finished; `problem` says why.
 */
export type TranscriptState =
  | "waiting"
  | "preparing"
  | "live"
  | "behind"
  | "finishing"
  | "saved"
  | "empty"
  | "failed";

/**
 * What stops a Transcript, each with one thing to do (`retryTranscript`):
 * - "download": the speech-to-text model couldn't be downloaded.
 * - "engine": it couldn't start, or stopped again and again.
 * - "save": the Transcript couldn't be written to the data folder.
 * - "speakers": saved, but the speaker pass (#138) couldn't run: its lines keep the labels of
 *   where they came from. Trying again runs the pass again while the audio is kept.
 */
export interface TranscriptProblem {
  kind: "download" | "engine" | "save" | "speakers";
  message: string;
}

export interface MeetingTranscript {
  /** The Transcript's Document, from its first line: searchable and citable while the Meeting records. */
  documentId: string | null;
  state: TranscriptState;
  /** How many lines it has. */
  lines: number;
  /**
   * The speech being transcribed now, while live: where it starts, in the Meeting's time, its
   * words so far, and whose they are ("Me", "Them" or "Speaker ?", see src/shared/speakers.ts;
   * null in a voice memo).
   */
  partial: { startMs: number; text: string; speaker: string | null } | null;
  /** The speech-to-text model, while it is downloading or failed to. */
  model: TranscriptionModelStatus | null;
  /** The cloud service transcribing the live audio now (#141); null: this computer. */
  cloud: CloudTranscriptionRoute | null;
  /**
   * This computer took over from the cloud service the User chose, during this stretch of
   * recording: where, in the Meeting's time, and why. "dropped": the connection was lost;
   * "refused": the service didn't accept the key; "cap": the month reached the cap;
   * "local-mode": “Keep everything on this computer” is on; "moved": the key now sends the
   * audio somewhere the User hasn't chosen (`TranscriptionServiceStatus.chooseAgain`). Null otherwise.
   */
  fellBack: {
    route: CloudTranscriptionRoute;
    atMs: number;
    reason: "dropped" | "refused" | "cap" | "local-mode" | "moved";
  } | null;
  /** Its own file in the data folder, once saved: kept for the Library, never shown as a path (#763). */
  savedPath: string | null;
  /** Saved, its speakers are being told apart after the call (#138): their labels may still change. */
  separating: boolean;
  problem: TranscriptProblem | null;
}

/** The speech-to-text model on this computer and its download, as the built-in embedding model's. */
export type TranscriptionModelStatus = EmbeddingModelStatus;

export interface MeetingAudio {
  /** Some audio is on this computer. */
  kept: boolean;
  /** When it will be deleted, once the Meeting is paused or stopped; null while recording. */
  expiresAt: string | null;
  /** When the User, or the day's limit, last deleted it. */
  deletedAt: string | null;
}

/** How long a Meeting's audio is kept after its last recording, at most. */
export const MEETING_AUDIO_KEPT_MS = 24 * 60 * 60 * 1000;

export interface CreateMeetingInput {
  /** An empty Mind to hold it. Not given: a new Mind, named for the day. */
  mindId?: string;
  /** The Folder a new Mind goes in; not with `mindId`. Not given: none. */
  folderId?: string | null;
}

export interface StartMeetingInput {
  meetingId: string;
  /** Record the computer's sound too. Defaults to the Settings choice ("What is recorded"). */
  systemAudio?: boolean;
}

// ---------------------------------------------------------------------------
// Outside agents (#351, experimental)

/**
 * Stands for Not in a Folder where a Folder's id goes in a pairing's scope and in an
 * agent's `folderIds`. A Folder's id is a random UUID, so it can't be one.
 */
export const NOT_IN_A_FOLDER_ID = "not-in-a-folder";

/**
 * An outside agent the User connected: an AI agent they run themselves, such
 * as Claude Code or Codex, that uses IncarnaMind as an MCP server. One pairing
 * per agent, on this device only: the agent runs on this computer.
 */
export interface AgentPairing {
  id: string;
  /** What the User calls it, e.g. "Claude Code". Unique among pairings, ignoring case. */
  name: string;
  /**
   * The Folders it may search and read, with their Minds, and `NOT_IN_A_FOLDER_ID` for the
   * Documents in no Folder at the time of each call, without their Minds. None until the
   * User picks some.
   */
  folderIds: string[];
  /** The agent it was set up in, e.g. "codex"; null for one set up by hand. */
  client: string | null;
  /**
   * It may propose changes to the Notes in its Folders (#352), which wait for the User as
   * Proposals; never applied by the agent. Off unless the User allows it.
   */
  propose: boolean;
  /** When it last called IncarnaMind, ISO 8601, UTC; null if it never has. */
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AgentSettings {
  /** Connecting agents is on (Settings → Agents, experimental). Off by default; off, nothing listens. */
  enabled: boolean;
  /**
   * "local-mode": Local mode pauses every pairing, because an agent sends what
   * it reads to an AI model IncarnaMind can't see. Null when nothing pauses them.
   */
  paused: "local-mode" | null;
  pairings: AgentPairing[];
  /** The pairings whose agent has IncarnaMind's Skill installed, as IncarnaMind wrote it. */
  skills: string[];
}

export interface ConnectAgentInput {
  /** Trimmed; must not be empty, nor another pairing's name (ignoring case). */
  name: string;
  /** Folders (by id, or `NOT_IN_A_FOLDER_ID`) it may read; none by default. */
  folderIds?: string[];
  /** The agent it is set up in, e.g. "codex": lower-case letters, digits and hyphens. */
  client?: string;
  /** It may propose changes to the Notes in its Folders (`AgentPairing.propose`); off by default. */
  propose?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  folderIds?: string[];
  propose?: boolean;
}

/** How an agent starts IncarnaMind's server: the command for its MCP settings. */
export interface AgentLaunch {
  command: string;
  args: string[];
  /** Holds the pairing's token: write it only into that agent's own settings, never show or log it. */
  env: Record<string, string>;
}

/** A new pairing, and how its agent starts IncarnaMind's server. */
export interface ConnectedAgent {
  pairing: AgentPairing;
  launch: AgentLaunch;
}

/** The Tools an outside agent can call (see src/core/agents/mcp.ts). */
export const AGENT_TOOLS = [
  "search",
  "read_passages",
  "cite",
  "check_citations",
  "show_citation",
  "list_minds",
  "read_mind",
  "ask",
  "propose_changes",
] as const;

/**
 * The agents Settings → Agents sets IncarnaMind up in, and "other" for the
 * rest (see src/core/agents/clients.ts). A pairing made before an agent
 * stopped being listed keeps its own id, so a pairing's `client` is any text.
 */
export const AGENT_CLIENT_IDS = [
  "claude-desktop",
  "claude-code",
  "codex",
  "cursor",
  "antigravity",
  "workbuddy",
  "other",
] as const;

export type AgentClientId = (typeof AGENT_CLIENT_IDS)[number];

/**
 * How an agent takes IncarnaMind: "bundle", a file its app installs when
 * opened (Claude); "link", a link its app installs from (Cursor);
 * "file", IncarnaMind adds itself to the agent's settings file; "command", one
 * line to paste into a terminal (Claude Code); "manual", settings to paste
 * into the agent's own screen.
 */
export type AgentSetupKind = "bundle" | "link" | "file" | "command" | "manual";

export interface AgentClient {
  id: AgentClientId;
  /** Its own name; empty for "other", which the interface names. */
  name: string;
  /** It looks installed on this computer: such agents are listed first. */
  installed: boolean;
  setup: AgentSetupKind;
  /** Where setting it up puts the Skill that tells it when to use IncarnaMind; null if it reads none. */
  skillPath: string | null;
}

/** What setting an agent up will change in its settings file, the pairing's key hidden. */
export interface AgentSetupPreview {
  path: string;
  /** The lines IncarnaMind adds (or puts in place of its own earlier ones). */
  change: string;
}

/**
 * How setting an agent up went:
 * - "opened": its app opened to finish (Install, in its own dialog);
 * - "wrote": IncarnaMind added itself to its settings file at `path`;
 * - "copy": something for the User to paste (`text`, which holds the key;
 *   `shown` hides it): a command line, or settings for the agent's screen, or
 *   for its settings file at `path` when IncarnaMind couldn't read that file.
 */
export type AgentSetupResult =
  | { kind: "opened"; how: "bundle" | "link" }
  | { kind: "wrote"; path: string }
  | {
      kind: "copy";
      how: "command" | "settings";
      text: string;
      shown: string;
      path?: string;
      /**
       * The Skill (SKILL.md) for the User to add to the agent's own skills
       * folder, by hand, where IncarnaMind couldn't install it. Apart from
       * `text`, which is pasted into a settings field that takes only the settings.
       */
      skill: string;
    };

export interface SetUpAgentInput {
  client: AgentClientId;
  /** The Folders it may read; the User picks at least one. */
  folderIds: string[];
  /** The name the User gave it ("Other agent" only); otherwise its own name. */
  name?: string;
  /** It may propose changes to the Notes in its Folders (`AgentPairing.propose`); off by default. */
  propose?: boolean;
}

export interface SetUpAgent {
  pairing: AgentPairing;
  result: AgentSetupResult;
}

/** An outside agent asked IncarnaMind to show one of its Citations (`show_citation`). */
export interface AgentCitationShown extends DocumentPlace {
  documentId: string;
}

export type AgentToolName = (typeof AGENT_TOOLS)[number];

/**
 * Why an outside agent's call was refused or failed:
 * - "unpaired": its token belongs to no pairing (it was disconnected);
 * - "off": connecting agents is turned off;
 * - "local-mode": Local mode pauses outside agents;
 * - "consent": the User's consent to its data flow was revoked;
 * - "no-folders": it has no Folders to read yet;
 * - "outside-scope": what it asked for is outside its Folders;
 * - "not-found": no such Passage, Document, Mind or Citation;
 * - "chat-not-ready": `ask` needs a chat model that is set up and allowed;
 * - "read-only": it may read but not propose changes (`AgentPairing.propose`);
 * - "changed": the Note changed since the agent read it, so its paragraphs' names may not hold;
 * - "waiting": a paragraph it names has changes waiting for the User, or is being written;
 * - "invalid": its arguments make no sense;
 * - "failed": something went wrong in IncarnaMind (the log says what).
 */
export type AgentProblem =
  | "unpaired"
  | "off"
  | "local-mode"
  | "consent"
  | "no-folders"
  | "outside-scope"
  | "not-found"
  | "chat-not-ready"
  | "read-only"
  | "changed"
  | "waiting"
  | "invalid"
  | "failed";

/** One call an outside agent made, as its activity list shows it. */
export interface AgentActivity {
  id: string;
  pairingId: string;
  tool: AgentToolName;
  /** What it asked, to show: the search words, the Question, the quotes it cited; "" for none. */
  summary: string;
  outcome: "done" | "refused" | "failed";
  /** Why it was refused or failed; null when it was done. */
  problem: AgentProblem | null;
  /** How many Passages, Citations or Minds it got; null when it got none. */
  count: number | null;
  /** The Documents it got text from, by id. */
  documentIds: string[];
  /** What the call did: reading the Documents or a Mind, sending a Question to the chat model. */
  effects: Effect[];
  durationMs: number;
  /** ISO 8601, UTC. */
  at: string;
}

// ---------------------------------------------------------------------------

export interface CoreApi {
  getLibrary(): Promise<LibrarySnapshot>;
  createLibraryGroup(input: LibraryGroupInput): Promise<LibraryGroup>;
  updateLibraryGroup(groupId: string, input: LibraryGroupInput): Promise<LibraryGroup>;
  /**
   * Its Minds, Documents and conversations go to Not in a Folder. Returns what it held,
   * which restoring it puts back.
   */
  deleteLibraryGroup(groupId: string): Promise<FolderDeletion>;
  addLibraryStarterGroups(keys: string[]): Promise<void>;
  /**
   * Saves the Tagging setting: the model for automatic tagging and Organize,
   * and whether new and changed Documents are organized automatically. A
   * classifier of null is Automatic; `organizeWith` left out stays as it was.
   * `automatic` is the switch as shown, and a save can only turn it off.
   * `turnOn` turns it on, and records when, as the consent for the services
   * it sends to now (ADR-0022): only where the line says what goes, as
   * setup's Use this, Settings › Models' Tagging section and Turn on… do.
   * Turned on for one service, it reads off for another until it is turned
   * on there (#2308).
   */
  saveLibrarySettings(
    settings: Omit<LibrarySettings, "classifier" | "organizeWith" | "taggingStopped"> & {
      classifier: LibraryClassifier | null;
      organizeWith?: TaggingClassifier | null;
      turnOn?: boolean;
    },
  ): Promise<void>;
  /**
   * What the Tagging section shows: what Automatic tags with now and
   * why, and the models the User can choose instead, grouped by where they
   * run, with what each costs. Asks Ollama on this computer which decision
   * models it has; sends nothing anywhere else.
   */
  getTaggingModels(): Promise<TaggingModels>;
  /**
   * The current model's destination, automatic tagging by default; classification
   * reads Organize's text model, scan-images its image reader. The flows say
   * whether the User allowed the service.
   */
  getTaggingRoute(flow?: TaggingFlow): Promise<TaggingRoute>;
  /**
   * Organize where there are no Folders to sort into (#2308): asks Organize's model, once, for
   * a few Folders that would hold these Documents, named from what they say in the interface
   * language, and makes them. `classifyDocuments` then suggests one for each. Returns the
   * Folders made, none when no Document has text to read. Throws InvalidInputError with no
   * model for Organize, or one that can't name Folders (a decision model), and what the
   * provider throws; nothing is made then.
   */
  proposeFolders(documentIds: string[]): Promise<LibraryGroup[]>;
  /**
   * Queues selected documents, or all. Organize suggests a Folder for each
   * (a Suggested Folder) and its Tags; manual assignments are preserved, and
   * only their Tags suggested.
   */
  classifyDocuments(documentIds?: string[]): Promise<void>;
  /**
   * Stops automatic Tagging with AI where the Documents waiting to be
   * tagged, or being tagged, are: each of their Folders, and Not in a Folder
   * (null). Nothing more from there is sent to tag, by automatic tagging or by
   * Organize on its own, until `setTaggingWithAi` turns it back on; a re-tag
   * or Organize the User asks for still goes. Kept across restarts. Returns
   * the places it stopped.
   */
  stopTagging(): Promise<(string | null)[]>;
  /** Turns automatic Tagging with AI on, or stops it, in a Folder or Not in a Folder (null). */
  setTaggingWithAi(folderId: string | null, on: boolean): Promise<void>;
  /** Closes the Library's one-time line that automatic tagging and sorting went off (`LibrarySnapshot.automaticOffNotice`). */
  dismissAutomaticOffNotice(): Promise<void>;
  /**
   * A manual choice, including Not in a Folder (null), wins over in-flight classification.
   * Returns the change it made, its place and tagging before and after, for `restoreAssignment`.
   */
  assignDocumentGroup(documentId: string, groupId: string | null): Promise<AssignmentChange>;
  /**
   * Puts a Document's place and tagging back as `before` had them, with who chose it, so an
   * automatic choice stays automatic and Organize may change it again, and a Suggested Folder is
   * a suggestion again, which also takes back its rejection: Organize may offer that Folder for
   * the Document again. Other rejections stay. Each row goes back only while it still equals what
   * the change left there (`after`); a later move, run or re-tag wins and that row is left alone.
   * Returns the change it made, its real rows before and after, or null when it moved neither row.
   */
  restoreAssignment(
    documentId: string,
    before: AssignmentState,
    after: AssignmentState,
  ): Promise<AssignmentChange | null>;
  /**
   * Makes these Documents' Suggested Folders the User's choices, which
   * Organize never changes. Documents with none waiting are left alone; an
   * unknown Document throws and changes nothing. Returns what changed.
   * `checked` gives the Suggested Folder each was checked against (null: none): when one waits
   * for another Folder now, nothing is accepted and it throws InvalidInputError (#2243).
   * `wall` is the Folder wall the assistant checked them behind, given with `checked` (null:
   * outside every wall): the walls are judged again here, when they are filed, so one that gained
   * a wall since takes nothing (#2250). Without it, as To review accepts for the User, the User
   * files anywhere.
   */
  acceptAssignments(
    documentIds: string[],
    checked?: Record<string, string | null>,
    wall?: string | null,
  ): Promise<AssignmentChange[]>;
  /**
   * Turns down these Documents' Suggested Folders: each is left Not in a
   * Folder, and Organize doesn't suggest that Folder for it again. Documents
   * with none waiting are left alone; an unknown Document throws and changes
   * nothing. Returns what changed.
   */
  rejectAssignments(documentIds: string[]): Promise<AssignmentChange[]>;
  /**
   * Moves Minds, Documents and conversations into a Folder, or out of every Folder
   * (null), all or none: an unknown Mind, Document, conversation or Folder changes
   * nothing and throws. A Document's move is a manual choice, which Organize keeps.
   * Returns where each was, for Undo: each Mind and conversation moved back to its
   * `from`, and each Document's `change` put back with `restoreAssignment`.
   * "minds.changed", "library.assignments" and "conversations.changed" follow, once each.
   */
  moveToFolder(move: FolderMoveInput): Promise<FolderMove>;

  /**
   * Brings back deleted Minds with their content, conversations with their messages,
   * Documents with their Passages, text and Tags, Folders with the Minds, conversations and
   * Documents their deletion took out (those in no Folder since)
   * and Tags with their links, all or none, and sends the events any change sends. With `reopen`,
   * Undo putting the User back where they were, a Mind's tabs, which its delete closed, come back
   * where they were and as they were; without it the window stays as it is, since a restore must
   * not replace the Note the User is in. A Mind comes back with its Meeting, as it was, with its
   * Transcript and its audio, unless the audio's day ended meanwhile (#1253). One not deleted is
   * left as it is. Throws, changing nothing, for one deleted permanently or more than
   * `RECENTLY_DELETED_DAYS` ago, or that can't come back now (its name taken, its Linked folder
   * unlinked). Never touches the User's files.
   */
  restore(refs: RestoreRef[], options?: { reopen?: boolean }): Promise<RestoreResult>;
  /**
   * Undoes a Restore: each item goes back to Recently deleted as it was before it came back, with
   * the rows its Restore brought back, deleted at the time it was deleted then, so the Folder it
   * was in and its `RECENTLY_DELETED_DAYS` are as they were. A time outside those days, or in the
   * future, is taken as now, so it never lands expired. Sends the events a delete sends.
   */
  deleteAgain(refs: DeletedAgainRef[]): Promise<void>;
  /**
   * Takes back every change the commands of one of the assistant's Runs made (#1110), the last
   * first: `CommandDone.run`. A change that can't be taken back is skipped and the rest are;
   * called again, it tries those left. Throws NotFoundError for a Run of an earlier session.
   */
  undoCommands(run: string): Promise<CommandsUndone>;
  /** Makes again the changes `undoCommands` took back, as far as it can, saying what it couldn't. */
  redoCommands(run: string): Promise<void>;
  /** What can be restored: the Minds, conversations, Documents, Folders and Tags deleted in the last `RECENTLY_DELETED_DAYS`, newest first. */
  listDeleted(): Promise<DeletedItem[]>;
  /**
   * Drops deleted things' content (a Mind's notes and its Meeting's audio, Transcript and
   * recording details, a conversation's messages and titles, a
   * Document's Passages and text, a Tag's links), keeping each one's id and when it was
   * deleted, so a later sync can pass the
   * deletion on. They can't be restored afterwards. Throws for one not deleted. Never
   * touches the User's files; a copy the old layout made in the data folder (ADR-0010) goes
   * with its Document. Done by itself at start-up `RECENTLY_DELETED_DAYS` after. When a Meeting's
   * file can't be removed yet, the rest is done and it rejects saying so; the file goes at a later
   * start.
   */
  deletePermanently(refs: DeletedRef[]): Promise<void>;

  /** Makes a Mind, in a Folder if given (it must exist), and returns it. */
  createMind(input?: CreateMindInput): Promise<Mind>;
  /**
   * Makes a copy of a Mind, "{name} (copy)", with its Blocks, Citations, checks and sign-offs:
   * the copy is the User's own to change, and the Mind it came from is untouched.
   */
  duplicateMind(mindId: string): Promise<Mind>;
  /**
   * Reads a Word file for the import screen (#104): whether it can be imported, whose
   * document it looks like, and an earlier draft of it imported into the Folder (none, or
   * null: Not in a Folder). Keeps nothing, and changes nothing.
   */
  checkWordFile(path: string, folderId?: string | null): Promise<WordFileCheck>;
  /**
   * Imports a .docx as a new Mind (#104), titled after the file, keeping a copy of its
   * package in the data folder to export back into (#105), so the file may move or go.
   * A file that can't be imported is refused before any Mind is made. Otherwise the Mind
   * is returned at once and fills in with the file's content, a batch at a time
   * (`WordImportProgress` in its document; an import a quit cut short goes on at the
   * next start). Someone else's document makes every Block third-party text (#78).
   */
  importWordFile(input: ImportWordFileInput): Promise<ImportWordFileResult>;
  /**
   * Adds the original of a Mind imported from Word to the Library, in the Mind's Folder,
   * and links the two, as importing with `addOriginal` does (#720): for when that failed.
   * Returns whether it was added. Throws NotFoundError for an unknown Mind, and
   * InvalidInputError for one not imported from Word.
   */
  addWordOriginal(mindId: string, path: string): Promise<boolean>;
  /**
   * The fonts a Mind imported from Word draws its text in, as its Word look names them
   * (#746), for Get info to say which aren't installed; none for any other Mind. Throws
   * NotFoundError for an unknown Mind.
   */
  wordFonts(mindId: string): Promise<string[]>;
  /** Minds that are not deleted, most recently updated first. Editing a Mind's content updates it. */
  listMinds(): Promise<Mind[]>;
  /** Changes a Mind's title (trimmed; empty means "Untitled") and returns the Mind. */
  renameMind(mindId: string, title: string): Promise<Mind>;
  /**
   * Soft-deletes a Mind: it leaves the list, and its rows stay, marked deleted (ADR-0003). Its
   * Meeting goes with it, stopped first if it records, and its Transcript Document and audio stay
   * for `restore` (#1253).
   */
  deleteMind(mindId: string): Promise<void>;
  /**
   * Returns a Mind's content for editing. A client applies `state` to an empty
   * `Y.Doc`, sends its own changes with `applyMindUpdate`, and applies every
   * `"mind.update"` event for the Mind (these include its own changes, which Yjs ignores).
   */
  openMind(mindId: string): Promise<OpenedMind>;
  /**
   * Applies a client's Yjs update to the Mind, pushes it to every client as `"mind.update"`, and
   * stores it. Storage that refuses it doesn't fail the call: the change waits in memory, as
   * `unsavedChanges` says (#1119). Throws `"error.mind.missedChange"` for an update that builds
   * on one the Mind never got: the client sends its whole state then.
   */
  applyMindUpdate(mindId: string, update: Uint8Array): Promise<void>;
  /** Changes to Minds storage refused, kept in memory while the app runs (#1119); null when none. */
  unsavedChanges(): Promise<UnsavedChanges | null>;
  /** Tries now to store the changes `unsavedChanges` names, and says what still waits. */
  saveChangesAgain(): Promise<UnsavedChanges | null>;
  /**
   * How many changes the last run couldn't store before it closed without quitting (a crash, a
   * force-quit), once: later calls give null. Null too when it doesn't know.
   */
  takeLostChanges(): Promise<number | null>;
  /**
   * Tells the core a client stopped editing the Mind, so it can compact the
   * Mind's stored updates and free its memory. Editing the Mind again is fine.
   */
  closeMind(mindId: string): Promise<void>;

  /**
   * Saves a Checkpoint of the Mind as it is now (#113), and returns it. Call
   * it just before an AI change goes into the Mind, with why: accepting
   * changes, Regenerate, Enhance, inserting a comparison table ("compare"), or
   * accepting someone else's changes ("others"). The renderer may call it
   * without waiting, right before sending the change: calls are taken in
   * order. When the Mind hasn't changed since its last Checkpoint, deletions
   * included, nothing new is saved and that one is returned; an idle one is
   * kept for good from then on. Its Citations' Document versions keep their
   * text for as long as it is kept. Throws NotFoundError for an unknown or
   * deleted Mind.
   */
  saveCheckpoint(mindId: string, reason: CheckpointReason): Promise<Checkpoint>;
  /** A Mind's Checkpoints, newest first, and which holds it as it is now. */
  listCheckpoints(mindId: string): Promise<CheckpointList>;
  /**
   * Compares a Checkpoint with another one, or with the Mind now, Block by
   * Block and word by word. Throws NotFoundError for a Checkpoint that isn't
   * one of the Mind's, or is no longer kept.
   */
  compareCheckpoints(input: CompareCheckpointsInput): Promise<MindComparison>;
  /**
   * Brings a Checkpoint's Blocks back as a new change to the Mind, after
   * saving one of the Mind as it is ("restore"): nothing is overwritten, and
   * both stay in History. Proposals that were waiting in it don't come back,
   * so it reads as `compareCheckpoints` showed it. Restoring the `before` it
   * returns takes it back.
   * Throws MindReadOnlyError for a Mind a newer version wrote.
   */
  restoreCheckpoint(mindId: string, checkpointId: string): Promise<RestoredCheckpoint>;
  /**
   * Names a Checkpoint, or (null or blank) takes its name off (#1933). A named one is kept for
   * good. Throws NotFoundError for one that isn't the Mind's, or is no longer kept.
   */
  renameCheckpoint(
    mindId: string,
    checkpointId: string,
    name: string | null,
  ): Promise<RenamedCheckpoint>;

  /**
   * Asks a Question in the assistant (ADR-0017): adds it to the conversation, or starts
   * a conversation with it, and the Answer streams into the conversation ("answer.*"
   * events with its `conversationId`, and each write as "conversation.message"). The
   * Question records the Mind in focus, which its Answer reads, the selection first; a
   * new conversation belongs to that Mind's Folder, or to none. When the Question can't be
   * asked, nothing is kept: no Question, and no conversation. "conversations.changed" follows.
   */
  askInConversation(input: AskInConversationInput): Promise<ConversationAskResult>;
  /**
   * Asks the example's ready Question, whose Answer is written in advance and needs no model, in
   * a new conversation: whatever the User's own Documents are, as in a library that has some
   * before the example is made. Waits while its Documents are still being read, then writes the
   * Answer; Stop in the meantime (`stopExampleReadyQuestion`) writes the Question with a stopped
   * Answer. Throws once the example isn't made, a Document it cites can't be read, or the read
   * hasn't finished in time.
   */
  askExampleReadyQuestion(): Promise<ExampleReadyAsked>;
  /** Stops a waiting `askExampleReadyQuestion`: its Question is kept, and its Answer says Stopped. */
  stopExampleReadyQuestion(): Promise<void>;
  /**
   * Writes an Answer of a conversation again, in place, for its Question as it was asked,
   * reading the Mind it was asked from as that Mind is now.
   */
  regenerateConversationAnswer(input: ConversationAnswerInput): Promise<ConversationAskResult>;
  /**
   * How many Documents a Search scope covers that can be searched now; for a
   * scope of none (null), every Document's. 0: the scope holds none (#748).
   */
  countScopeDocuments(scope?: SearchScope | null): Promise<number>;
  /** Stops an Answer of a conversation being written, keeping what it has, or the judgement of its sentences. */
  stopConversationAnswer(input: ConversationAnswerInput): Promise<void>;
  /**
   * Judges again the sentences of an ended Answer whose Citations are not checked (#2311), on the
   * model that wrote it: Check again on such a Citation's card, and Check the rest past a limit.
   * `limit`: the most it may spend, as `estimateAnswerCheck` gave it; the Answer's own limit when
   * left out. Resolves once each has a result.
   */
  checkAnswerAgain(input: ConversationAnswerInput & { limit?: Money }): Promise<void>;
  /**
   * What judging an ended Answer's sentences whose Citations are not checked costs (#2311), about
   * and at most, for Check the rest to say before it spends; null when nothing is left to judge.
   * Sends nothing.
   */
  estimateAnswerCheck(input: ConversationAnswerInput): Promise<RunEstimate | null>;
  /**
   * How many seconds the model of an Answer of a conversation usually takes
   * before its Answers have words, from its latest ones to a Question of the
   * same kind (one that asks to check or calculate, or not); null with too
   * few to say (#899).
   */
  usualAnswerWait(answerId: string): Promise<number | null>;
  /**
   * The conversations that aren't deleted, newest first: all of them, or those of one
   * Folder (`folderId` null: Not in a Folder). Only the assistant's History lists them.
   */
  listConversations(options?: ListConversationsOptions): Promise<Conversation[]>;
  /** A conversation and its messages, in order. Throws for a deleted or unknown one. */
  getConversation(conversationId: string): Promise<ConversationContent>;
  /**
   * The conversations, in every Folder, whose name or messages hold every word of
   * `query` (English and Chinese, as Document search reads them; the last letters of
   * each word may be still to type), newest first, with the messages that match.
   */
  searchConversations(query: string): Promise<ConversationMatch[]>;
  /**
   * ⌘K's "In your notes": the Minds, not deleted, whose Blocks hold every word of `query`
   * (English and Chinese, as Document search reads them; the last letters of each word may be
   * still to type), best match first, at most 20. Blocks are searched as they are now: words
   * typed a moment ago are found.
   */
  searchMinds(query: string): Promise<MindTextMatch[]>;
  /**
   * Home's Recent: each Mind's first line of text under its name, as the words typed a moment
   * ago are; Minds with none, or not read yet, are left out.
   */
  listMindSnippets(): Promise<MindSnippet[]>;
  /**
   * Home's Recent (D266): each named Mind's whole Yjs document as stored, the one reader of
   * its health there. Reads only: nothing is settled, compacted or written, and a Mind that
   * isn't there or is deleted is left out.
   */
  readMindContents(mindIds: readonly string[]): Promise<MindContentSnapshot[]>;
  /**
   * ⌘K's "In your Documents" and the Library's search: live Documents whose Passages hold every
   * word of `query`, as `searchMinds` reads it, best match first, one Passage each, at most
   * `limit` (20 unless asked; InvalidInputError outside 1 to 200). Keyword search over the
   * Passage index, whatever the embedding settings.
   */
  searchDocumentText(query: string, options?: { limit?: number }): Promise<DocumentTextMatch[]>;
  /**
   * Gives a conversation the title the User typed (trimmed; empty goes back to its own
   * name) and returns it. A name the conversation gives itself never replaces it.
   */
  renameConversation(conversationId: string, title: string): Promise<Conversation>;
  /**
   * Sends a conversation to Recently deleted (`restore` brings it back), stopping an
   * Answer being written in it. Its rows stay, marked deleted (ADR-0003).
   */
  deleteConversation(conversationId: string): Promise<void>;
  /**
   * Where a reference leads now: a link back from a Note to the Answer it came from, or a
   * Block's origin. Restoring what it points into makes it lead there again.
   */
  resolveReference(reference: ArtifactReference): Promise<ReferenceTarget>;
  /** Applies a turn's asked changes without its editor, or null when none remain. */
  applyAskedChanges(input: ApplyAskedChangesInput): Promise<AskedChangeApplication | null>;
  /** Takes back a core-applied change if nothing in its Mind followed it; returns the resulting state, or null when refused. */
  undoAskedChanges(undoId: string): Promise<AskedChangeTransition | null>;
  /** Does a core-applied change again after its Undo, with the same result contract. */
  redoAskedChanges(undoId: string): Promise<AskedChangeTransition | null>;
  /** Lets go of a core-applied change's in-session Review and Undo records. */
  releaseAskedChanges(undoId: string): Promise<void>;
  /**
   * "Add to note" (#201) into a Mind that isn't open in the editor: Blocks at the
   * end of its note (in place of its empty last line), each Citation in them
   * checked again against its Document, with a link back to the Answer. As
   * `proposed`, they wait as changes to accept or reject. What is added at once
   * goes into the record of AI use; a proposal does once it is accepted. The
   * Mind open in the editor adds at its cursor itself, by the same rules.
   */
  addToNote(input: AddToNoteInput): Promise<AddedToNote>;
  /**
   * Takes the Blocks an "Add to note" put into a Mind back out, with their links back. A Block
   * whose words the User changed since it went in stays, and is counted in `kept`.
   */
  undoAddToNote(input: UndoAddToNoteInput): Promise<UndoAddToNoteResult>;
  /**
   * The Conversation each Mind's Blocks came from, by Mind id, for History's names: read from
   * the links back the Blocks keep, so it covers notes made before this version too.
   */
  listNoteConversations(): Promise<NoteConversation[]>;

  getSettings(): Promise<Settings>;
  /**
   * Changes only the fields given and returns the settings now in effect.
   * Turning `suggestWhileWriting` on (or setting it on again) first asks for
   * consent to the "suggestions" flow when the default chat model sends to a
   * service, again if the User declined it before; if they decline, it stays off.
   */
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /**
   * A window's tabs and groups, as it left them last time (the app's window
   * is "main"), without the Minds and Documents deleted since.
   */
  getLayout(windowId: string): Promise<WindowLayout>;
  /**
   * Changes a window's tabs and groups, keeps the layout for the next start,
   * and returns it; "layout.changed" follows. Throws InvalidInputError for a
   * change that names a tab or group the window doesn't have, and
   * NotFoundError for a Mind that isn't there.
   */
  changeLayout(windowId: string, change: LayoutChange): Promise<WindowLayout>;
  /**
   * Adds PDF, TXT and Markdown files on their own, given their absolute
   * paths. Each is indexed where it is, never copied, and queued for
   * processing; "document.status" events report its progress. A file already
   * indexed at that path gives its Document; a file inside a Linked folder
   * is that Linked folder's Document; a file with the content of a missing
   * Document is that Document, moved. The new Documents are one batch; given
   * a Folder (see `AddDocumentsOptions`), they are filed there.
   */
  addDocuments(paths: string[], options?: AddDocumentsOptions): Promise<AddDocumentsResult>;
  /**
   * Keeps text the User pasted as a Markdown Document, so Answers can cite it.
   * The file is written in the data folder ("Saved text"), never next to the
   * User's files, and added on its own like any file: in no Folder, but in the walled Folder of
   * the Note, or of the conversation with no Note open, it was pasted in (`wallOfTurn`). A name taken
   * already gets a number. Throws InvalidInputError for text with no words, and NotFoundError,
   * saving nothing, once that Note or conversation is deleted.
   */
  saveTextAsDocument(
    input: {
      name: string;
      text: string;
    } & TurnPlace,
  ): Promise<Document>;
  /**
   * The walled Folder a Question asked here would be behind, as Answers judge it (#1934): the
   * Note's, else the conversation's when no Note is open; null outside every wall. What the
   * composer shows and files follows it. Throws NotFoundError once that Note or conversation is
   * deleted.
   */
  wallOfTurn(input: TurnPlace): Promise<string | null>;
  /**
   * Saves a web page as a Document (#261): its readable text, without
   * navigation, ads or scripts, kept as a snapshot that Citations point at
   * and the check reads, named by the page's title. The page is fetched from
   * this computer, with a time and size limit, unless `html` is given (a
   * page the app has open), with its article's pictures. Kept as it
   * looks too, if asked, in the background (`WebPageInfo.look`). An address
   * saved already gives its Document, as it is. "document.status" events
   * report its processing. A page that can't be fetched, or that is mostly
   * not text, isn't saved: the result says why.
   */
  saveWebPage(input: SaveWebPageInput): Promise<WebPageResult>;
  /**
   * Keeps a web page Document's last version as it looks (`WebPageLook`),
   * again after it failed, in the background: the User's click is the
   * consent to its full load. Throws NotFoundError for an unknown Document,
   * and InvalidInputError for one that isn't a web page.
   */
  keepWebPageLook(documentId: string): Promise<Document>;
  /**
   * "Fetch again" on a web page Document: its address is fetched anew, and a
   * page that changed becomes a new version. Citations keep pointing at the
   * version they quote. One that can't be fetched now leaves the Document as
   * it was: the result says why. Throws NotFoundError for an unknown
   * Document, and InvalidInputError for one that isn't a web page. In Local
   * mode nothing is fetched unless `localModeOnce` says the User let it.
   */
  fetchWebPageAgain(documentId: string, options?: FetchWebPageAgainOptions): Promise<WebPageResult>;
  /**
   * Documents that are not deleted, missing ones included, most recently
   * added first. With a Folder, only the Documents in it, and in its
   * sub-Folders if asked; with a Tag, only the Documents carrying it; with a
   * Linked folder (or null), only its Documents (or the files added on their own).
   */
  listDocuments(options?: ListDocumentsOptions): Promise<Document[]>;
  /** Returns the renamed Document. Only its name in IncarnaMind changes, never the file. */
  renameDocument(id: string, name: string): Promise<Document>;
  /**
   * Removes a Document from the index: soft-deletes it, its Passages and its
   * Tags, so search ignores them. The file isn't touched. A Document in a
   * Linked folder whose file is still there stays out of the index after
   * later scans, until it is restored, or the Linked folder is removed and
   * linked again.
   */
  deleteDocument(id: string): Promise<void>;
  /** Removes Documents from the index as `deleteDocument` does, all in one step: or none, when one isn't found. */
  deleteDocuments(ids: string[]): Promise<void>;
  /**
   * Processes a Document that failed again, from its file as it is now, e.g.
   * once the User has fixed it. Returns it, queued; "document.status" events
   * report its progress. A last good version it kept stays searched meanwhile. Throws InvalidInputError for a Document that didn't
   * fail, and NotFoundError for an unknown one or one whose file isn't there.
   */
  retryDocument(id: string): Promise<Document>;
  /**
   * Reads a workbook with its hidden and very hidden sheets (`readHidden`, the
   * default), or again without them (`false`), which Undo asks for (#740). The
   * choice is kept for every version after. Returns it, queued;
   * "document.status" events report its progress. Throws InvalidInputError for
   * a Document that isn't a workbook, or one with no hidden sheet left out when
   * asked to read them, and NotFoundError for an unknown one or one whose file
   * isn't there.
   */
  readHiddenSheets(id: string, readHidden?: boolean): Promise<Document>;
  /**
   * Opens a password-protected PDF Document with `password` (#763). When it
   * opens, the password is kept on this device, in the system's keychain, by
   * Document, and the Document is read again with it. "wrong-password" when
   * it doesn't open it: nothing is kept. Throws InvalidInputError for a
   * Document that isn't a PDF, or one that opens without a password, and
   * NotFoundError for an unknown one or one whose file isn't there.
   */
  unlockDocument(input: UnlockDocumentInput): Promise<UnlockDocumentResult>;
  /** Forgets a Document's kept PDF password (#763); its text stays as it was read. */
  forgetDocumentPassword(documentId: string): Promise<void>;
  /**
   * The kept password of a locked PDF Document, for the viewer to open it
   * with and for nothing else; null for any other Document, when none is
   * kept, or when the Document's file isn't being shown (opened with
   * `openDocumentFile` now or in the last few seconds) (#763).
   */
  documentPasswordFor(documentId: string): Promise<string | null>;
  /** The Documents whose PDF password is kept on this device, by id (#763). */
  listDocumentPasswords(): Promise<string[]>;
  /**
   * The text IncarnaMind kept of a Document's current version: what the
   * viewer shows when the file is missing or can't be reached. Throws
   * NotFoundError for an unknown or deleted Document.
   */
  readDocumentText(documentId: string): Promise<DocumentText>;
  /**
   * The text kept of one version of a live Document, its Units `pageFrom` to
   * `pageTo`: the version a Citation was made from, which the viewer shows
   * after the Document changed (#2159). Null when that version's text isn't
   * kept. Throws NotFoundError for an unknown or deleted Document.
   */
  readVersionText(input: ReadVersionTextInput): Promise<DocumentVersionText | null>;
  /**
   * The picture saved of the place a Citation cites, in the version it quotes
   * (#133): how its Location looked, with the text drawn on it, so the viewer
   * shows it as cited after the file changed (#2159). Null when none is saved:
   * the Citation was made before pages were saved, its page couldn't be drawn,
   * or it waits to be. Throws NotFoundError for an unknown or deleted Document.
   */
  readCitedPage(input: ReadCitedPageInput): Promise<DrawnPage | null>;
  /**
   * The scanned pages of a Document's current version, with where their
   * lines are (#397): empty when it has none. Throws NotFoundError for an
   * unknown or deleted Document.
   */
  readScannedText(documentId: string): Promise<ScannedText>;
  /**
   * Whether a Citation's quote was read from a scan (#397), and the words in
   * it the reading wasn't sure of; null when the Units it cites weren't
   * scanned, or its quote isn't in them.
   */
  readScannedQuote(input: ScannedQuoteInput): Promise<ScannedQuote | null>;
  /**
   * A Citation's quote as its Document's text reads it (#905): a word a PDF split at a line end
   * whole again, and a quote that stops at one run to the end of its word. Null when the quote
   * isn't in the Units it cites, which leaves the quote as it is.
   */
  readableQuote(input: ScannedQuoteInput): Promise<string | null>;
  /** The built-in text recognition model's download state (#397). */
  getTextRecognitionModel(): Promise<EmbeddingModelStatus>;
  /**
   * Downloads the built-in text recognition model, or tries again after a
   * failure; once it is ready, Documents whose scanned pages couldn't be
   * read are read again. "textRecognitionModel.status" events report progress.
   */
  downloadTextRecognitionModel(): Promise<EmbeddingModelStatus>;
  /**
   * What linking a folder would take (see `LinkedFolderPreview`), from the
   * files' metadata, without reading or changing anything. Throws for a path
   * that isn't a folder.
   */
  previewLinkedFolder(path: string): Promise<LinkedFolderPreview>;
  /**
   * Links a folder: every supported file in it, at any depth, becomes a
   * Document indexed where it is, newest first, and the folder is watched
   * for changes while the app runs. Returns at once, "scanning";
   * "linkedFolders.changed" and "document.status" events report progress.
   * A folder inside a Linked folder is already linked: that Linked folder is
   * returned. Linked folders inside this one are merged into it, their
   * Documents keeping their ids. Files added on their own that are inside it
   * become its Documents. The Documents its first scan adds are one batch;
   * given a Folder (see `AddDocumentsOptions`), they are filed there.
   */
  addLinkedFolder(path: string, options?: AddDocumentsOptions): Promise<AddedLinkedFolder>;
  /** The Linked folders, in path order. */
  listLinkedFolders(): Promise<LinkedFolder[]>;
  /**
   * The files in a Search scope that couldn't be read, and why (#740): its
   * Documents with no text, password-protected or damaged, and the files in
   * its Linked folders in a format not read, by file name. A scope of none (null) is every
   * Document. Empty when everything in it was read.
   */
  listUnreadFiles(scope?: SearchScope | null): Promise<UnreadFile[]>;
  /**
   * Points a Linked folder at where it is on this computer now, after it was
   * moved or renamed, or when the data folder is opened on another computer
   * (ADR-0020). Its Documents are looked for at their paths inside it and
   * keep their ids, versions, Tags and Citations: a file with the same size
   * and modified time isn't read, and one with the same content isn't
   * processed again. Returns at once, "scanning". Throws InvalidInputError,
   * changing nothing, for a folder inside or around another Linked folder,
   * one that holds none of its files, or one with a file of it already added
   * on its own.
   */
  locateLinkedFolder(linkedFolderId: string, path: string): Promise<LinkedFolder>;
  /**
   * Stops syncing a Linked folder and removes its Documents and Folders from
   * the index. Nothing on disk is touched. Of their stored text, only the
   * Units the Citations in Minds point to are kept, so those Citations can
   * still be checked: "keptCitationTexts.changed" reports them. Its Documents
   * in `options.keep` stay, as files added on their own: Undo of a link keeps
   * those that were there before it (#1361).
   */
  removeLinkedFolder(linkedFolderId: string, options?: { keep?: string[] }): Promise<void>;
  /** The text kept of Documents unlinked with their Linked folder, for the Citations that quote it. */
  listKeptCitationTexts(): Promise<KeptCitationText[]>;
  /**
   * Changes fields of a Document's reference record (#286) as the User typed
   * them: each becomes theirs, so reading the file again never replaces it.
   * A field given its value as it is changes nothing. A DOI is kept without
   * "https://doi.org/", and a date as `ReferenceFields.issued` says. Returns
   * the Document; "references.changed" carries it too. Throws
   * InvalidInputError for a field that isn't one, or a value that can't be
   * (a date or a DOI that isn't one), and NotFoundError for an unknown Document.
   */
  updateReference(documentId: string, patch: ReferencePatch): Promise<Document>;
  /**
   * Puts these fields of a Document's reference record back as they were in
   * `before`, a copy of the record from earlier, each with where its value
   * came from: Undo, after `updateReference` or `lookUpReference`. Returns
   * the Document; "references.changed" carries it too.
   */
  restoreReference(
    documentId: string,
    before: ReferenceRecord,
    fields: ReferenceField[],
  ): Promise<Document>;
  /**
   * The User checked what was read from the file (`fieldsToCheck`): each of those fields
   * becomes theirs, as if typed, so reading the file again never replaces it. Undo is
   * `restoreReference` with the record from before. Returns the Document; "references.changed"
   * carries it too.
   */
  confirmReference(documentId: string): Promise<Document>;
  /**
   * Look up (#286): fetches the record for the Document's DOI from Crossref,
   * or for its arXiv id (from an arXiv address) from arXiv, and fills its
   * empty fields with it, leaving every other field that has a value. The
   * type is the one exception: one read from the file is only a guess from a
   * DOI or an arXiv id, so the service's replaces it, unless the User chose
   * it. Only the identifier is sent, after the User has allowed the "reference-lookup"
   * flow to that service (asked once); never in local mode. Only when the
   * User asks: nothing looks up by itself.
   */
  lookUpReference(documentId: string): Promise<ReferenceLookupResult>;
  /**
   * Looks up each entry of a Mind's reference list in Crossref, by its DOI,
   * else as written; then in OpenAlex when Crossref has no record of it or
   * only one that differs; an arXiv number on arXiv. Calling it is the
   * consent to the "reference-check" flow (ADR-0022); in local mode every
   * entry is "not-checked". One check of a Mind at a time. Answers are kept:
   * a found record for good, a miss for seven days; `again` asks about every
   * miss again.
   */
  checkReferences(mindId: string, options?: { again?: boolean }): Promise<CheckReferencesResult>;
  /** Stops a Mind's `checkReferences`: it gives "cancelled". Stopping none does nothing. */
  stopReferenceCheck(mindId: string): Promise<void>;
  /**
   * Imports the references in a CSL JSON, BibTeX or RIS file (#287), from
   * Zotero, EndNote, Mendeley and others. The format is read from what is in
   * the file. Each reference is matched to a Document by DOI, then arXiv id,
   * then title with the year and first author, and written into its reference
   * record, or into a record with no Document yet if none matches. Fields
   * the User edited, or that Look up filled, are never replaced; importing
   * again updates instead of repeating. An entry that can't be read is
   * reported and the rest are imported. Reads the file only: nothing is sent.
   * "references.importProgress" reports how far it is.
   */
  importReferences(path: string): Promise<ReferenceImportResult>;
  /** Takes an import back: its new records go, and the fields it wrote, unless the User has edited them since. */
  undoReferenceImport(importId: string): Promise<void>;
  /**
   * Adds the attached files an import found for its unmatched references
   * (`ReferenceImportResult.files`) as Documents, each taking its reference's record.
   */
  addImportedReferenceFiles(importId: string): Promise<ReferenceFilesResult>;
  /** The references kept with no Document yet, oldest first. */
  listUnmatchedReferences(): Promise<ReferenceRecord[]>;
  /**
   * Adds a file as a Document and gives it a reference record that has none
   * (`listUnmatchedReferences`): "Add the PDF…". Returns the Document.
   */
  addReferenceFile(recordId: string, path: string): Promise<Document>;

  /** The Source providers Find sources can ask, each with the User's consent decision (#296). */
  listSourceProviders(): Promise<SourceProviderInfo[]>;
  /**
   * Sets, or with null removes, the User's own key for a provider that takes
   * one (openFDA's, GovInfo's). It is kept only in the keychain, sent only to that
   * provider in a header, and never given back. Throws InvalidInputError for
   * a provider that takes none, and SecretStorageError when it can't be kept.
   */
  setSourceProviderKey(providerId: string, key: string | null): Promise<void>;
  /**
   * Find sources (#296): searches the providers asked (every one that
   * searches, by default) for works, and merges what they find, best first.
   * An identifier (a DOI, an arXiv ID, a PubMed ID) is looked up instead.
   * Each provider is sent only the query and its filters, after the User has
   * allowed the "find-sources" flow to it (asked once; a provider declined
   * is skipped, and says so); nothing at all in local mode. The same search
   * again soon after is answered from what was found, without asking again.
   * Throws InvalidInputError for an empty query or a year that can't be one.
   */
  findSources(input: FindSourcesInput): Promise<FindSourcesResult>;
  /**
   * Adds a found work (by its key, from a search this session) to the
   * Library, in the Folder given: its open full text, downloaded (only an
   * open-access copy, never from behind a paywall) and processed into a
   * Document with its reference record filled; or, with no open copy, its
   * reference record alone. A work added before gives what it was added as.
   * A download goes to the provider that gives the copy only once the User
   * has allowed it; nothing in local mode.
   */
  addFoundSource(input: AddFoundSourceInput): Promise<AddFoundSourceResult>;

  /** An example Mind and its Documents, if made (see `Examples`); the credit paper by default. */
  getExamples(group?: ExampleGroup): Promise<Examples>;
  /**
   * The first open's ready Question (see `ReadyQuestion`): about the most recently added of
   * the User's own Documents that a search can answer from, and the example's only while they
   * have none. Null while theirs are still being read, or when there is nothing to ask.
   */
  readyQuestion(): Promise<ReadyQuestion | null>;
  /**
   * Whether a Document is one of the examples' (see `Examples`): read with them,
   * and left out of the User's own Folders, Tags and search (#1942).
   */
  isExampleDocument(documentId: string): Promise<boolean>;
  /**
   * On a first run (no Mind yet, examples never offered before), makes the
   * examples, once. Returns them, or null when nothing was made.
   */
  offerExamples(): Promise<Examples | null>;
  /**
   * Makes the example Mind and its Documents (copies of the shipped files in
   * the data folder, linked), or returns them if they exist. Its Citations
   * are checked once the Documents have been read, and so are its draft's
   * checks, already made. "examples.changed" follows. The credit paper by default.
   */
  createExamples(group?: ExampleGroup): Promise<Examples>;
  /** Deletes the example Mind, and unlinks the example Documents and deletes their copies. */
  removeExamples(group?: ExampleGroup): Promise<void>;
  /**
   * Brings back an example removed in this session, as Undo does: the same Mind
   * from Recently deleted, and its Documents as the same Documents with their
   * files copied again, so its Citations still open them. The credit paper by default.
   */
  restoreExamples(group?: ExampleGroup): Promise<Examples>;
  /** Shows a Linked folder as a tree of Folders or as a flat list. Returns it. */
  setLinkedFolderLayout(linkedFolderId: string, layout: LinkedFolderLayout): Promise<LinkedFolder>;
  /**
   * Pauses a Linked folder's indexing: nothing in it is read, extracted or
   * embedded until it is resumed, which scans it again. Returns it.
   */
  setLinkedFolderPaused(linkedFolderId: string, paused: boolean): Promise<LinkedFolder>;
  /**
   * Downloads the Linked folder's online-only files (reading one makes its
   * sync service download it) and indexes them. Returns at once.
   */
  downloadOnlineOnlyFiles(linkedFolderId: string): Promise<LinkedFolder>;
  /**
   * Checks a Citation again against its Document's current version (see
   * `CitationRecheck`), e.g. after the Document changed; given the version it
   * quotes, in that version too. Nothing is stored: the editor writes the
   * result onto the Citation's node.
   */
  recheckCitation(input: RecheckCitationInput): Promise<RecheckResult>;
  /**
   * Cites words the User selected in a Document's viewer (#101), given in the
   * order selected, one part for each Unit: checked against the current
   * version's text of those Units only, never found somewhere else, and kept
   * there when it isn't found. With no Unit known, it is cited only where
   * the Document has the words in one place.
   */
  citeSelection(input: { documentId: string; parts: SelectedPart[] }): Promise<CitedSelection>;
  /**
   * Searches the Passages of live Documents, best match first: hybrid
   * (keyword and vector) search by default, which is keyword search while
   * embeddings are off, over every Document or only the given ones. A
   * "vector" search throws EmbeddingModelNotReadyError while the embedding
   * model isn't ready, and InvalidInputError while embeddings are off.
   */
  searchPassages(query: string, options?: SearchPassagesOptions): Promise<PassageSearchResult[]>;
  /**
   * Searches as a check or a comparison table does (#80): as the search Tool
   * searches for an Answer, reranked as the User chose, but without the
   * Documents a check leaves out of its evidence (see `EvidenceExclusion`).
   * Those that match are named in `excluded`, with where, so the result can
   * say so and offer Count it.
   */
  searchEvidence(query: string, options?: SearchEvidenceOptions): Promise<EvidenceSearchResult>;
  /**
   * Counts a Document IncarnaMind wrote as evidence from now on ("Count it"),
   * or, with false, leaves it out again: its Undo, and its menu. Returns it,
   * and "document.status" says so. InvalidInputError for a Document
   * IncarnaMind didn't write.
   */
  setCountedAsEvidence(documentId: string, counted: boolean): Promise<Document>;
  /**
   * Keeps a Document as the User's own workings, or with false cites it as any
   * Document again (see `Document.notCited`): its Undo, and its menu. Returns
   * it, and "document.status" says so.
   */
  setNotCited(documentId: string, notCited: boolean): Promise<Document>;
  /** The built-in embedding model and its download. */
  getEmbeddingModel(): Promise<EmbeddingModelStatus>;
  /**
   * Starts downloading the built-in embedding model, or tries again after a
   * failure, resuming what was already downloaded. Returns at once;
   * "embeddingModel.status" events report progress. The core also starts the
   * download by itself as soon as a Document needs the model: only while the
   * built-in model is on, never while embeddings are off.
   */
  downloadEmbeddingModel(): Promise<EmbeddingModelStatus>;

  /** The embedding model document search uses ("off" by default), local mode, and any rebuild under way. */
  getEmbeddingSettings(): Promise<EmbeddingSettings>;
  /**
   * Turns embeddings on with an embedding model, switches to another one (its
   * key goes to the keychain, never the database), or turns them off ("off":
   * any key is deleted, vectors already made stay stored, unused, and every
   * Document is ready once its keyword index is). A cloud provider's
   * "embeddings" flow needs consent first: if the User declines, nothing
   * changes. Turning them on, or a different model, means every Document
   * without its vectors is embedded: each goes back to "embedding", and
   * "embedding.changed" events report the rebuild. Saving the same model
   * again (e.g. with a new key) re-embeds nothing. Refused for a cloud
   * provider while local mode is on.
   */
  saveEmbeddingProvider(input: SaveEmbeddingProviderInput): Promise<EmbeddingSettings>;
  /**
   * Embeds one fixed text, nothing of the User's. A cloud provider's
   * "embeddings" flow needs consent first, as for a chat provider's test.
   */
  testEmbeddingConnection(
    input: TestEmbeddingConnectionInput,
  ): Promise<EmbeddingConnectionTestResult>;
  /** Tries the embedding provider again after an error: Documents waiting for it carry on. */
  retryEmbedding(): Promise<EmbeddingSettings>;
  /**
   * Turns local mode ("keep everything on this computer") on or off on this
   * device. Turning it on switches a cloud embedding provider back to the
   * built-in model, which embeds every Document again (an embedding provider
   * on this computer, e.g. Ollama, is kept), and pauses a reranking service
   * (the built-in reranking model carries on). Questions are then asked only of a
   * model on this computer: a cloud model is refused before anything is sent, and
   * an Answer streaming to one is stopped.
   */
  setLocalOnly(enabled: boolean): Promise<EmbeddingSettings>;

  /** Rerank on this device: the built-in model (the default), a Cohere or Voyage key, or off. */
  getRerankSettings(): Promise<RerankSettings>;
  /**
   * Starts the built-in reranking model's download, or tries it again after
   * a failure. It also starts by itself when the first Documents are ready
   * to search, while the built-in model is chosen. "rerank.changed" events
   * report its progress.
   */
  downloadRerankingModel(): Promise<RerankSettings>;
  /**
   * Sets up rerank, or changes it: from then on document search reranks its
   * candidates. For a service, the "rerank" flow to it needs consent first:
   * if the User declines, nothing changes, and the key goes to the keychain.
   * "built-in" needs neither: it starts downloading the built-in model (or
   * tries again after a failed download); "rerank.changed" events report
   * its progress.
   */
  saveRerankSettings(input: SaveRerankSettingsInput): Promise<RerankSettings>;
  /** Turns reranking off on this device and removes a service's key: search keeps its own order. The built-in model's files are kept. */
  removeRerankSettings(): Promise<RerankSettings>;
  /**
   * Reranks two fixed texts against a fixed query, nothing of the User's,
   * with the given service settings or the saved ones. The "rerank" flow
   * needs consent first. Not for the built-in model.
   */
  testRerankConnection(input?: TestRerankConnectionInput): Promise<ConnectionTestResult>;

  listChatProviders(): Promise<ChatProvider[]>;
  /**
   * Saves a chat provider (its key goes to the keychain, never the database)
   * and makes `modelId` on it the default chat model. Saving the same kind and
   * server again updates the existing provider.
   */
  saveChatProvider(input: SaveChatProviderInput): Promise<ChatProvider>;
  /** Removes a provider and its key. If it held the default model, there is none afterwards. */
  deleteChatProvider(id: string): Promise<void>;
  /** Makes one small real request. A cloud provider's data flow needs consent first. */
  testChatConnection(input: TestChatConnectionInput): Promise<ConnectionTestResult>;
  /**
   * Asks a saved provider for its model list, then sends one word to its quick-tasks
   * model. Neither goes in Local mode; both need the chat flow allowed, which asks the User.
   */
  testChatProvider(providerId: string): Promise<ProviderTestResult>;
  getModelRoles(): Promise<ModelRoles>;
  getChatReadiness(): Promise<ChatReadiness>;
  /**
   * The models a Question's model picker offers: for each saved provider, the
   * models it lists and its default model. Providers are asked without sending
   * any User content, and a cloud one only once the User has allowed the chat
   * flow to it. A provider that isn't asked, or can't be reached, offers its default.
   */
  listChatModels(): Promise<ChatModelGroup[]>;
  /**
   * Puts a model id in a provider's model menu, or takes one out of it, the
   * provider's own included. Any id can be added, listed by the provider or not.
   */
  setChatModelInMenu(input: SetChatModelInMenuInput): Promise<void>;
  /**
   * This month's cost so far, for Settings: what requests billed per token
   * cost, settled and still reserved, and each provider's use. Recorded on
   * this computer only.
   */
  getCostSummary(): Promise<CostSummary>;
  /**
   * The estimate shown before a large run (comparison tables, verify,
   * contradiction watch, Enhance): for a model billed per token, its calls,
   * tokens and price; for a plan or a model on this computer, nothing.
   */
  estimateRun(input: RunEstimateInput): Promise<RunEstimate>;

  /**
   * Compare Documents (#98): puts a comparison table into the Mind, one row
   * per Document and one column per Question, as one change to accept or
   * reject, and fills its cells, each an Answer from its row's Document alone
   * with checked Citations ("comparison.filling" while it does). A model off
   * this computer writes up to 4 cells at once, backing off when its provider
   * limits requests; one on this computer, one at a time. The monthly cap or a
   * plan's limit stops the fill, and the cells left say they weren't checked.
   */
  compareDocuments(input: CompareDocumentsInput): Promise<ComparisonResult>;
  /**
   * Fills a comparison table's cells that have no Answer (`cellToFill`): a
   * column the editor just added or reworded, rows the User added as
   * Documents, or cells a fill left (a quit, the monthly cap, a failure).
   * Given `questionIds`, it fills those columns alone; given `documentIds`,
   * those rows alone; so the others' Answers and problems stay as they are. A
   * fill already going takes them up once its cells are done.
   */
  fillComparisonTable(input: ComparisonFillRequest): Promise<ComparisonResult>;
  /**
   * Moves a comparison table's column: its Question's place and every row's
   * cell with it, as one change of the Mind, so no reader ever sees a half
   * moved table. Its Answers, Citations and marks go with it, and a fill
   * going on keeps writing into its cells.
   */
  moveComparisonColumn(input: ComparisonColumnMove): Promise<ComparisonColumnMoveResult>;
  /** A column's label and Question: a new Question gives it new cells, which the window fills. */
  editComparisonColumn(input: ComparisonColumnEditRequest): Promise<ComparisonColumnEdited>;
  /** A column added beside another, with a waiting cell in every row. */
  insertComparisonColumn(input: ComparisonColumnInsertRequest): Promise<ComparisonColumnAdded>;
  /** A column copied beside itself, its Answers included. */
  duplicateComparisonColumn(
    input: ComparisonColumnDuplicateRequest,
  ): Promise<ComparisonColumnAdded>;
  /** A column and its cells taken out whole. */
  removeComparisonColumn(input: ComparisonColumnRemoveRequest): Promise<ComparisonColumnRemoved>;
  /** A column's width, within the table's bounds; nothing changes when it is the same. */
  resizeComparisonColumn(
    input: ComparisonColumnWidthRequest,
  ): Promise<ComparisonColumnWidthSet | null>;
  /** A column hidden from the table, or shown again; hiding deletes nothing. */
  setComparisonColumnHidden(
    input: ComparisonColumnHiddenRequest,
  ): Promise<ComparisonColumnHiddenSet | null>;
  /**
   * Documents added to a table that exists, as one change of the Mind: a row
   * with a waiting cell under every column, which the window fills for those
   * rows alone.
   */
  addComparisonRows(input: ComparisonRowsAddRequest): Promise<ComparisonRowsAdded>;
  /** A row and its Answers taken out whole. */
  removeComparisonRow(input: ComparisonRowRemoveRequest): Promise<ComparisonRowRemoved>;
  /** A row moved among the rows, as one change of the Mind. */
  moveComparisonRow(input: ComparisonRowMoveRequest): Promise<ComparisonRowMoveResult>;
  /**
   * Takes back the structure change the window names, if it is still the
   * table's latest and that window made it.
   */
  undoComparisonStructure(input: ComparisonStructureRef): Promise<ComparisonStructureUndoResult>;
  /** Does again the structure change its Undo took back. */
  redoComparisonStructure(input: ComparisonStructureRef): Promise<ComparisonStructureUndoResult>;
  /** A window with the Mind open: it flushes and locks for that Mind's column changes. */
  watchComparisonMind(input: ComparisonWatch): Promise<void>;
  /** That window closed the Mind. */
  unwatchComparisonMind(input: ComparisonWatch): Promise<void>;
  /** Its changes for the Mind have reached the core; a waiting structure change may go on. */
  acknowledgeComparisonStructure(input: ComparisonStructureAck): Promise<void>;
  /**
   * Its window is gone (closed or crashed): stop waiting for it on every Mind.
   * The core also drops a window that misses one wait, after that wait.
   */
  forgetComparisonWindow(input: ComparisonWindow): Promise<void>;
  /**
   * Stops filling a comparison table: cells being written stay as they were. With a `pass`,
   * stops that refill alone: its cells are asked no more and write nothing.
   */
  stopComparisonTable(input: ComparisonStopRequest): Promise<void>;
  /** The comparison tables whose cells are being filled now. */
  listFillingComparisons(): Promise<ComparisonTableRef[]>;

  /**
   * Tasks (#126): those not finished, then those finished in the last 7 days,
   * most recent first ("task.changed" as each changes). A comparison table
   * fills as a Task: closing its Mind or quitting doesn't stop it, and it
   * goes on when IncarnaMind starts again.
   */
  listTasks(): Promise<Task[]>;
  /**
   * Pauses a running Task where it is: a step being done (a cell being
   * written) stops and is done again when it resumes, and what it asked is
   * asked again then. A file or Connector change under way finishes first.
   */
  pauseTask(taskId: string): Promise<Task>;
  /** Resumes a paused Task from where it stopped. A Task waiting for an answer resumes once answered. */
  resumeTask(taskId: string): Promise<Task>;
  /** Stops a Task for good: what it did stays, and what it waits for is withdrawn. */
  stopTask(taskId: string): Promise<Task>;
  /** Answers a Task's "unknown-outcome" ask: do the step again, or go on without it. */
  answerTaskAsk(taskId: string, answer: TaskAskAnswer): Promise<Task>;
  /** Every step of a Task, in the order each first started. */
  listTaskSteps(taskId: string): Promise<TaskStep[]>;
  /**
   * Tell it…: a message for a running Task whose kind reads them (`actions`
   * has "tell"), queued until its next step starts, which reads it.
   */
  tellTask(taskId: string, text: string): Promise<Task>;
  /** Takes back a message the Task hasn't read yet; one it read stays. */
  untellTask(taskId: string, messageId: string): Promise<Task>;
  /** A Research Task's plan, each step with how far it is (Plan). */
  getResearchPlan(taskId: string): Promise<ResearchPlanView>;
  /**
   * Research (#130): the steps the composer's model proposes for a topic,
   * before it writes, in the topic's language; or, with `change`, the steps
   * redone as the User said. Only the topic (and the steps) are sent, once
   * the User has allowed the chat flow to the model's service.
   */
  planResearch(input: PlanResearchInput): Promise<ResearchPlanResult>;
  /**
   * Starts a Research Task from its plan: each step searches the Library
   * and, with Web on, the web, as an Answer does, saving the web pages it
   * reads as Documents. It shows in the thread of the Mind it started from.
   */
  startResearch(input: StartResearchInput): Promise<ResearchStartResult>;

  /**
   * Asks a Question: its Answer is written into the Mind right after it, as the
   * model streams it ("answer.*" events follow its progress). Asking a Question
   * that already has an Answer writes it again in place. An Answer the User
   * has edited isn't replaced: the new one is written, once it is finished,
   * as Proposals over the User's version (#94), which stays until they accept
   * a change to it. Nothing is sent when Questions can't be asked yet.
   */
  askQuestion(input: AskQuestionInput): Promise<AskResult>;
  /** Writes an Answer again, in place, from its Question. Same rules as `askQuestion`. */
  regenerateAnswer(input: RegenerateAnswerInput): Promise<AskResult>;
  /**
   * Stops an Answer being written. It keeps what was written so far and is
   * marked "stopped". Stopping a finished Answer does nothing.
   */
  stopAnswer(input: StopAnswerInput): Promise<void>;

  /**
   * At a pause at the end of a paragraph: how it may go on, from the
   * Documents of `scope`, with a checked Citation (#282). The paragraph's end
   * is searched as an Answer's Question is; only when the best Passage
   * matches it strongly is the default chat model asked, with the paragraph
   * and up to 8 Passages, and only once the User has allowed the
   * "suggestions" flow to its service (never asked here: see
   * `updateSettings`); in local mode, only a model on this computer. A
   * suggestion is given only when its quote is found in the Passage it
   * cites. A new request cancels the one before.
   */
  suggestNext(request: SuggestionRequest): Promise<SuggestionOutcome>;
  /** Cancels a suggestion request: it gives "none". Cancelling one that ended does nothing. */
  cancelSuggestion(requestId: string): Promise<void>;
  /**
   * The User accepted a suggestion into its Mind: counted for today, and
   * pushed as "suggestion.accepted". `characters`: how much of it they took.
   */
  acceptSuggestion(input: { suggestionId: string; characters: number }): Promise<void>;
  /** Today's counts, and why suggestions can't be made now. */
  getSuggestionStatus(): Promise<SuggestionStatus>;

  /**
   * Edit with AI (#93): asks the model to change the selected text as
   * `action` says, and writes what it gives back into the Mind as Proposals
   * waiting for the User to accept or reject, never as an edit. Citations the
   * new text keeps stay, checked again; one it would drop stays in a Proposal
   * for the User to review. Sends on the "edits" flow once the User allows it
   * for the model's service; in local mode only a model on this computer is
   * used. Pushes the Proposals as a "mind.update", like any edit.
   */
  editWithAi(input: EditWithAiInput): Promise<EditWithAiResult>;
  /**
   * Makes a change from Edit with AI again (#94), usually one out of date:
   * rejects it and asks the model again, as that request asked, for the text
   * it covered as it is now, the User's edits included. What comes back are
   * new Proposals, written as `editWithAi` writes them; when the model gives
   * the text back as it is, the change just goes ("unchanged"). If the model
   * fails or is stopped, the change stays. Not for changes from other
   * requests (an Answer's Regenerate is `regenerateAnswer`).
   */
  regenerateProposal(input: RegenerateProposalInput): Promise<EditWithAiResult>;
  /** Stops an Edit with AI request: it gives "cancelled". Stopping one that ended does nothing. */
  cancelEdit(requestId: string): Promise<void>;
  /**
   * Check against Documents (#96): checks each sentence the
   * selection touches against the Mind's Folder (or every Document), one at a
   * time, with `checkClaim`. Each sentence gets a `CLAIM_CHECK_MARK` at once,
   * "checking", then its result, pushed as a "mind.update" like any edit.
   * Sends on the "checks" flow once the User allows it for the model's
   * service; in local mode only a model on this computer is used.
   *
   * `check-against-document` instead reads the picked `within` scope in ordered
   * windows on the separate "document-check" flow. It keeps the previous mark
   * unchanged until the read settles, so stopping leaves no partial result.
   */
  checkSentences(input: CheckSentencesInput): Promise<CheckSentencesResult>;
  /**
   * Sizes Check against a Document… for its sentences, or one part, before anything is sent; the
   * read is `checkSentences` with `within` and this plan's `id`. It becomes the Note's latest plan
   * and stops a whole read already running there.
   */
  planDocumentCheck(input: PlanDocumentCheckInput): Promise<DocumentCheckPlan>;
  /** Stops a `checkSentences` request: it gives "cancelled". Stopping one that ended does nothing. */
  cancelCheck(requestId: string): Promise<void>;
  /**
   * The claim-check function (#96): checks one claim against the Documents
   * in a check Run, which is offered the Documents' search and `cite` only
   * (ADR-0013), searching as `searchEvidence` does. A model that refuses,
   * fails or gives no verdict leaves it "not-checked" with the reason.
   * Sends on the "checks" flow, as `checkSentences` does.
   */
  checkClaim(input: CheckClaimInput): Promise<ClaimCheckResult>;
  chooseRecordCiteSource(input: ChooseRecordCiteSourceInput): Promise<ChooseRecordCiteSourceResult>;
  /**
   * Verify (#97): adds a document someone else wrote (a PDF) to the Library,
   * or finds it there, waits until its text is read, and makes a Mind of that
   * text, a paragraph to a Block, each Block's page recorded. A Word file
   * (#110) is imported as a Mind instead, as `importWordFile` imports
   * someone else's, kept to export back into, and resolves once every Block
   * is in it. Its text is the document being checked: third-party (#78), and
   * never its own evidence.
   */
  verifyDocument(input: VerifyDocumentInput): Promise<VerifyDocumentResult>;
  /**
   * Has the model name the sentences of a `verifyDocument` Mind that make
   * claims, and records them in the Mind. Sends the document's sentences on
   * the "checks" flow, as `checkSentences` does. One verify run at a time.
   */
  findClaims(input: VerifyClaimsInput): Promise<FindClaimsResult>;
  /**
   * Checks the claims `findClaims` found, as Check against Documents does,
   * against the Mind's Folder (or every Document), the PDF, its earlier
   * versions and its copies left out. A cloud model checks a few at once.
   * Each gets its mark at once, then its result; the monthly cap or a plan's
   * limit stops the run. `cancelCheck` stops it. One verify run at a time.
   */
  verifyClaims(input: VerifyClaimsInput): Promise<VerifyClaimsResult>;
  /**
   * What "Check for contradictions" would check in a Mind (#112): its cited
   * sentences, or why there is nothing to check. Sends nothing.
   */
  planContradictionCheck(mindId: string): Promise<ContradictionCheckPlan>;
  /**
   * Contradiction watch (#112): checks each cited sentence of a Mind against
   * the other Documents in its Folder, the Documents it cites and IncarnaMind's
   * own files left out, with `checkClaim`. A contradicted sentence gets a
   * "contradiction-watch" `CLAIM_CHECK_MARK`; any such mark on the others goes.
   * A new version of a Document in a Folder starts the same check, in the
   * background, for the Folder's Minds, when the User allowed the "checks"
   * flow for the model's service (`ContradictionWatchRun`). `cancelCheck` stops it.
   */
  checkContradictions(input: CheckContradictionsInput): Promise<CheckContradictionsResult>;
  /**
   * What "Check this Mind" (#737) would send in `mode`, against the Mind's
   * Folder or, with `allDocuments`, every Document; or why there is nothing
   * to check. Sends nothing. In "changed" mode the checks that couldn't be
   * made count as changed.
   */
  planMindCheck(
    mindId: string,
    mode: CheckMindMode,
    allDocuments?: boolean,
  ): Promise<MindCheckPlan>;
  /**
   * Keeps a Note for one Check from its planning until it runs or `cancelCheck` drops it
   * (#2240), so a second window's Check is refused before it plans and asks. False: another
   * request keeps it.
   */
  holdMindCheck(input: HoldMindCheckInput): Promise<boolean>;
  /**
   * The window is gone (#2240): a Note its Check was being planned on, and hadn't run, is free
   * again for another window's Check.
   */
  forgetCheckWindow(input: { clientId: string }): Promise<void>;
  /**
   * The first step of "Check this Mind" (#973): the model names the claims
   * among the sentences `checkMind` would send, so the ask before the run
   * counts and prices them exactly. What it named is kept, and `checkMind`
   * doesn't send those sentences to be sorted again. `cancelCheck` stops it.
   */
  findMindClaims(input: CheckMindInput): Promise<FindMindClaimsResult>;
  /**
   * "Check this Mind" (#737): the model names the claims among the Mind's
   * sentences, leaving out headings, questions and the User's own opinions,
   * then each claim is checked as Check against Documents checks it, against
   * the Mind's Folder (or every Document). In "changed" mode only the checks
   * that need a re-check or couldn't be made, and the sentences never checked
   * since, are sent. In "all" mode a sentence with a check is checked again,
   * and neither it nor a skipped one is sent to the model to be named again.
   * Each claim gets its mark at once, then its result; a cloud model checks a
   * few at once, and the monthly cap or a plan's limit stops the run. Records
   * the run in the Mind (`MindCheckRun`). `cancelCheck` stops it.
   */
  checkMind(input: CheckMindInput): Promise<CheckMindResult>;
  /** The current Note’s figures, projected from its one Check and saved evidence. */
  getFigureSchedule(mindId: string): Promise<FigureSchedule>;
  /**
   * `getFigureSchedule` as a change to the schedule `since` names, one this call gave before:
   * the rows that differ, so the window asks again after every change without the whole
   * schedule crossing over. The whole schedule once the core no longer keeps that one.
   */
  getFigureScheduleChange(mindId: string, since: string | null): Promise<FigureScheduleChange>;
  saveFigureScheduleExport(mindId: string): Promise<SavedExport>;
  /** The Mind's checks that Documents added since could change, with those Documents (#993). Sends nothing. */
  documentsAddedSinceChecks(mindId: string): Promise<DocumentsAddedSince[]>;

  getSecretStorage(): Promise<SecretStorageStatus>;
  /** The User accepts storing keys without keyring protection on this device. */
  acceptPlainTextSecretStorage(): Promise<SecretStorageStatus>;

  /** Looks for Ollama, on its default local port unless another URL is given. */
  detectOllama(input?: { baseUrl?: string }): Promise<OllamaStatus>;
  /** Looks for a preset's server on this computer at its address, and lists its models. */
  detectLocalServer(input: DetectLocalServerInput): Promise<LocalServerStatus>;
  /**
   * Opens Ollama's app and waits, for up to twenty seconds, until Ollama answers; resolves with
   * what `detectOllama` then finds. Rejects when the app can't be opened from here.
   */
  openOllama(input?: { baseUrl?: string }): Promise<OllamaStatus>;
  /**
   * One click "use local models": pulls the model if needed (progress arrives as
   * "ollama.pullProgress" events), saves Ollama as a provider and makes the model the default.
   */
  selectOllama(input?: SelectOllamaInput): Promise<ChatProvider>;

  /** The ChatGPT plan provider: the sign-in, the account's models and their limits this session. */
  getChatGptPlan(): Promise<ChatGptPlanStatus>;
  /**
   * The User clicked "Answer with {model}" on an Answer the plan's limit
   * stopped: Questions for that model (or for the one it stands in for) go
   * to `modelId` until its limit resets. Nothing else ever switches model.
   */
  answerWithPlanModel(input: AnswerWithPlanModelInput): Promise<ChatGptPlanStatus>;
  /** The User chose a model in the chip: Questions no longer go to a stand-in. */
  endPlanStandIn(): Promise<ChatGptPlanStatus>;
  /**
   * "Continue with ChatGPT": opens Sign in with ChatGPT in the User's
   * browser and waits, for a few minutes at most, until they finish.
   * Starting again cancels a sign-in still waiting. `anotherAccount` signs in
   * to a different ChatGPT account than the one this device used before.
   * `replaceUnreadable` is the User's answer to a sign-in that can't be read:
   * sign in again, and replace it only once that completes. Signing in doesn't
   * choose a model: `saveChatProvider` does.
   */
  signInToChatGpt(input?: {
    anotherAccount?: boolean;
    replaceUnreadable?: boolean;
  }): Promise<ChatGptSignInResult>;
  /** Stops waiting for a browser sign-in. */
  cancelChatGptSignIn(): Promise<void>;
  /** Opens the waiting sign-in's page in the browser again; false when none is waiting. */
  reopenChatGptSignIn(): Promise<boolean>;
  /**
   * Ends the ChatGPT sign-in at OpenAI and deletes its tokens from this
   * device. A saved ChatGPT provider then needs a new sign-in.
   */
  signOutOfChatGpt(): Promise<ChatGptSignOutResult>;
  /**
   * The address the browser ended on, pasted by the User when the sign-in
   * didn't come back to IncarnaMind: checked exactly as the browser's own
   * return, and the waiting `signInToChatGpt` finishes with it. A refused
   * address changes nothing.
   */
  pasteChatGptSignInAddress(address: string): Promise<PastedAddressResult>;

  getClaudeAccount(): Promise<ClaudeAccountStatus>;
  /**
   * Waits a few minutes at most for the browser or a pasted code. Signing in
   * doesn't choose a model: saving the "claude-account" provider does, and
   * allows its flows (ADR-0022).
   */
  signInToClaude(): Promise<ClaudeSignInResult>;
  /** Stops waiting for a browser sign-in. Nothing is kept. */
  cancelClaudeSignIn(): Promise<void>;
  /** Opens the waiting sign-in's page in the browser again; false when none is waiting. */
  reopenClaudeSignIn(): Promise<boolean>;
  /** A saved Claude account then needs a new sign-in. */
  signOutOfClaude(): Promise<ClaudeAccountStatus>;
  /** Checked exactly as the browser's own return; a refused one changes nothing. */
  pasteClaudeSignInAddress(address: string): Promise<PastedAddressResult>;

  getCopilot(): Promise<CopilotStatus>;
  /**
   * Shows GitHub's code in the status and waits until the User approves or
   * the code expires; `profile` defaults to IncarnaMind's own app. Saving the
   * "copilot" provider, not signing in, allows its flows (ADR-0022).
   */
  signInToCopilot(input?: { profile?: CopilotProfileId }): Promise<CopilotSignInResult>;
  /** Stops waiting for GitHub. Nothing is kept. */
  cancelCopilotSignIn(): Promise<void>;
  /** A saved Copilot provider then needs a new sign-in. */
  signOutOfCopilot(): Promise<CopilotStatus>;

  /**
   * Every registered external data flow, to each service it currently goes to
   * and each service the User has decided on, with that decision.
   */
  listDataFlows(): Promise<DataFlowStatus[]>;
  /** Consent requests still waiting for an answer, e.g. for a window that opened after they were raised. */
  listConsentRequests(): Promise<ConsentRequest[]>;
  respondToConsent(requestId: string, accept: boolean): Promise<void>;
  /**
   * Forgets the User's decision: the next request on the flow asks again. Returns the time it was
   * forgotten (ISO 8601), for `restoreConsent`; null when there was no decision.
   */
  revokeConsent(flowId: DataFlowId, serviceId: string): Promise<string | null>;
  /**
   * Brings back the decision `revokeConsent` forgot at `revokedAt`, as it was: no more kinds of
   * data than were accepted, the date it was made, even for a service the flow no longer goes
   * to. A decision made since stands, and so does a later forgetting: only the newest comes back.
   */
  restoreConsent(flowId: DataFlowId, serviceId: string, revokedAt: string): Promise<void>;
  /**
   * Every registered external data flow, each with the services it goes to,
   * including a flow that sends nothing now: the Privacy page lists them all.
   */
  listRegisteredDataFlows(): Promise<RegisteredDataFlow[]>;
  /**
   * The User allows a flow to one of its services from Settings, without
   * waiting to be asked, e.g. after declining it. Everything the flow sends
   * counts as accepted, and a request waiting for that flow and service is
   * answered too.
   */
  allowDataFlow(flowId: DataFlowId, serviceId: string): Promise<void>;

  /** Network traffic that carries nothing of the User's, such as update checks and model downloads. */
  listNetworkTraffic(): Promise<NetworkTraffic[]>;
  getPrivacySettings(): Promise<PrivacySettings>;
  /**
   * The folder where Microsoft's model runtime keeps usage data, when it is there and this install
   * is older than the build that stopped adding to it (#2145): its path, so Settings can say where
   * it is. Null otherwise. Only whether the folder exists is looked at, never what is in it.
   */
  getModelRuntimeFolder(): Promise<string | null>;
  /** Shows that folder in the file manager. Does nothing once it is gone. */
  showModelRuntimeFolder(): Promise<void>;
  /**
   * Changes the privacy choices on this device and returns them. Turning crash
   * reports on starts them; turning them off stops them at once. Refused if
   * this copy can't send crash reports.
   */
  updatePrivacySettings(patch: PrivacySettingsPatch): Promise<PrivacySettings>;
  /**
   * Usage data from the interface, such as a Citation opened: sent only while
   * the User agrees. Checked against src/core/usageEvents.ts either way:
   * throws InvalidInputError for an event the interface doesn't send, or a
   * field that isn't declared or doesn't fit.
   */
  recordUsage(event: UiUsageEvent): Promise<void>;
  /** Gives this install a new random ID: events from now on carry it instead of the old one. */
  resetUsageInstallId(): Promise<void>;
  /**
   * Adds what the AI wrote, or proposed and was turned down, to the record of
   * AI use (#292), one entry per input, all or none. Each Mind must exist.
   * Returns the entries. The record stays on this computer; see `AiUseEntry`.
   */
  recordAiUse(inputs: RecordAiUseInput[]): Promise<AiUseEntry[]>;
  /**
   * The record, oldest first, optionally of one Mind. Outcomes are brought up
   * to date with the Minds' content first.
   */
  listAiUse(mindId?: string): Promise<AiUseEntry[]>;
  getAiUseStatus(): Promise<AiUseStatus>;
  /** Empties the record. `restoreAiUse` takes it back. */
  clearAiUse(): Promise<AiUseCleared>;
  /** Brings back what `clearAiUse` emptied at `clearedAt`. */
  restoreAiUse(clearedAt: string): Promise<AiUseStatus>;
  /**
   * Makes the AI use statement of a Mind (#739) as a new Mind for the User to edit: in the
   * Mind's Folder, in the interface language, named after it. It states, as counts drawn from
   * what the Mind records, which models the AI wrote with and for what, how much AI text is in
   * each section and what became of it, and the results of checking Citations and sentences. A
   * figure the record doesn't hold is left out, and nothing is estimated. The Mind itself is
   * left as it is. Throws NotFoundError for an unknown Mind.
   */
  createAiUseStatement(mindId: string): Promise<Mind>;
  /**
   * The Folders of every Linked folder, as a flat list in name order (ignoring
   * case). Build the tree from each Folder's `parentId`; siblings keep the
   * list's order. Each Linked folder's own Folder has no parent.
   */
  listFolders(): Promise<Folder[]>;

  /**
   * Tags that are not deleted, in name order (ignoring case). The preset Tags
   * are created on first run, in the interface language of the time.
   */
  listTags(): Promise<Tag[]>;
  createTag(input: CreateTagInput): Promise<Tag>;
  /**
   * Changes a Tag's name or description and returns the Tag. Documents keep
   * their Tags; "Re-tag" applies the new definition to the automatic ones.
   */
  updateTag(tagId: string, patch: UpdateTagInput): Promise<Tag>;
  /** Soft-deletes a Tag, and takes it off every Document. */
  deleteTag(tagId: string): Promise<void>;
  /**
   * The User puts a Tag on a Document. From then on automatic tagging leaves
   * that Tag on that Document alone. Confirming a Tag automatic tagging
   * applied (e.g. one marked "needs review") is the same: it becomes the
   * User's. Returns the Document.
   */
  addDocumentTag(documentId: string, tagId: string): Promise<Document>;
  /**
   * The User takes a Tag off a Document. The removal is kept, so automatic
   * tagging never puts it back. Returns the Document.
   */
  removeDocumentTag(documentId: string, tagId: string): Promise<Document>;
  /**
   * The User puts a Tag on several Documents at once, as `addDocumentTag`
   * does on each, in one change: if one Document or the Tag doesn't exist,
   * nothing changes. Returns the Documents, in the order given; one
   * "documents.tagged" event carries those that changed.
   */
  addTagToDocuments(documentIds: string[], tagId: string): Promise<Document[]>;
  /** The User takes a Tag off several Documents at once, as `removeDocumentTag` does on each. */
  removeTagFromDocuments(documentIds: string[], tagId: string): Promise<Document[]>;
  /**
   * Puts Tags on Documents back as they were, with who chose them, all or none, without
   * recording a removal: automatic tagging may add a Tag taken off this way. Returns the
   * Documents, in the order given; one "documents.tagged" event carries those that changed.
   */
  revertDocumentTags(links: TagLinkState[]): Promise<Document[]>;
  /**
   * Merges a Tag into another: every Document carrying `tagId` carries
   * `intoTagId` instead, and `tagId` is deleted. Who chose each Tag is kept
   * (the User's choice wins when a Document had both), and a removal the
   * User made of the merged Tag carries over to the other. Returns what it
   * changed, which `restore` undoes.
   */
  mergeTags(tagId: string, intoTagId: string): Promise<TagMerge>;
  /**
   * Recomputes the automatic Tags of these Documents, or of every Document,
   * e.g. after Tag definitions changed. Tags the User added or removed are
   * kept as they are. Returns once the Documents are queued; "documents.tagged"
   * events report progress. Documents still being processed are tagged when they finish.
   */
  retagDocuments(documentIds?: string[]): Promise<void>;
  /**
   * The computer is back online: the Documents whose tagging couldn't reach
   * the AI model are tagged again, once however often it is said.
   */
  backOnline(): Promise<void>;

  /** TypeSafe Jev, the optional tagger: whether it is set up on this device, and how. */
  getJevSettings(): Promise<JevSettings>;
  /**
   * Sets up Jev on this device, or changes its settings. From then on
   * automatic tagging uses Jev instead of the chat model; Documents already
   * tagged keep their Tags until re-tagged. The key goes to the keychain,
   * never the database.
   */
  saveJevSettings(input: SaveJevSettingsInput): Promise<JevSettings>;
  /** Removes Jev's key and settings from this device: automatic tagging uses the chat model again. */
  removeJevSettings(): Promise<JevSettings>;
  /**
   * Asks Jev one question about a fixed text, nothing of the User's. Like a
   * chat provider's test, a cloud service's flow (here "tagging") needs
   * consent first.
   */
  testJevConnection(input?: TestJevConnectionInput): Promise<ConnectionTestResult>;

  /** Connectors that are not deleted, in name order (ignoring case), each with its state. */
  listConnectors(): Promise<Connector[]>;
  /**
   * Adds a Connector, turned on, and starts it: "connectors.changed" events
   * follow its state. A local one's environment values, and a remote one's
   * client secret, go to the keychain; if they can't be stored safely,
   * nothing is added. A remote one that requires a sign-in ends up
   * "needs-sign-in": nothing opens in the browser until `signInToConnector`.
   */
  addConnector(input: AddConnectorInput): Promise<Connector>;
  /**
   * Changes a local Connector's name, command, arguments and environment (an
   * empty `env` keeps the saved values), and starts it again with them. Its
   * Tools' approvals and its data-flow decision stay.
   */
  editConnector(connectorId: string, input: AddLocalConnectorInput): Promise<Connector>;
  /** Turns a Connector on (starting it) or off (stopping its process, or disconnecting). */
  setConnectorEnabled(connectorId: string, enabled: boolean): Promise<Connector>;
  /** Starts a Connector that is on again, e.g. after an error. */
  restartConnector(connectorId: string): Promise<Connector>;
  /**
   * Soft-deletes a Connector: stops it, removes its environment, client
   * secret and sign-in from the keychain, and forgets the User's consent
   * decision for it (for a remote one, unless another Connector uses the same server).
   */
  deleteConnector(connectorId: string): Promise<void>;
  /**
   * Signs in to a remote Connector that is on: discovers its authorization
   * server, registers IncarnaMind with it if needed, opens the sign-in in the
   * User's browser and waits for them, a few minutes at most. Its tokens go
   * to the keychain. Starting again cancels a sign-in still waiting.
   */
  signInToConnector(connectorId: string): Promise<ConnectorSignInResult>;
  /** Stops waiting for a remote Connector's browser sign-in. */
  cancelConnectorSignIn(connectorId: string): Promise<void>;
  /** Deletes a remote Connector's tokens from this device and disconnects it. */
  signOutOfConnector(connectorId: string): Promise<Connector>;
  /**
   * Sets the OAuth app a remote Connector signs in with, for a service that
   * can't register IncarnaMind by itself; null goes back to registering
   * automatically. Either way it signs out first.
   */
  setConnectorClient(connectorId: string, client: ConnectorClientInput | null): Promise<Connector>;
  /** Replaces device-only header secrets and restarts; an empty map removes them and disconnects. Values are never returned. */
  setConnectorHeaders(connectorId: string, headers: Record<string, string>): Promise<Connector>;
  /**
   * What importing an `mcpServers` configuration (Claude Desktop's or
   * Cursor's JSON, pasted or read from a file) would add, without adding anything.
   */
  previewConnectorImport(json: string): Promise<ConnectorImportEntry[]>;
  /** Adds every server of an `mcpServers` configuration that the preview marks "add". */
  importConnectors(json: string): Promise<ConnectorImportResult>;
  /** The reviewed Connectors of Settings › Connectors' Browse, in the directory's order. Reads nothing from the network. */
  listConnectorDirectory(): Promise<ConnectorDirectoryEntry[]>;
  /**
   * Adds a directory entry as a remote Connector named as the service, and
   * starts it, as `addConnector` does, with the User's OAuth app for an
   * "own-app" entry. A Connector already at the entry's URL is returned
   * instead, turned on.
   */
  addConnectorFromDirectory(entryId: string, client?: ConnectorClientInput): Promise<Connector>;
  /**
   * Searches the official MCP Registry for community servers matching what
   * the User typed (two letters or more), asking them the first time
   * ("connector-registry" flow). Nothing is sent in Local mode.
   */
  searchConnectorRegistry(query: string): Promise<ConnectorRegistrySearch>;

  /**
   * The User's approval policies, for the approvals page: every Tool always
   * allowed, every Tool switched to "ask", and every Skill whose scripts
   * always run. Policies of deleted Connectors and Skills aren't listed.
   */
  listApprovalPolicies(): Promise<ApprovalPolicy[]>;
  /**
   * Sets a policy, or with `policy: null` removes it (back to the default).
   * Returns the policy now in effect, or null for the default. "Always run"
   * for a Skill's scripts needs `riskAccepted`.
   */
  setApprovalPolicy(input: SetApprovalPolicyInput): Promise<ApprovalPolicy | null>;
  /** Removes a policy by its id: its subject goes back to the default. Revoking one that's gone does nothing. */
  revokeApprovalPolicy(policyId: string): Promise<void>;
  /** Tool calls still waiting for the User's approval, e.g. for a window that opened after they were raised. */
  listApprovalRequests(): Promise<ApprovalRequest[]>;
  /** The assistant's questions still waiting for the User's answer, oldest first (#1374). */
  listUserQuestions(): Promise<UserQuestionRequest[]>;
  /**
   * Answers one of the assistant's questions. Answering one no longer waiting (answered in
   * another window, or its Answer stopped) does nothing. Throws InvalidInputError for a choice it
   * didn't offer, more than one where one may be chosen, nothing chosen or written, or text where
   * none may be written.
   */
  answerUserQuestion(requestId: string, answer: UserAnswer): Promise<void>;
  /**
   * Says that a command the assistant asked the window to run started, then how it ended (#1421).
   * False: the core no longer waits for it (its Answer stopped before it started, or the window
   * didn't say it started in time), so it counts as not done.
   */
  answerWindowCommand(requestId: string, result: WindowCommandResult): Promise<boolean>;
  /**
   * The window is gone, closed or reloaded (#1421): the commands it was asked to run and hasn't
   * answered weren't done.
   */
  forgetCommandWindow(input: { clientId: string }): Promise<void>;
  /**
   * Answers an approval request. Answering one that's no longer waiting (decided
   * in another window, or its Answer stopped) does nothing. "always-allow" of a
   * Skill script ("always run") is refused unless `options.riskAccepted`: the
   * User must have seen and confirmed the risk warning first.
   */
  respondToApproval(
    requestId: string,
    decision: ApprovalDecision,
    options?: ApprovalResponseOptions,
  ): Promise<void>;

  /** Skills that are not removed, in name order. */
  listSkills(): Promise<Skill[]>;
  /**
   * Reads a Skill folder, or a zip holding one, given its absolute path, and
   * checks it: SKILL.md's frontmatter, paths and links that stay inside the
   * Skill, and its size (`SKILL_LIMITS`). Nothing is imported yet: the preview
   * says what would be, and `importSkill` imports exactly what was read.
   */
  previewSkillImport(path: string): Promise<SkillImportCheck>;
  /**
   * Imports a previewed Skill into the data folder, turned on. A Skill of the
   * same name is replaced, keeping its id and whether it's on. Previews are
   * kept in memory only: after a restart, or a few newer previews, preview again.
   */
  importSkill(importId: string): Promise<Skill>;
  /** Forgets a preview without importing it. Forgetting one that's gone does nothing. */
  cancelSkillImport(importId: string): Promise<void>;
  /** Turns a Skill on or off. Answers list and load only Skills that are on. Returns the Skill. */
  setSkillEnabled(skillId: string, enabled: boolean): Promise<Skill>;
  /**
   * Removes a Skill: soft-deleted in the database (ADR-0003). Its files are
   * deleted once nothing uses them, e.g. after Answers still being written with it finish.
   * A removed built-in Skill stays removed, through updates of the app too,
   * until `restoreBuiltInSkills`.
   */
  removeSkill(skillId: string): Promise<void>;
  /**
   * Copies a Skill as the User's own, e.g. a built-in one, whose files can't
   * be replaced: the same files, named "<name>-copy" (or "<name>-copy-2" and
   * on), turned on, not built-in. Returns the copy.
   */
  duplicateSkill(skillId: string): Promise<Skill>;
  /** A Skill as its editor shows it: its name, its "when to use" and its steps (SKILL.md's instructions). */
  getSkillDraft(skillId: string): Promise<SkillDraft>;
  /**
   * Saves a new Skill the User wrote or edited from a draft, turned on. A name
   * another Skill has is refused (`name-taken`), never replaced.
   */
  createSkill(draft: SkillDraft): Promise<SkillSaveResult>;
  /**
   * Saves what the User changed in a Skill that isn't built-in, keeping its
   * other files and whether it's on. Only the name, the description and the
   * instructions of its SKILL.md change; every other frontmatter field stays as
   * written. Throws for a built-in Skill: duplicate it.
   */
  updateSkill(skillId: string, draft: SkillDraft): Promise<SkillSaveResult>;
  /**
   * Saves a Skill as a zip in the Output location, under the next free name
   * (as `saveMindExport` does, asking where the first time). The zip imports
   * again with the same preview.
   */
  saveSkillExport(skillId: string): Promise<SavedExport>;
  /**
   * The chat model drafts a Skill from what the User just did in a Mind: its
   * Notes, Questions and Answers, the latest weighing most. Sends on the
   * "chat" flow once the User allows it to the model's service, and in local
   * mode only a model on this computer is used. Nothing is saved.
   */
  draftSkillFromMind(input: DraftSkillInput): Promise<DraftSkillResult>;
  /** Stops a `draftSkillFromMind` request. Stopping one that is gone does nothing. */
  cancelSkillDraft(requestId: string): Promise<void>;
  /**
   * The names of the built-in Skills the User removed, which
   * `restoreBuiltInSkills` would install again. Empty when they are all there.
   */
  listRemovedBuiltInSkills(): Promise<string[]>;
  /**
   * Installs again, turned on, the built-in Skills the User removed (those
   * `listRemovedBuiltInSkills` names), with this version's files. Returns them.
   */
  restoreBuiltInSkills(): Promise<Skill[]>;

  /**
   * What `exportMind` will write with these options: the file name, and how
   * many of the exported Citations are unverified, so the User sees that
   * before the file is written.
   */
  previewMindExport(mindId: string, options: ExportMindOptions): Promise<MindExportPreview>;
  /**
   * Exports a Mind as a file, which the host saves: its title, its Notes
   * (those switched out of Question context too), its Answers and, if
   * included, its Questions, in order. Its Citations are in the Mind's
   * citation style (#289): in the text, or as notes, with the Bibliography at
   * the end; in Numbered, each is its own footnote naming its Document and
   * Location, e.g. "Tides, p. 12–13" or "Deck, slide 4"; a web page's also
   * names its site, its address and the day the quoted version was fetched.
   * A Citation is marked "[unverified]" unless its quote was found. Math stays
   * LaTeX in Markdown, becomes Word equations in a .docx, and is typeset in a
   * PDF, which the `printer` adapter prints with each footnote on the page of
   * its marker.
   */
  exportMind(mindId: string, options: ExportMindOptions): Promise<MindExport>;
  /**
   * Prints a Mind as its PDF export lays it out, with each footnote at the foot of its page, in
   * the printer the User chooses. Nothing is saved, and the Mind doesn't change.
   */
  printMind(mindId: string): Promise<void>;
  /**
   * What the Mind's web page to share would hold with these options (Questions, someone's changes
   * waiting): its Documents, their quotes and pictures.
   */
  previewSharePage(mindId: string, options: ExportMindOptions): Promise<SharePagePreview>;
  /**
   * The Documents whose Citations the Mind's web page to share keeps as text, without their
   * page pictures; kept with the Mind.
   */
  setSharePageTextOnly(mindId: string, documentIds: string[]): Promise<void>;
  /**
   * Exports a Mind (as `exportMind`) into the Output location, under the
   * next free name, asking where new files go the first time.
   */
  saveMindExport(mindId: string, options: ExportMindOptions): Promise<SavedMindExport>;
  /**
   * Writes a Mind's export again into the file this Mind's `saveMindExport` saved at `path`
   * since the app opened, in place, as it would be written now: for a choice changed under its
   * Saved line, so no second copy sits beside the first (#110). `checkComments`, for someone
   * else's file, writes with that choice and keeps it for the Note once the file holds it. A file
   * the User changed since is left as it is, and the export is saved beside it instead
   * (`changedFile`). What it replaces is kept for `restoreMindExport`, under the `step` it
   * returns. Throws InvalidInputError for a file another Note exported or this session didn't
   * save, and a plain-words problem naming a file that was moved, deleted or can't be changed.
   */
  rewriteMindExport(
    mindId: string,
    options: ExportMindOptions,
    path: string,
    checkComments?: boolean,
  ): Promise<RewrittenMindExport>;
  /**
   * Undoes the `rewriteMindExport` that returned `step` for `path` (#110): the file's bytes as
   * they were, or, for a file saved beside one the User had changed, no file; and the Note's
   * comment choice as it was. Only the newest step of `path`, and never over a file changed since
   * it was written. Refused, it throws a plain-words problem and leaves the file, the choice and
   * the step as they were, so it can be tried again.
   */
  restoreMindExport(path: string, step: string): Promise<void>;
  /**
   * For a Mind made by Verify from someone else's file (#110): whether its Word export gets
   * comments on what needs a look. Off until the User turns it on, for this Note only, as its
   * comments quote the User's Documents in a file that goes back to its author. Throws
   * InvalidInputError for a Mind that verifies nothing.
   */
  setCheckComments(mindId: string, on: boolean): Promise<void>;
  /**
   * Saves a record of what was checked in a Mind (#738) into the Output location, as
   * `saveMindExport` does, as a PDF and a CSV side by side under one name: each checked sentence
   * and each Citation with its result, the Document version, the model and the time. Nothing is
   * sent anywhere.
   */
  saveCheckRecord(mindId: string): Promise<SavedCheckRecord>;
  /**
   * Saves a comparison table as an Excel workbook (#132) into the Output location, as
   * `saveMindExport` does. A Document a row, a Question a column: each cell its Answer's text,
   * or a number or date with its words as written in its note when the Answer is a single
   * figure, and its Citations in its note; and a Sources sheet, a Citation a row.
   */
  saveComparisonExport(input: ComparisonTableRef): Promise<SavedComparisonExport>;

  /**
   * Formats Citations and their Bibliography in a citation style (#289), from the cited
   * Documents' reference records as they are now. The work is done off the main thread, and a
   * request like the last ones is answered from memory.
   */
  formatCitations(request: CitationFormatRequest): Promise<FormattedCitations>;
  /** The citation style a Mind is in: its own choice, or Numbered, the default. */
  getMindCitationStyle(mindId: string): Promise<MindCitationStyle>;
  /**
   * Chooses the Mind's citation style; null forgets the choice. A style chosen is also the one
   * new Minds in its Folder start in (see `SetMindCitationStyleOptions`). Undo sets the ones
   * before.
   */
  setMindCitationStyle(
    mindId: string,
    style: CitationStyleId | null,
    options?: SetMindCitationStyleOptions,
  ): Promise<MindCitationStyle>;
  /**
   * Every style the app ships but the common ones, for the picker, read from the style pack the
   * first time it is asked for.
   */
  listCitationStyles(): Promise<StyleCatalogue>;
  /** Opens the licence notice of the shipped citation styles in the app that opens text files. */
  openCitationStyleLicences(): Promise<void>;

  /** The font and text size a Mind is written in: its own choice, else the default style. */
  getMindStyle(mindId: string): Promise<MindStyle>;
  /** Sets the Mind's font and text size together, so Undo can put both back. */
  setMindStyle(mindId: string, style: MindStyle): Promise<MindStyle>;
  /**
   * The pages of a Mind, for Page view (#803): each section's size, orientation and margins, and its
   * headers and footers with their page fields, as the Word file it was imported from has them; for
   * any other Mind, the native export's paper (A4 or Letter by region) and margins in one section.
   */
  getPageSetup(mindId: string): Promise<PageSetup>;

  /** Where new files go, and the Linked folders IncarnaMind may or may not add files to. */
  getOutputSettings(): Promise<OutputSettings>;
  /**
   * Sets the Output location: an absolute path to a folder, made if it is the
   * suggested one and isn't there yet. A save waiting to know where goes on there.
   */
  setOutputLocation(path: string): Promise<OutputSettings>;
  /**
   * Allows or stops IncarnaMind adding new files inside a Linked folder (it
   * never changes the files there). A save waiting for that answer goes on with it.
   */
  setLinkedFolderWriting(linkedFolderId: string, allowed: boolean): Promise<OutputSettings>;
  /** Saves waiting for the User's answer, oldest first. */
  listFileWriteRequests(): Promise<FileWriteRequest[]>;
  /** Answers a save's question (see `FileWriteRequest`). One already answered does nothing. */
  respondToFileWrite(requestId: string, accept: boolean): Promise<void>;

  /** Every Meeting, newest first. */
  listMeetings(): Promise<Meeting[]>;
  /**
   * A Meeting ready to record, in a new Mind named for the day or in an empty
   * Mind given: its Mind shows the start block. Needs a Mind with no Meeting,
   * and a copy that can record audio.
   */
  createMeeting(input?: CreateMeetingInput): Promise<Meeting>;
  /** Takes back a Meeting that hasn't started ("Don't record; keep this as a note"): its Mind stays. */
  discardMeeting(meetingId: string): Promise<void>;
  /**
   * Starts recording a ready Meeting: the microphone, and the computer's sound
   * if asked. Needs the one-time recording notice accepted on this device, and
   * no other Meeting recording.
   */
  startMeeting(input: StartMeetingInput): Promise<Meeting>;
  /**
   * Records a voice memo at once (#1568): the microphone alone, in the empty Mind given, else in
   * a new Mind with no title, in the Folder given, so the note's title line names it. Needs what
   * `startMeeting` does; nothing is made when it can't start.
   */
  recordMemo(input?: CreateMeetingInput): Promise<Meeting>;
  pauseMeeting(meetingId: string): Promise<Meeting>;
  /** Records again after a pause, the User's or one IncarnaMind closing made. */
  resumeMeeting(meetingId: string): Promise<Meeting>;
  /** Ends the recording. Its audio is kept for at most a day. */
  stopMeeting(meetingId: string): Promise<Meeting>;
  /** Deletes the Meeting's audio on this computer now; a recording goes on keeping what comes next. */
  deleteMeetingAudio(meetingId: string): Promise<Meeting>;
  /** The cloud services that can transcribe meeting audio (#141), and whether each has a key. */
  listTranscriptionServices(): Promise<TranscriptionServices>;
  /**
   * Keeps a transcription service's own key (Soniox), in the keychain, once the service accepts
   * it. Throws `InvalidInputError` when it refuses the key.
   */
  setTranscriptionKey(input: SetTranscriptionKeyInput): Promise<TranscriptionServices>;
  /** Forgets a transcription service's own key; meeting audio is then transcribed on this computer. */
  removeTranscriptionKey(route: CloudTranscriptionRoute): Promise<TranscriptionServices>;
  /**
   * Whether this computer keeps up with live speech, as the last Meeting transcribed here
   * measured it; null before one has been. The speed probe (#462) will measure it sooner.
   */
  getTranscriptionSpeed(): Promise<{ keepsUp: boolean | null }>;
  /**
   * The speech-to-text model on this computer and its download, or null where this copy can't
   * transcribe. The first Record says its size and offers "Download and start" only while it
   * isn't here (#763).
   */
  getTranscriptionModel(): Promise<TranscriptionModelStatus | null>;
  /**
   * Tries the Meeting's Transcript again after a problem (`MeetingTranscript.problem`):
   * downloads or starts the speech-to-text model, or saves the WebVTT file again.
   */
  retryTranscript(meetingId: string): Promise<Meeting>;
  /**
   * Fills the Meeting's notes in from its Transcript again (#142), after a problem or an Undo:
   * on Try again. The model is the Answers one the User chose; nothing asks first.
   */
  fillMeetingNotes(meetingId: string): Promise<Meeting>;
  /** Takes back what filling in added, leaving the notes as the User left them (#142). */
  undoMeetingFill(meetingId: string): Promise<Meeting>;
  /** Opens the system's settings where the User allows IncarnaMind to record this source. */
  openAudioSettings(source: AudioSource): Promise<void>;
  /**
   * One-click help during the call: asks the button's Question in a conversation, from
   * the Meeting's Mind, while it records or is paused; its Answer is one or two options to
   * say, read from the live transcript and from what the Mind's Folder says about its newest
   * lines. The Meeting's `help` names it. As `askInConversation` otherwise.
   */
  askMeetingHelp(input: AskMeetingHelpInput): Promise<ConversationAskResult>;
  /** Sets the kind of meeting a live Meeting's help buttons are for: its template adds two or three. */
  setMeetingTemplate(input: SetMeetingTemplateInput): Promise<Meeting>;
  /**
   * Pauses the microphone of a Meeting that records or is paused, or resumes it. Paused, nothing
   * from the microphone is saved, transcribed or sent to a transcription service, and the Transcript
   * marks the stretch; the computer's sound goes on. Every Meeting starts with its microphone on.
   */
  setMeetingMicrophone(input: SetMeetingMicrophoneInput): Promise<Meeting>;

  /** Outside agents (#351, experimental): the setting, what pauses them, and every pairing. */
  getAgents(): Promise<AgentSettings>;
  /** Turns connecting agents on or off on this device. Off, nothing listens and every call is refused. */
  setAgentsEnabled(enabled: boolean): Promise<AgentSettings>;
  /**
   * Pairs a new agent, and records the User's consent to its data flow: call
   * it only once the User has confirmed what the agent will be able to read
   * and where that goes. Returns how the agent starts IncarnaMind's server.
   */
  connectAgent(input: ConnectAgentInput): Promise<ConnectedAgent>;
  /** Renames a pairing, or changes the Folders it may read; calls already made keep their activity. */
  updateAgent(pairingId: string, input: UpdateAgentInput): Promise<AgentPairing>;
  /** Unpairs an agent: its token stops working at once, its connections close and its consent goes. */
  disconnectAgent(pairingId: string): Promise<void>;
  /** How a paired agent starts IncarnaMind's server, again: e.g. to set it up in that agent once more. */
  getAgentLaunch(pairingId: string): Promise<AgentLaunch>;
  /** The calls a paired agent made, newest first: the most recent 500. */
  listAgentActivity(pairingId: string): Promise<AgentActivity[]>;
  /** The agents IncarnaMind can be set up in, those on this computer first. */
  listAgentClients(): Promise<AgentClient[]>;
  /** What setting up an agent will change in its settings file; null for one that has none. */
  previewAgentSetup(client: AgentClientId): Promise<AgentSetupPreview | null>;
  /**
   * Pairs an agent and sets IncarnaMind up in it, as `connectAgent` does,
   * once the User has confirmed: opens its app to finish, writes its settings
   * file, or gives what to paste. A setup that fails leaves no pairing.
   */
  setUpAgent(input: SetUpAgentInput): Promise<SetUpAgent>;
  /** Takes a setup just made back: its settings file as it was, and the pairing gone. */
  undoAgentSetup(pairingId: string): Promise<void>;
  /** A paired agent's settings to paste again, e.g. into a second copy of it. */
  copyAgentSetup(pairingId: string): Promise<Extract<AgentSetupResult, { kind: "copy" }>>;
}

/**
 * Events the core pushes to the UI, by name, with their payloads. Tickets that
 * need to push something (processing progress, Answer streams) add their
 * events here. Payloads are plain data (Uint8Array included), so they survive IPC.
 */
/** Why storage refused changes to a Mind (#1119), from the database's own code. */
export type SaveFailureReason = "full" | "io" | "readOnly" | "busy" | "other";

/** Changes to Minds storage refused (#1119): kept in memory while the app runs, tried again. */
export interface UnsavedChanges {
  /** How many changes wait, in all the Minds, deleted ones included (#1202). */
  count: number;
  /** The Minds they wait in, but deleted ones: a copy of those isn't offered. */
  mindIds: string[];
  reason: SaveFailureReason;
  /** The database's own words, for Details. */
  detail: string;
}

export interface CoreEvents {
  /** The settings in effect changed, e.g. the interface language. */
  "settings.changed": Settings;
  /**
   * Minds were created, renamed, moved to another Folder, deleted, restored or edited, or
   * their Folder was deleted or restored: the list as `listMinds` now returns it.
   */
  "minds.changed": Mind[];
  /**
   * Conversations were started, asked in, renamed, moved to another Folder, deleted or
   * restored, or their Folder was deleted or restored: read `listConversations` again.
   */
  "conversations.changed": null;
  /**
   * A message of a conversation, whole: a Question was asked, or an Answer was written
   * (as it streams, at most every 50 ms, and when it ends). Replace it by its `id`.
   */
  "conversation.message": ConversationMessage;
  /** A window's tabs and groups changed: by `changeLayout`, or a deleted Mind's tab closed. */
  "layout.changed": { windowId: string; layout: WindowLayout };
  "examples.changed": Examples;
  /** A Mind's content changed. Clients editing that Mind apply the update to their `Y.Doc`. */
  "mind.update": MindUpdate;
  /** The assistant is writing changes into a Mind as they come (#202), or has stopped. */
  "mind.writing": MindWriting;
  /** Changes storage refused wait in memory, or (null) all of them are stored now (#1119). */
  "minds.unsaved": UnsavedChanges | null;
  /** A Mind's Checkpoints changed: one was saved, kept for good, or thinned out. Read `listCheckpoints` again. */
  "checkpoints.changed": { mindId: string };
  /**
   * A Document was added or restored, or its processing status (or embedding
   * progress) changed, or its creation date, title or reference record was read
   * in the background. Carries the whole Document.
   */
  "document.status": Document;
  /** The built-in embedding model's state changed, or its download made progress. */
  "embeddingModel.status": EmbeddingModelStatus;
  /** The built-in text recognition model's download state changed (#397). */
  "textRecognitionModel.status": EmbeddingModelStatus;
  /**
   * The embedding model search uses changed, or local mode, or a rebuild made
   * progress (a Document finished) or finished, or the provider failed or recovered.
   */
  "embedding.changed": EmbeddingSettings;
  /**
   * Rerank was set up, changed or removed on this device, or paused by local
   * mode; or the built-in reranking model's download moved on.
   */
  "rerank.changed": RerankSettings;
  /** Whether Questions can be asked may have changed. */
  "chatReadiness.changed": ChatReadiness;
  /** The Output location, or what IncarnaMind may do in a Linked folder, changed. */
  "outputSettings.changed": OutputSettings;
  /** A save waits for the User's answer: where new files go, or whether it may add files to a Linked folder. */
  "fileWrite.requested": FileWriteRequest;
  /** A save's question was answered, here or in another window, or withdrawn. */
  "fileWrite.resolved": { requestId: string };
  /** A data flow needs the User's consent before anything is sent. */
  "consent.requested": ConsentRequest;
  /** A consent request was answered, here or in another window. */
  "consent.resolved": { requestId: string; accepted: boolean };
  /** The User allowed or revoked a data flow in Settings. */
  "dataFlows.changed": RegisteredDataFlow[];
  /** The privacy choices changed, e.g. crash reports were turned on. */
  "privacy.changed": PrivacySettings;
  /** The record of AI use gained or lost entries (recorded, cleared or restored). */
  "aiUse.changed": AiUseStatus;
  /** Progress of a model download through Ollama. */
  "ollama.pullProgress": OllamaPullProgress;
  /**
   * Documents whose file moved to another Folder on disk, or into or out of
   * a Linked folder. Carries each moved Document whole.
   */
  "documents.moved": Document[];
  /** Documents removed from the index, by the User or with their Linked folder: their ids. */
  "documents.removed": string[];
  /** A Document renamed, by the User or the assistant (#1110), whole as it is named now. */
  "documents.renamed": Document[];
  /** The Documents whose PDF password is kept changed (#763): their ids now. */
  "documentPasswords.changed": string[];
  /** Folders appeared or went with the folders on disk: the list as `listFolders` now returns it. */
  "folders.changed": Folder[];
  /**
   * Linked folders were added, removed, paused or resumed, or one's status,
   * layout, progress or online-only files changed: the list as
   * `listLinkedFolders` now returns it.
   */
  "linkedFolders.changed": LinkedFolder[];
  /**
   * A Linked folder was unlinked, and the text its Citations quote kept: the
   * list as `listKeptCitationTexts` now returns it.
   */
  "keptCitationTexts.changed": KeptCitationText[];
  /** Tags were created (including the presets), edited, deleted or restored: the list as `listTags` now returns it. */
  "tags.changed": Tag[];
  /**
   * The Library's Folders or settings changed, or a deleted Folder left its
   * Documents Not in a Folder, or a restored one took them back: read the current snapshot.
   */
  "library.changed": null;
  /**
   * Documents' Library assignments changed: Organize queued, started,
   * finished or failed on them, or the User put one in a Folder, or accepted
   * or rejected its Suggested Folder. Carries each
   * one's assignment whole, as `getLibrary` lists it, so the snapshot needn't
   * be read again.
   */
  "library.assignments": DocumentGroupAssignment[];
  /**
   * A batch of Documents added together moved on: one joined it, was read
   * or sorted, or its Suggested Folders changed. Carries the batch whole.
   */
  "documents.batch": DocumentBatch;
  /**
   * Documents' Tags changed, or where automatic tagging is for them: the User
   * added or removed a Tag, automatic tagging started, waited, finished or
   * failed, or a deleted Tag left them. Carries each Document whole.
   */
  "documents.tagged": Document[];
  /**
   * Documents' reference records changed (#286): the User edited one or put
   * one back, or Look up filled one. Reading a record from a file comes with
   * "document.status". Carries each Document whole.
   */
  "references.changed": Document[];
  /** How far a whole read of Check against a Document… is (#1554). */
  "documentCheck.progress": DocumentCheckProgress;
  /** How far a Mind's `checkReferences` is: `done` of `total` entries looked up. */
  "referenceCheck.progress": { mindId: string; done: number; total: number };
  /** `importReferences` has matched `done` of `total` references. */
  "references.importProgress": { done: number; total: number };
  /** The ChatGPT sign-in changed: started, finished, signed out, or expired. */
  "chatGptPlan.changed": ChatGptPlanStatus;
  /** The Claude account sign-in changed: started, finished, signed out, or expired. */
  "claudeAccount.changed": ClaudeAccountStatus;
  /** The Copilot sign-in changed: started, showed its code, finished, signed out, or expired. */
  "copilot.changed": CopilotStatus;
  /** Jev was set up, changed or removed on this device. */
  "jev.changed": JevSettings;
  /**
   * Skills were imported, duplicated, turned on or off, removed or restored:
   * the list as `listSkills` now returns it.
   */
  "skills.changed": Skill[];
  /**
   * Connectors were added, turned on or off, or deleted, or one's state or
   * sign-in changed (connecting, signing in, ready, needs sign-in, error):
   * the list as `listConnectors` now returns it.
   */
  "connectors.changed": Connector[];
  /** Approval policies were set or revoked: the list as `listApprovalPolicies` now returns it. */
  "approvals.changed": ApprovalPolicy[];
  /** A Tool call is waiting for the User's approval: its Answer shows an approval card, in every window. */
  "approval.requested": ApprovalRequest;
  /**
   * An approval request was decided, here or in another window, or its Answer
   * stopped ("deny"): every window takes its card away.
   */
  "approval.resolved": { requestId: string; decision: ApprovalDecision };
  /** The assistant asks the User a question (#1374): it waits in the tray, in every window. */
  "question.asked": UserQuestionRequest;
  /** A question was answered, here or in another window, or withdrawn (null) as its Answer stopped. */
  "question.answered": { requestId: string; answer: UserAnswer | null };
  /** The assistant runs a command of the window's list (#1421): the window that asked runs it. */
  "command.windowRun": WindowCommandRequest;
  /**
   * The Answer event stream. The core writes each Answer into its Mind's Yjs
   * document as it streams (its text, Citations and Tool calls), so every
   * window sees it; these events are for UI state, e.g. the stop button, and
   * for the evaluation.
   */
  "answer.started": AnswerStarted;
  /** The Answer is loading its model, searching, or writing: its meta line says which. */
  "answer.phase": AnswerPhaseEvent;
  "answer.reasoning": AnswerReasoning;
  "answer.delta": AnswerDelta;
  "answer.toolCallStarted": AnswerToolCallEvent;
  "answer.toolCallFinished": AnswerToolCallEvent;
  "answer.citationAdded": AnswerCitationAdded;
  "answer.finished": AnswerFinished;
  "answer.failed": AnswerFailed;
  /** A comparison table's cells started or stopped being filled. */
  "comparison.filling": ComparisonFilling;
  /** A column of a comparison table is being written: every window holds its edits until it lands. */
  "comparison.structure": ComparisonStructureWriting;
  /** A Task started, moved on, waits for the User, paused, resumed or finished. */
  "task.changed": Task;
  /** A Task's notification was clicked: the window opens its Mind, with its row in the tray. */
  "task.shown": TaskShown;
  /** The User accepted a suggestion into a Mind (see `acceptSuggestion`). */
  "suggestion.accepted": SuggestionAccepted;
  /**
   * A Meeting was created, started, paused, resumed, stopped or discarded, a
   * source's state changed, or its audio was saved or deleted: the list as
   * `listMeetings` now returns it.
   */
  "meetings.changed": Meeting[];
  /** About ten times a second while a Meeting's audio is captured: how loud each source is. */
  "meetings.level": MeetingLevel;
  /** A notification that a Meeting's notes were filled in was clicked: its Mind is shown (#142). */
  "meetings.notesShown": { mindId: string };
  /**
   * Connecting agents was turned on or off, Local mode paused or resumed them, or a pairing
   * was made, changed, used or removed: as `getAgents` now returns it.
   */
  "agents.changed": AgentSettings;
  /** An outside agent made a call (see `listAgentActivity`). */
  "agents.activity": AgentActivity;
  /** An outside agent asked to show one of its Citations: open it in the viewer, in front. */
  "agents.citationShown": AgentCitationShown;
}

export type CoreEventName = keyof CoreEvents;

export type CoreEventListener<E extends CoreEventName> = (payload: CoreEvents[E]) => void;

/** Stops a listener. Safe to call more than once. */
export type Unsubscribe = () => void;

/** The push half of the core's public interface. */
export interface CoreEventSource {
  on<E extends CoreEventName>(event: E, listener: CoreEventListener<E>): Unsubscribe;
}

/** What the renderer gets on `window.incarnamind`: every method plus events. */
export type CoreBridge = CoreApi & CoreEventSource;

export type CoreApiMethod = keyof CoreApi;

// A Record over every method name: adding a method to CoreApi without listing it here fails the type-check.
const methods: Record<CoreApiMethod, true> = {
  createMind: true,
  duplicateMind: true,
  checkWordFile: true,
  importWordFile: true,
  addWordOriginal: true,
  wordFonts: true,
  listMinds: true,
  renameMind: true,
  deleteMind: true,
  openMind: true,
  applyMindUpdate: true,
  unsavedChanges: true,
  saveChangesAgain: true,
  takeLostChanges: true,
  closeMind: true,
  saveCheckpoint: true,
  listCheckpoints: true,
  compareCheckpoints: true,
  restoreCheckpoint: true,
  renameCheckpoint: true,
  askInConversation: true,
  askExampleReadyQuestion: true,
  stopExampleReadyQuestion: true,
  regenerateConversationAnswer: true,
  countScopeDocuments: true,
  stopConversationAnswer: true,
  checkAnswerAgain: true,
  estimateAnswerCheck: true,
  usualAnswerWait: true,
  listConversations: true,
  getConversation: true,
  searchConversations: true,
  searchMinds: true,
  listMindSnippets: true,
  readMindContents: true,
  searchDocumentText: true,
  renameConversation: true,
  deleteConversation: true,
  resolveReference: true,
  addToNote: true,
  applyAskedChanges: true,
  undoAskedChanges: true,
  redoAskedChanges: true,
  releaseAskedChanges: true,
  undoAddToNote: true,
  listNoteConversations: true,
  getSettings: true,
  updateSettings: true,
  getLayout: true,
  changeLayout: true,
  addDocuments: true,
  saveWebPage: true,
  keepWebPageLook: true,
  fetchWebPageAgain: true,
  saveTextAsDocument: true,
  wallOfTurn: true,
  listDocuments: true,
  renameDocument: true,
  deleteDocument: true,
  deleteDocuments: true,
  retryDocument: true,
  readHiddenSheets: true,
  unlockDocument: true,
  forgetDocumentPassword: true,
  documentPasswordFor: true,
  listDocumentPasswords: true,
  readDocumentText: true,
  readVersionText: true,
  readCitedPage: true,
  readScannedText: true,
  readScannedQuote: true,
  readableQuote: true,
  getTextRecognitionModel: true,
  downloadTextRecognitionModel: true,
  previewLinkedFolder: true,
  addLinkedFolder: true,
  listLinkedFolders: true,
  listUnreadFiles: true,
  locateLinkedFolder: true,
  removeLinkedFolder: true,
  listKeptCitationTexts: true,
  updateReference: true,
  restoreReference: true,
  confirmReference: true,
  lookUpReference: true,
  checkReferences: true,
  stopReferenceCheck: true,
  listSourceProviders: true,
  setSourceProviderKey: true,
  findSources: true,
  addFoundSource: true,
  importReferences: true,
  undoReferenceImport: true,
  addImportedReferenceFiles: true,
  listUnmatchedReferences: true,
  addReferenceFile: true,
  setLinkedFolderLayout: true,
  setLinkedFolderPaused: true,
  downloadOnlineOnlyFiles: true,
  recheckCitation: true,
  citeSelection: true,
  searchPassages: true,
  searchEvidence: true,
  setCountedAsEvidence: true,
  setNotCited: true,
  getEmbeddingModel: true,
  downloadEmbeddingModel: true,
  getEmbeddingSettings: true,
  saveEmbeddingProvider: true,
  testEmbeddingConnection: true,
  retryEmbedding: true,
  setLocalOnly: true,
  getRerankSettings: true,
  downloadRerankingModel: true,
  saveRerankSettings: true,
  removeRerankSettings: true,
  testRerankConnection: true,
  listChatProviders: true,
  saveChatProvider: true,
  deleteChatProvider: true,
  testChatConnection: true,
  testChatProvider: true,
  getModelRoles: true,
  getChatReadiness: true,
  listChatModels: true,
  setChatModelInMenu: true,
  getCostSummary: true,
  estimateRun: true,
  compareDocuments: true,
  fillComparisonTable: true,
  moveComparisonColumn: true,
  editComparisonColumn: true,
  insertComparisonColumn: true,
  duplicateComparisonColumn: true,
  removeComparisonColumn: true,
  resizeComparisonColumn: true,
  setComparisonColumnHidden: true,
  addComparisonRows: true,
  removeComparisonRow: true,
  moveComparisonRow: true,
  undoComparisonStructure: true,
  redoComparisonStructure: true,
  watchComparisonMind: true,
  unwatchComparisonMind: true,
  acknowledgeComparisonStructure: true,
  forgetComparisonWindow: true,
  stopComparisonTable: true,
  listFillingComparisons: true,
  listTasks: true,
  pauseTask: true,
  resumeTask: true,
  stopTask: true,
  answerTaskAsk: true,
  listTaskSteps: true,
  tellTask: true,
  untellTask: true,
  getResearchPlan: true,
  planResearch: true,
  startResearch: true,
  askQuestion: true,
  regenerateAnswer: true,
  stopAnswer: true,
  suggestNext: true,
  cancelSuggestion: true,
  acceptSuggestion: true,
  getSuggestionStatus: true,
  editWithAi: true,
  regenerateProposal: true,
  cancelEdit: true,
  checkSentences: true,
  planDocumentCheck: true,
  cancelCheck: true,
  checkClaim: true,
  chooseRecordCiteSource: true,
  verifyDocument: true,
  findClaims: true,
  verifyClaims: true,
  planContradictionCheck: true,
  checkContradictions: true,
  planMindCheck: true,
  holdMindCheck: true,
  forgetCheckWindow: true,
  findMindClaims: true,
  checkMind: true,
  getFigureSchedule: true,
  getFigureScheduleChange: true,
  saveFigureScheduleExport: true,
  documentsAddedSinceChecks: true,
  getSecretStorage: true,
  acceptPlainTextSecretStorage: true,
  detectOllama: true,
  detectLocalServer: true,
  openOllama: true,
  selectOllama: true,
  getChatGptPlan: true,
  answerWithPlanModel: true,
  endPlanStandIn: true,
  signInToChatGpt: true,
  cancelChatGptSignIn: true,
  reopenChatGptSignIn: true,
  signOutOfChatGpt: true,
  pasteChatGptSignInAddress: true,
  getClaudeAccount: true,
  signInToClaude: true,
  cancelClaudeSignIn: true,
  reopenClaudeSignIn: true,
  signOutOfClaude: true,
  pasteClaudeSignInAddress: true,
  getCopilot: true,
  signInToCopilot: true,
  cancelCopilotSignIn: true,
  signOutOfCopilot: true,
  listDataFlows: true,
  listConsentRequests: true,
  respondToConsent: true,
  revokeConsent: true,
  restoreConsent: true,
  listRegisteredDataFlows: true,
  allowDataFlow: true,
  listNetworkTraffic: true,
  getPrivacySettings: true,
  getModelRuntimeFolder: true,
  showModelRuntimeFolder: true,
  updatePrivacySettings: true,
  recordUsage: true,
  resetUsageInstallId: true,
  recordAiUse: true,
  listAiUse: true,
  getAiUseStatus: true,
  clearAiUse: true,
  restoreAiUse: true,
  createAiUseStatement: true,
  listFolders: true,
  getLibrary: true,
  createLibraryGroup: true,
  updateLibraryGroup: true,
  deleteLibraryGroup: true,
  addLibraryStarterGroups: true,
  saveLibrarySettings: true,
  getTaggingModels: true,
  getTaggingRoute: true,
  proposeFolders: true,
  classifyDocuments: true,
  stopTagging: true,
  setTaggingWithAi: true,
  dismissAutomaticOffNotice: true,
  assignDocumentGroup: true,
  acceptAssignments: true,
  rejectAssignments: true,
  moveToFolder: true,
  restoreAssignment: true,
  restore: true,
  deleteAgain: true,
  undoCommands: true,
  redoCommands: true,
  listDeleted: true,
  deletePermanently: true,
  listTags: true,
  createTag: true,
  updateTag: true,
  deleteTag: true,
  addDocumentTag: true,
  removeDocumentTag: true,
  addTagToDocuments: true,
  removeTagFromDocuments: true,
  revertDocumentTags: true,
  mergeTags: true,
  retagDocuments: true,
  backOnline: true,
  getJevSettings: true,
  saveJevSettings: true,
  removeJevSettings: true,
  testJevConnection: true,
  listConnectors: true,
  addConnector: true,
  getExamples: true,
  readyQuestion: true,
  isExampleDocument: true,
  offerExamples: true,
  createExamples: true,
  removeExamples: true,
  restoreExamples: true,
  editConnector: true,
  setConnectorEnabled: true,
  restartConnector: true,
  deleteConnector: true,
  signInToConnector: true,
  cancelConnectorSignIn: true,
  signOutOfConnector: true,
  setConnectorClient: true,
  setConnectorHeaders: true,
  previewConnectorImport: true,
  importConnectors: true,
  listConnectorDirectory: true,
  addConnectorFromDirectory: true,
  searchConnectorRegistry: true,
  listApprovalPolicies: true,
  setApprovalPolicy: true,
  revokeApprovalPolicy: true,
  listApprovalRequests: true,
  respondToApproval: true,
  listUserQuestions: true,
  answerUserQuestion: true,
  answerWindowCommand: true,
  forgetCommandWindow: true,
  listSkills: true,
  previewSkillImport: true,
  importSkill: true,
  cancelSkillImport: true,
  setSkillEnabled: true,
  removeSkill: true,
  duplicateSkill: true,
  getSkillDraft: true,
  createSkill: true,
  updateSkill: true,
  saveSkillExport: true,
  draftSkillFromMind: true,
  cancelSkillDraft: true,
  listRemovedBuiltInSkills: true,
  restoreBuiltInSkills: true,
  previewMindExport: true,
  exportMind: true,
  printMind: true,
  previewSharePage: true,
  setSharePageTextOnly: true,
  saveMindExport: true,
  rewriteMindExport: true,
  restoreMindExport: true,
  setCheckComments: true,
  saveCheckRecord: true,
  saveComparisonExport: true,
  formatCitations: true,
  getMindCitationStyle: true,
  setMindCitationStyle: true,
  listCitationStyles: true,
  openCitationStyleLicences: true,
  getMindStyle: true,
  setMindStyle: true,
  getPageSetup: true,
  getOutputSettings: true,
  setOutputLocation: true,
  setLinkedFolderWriting: true,
  listFileWriteRequests: true,
  respondToFileWrite: true,
  listMeetings: true,
  createMeeting: true,
  discardMeeting: true,
  startMeeting: true,
  recordMemo: true,
  pauseMeeting: true,
  resumeMeeting: true,
  stopMeeting: true,
  deleteMeetingAudio: true,
  listTranscriptionServices: true,
  setTranscriptionKey: true,
  removeTranscriptionKey: true,
  getTranscriptionSpeed: true,
  getTranscriptionModel: true,
  retryTranscript: true,
  fillMeetingNotes: true,
  undoMeetingFill: true,
  openAudioSettings: true,
  askMeetingHelp: true,
  setMeetingTemplate: true,
  setMeetingMicrophone: true,
  getAgents: true,
  setAgentsEnabled: true,
  connectAgent: true,
  updateAgent: true,
  disconnectAgent: true,
  getAgentLaunch: true,
  listAgentActivity: true,
  listAgentClients: true,
  previewAgentSetup: true,
  setUpAgent: true,
  undoAgentSetup: true,
  copyAgentSetup: true,
};

/** Every method of CoreApi, used to wire the IPC bridge. */
export const coreApiMethods = Object.keys(methods) as CoreApiMethod[];
