/**
 * What an outside agent can do with IncarnaMind (#351): the one interface
 * every way in uses, the MCP server now (./mcp), and a command line or an ACP
 * host later. Each call comes from a pairing and is untrusted input, so it is
 * checked here, not in the transport: the pairing must still exist,
 * connecting agents be on, Local mode off and the User's consent in place,
 * and it reaches only the Documents in the pairing's Folders and those
 * Folders' Minds, and, if Not in a Folder is one of them, the Documents in no
 * Folder at the time of each call (never a Mind). Nothing here changes the
 * User's Documents, and a Mind only through `propose_changes`, which the User
 * allows per pairing and whose changes wait for them as Proposals (#352,
 * ./proposals).
 *
 * Only IncarnaMind mints a Citation (./citations): a quote is checked first,
 * by the Citation check Answers use, and gets a token only once found. A
 * search returns each Passage with a ready token for its best-matching
 * sentence, so an agent can cite without a second call. `ask` runs
 * IncarnaMind's own Answer on the User's chat model and returns it with its
 * Citations as tokens. Every call is recorded for the pairing's activity list.
 */

import { randomUUID } from "node:crypto";
import type * as Y from "yjs";
import { citedLocation, type LiveDocument, withShownName } from "../../shared/citations";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { mindName } from "../../shared/naming";
import type { OutsideAnswer } from "../answers";
import type { Citing } from "../answers/citing";
import { matchingTerms } from "../answers/citing";
import {
  type AgentActivity,
  type AgentCitationShown,
  type AgentProblem,
  type AgentToolName,
  type Citation,
  type CitationLocation,
  type CitationRecheck,
  type Effect,
  type Mind,
  NOT_IN_A_FOLDER_ID,
} from "../api";
import { keywordTerms } from "../documents/keywords";
import type { WindowedPassage } from "../documents/search";
import type { SearchToolParameters } from "../documents/searchTool";
import { isRecord } from "../errors";
import { type AgentCitation, type AgentCitations, CITATION_TOKEN, citeTag } from "./citations";
import {
  ChangeRefused,
  type CitedToken,
  HeldParagraph,
  type NamedChange,
  namedNote,
  proposeNamed,
} from "./proposals";

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
  /** The Passage's text, at most `PASSAGE_CHARS` characters around `quote`. */
  text: string;
}

export interface AgentSearchResult {
  passages: AgentPassage[];
  page: number;
  /** There are more results on the next page. */
  more: boolean;
}

export interface AgentReadInput {
  /** Read around this Passage. */
  passageId?: string;
  /** Or read this Document from its start. */
  documentId?: string;
  /** Passages before `passageId` to read too, at most `MAX_AROUND`. */
  before?: number;
  /** Passages after it (or after the start of `documentId`) to read too, at most `MAX_AROUND`. */
  after?: number;
}

export interface AgentReadResult {
  documentId: string;
  document: string;
  passages: { passageId: string; location: string | null; text: string }[];
  /** The Passage before the first one read, to read on backwards; null at the start. */
  previous: string | null;
  /** The Passage after the last one read, to read on; null at the end. */
  next: string | null;
}

export interface AgentCiteInput {
  citations: { passageId: string; quote: string }[];
}

export interface AgentCited {
  passageId: string;
  quote: string;
  /** "found": the quote is word for word at that Location. Never a verdict on the claim. */
  check: "found" | "not-found" | "cant-check";
  /** The Citation to write, when found; null otherwise. */
  cite: string | null;
  document: string | null;
  location: string | null;
  /** When not found: the Passage's text, to copy the quote from exactly. */
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
    /** How many Documents it holds. */
    documents: number;
    minds: { id: string; title: string; updatedAt: string }[];
  }[];
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
  /** How many of its changes wait for the User in the Note: none applies until they accept it. */
  waiting: number;
  /** Each token in the text, checked again against its Document as it is now. */
  citations: AgentCheckedCitation[];
  /** Sentences of the text with no Citation in them, at most `MAX_UNCITED`. */
  uncited: string[];
}

export interface AgentAskInput {
  question: string;
  /** Only these of the pairing's Folders; all of them when absent. */
  folderIds?: string[];
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
  listMinds(): Promise<AgentMindList>;
  readMind(input: AgentReadMindInput): Promise<AgentMindText>;
  ask(input: AgentAskInput, signal?: AbortSignal): Promise<AgentAnswer>;
  /** Proposes changes to a Note, which wait for the User (#352); never applied by the agent. */
  proposeChanges(input: AgentProposeInput): Promise<AgentProposed>;
}

/** Why a call was refused or failed, in the interface language, for the agent to pass on. */
export class AgentRefusedError extends Error {
  constructor(
    readonly problem: AgentProblem,
    message: string,
  ) {
    super(message);
    this.name = "AgentRefusedError";
  }
}

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
/** The longest summary kept of a call for the activity list. */
const SUMMARY_CHARS = 300;
/** The longest quote a ready Citation of a search result has. */
const READY_QUOTE_CHARS = 300;

// ---------------------------------------------------------------------------
// What it needs

/** A pairing allowed to call now. */
export interface AdmittedPairing {
  id: string;
  name: string;
  folderIds: string[];
  /** The User let it propose changes to the Notes in its Folders. */
  propose: boolean;
}

export interface AgentAccessDeps {
  /** The pairing, if it may call now; otherwise throws `AgentRefusedError`. */
  admit(pairingId: string): AdmittedPairing;
  /** The live Folders. */
  folders(): { id: string; name: string; keepInside: boolean }[];
  /** The Folder ids a pairing may read after Folder walls are applied. */
  foldersInScope(folderIds: readonly string[]): string[];
  /** The ids of the live Documents in these Folders; `NOT_IN_A_FOLDER_ID` stands for those in no Folder now. */
  documentsIn(folderIds: readonly string[]): string[];
  /** The search Answers use, without reranking, over these Documents. */
  search(
    query: string,
    documentIds: readonly string[],
    parameters: Partial<SearchToolParameters>,
    signal?: AbortSignal,
  ): Promise<WindowedPassage[]>;
  passage(passageId: string): WindowedPassage | null;
  passagesBetween(documentId: string, from: number, to: number): WindowedPassage[];
  citing: Pick<Citing, "citeQuote" | "locate">;
  /** Whether the Passage's Document is the User's own workings: an agent reads it and never cites it. */
  notCited(passageId: string): boolean;
  /** A Citation checked again against its Document as it is now. */
  recheck(input: {
    documentId: string;
    quote: string;
    pageFrom: number | null;
    pageTo: number | null;
  }): CitationRecheck;
  /** Shows a Citation in the viewer, the app in front. */
  show(place: AgentCitationShown): void;
  /** The Minds there are. */
  minds(): Mind[];
  /** The live Documents' names: what a Citation is shown with, when its Document was renamed since. */
  liveDocuments(): readonly LiveDocument[];
  /** Reads a Mind's Blocks, leaving it unloaded if it was. */
  mindBlocks<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T;
  /** Changes a Mind's Blocks in one Yjs transaction, stored and sent to its open windows. */
  editMind<T>(mindId: string, change: (blocks: Y.XmlFragment) => T): T;
  /** A Mind as Markdown, each Citation's footnote as `footnote` words it (see ../exports). */
  mindMarkdown(
    mindId: string,
    footnote: (attributes: Record<string, unknown>) => { source: string; unverified: boolean },
  ): string;
  /** IncarnaMind's Answer to a Question from these Documents, on the default chat model. */
  answer(question: string, documentIds: string[], signal: AbortSignal): Promise<OutsideAnswer>;
  citations: AgentCitations;
  /** Keeps a call for the pairing's activity list. */
  record(activity: Omit<AgentActivity, "id" | "at">): void;
  /** A message in the interface language. */
  say(key: MessageKey, params?: MessageParams): string;
  /** Milliseconds, for how long a call took. */
  clock(): number;
  /** Now, ISO 8601, UTC. */
  now(): string;
  reportError(error: unknown): void;
}

// ---------------------------------------------------------------------------
// Helpers

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

/** Long enough to be a claim: four words, or ten Chinese characters. */
function makesAClaim(sentence: string): boolean {
  const han = sentence.match(HAN)?.length ?? 0;
  if (han >= 10) return true;
  return sentence.split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word)).length >= 4;
}

/** The part of a Passage's text an agent gets: all of it, or `PASSAGE_CHARS` around `quote`. */
function excerpt(text: string, quote: string | null): string {
  if (text.length <= PASSAGE_CHARS) return text;
  const at = quote ? Math.max(0, text.indexOf(quote)) : 0;
  const centre = at + (quote?.length ?? 0) / 2;
  const start = Math.max(
    0,
    Math.min(text.length - PASSAGE_CHARS, Math.round(centre - PASSAGE_CHARS / 2)),
  );
  const end = start + PASSAGE_CHARS;
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

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentRefusedError("invalid", `${what} must be text.`);
  }
  if (value.length > max) {
    throw new AgentRefusedError("invalid", `${what} is longer than ${max} characters.`);
  }
  return value.trim();
}

function whole(value: unknown, what: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AgentRefusedError("invalid", `${what} must be a whole number from ${min} to ${max}.`);
  }
  return value;
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
        each
          .replace(/^#{1,6}\s.*$/gm, "")
          .replace(/^\s*\|.*$/gm, "")
          .replace(/^\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])?\s+/gm, "")
          .replace(CITATION_TOKEN, (_whole, token: string) => (counts(token) ? CITED : "")),
      ),
    )
    .filter((sentence) => !sentence.includes(CITED) && makesAClaim(sentence))
    .slice(0, MAX_UNCITED)
    .map((sentence) => clip(sentence, 200));
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
  if (value.length > MAX_CHANGE_CHARS) {
    throw new AgentRefusedError(
      "invalid",
      t("agents.propose.textTooLong", { name, max: MAX_CHANGE_CHARS }),
    );
  }
  return value.trim();
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

/** The changes, each for the named paragraph it is for, in a Note of `count` named paragraphs. */
function placeChanges(asked: readonly AskedChange[], count: number, t: Say): NamedChange[] {
  const named = new Set<number>();
  let before: number | null = null;
  return asked.map((change): NamedChange => {
    const n = change.n ?? (before === null ? null : before + 1);
    if (n === null) throw new AgentRefusedError("invalid", t("agents.propose.firstAdd"));
    if (n < 1 || n > count) {
      throw new AgentRefusedError(
        "invalid",
        count === 0
          ? t("agents.propose.noParagraphs", { name: change.name })
          : t("agents.propose.outOfRange", { name: change.name, count }),
      );
    }
    before = n - 1;
    if (change.kind === "add") return { kind: "add", after: n - 1, text: change.text };
    if (named.has(n)) {
      throw new AgentRefusedError("invalid", t("agents.propose.twice", { name: change.name }));
    }
    named.add(n);
    return change.kind === "remove"
      ? { kind: "remove", at: n - 1 }
      : { kind: "rewrite", at: n - 1, text: change.text };
  });
}

/** What a call returns, with what its activity row says of it. */
interface Done<T> {
  result: T;
  count: number | null;
  documentIds: string[];
  effects?: Effect[];
}

// ---------------------------------------------------------------------------
// The implementation

/** The core interface for one pairing's calls. */
export function createAgentAccess(deps: AgentAccessDeps, pairingId: string): AgentAccess {
  const t: Say = (key, params) => deps.say(key, params);
  const label = (
    location: CitationLocation | null,
    pageFrom: number | null,
    pageTo: number | null,
  ) => citedLocation({ location, pageFrom, pageTo }, t);

  /** Runs a call: admits the pairing, then records what came of it. */
  async function call<T>(
    tool: AgentToolName,
    summary: string,
    effects: Effect[],
    run: (pairing: AdmittedPairing) => Promise<Done<T>> | Done<T>,
  ): Promise<T> {
    const started = deps.clock();
    const record = (outcome: AgentActivity["outcome"], rest: Partial<AgentActivity>) => {
      try {
        deps.record({
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
        });
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
      record("done", {
        count: done.count,
        documentIds: [...new Set(done.documentIds)],
        effects: done.effects ?? effects,
      });
      return done.result;
    } catch (error) {
      if (error instanceof AgentRefusedError) {
        record(error.problem === "failed" ? "failed" : "refused", { problem: error.problem });
        throw error;
      }
      deps.reportError(error);
      record("failed", { problem: "failed" });
      throw new AgentRefusedError("failed", t("agents.problem.failed"));
    }
  }

  /** The Documents a call may read: its pairing's Folders, or only those of them it names. */
  const scopeOf = (pairing: AdmittedPairing, folderIds: unknown): string[] => {
    if (pairing.folderIds.length === 0) {
      throw new AgentRefusedError("no-folders", t("agents.problem.no-folders"));
    }
    const effective = deps.foldersInScope(pairing.folderIds);
    if (folderIds === undefined) return deps.documentsIn(effective);
    if (!Array.isArray(folderIds) || !folderIds.every((id) => typeof id === "string")) {
      throw new AgentRefusedError("invalid", "folderIds must be a list of Folder ids.");
    }
    if (folderIds.length === 0) return deps.documentsIn(effective);
    if (!folderIds.every((id) => effective.includes(id))) {
      throw new AgentRefusedError("outside-scope", t("agents.problem.outside-scope"));
    }
    return deps.documentsIn(folderIds);
  };

  /** A live Passage of these Documents, or a refusal that tells nothing of the others. */
  const passageInScope = (inScope: ReadonlySet<string>, passageId: unknown): WindowedPassage => {
    const id = text(passageId, "passageId", 200);
    const passage = deps.passage(id);
    if (!passage || !inScope.has(passage.documentId)) {
      throw new AgentRefusedError("not-found", t("agents.problem.not-found"));
    }
    return passage;
  };

  const passageLocation = (passage: WindowedPassage) => {
    const location = deps.citing.locate(passage);
    return label(location, passage.pageFrom, passage.pageTo);
  };

  /** Mints the token of a Citation the check found. */
  const mint = (pairing: AdmittedPairing, citation: Citation): AgentCitation =>
    deps.citations.mint(pairing.id, citation);

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
    return {
      passageId: passage.passageId,
      documentId: passage.documentId,
      document: passage.documentName,
      location: found
        ? label(found.location, found.pageFrom, found.pageTo)
        : passageLocation(passage),
      quote: found ? found.quote : null,
      cite: minted ? citeTag(minted.token) : null,
      text: excerpt(passage.text, found?.quote ?? null),
    };
  };

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
    if (!kept || !inScope.has(kept.documentId)) {
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
    const now = deps.recheck({
      documentId: kept.documentId,
      quote: kept.quote,
      pageFrom: kept.pageFrom,
      pageTo: kept.pageTo,
    });
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
    const attributes =
      check === "found" && now.contentHash !== null
        ? {
            ...asMinted,
            passageId: now.passageId ?? kept.passageId,
            contentHash: now.contentHash,
            pageFrom: now.pageFrom,
            pageTo: now.pageTo,
            location: now.location ?? kept.location,
            check: "found",
            checkReason: null,
          }
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
        location: label(now.location ?? kept.location, now.pageFrom, now.pageTo),
        quote: kept.quote,
        changed,
      },
    };
  };

  /** A Mind in the pairing's Folders, or a refusal that tells nothing of the others. */
  const mindInScope = (pairing: AdmittedPairing, mindId: string): Mind => {
    const mind = deps.minds().find((each) => each.id === mindId);
    if (
      !mind ||
      mind.folderId === null ||
      !deps.foldersInScope(pairing.folderIds).includes(mind.folderId)
    ) {
      throw new AgentRefusedError("not-found", t("agents.problem.not-found"));
    }
    return mind;
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
  });

  return {
    search(input, signal) {
      const query = typeof input?.query === "string" ? input.query : "";
      return call("search", query, [READ_DOCUMENTS], async (pairing) => {
        const words = text(input?.query, "query", MAX_QUERY_CHARS);
        const page = whole(input?.page, "page", 1, MAX_SEARCH_PAGE, 1);
        const documentIds = scopeOf(pairing, input?.folderIds);
        if (documentIds.length === 0) {
          return { result: { passages: [], page, more: false }, count: 0, documentIds: [] };
        }
        // Enough for this page and one more result, to know if there is a next page.
        const wanted = SEARCH_PAGE_SIZE * page + 1;
        const found = await deps.search(
          words,
          documentIds,
          { maxPassages: wanted, maxDocuments: wanted, candidates: 30 * page },
          signal,
        );
        const ranked = [...found].sort(
          (a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY),
        );
        const shown = ranked.slice(SEARCH_PAGE_SIZE * (page - 1), SEARCH_PAGE_SIZE * page);
        const terms = keywordTerms(words);
        const passages = shown.map((passage) => asResult(pairing, passage, terms));
        return {
          result: { passages, page, more: ranked.length > SEARCH_PAGE_SIZE * page },
          count: passages.length,
          documentIds: passages.map((passage) => passage.documentId),
        };
      });
    },

    readPassages(input) {
      return call("read_passages", "", [READ_DOCUMENTS], (pairing) => {
        const before = whole(input?.before, "before", 0, MAX_AROUND, 0);
        const after = whole(input?.after, "after", 0, MAX_AROUND, input?.passageId ? 0 : 2);
        let documentId: string;
        let from: number;
        let to: number;
        if (input?.passageId !== undefined) {
          const passage = passageInScope(new Set(scopeOf(pairing, undefined)), input.passageId);
          documentId = passage.documentId;
          from = Math.max(0, passage.position - before);
          to = passage.position + after;
        } else {
          documentId = text(input?.documentId, "passageId or documentId", 200);
          if (!scopeOf(pairing, undefined).includes(documentId)) {
            throw new AgentRefusedError("not-found", t("agents.problem.not-found"));
          }
          from = 0;
          to = after;
        }
        // One more on each side, to say whether there is more to read.
        const read = deps.passagesBetween(documentId, Math.max(0, from - 1), to + 1);
        const inRange = read.filter((each) => each.position >= from && each.position <= to);
        const first = inRange[0];
        if (!first) throw new AgentRefusedError("not-found", t("agents.problem.not-found"));
        const previous = read.find((each) => each.position === from - 1)?.passageId ?? null;
        const next = read.find((each) => each.position === to + 1)?.passageId ?? null;
        return {
          result: {
            documentId,
            document: first.documentName,
            passages: inRange.map((passage) => ({
              passageId: passage.passageId,
              location: passageLocation(passage),
              text: passage.text,
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
      return call("cite", summary, [READ_DOCUMENTS], (pairing) => {
        if (list.length === 0 || list.length > MAX_CITES) {
          throw new AgentRefusedError(
            "invalid",
            `citations must list 1 to ${MAX_CITES} quotes, each with its passageId.`,
          );
        }
        const inScope = new Set(scopeOf(pairing, undefined));
        const read: string[] = [];
        const citations: AgentCited[] = list.map((entry) => {
          const record = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
            string,
            unknown
          >;
          const passage = passageInScope(inScope, record.passageId);
          if (deps.notCited(passage.passageId)) {
            throw new AgentRefusedError(
              "invalid",
              "That Passage is from the User's own working file, which is read but never cited.",
            );
          }
          read.push(passage.documentId);
          const quote = text(record.quote, "quote", MAX_QUOTE_CHARS);
          const citation = deps.citing.citeQuote(passage.passageId, quote);
          if (!citation) throw new AgentRefusedError("not-found", t("agents.problem.not-found"));
          const check =
            citation.check === "found" || citation.check === "cant-check"
              ? citation.check
              : "not-found";
          const minted = check === "found" ? mint(pairing, citation) : null;
          return {
            passageId: passage.passageId,
            quote: citation.quote,
            check,
            cite: minted ? citeTag(minted.token) : null,
            document: citation.documentName,
            location: label(citation.location, citation.pageFrom, citation.pageTo),
            text: check === "found" ? null : excerpt(passage.text, null),
          };
        });
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
          if (!kept || !inScope.has(kept.documentId)) {
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
          });
          const check =
            now.check === "found" || now.check === "cant-check" ? now.check : "not-found";
          citations.push({
            cite: citeTag(token),
            check,
            document: withShownName(kept, live).documentName,
            location: label(now.location ?? kept.location, now.pageFrom, now.pageTo),
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
        if (!kept || !scopeOf(pairing, undefined).includes(kept.documentId)) {
          throw new AgentRefusedError("not-found", t("agents.problem.not-found"));
        }
        const now = deps.recheck({
          documentId: kept.documentId,
          quote: kept.quote,
          pageFrom: kept.pageFrom,
          pageTo: kept.pageTo,
        });
        if (now.contentHash === null) {
          throw new AgentRefusedError("not-found", t("agents.problem.not-found"));
        }
        const where = label(now.location ?? kept.location, now.pageFrom, now.pageTo);
        deps.show({
          documentId: kept.documentId,
          ...(now.pageFrom !== null && { pageFrom: now.pageFrom }),
          ...(now.pageTo !== null && { pageTo: now.pageTo }),
          quote: kept.quote,
          citation: {
            check: now.check,
            ...(where && { label: where }),
            contentHash: now.contentHash,
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

    listMinds() {
      return call("list_minds", "", [READ_DOCUMENTS], (pairing) => {
        if (pairing.folderIds.length === 0) {
          throw new AgentRefusedError("no-folders", t("agents.problem.no-folders"));
        }
        const minds = deps.minds();
        const folderIds = deps.foldersInScope(pairing.folderIds);
        const folders: AgentMindList["folders"] = deps
          .folders()
          .filter((folder) => folderIds.includes(folder.id))
          .map((folder) => ({
            id: folder.id,
            name: folder.name,
            documents: deps.documentsIn([folder.id]).length,
            minds: minds
              .filter((mind) => mind.folderId === folder.id)
              .map((mind) => ({
                id: mind.id,
                title: mind.title || mind.autoTitle || t("mind.untitled"),
                updatedAt: mind.updatedAt,
              })),
          }));
        if (folderIds.includes(NOT_IN_A_FOLDER_ID)) {
          folders.push({
            id: NOT_IN_A_FOLDER_ID,
            name: t("library.unsorted"),
            documents: deps.documentsIn([NOT_IN_A_FOLDER_ID]).length,
            minds: [],
          });
        }
        return {
          result: { folders },
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
        if (input?.named === true) {
          const note = deps.mindBlocks(mind.id, (blocks) =>
            namedNote(blocks, namedWords(pairing, inScope, cited)),
          );
          return {
            result: { ...page(mind, note.text, offset), version: note.version },
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
          const where = label(citation.location, citation.pageFrom, citation.pageTo);
          const source = where ? `${citation.documentName}, ${where}` : citation.documentName;
          if (citation.check !== "found") return { source, unverified: true };
          cited.push(documentId);
          // Made before Citations kept their Passage: checked, but nothing to mint from.
          if (citation.passageId === "") return { source, unverified: false };
          return {
            source: `${citeTag(mint(pairing, citation).token)} ${source}`,
            unverified: false,
          };
        });
        return { result: page(mind, markdown, offset), count: 1, documentIds: cited };
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
            const tag = citeTag(mint(pairing, citation).token);
            if (!citations.some((each) => each.cite === tag)) {
              citations.push({
                cite: tag,
                document: citation.documentName,
                location: label(citation.location, citation.pageFrom, citation.pageTo),
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
      return call("propose_changes", known ? mindName(known) : "", effects, (pairing) => {
        if (!pairing.propose) {
          throw new AgentRefusedError("read-only", t("agents.problem.read-only"));
        }
        const mind = mindInScope(pairing, text(input?.mindId, "mindId", 200));
        const version = typeof input?.version === "string" ? input.version.trim() : "";
        if (version === "" || version.length > 100) {
          throw new AgentRefusedError("invalid", t("agents.propose.version"));
        }
        const asked = parseChanges(input?.changes, t);
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
        let proposed: { waiting: number; uncited: string[] };
        try {
          proposed = deps.editMind(mind.id, (blocks) => {
            const note = namedNote(blocks, namedWords(pairing, inScope, []));
            if (note.version !== version) {
              throw new AgentRefusedError("changed", t("agents.problem.changed"));
            }
            return proposeNamed(blocks, note, placeChanges(asked, note.paragraphs.length, t), {
              request: randomUUID(),
              made: {
                source: "outside-agent",
                agent: pairing.name,
                pairingId: pairing.id,
                createdAt: deps.now(),
              },
              cited: (token) => tokens.get(token)?.cited ?? null,
              notFound: t("agents.answer.notFound"),
              newId: randomUUID,
            });
          });
        } catch (error) {
          if (error instanceof ChangeRefused) {
            throw new AgentRefusedError("invalid", t(error.key, { name: error.paragraph }));
          }
          if (!(error instanceof HeldParagraph)) throw error;
          throw new AgentRefusedError(
            "waiting",
            t(error.held === "busy" ? "agents.problem.busy" : "agents.problem.waiting", {
              paragraph: error.paragraph.name,
            }),
          );
        }
        const citations = [...tokens.values()].map((each) => each.report);
        return {
          result: {
            mindId: mind.id,
            waiting: proposed.waiting,
            citations,
            // As the change's bar counts them, from what was written, the Citations kept too.
            uncited: proposed.uncited.slice(0, MAX_UNCITED).map((sentence) => clip(sentence, 200)),
          },
          count: proposed.waiting,
          documentIds: [...tokens.values()].flatMap((each) =>
            each.cited ? [each.cited.minted.documentId] : [],
          ),
        };
      });
    },
  };
}

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
