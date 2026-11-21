/**
 * What an outside agent can do with IncarnaMind (#351): the one interface
 * every way in uses, the MCP server now (./mcp), and a command line or an ACP
 * host later. Each call comes from a pairing and is untrusted input, so it is
 * checked here, not in the transport: the pairing must still exist,
 * connecting agents be on, Local mode off and the User's consent in place,
 * and it reaches only the Documents in the pairing's Folders and those
 * Folders' Minds, and, if Not in a Folder is one of them, the Documents in no
 * Folder at the time of each call and the Minds there the pairing wrote itself
 * (#3364), never another's; given all of the User's Documents and Notes, it
 * reaches every Folder outside a wall at the time of each call, and every Mind
 * in no Folder but the examples (#3544). Where a result can read as "nothing is
 * there", it says in one line, naming nothing, when the User has more than the
 * pairing reaches (`holdsMore`). Nothing here changes the
 * User's Documents, and a Mind only through `propose_changes`, which the User
 * allows per pairing and whose changes wait for them as Proposals (#352,
 * ./proposals). With the same leave `create_mind` writes a new Mind (#3306):
 * it changes none there is, so it doesn't wait. In a Mind the pairing wrote
 * itself, its changes apply at once, each a step the User can undo after a
 * Checkpoint (#3371, ./ownChanges).
 *
 * `run_analysis` works a figure out for it, over what it may read alone, with the code
 * IncarnaMind's own check runs (./workings, #3363); a figure it works out itself from numbers
 * Passages give, it hands back with its working, which IncarnaMind confirms (#3393).
 *
 * Only IncarnaMind mints a Citation (./citations): a quote is checked first,
 * by the Citation check Answers use, and gets a token only once found. A
 * search returns each Passage with a ready token for its best-matching
 * sentence, so an agent can cite without a second call. `ask` runs
 * IncarnaMind's own Answer on the User's chat model and returns it with its
 * Citations as tokens. Every call is recorded for the pairing's activity list.
 */

import * as Y from "yjs";
import {
  citedLocation,
  type LiveDocument,
  liveDocumentOf,
  withShownName,
} from "../../shared/citations";
import { formatFullDateTime } from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { isListedMind } from "../../shared/listedMinds";
import { mindName } from "../../shared/naming";
import type { CheckRow } from "../../shared/noteHealth";
import { noteWriterOf, recordNoteWriter } from "../../shared/noteWriter";
import {
  addsOnly,
  changeKinds,
  countChanged,
  decideProposals,
  waitingChanges,
} from "../../shared/proposals";
import { setTextOrigin } from "../../shared/textOrigins";
import type { AnalysisRuntime, NamedFile, Pictures } from "../adapters";
import type { OutsideAnswer } from "../answers";
import type {
  CheckTask,
  Judged,
  JudgedSentence,
  LandedCheck,
  NotJudgedReason,
} from "../answers/checks/judgedOutside";
import type { NotAskedReason, OutsideCheck } from "../answers/checks/mindCheck";
import type { AnswerDocuments } from "../answers/citations";
import type { Citing } from "../answers/citing";
import { matchingTerms } from "../answers/citing";
import { estimateTokens } from "../answers/context";
import { saidBetween, withCueMarks } from "../answers/cueMarks";
import { withoutOverlap } from "../answers/documentText";
import {
  type AgentActivity,
  type AgentCitationShown,
  type AgentNoteChange,
  type AgentOpened,
  type AgentToolName,
  ALL_SHARED_ID,
  BLOCK_ID_ATTRIBUTE,
  type Citation,
  type CitationLocation,
  type CitationRecheck,
  type Effect,
  type LibrarySource,
  type Mind,
  NOT_IN_A_FOLDER_ID,
  NOTE_TAB_NODE,
} from "../api";
import { citedTokens } from "../canvases/markers";
import type { CheckRecord } from "../checkRecord";
import type { CitationSource } from "../documents";
import { keywordTerms } from "../documents/keywords";
import type { WindowedPassage } from "../documents/search";
import type { SearchToolParameters } from "../documents/searchTool";
import { isRecord } from "../errors";
import type { Language } from "../language";
import type { LibraryLists } from "../library/lists";
import type { NoteTranscript } from "../meetings/oneItem";
import { isKnownKind } from "../mindAccess";
import type { Footnote } from "../mindText";
import { insertBlocks } from "../noteAdding";
import { callMarkupIn } from "../tools/callMarkup";
import { type Looking, lookingText } from "./ask";
import {
  type AgentCanvasListed,
  type AgentCanvasPublished,
  type AgentCanvasText,
  type CanvasesInput,
  type CanvasToolDeps,
  createCanvasTools,
} from "./canvases";
import { type AgentCitation, type AgentCitations, CITATION_TOKEN, citeTag } from "./citations";
import type { FileCiting } from "./citedFiles";
import { type AgentHandedFile, createHandedFileTool, type HandedFileToolDeps } from "./handedFiles";
import { howToJudge, OWN_VERDICTS, type OwnVerdict } from "./ownCheck";
import {
  HELD_PICTURE,
  holdPictures,
  inlinePictureChars,
  NOTE_PICTURE_LIMITS,
  readPictures,
} from "./pictures";
import {
  ChangeRefused,
  type CitedToken,
  HeldParagraph,
  type NamedChange,
  type NamedNote,
  type NamedOptions,
  namedNote,
  newBlocks,
  proposeNamed,
} from "./proposals";
import { AgentRefusedError, MAX_PATH_CHARS, NotReachedError, text, whole } from "./refusals";
import type { AgentRequests, RequestNamed } from "./requests";
import type { AgentSorting, SortingBatch, SortingProposal } from "./sorting";
import { openTabs, TAB_FENCE } from "./tabs";
import { CHART_FENCE, type NoteVisuals, type VisualRefused } from "./visuals";
import {
  type AgentAnalysed,
  type AgentReach,
  type AgentWorkings,
  createWorkOut,
  pythonRuns,
  type WorkFor,
  workedFrom,
} from "./workings";

// ---------------------------------------------------------------------------
// The interface

export interface AgentSearchInput {
  /** What to look for, in the words a Document would use. */
  query: string;
  /** Only these of the pairing's Folders; all of them when absent. */
  folderIds?: string[];
  /** Which page of results, from 1. */
  page?: number;
}

/** A Passage as an agent gets it: compact, with a ready Citation. */
export interface AgentPassage {
  passageId: string;
  documentId: string;
  /** The Document's name. */
  document: string;
  /** Where it is, e.g. "p. 12" or "slide 4"; null when the Document has no such units. */
  location: string | null;
  /** Its sentence that best matches the search, checked as found; null if none could be. */
  quote: string | null;
  /** A ready Citation of `quote`, to write as it is; null with `quote`. */
  cite: string | null;
  timedText?: string;
  /** The Passage's text, at most `PASSAGE_CHARS` characters around `quote`. */
  text: string;
}

export interface AgentSearchResult {
  passages: AgentPassage[];
  page: number;
  /** There are more results on the next page. */
  more: boolean;
  /** Present when the User has more than the agent reaches (`holdsMore`): one line, naming nothing. */
  notShared?: string;
}

export interface AgentReadInput {
  /** Read around this Passage. */
  passageId?: string;
  /** Or read this Document from its start, whole or its first part (`READ_PART_TOKENS`). */
  documentId?: string;
  /** Or read on from this Passage, a part's `next`, in a part as large. */
  from?: string;
  /** Passages before `passageId` to read too, at most `MAX_AROUND`. */
  before?: number;
  /** Passages after `passageId` to read too, at most `MAX_AROUND`. */
  after?: number;
}

export interface AgentReadResult {
  documentId: string;
  document: string;
  /** In a part, each Passage's text leaves out what it repeats of the one before it. */
  passages: { passageId: string; location: string | null; text: string; timedText?: string }[];
  /** The Passage before the first one read, to read on backwards; null at the start. */
  previous: string | null;
  /** The Passage after the last one read, to read on; null at the end. */
  next: string | null;
}

export interface AgentCiteInput {
  /** Each quote from a Passage, or from a file on this computer named by its full path (#3509). */
  citations: { passageId?: string; path?: string; quote: string }[];
}

export interface AgentCited {
  /** The Passage the quote was found in; null for a file's quote not found. */
  passageId: string | null;
  quote: string;
  /** "found": the quote is word for word at that Location. Never a verdict on the claim. */
  check: "found" | "not-found" | "cant-check";
  /** The Citation to write, when found; null otherwise. */
  cite: string | null;
  document: string | null;
  location: string | null;
  /** When not found: the Passage's text, to copy the quote from exactly; never a file's. */
  text: string | null;
}

export interface AgentCiteResult {
  citations: AgentCited[];
}

export interface AgentCheckInput {
  /** A draft, with the Citations IncarnaMind gave as they were given. */
  text: string;
}

export interface AgentCheckedCitation {
  cite: string;
  /** "unknown": IncarnaMind never gave this Citation, or not for this agent's Folders. */
  check: "found" | "not-found" | "cant-check" | "unknown";
  document: string | null;
  location: string | null;
  quote: string | null;
  /** The Document changed since it was cited: it was checked against its text now. */
  changed: boolean;
}

export interface AgentCheckResult {
  citations: AgentCheckedCitation[];
  /** Sentences of the draft with no Citation in them, at most `MAX_UNCITED`. */
  uncited: string[];
}

export interface AgentShowInput {
  /** A Citation IncarnaMind gave, e.g. "[cite:k3x9a2b7]". */
  cite: string;
}

export interface AgentShown {
  shown: true;
  document: string;
  location: string | null;
}

export interface AgentMindList {
  folders: {
    id: string;
    name: string;
    /** Its names from the outermost Folder the agent reaches it in, when that is another (#3394). */
    path?: string;
    /** How many Documents are filed in it, not in the Folders inside it, each listed apart. */
    documents: number;
    /** Its Documents by name, the first `MAX_LISTED_DOCUMENTS`: never their text (#3363, #3364). */
    documentList: { id: string; name: string; kind: string }[];
    /**
     * `yours`: this agent wrote it, so its changes there apply at once (#3371). `meeting` or
     * `voiceMemo`: the Note holds one, whose Transcript is listed only here (#3384).
     */
    minds: {
      id: string;
      title: string;
      updatedAt: string;
      yours?: true;
      meeting?: AgentHeldCall;
      voiceMemo?: AgentHeldCall;
    }[];
    /** The Canvases in it the agent reaches (#3406), when there are any. */
    canvases?: AgentCanvasListed[];
  }[];
  /** As `AgentSearchResult.notShared`. */
  notShared?: string;
}

/** A Meeting or voice memo a Note holds, as `list_minds` marks the Note (#3384). */
export interface AgentHeldCall {
  /** When it started, as Answers give a call's date to a model; null when that isn't known. */
  started: string | null;
  /** Its Transcript's documentId, to search and read as any Document. */
  transcript: string;
}

export interface AgentReadMindInput {
  mindId: string;
  /** Where to go on reading, from an earlier result's `nextOffset`. */
  offset?: number;
  /** Each paragraph after its name (¶1, ¶2…), each Citation as its token, to propose changes. */
  named?: boolean;
}

export interface AgentMindText {
  mindId: string;
  title: string;
  folder: string;
  /**
   * The Mind as Markdown, each Citation's footnote starting with its token; or, `named`, a
   * paragraph to a line after its name, each Citation as its token.
   */
  markdown: string;
  offset: number;
  /** Where the next part starts; null when this is the end. */
  nextOffset: number | null;
  /** With `named`: the Note as read, which `propose_changes` names its changes against. */
  version?: string;
  /** In a Note this agent wrote: how many of its sentences hold no check result yet (#3432). */
  next?: string | null;
}

/** One change an agent proposes, for the paragraph `read_mind` named. */
export interface AgentChange {
  /** "¶3" rewrites or takes out ¶3; "¶3+" adds after ¶3; "¶+" adds after the change before. */
  paragraph: string;
  /** The new text, as Markdown, cited only with IncarnaMind's tokens. */
  text?: string;
  /** Take the paragraph out, with "¶n". */
  remove?: boolean;
}

export interface AgentProposeInput {
  mindId: string;
  /** `version` from `read_mind` with `named`. */
  version: string;
  changes: AgentChange[];
}

export interface AgentProposed {
  mindId: string;
  /**
   * "applied": the changes are in the Note now, one step the User can undo, since this agent
   * wrote it (#3371); "waiting": they wait for the User to accept or reject.
   */
  status: "applied" | "waiting";
  /** How many of its changes wait for the User in the Note; 0 once they applied. */
  waiting: number;
  /** How many changes wait in the Note in all, this agent's and any before them. */
  waitingInNote: number;
  /** The Note as it is now, read by name as `read_mind` with `named` reads it: its next change names these. */
  markdown: string;
  nextOffset: number | null;
  version: string;
  /** Each token in the text, checked again against its Document as it is now. */
  citations: AgentCheckedCitation[];
  /** Sentences of the text with no Citation in them, at most `MAX_UNCITED`. */
  uncited: string[];
  /** Each picture or chart that isn't in the Note, and why: the Note has a line saying so (#3413). */
  refused: VisualLeftOut[];
  /**
   * In a Note this agent wrote, how many of its sentences hold no check result now, and that
   * `check_mind_yourself` gives them (#3378); null when none do, and in any other Note.
   */
  next: string | null;
}

export interface AgentCreateInput {
  /** The Note's name. */
  title: string;
  /** Its text, as Markdown, cited only with IncarnaMind's tokens. */
  markdown: string;
  /**
   * The Folder to make it in, of the pairing's, or `NOT_IN_A_FOLDER_ID` for none; may be left
   * out when it has one Folder, or none and reads the Documents in no Folder.
   */
  folderId?: string;
}

export interface AgentCreated {
  mindId: string;
  title: string;
  folder: string;
  /** Each token in the text, checked again against its Document as it is now. */
  citations: AgentCheckedCitation[];
  /** Sentences of the text with no Citation in them, at most `MAX_UNCITED`. */
  uncited: string[];
  /** Each picture or chart that isn't in the Note, and why: the Note has a line saying so (#3413). */
  refused: VisualLeftOut[];
}

/** A picture or chart an agent wrote that isn't in the Note: what it wrote, and why, in words. */
export interface VisualLeftOut {
  item: string;
  reason: string;
}

export interface AgentCheckMindInput {
  /** A Note the agent wrote with `create_mind`. */
  mindId: string;
}

export interface AgentCheckYourselfInput extends AgentCheckMindInput {
  /** Every sentence, its result or not: the agent judges the Note again. */
  again?: boolean;
}

/** A claim of a checked Note that needs a look, isn't checked or can be cited. */
export interface AgentCheckedClaim {
  sentence: string;
  /** The count of the Note's page it is in. */
  group: "needLook" | "notChecked" | "canBeCited";
  /** "supported" only for a sentence that can be cited, "citation-not-found" for one with a Citation whose quote isn't found. */
  result:
    | "supported"
    | "citation-not-found"
    | "unsupported"
    | "contradicted"
    | "not-found"
    | "not-checked"
    | "needs-recheck"
    | "changed";
  /**
   * Why a "not-checked" claim shows no verdict, as the check names it ("rate-limit", "cost-cap"),
   * or "beyond-reach": the User had it checked against Documents this agent may not read.
   */
  reason: string | null;
  /** What the Document says, in the check's words; null when it gave none. */
  says: string | null;
  /** The Passage it was judged on: its Document, Location and quote; null when none backs it. */
  document: string | null;
  location: string | null;
  quote: string | null;
  /** A token to cite that quote by, when it is found in its Document now. */
  cite: string | null;
}

/** A Note's results, counted as its page counts them. */
export interface AgentCheckedNote {
  /** The models that judged, as the Note's check record names them. */
  models: string[];
  /** How many sentences the Note's page counts as supported. */
  supported: number;
  /** How many need a look: unsupported, contradicted, or a quote not found. */
  needLook: number;
  /** How many weren't checked: no verdict, or one the User's wider check made on Documents this agent can't read. */
  notChecked: number;
  /** How many are supported by a Passage no Citation of theirs holds yet: the page's "can be cited". */
  canBeCited: number;
  /** How many sentences the check found to be the writer's own view (#3322): none needs a look. */
  ownViews: number;
  /** The first `MAX_CHECKED_CLAIMS` of the sentences that need a look, then those not checked, then those that can be cited, each in the Note's order. */
  claims: AgentCheckedClaim[];
}

export interface AgentMindCheck extends AgentCheckedNote {
  mindId: string;
  title: string;
  /**
   * "running": the check goes on, and the same call again gives its result.
   * "stopped": it ended early, and `stopped` says why.
   */
  status: "checked" | "running" | "stopped";
  stopped: string | null;
}

/** A Note's sentences that hold no result yet, for the agent to judge with its own model (#3342). */
export interface AgentCheckTask {
  mindId: string;
  title: string;
  /** Hands the results back to this task: `report_check` refuses another state of the Note. */
  task: string;
  /** How to judge the sentences and hand the results back; with none, that none is left. */
  how: string;
  sentences: { n: number; text: string; row?: string; column?: string }[];
  /** With no sentence left, the results the Note holds (#3465). */
  checked?: AgentCheckedNote;
}

export interface AgentReportInput {
  mindId: string;
  task: string;
  results: {
    n: number;
    verdict: string;
    cites?: string[];
    /** The id of a run IncarnaMind made for this agent in this check (#3363). */
    run?: string;
    /**
     * A figure the agent worked out itself (#3393): each input's number with the Citation of its
     * quote, the expression over their names and the figure it gives.
     */
    working?: {
      inputs: { name: string; value: number; cite: string }[];
      expression: string;
      figure: string;
    };
    explanation?: string;
  }[];
}

export interface AgentReported {
  mindId: string;
  title: string;
  /** How many sentences got a mark in the Note. */
  marked: number;
  /**
   * Supported or contradicted with no Citation IncarnaMind could confirm: marked Not checked; and
   * any result naming a run that isn't this agent's, of this check, in its reach: marked nothing.
   */
  unconfirmed: number[];
  unreported: number[];
  /** What to do about those; null when there are none. */
  next: string | null;
}

/** Code to run over a sheet's or CSV file's rows, or the Library's lists, as `run_analysis` takes it. */
export interface AgentAnalysisInput {
  title: string;
  inputs: unknown;
  code: string;
}

export interface AgentAskInput {
  question: string;
  /** Only these of the pairing's Folders; all of them when absent. */
  folderIds?: string[];
}

/** Which of the pairing's waiting requests `read_request` reads: the one about this Note, by name. */
export interface AgentReadRequestInput {
  note?: string;
}

export interface AgentReadRequest {
  /** The Note it is about; null for a request about no Note, and for the answer that none waits. */
  mindId: string | null;
  title: string;
  /** What the User asked, beyond the line they sent: which Note, which sentences, what to do. */
  request: string;
}

export interface AgentAnswer {
  status: "done" | "stopped";
  /** IncarnaMind's Answer in Markdown, each Citation as its token. */
  answer: string;
  /** Its Citations, each found by the Citation check, in order. */
  citations: { cite: string; document: string; location: string | null; quote: string }[];
  /** Citations whose quote wasn't found, or can't be checked: marked in the text, with no token. */
  unchecked: number;
}

/** Everything an outside agent can do: the methods of the core interface every transport uses. */
export interface AgentAccess {
  search(input: AgentSearchInput, signal?: AbortSignal): Promise<AgentSearchResult>;
  readPassages(input: AgentReadInput): Promise<AgentReadResult>;
  cite(input: AgentCiteInput): Promise<AgentCiteResult>;
  checkCitations(input: AgentCheckInput): Promise<AgentCheckResult>;
  /** Opens a Citation in IncarnaMind's viewer, at its quote, in front: chat apps won't open links. */
  showCitation(input: AgentShowInput): Promise<AgentShown>;
  listSorting(after?: string): Promise<SortingBatch>;
  proposeSorting(proposals: SortingProposal[]): Promise<{ waiting: number }>;
  listMinds(): Promise<AgentMindList>;
  readMind(input: AgentReadMindInput): Promise<AgentMindText>;
  ask(input: AgentAskInput, signal?: AbortSignal): Promise<AgentAnswer>;
  /**
   * Changes a Note: at once in a Note this agent wrote, as a step the User can undo (#3371);
   * in any other, as changes that wait for the User (#352).
   */
  proposeChanges(input: AgentProposeInput): Promise<AgentProposed>;
  /** Writes a new Note in one of the pairing's Folders (#3306): there at once, as the agent's text. */
  createMind(input: AgentCreateInput): Promise<AgentCreated>;
  /** Has a Note the agent wrote checked claim by claim against its Folder's Documents (#3317). */
  checkMind(input: AgentCheckMindInput): Promise<AgentMindCheck>;
  /** The sentences of a Note the agent wrote, for it to judge with its own model (#3342). */
  checkMindYourself(input: AgentCheckYourselfInput): Promise<AgentCheckTask>;
  /** Marks the Note with the agent's results, each on the Citations IncarnaMind can confirm. */
  reportCheck(input: AgentReportInput): Promise<AgentReported>;
  /** Runs code over what the agent may read, in IncarnaMind's sandbox (#3363). */
  runAnalysis(input: AgentAnalysisInput, signal?: AbortSignal): Promise<AgentAnalysed>;
  /** Publishes a Canvas where the agent may write (#3406): its version 1. */
  publishCanvas(input: CanvasesInput): Promise<AgentCanvasPublished>;
  /** A Canvas the agent reaches, its newest version's HTML a part at a time. */
  readCanvas(input: { canvasId?: unknown; offset?: unknown }): Promise<AgentCanvasText>;
  /** A Canvas's next version, built on the one the agent read. */
  updateCanvas(
    input: CanvasesInput & { canvasId?: unknown; version?: unknown },
  ): Promise<AgentCanvasPublished>;
  /** What the User asked this agent from IncarnaMind beyond the line they sent, read once (#3419). */
  readRequest(input: AgentReadRequestInput): Promise<AgentReadRequest>;
  /**
   * Keeps a file the agent made, named by its path, as an item with its versions, and checks it
   * against the User's Documents (#3412).
   */
  handOverFile(input: { path?: unknown; folderId?: unknown }): Promise<AgentHandedFile>;
}

export { AgentRefusedError } from "./refusals";

// ---------------------------------------------------------------------------
// Limits

/** Results per page of a search. */
export const SEARCH_PAGE_SIZE = 5;
/** The last page a search goes to. */
export const MAX_SEARCH_PAGE = 5;
/** The most characters of a Passage a result carries. */
export const PASSAGE_CHARS = 1200;
/** The most Passages read before or after one. */
export const MAX_AROUND = 3;
/**
 * The most tokens one part of a Document carries, as `estimateTokens` counts its result: an
 * hour-long interview in two or three parts. Codex cuts the middle out of a Tool result over
 * 10,000 tokens, Claude Code saves one over 25,000 to a file (#3573).
 */
export const READ_PART_TOKENS = 8_000;
const PART_BATCH = 64;
/** The most quotes one `cite` call checks. */
export const MAX_CITES = 20;
/** The most sentences `check_citations` lists as uncited. */
export const MAX_UNCITED = 20;
/** The most characters of a Mind one `read_mind` returns. */
export const MIND_PAGE_CHARS = 20_000;
/** The longest search, quote, Question or draft accepted, in characters. */
const MAX_QUERY_CHARS = 1_000;
const MAX_QUOTE_CHARS = 2_000;
const MAX_DRAFT_CHARS = 100_000;
/** The most changes one `propose_changes` call makes. */
export const MAX_CHANGES = 50;
/** The longest text of one change, in characters. */
const MAX_CHANGE_CHARS = 20_000;
/** The longest name of a Note an agent writes. */
const MAX_TITLE_CHARS = 200;
/** The most Notes one pairing writes in an hour. */
export const MAX_NOTES_AN_HOUR = 20;
/** The most checks of its Notes one pairing starts in an hour. */
export const MAX_CHECKS_AN_HOUR = 20;
/** The most results one `report_check` takes: more than a Note an agent writes holds. */
const MAX_REPORTED_SENTENCES = 2000;
/** The most Documents `list_minds` names in one Folder; `documents` counts them all. */
export const MAX_LISTED_DOCUMENTS = 50;
/** How many times `check_mind` reads its record while what the agent reaches changes under it. */
const MAX_RECORD_READS = 3;

/** The most claims `check_mind` lists as needing a look. */
export const MAX_CHECKED_CLAIMS = 60;
/**
 * How long `check_mind` waits for the check before it answers "running": under the shortest Tool
 * time limit of the agents there are (a minute).
 */
export const CHECK_WAIT_MS = 45_000;
const HOUR_MS = 3_600_000;
/** The longest summary kept of a call for the activity list. */
const SUMMARY_CHARS = 300;
/** The longest quote a ready Citation of a search result has. */
const READY_QUOTE_CHARS = 300;

// ---------------------------------------------------------------------------
// What it needs

/** A pairing allowed to call now. */
export interface AdmittedPairing {
  shareTagNames?: boolean;
  id: string;
  name: string;
  folderIds: string[];
  /** When the User connected it: no Note it wrote is older. */
  createdAt: string;
  /** The User let it propose changes to the Notes in its Folders. */
  propose: boolean;
}

export interface AgentAccessDeps {
  sorting: AgentSorting;
  /** The pairing, if it may call now; otherwise throws `AgentRefusedError`. */
  admit(pairingId: string): AdmittedPairing;
  /** The live Folders. */
  folders(): { id: string; name: string; parentId: string | null; keepInside: boolean }[];
  /** The walled Folder a Folder is behind, or is; null outside every wall. */
  wallOf(folderId: string): string | null;
  /** The Folder ids a pairing may be granted after Folder walls are applied. */
  foldersInScope(folderIds: readonly string[]): string[];
  /** A live Folder and the live Folders inside it up to the next wall, its own wall aside. */
  foldersInside(folderId: string): string[];
  /**
   * The ids of the live Documents filed in exactly these Folders, never those inside them;
   * `NOT_IN_A_FOLDER_ID` stands for those in no Folder now.
   */
  documentsIn(folderIds: readonly string[]): string[];
  /** Every live Transcript that belongs to a Note (#2528). */
  noteTranscripts(): readonly NoteTranscript[];
  /** The search Answers use, without reranking, over these Documents. */
  search(
    query: string,
    documentIds: readonly string[],
    parameters: Partial<SearchToolParameters>,
    signal?: AbortSignal,
  ): Promise<WindowedPassage[]>;
  passage(passageId: string): WindowedPassage | null;
  passagesBetween(documentId: string, from: number, to: number): WindowedPassage[];
  citationSource(passageId: string): CitationSource | null;
  pageTexts: AnswerDocuments["pageTexts"];
  passagesCovering?: AnswerDocuments["passagesCovering"];
  /** Runs `run_analysis`'s code; absent where this computer can't run Python for IncarnaMind. */
  analysisRuntime?: AnalysisRuntime;
  /**
   * Reads a picture file an agent names for a Note, with the host's reader of the files agents
   * name (`CanvasFiles.readNamed`); absent where the host has none.
   */
  readNamed?(path: string, maxBytes: number): Promise<NamedFile>;
  /** Draws an agent's SVG picture as a PNG, as a chart is drawn for Word; absent where the host can't. */
  pictures?: Pictures;
  /** The interface language, which a chart reads its figures in. */
  language(): Language;
  /** The Library's lists of these Documents, Folders and notes alone, as `source` names them. */
  libraryLists(reach: AgentReach & { source: LibrarySource }): LibraryLists;
  /** The version of the Library's lists as a Note's own Check counts them, which its marks compare. */
  libraryVersion(mindId: string): string;
  citing: Pick<Citing, "citeQuote" | "locate">;
  /** A quote of a file an agent cites by its path (`FileCiting`, #3509). */
  citeFile: FileCiting["cite"];
  /** Whether the Document is a file an agent cited by its path, evidence for what cites it alone. */
  citedOutside(documentId: string): boolean;
  /** Every file an agent cited by its path (`citedOutside`). */
  citedFiles(): string[];
  /** Whether the Passage's Document is the User's own workings: an agent reads it and never cites it. */
  notCited(passageId: string): boolean;
  /** A Citation checked again against its Document as it is now. */
  recheck(input: {
    documentId: string;
    quote: string;
    pageFrom: number | null;
    pageTo: number | null;
    location?: CitationLocation | null;
  }): CitationRecheck;
  /** Shows a Citation in the viewer, the app in front. */
  show(place: AgentCitationShown): void;
  /** Opens what the agent made, in front where the User asked it from IncarnaMind (#3534). */
  opened(opened: AgentOpened): void;
  /** The Minds there are. */
  minds(): Mind[];
  /** The examples' Minds: never the User's, so no share of everything reaches one in no Folder. */
  exampleNotes(): readonly string[];
  /** The Mind a Mind was duplicated from; null for one that is no copy. */
  duplicatedFrom(mindId: string): string | null;
  /** These Documents' names and kinds, those that are live, in this order. */
  documentsNamed(documentIds: readonly string[]): { id: string; name: string; kind: string }[];
  /** The live Documents' names: what a Citation is shown with, when its Document was renamed since. */
  liveDocuments(): readonly LiveDocument[];
  /** Reads a Mind's Blocks, leaving it unloaded if it was. */
  mindBlocks<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T;
  /** Changes a Mind's Blocks in one Yjs transaction, stored and sent to its open windows. */
  editMind<T>(mindId: string, change: (blocks: Y.XmlFragment) => T): T;
  /**
   * `editMind` for a change that applies at once in a Note the agent wrote (#3371): one step the
   * User's Undo takes back, by `step`; null when it changed nothing.
   */
  editOwnMind<T>(
    mindId: string,
    change: (blocks: Y.XmlFragment) => T,
  ): { value: T; step: string | null };
  /** Saves a Checkpoint of a Mind as it is, just before an agent's change applies there. */
  checkpoint(mindId: string): void;
  /** Tells the windows of a Note an agent wrote, or changed at once (#3371). */
  noteChanged(change: AgentNoteChange): void;
  /** A Mind as Markdown, each Citation's footnote as `footnote` words it (see ../exports). */
  mindMarkdown(mindId: string, footnote: (attributes: Record<string, unknown>) => Footnote): string;
  /** A new, empty Mind in a Folder, or in none; with no `title`, its text names it. */
  createMind(title: string, folderId: string | null): Mind;
  /** How many Notes the pairing wrote since `since` (ISO 8601, UTC). */
  notesWrittenSince(pairingId: string, since: string): number;
  /** IncarnaMind's Answer to a Question from these Documents, on the default chat model. */
  answer(question: string, documentIds: string[], signal: AbortSignal): Promise<OutsideAnswer>;
  /**
   * A Note's Check of what it hasn't checked yet, on the Note's model, asking the User nothing and
   * searching none but `documentIds`, the Documents the agent may read.
   */
  checkNote(mindId: string, documentIds: readonly string[]): Promise<OutsideCheck>;
  /**
   * A Note's sentences that hold no result yet, or with `every` all it judges, results or not, when
   * its Check searches none but `documentIds`.
   */
  checkTask(mindId: string, documentIds: ReadonlySet<string>, every?: boolean): Judged<CheckTask>;
  /** Marks a task's sentences with what the agent `agent` judged of them. */
  landJudged(
    mindId: string,
    documentIds: ReadonlySet<string>,
    agent: string,
    task: string,
    judged: readonly JudgedSentence[],
  ): Judged<LandedCheck>;
  /**
   * What a Note's checks found, sentence by sentence, as its check record lists them for an agent
   * that reaches `reach`.
   */
  checkRecord(
    mindId: string,
    reach: ReadonlySet<string>,
  ): Promise<Pick<CheckRecord, "models" | "sentences"> & Partial<Pick<CheckRecord, "notChecked">>>;
  /** The Checks agents started, shared by every connection (`createCheckRuns`). */
  checkRuns: CheckRuns;
  /** What IncarnaMind worked out for agents, shared by every connection (`createAgentWorkings`). */
  workings: AgentWorkings;
  /**
   * Each Note's version right after a pairing's last change to it, by `versionKey`: a change
   * built on an older version is refused for its true cause, the agent's own change or another's.
   */
  versions: Map<string, string>;
  /** `CHECK_WAIT_MS`, unless a test waits less. */
  checkWaitMs?: number;
  citations: AgentCitations;
  /** The requests the User made of their own AI, kept for each agent to read once (./requests). */
  requests: Pick<AgentRequests, "ofPairing" | "markRead">;
  /** Keeps a call for the pairing's activity list, with the request it read. */
  record(activity: Omit<AgentActivity, "id" | "at" | "request">, requestId?: string): void;
  /** A message in the interface language. */
  say(key: MessageKey, params?: MessageParams): string;
  /** Milliseconds, for how long a call took. */
  clock(): number;
  /** Now, ISO 8601, UTC. */
  now(): string;
  /** A new random id, for a request of changes and the Proposals it writes. */
  newId(): string;
  reportError(error: unknown): void;
  /** The Canvases outside agents publish (#3406). */
  canvases: CanvasToolDeps["canvases"];
  /** Tells the windows an agent published a Canvas, or a new version of one. */
  canvasChanged: CanvasToolDeps["canvasChanged"];
  doneSince: CanvasToolDeps["doneSince"];
  /** The files outside agents hand over (#3412). */
  handedAt: HandedFileToolDeps["handedAt"];
  handOver: HandedFileToolDeps["handOver"];
  handedCheck: HandedFileToolDeps["handedCheck"];
}

/**
 * The Checks agents started (#3317): each Note's until a call has had its end, so a second call
 * joins it and one that stopped waiting still learns how it ended, and when each pairing started
 * one, by `clock`, for the hour's limit.
 */
export interface CheckRuns {
  running: Map<string, Promise<OutsideCheck>>;
  started: Map<string, number[]>;
}

export const createCheckRuns = (): CheckRuns => ({ running: new Map(), started: new Map() });

// ---------------------------------------------------------------------------
// Helpers

/** What `run` gives, or null once `ms` have passed with it still going. */
async function within<T>(run: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How a Check that sent something to the AI model ended. */
const SENT: ReadonlySet<string> = new Set(["checked", "failed", "cancelled"]);

const CLAIM_RESULTS = {
  // A supported sentence or a view is told only when one of its Citations isn't found: it needs a look.
  supported: "citation-not-found",
  ownView: "citation-not-found",
  unsupported: "unsupported",
  contradicted: "contradicted",
  notFound: "not-found",
  notChecked: "not-checked",
  needsRecheck: "needs-recheck",
  changed: "changed",
} as const satisfies Record<string, AgentCheckedClaim["result"]>;

/**
 * The rows of the Note's check card an agent is told sentences of, with the count the page gives
 * each, in the order `claims` lists them: what needs a look first, so the cap never hides it.
 */
const CLAIM_GROUPS = [
  ["look", "needLook"],
  ["toCheck", "notChecked"],
  ["notYetCited", "canBeCited"],
] as const satisfies readonly (readonly [CheckRow, AgentCheckedClaim["group"]])[];

const READ_DOCUMENTS: Effect = { action: "read", scope: { kind: "documents" } };

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

/** A text's sentences, each trimmed, line by line: a heading or list item is one of its own. */
export function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const { segment } of sentenceSegmenter.segment(line)) {
      const sentence = segment.trim();
      if (sentence !== "") sentences.push(sentence);
    }
  }
  return sentences;
}

const HAN = /\p{Script=Han}/gu;

/** Folders in the order of their paths: each right after the one it is inside. */
function comparePaths(a: readonly string[], b: readonly string[]): number {
  for (let at = 0; at < Math.min(a.length, b.length); at++) {
    const order = (a[at] ?? "").localeCompare(b[at] ?? "");
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** Long enough to be a claim: four words, or ten Chinese characters. */
function makesAClaim(sentence: string): boolean {
  const han = sentence.match(HAN)?.length ?? 0;
  if (han >= 10) return true;
  return sentence.split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word)).length >= 4;
}

/** The part of a Passage's text an agent gets: all of it, or `PASSAGE_CHARS` around `quote`. */
function excerptWindow(text: string, quote: string | null) {
  if (text.length <= PASSAGE_CHARS) return { start: 0, end: text.length };
  const at = quote ? Math.max(0, text.indexOf(quote)) : 0;
  const centre = at + (quote?.length ?? 0) / 2;
  const start = Math.max(
    0,
    Math.min(text.length - PASSAGE_CHARS, Math.round(centre - PASSAGE_CHARS / 2)),
  );
  return { start, end: start + PASSAGE_CHARS };
}

function excerpt(text: string, quote: string | null): string {
  const { start, end } = excerptWindow(text, quote);
  if (start === 0 && end === text.length) return text;
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** The sentence of a Passage that holds the most of the search's words; the first on a tie. */
function bestSentence(text: string, terms: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const sentence of sentencesOf(text)) {
    if (!makesAClaim(sentence)) continue;
    const score = matchingTerms(terms, sentence).length;
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  return best === null ? null : clip(best, READY_QUOTE_CHARS).replace(/…$/, "");
}

/**
 * The sentences of `texts` that make a claim with no Citation `counts`, at most `MAX_UNCITED`,
 * each without the mark of a list item or quote it is in. Headings and table rows aren't
 * sentences that make claims of their own.
 */
function uncitedIn(texts: readonly string[], counts: (token: string) => boolean): string[] {
  const CITED = "\u0000";
  return texts
    .flatMap((each) =>
      sentencesOf(
        marksBeforeTheirStop(
          citationMarks(
            each
              .replace(/^#{1,6}\s.*$/gm, "")
              .replace(/^\s*\|.*$/gm, "")
              .replace(/^\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])?\s+/gm, ""),
            counts,
            CITED,
          ),
          CITED,
        ),
      ),
    )
    .filter((sentence) => !sentence.includes(CITED) && makesAClaim(sentence))
    .slice(0, MAX_UNCITED)
    .map((sentence) => clip(sentence, 200));
}

/**
 * A draft's words without its pictures, its charts' blocks and its tabs' titles, which make no
 * claim to cite.
 */
function proseOf(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of holdPictures(openTabs(text)).text.replace(HELD_PICTURE, "").split("\n")) {
    if (fence !== null) {
      const trimmed = line.trim();
      if (trimmed.startsWith(fence) && trimmed.replaceAll(fence[0] ?? "", "") === "") fence = null;
      continue;
    }
    const opens = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/.exec(line);
    if (opens?.[1] && (opens[2] === CHART_FENCE || opens[2] === TAB_FENCE)) fence = opens[1];
    else kept.push(line);
  }
  return kept.join("\n");
}

// Scanned by hand, never by a pattern that backtracks: a draft runs to `MAX_DRAFT_CHARS`, and a
// long run of spaces or full stops with no token after it took a pattern seconds (#3378).

/**
 * `text` with each token that `counts` as `mark`, and each that doesn't gone, each with the spaces
 * before it, as the sentence reads without it.
 */
function citationMarks(text: string, counts: (token: string) => boolean, mark: string): string {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(CITATION_TOKEN)) {
    let end = match.index;
    while (end > at && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
    out += text.slice(at, end) + (counts(match[1] ?? "") ? mark : "");
    at = match.index + match[0].length;
  }
  return out + text.slice(at);
}

const STOPS = new Set([".", "!", "?", "。", "！", "？"]);
const CLOSERS = new Set(['"', "'", "”", "’", ")", "]"]);

/**
 * `text` with each `mark` written after a sentence's full stop moved before it: a Citation there
 * cites that sentence, not the next.
 */
function marksBeforeTheirStop(text: string, mark: string): string {
  let out = "";
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    if (!STOPS.has(text.charAt(at))) {
      at++;
      continue;
    }
    let end = at;
    while (STOPS.has(text.charAt(end))) end++;
    while (CLOSERS.has(text.charAt(end))) end++;
    let marked = end;
    while (marked < text.length && text.charAt(marked) === mark) marked++;
    if (marked > end) {
      out += text.slice(copied, at) + text.slice(end, marked) + text.slice(at, end);
      copied = marked;
    }
    at = marked;
  }
  return out + text.slice(copied);
}

/** A change as asked, its paragraph's name read but not yet found in the Note. */
type AskedChange =
  | { kind: "rewrite"; name: string; n: number; text: string }
  | { kind: "remove"; name: string; n: number }
  | { kind: "add"; name: string; n: number | null; text: string };

/** "¶3", "¶3+" or "¶+". */
const PARAGRAPH_NAME = /^¶(?:(\d{1,5})(\+?)|\+)$/;

/** A message in the interface language. */
type Say = (key: MessageKey, params?: MessageParams) => string;

/** A change's text: words, at most `MAX_CHANGE_CHARS` of them. */
function changeText(value: unknown, name: string, t: Say): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentRefusedError("invalid", t("agents.propose.text", { name }));
  }
  refuseCallMarkup(value, "text", t);
  if (value.length > MAX_CHANGE_CHARS + inlinePictureChars(value)) {
    throw new AgentRefusedError(
      "invalid",
      t("agents.propose.textTooLong", { name, max: MAX_CHANGE_CHARS }),
    );
  }
  return value.trim();
}

/** Text that holds the call's own markup is a malformed call's, never words for the Note (#3476). */
function refuseCallMarkup(value: string, argument: string, t: Say): void {
  const markup = callMarkupIn(value, argument);
  if (markup !== null) {
    throw new AgentRefusedError("invalid", t("agents.problem.callMarkup", { argument, markup }));
  }
}

function parseChanges(value: unknown, t: Say): AskedChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANGES) {
    throw new AgentRefusedError("invalid", t("agents.propose.list", { max: MAX_CHANGES }));
  }
  return value.map((entry): AskedChange => {
    const change = isRecord(entry) ? entry : {};
    const name = typeof change.paragraph === "string" ? change.paragraph.trim() : "";
    const read = PARAGRAPH_NAME.exec(name);
    if (!read) {
      throw new AgentRefusedError("invalid", t("agents.propose.name", { name: clip(name, 20) }));
    }
    const n = read[1] === undefined ? null : Number(read[1]);
    if (change.remove !== undefined && typeof change.remove !== "boolean") {
      throw new AgentRefusedError("invalid", t("agents.propose.removeChoice"));
    }
    if (change.remove === true) {
      if (n === null || read[2] === "+" || change.text !== undefined) {
        throw new AgentRefusedError("invalid", t("agents.propose.removeOnly", { name }));
      }
      return { kind: "remove", name, n };
    }
    const written = changeText(change.text, name, t);
    if (n === null || read[2] === "+") return { kind: "add", name, n, text: written };
    return { kind: "rewrite", name, n, text: written };
  });
}

/** The changes, each for the named paragraph it is for, by its place in `note`. */
function placeChanges(asked: readonly AskedChange[], note: NamedNote, t: Say): NamedChange[] {
  const titled = note.paragraphs[0]?.name === "¶0";
  const count = note.paragraphs.length - (titled ? 1 : 0);
  const named = new Set<number>();
  let before: number | null = null;
  return asked.map((change): NamedChange => {
    const n = change.n ?? before;
    if (n === null) throw new AgentRefusedError("invalid", t("agents.propose.firstAdd"));
    const at = note.paragraphs.findIndex((paragraph) => paragraph.name === `¶${n}`);
    if (at < 0) {
      if (note.paragraphs.length === 0 && n === 0 && change.kind === "add") {
        before = n;
        return { kind: "add", after: null, text: change.text };
      }
      throw new AgentRefusedError(
        "invalid",
        note.paragraphs.length === 0
          ? t("agents.propose.noParagraphs", { name: change.name })
          : t(titled ? "agents.propose.outOfRange.titled" : "agents.propose.outOfRange", {
              name: change.name,
              count,
            }),
      );
    }
    before = n;
    if (change.kind === "add") return { kind: "add", after: at, text: change.text };
    if (named.has(at)) {
      throw new AgentRefusedError("invalid", t("agents.propose.twice", { name: change.name }));
    }
    named.add(at);
    return change.kind === "remove"
      ? { kind: "remove", at }
      : { kind: "rewrite", at, text: change.text };
  });
}

/** What a call returns, with what its activity row says of it. */
interface Done<T> {
  result: T;
  count: number | null;
  documentIds: string[];
  effects?: Effect[];
  /** The request the call read (`read_request`). */
  requestId?: string;
  /** What its activity line says, when only the call knows (`read_request`: the names it gave). */
  summary?: string;
}

type ReachDeps = Pick<
  AgentAccessDeps,
  | "folders"
  | "wallOf"
  | "foldersInScope"
  | "foldersInside"
  | "mindBlocks"
  | "duplicatedFrom"
  | "exampleNotes"
>;

/** The pairing was given all of the User's Documents and Notes, those added later too (#3544). */
export const sharesAll = (pairing: Pick<AdmittedPairing, "folderIds">): boolean =>
  pairing.folderIds.includes(ALL_SHARED_ID);

/**
 * Everything a pairing reaches, by Folder (#3394): each Folder it was granted, as walls allow, with
 * the Folders inside it up to the next wall, and `NOT_IN_A_FOLDER_ID` when it was granted that.
 * Given all, every Folder outside a wall now, and `NOT_IN_A_FOLDER_ID` (#3544). Its Documents and
 * its Notes are those in these Folders, and a meeting goes with its Note.
 */
export function reachedFolders(deps: ReachDeps, pairing: AdmittedPairing): Set<string> {
  if (sharesAll(pairing)) {
    return new Set([
      ...deps
        .folders()
        .filter((folder) => deps.wallOf(folder.id) === null)
        .map((folder) => folder.id),
      NOT_IN_A_FOLDER_ID,
    ]);
  }
  return new Set(
    deps
      .foldersInScope(pairing.folderIds)
      .flatMap((id) => (id === NOT_IN_A_FOLDER_ID ? [id] : deps.foldersInside(id))),
  );
}

/**
 * The Folders a pairing's reach is named by, as the User granted them: given all, those of the
 * Folders it reaches that are inside none of them, a Folder inside one being part of it.
 */
function grantedFolders(deps: ReachDeps, pairing: AdmittedPairing): string[] {
  if (!sharesAll(pairing)) return deps.foldersInScope(pairing.folderIds);
  const reached = reachedFolders(deps, pairing);
  return deps
    .folders()
    .filter(
      (folder) =>
        reached.has(folder.id) && (folder.parentId === null || !reached.has(folder.parentId)),
    )
    .map((folder) => folder.id);
}

/**
 * Whether the pairing wrote this Mind, as `create_mind` records it in the Mind. A copy carries
 * the record, so it holds only for the Mind it names; one that names none, kept before records
 * did, holds for a Mind that is no copy, as a duplicate is the one way a Mind's content is
 * copied into another (#3364).
 */
function pairingWrote(deps: ReachDeps, pairing: AdmittedPairing, mindId: string): boolean {
  const writer = deps.mindBlocks(mindId, (blocks) =>
    blocks.doc ? noteWriterOf(blocks.doc) : null,
  );
  if (writer?.pairingId !== pairing.id) return false;
  return writer.mindId === undefined
    ? deps.duplicatedFrom(mindId) === null
    : writer.mindId === mindId;
}

/**
 * Whether `read_mind` reads this Mind for the pairing: in a Folder it reaches, or in none when it
 * wrote it there, or when it was given all and the Mind is no example's. `reached`: the pairing's
 * `reachedFolders`, when the caller has them.
 */
export const pairingReaches = (
  deps: ReachDeps,
  pairing: AdmittedPairing,
  mind: Mind,
  reached: ReadonlySet<string> = reachedFolders(deps, pairing),
): boolean => {
  if (mind.folderId !== null) return reached.has(mind.folderId);
  if (!reached.has(NOT_IN_A_FOLDER_ID)) return false;
  return sharesAll(pairing)
    ? !deps.exampleNotes().includes(mind.id)
    : pairingWrote(deps, pairing, mind.id);
};

/**
 * The Documents filed in these Folders, of those the pairing reaches, a Transcript among them only
 * while the pairing reaches its Note: its words are its Note's (#3384, #3394). `reached`: the
 * pairing's `reachedFolders`, when the caller has them.
 */
export function documentsForPairing(
  deps: AgentAccessDeps,
  pairing: AdmittedPairing,
  folderIds: readonly string[],
  reached: ReadonlySet<string> = reachedFolders(deps, pairing),
): string[] {
  const documentIds = deps.documentsIn(folderIds);
  const held = deps.noteTranscripts();
  if (held.length === 0) return documentIds;
  const minds = new Map(deps.minds().map((mind) => [mind.id, mind]));
  const apart = new Set(
    held
      .filter(({ mindId }) => {
        const mind = minds.get(mindId);
        // No Note it wrote is older than the pairing, which spares reading the others' records.
        return (
          !mind ||
          (mind.folderId === null && !sharesAll(pairing) && mind.createdAt < pairing.createdAt) ||
          !pairingReaches(deps, pairing, mind, reached)
        );
      })
      .map(({ documentId }) => documentId),
  );
  return documentIds.filter((id) => !apart.has(id));
}

/**
 * Whether the User has a Folder, a Document or a Note the pairing doesn't reach (#3544): the one
 * thing an agent is told of what it wasn't given, never which, how many or of what kind. The
 * examples, Recently deleted and the files agents hand over count for nothing: no share reaches
 * them. A meeting's Transcript counts as its Note does.
 */
export function holdsMore(
  deps: AgentAccessDeps,
  pairing: AdmittedPairing,
  reached: ReadonlySet<string> = reachedFolders(deps, pairing),
): boolean {
  if (deps.folders().some((folder) => !reached.has(folder.id))) return true;
  if (!reached.has(NOT_IN_A_FOLDER_ID)) {
    const transcripts = new Set(deps.noteTranscripts().map((each) => each.documentId));
    if (deps.documentsIn([NOT_IN_A_FOLDER_ID]).some((id) => !transcripts.has(id))) return true;
  }
  const examples = new Set(deps.exampleNotes());
  return deps
    .minds()
    .some(
      (mind) =>
        mind.folderId === null &&
        isListedMind(mind) &&
        !examples.has(mind.id) &&
        !pairingReaches(deps, pairing, mind, reached),
    );
}

// ---------------------------------------------------------------------------
// The implementation

/** The core interface for one pairing's calls. */
export function createAgentAccess(deps: AgentAccessDeps, pairingId: string): AgentAccess {
  const t: Say = (key, params) => deps.say(key, params);
  /** This connection read a request the User made from IncarnaMind: what it makes then opens in front. */
  let askedFromIncarnaMind = false;
  const opened = (item: AgentOpened["item"]) => deps.opened({ item, front: askedFromIncarnaMind });
  const pictureLimit = { max: NOTE_PICTURE_LIMITS.bytes / (1024 * 1024) };
  const reasonOf = (left: VisualRefused) =>
    left.kind === "picture"
      ? t(
          `agents.picture.refused.${left.why}`,
          left.why === "too-many" ? { max: NOTE_PICTURE_LIMITS.pictures } : pictureLimit,
        )
      : t(`agents.chart.refused.${left.why}`);
  /** The pictures `texts` name, read for this call, and how its Blocks put them and its charts in place (#3413). */
  const visualsFor = async (texts: readonly string[]): Promise<NoteVisuals> => ({
    pictures: await readPictures(
      texts.flatMap((each) => holdPictures(each).pictures),
      deps.readNamed,
      deps.pictures,
    ),
    language: deps.language(),
    notFound: t("agents.answer.notFound"),
    line: (left) =>
      left.kind === "chart"
        ? t("agents.chart.notDrawn", { reason: reasonOf(left) })
        : left.name === ""
          ? t("agents.picture.notAdded", { reason: reasonOf(left) })
          : t("agents.picture.notAddedNamed", { name: left.name, reason: reasonOf(left) }),
    newId: deps.newId,
  });
  const leftOut = (refused: readonly VisualRefused[]): VisualLeftOut[] =>
    refused.map((each) => ({ item: each.item, reason: reasonOf(each) }));
  const label = (
    location: CitationLocation | null,
    pageFrom: number | null,
    pageTo: number | null,
    documentId?: string | null,
    quote?: string,
  ) =>
    citedLocation(
      { location, pageFrom, pageTo, documentId, ...(quote && { quote }) },
      t,
      location?.kind === "time" && documentId ? deps.liveDocuments() : null,
    );

  function sortingScope(pairing: AdmittedPairing) {
    const reached = reachedFolders(deps, pairing);
    if (!reached.size) throw new AgentRefusedError("no-folders", t("agents.problem.no-folders"));
    return {
      documents: documentsForPairing(deps, pairing, [...reached], reached),
      shareTagNames: pairing.shareTagNames === true,
      folders: deps
        .folders()
        .filter((f) => reached.has(f.id))
        .map(({ id, name }) => ({ id, name })),
    };
  }

  /** Runs a call: admits the pairing, then records what came of it. */
  async function call<T>(
    tool: AgentToolName,
    summary: string,
    effects: Effect[],
    run: (pairing: AdmittedPairing) => Promise<Done<T>> | Done<T>,
  ): Promise<T> {
    const started = deps.clock();
    const record = (
      outcome: AgentActivity["outcome"],
      rest: Partial<AgentActivity>,
      requestId?: string,
    ) => {
      try {
        deps.record(
          {
            pairingId,
            tool,
            summary: clip(summary, SUMMARY_CHARS),
            outcome,
            problem: null,
            count: null,
            documentIds: [],
            effects,
            durationMs: Math.max(0, Math.round(deps.clock() - started)),
            ...rest,
          },
          requestId,
        );
      } catch (error) {
        deps.reportError(error);
      }
    };
    let pairing: AdmittedPairing;
    try {
      pairing = deps.admit(pairingId);
    } catch (error) {
      // A pairing that no longer exists has no activity list to keep this in.
      if (error instanceof AgentRefusedError && error.problem !== "unpaired") {
        record("refused", { problem: error.problem });
      }
      throw error;
    }
    try {
      const done = await run(pairing);
      record(
        "done",
        {
          count: done.count,
          documentIds: [...new Set(done.documentIds)],
          effects: done.effects ?? effects,
          ...(done.summary !== undefined && { summary: clip(done.summary, SUMMARY_CHARS) }),
        },
        done.requestId,
      );
      return done.result;
    } catch (error) {
      if (error instanceof AgentRefusedError) {
        record(error.problem === "failed" ? "failed" : "refused", { problem: error.problem });
        throw error instanceof NotReachedError ? withNotShared(error) : error;
      }
      deps.reportError(error);
      record("failed", { problem: "failed" });
      throw new AgentRefusedError("failed", t("agents.problem.failed"));
    }
  }

  /** The line that the User has more than the pairing reaches now, read after any wait; null if not. */
  const notShared = (): string | null => {
    try {
      return holdsMore(deps, deps.admit(pairingId)) ? t("agents.notShared") : null;
    } catch (error) {
      if (error instanceof AgentRefusedError) return null;
      throw error;
    }
  };

  /** A refusal that found nothing of what was named, with `notShared`'s line where it has one. */
  const withNotShared = (error: AgentRefusedError): AgentRefusedError => {
    const line = notShared();
    return line === null ? error : new AgentRefusedError(error.problem, `${error.message} ${line}`);
  };

  /**
   * The Documents a call may read: everything its pairing reaches, or only what the Folders it
   * names hold, the Folders inside them included.
   */
  const scopeOf = (pairing: AdmittedPairing, folderIds: unknown): string[] => {
    if (pairing.folderIds.length === 0) {
      throw new AgentRefusedError("no-folders", t("agents.problem.no-folders"));
    }
    const reached = reachedFolders(deps, pairing);
    const holding = (folders: Iterable<string>) =>
      documentsForPairing(deps, pairing, [...folders], reached);
    if (folderIds === undefined) return holding(reached);
    if (!Array.isArray(folderIds) || !folderIds.every((id) => typeof id === "string")) {
      throw new AgentRefusedError("invalid", "folderIds must be a list of Folder ids.");
    }
    if (folderIds.length === 0) return holding(reached);
    if (!folderIds.every((id) => reached.has(id))) {
      throw new AgentRefusedError("outside-scope", t("agents.problem.outside-scope"));
    }
    return holding(
      new Set(
        folderIds.flatMap((id) =>
          id === NOT_IN_A_FOLDER_ID
            ? [id]
            : deps.foldersInside(id).filter((each) => reached.has(each)),
        ),
      ),
    );
  };

  /**
   * The pairing as it is admitted now, once a call has waited: what the User grants may have
   * changed meanwhile (#3458). Refused unless it still reaches every Document in `told`, so nothing
   * read under the earlier grant goes out under one that leaves it out.
   */
  const stillReaching = (told: Iterable<string>): AdmittedPairing => {
    const granted = deps.admit(pairingId);
    const reach = new Set(scopeOf(granted, undefined));
    for (const documentId of told) {
      if (!reach.has(documentId)) {
        throw new AgentRefusedError("outside-scope", t("agents.problem.reachChanged"));
      }
    }
    return granted;
  };

  /** A live Passage of these Documents, or a refusal that tells nothing of the others. */
  const passageInScope = (
    pairing: AdmittedPairing,
    inScope: ReadonlySet<string>,
    passageId: unknown,
    notFound = (_id: string) => t("agents.problem.not-found"),
  ): WindowedPassage => {
    const id = text(passageId, "passageId", 200);
    // A Citation's token stands for its Passage too: agents give one where a passageId goes (#3465).
    const token = [...id.matchAll(CITATION_TOKEN)][0]?.[1] ?? id;
    const passage =
      deps.passage(id) ?? deps.passage(deps.citations.find(pairing.id, token)?.passageId ?? "");
    if (!passage || !inScope.has(passage.documentId)) throw new NotReachedError(notFound(id));
    return passage;
  };

  const passageReading = (
    passage: WindowedPassage,
    window = { start: 0, end: passage.text.length },
  ) => {
    if (passage.documentKind !== "transcript")
      return {
        location: label(
          deps.citing.locate(passage),
          passage.pageFrom,
          passage.pageTo,
          passage.documentId,
        ),
      };
    if (passage.pageFrom === null || passage.pageTo === null) return { location: null };
    const units = deps.pageTexts(
      passage.documentId,
      passage.contentHash,
      passage.pageFrom,
      passage.pageTo,
    );
    const span = saidBetween(passage.text, units);
    const speakers = liveDocumentOf(
      { documentId: passage.documentId },
      deps.liveDocuments(),
    )?.speakers;
    const marked = withCueMarks(passage.text, units, speakers, window);
    return {
      location: span ? label({ kind: "time", ...span }, null, null, passage.documentId) : null,
      ...(marked !== passage.text.slice(window.start, window.end) && {
        timedText: `${window.start ? "…" : ""}${marked}${window.end < passage.text.length ? "…" : ""}`,
      }),
    };
  };

  /**
   * A part of a Document, from the Passage at `position` on: its Passages in reading order, each
   * without what it repeats of the one before (Passages overlap), as many as fit in
   * `READ_PART_TOKENS` as the result is sent, and always one.
   */
  const partOf = (documentId: string, position: number): AgentReadResult => {
    const passages: AgentReadResult["passages"] = [];
    let behind = position > 0 ? deps.passagesBetween(documentId, position - 1, position - 1) : [];
    const previous = behind[0]?.passageId ?? null;
    let document: string | null = null;
    let next: string | null = null;
    let size = 0;
    for (let at = position; next === null; at += PART_BATCH) {
      const batch = deps.passagesBetween(documentId, at, at + PART_BATCH - 1);
      const first = batch[0];
      if (!first) break;
      if (document === null) {
        document = first.documentName;
        size = estimateTokens(
          JSON.stringify({ documentId, document, passages, previous, next: first.passageId }),
        );
      }
      const shown = new Map(
        withoutOverlap([...behind, ...batch]).map((each) => [each.passageId, each.text]),
      );
      for (const passage of batch) {
        const text = shown.get(passage.passageId);
        if (text === undefined) continue;
        const entry = {
          passageId: passage.passageId,
          text,
          ...passageReading(passage, {
            start: passage.text.length - text.length,
            end: passage.text.length,
          }),
        };
        const cost = estimateTokens(JSON.stringify(entry)) + 1;
        if (passages.length > 0 && size + cost > READ_PART_TOKENS) {
          next = passage.passageId;
          break;
        }
        passages.push(entry);
        size += cost;
      }
      behind = batch.slice(-1);
    }
    if (document === null) throw new NotReachedError(t("agents.problem.not-found"));
    return { documentId, document, passages, previous, next };
  };

  /** The first part of a Document the pairing reaches. */
  const readStart = (reach: ReadonlySet<string>, given: unknown): AgentReadResult => {
    const documentId = text(given, "passageId or documentId", 200);
    if (!reach.has(documentId)) throw new NotReachedError(t("agents.problem.not-found"));
    return partOf(documentId, 0);
  };

  /**
   * The part of a Document from `from`, a part's `next`, on. A Document changed since that part
   * has new Passages, so the one named is no longer live: that is said, to read it again from its
   * start, rather than read on in another version of it.
   */
  const readOn = (reach: ReadonlySet<string>, given: unknown): AgentReadResult => {
    const from = text(given, "from", 200);
    const passage = deps.passage(from);
    if (passage && reach.has(passage.documentId))
      return partOf(passage.documentId, passage.position);
    const earlier = passage ? null : deps.citationSource(from);
    if (earlier && !earlier.documentDeleted && reach.has(earlier.documentId)) {
      throw new AgentRefusedError(
        "changed",
        t("agents.problem.documentChanged", { document: earlier.documentName }),
      );
    }
    throw new NotReachedError(t("agents.problem.not-found"));
  };

  /** Mints the token of a Citation the check found. */
  const mint = (pairing: AdmittedPairing, citation: Citation): AgentCitation =>
    deps.citations.mint(pairing.id, citation);

  /**
   * Whether a Citation the pairing was given may be used: of a Document it reaches, or of a file it
   * cited by its path (#3509), whose tokens only it was given.
   */
  const usable = (inScope: ReadonlySet<string>, documentId: string) =>
    inScope.has(documentId) || deps.citedOutside(documentId);

  /**
   * The Documents a check's results may rest on for the pairing: those it reaches, and files cited
   * by path (#3509), which hold no more than the quotes cited from them and are no source.
   */
  const checkReach = (pairing: AdmittedPairing): Set<string> =>
    new Set([...scopeOf(pairing, undefined), ...deps.citedFiles()]);

  /** A Passage as a search result: its best sentence cited, if the check finds it. */
  const asResult = (
    pairing: AdmittedPairing,
    passage: WindowedPassage,
    terms: readonly string[],
  ): AgentPassage => {
    const sentence = bestSentence(passage.text, terms);
    const citation =
      sentence && !deps.notCited(passage.passageId)
        ? deps.citing.citeQuote(passage.passageId, sentence)
        : null;
    const found = citation?.check === "found" ? citation : null;
    const minted = found ? mint(pairing, found) : null;
    const reading = passageReading(passage, excerptWindow(passage.text, found?.quote ?? null));
    return {
      passageId: passage.passageId,
      documentId: passage.documentId,
      document: passage.documentName,
      ...reading,
      location: found
        ? label(found.location, found.pageFrom, found.pageTo, passage.documentId, found.quote)
        : reading.location,
      quote: found ? found.quote : null,
      cite: minted ? citeTag(minted.token) : null,
      text: excerpt(passage.text, found?.quote ?? null),
    };
  };

  const recheckKept = (kept: AgentCitation) =>
    deps.recheck({
      documentId: kept.documentId,
      quote: kept.quote,
      pageFrom: kept.pageFrom,
      pageTo: kept.pageTo,
      location: kept.location,
    });

  /** A minted Citation as its Document holds it now; null unless its quote is found there. */
  const foundNow = (kept: AgentCitation, now: CitationRecheck): Citation | null =>
    now.check === "found" && now.contentHash !== null
      ? {
          passageId: now.passageId ?? kept.passageId,
          documentId: kept.documentId,
          documentName: kept.documentName,
          contentHash: now.contentHash,
          pageFrom: now.pageFrom,
          pageTo: now.pageTo,
          location: now.location ?? kept.location,
          quote: kept.quote,
          check: "found",
          checkReason: null,
        }
      : null;

  /**
   * A token in proposed text, looked up for this pairing and checked again against its
   * Document as it is now: found, Needs re-check once the Document changed, or Quote not found.
   * One that isn't this agent's, or not of its Folders, cites nothing (`cited` null).
   */
  const checkToken = (
    pairing: AdmittedPairing,
    inScope: ReadonlySet<string>,
    live: readonly LiveDocument[],
    token: string,
  ): { cited: CitedToken | null; report: AgentCheckedCitation } => {
    const kept = deps.citations.find(pairing.id, token);
    if (!kept || !usable(inScope, kept.documentId)) {
      return {
        cited: null,
        report: {
          cite: citeTag(token),
          check: "unknown",
          document: null,
          location: null,
          quote: null,
          changed: false,
        },
      };
    }
    const now = recheckKept(kept);
    const check = now.check === "found" || now.check === "cant-check" ? now.check : "not-found";
    const changed = now.contentHash !== null && now.contentHash !== kept.contentHash;
    const asMinted = {
      passageId: kept.passageId,
      documentId: kept.documentId,
      documentName: kept.documentName,
      contentHash: kept.contentHash,
      pageFrom: kept.pageFrom,
      pageTo: kept.pageTo,
      location: kept.location,
      quote: kept.quote,
    };
    // Found in the Document now: cited as it is now. Not found after the Document changed: the
    // version it was found in, which the Note shows as needing a check again.
    const found = foundNow(kept, now);
    const attributes = found
      ? { ...found }
      : changed
        ? { ...asMinted, check: "found", checkReason: null }
        : { ...asMinted, check, checkReason: now.checkReason };
    return {
      cited: {
        minted: { documentId: kept.documentId, quote: kept.quote, pageFrom: kept.pageFrom },
        attributes,
        citable: !deps.notCited(kept.passageId),
      },
      report: {
        cite: citeTag(token),
        check,
        document: withShownName(kept, live).documentName,
        location: label(
          now.location ?? kept.location,
          now.pageFrom,
          now.pageTo,
          kept.documentId,
          kept.quote,
        ),
        quote: kept.quote,
        changed,
      },
    };
  };

  const wrote = (pairing: AdmittedPairing, mindId: string) => pairingWrote(deps, pairing, mindId);
  const reaches = (pairing: AdmittedPairing, mind: Mind, reached?: ReadonlySet<string>) =>
    pairingReaches(deps, pairing, mind, reached);

  /**
   * A Mind in the pairing's Folders, or in no Folder when the pairing wrote it and reads the
   * Documents there (#3364); otherwise a refusal that tells nothing of the others.
   */
  const mindInScope = (pairing: AdmittedPairing, mindId: string): Mind => {
    const mind = deps.minds().find((each) => each.id === mindId);
    if (!mind || !reaches(pairing, mind)) {
      throw new NotReachedError(t("agents.problem.not-found"));
    }
    return mind;
  };

  /**
   * The Check of a Note going now, started if none an agent started is: its sentences go to the
   * User's AI model, so a pairing starts `MAX_CHECKS_AN_HOUR` at most. Joining one is free, and so
   * is one that sent nothing: not allowed, held by the window's own Check, or with nothing new.
   */
  const checkOf = (pairing: AdmittedPairing, mindId: string): Promise<OutsideCheck> => {
    const { running, started } = deps.checkRuns;
    const going = running.get(mindId);
    if (going) return going;
    const now = deps.clock();
    const lately = (started.get(pairing.id) ?? []).filter((at) => at > now - HOUR_MS);
    if (lately.length >= MAX_CHECKS_AN_HOUR) {
      throw new AgentRefusedError(
        "too-many",
        t("agents.check.tooMany", { max: MAX_CHECKS_AN_HOUR }),
      );
    }
    started.set(pairing.id, [...lately, now]);
    const run = deps.checkNote(mindId, [...checkReach(pairing)]);
    run.then(
      (outcome) => {
        if (outcome.asked && SENT.has(outcome.result.kind)) return;
        const times = started.get(pairing.id) ?? [];
        const counted = times.indexOf(now);
        started.set(
          pairing.id,
          times.filter((_, index) => index !== counted),
        );
      },
      // A call that stopped waiting leaves it running: its failure is still said somewhere.
      (error: unknown) => {
        if (running.get(mindId) === run) running.delete(mindId);
        deps.reportError(error);
      },
    );
    running.set(mindId, run);
    return run;
  };

  /** Nothing to check a Note against: none in its Folder, or none at all for a Note in no Folder. */
  const noDocuments = (mind: Mind) =>
    new AgentRefusedError(
      "invalid",
      t(mind.folderId === null ? "agents.check.noDocuments.unfiled" : "agents.check.noDocuments"),
    );

  /** Why a Check of `mind` sent nothing, in plain words. */
  const notAsked = (reason: NotAskedReason, mind: Mind): AgentRefusedError => {
    switch (reason) {
      case "local-mode":
        return new AgentRefusedError("local-mode", t("agents.problem.local-mode"));
      case "beyond-reach":
        return new AgentRefusedError("outside-scope", t("agents.check.beyondReach"));
      case "no-documents":
        return noDocuments(mind);
      case "consent-needed":
        return new AgentRefusedError("chat-not-ready", t("agents.check.consent"));
      case "not-ready":
        return new AgentRefusedError("chat-not-ready", t("agents.check.notReady"));
    }
  };

  /** A Note this agent wrote and may write to: the only kind it has checked. */
  const ownNote = (pairing: AdmittedPairing, mindId: unknown): Mind => {
    if (!pairing.propose) {
      throw new AgentRefusedError("read-only", t("agents.problem.read-only"));
    }
    const mind = mindInScope(pairing, text(mindId, "mindId", 200));
    if (!wrote(pairing, mind.id)) {
      throw new AgentRefusedError("invalid", t("agents.check.notYours"));
    }
    return mind;
  };

  const notJudged = (reason: NotJudgedReason, mind: Mind): AgentRefusedError => {
    switch (reason) {
      case "beyond-reach":
        return new AgentRefusedError("outside-scope", t("agents.check.beyondReach"));
      case "no-documents":
        return noDocuments(mind);
      case "changed":
        return new AgentRefusedError("changed", t("agents.check.taskChanged"));
    }
  };

  /**
   * Where a new Note goes: the Folder named, of those the pairing reaches, the Folders inside its
   * own included (#3394), or the one it was granted; else no Folder, named or not, when the
   * pairing reads the Documents there (#3364).
   */
  const placeToWriteIn = (
    pairing: AdmittedPairing,
    folderId: unknown,
  ): { id: string | null; name: string } => {
    const granted = deps.foldersInScope(pairing.folderIds);
    const reached = reachedFolders(deps, pairing);
    const folders = deps.folders().filter((folder) => reached.has(folder.id));
    const unfiled = reached.has(NOT_IN_A_FOLDER_ID);
    const none = { id: null, name: "" };
    if (folders.length === 0 && !unfiled) {
      throw new AgentRefusedError("no-folders", t("agents.problem.no-folders"));
    }
    if (folderId === undefined) {
      // Given all, a Note goes where a Note the User makes goes, until the agent names a Folder.
      if (sharesAll(pairing)) return none;
      const [only, ...others] = folders.filter((folder) => granted.includes(folder.id));
      if (only && others.length === 0) return only;
      if (!only) return none;
      throw new AgentRefusedError("invalid", t("agents.create.folder"));
    }
    if (folderId === NOT_IN_A_FOLDER_ID && unfiled) return none;
    const folder = folders.find((each) => each.id === folderId);
    if (!folder) throw new AgentRefusedError("outside-scope", t("agents.problem.outside-scope"));
    return folder;
  };

  /** One page of a Mind's text from `offset`, ending at a paragraph's end where one is near. */
  const page = (mind: Mind, markdown: string, offset: number): AgentMindText => {
    let end = Math.min(markdown.length, offset + MIND_PAGE_CHARS);
    if (end < markdown.length) {
      // At a paragraph's end, if there is one in the last quarter of the page.
      const paragraph = markdown.lastIndexOf("\n\n", end);
      if (paragraph > offset + (MIND_PAGE_CHARS * 3) / 4) end = paragraph;
    }
    const folder = deps.folders().find((each) => each.id === mind.folderId);
    return {
      mindId: mind.id,
      title: mind.title || mind.autoTitle || t("mind.untitled"),
      folder: folder?.name ?? "",
      markdown: markdown.slice(offset, end),
      offset,
      nextOffset: end < markdown.length ? end : null,
    };
  };

  /**
   * How a Note is named for an agent: its title as ¶0, and in a Note the agent wrote, what the
   * User wrote there marked as theirs (#3371).
   */
  const namingOf = (own: boolean): NamedOptions => ({
    title: true,
    ...(own && {
      users: { wrote: t("agents.mind.usersWrote"), changed: t("agents.mind.usersChanged") },
    }),
  });

  const versionKey = (pairing: AdmittedPairing, mindId: string) => `${pairing.id}\u0000${mindId}`;

  /**
   * How an agent reads a Note by name: each Citation of its Folders that was found as its
   * token, to keep or cite again, and the others as handles that only keep them. `cited`
   * hears the Documents.
   */
  const namedWords = (pairing: AdmittedPairing, inScope: ReadonlySet<string>, cited: string[]) => ({
    citation: (attributes: Record<string, unknown>) => {
      const documentId = typeof attributes.documentId === "string" ? attributes.documentId : "";
      if (!inScope.has(documentId)) return null;
      const citation = citationOf(attributes);
      if (citation.check !== "found" || citation.passageId === "") return null;
      cited.push(documentId);
      return citeTag(mint(pairing, citation).token);
    },
    waiting: t("agents.mind.waiting"),
    busy: t("agents.mind.busy"),
    untitledTab: (number: number) => t("noteTabs.defaultTitle", { n: number }),
  });

  const workOut = createWorkOut({
    ...(deps.analysisRuntime && { analysisRuntime: deps.analysisRuntime }),
    passage: deps.passage,
    passagesBetween: deps.passagesBetween,
    citationSource: deps.citationSource,
    pageTexts: deps.pageTexts,
    ...(deps.passagesCovering && { passagesCovering: deps.passagesCovering }),
    citations: deps.citations,
    workings: deps.workings,
    newId: deps.newId,
    now: deps.now,
  });

  /** Everything the pairing may read now: its Documents, its Folders and the Notes there it reaches. */
  const reachOf = (pairing: AdmittedPairing) => {
    let minds: Set<string> | null = null;
    const reached = reachedFolders(deps, pairing);
    return {
      documentIds: new Set(scopeOf(pairing, undefined)),
      folderIds: new Set([...reached].filter((id) => id !== NOT_IN_A_FOLDER_ID)),
      unfiled: reached.has(NOT_IN_A_FOLDER_ID),
      get mindIds(): Set<string> {
        minds ??= new Set(
          deps
            .minds()
            .filter((mind) => reaches(pairing, mind, reached))
            .map((mind) => mind.id),
        );
        return minds;
      },
    };
  };

  /**
   * What a figure is worked out over for the pairing: its Documents, and the Library's lists of
   * those, its Folders and the other Notes it reaches, named as its Folders are (#3363).
   */
  const workFor = (pairing: AdmittedPairing): WorkFor => {
    const reach = reachOf(pairing);
    return {
      pairingId: pairing.id,
      documentIds: reach.documentIds,
      lists(checking) {
        const read: AgentReach = {
          documentIds: [...reach.documentIds],
          folderIds: [...reach.folderIds],
          mindIds: [...reach.mindIds].filter((id) => id !== checking),
        };
        // Named as the User granted them: a Folder inside one is part of it.
        const granted = grantedFolders(deps, pairing);
        const names = [
          ...deps
            .folders()
            .filter((folder) => granted.includes(folder.id))
            .map((folder) => folder.name),
          ...(reach.unfiled ? [t("library.unsorted")] : []),
        ];
        const source: LibrarySource = {
          kind: "scope",
          name: names[0] ?? "",
          more: Math.max(0, names.length - 1),
        };
        return {
          lists: deps.libraryLists({ ...read, source }),
          read,
          version: checking === null ? null : deps.libraryVersion(checking),
        };
      },
    };
  };

  const handedFileTool = createHandedFileTool({
    deps,
    t,
    call,
    reached: (pairing) => reachedFolders(deps, pairing),
    again: () => deps.admit(pairingId),
    documentsIn: (pairing) => new Set(scopeOf(pairing, undefined)),
    noteReached: (pairing, mindId) => {
      const mind = deps.minds().find((each) => each.id === mindId);
      return mind !== undefined && reaches(pairing, mind);
    },
    placeToWriteIn,
    waitMs: deps.checkWaitMs ?? CHECK_WAIT_MS,
  });

  const canvasTools = createCanvasTools({
    deps: {
      ...deps,
      canvasChanged: (change) => {
        deps.canvasChanged(change);
        if (change.kind === "published") opened({ kind: "canvas", canvasId: change.canvasId });
      },
    },
    t,
    call,
    reached: (pairing) => reachedFolders(deps, pairing),
    placeToWriteIn,
    again: () => deps.admit(pairingId),
    cited: (pairing, html) => {
      const inScope = new Set(scopeOf(pairing, undefined));
      return citedTokens(html).map((token) => {
        const kept = deps.citations.find(pairing.id, token);
        if (!kept || !usable(inScope, kept.documentId)) return { token, citation: null };
        const { pairingId: _, ...citation } = kept;
        return { token, citation };
      });
    },
  });

  /**
   * What a request named, as it is now: each Document and Folder that was deleted since is left
   * out, and one that exists but isn't this pairing's to read now refuses the request, as a Note
   * out of reach does, which then waits for the User to share it again.
   */
  const lookingNow = (pairing: AdmittedPairing, named: RequestNamed): Looking => {
    const reached = reachedFolders(deps, pairing);
    const readable = new Set(documentsForPairing(deps, pairing, [...reached], reached));
    const folders = new Map(deps.folders().map((folder) => [folder.id, folder.name]));
    const documents = new Map(
      deps.documentsNamed([...named.open, ...named.documents]).map((each) => [each.id, each.name]),
    );
    const outOfReach = () =>
      new AgentRefusedError("outside-scope", t("agents.problem.requestOutOfReach"));
    const still = (
      ids: readonly string[],
      nameOf: (id: string) => string | undefined,
      reads: (id: string) => boolean,
    ) =>
      ids.flatMap((id) => {
        const name = nameOf(id);
        if (name === undefined) return [];
        if (!reads(id)) throw outOfReach();
        return [{ id, name }];
      });
    const document = (id: string) => documents.get(id);
    return {
      open: still(named.open, document, (id) => readable.has(id)),
      folders: still(
        named.folders,
        (id) => folders.get(id),
        (id) => reached.has(id),
      ),
      documents: still(named.documents, document, (id) => readable.has(id)),
    };
  };

  function sortingRequest(
    pairing: AdmittedPairing,
    target: NonNullable<RequestNamed["organize"]>,
    looking: Looking,
  ) {
    let scope: string;
    if (target === "selected") {
      scope = t("agents.ask.organize.selected", {
        ids: JSON.stringify(looking.documents.map((doc) => doc.id)),
      });
    } else {
      const reached = reachedFolders(deps, pairing);
      if (target === "loose") {
        if (!reached.has(NOT_IN_A_FOLDER_ID))
          throw new AgentRefusedError("outside-scope", t("agents.problem.requestOutOfReach"));
        scope = t("agents.ask.organize.loose");
      } else {
        const folder = looking.folders[0]?.id;
        if (!folder)
          throw new AgentRefusedError("not-found", t("agents.problem.requestNoteDeleted"));
        const children = deps
          .foldersInside(folder)
          .filter((id) => id !== folder && reached.has(id));
        scope = t("agents.ask.organize.folder", { folder, folders: JSON.stringify(children) });
      }
    }
    return t("agents.ask.request.organize", { scope });
  }

  /**
   * The results a Note holds, as its page counts them, and what a Document says of each sentence
   * that needs a look: what this agent reaches only. The Documents read are in `read`.
   */
  const checkedNote = async (
    mindId: string,
  ): Promise<{ note: AgentCheckedNote; listed: number; read: string[] }> => {
    // What the agent reaches may have changed while a Check ran, and again while its record is
    // read: a result resting on a Document the agent doesn't reach doesn't stand for it, so the
    // record is read again with what it reaches once it is read, and nothing told goes beyond.
    let granted = deps.admit(pairingId);
    mindInScope(granted, mindId);
    let inScope = checkReach(granted);
    let record = await deps.checkRecord(mindId, inScope);
    for (let reads = 1; ; reads++) {
      granted = deps.admit(pairingId);
      mindInScope(granted, mindId);
      const now = checkReach(granted);
      if (now.size === inScope.size && [...now].every((id) => inScope.has(id))) break;
      if (reads >= MAX_RECORD_READS) {
        throw new AgentRefusedError("outside-scope", t("agents.problem.reachChanged"));
      }
      inScope = now;
      record = await deps.checkRecord(mindId, inScope);
    }
    const read = new Set<string>();
    // A mark the User's wider check left says what Documents beyond the agent's Folders hold.
    const beyond = (item: (typeof record.sentences)[number]) =>
      item.scope.widened || item.scope.chosen != null;
    // Told as not checked, whatever the wider check found: what a Document it can't read holds stays there.
    const rowOf = (item: (typeof record.sentences)[number]) =>
      beyond(item) ? "toCheck" : item.row;
    const counted = (row: CheckRow) =>
      record.sentences.filter((item) => rowOf(item) === row).length;
    const listed = CLAIM_GROUPS.flatMap(([row, group]) =>
      record.sentences.filter((item) => rowOf(item) === row).map((item) => ({ ...item, group })),
    );
    const claims = listed.slice(0, MAX_CHECKED_CLAIMS).map((item): AgentCheckedClaim => {
      const unsaid = { says: null, document: null, location: null, quote: null, cite: null };
      const sentence = clip(item.text, READY_QUOTE_CHARS);
      const { group } = item;
      if (beyond(item)) {
        return { sentence, group, result: "not-checked", reason: "beyond-reach", ...unsaid };
      }
      // What the page calls Supported, not yet cited reads Supported here, not as the Not checked, found elsewhere it is stored as.
      const claim = {
        sentence,
        group,
        result: group === "canBeCited" ? ("supported" as const) : CLAIM_RESULTS[item.result],
        reason: group === "canBeCited" ? null : item.reason,
      };
      // A sentence that can be cited is given the Passage an Add would cite, not the one it rests on.
      const passage = group === "canBeCited" ? item.toCite : item;
      const judgedOn = passage?.judgedOn ? citationOf(passage.judgedOn) : null;
      // What a Document outside the pairing's Folders says stays there.
      if (!passage || !judgedOn || !passage.evidence || !inScope.has(judgedOn.documentId)) {
        return { ...claim, ...unsaid };
      }
      read.add(judgedOn.documentId);
      const { quote } = passage.evidence;
      const found =
        quote !== null &&
        judgedOn.quote !== "" &&
        judgedOn.passageId !== "" &&
        !deps.notCited(judgedOn.passageId) &&
        deps.recheck(judgedOn).check === "found";
      return {
        ...claim,
        says: passage.says,
        document: passage.evidence.name,
        location: passage.evidence.location,
        quote,
        cite: found ? citeTag(mint(granted, { ...judgedOn, check: "found" }).token) : null,
      };
    });
    return {
      note: {
        models: record.models,
        supported: counted("supported"),
        needLook: counted("look"),
        notChecked: counted("toCheck") + (record.notChecked ?? 0),
        canBeCited: counted("notYetCited"),
        ownViews: counted("ownViews"),
        claims,
      },
      listed: listed.length,
      read: [...read],
    };
  };

  return {
    search(input, signal) {
      const query = typeof input?.query === "string" ? input.query : "";
      return call("search", query, [READ_DOCUMENTS], async (pairing) => {
        const words = text(input?.query, "query", MAX_QUERY_CHARS);
        const page = whole(input?.page, "page", 1, MAX_SEARCH_PAGE, 1);
        const documentIds = scopeOf(pairing, input?.folderIds);
        if (documentIds.length === 0) {
          const line = notShared();
          return {
            result: { passages: [], page, more: false, ...(line !== null && { notShared: line }) },
            count: 0,
            documentIds: [],
          };
        }
        // Enough for this page and one more result, to know if there is a next page.
        const wanted = SEARCH_PAGE_SIZE * page + 1;
        const searched = await deps.search(
          words,
          documentIds,
          { maxPassages: wanted, maxDocuments: wanted, candidates: 30 * page },
          signal,
        );
        // What the agent reaches may have changed during the search: only what it reaches now is told.
        const granted = deps.admit(pairingId);
        const reach = new Set(scopeOf(granted, input?.folderIds));
        const found = searched.filter((passage) => reach.has(passage.documentId));
        const ranked = [...found].sort(
          (a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY),
        );
        const shown = ranked.slice(SEARCH_PAGE_SIZE * (page - 1), SEARCH_PAGE_SIZE * page);
        const terms = keywordTerms(words);
        const passages = shown.map((passage) => asResult(granted, passage, terms));
        // Told with every page: only the agent can tell whether its Passages answer the User.
        const line = holdsMore(deps, granted) ? t("agents.notShared") : null;
        return {
          result: {
            passages,
            page,
            more: ranked.length > SEARCH_PAGE_SIZE * page,
            ...(line !== null && { notShared: line }),
          },
          count: passages.length,
          documentIds: passages.map((passage) => passage.documentId),
        };
      });
    },

    readPassages(input) {
      return call("read_passages", "", [READ_DOCUMENTS], (pairing) => {
        const reach = new Set(scopeOf(pairing, undefined));
        if (input?.passageId === undefined) {
          const result =
            input?.from !== undefined
              ? readOn(reach, input.from)
              : readStart(reach, input?.documentId);
          return { result, count: result.passages.length, documentIds: [result.documentId] };
        }
        const before = whole(input.before, "before", 0, MAX_AROUND, 0);
        const after = whole(input.after, "after", 0, MAX_AROUND, 0);
        const passage = passageInScope(pairing, reach, input.passageId);
        const documentId = passage.documentId;
        const from = Math.max(0, passage.position - before);
        const to = passage.position + after;
        // One more on each side, to say whether there is more to read.
        const read = deps.passagesBetween(documentId, Math.max(0, from - 1), to + 1);
        const inRange = read.filter((each) => each.position >= from && each.position <= to);
        const first = inRange[0];
        if (!first) throw new NotReachedError(t("agents.problem.not-found"));
        const previous = read.find((each) => each.position === from - 1)?.passageId ?? null;
        const next = read.find((each) => each.position === to + 1)?.passageId ?? null;
        return {
          result: {
            documentId,
            document: first.documentName,
            passages: inRange.map((passage) => ({
              passageId: passage.passageId,
              text: passage.text,
              ...passageReading(passage),
            })),
            previous,
            next,
          },
          count: inRange.length,
          documentIds: [documentId],
        };
      });
    },

    cite(input) {
      const list: unknown[] = Array.isArray(input?.citations) ? input.citations : [];
      const summary = list
        .map((each) =>
          typeof each === "object" && each !== null && "quote" in each ? String(each.quote) : "",
        )
        .filter(Boolean)
        .join(" · ");
      return call("cite", summary, [READ_DOCUMENTS], async (pairing) => {
        if (list.length === 0 || list.length > MAX_CITES) {
          throw new AgentRefusedError(
            "invalid",
            `citations must list 1 to ${MAX_CITES} quotes, each with its passageId or path.`,
          );
        }
        const reachNow = () => new Set(scopeOf(deps.admit(pairingId), undefined));
        let inScope = new Set(scopeOf(pairing, undefined));
        const read: string[] = [];
        const citations: AgentCited[] = [];
        for (const entry of list) {
          const record = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
            string,
            unknown
          >;
          if (record.passageId === undefined && record.path !== undefined) {
            const quote = text(record.quote, "quote", MAX_QUOTE_CHARS);
            const filed = await deps.citeFile(
              text(record.path, "path", MAX_PATH_CHARS),
              quote,
              pairing.name,
              (documentId) => reachNow().has(documentId),
            );
            // What the User shares may have changed while the file was read (#3458).
            inScope = reachNow();
            read.push(filed.documentId);
            const found = filed.citation;
            if (found && deps.notCited(found.passageId)) {
              throw new AgentRefusedError(
                "invalid",
                "That Passage is from the User's own working file, which is read but never cited.",
              );
            }
            const minted = found ? mint(pairing, found) : null;
            citations.push({
              passageId: found?.passageId ?? null,
              quote: found?.quote ?? quote,
              check: found ? "found" : "not-found",
              cite: minted ? citeTag(minted.token) : null,
              document: filed.name,
              location: found
                ? label(found.location, found.pageFrom, found.pageTo, filed.documentId, found.quote)
                : null,
              // The agent has the file: IncarnaMind gives back nothing of it but where its quote is.
              text: null,
            });
            continue;
          }
          // One quote of many names a Passage it doesn't have: the agent is told which (#3573).
          const passage = passageInScope(pairing, inScope, record.passageId, (id) =>
            t("agents.problem.citeNotFound", { passageId: id }),
          );
          if (deps.notCited(passage.passageId)) {
            throw new AgentRefusedError(
              "invalid",
              "That Passage is from the User's own working file, which is read but never cited.",
            );
          }
          read.push(passage.documentId);
          const quote = text(record.quote, "quote", MAX_QUOTE_CHARS);
          const citation = deps.citing.citeQuote(passage.passageId, quote);
          if (!citation) throw new NotReachedError(t("agents.problem.not-found"));
          const check =
            citation.check === "found" || citation.check === "cant-check"
              ? citation.check
              : "not-found";
          const minted = check === "found" ? mint(pairing, citation) : null;
          citations.push({
            passageId: passage.passageId,
            quote: citation.quote,
            check,
            cite: minted ? citeTag(minted.token) : null,
            document: citation.documentName,
            location: label(
              citation.location,
              citation.pageFrom,
              citation.pageTo,
              passage.documentId,
              citation.quote,
            ),
            text: check === "found" ? null : excerpt(passage.text, null),
          });
        }
        // Nothing read under an earlier grant goes out under one that leaves it out (#3458).
        stillReaching(read.filter((documentId) => !deps.citedOutside(documentId)));
        return {
          result: { citations },
          count: citations.filter((each) => each.check === "found").length,
          documentIds: read,
        };
      });
    },

    checkCitations(input) {
      return call("check_citations", "", [READ_DOCUMENTS], (pairing) => {
        const draft = text(input?.text, "text", MAX_DRAFT_CHARS);
        const inScope = new Set(scopeOf(pairing, undefined));
        const live = deps.liveDocuments();
        const seen = new Set<string>();
        const citations: AgentCheckedCitation[] = [];
        for (const match of draft.matchAll(CITATION_TOKEN)) {
          const token = match[1] as string;
          if (seen.has(token)) continue;
          seen.add(token);
          const kept = deps.citations.find(pairing.id, token);
          if (!kept || !usable(inScope, kept.documentId)) {
            citations.push({
              cite: citeTag(token),
              check: "unknown",
              document: null,
              location: null,
              quote: null,
              changed: false,
            });
            continue;
          }
          const now = deps.recheck({
            documentId: kept.documentId,
            quote: kept.quote,
            pageFrom: kept.pageFrom,
            pageTo: kept.pageTo,
            location: kept.location,
          });
          const check =
            now.check === "found" || now.check === "cant-check" ? now.check : "not-found";
          citations.push({
            cite: citeTag(token),
            check,
            document: withShownName(kept, live).documentName,
            location: label(
              now.location ?? kept.location,
              now.pageFrom,
              now.pageTo,
              kept.documentId,
              kept.quote,
            ),
            quote: kept.quote,
            changed: now.contentHash !== null && now.contentHash !== kept.contentHash,
          });
        }
        const uncited = uncitedIn([draft], () => true);
        return {
          result: { citations, uncited },
          count: citations.length,
          documentIds: [],
        };
      });
    },

    showCitation(input) {
      const given = typeof input?.cite === "string" ? input.cite : "";
      return call("show_citation", given, [READ_DOCUMENTS], (pairing) => {
        const tag = text(input?.cite, "cite", 100);
        const token = [...tag.matchAll(CITATION_TOKEN)][0]?.[1] ?? tag;
        const kept = deps.citations.find(pairing.id, token);
        if (!kept || !usable(new Set(scopeOf(pairing, undefined)), kept.documentId)) {
          throw new NotReachedError(t("agents.problem.not-found"));
        }
        const now = deps.recheck({
          documentId: kept.documentId,
          quote: kept.quote,
          pageFrom: kept.pageFrom,
          pageTo: kept.pageTo,
          location: kept.location,
        });
        if (now.contentHash === null) {
          throw new NotReachedError(t("agents.problem.not-found"));
        }
        const location = now.location ?? kept.location;
        const where = label(location, now.pageFrom, now.pageTo, kept.documentId, kept.quote);
        deps.show({
          documentId: kept.documentId,
          ...(now.pageFrom !== null && { pageFrom: now.pageFrom }),
          ...(now.pageTo !== null && { pageTo: now.pageTo }),
          quote: kept.quote,
          citation: {
            check: now.check,
            ...(where && { label: where }),
            contentHash: now.contentHash,
            ...(location && { location }),
          },
        });
        return {
          result: {
            shown: true as const,
            document: withShownName(kept, deps.liveDocuments()).documentName,
            location: where,
          },
          count: 1,
          documentIds: [kept.documentId],
        };
      });
    },

    listSorting(after) {
      return call("list_sorting", "", [READ_DOCUMENTS], (pairing) => {
        const result = deps.sorting.list(sortingScope(pairing), after);
        return {
          result,
          count: result.documents.length,
          documentIds: result.documents.map((doc) => doc.id),
        };
      });
    },

    proposeSorting(proposals) {
      return call(
        "propose_sorting",
        "",
        [{ action: "write", scope: { kind: "library" } }],
        (pairing) => {
          const waiting = deps.sorting.submit(sortingScope(pairing), pairing.name, proposals);
          return {
            result: { waiting },
            count: waiting,
            documentIds: proposals.map((p) => p.documentId),
          };
        },
      );
    },

    listMinds() {
      return call("list_minds", "", [READ_DOCUMENTS], (pairing) => {
        if (pairing.folderIds.length === 0) {
          throw new AgentRefusedError("no-folders", t("agents.problem.no-folders"));
        }
        const minds = deps.minds().filter(isListedMind);
        const reached = reachedFolders(deps, pairing);
        const held = deps.noteTranscripts();
        const transcripts = new Set(held.map((each) => each.documentId));
        const listed = (documentIds: string[]) => {
          const own = documentIds.filter((id) => !transcripts.has(id));
          return {
            documents: own.length,
            documentList: deps
              .documentsNamed(own)
              .sort((a, b) => a.name.localeCompare(b.name))
              .slice(0, MAX_LISTED_DOCUMENTS),
          };
        };
        const canvasesIn = (folderId: string) => {
          const canvases = canvasTools.listedIn(pairing, folderId);
          return canvases.length > 0 ? { canvases } : {};
        };
        // No Note it wrote is older than the pairing, which spares reading the others' records.
        const yours = (mind: Mind) =>
          mind.createdAt >= pairing.createdAt && wrote(pairing, mind.id);
        const row = (mind: Mind, own: boolean, inFolder: ReadonlySet<string>) => {
          const call = held.find(
            (each) => each.mindId === mind.id && inFolder.has(each.documentId),
          );
          const mark: AgentHeldCall | null = call
            ? {
                started: call.startedAt && formatFullDateTime(call.startedAt, "en"),
                transcript: call.documentId,
              }
            : null;
          return {
            id: mind.id,
            title: mind.title || mind.autoTitle || t("mind.untitled"),
            updatedAt: mind.updatedAt,
            ...(own && { yours: true as const }),
            ...(mark && (call?.kind === "memo" ? { voiceMemo: mark } : { meeting: mark })),
          };
        };
        // Each Folder it reaches holds only what is filed in it, so the counts add up; one inside
        // another it reaches says where it is, as `run_analysis` names its path (#3394).
        const all = deps.folders();
        const byId = new Map(all.map((folder) => [folder.id, folder]));
        const pathOf = (folder: (typeof all)[number]): string[] => {
          const names = [folder.name];
          const seen = new Set([folder.id]);
          for (let at = folder.parentId; at !== null && reached.has(at) && !seen.has(at); ) {
            const above = byId.get(at);
            if (!above) break;
            seen.add(at);
            names.unshift(above.name);
            at = above.parentId;
          }
          return names;
        };
        const folders: AgentMindList["folders"] = all
          .filter((folder) => reached.has(folder.id))
          .map((folder) => ({ folder, path: pathOf(folder) }))
          .sort((a, b) => comparePaths(a.path, b.path))
          .map(({ folder, path }) => {
            const documentIds = deps.documentsIn([folder.id]);
            const inFolder = new Set(documentIds);
            return {
              id: folder.id,
              name: folder.name,
              ...(path.length > 1 && { path: path.join(" / ") }),
              ...listed(documentIds),
              minds: minds
                .filter((mind) => mind.folderId === folder.id)
                .map((mind) => row(mind, yours(mind), inFolder)),
              ...canvasesIn(folder.id),
            };
          });
        if (reached.has(NOT_IN_A_FOLDER_ID)) {
          const documentIds = deps.documentsIn([NOT_IN_A_FOLDER_ID]);
          // Not a Folder, so it has no Folder's name to say in a sentence: an agent that was
          // given one wrote "in Not in a Folder" (#3487).
          folders.push({
            id: NOT_IN_A_FOLDER_ID,
            name: "",
            ...listed(documentIds),
            minds: minds
              .filter(
                (mind) =>
                  mind.folderId === null &&
                  (sharesAll(pairing) ? reaches(pairing, mind, reached) : yours(mind)),
              )
              .map((mind) => row(mind, yours(mind), new Set(documentIds))),
            ...canvasesIn(NOT_IN_A_FOLDER_ID),
          });
        }
        const line = holdsMore(deps, pairing, reached) ? t("agents.notShared") : null;
        return {
          result: { folders, ...(line !== null && { notShared: line }) },
          count: folders.reduce((sum, folder) => sum + folder.minds.length, 0),
          documentIds: [],
        };
      });
    },

    readMind(input) {
      const mindId = typeof input?.mindId === "string" ? input.mindId : "";
      const effects: Effect[] = [{ action: "read", scope: { kind: "mind", mindId } }];
      const known = deps.minds().find((mind) => mind.id === mindId);
      return call("read_mind", known ? mindName(known) : "", effects, (pairing) => {
        const id = text(input?.mindId, "mindId", 200);
        const offset = whole(input?.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
        if (input?.named !== undefined && typeof input.named !== "boolean") {
          throw new AgentRefusedError("invalid", t("agents.mind.namedChoice"));
        }
        const mind = mindInScope(pairing, id);
        const inScope = new Set(scopeOf(pairing, undefined));
        const live = deps.liveDocuments();
        const cited: string[] = [];
        const own = wrote(pairing, mind.id);
        // Read in a later chat, its words alone don't say that none of them is checked (#3432).
        const left = own && isKnownKind(mind.kind) ? deps.checkTask(mind.id, inScope) : null;
        const unchecked = left?.ok ? left.value.sentences.length : 0;
        const next =
          unchecked === 0
            ? null
            : t(unchecked === 1 ? "agents.read.unchecked.one" : "agents.read.unchecked", {
                count: unchecked,
              });
        if (input?.named === true) {
          const naming = namingOf(own);
          const note = deps.mindBlocks(mind.id, (blocks) =>
            namedNote(blocks, namedWords(pairing, inScope, cited), naming),
          );
          return {
            result: { ...page(mind, note.text, offset), version: note.version, next },
            count: 1,
            documentIds: cited,
          };
        }
        const markdown = deps.mindMarkdown(mind.id, (attributes) => {
          const documentId = typeof attributes.documentId === "string" ? attributes.documentId : "";
          if (!inScope.has(documentId)) {
            return { source: t("agents.mind.outsideCitation"), unverified: false };
          }
          const citation = withShownName(citationOf(attributes), live);
          const where = label(
            citation.location,
            citation.pageFrom,
            citation.pageTo,
            citation.documentId,
            citation.quote,
          );
          const source = where ? `${citation.documentName}, ${where}` : citation.documentName;
          if (citation.check !== "found") return { source, unverified: true };
          cited.push(documentId);
          // Made before Citations kept their Passage: checked, but nothing to mint from.
          if (citation.passageId === "") return { source, unverified: false };
          return {
            agentCite: citeTag(mint(pairing, citation).token),
            source,
            unverified: false,
          };
        });
        return { result: { ...page(mind, markdown, offset), next }, count: 1, documentIds: cited };
      });
    },

    ask(input, signal) {
      const question = typeof input?.question === "string" ? input.question : "";
      return call("ask", question, [READ_DOCUMENTS], async (pairing) => {
        const asked = text(input?.question, "question", MAX_QUERY_CHARS * 4);
        const documentIds = scopeOf(pairing, input?.folderIds);
        const controller = new AbortController();
        const stop = () => controller.abort();
        signal?.addEventListener("abort", stop, { once: true });
        let outcome: OutsideAnswer;
        try {
          outcome = await deps.answer(asked, documentIds, controller.signal);
        } finally {
          signal?.removeEventListener("abort", stop);
        }
        // Local mode turned on while the call was on its way: paused, as every Tool is.
        if (!outcome.asked && outcome.reason === "local-mode") {
          throw new AgentRefusedError("local-mode", t("agents.problem.local-mode"));
        }
        if (!outcome.asked) {
          throw new AgentRefusedError(
            "chat-not-ready",
            t(
              outcome.reason === "consent-needed"
                ? "agents.problem.chat-consent"
                : "agents.problem.chat-not-ready",
            ),
          );
        }
        if (outcome.status === "failed") {
          throw new AgentRefusedError(
            "failed",
            t("agents.problem.answer-failed", { message: outcome.error?.message ?? "" }),
          );
        }
        // An Answer is written from all it read, cited or not: one that read a Document the agent
        // no longer reaches isn't given.
        const granted = stillReaching([
          ...outcome.read,
          ...outcome.citations.map((each) => each.documentId),
        ]);
        const byMarker = new Map(outcome.citations.map((each) => [each.marker, each]));
        const citations: AgentAnswer["citations"] = [];
        let unchecked = 0;
        const answer = outcome.markdown
          .replace(/\[\^(\d{1,4})\]/g, (_whole, number: string) => {
            const citation = byMarker.get(Number(number));
            if (!citation) return "";
            if (citation.check !== "found") {
              unchecked++;
              return t(
                citation.check === "cant-check"
                  ? "agents.answer.cantCheck"
                  : "agents.answer.notFound",
              );
            }
            const tag = citeTag(mint(granted, citation).token);
            if (!citations.some((each) => each.cite === tag)) {
              citations.push({
                cite: tag,
                document: citation.documentName,
                location: label(
                  citation.location,
                  citation.pageFrom,
                  citation.pageTo,
                  citation.documentId,
                  citation.quote,
                ),
                quote: citation.quote,
              });
            }
            return tag;
          })
          .trim();
        const effects: Effect[] = [
          READ_DOCUMENTS,
          ...(outcome.service
            ? [
                {
                  action: "network" as const,
                  scope: {
                    kind: "service" as const,
                    serviceId: outcome.service.id,
                    name: outcome.service.name,
                  },
                },
              ]
            : []),
        ];
        return {
          result: { status: outcome.status, answer, citations, unchecked },
          count: citations.length,
          documentIds: outcome.citations.map((each) => each.documentId),
          effects,
        };
      });
    },

    proposeChanges(input) {
      const mindId = typeof input?.mindId === "string" ? input.mindId : "";
      const effects: Effect[] = [
        READ_DOCUMENTS,
        { action: "write", scope: { kind: "mind", mindId } },
      ];
      const known = deps.minds().find((mind) => mind.id === mindId);
      return call("propose_changes", known ? mindName(known) : "", effects, async (admitted) => {
        if (!admitted.propose) {
          throw new AgentRefusedError("read-only", t("agents.problem.read-only"));
        }
        const mind = mindInScope(admitted, text(input?.mindId, "mindId", 200));
        const version = typeof input?.version === "string" ? input.version.trim() : "";
        if (version === "" || version.length > 100) {
          throw new AgentRefusedError("invalid", t("agents.propose.version"));
        }
        const asked = parseChanges(input?.changes, t);
        const visuals = await visualsFor(
          asked.flatMap((change) => (change.kind === "remove" ? [] : [change.text])),
        );
        // What the User grants may have changed while the pictures were read.
        const pairing = deps.admit(pairingId);
        if (!pairing.propose) {
          throw new AgentRefusedError("read-only", t("agents.problem.read-only"));
        }
        mindInScope(pairing, mind.id);
        const inScope = new Set(scopeOf(pairing, undefined));
        const live = deps.liveDocuments();
        const tokens = new Map<
          string,
          { cited: CitedToken | null; report: AgentCheckedCitation }
        >();
        const texts = asked.flatMap((change) => (change.kind === "remove" ? [] : [change.text]));
        for (const each of texts) {
          for (const match of each.matchAll(CITATION_TOKEN)) {
            const token = match[1] ?? "";
            if (!tokens.has(token)) tokens.set(token, checkToken(pairing, inScope, live, token));
          }
        }
        // A copy of a Note the agent wrote is the User's: its changes wait there (#3371).
        const own = wrote(pairing, mind.id);
        const naming = namingOf(own);
        const key = versionKey(pairing, mind.id);
        const request = deps.newId();
        const mine = (ref: { request: string }) => ref.request === request;
        const write = (blocks: Y.XmlFragment) => {
          const note = namedNote(blocks, namedWords(pairing, inScope, []), naming);
          if (note.version !== version) {
            // Its own last change gave the Note the version it has now: nothing else changed it.
            const cause =
              deps.versions.get(key) === note.version ? "changedByYou" : "changedByUser";
            throw new AgentRefusedError("changed", t(`agents.problem.${cause}`));
          }
          if (note.paragraphs.length === 0 && waitingChanges(blocks) > 0) {
            throw new AgentRefusedError("waiting", t("agents.propose.firstWaiting"));
          }
          const proposed = proposeNamed(blocks, note, placeChanges(asked, note, t), {
            request,
            made: {
              source: "outside-agent",
              agent: pairing.name,
              pairingId: pairing.id,
              createdAt: deps.now(),
            },
            cited: (token) => tokens.get(token)?.cited ?? null,
            notFound: t("agents.answer.notFound"),
            visuals,
            newId: deps.newId,
            ...(own && { checkpoint: () => deps.checkpoint(mind.id) }),
          });
          const kinds = changeKinds(blocks, mine);
          if (own) decideProposals(blocks, mine, "accept");
          const now = namedNote(blocks, namedWords(pairing, inScope, []), naming);
          return { ...proposed, kinds, now, waitingInNote: waitingChanges(blocks) };
        };
        let written: ReturnType<typeof write>;
        let step: string | null = null;
        try {
          if (own) ({ value: written, step } = deps.editOwnMind(mind.id, write));
          else written = deps.editMind(mind.id, write);
        } catch (error) {
          if (error instanceof ChangeRefused) {
            const line = error.left ? visuals.line(error.left) : "";
            throw new AgentRefusedError("invalid", t(error.key, { name: error.paragraph, line }));
          }
          if (!(error instanceof HeldParagraph)) throw error;
          throw new AgentRefusedError(
            "waiting",
            t(error.held === "busy" ? "agents.problem.busy" : "agents.problem.waiting", {
              paragraph: error.paragraph.name,
            }),
          );
        }
        deps.versions.set(key, written.now.version);
        if (own && step !== null) {
          const added = addsOnly(written.kinds) ? countChanged(written.kinds) : 0;
          deps.noteChanged({
            mindId: mind.id,
            agent: pairing.name,
            kind: "changed",
            changed: added > 0 ? 0 : countChanged(written.kinds),
            added,
            tables: written.kinds.filter((kind) => kind === "table-added").length,
            step,
          });
        }
        const citations = [...tokens.values()].map((each) => each.report);
        const { markdown, nextOffset } = page(mind, written.now.text, 0);
        const left = own ? deps.checkTask(mind.id, inScope) : null;
        const unchecked = left?.ok ? left.value.sentences.length : 0;
        return {
          result: {
            mindId: mind.id,
            status: own ? "applied" : "waiting",
            waiting: own ? 0 : written.waiting,
            waitingInNote: written.waitingInNote,
            markdown,
            nextOffset,
            version: written.now.version,
            citations,
            // As the change's bar counts them, from what was written, the Citations kept too.
            uncited: written.uncited.slice(0, MAX_UNCITED).map((sentence) => clip(sentence, 200)),
            refused: leftOut(written.refused),
            next:
              unchecked === 0
                ? null
                : t(unchecked === 1 ? "agents.propose.unchecked.one" : "agents.propose.unchecked", {
                    count: unchecked,
                  }),
          },
          // An activity row of changes that applied at once counts none waiting: null says so.
          count: own ? null : written.waiting,
          documentIds: [...tokens.values()].flatMap((each) =>
            each.cited ? [each.cited.minted.documentId] : [],
          ),
        };
      });
    },

    createMind(input) {
      const named = typeof input?.title === "string" ? input.title.trim() : "";
      const unmade: Effect = { action: "write", scope: { kind: "mind", mindId: "" } };
      return call("create_mind", named, [READ_DOCUMENTS, unmade], async (admitted) => {
        if (!admitted.propose) {
          throw new AgentRefusedError("read-only", t("agents.problem.read-only"));
        }
        const title = text(input?.title, "title", MAX_TITLE_CHARS);
        const draft = typeof input?.markdown === "string" ? input.markdown : "";
        const written = text(
          input?.markdown,
          "markdown",
          MAX_DRAFT_CHARS + inlinePictureChars(draft),
        );
        refuseCallMarkup(title, "title", t);
        refuseCallMarkup(written, "markdown", t);
        placeToWriteIn(admitted, input?.folderId);
        const visuals = await visualsFor([written]);
        // What the User grants may have changed while the pictures were read.
        const pairing = deps.admit(pairingId);
        if (!pairing.propose) {
          throw new AgentRefusedError("read-only", t("agents.problem.read-only"));
        }
        const folder = placeToWriteIn(pairing, input?.folderId);
        // Counted once the pictures are read: from here the Note is written without a wait.
        const since = new Date(Date.parse(deps.now()) - HOUR_MS).toISOString();
        if (deps.notesWrittenSince(pairing.id, since) >= MAX_NOTES_AN_HOUR) {
          throw new AgentRefusedError(
            "too-many",
            t("agents.problem.too-many", { max: MAX_NOTES_AN_HOUR }),
          );
        }
        const inScope = new Set(scopeOf(pairing, undefined));
        const live = deps.liveDocuments();
        const tokens = new Map<
          string,
          { cited: CitedToken | null; report: AgentCheckedCitation }
        >();
        for (const match of written.matchAll(CITATION_TOKEN)) {
          const token = match[1] ?? "";
          if (!tokens.has(token)) tokens.set(token, checkToken(pairing, inScope, live, token));
        }
        let made: ReturnType<typeof newBlocks>;
        try {
          made = newBlocks(written, t("agents.create.text"), {
            cited: (token) => tokens.get(token)?.cited ?? null,
            notFound: t("agents.answer.notFound"),
            visuals,
          });
        } catch (error) {
          if (!(error instanceof ChangeRefused)) throw error;
          throw new AgentRefusedError("invalid", t(error.key, { name: error.paragraph }));
        }
        // Named by its title heading, as a Note written in the window is, so the name follows the
        // heading whoever changes it (#3378). A text that begins with a heading 1, or with a
        // heading in the words of `title`, keeps it as its title; any other gets `title` as its
        // heading above it, as the page shows no title of its own (#3466). A text in tabs begins
        // inside its first, and so does a title heading written above it (#3414).
        const [above, start] = made.nodes;
        const nodes =
          above?.type === "heading" && above.attrs?.level === 1 && start?.type === NOTE_TAB_NODE
            ? [start, above, ...made.nodes.slice(2)]
            : made.nodes;
        const opens = nodes[0]?.type === NOTE_TAB_NODE ? 1 : 0;
        const first = nodes[opens];
        const ownHeading = first?.type === "heading";
        const titleHeading =
          ownHeading && first.attrs?.level === 1 && (first.content?.length ?? 0) > 0;
        const titled =
          titleHeading ||
          (ownHeading &&
            comparableName((first.content ?? []).map((each) => each.text ?? "").join("")) ===
              comparableName(title));
        const mind = deps.createMind(titled && !titleHeading ? title : "", folder.id);
        const heading = {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: title }],
        };
        deps.editMind(mind.id, (blocks) => {
          insertBlocks(
            blocks,
            titled ? nodes : [...nodes.slice(0, opens), heading, ...nodes.slice(opens)],
          );
          if (!blocks.doc) return;
          const ids = blocks.toArray().flatMap((each) => {
            const id = each instanceof Y.XmlElement ? each.getAttribute(BLOCK_ID_ATTRIBUTE) : null;
            return typeof id === "string" ? [id] : [];
          });
          setTextOrigin(blocks.doc, ids, "outside-agent");
          recordNoteWriter(blocks.doc, {
            source: "outside-agent",
            agent: pairing.name,
            pairingId: pairing.id,
            mindId: mind.id,
            createdAt: deps.now(),
          });
        });
        deps.noteChanged({
          mindId: mind.id,
          agent: pairing.name,
          kind: "wrote",
          changed: 0,
          added: 0,
          tables: 0,
          step: null,
        });
        opened({ kind: "mind", mindId: mind.id });
        const listed = deps.minds().find((each) => each.id === mind.id);
        return {
          result: {
            mindId: mind.id,
            title: (listed && mindName(listed)) || title,
            folder: folder.name,
            citations: [...tokens.values()].map((each) => each.report),
            uncited: uncitedIn(
              [proseOf(written)],
              (token) => tokens.get(token)?.cited?.citable === true,
            ),
            refused: leftOut(made.refused),
          },
          count: 1,
          documentIds: [...tokens.values()].flatMap((each) =>
            each.cited ? [each.cited.minted.documentId] : [],
          ),
          effects: [READ_DOCUMENTS, { action: "write", scope: { kind: "mind", mindId: mind.id } }],
        };
      });
    },

    checkMind(input) {
      const mindId = typeof input?.mindId === "string" ? input.mindId : "";
      const known = deps.minds().find((mind) => mind.id === mindId);
      // Its marks are written into the Note, and its sentences go to the User's AI model.
      const effects: Effect[] = [
        READ_DOCUMENTS,
        { action: "write", scope: { kind: "mind", mindId } },
      ];
      return call("check_mind", known ? mindName(known) : "", effects, async (pairing) => {
        const mind = ownNote(pairing, input?.mindId);
        const { running } = deps.checkRuns;
        const run = checkOf(pairing, mind.id);
        const outcome = await within(run, deps.checkWaitMs ?? CHECK_WAIT_MS);
        // Its end is told once: the call after starts a Check of what changed since.
        if (outcome && running.get(mind.id) === run) running.delete(mind.id);
        if (outcome && !outcome.asked) throw notAsked(outcome.reason, mind);
        const result = outcome?.result ?? null;
        if (result?.kind === "not-ready") throw notAsked("not-ready", mind);
        if (result?.kind === "local-mode") throw notAsked("local-mode", mind);
        if (result?.kind === "failed") {
          throw new AgentRefusedError(
            "failed",
            t("agents.check.failed", { message: result.error.message }),
          );
        }
        if (result?.kind === "no-documents") throw noDocuments(mind);
        const stopped =
          result?.kind === "cancelled"
            ? t("agents.check.stopped.user")
            : result?.kind === "checked" && result.stop
              ? t(`agents.check.stopped.${result.stop.reason}`)
              : null;
        const { note, listed, read } = await checkedNote(mind.id);
        return {
          result: {
            mindId: mind.id,
            title: mindName(mind),
            status:
              !result || result.kind === "running" ? "running" : stopped ? "stopped" : "checked",
            stopped,
            ...note,
          },
          count: listed,
          documentIds: read,
        };
      });
    },

    checkMindYourself(input) {
      const mindId = typeof input?.mindId === "string" ? input.mindId : "";
      const known = deps.minds().find((mind) => mind.id === mindId);
      const effects: Effect[] = [{ action: "read", scope: { kind: "mind", mindId } }];
      return call("check_mind_yourself", known ? mindName(known) : "", effects, async (pairing) => {
        const mind = ownNote(pairing, input?.mindId);
        const found = deps.checkTask(mind.id, checkReach(pairing), input?.again === true);
        if (!found.ok) throw notJudged(found.reason, mind);
        workOut.checks(pairing.id, mind.id);
        const { task, sentences } = found.value;
        const given = { mindId: mind.id, title: mindName(mind), task, sentences };
        if (sentences.length > 0) {
          return {
            result: { ...given, how: howToJudge(mind.folderId) },
            count: sentences.length,
            documentIds: [],
          };
        }
        // A Note checked already, in this chat or another: what the User asks is answered from its marks (#3465).
        const { note, read } = await checkedNote(mind.id);
        return {
          result: { ...given, how: t("agents.check.nothingLeft"), checked: note },
          count: 0,
          documentIds: read,
          effects: [...effects, READ_DOCUMENTS],
        };
      });
    },

    reportCheck(input) {
      const mindId = typeof input?.mindId === "string" ? input.mindId : "";
      const known = deps.minds().find((mind) => mind.id === mindId);
      const effects: Effect[] = [
        READ_DOCUMENTS,
        { action: "write", scope: { kind: "mind", mindId } },
      ];
      return call("report_check", known ? mindName(known) : "", effects, (pairing) => {
        const mind = ownNote(pairing, input?.mindId);
        const task = text(input?.task, "task", 200);
        if (!Array.isArray(input?.results) || input.results.length > MAX_REPORTED_SENTENCES) {
          throw new AgentRefusedError(
            "invalid",
            t("agents.check.results", { max: MAX_REPORTED_SENTENCES }),
          );
        }
        const reach = reachOf(pairing);
        const inScope = reach.documentIds;
        const worked = new Set<string>();
        const workings: string[] = [];
        const confirmed = new Map<string, Citation | null>();
        const citationOfToken = (given: string): Citation | null => {
          const token = [...given.matchAll(CITATION_TOKEN)][0]?.[1] ?? given.trim();
          if (!confirmed.has(token)) {
            const kept = deps.citations.find(pairing.id, token);
            confirmed.set(
              token,
              kept && usable(inScope, kept.documentId) && !deps.notCited(kept.passageId)
                ? foundNow(kept, recheckKept(kept))
                : null,
            );
          }
          return confirmed.get(token) ?? null;
        };
        const judged = input.results.flatMap((each: unknown): JudgedSentence[] => {
          if (!isRecord(each) || typeof each.n !== "number" || !Number.isInteger(each.n)) return [];
          const verdict = OWN_VERDICTS[each.verdict as OwnVerdict];
          if (verdict === undefined) return [];
          const cites: unknown[] = Array.isArray(each.cites) ? each.cites : [];
          const working = isRecord(each.working)
            ? workedFrom(each.working, citationOfToken)
            : undefined;
          if (working && !working.ok) workings.push(`${each.n}: ${working.problem}`);
          const run = working
            ? working.ok
              ? working.worked
              : null
            : typeof each.run === "string" && each.run.trim() !== ""
              ? workOut.confirmed(each.run, pairing.id, mind.id, reach)
              : undefined;
          if (run?.ok) for (const id of run.backing.documentIds) worked.add(id);
          return [
            {
              n: each.n,
              verdict,
              evidence: cites.flatMap((cite) =>
                typeof cite === "string" ? (citationOfToken(cite) ?? []) : [],
              ),
              ...(run !== undefined && { worked: run }),
              explanation:
                typeof each.explanation === "string" && each.explanation.trim() !== ""
                  ? clip(each.explanation.trim(), READY_QUOTE_CHARS)
                  : null,
            },
          ];
        });
        const landed = deps.landJudged(mind.id, inScope, pairing.name, task, judged);
        if (!landed.ok) throw notJudged(landed.reason, mind);
        const { marked, unconfirmed, unreported } = landed.value;
        return {
          result: {
            mindId: mind.id,
            title: mindName(mind),
            marked,
            unconfirmed,
            unreported,
            next:
              unconfirmed.length > 0 || unreported.length > 0
                ? [t("agents.check.reportAgain"), ...workings].join("\n")
                : null,
          },
          count: marked,
          documentIds: [
            ...new Set([
              ...[...confirmed.values()].flatMap((each) => (each ? [each.documentId] : [])),
              ...worked,
            ]),
          ],
        };
      });
    },

    runAnalysis(input, signal) {
      const title = typeof input?.title === "string" ? input.title : "";
      const effects: Effect[] = [READ_DOCUMENTS, { action: "execute", scope: { kind: "sandbox" } }];
      return call("run_analysis", title, effects, async (pairing) => {
        if (!pythonRuns(deps.analysisRuntime)) {
          throw new AgentRefusedError("no-python", t("agents.problem.no-python"));
        }
        if (pairing.folderIds.length === 0) {
          throw new AgentRefusedError("no-folders", t("agents.problem.no-folders"));
        }
        const given = isRecord(input) ? input : {};
        const done = await workOut.analyse(
          given,
          workFor(pairing),
          signal ?? new AbortController().signal,
        );
        // Worked out from what it read: none of it is given once the agent no longer reaches that.
        stillReaching(done.documentIds);
        return { ...done, count: done.result.id === null ? 0 : 1 };
      });
    },

    publishCanvas: canvasTools.publishCanvas,
    readCanvas: canvasTools.readCanvas,
    updateCanvas: canvasTools.updateCanvas,
    async handOverFile(input) {
      const handed = await handedFileTool.handOverFile(input);
      if (handed.mindId !== null) opened({ kind: "mind", mindId: handed.mindId });
      return handed;
    },
    readRequest(input) {
      const named = typeof input?.note === "string" ? comparableName(input.note) : "";
      const minds = new Map(deps.minds().map((mind) => [mind.id, mind]));
      const titleOf = (mindId: string) => {
        const mind = minds.get(mindId);
        return mind ? mindName(mind) || t("mind.untitled") : "";
      };
      // The Note the User's line names, when the agent passes it on: by the name the line gave it,
      // else by its name now. A request about it that was read already is never made up for by
      // another Note's, which waits for its own line.
      const kept = deps.requests.ofPairing(pairingId);
      const given = kept.filter((each) => comparableName(each.title) === named);
      const about =
        given.length > 0
          ? given
          : kept.filter(
              (each) => each.mindId !== null && comparableName(titleOf(each.mindId)) === named,
            );
      const chosen = (named !== "" && about.length > 0 ? about : kept).find(
        (each) => each.readAt === null,
      );
      const effects: Effect[] = chosen?.mindId
        ? [{ action: "read", scope: { kind: "mind", mindId: chosen.mindId } }]
        : [];
      // Nothing waiting is a look that found nothing, not a failure of the agent's call (#3533):
      // its activity line says it looked, as it always did.
      const none = {
        result: { mindId: null, title: "", request: t("agents.request.none") },
        count: 0,
        documentIds: [],
      };
      // What a request about no Note names is not said until it is read: only then are its
      // Documents and Folders known to be the agent's to read, and named as they are by then.
      const summary = chosen?.mindId ? titleOf(chosen.mindId) : "";
      return call("read_request", summary, effects, (pairing) => {
        if (!chosen) return none;
        if (chosen.mindId !== null) {
          const mind = minds.get(chosen.mindId);
          if (!mind) {
            // Sharing a Folder can't bring it back, so the request goes rather than wait in front of
            // the User's next one.
            deps.requests.markRead(chosen.id);
            throw new AgentRefusedError("not-found", t("agents.problem.requestNoteDeleted"));
          }
          if (!reaches(pairing, mind)) {
            throw new AgentRefusedError("outside-scope", t("agents.problem.requestOutOfReach"));
          }
        }
        const looking = chosen.named === null ? null : lookingNow(pairing, chosen.named);
        const [first] = [
          ...(looking?.open ?? []),
          ...(looking?.documents ?? []),
          ...(looking?.folders ?? []),
        ];
        if (
          looking !== null &&
          chosen.mindId === null &&
          !first &&
          chosen.named?.organize !== "loose"
        ) {
          // Everything it named was deleted since: nothing is left to go on, as for a deleted Note.
          deps.requests.markRead(chosen.id);
          throw new AgentRefusedError("not-found", t("agents.problem.requestNoteDeleted"));
        }
        const request =
          looking && chosen.named?.organize
            ? sortingRequest(pairing, chosen.named.organize, looking)
            : [chosen.text, looking ? lookingText(looking, t) : ""]
                .filter((part) => part !== "")
                .join("\n\n");
        const read = deps.requests.markRead(chosen.id, request);
        if (!read) return none;
        askedFromIncarnaMind = true;
        // As the line named it: the Note, else the Document in front.
        const title =
          chosen.mindId !== null
            ? titleOf(chosen.mindId)
            : chosen.named?.organize
              ? chosen.title
              : (looking?.open[0]?.name ?? "");
        return {
          result: { mindId: chosen.mindId, title, request },
          count: 1,
          documentIds: [],
          requestId: read.id,
          summary: title,
        };
      });
    },
  };
}

/** A Note's name as the User's line may give it: without its quotation marks or case. */
const comparableName = (name: string) =>
  name
    .normalize("NFC")
    .trim()
    .replace(/^["“”'‘’「」『』]+|["“”'‘’「」『』]+$/gu, "")
    .trim()
    .toLocaleLowerCase();

/** A Citation node's Location: stored as an object, or as its JSON. */
function locationOf(value: unknown): CitationLocation | null {
  if (typeof value === "string") {
    try {
      return locationOf(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && "kind" in value
    ? (value as CitationLocation)
    : null;
}

/** A Mind's Citation, from its node's attributes, as minting reads one. */
function citationOf(attributes: Record<string, unknown>): Citation {
  const string = (value: unknown) => (typeof value === "string" ? value : "");
  const unit = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
  const check = string(attributes.check);
  return {
    passageId: string(attributes.passageId),
    documentId: string(attributes.documentId),
    documentName: string(attributes.documentName),
    contentHash: string(attributes.contentHash),
    pageFrom: unit(attributes.pageFrom),
    pageTo: unit(attributes.pageTo) ?? unit(attributes.pageFrom),
    location: locationOf(attributes.location),
    quote: string(attributes.quote),
    check:
      check === "found" || check === "not-found" || check === "cant-check" ? check : "not-found",
    checkReason: null,
  };
}
