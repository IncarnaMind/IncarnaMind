/**
 * Check against Documents (#96) on the User's own sentences in a Mind, and
 * the claim-check function the other checks share with it (./claimCheck).
 *
 * 1. The sentences the selection touches are read from the Mind, whole, and
 *    each gets a "checking" mark at once (./sentences).
 * 2. They are checked against the Mind's Folder (every Document for a Mind
 *    in none, or when the User widens it): each whole, by the decision model
 *    the User's checks use and, where that leaves it undecided, by the AI
 *    model, in a check Run that can only search and cite (./claimCheck).
 * 3. Each result is written onto its sentence's mark as it comes, with what
 *    it was made from: the sentence's text, the Document versions it read
 *    and the scope, so it shows "needs re-check" once any of them changes, or
 *    a Document its result rests on goes (src/shared/claimChecks.ts). A mark whose sentence was deleted meanwhile
 *    is simply gone. What the scope couldn't read as the request started is
 *    kept beside the Mind's Blocks, by request (src/shared/unreadFiles.ts).
 *
 * The evidence of a Mind's checks is retained (#79) under the Mind, so its
 * text stays for the cards and "Add as Citation" after the Document changes.
 * Stopping a request, or quitting, marks the sentences not checked yet
 * "stopped"; a "checking" mark left by a crash says so when its Mind opens.
 *
 * Nothing leaves the computer before the User allows the "checks" flow to
 * the model's service, and in local mode only a model on this computer is used.
 */

import { randomUUID } from "node:crypto";
import type * as Y from "yjs";
import { caseCitations } from "../../../shared/caseCitations";
import { type LiveDocument, withShownName } from "../../../shared/citations";
import { keepRecordCites, restsOn, restsOnItsCitation } from "../../../shared/claimChecks";
import {
  boundedCheck,
  boundedCheckParts,
  checkWithParts,
  partsWrittenBy,
  partWithResult,
  resultFromParts,
} from "../../../shared/claimParts";
import { isLibraryCitation } from "../../../shared/libraryFacts";
import { mindScopeIn } from "../../../shared/mindScope";
import { readRecordCiteChoices, writeRecordCiteChoice } from "../../../shared/recordCiteChoices";
import { folderScope, oneFolderOf } from "../../../shared/searchScope";
import { namePartCitations } from "../../../shared/signOffs";
import { judgesUnreliably } from "../../../shared/smallModel";
import { recordCheckUnread } from "../../../shared/unreadFiles";
import {
  type ChatModelChoice,
  type ChatReadiness,
  type CheckContradictionsResult,
  type CheckedDocument,
  type CheckSentencesResult,
  type ChooseRecordCiteSourceInput,
  type CitationAttributes,
  type CitedQuote,
  type ClaimCheckAction,
  type ClaimCheckAttributes,
  type ClaimCheckBasis,
  type ClaimCheckPart,
  type ClaimCheckResult,
  type ClaimCheckScope,
  type ClaimCorrection,
  type ClaimJudgment,
  type ClaimPartSpan,
  type ContradictionCheckPlan,
  type Currency,
  claimCheckActions,
  type DataKind,
  type Document,
  type ExternalService,
  type MindCheckEarly,
  type Money,
  type RunEstimate,
  type SearchScope,
  type TextPlace,
  type TextStretch,
  type UnreadFile,
  type UnsupportedReason,
} from "../../api";
import type { Consent } from "../../consent";
import type { EstimatedRead } from "../../cost/meter";
import { depositionMapper } from "../../documents/deposition";
import type { Evidence, EvidenceScope } from "../../documents/evidence";
import { parseCheckedDocument } from "../../documents/evidence";
import type { RetainVersion, VersionRetention } from "../../documents/retention";
import type { WindowedPassage } from "../../documents/search";
import { parseModel, parsePlace } from "../../edits";
import {
  ChatNotReadyError,
  ConsentDeclinedError,
  InvalidInputError,
  isRecord,
  LocalModeError,
} from "../../errors";
import type { Language } from "../../language";
import type { MindContent } from "../../mindContent";
import { parseMindId } from "../../minds";
import { withoutDateSuffix } from "../../providers/catalog";
import { type CheckPathsOverride, quickLooksFirst } from "../../providers/catalog/checkPaths";
import type { PreparedChatModel } from "../../providers/chat";
import { type RecordCiteSource, recordCiteLibrary } from "../../recordCites/documents";
import { parseRecordCite, recordCiteTokens } from "../../recordCites/parser";
import { recordCiteChoiceAlias, resolveChosenRecordCite } from "../../recordCites/resolver";
import type { RepliesOut } from "../../runs/replies";
import { parseSearchScope } from "../../scope";
import type { AnswerEngine } from "../engine";
import { type AnswerCheckInput, createAnswerCheck } from "./answerCheck";
import { lookResult } from "./answerLook";
import { inCheck } from "./checkedText";
import {
  type CheckedCitation,
  type ClaimCheckDependencies,
  type ClaimCheckRequest,
  createClaimCheck,
} from "./claimCheck";
import { createFirstReading, type DecisionReader } from "./decisionFirst";
import { createFastPaths } from "./fastPaths";
import { createJudgedOutside } from "./judgedOutside";
import { createMindCheck, type MindCheckOptions, type NotAskedReason } from "./mindCheck";
import { recordOpinions, removeOpinion, unmarkedOpinion } from "./opinions";
import {
  judgeResolvedRecordCites,
  notJudgedError,
  unplacedRecordCites,
  withRecordCites,
} from "./recordCites";
import { CLAIM_TIME_LIMIT_MS, checkRunOf, resultOf, runCheck, runClaimChecks } from "./runCheck";
import { notCheckedMark } from "./runChecks";
import type { BatchCall } from "./sentenceBatch";
import {
  markedSentences as allMarks,
  assistantWrote,
  checkedSentences,
  checkText,
  citedQuoteOf,
  everySentence,
  markedSentences,
  markSentence,
  marksASourceName,
  noteTextOf,
  recordCiteParagraphs,
  type SelectedSentence,
  selectedSentences,
  unmarkSourceNames,
  updateCheck,
} from "./sentences";
import { createVerify, type NoDocuments, type VerifyOptions } from "./verify";
import { waitLine } from "./waitLine";
import { createContradictionWatch, type WatchOptions } from "./watch";
import { createWrittenCheck, type WrittenCheckOptions } from "./written";

/**
 * What the "checks" flow sends: the sentences checked, with their paragraphs,
 * the Passages found, a verified document's sentences, to find its claims
 * (#97), a Mind's sentences when the whole Mind is checked (#737), how a
 * figure an Answer worked out was worked out, which its check is told, and
 * what the code came to where a check worked a figure out over a data file's
 * rows (#3282).
 */
export const CHECKS_FLOW_SENDS = [
  "selection",
  "passages",
  "verified-document",
  "blocks",
  "watched-sentences",
  "worked-figures",
  "analysis-results",
] as const;

/**
 * What the contradiction watch may send of the checks flow: its sentences, checked as any is,
 * never how a figure was worked out. Its consent is to these alone.
 */
const WATCH_SENDS: readonly DataKind[] = ["selection", "passages", "watched-sentences"];

/**
 * What checking the assistant's write may send: all the checks flow does but the watch's
 * sentences, and no code's results: only a check the User starts runs code over a data file.
 */
const WRITTEN_SENDS: readonly DataKind[] = CHECKS_FLOW_SENDS.filter(
  (kind) => kind !== "watched-sentences" && kind !== "analysis-results",
);

/** The longest claim one check takes, in characters: a sentence, not a page. */
const MAX_CLAIM_CHARACTERS = 2_000;

/** The flows a check sends on; "chat" for an Answer's own sentences, judged as part of its request (#2311). */
type CheckFlow = "checks" | "chat";

/**
 * How hard the step that judges a sentence asks its model to think: as for an everyday Answer.
 * The sentence is judged whole, with nothing in code behind the verdict, so the model is given
 * room to reason (#3257); the check's other requests don't think.
 */
const JUDGING_THINKS = "answer";

export interface ChecksOptions
  extends Pick<
    VerifyOptions,
    | "requireFolder"
    | "addFile"
    | "document"
    | "onStatus"
    | "readText"
    | "readUnits"
    | "readTables"
    | "readSlides"
    | "readScanned"
    | "createMind"
    | "wordRefusal"
    | "importWord"
    | "wordWritten"
    | "discardWordMind"
    | "recordAiUse"
    | "unread"
    | "timers"
    | "claimTimeLimitMs"
  > {
  /** The interface language: what a check's sentence is written in. */
  language(): Language;
  /** What a check reads of the Library as it runs, as text that differs whenever that does. */
  libraryState(): string;
  content: Pick<MindContent, "read" | "edit" | "readSettings" | "editSettings">;
  /** What contradiction watch needs besides (#112). */
  watch: Pick<
    WatchOptions,
    "minds" | "documentVersions" | "background" | "runCost" | "delayMs" | "log"
  >;
  /** Aborts once a write's claims sort has taken too long; a check's time limit unless given. */
  sortTimeLimit?: () => AbortSignal;
  /** Where an Answer marks its provider while it is written, which a check's requests wait behind. */
  repliesOut?: RepliesOut;
  /** Says that the check of `id` waits on a rate limit until (ms since the epoch), or no longer does (#2944). */
  waiting?(id: string, until: number | null): void;
  /** Throws unless the Mind exists and this version may write to it. */
  requireMind(mindId: string): void;
  /** The Folder the Mind is in; null for none. */
  mindFolder(mindId: string): string | null;
  /** The Folder whose work stays inside it, or null when this Mind is not walled. */
  walledFolder(mindId: string | null): string | null;
  /** The wall a Document belongs to, or null when it belongs to none. */
  walledDocument(documentId: string): string | null;
  /** The name of that wall's Folder, or null when it belongs to none. */
  walledFolderName(documentId: string): string | null;
  /** What a check from a Mind searches, by the one rule (`mindSearchScope`); null: every Document. */
  searchedScope(scope: SearchScope | null, mindId: string): SearchScope | null;
  /** The file a Mind was imported from (#720), which its own checks never use as evidence. */
  originalOf(mindId: string): CheckedDocument | null;
  /** The default chat model, used when the Mind has none of its own. */
  defaultModel(): ChatModelChoice | null;
  /** The model a Mind whose own pick is `own` is checked with: see `modelInUse`. */
  modelInUse(own: ChatModelChoice | null): ChatModelChoice | null;
  /** The core's lifetime: once it ends, the database is closed and nothing more is read. */
  closed: AbortSignal;
  chat: {
    readiness(choice: ChatModelChoice | undefined, flow: CheckFlow): Promise<ChatReadiness>;
    prepareModel(
      choice: ChatModelChoice | undefined,
      flow: CheckFlow,
      thinking?: typeof JUDGING_THINKS,
      options?: { sends?: readonly DataKind[] },
    ): Promise<PreparedChatModel>;
    modelShape(
      choice: ChatModelChoice | undefined,
    ): Promise<Pick<PreparedChatModel, "window" | "support" | "capabilities"> | null>;
    /** The service the default chat model sends to; null with none, or one on this computer. */
    defaultService(): ExternalService | null;
    /** Whether background work in a Note whose own pick is `own` waits for the User (../../providers/chat). */
    waitsForRemovedModel(own: ChatModelChoice | null): boolean;
    /** The quick-tasks model for Answers on `answers` (../../providers/chat). */
    quickTasksModel(answers: ChatModelChoice): ChatModelChoice | null;
  };
  /**
   * The call a Transcript's Passage is from, for an Answer asked in the Note `callIn` holds a call
   * of (#3005): this call's or an earlier one's; null for any other Document, and with no `callIn`.
   */
  callMark?(callIn: string | null, documentId: string): BatchCall | null;
  /** Which written sentences take the fast paths, instead of the list beside the catalog. */
  checkPaths?: CheckPathsOverride;
  consent: Consent;
  /** Local mode: only models on this computer. */
  localOnly(): boolean;
  resolveScope(scope: SearchScope, mindId?: string | null): string[] | null;
  /** The Documents a Search scope covers; with none, the User's own (`scopeDocuments`). */
  scopeDocuments(scope: SearchScope | null, mindId: string | null): string[] | null;
  evidence: Pick<Evidence, "ready" | "scope" | "search" | "best">;
  documents: ClaimCheckDependencies["documents"] &
    MindCheckOptions["documents"] &
    Pick<RecordCiteSource, "batesHolders"> & {
      /** Every live Document's names: what the Citations a sentence already has are named by. */
      names(): readonly LiveDocument[];
      /** The live Documents of these, in the order given. */
      live(documentIds: readonly string[]): Document[];
      /** A live Document's Passages, in reading order. */
      passages(documentId: string): WindowedPassage[];
      /** Whether another Document among these holds half the words of `text` (../../documents/search). */
      othersHoldTerms(
        text: string,
        except: string,
        documentIds: readonly string[] | undefined,
        leftOut: readonly string[],
      ): boolean;
    };
  /** A Citation checked again in its Document's current version, at the Units it cites. */
  recheckCitation(citation: {
    documentId: string;
    quote: string;
    pageFrom: number | null;
    pageTo: number | null;
    contentHash: string;
  }): { check: CitationAttributes["check"]; contentHash: string | null };
  /** The estimate of a whole read's requests. */
  estimateRead(model: ChatModelChoice | null, read: EstimatedRead): RunEstimate | null;
  /** What a whole read's requests have settled at, by its request id, in `currency`. */
  readSpent(requestId: string, currency: Currency): Money;
  /** What the monthly cap leaves this month, counting what open requests may cost; null with no cap. */
  capLeft(): Money | null;
  /** A Check this Note run's sentences checked before it marks them. */
  checkingEarly(event: MindCheckEarly): void;
  decision?: MindCheckOptions["decision"];
  libraryLists?: ClaimCheckDependencies["libraryLists"];
  /** How far the check of what the assistant wrote is (./written). */
  writtenProgress: WrittenCheckOptions["progress"];
  engine: AnswerEngine;
  retention: Pick<VersionRetention, "retain" | "retainedBy">;
  now(): Date;
}

interface ParsedCheck {
  requestId: string;
  mindId: string;
  from: TextPlace;
  to: TextPlace;
  more: TextStretch[];
  action: ClaimCheckAction;
  allDocuments: boolean;
  model: ChatModelChoice | null;
  part?: { id: string; span: ClaimPartSpan };
}

function parsePart(value: unknown): ParsedCheck["part"] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    !isRecord(value.span) ||
    !Number.isInteger(value.span.start) ||
    !Number.isInteger(value.span.end) ||
    typeof value.span.start !== "number" ||
    typeof value.span.end !== "number" ||
    value.span.start < 0 ||
    value.span.end <= value.span.start
  )
    throw new InvalidInputError({ key: "error.check.partChanged" });
  return { id: value.id, span: { start: value.span.start, end: value.span.end } };
}

function parseStretches(value: unknown): TextStretch[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((each: unknown) => {
    const stretch = isRecord(each) ? each : {};
    return {
      from: parsePlace(stretch.from, "more's from"),
      to: parsePlace(stretch.to, "more's to"),
    };
  });
}

function parseCheck(input: unknown): ParsedCheck {
  if (!isRecord(input)) throw new InvalidInputError("checkSentences expects an object.");
  const { requestId, action } = input;
  if (typeof requestId !== "string" || requestId === "") {
    throw new InvalidInputError("A check needs a request id.");
  }
  const known = claimCheckActions.find((each) => each === action);
  if (!known) throw new InvalidInputError(`Unknown check "${String(action)}".`);
  const part = parsePart(input.part);
  if (part && known === "contradiction-watch") {
    throw new InvalidInputError({ key: "error.check.partChanged" });
  }
  return {
    requestId,
    mindId: parseMindId(input.mindId),
    from: parsePlace(input.from, "from"),
    to: parsePlace(input.to, "to"),
    more: parseStretches(input.more),
    action: known,
    allDocuments: input.allDocuments === true,
    model: parseModel(input.model),
    ...(part && { part }),
  };
}

function parseClaim(input: unknown) {
  if (!isRecord(input)) throw new InvalidInputError("checkClaim expects an object.");
  const claim = typeof input.claim === "string" ? input.claim.trim() : "";
  if (claim === "") throw new InvalidInputError("A claim to check must be some text.");
  if (claim.length > MAX_CLAIM_CHARACTERS)
    throw new InvalidInputError({
      key: "error.check.claimTooLong",
      values: { max: MAX_CLAIM_CHARACTERS },
    });
  const cited: CitedQuote[] = Array.isArray(input.cited)
    ? input.cited.flatMap((each: unknown) =>
        isRecord(each) && typeof each.quote === "string"
          ? [
              {
                ...citedQuoteOf(each),
                documentName: String(each.documentName ?? ""),
                quote: each.quote,
              },
            ]
          : [],
      )
    : [];
  return {
    claim,
    context: typeof input.context === "string" ? input.context : undefined,
    cited,
    scope: parseSearchScope(input.scope),
    mindId: typeof input.mindId === "string" ? input.mindId : null,
    checked: parseCheckedDocument(input.checked),
    model: parseModel(input.model),
  };
}

/** A Citation as a mark stores it: the Passage that decides a claim, or that covers part of it. */
const citationAttributes = (citation: CitationAttributes): CitationAttributes => ({
  passageId: citation.passageId,
  documentId: citation.documentId,
  documentName: citation.documentName,
  contentHash: citation.contentHash,
  pageFrom: citation.pageFrom,
  pageTo: citation.pageTo,
  location: citation.location,
  quote: citation.quote,
  ...(citation.yourNoteAt && { yourNoteAt: citation.yourNoteAt }),
  check: citation.check,
  checkReason: citation.checkReason,
  ...(citation.id && { id: citation.id }),
});

const evidenceOf = (citation: CitationAttributes | null): CitationAttributes | null =>
  citation && citationAttributes(citation);

const correctionOf = (correction: ClaimCorrection): ClaimCorrection => ({
  from: correction.from,
  choices: correction.choices.map((choice) => ({
    wording: choice.wording,
    evidence: citationAttributes(choice.evidence),
  })),
});

const withQuoted = ({ quoted, ...why }: UnsupportedReason): UnsupportedReason => {
  const kept = quoted ? evidenceOf(quoted) : null;
  return kept ? { ...why, quoted: kept } : why;
};

/** A result written onto its mark. */
function withJudgment(check: ClaimCheckBasis, result: ClaimJudgment, at: string): ClaimCheckBasis {
  // A mark holds no key without a value: with one, Tie out figures never saw its checks end.
  const { recordCites: _earlier, readDocuments: _gone, ...rest } = check;
  const basis: ClaimCheckBasis =
    result.readDocuments === undefined ? rest : { ...rest, readDocuments: result.readDocuments };
  const common = {
    versions: result.versions,
    excluded: result.excluded,
    ...(result.recordCites && { recordCites: result.recordCites }),
    checkedAt: at,
  };
  return boundedCheck(
    result.verdict === "not-checked"
      ? {
          ...basis,
          ...common,
          state: "not-checked",
          reason: result.reason,
          detail: result.detail,
          evidence: null,
          says: null,
          unsupported: null,
          calculation: null,
          citedCaseUnchecked: false,
          citedCaseFound: false,
          ...(result.parts && { parts: result.parts }),
        }
      : {
          ...basis,
          ...common,
          state: result.verdict,
          reason: null,
          detail: null,
          evidence: evidenceOf(result.evidence),
          ...(result.correction && { correction: correctionOf(result.correction) }),
          says: result.says,
          unsupported: result.unsupported && withQuoted(result.unsupported),
          calculation: result.calculation,
          citedCaseUnchecked: result.citedCaseUnchecked,
          citedCaseFound: result.citedCaseFound,
          ...(result.parts && { parts: result.parts }),
        },
  );
}

function withResult(
  check: ClaimCheckAttributes,
  result: ClaimCheckResult,
  at: string,
  sourceText = check.text,
  priorParts: readonly ClaimCheckPart[] = check.parts ?? [],
): ClaimCheckAttributes {
  // Every result is its sentence's one part, a run's own too (a limit, a stop, a time limit): a
  // mark's state is read from its parts, so one left from an earlier check would show that check's.
  if (!result.parts && sourceText.length > 0)
    result = resultFromParts([
      partWithResult({ kind: "fact", span: { start: 0, end: sourceText.length } }, result),
    ]);
  // Verify anchors a whole row to its first cell (#1368); its contextual claim has different offsets.
  if (result.parts && sourceText !== check.text) {
    const evidence = result.parts.flatMap((part) => part.evidence);
    // A row's correction names words of its contextual claim, not of the cell it is anchored to.
    let anchored = result;
    if (anchored.verdict !== "not-checked") {
      const { correction: _row, ...judged } = anchored;
      anchored = judged;
    }
    result = {
      ...anchored,
      ...resultFromParts([
        partWithResult(
          { span: { start: 0, end: check.text.length }, kind: "fact" },
          anchored,
          evidence,
        ),
      ]),
    };
  }
  if (result.parts) {
    // A mark holds no key without a value: with one, Tie out figures never saw its checks end.
    const { recordCites: _earlier, figures: _figures, remainder: _remainder, ...basis } = check;
    return keepRecordCites(
      checkWithParts(
        { ...basis, checkedAt: at },
        // Bounded before their ids are matched: every receipt's quote is cut the same way wherever
        // it sits, so one that moves on a re-check keeps the id its sign-off rests on (#2220).
        namePartCitations(boundedCheckParts(result.parts), priorParts),
      ),
      result.recordCites,
    );
  }
  const { figures: _figures, remainder: _remainder, ...basis } = check;
  return withJudgment(basis, result, at);
}

const stopped = (check: ClaimCheckAttributes): ClaimCheckAttributes => {
  if (!check.parts) return { ...check, state: "not-checked", reason: "stopped" };
  const parts = check.parts.map(
    (part): ClaimCheckPart =>
      part.verdict === "checking"
        ? { ...part, verdict: "not-checked", reason: "stopped", detail: null }
        : part,
  );
  return withResult({ ...check, parts }, resultFromParts(parts), check.checkedAt);
};

/**
 * `parts`, each keeping the result it had when its check again stayed inside a wall, or came back
 * Unsupported only because its deciding Passage is behind another wall (#1934); null when none did.
 */
function partsKeptInside(
  parts: readonly ClaimCheckPart[],
  before: readonly ClaimCheckPart[],
  behindAnotherWall: (citation: CitationAttributes | undefined) => boolean,
): ClaimCheckPart[] | null {
  let kept = false;
  const next = parts.map((part) => {
    const prior = before.find(
      (each) =>
        each.kind === part.kind &&
        each.span.start === part.span.start &&
        each.span.end === part.span.end,
    );
    if (
      !prior ||
      prior.verdict === null ||
      prior.verdict === "checking" ||
      prior.verdict === "not-checked"
    )
      return part;
    const deciding =
      prior.decidingEvidence === null ? undefined : prior.evidence[prior.decidingEvidence ?? 0];
    if (
      (part.verdict === "not-checked" && part.reason === "kept-inside") ||
      (part.verdict === "unsupported" && behindAnotherWall(deciding))
    ) {
      kept = true;
      return prior;
    }
    return part;
  });
  return kept ? next : null;
}

/**
 * `parts`, each keeping the Supported or Contradicted result it had when a check again left its
 * cited Document out of the Note's Search scope, while that result rests on the sentence's own
 * Citation in the version its Document has now (#3087); null when none did.
 */
function partsStanding(
  parts: readonly ClaimCheckPart[],
  before: readonly ClaimCheckPart[],
  stands: (part: ClaimCheckPart) => boolean,
): ClaimCheckPart[] | null {
  let kept = false;
  const next = parts.map((part) => {
    if (part.verdict !== "not-checked" || part.reason !== "outside-scope") return part;
    const prior = before.find(
      (each) =>
        each.kind === part.kind &&
        each.span.start === part.span.start &&
        each.span.end === part.span.end,
    );
    if (!prior || !stands(prior)) return part;
    kept = true;
    return prior;
  });
  return kept ? next : null;
}

function chooseInput(value: unknown): ChooseRecordCiteSourceInput {
  if (!isRecord(value)) throw new InvalidInputError({ key: "error.recordCite.choiceInvalid" });
  const { mindId, checkId, raw, documentId, from, to } = value;
  if (
    typeof mindId !== "string" ||
    !mindId ||
    typeof checkId !== "string" ||
    !checkId ||
    typeof raw !== "string" ||
    !raw ||
    typeof documentId !== "string" ||
    !documentId
  )
    throw new InvalidInputError({ key: "error.recordCite.choiceInvalid" });
  if (
    (from !== undefined && (typeof from !== "number" || !Number.isInteger(from) || from < 0)) ||
    (to !== undefined && (typeof to !== "number" || !Number.isInteger(to) || to < 0))
  )
    throw new InvalidInputError({ key: "error.recordCite.spanInvalid" });
  return {
    mindId,
    checkId,
    raw,
    documentId,
    from: from as number | undefined,
    to: to as number | undefined,
  };
}

export function createChecks(options: ChecksOptions) {
  const { content, chat } = options;

  function noteResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
    blocks: Y.XmlFragment,
    mindId: string,
    sourceText = check.text,
    priorParts?: readonly ClaimCheckPart[],
    previous: ClaimCheckAttributes | null = null,
    sameTextParts?: readonly ClaimCheckPart[],
  ): ClaimCheckAttributes {
    // An earlier result is kept for the words it judged only: words edited since are new (#3087).
    const before = previous?.text === check.text ? previous : check;
    const behindAnotherWall = (citation: CitationAttributes | null | undefined) => {
      const wall = citation?.documentId ? options.walledDocument(citation.documentId) : null;
      return wall !== null && wall !== options.walledFolder(mindId);
    };
    if (
      result.verdict === "not-checked" &&
      result.reason === "kept-inside" &&
      before.state !== "checking" &&
      before.state !== "not-checked"
    ) {
      return before;
    }
    if (
      result.verdict === "unsupported" &&
      before.state !== "checking" &&
      before.state !== "not-checked" &&
      behindAnotherWall(before.evidence)
    ) {
      return before;
    }
    const keptParts =
      result.parts &&
      before.parts &&
      partsKeptInside(result.parts, before.parts, behindAnotherWall);
    if (keptParts) result = resultFromParts(keptParts);
    const leftOut = result.parts?.some(
      (part) => part.verdict === "not-checked" && part.reason === "outside-scope",
    );
    const held =
      leftOut && sameTextParts
        ? checkedSentences(blocks).find((each) => each.check.id === check.id)
        : undefined;
    if (held && sameTextParts && result.parts) {
      const versions = options.watch.documentVersions();
      const stands = (part: ClaimCheckPart) => {
        const deciding =
          part.decidingEvidence === null ? undefined : part.evidence[part.decidingEvidence ?? 0];
        return (
          deciding?.documentId != null &&
          versions.get(deciding.documentId) === deciding.contentHash &&
          restsOnItsCitation(part, held.citations, held.sentence)
        );
      };
      const standing = partsStanding(result.parts, sameTextParts, stands);
      if (standing) result = resultFromParts(standing);
    }
    // A mark not in the Note yet is the assistant's own write's, which says whose it is itself.
    const assistant = assistantWrote(blocks, check.id);
    if (result.parts && assistant !== null)
      result = { ...result, parts: partsWrittenBy(result.parts, assistant) };
    return withResult(check, result, at, sourceText, priorParts);
  }
  /** The requests running, by id: how to stop each, and its Mind. */
  const running = new Map<string, { controller: AbortController; mindId: string }>();
  const recordCiteDocuments = {
    ...options.documents,
    recordChoices: (mindId: string) => content.readSettings(mindId, readRecordCiteChoices),
    noteParagraphs: (mindId: string) => content.read(mindId, recordCiteParagraphs),
  };
  const withCites = (check: ReturnType<typeof createClaimCheck>) =>
    withRecordCites(check, { language: options.language, documents: recordCiteDocuments });
  // Every request a check makes is told apart by its sentence (./checkedText).
  const asCheck =
    (check: (request: ClaimCheckRequest) => Promise<ClaimCheckResult>) =>
    (request: ClaimCheckRequest) =>
      inCheck({ sentence: request.claim, part: null }, () => check(request));
  const firstReading = createFirstReading(options);
  const readers = new WeakMap<PreparedChatModel, Promise<DecisionReader | null>>();
  /**
   * The decision model the User's checks use, in front of a sentence's check, whichever flow asks
   * for it: a sentence it decides never reaches the AI model. A run that has read its sentences
   * itself (Check this Note, which shows what a reading leans to) says so with `about`.
   */
  const readFirst =
    (check: (request: ClaimCheckRequest) => Promise<ClaimCheckResult>) =>
    async (request: ClaimCheckRequest): Promise<ClaimCheckResult> => {
      const { decision } = options;
      if (request.about || !decision) return check(request);
      const reader =
        readers.get(request.model) ??
        decision(request.model.provider.service).catch((error: unknown) => {
          console.error("The decision model for checks couldn't be made ready:", error);
          return null;
        });
      readers.set(request.model, reader);
      const reading = await reader;
      const read = reading
        ? await firstReading(request, reading).catch((error: unknown) => {
            if (!request.signal.aborted)
              console.error("A decision model's reading of a sentence failed:", error);
            return null;
          })
        : null;
      if (!read) return check(request);
      return "result" in read ? read.result : check({ ...request, about: read.about });
    };
  const checkByAiModel = asCheck(withCites(createClaimCheck(options)));
  const claimCheck = asCheck(readFirst(withCites(createClaimCheck(options))));
  // A check that starts by itself (of what the assistant wrote, of an Answer's own sentences)
  // sends what the written check may: no code runs over a data file unless the User asked.
  const unaskedCheck: typeof claimCheck = (request) =>
    claimCheck({ ...request, sends: request.sends ?? WRITTEN_SENDS });

  const services = async () => {
    const service = chat.defaultService();
    return service ? [service] : [];
  };
  options.consent.registry.register({ id: "checks", sends: CHECKS_FLOW_SENDS, services });

  /**
   * `prepared` with the same model asked to think for the step that judges a sentence. A model on
   * this computer is left as it is: thinking was measured on a service only (#3257).
   */
  async function thinksToJudge(
    choice: ChatModelChoice | null,
    flow: CheckFlow,
    prepared: PreparedChatModel,
    sent?: { sends?: readonly DataKind[] },
  ): Promise<PreparedChatModel> {
    if (!prepared.provider.service) return prepared;
    const thinks = await chat.prepareModel(choice ?? undefined, flow, JUDGING_THINKS, sent);
    return { ...prepared, thinking: thinks.model };
  }

  /** The model to check with, or why there is none; the consent dialog shows before anything is sent. */
  async function prepare(
    choice: ChatModelChoice | null,
    flow: CheckFlow = "checks",
  ): Promise<
    | { ok: true; prepared: PreparedChatModel }
    | {
        ok: false;
        result: Extract<CheckSentencesResult, { kind: "not-ready" | "local-mode" | "cancelled" }>;
      }
  > {
    const readiness = await chat.readiness(choice ?? undefined, flow);
    if (!readiness.ready) return { ok: false, result: { kind: "not-ready", readiness } };
    if (readiness.provider.service && options.localOnly()) {
      return { ok: false, result: { kind: "local-mode" } };
    }
    try {
      const prepared = await chat.prepareModel(choice ?? undefined, flow);
      return { ok: true, prepared: await thinksToJudge(choice, flow, prepared) };
    } catch (error) {
      if (error instanceof ChatNotReadyError) {
        return { ok: false, result: { kind: "not-ready", readiness: error.readiness } };
      }
      if (error instanceof LocalModeError) return { ok: false, result: { kind: "local-mode" } };
      if (error instanceof ConsentDeclinedError) {
        const now = await chat.readiness(choice ?? undefined, flow);
        return {
          ok: false,
          result: now.ready ? { kind: "cancelled" } : { kind: "not-ready", readiness: now },
        };
      }
      throw error;
    }
  }

  /**
   * Keeps the text of the evidence every check in the Mind shows, a worked-out
   * figure's inputs included, and lets go of the rest (#79).
   */
  function retainEvidence(mindId: string): void {
    const inventory = content.read(mindId, (blocks) => {
      const marks = markedSentences(blocks);
      const versions = marks.flatMap(({ check }): RetainVersion[] =>
        restsOn(check).flatMap((evidence) =>
          // The Library's facts an earlier check quoted are no Document's text to keep (#2525).
          evidence.documentId && evidence.contentHash && !isLibraryCitation(evidence)
            ? [
                {
                  documentId: evidence.documentId,
                  contentHash: evidence.contentHash,
                  pageFrom: evidence.pageFrom,
                  pageTo: evidence.pageTo,
                  location: evidence.location,
                },
              ]
            : [],
        ),
      );
      return { versions, complete: marks.every((mark) => mark.partsComplete) };
    });
    if (!inventory.complete) {
      options.watch.log.warn("checks.evidenceInventoryIncomplete", { mindId });
    }
    options.retention.retain("check-result", mindId, [
      ...inventory.versions,
      ...(!inventory.complete ? options.retention.retainedBy("check-result", mindId) : []),
    ]);
  }

  /** What a sentence cites, each Document named as it is now. */
  function citedNow(cited: readonly CitedQuote[]): CheckedCitation[] {
    const live = options.documents.names();
    return cited.map((each) => {
      const current = live.find((document) => document.id === each.documentId);
      return {
        documentName: withShownName(each, live).documentName,
        quote: each.quote,
        ...(current && { documentId: current.id }),
        // A Passage of an older version isn't what the Document says now.
        ...(each.passageId &&
          current?.contentHash === each.contentHash && { passageId: each.passageId }),
      };
    });
  }

  /** Marks a request's sentences not checked yet "stopped". */
  function settleStopped(mindId: string, request: string): void {
    // Quitting settles every running request at once, then closes the Notes: one that unwinds
    // after that has been settled.
    if (!running.has(request)) return;
    settleChecking(mindId, request);
  }

  /** Marks a request's sentences still shown as being checked "stopped", whether or not it runs. */
  function settleChecking(mindId: string, request: string): void {
    const ids = content.read(mindId, (blocks) =>
      markedSentences(blocks)
        .filter(({ check }) => check.request === request && check.state === "checking")
        .map(({ check }) => check.id),
    );
    if (ids.length === 0) return;
    content.edit(mindId, (blocks) => {
      for (const id of ids) updateCheck(blocks, id, stopped);
    });
  }

  function recordUnread(blocks: Y.XmlFragment, request: string, files: readonly UnreadFile[]) {
    if (!blocks.doc) return;
    const requests = new Set(markedSentences(blocks).map(({ check }) => check.request));
    recordCheckUnread(blocks.doc, request, files, requests);
  }

  function leftOutOf(mindId: string, checked: CheckedDocument = {}): CheckedDocument {
    const original = options.originalOf(mindId);
    return {
      documentIds: [...(original?.documentIds ?? []), ...(checked.documentIds ?? [])],
      contentHashes: [...(original?.contentHashes ?? []), ...(checked.contentHashes ?? [])],
      // A Mind's own snapshot never supports its own sentences, nor a copy of it (#335, #1935).
      ownNoteMindIds: [
        mindId,
        ...(original?.ownNoteMindIds ?? []),
        ...(checked.ownNoteMindIds ?? []),
      ],
    };
  }

  /**
   * Where a Mind's sentences are checked: the scope the User set for it, else its Folder, or
   * every Document, never the file the Mind was imported from. The contradiction watch leaves
   * out the same, so a sentence finds the same evidence alone or in a whole check.
   */
  function scopeOf(mindId: string, allDocuments: boolean, checked: CheckedDocument = {}) {
    const own = options.mindFolder(mindId);
    const chosen = content.readSettings(mindId, mindScopeIn);
    const walled = options.walledFolder(mindId) !== null;
    const wanted =
      allDocuments && !walled
        ? null
        : options.searchedScope(allDocuments ? null : (chosen ?? folderScope(own)), mindId);
    const folderId = oneFolderOf(wanted);
    const inChosen = chosen !== null && wanted !== null && (own === null || folderId !== own);
    // An own Folder that holds no Document searches everything, as "Search all Documents" does.
    const marked: ClaimCheckScope = inChosen
      ? { folderId: own, widened: false, chosen: wanted }
      : { folderId: own, widened: walled ? false : allDocuments || own !== folderId };
    const leftOut = leftOutOf(mindId, checked);
    const resolved = options.scopeDocuments(wanted, mindId);
    const scope = options.evidence.scope(mindId, resolved, leftOut);
    const searchable = options.documents.searchableCount(scope.documentIds);
    const empty = (): NoDocuments => {
      const none: NoDocuments = { kind: "no-documents", folderId };
      if (!inChosen || !wanted) return none;
      if (
        options.documents.searchableCount(
          options.evidence.scope(mindId, options.scopeDocuments(null, mindId), leftOut).documentIds,
        ) === 0
      )
        return none;
      const onlyLeftOut =
        options.documents.searchableCount(options.evidence.scope(mindId, resolved).documentIds) > 0;
      return { ...none, chosen: { scope: wanted, onlyLeftOut } };
    };
    return {
      searchable,
      folderId,
      empty: searchable === 0 ? empty() : null,
      check: { scope, marked, wanted },
    };
  }

  function partOwner(blocks: Y.XmlFragment, target: NonNullable<ParsedCheck["part"]>) {
    const marked = markedSentences(blocks).find((each) => each.check.id === target.id);
    if (marked?.check.state === "checking") {
      throw new InvalidInputError({ key: "error.check.partChecking" });
    }
    const sentence =
      marked &&
      everySentence(blocks).find(
        (each) =>
          each.element === marked.element &&
          each.from < marked.to &&
          each.to > marked.from &&
          each.text === marked.check.text,
      );
    const opinion = marked ? null : unmarkedOpinion(blocks, target.id);
    const parts = sentence ? marked?.check.parts : opinion?.parts;
    const own = sentence ?? opinion;
    const part = parts?.find(
      (each) => each.span.start === target.span.start && each.span.end === target.span.end,
    );
    if (!own || !parts || !part || part.verdict === "checking") {
      throw new InvalidInputError({ key: "error.check.partChanged" });
    }
    return { sentence: own, parts, check: marked?.check };
  }

  /** A sentence's "checking" mark and what its check is asked; `owner` when one part is asked. */
  function startCheck(
    blocks: Y.XmlFragment,
    sentence: SelectedSentence,
    owner: ReturnType<typeof partOwner> | null,
    input: ParsedCheck,
    prepared: PreparedChatModel,
    scope: ClaimCheckScope,
    startedAt: string,
  ) {
    const priorOwners = markedSentences(blocks).filter(
      (each) =>
        each.element === sentence.element && each.from < sentence.to && each.to > sentence.from,
    );
    const physicalPrior =
      owner?.check ?? (priorOwners.length === 1 ? priorOwners[0]?.check : undefined);
    const prior = physicalPrior?.text === sentence.text ? physicalPrior : undefined;
    const previous = owner?.parts ?? prior?.parts;
    const check: ClaimCheckAttributes = {
      id: input.part?.id ?? randomUUID(),
      request: input.requestId,
      action: input.action,
      state: "checking",
      reason: null,
      detail: null,
      providerId: prepared.provider.id,
      modelId: prepared.modelId,
      text: sentence.text,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: owner?.check?.scope ?? scope,
      versions: [],
      excluded: [],
      checkedAt: startedAt,
    };
    const priorFigures =
      allMarks(blocks).find(
        (mark) =>
          mark.element === sentence.element && mark.from < sentence.to && mark.to > sentence.from,
      )?.check ?? null;
    return {
      pending: check,
      queued: {
        id: check.id,
        ...checkText(sentence),
        cited: sentence.cited,
        recordClaim: noteTextOf(sentence),
        place: { blockId: sentence.blockId, from: sentence.from },
        ...(previous && { previous }),
        ...((owner?.parts ?? physicalPrior?.parts) && {
          priorParts: owner?.parts ?? physicalPrior?.parts,
        }),
        before: priorFigures,
      },
    };
  }

  function checkRequest(
    sentence: ReturnType<typeof startCheck>["queued"],
    scope: EvidenceScope,
    prepared: PreparedChatModel,
    mindId: string,
    signal: AbortSignal,
  ): ClaimCheckRequest {
    return {
      claim: sentence.claim,
      context: sentence.context,
      ...(sentence.near !== undefined && { near: sentence.near }),
      ...(sentence.figures && { figures: sentence.figures }),
      cited: citedNow(sentence.cited),
      scope,
      model: prepared,
      mindId,
      recordClaim: sentence.recordClaim,
      place: sentence.place,
      cacheKey: mindId,
      signal,
    };
  }

  /**
   * Takes an earlier check's mark off each sentence `stretches` touch that only names the Document
   * it cites: no check reads it now (#3093). An edit only when there is such a mark.
   */
  function clearSourceNames(mindId: string, stretches: readonly TextStretch[]) {
    const named = (blocks: Y.XmlFragment) => selectedSentences(blocks, stretches).named;
    if (content.read(mindId, (blocks) => marksASourceName(blocks, named(blocks))))
      content.edit(mindId, (blocks) => unmarkSourceNames(blocks, named(blocks)));
  }

  async function checkSentences(
    input: ParsedCheck,
    signal: AbortSignal,
  ): Promise<CheckSentencesResult> {
    const { mindId } = input;
    const stretches = [{ from: input.from, to: input.to }, ...input.more];
    clearSourceNames(mindId, stretches);
    const read = content.read(mindId, (blocks) => selectedSentences(blocks, stretches));
    if (!read.ok) return { kind: read.reason };
    if (input.part) {
      const target = input.part;
      content.read(mindId, (blocks) => {
        const owner = partOwner(blocks, target);
        if (
          !read.sentences.some(
            (each) =>
              each.element === owner.sentence.element &&
              each.from === owner.sentence.from &&
              each.to === owner.sentence.to,
          )
        ) {
          throw new InvalidInputError({ key: "error.check.partChanged" });
        }
      });
    }

    const { empty, check } = scopeOf(mindId, input.allDocuments);
    if (empty) return empty;
    const { scope: evidenceScope, marked: scope } = check;

    const ready = await prepare(input.model ?? options.defaultModel());
    if (!ready.ok) return ready.result;
    if (signal.aborted) return { kind: "cancelled" };
    if (read.sentences.length === 0) return { kind: "waiting", waiting: read.waiting };

    const startedAt = options.now().toISOString();
    const unread = options.unread(check.wanted);
    let { waiting } = read;
    const queued = content.edit(mindId, (blocks: Y.XmlFragment) => {
      const again = selectedSentences(blocks, stretches);
      if (!again.ok) return [];
      waiting = again.waiting;
      const owner = input.part ? partOwner(blocks, input.part) : null;
      const marked = again.sentences.flatMap((sentence) => {
        if (
          owner &&
          !(
            owner.sentence.element === sentence.element &&
            owner.sentence.from === sentence.from &&
            owner.sentence.to === sentence.to
          )
        )
          return [];
        const started = startCheck(
          blocks,
          sentence,
          owner,
          input,
          ready.prepared,
          scope,
          startedAt,
        );
        markSentence(sentence.element, sentence.from, sentence.to, started.pending);
        if (input.part) removeOpinion(blocks, input.part.id);
        return [started.queued];
      });
      recordOpinions(blocks, []);
      if (marked.length > 0) recordUnread(blocks, input.requestId, unread);
      return marked;
    });
    if (queued.length === 0) {
      return waiting.sentences.length > 0 ? { kind: "waiting", waiting } : { kind: "nothing" };
    }

    let checked = 0;
    const ran = checkRunOf(options, ready.prepared, signal, mindId);
    const { outcomeError } = await runClaimChecks(
      queued,
      (sentence, attempt) =>
        attempt(claimCheck, checkRequest(sentence, evidenceScope, ready.prepared, mindId, signal)),
      {
        ...ran,
        ...(options.waiting && {
          onPause: waitLine(ran.timers.now, (until) => options.waiting?.(input.requestId, until)),
        }),
        onOutcome(sentence, outcome) {
          if (signal.aborted) return;
          if ("result" in outcome && outcome.result.verdict !== "not-checked") checked++;
          const at = options.now().toISOString();
          const kept = content.edit(mindId, (blocks) =>
            updateCheck(blocks, sentence.id, (check) =>
              "result" in outcome
                ? noteResult(
                    check,
                    outcome.result,
                    at,
                    blocks,
                    mindId,
                    sentence.claim,
                    sentence.priorParts,
                    sentence.before,
                    sentence.previous,
                  )
                : notCheckedMark(
                    check,
                    blocks,
                    { withResult: noteResult, mindId, at },
                    outcome.reason,
                    outcome.detail,
                  ),
            ),
          );
          if (kept) retainEvidence(mindId);
        },
      },
    );
    if (outcomeError !== null) {
      console.error(`A mark for Note ${mindId} couldn't be written:`, outcomeError.error);
      throw outcomeError.error;
    }
    if (signal.aborted) {
      settleStopped(mindId, input.requestId);
      return { kind: "cancelled" };
    }
    return {
      kind: "checked",
      sentences: queued.length,
      checked,
      smallModel: judgesUnreliably(ready.prepared),
      ...(waiting.sentences.length > 0 && { waiting }),
    };
  }

  const track = (requestId: string, mindId: string) => {
    const controller = new AbortController();
    running.set(requestId, { controller, mindId });
    return { signal: controller.signal, done: () => running.delete(requestId) };
  };

  /**
   * Whether work on the checks flow that sends `sends` to `service` waits for the User to allow
   * them: they allowed checks before the flow sent more, and not the more yet (#2525).
   */
  const waitsFor = (service: ExternalService | null, sends: readonly DataKind[]) =>
    service !== null &&
    !options.localOnly() &&
    options.consent.allows("checks", service) &&
    !options.consent.covers("checks", service, sends);

  /**
   * The model, when it can be used now without asking the User: never in the background. `sends`:
   * what this work sends of the checks flow, all of it when left out, the consent it needs.
   */
  async function prepareQuietly(
    choice: ChatModelChoice | null,
    sends: readonly DataKind[] = CHECKS_FLOW_SENDS,
  ): Promise<PreparedChatModel | null> {
    const readiness = await chat.readiness(choice ?? undefined, "checks");
    if (!readiness.ready) return null;
    const { service } = readiness.provider;
    if (service && (options.localOnly() || !options.consent.covers("checks", service, sends))) {
      return null;
    }
    try {
      const prepared = await chat.prepareModel(choice ?? undefined, "checks", undefined, { sends });
      return await thinksToJudge(choice, "checks", prepared, { sends });
    } catch (error) {
      if (error instanceof ChatNotReadyError || error instanceof ConsentDeclinedError) return null;
      throw error;
    }
  }

  /** The model, prepared with nothing asked of the User (`prepareQuietly`), or why it can't be. */
  async function prepareUnasked(
    choice: ChatModelChoice | null,
  ): Promise<PreparedChatModel | NotAskedReason> {
    const readiness = await chat.readiness(choice ?? undefined, "checks");
    if (!readiness.ready) return "not-ready";
    const { service } = readiness.provider;
    if (service && options.localOnly()) return "local-mode";
    if (service && !options.consent.covers("checks", service, CHECKS_FLOW_SENDS)) {
      return "consent-needed";
    }
    return (await prepareQuietly(choice)) ?? "not-ready";
  }

  const evidenceReady = (stop: AbortSignal, mindId: string) =>
    options.evidence.ready(stop, () => leftOutOf(mindId));

  const watch = createContradictionWatch({
    ...options,
    ...options.watch,
    evidenceReady,
    folderDocuments: (folderId) =>
      options.resolveScope({ folderIds: [folderId], tagIds: [], documentIds: [] }) ?? [],
    evidenceScope: (mindId, documentIds, citedIds) =>
      options.evidence.scope(
        mindId,
        documentIds,
        leftOutOf(mindId, { documentIds: [...citedIds] }),
      ),
    searchableCount: (documentIds) => options.documents.searchableCount(documentIds),
    prepare,
    waitsForRemovedModel: (own) => options.chat.waitsForRemovedModel(own),
    prepareQuietly: (choice) => prepareQuietly(choice, WATCH_SENDS),
    sendsInBackground: WATCH_SENDS,
    waitsForConsent: async (choice) => {
      const readiness = await chat.readiness(choice ?? undefined, "checks");
      return readiness.ready && waitsFor(readiness.provider.service, WATCH_SENDS);
    },
    claimCheck,
    withResult: noteResult,
    retainEvidence,
    track,
  });

  const verify = createVerify({
    ...options,
    prepare,
    evidenceScope: (mindId, allDocuments, verification) =>
      scopeOf(mindId, allDocuments, { documentIds: [verification.documentId] }),
    evidenceReady,
    claimCheck,
    withResult: noteResult,
    retainEvidence,
    recordUnread,
    settleStopped,
    track,
  });

  const mindCheck = createMindCheck({
    ...options,
    documentVersions: options.watch.documentVersions,
    prepare,
    prepareUnasked,
    scopeOf: (mindId, allDocuments) => scopeOf(mindId, allDocuments),
    evidenceReady,
    citedNow,
    recordUnread,
    isRunning: (requestId) => running.has(requestId),
    // The run reads its sentences itself, to show what a reading leans to as it comes.
    claimCheck: checkByAiModel,
    firstReading,
    withResult: noteResult,
    retainEvidence,
    settleStopped,
    track,
  });

  const judgedOutside = createJudgedOutside({
    content,
    scopeOf: (mindId, allDocuments) => scopeOf(mindId, allDocuments),
    requireMind: options.requireMind,
    withResult: noteResult,
    retainEvidence,
    now: options.now,
  });

  /**
   * The quick model that looks first at a write's sentences checked on `prepared` (./fastPaths):
   * another model than the Answers model, so none once the User has set the quick-tasks model to
   * it; listed beside the catalog with this Answers model; and on the same provider, so the same
   * service.
   */
  async function quickModelOf(prepared: PreparedChatModel): Promise<PreparedChatModel | null> {
    const answers = { providerId: prepared.provider.id, modelId: prepared.modelId };
    const quick = chat.quickTasksModel(answers);
    const { catalogId } = prepared.provider;
    const looks =
      quick !== null &&
      quick.providerId === answers.providerId &&
      withoutDateSuffix(quick.modelId) !== withoutDateSuffix(answers.modelId) &&
      quickLooksFirst(
        { catalogId, modelId: answers.modelId },
        { catalogId, modelId: quick.modelId },
        options.checkPaths,
      );
    return looks ? prepareQuietly(quick, WRITTEN_SENDS) : null;
  }

  const firstLook = createFastPaths({
    citationSource: (passageId) => options.documents.citationSource(passageId),
    pageTexts: (documentId, contentHash, from, to) =>
      options.documents.pageTexts(documentId, contentHash, from, to),
    othersHoldTerms: (text, documentId, scope) =>
      options.documents.othersHoldTerms(text, documentId, scope.documentIds ?? undefined, [
        ...scope.excluded.keys(),
      ]),
    walled: (documentId) => options.walledDocument(documentId) !== null,
    versionNow: (documentId) => options.documents.live([documentId])[0]?.contentHash ?? null,
  });

  const written = createWrittenCheck({
    ...options,
    prepare: (answer) =>
      prepareQuietly({ providerId: answer.provider.id, modelId: answer.modelId }, WRITTEN_SENDS),
    widened: ({ provider: { service } }) => waitsFor(service, WRITTEN_SENDS),
    quickModel: quickModelOf,
    firstLook,
    claimCheck: unaskedCheck,
    scopeOf: (mindId, allDocuments) => scopeOf(mindId, allDocuments),
    evidenceReady,
    citedNow,
    withResult: noteResult,
    read: (mindId, look) => content.read(mindId, look),
    retainEvidence,
    ...(options.sortTimeLimit && { sortTimeLimit: options.sortTimeLimit }),
    track,
    settleStopped,
    // A write a Redo brings back was ended by its Undo: its check runs no more.
    settleBroughtBack: (mindId, request) => {
      if (!options.closed.aborted) settleChecking(mindId, request);
    },
    progress: options.writtenProgress,
  });

  /**
   * The model that answered, for its Answer's sentences: they are judged as part of its own
   * request, on the chat flow the User already allowed, never asking again (#2311).
   */
  async function answeringModel(choice: ChatModelChoice): Promise<PreparedChatModel | null> {
    const readiness = await chat.readiness(choice, "chat");
    if (!readiness.ready) return null;
    const { service } = readiness.provider;
    if (service && (options.localOnly() || options.consent.status("chat", service) !== "accepted"))
      return null;
    try {
      return await chat.prepareModel(choice, "chat");
    } catch (error) {
      if (error instanceof ChatNotReadyError || error instanceof ConsentDeclinedError) return null;
      throw error;
    }
  }

  const answerCheck = createAnswerCheck({
    language: options.language,
    prepare: answeringModel,
    scope: (mindId, documentIds) => options.evidence.scope(mindId, documentIds),
    searchableCount: (documentIds) => options.documents.searchableCount(documentIds),
    citedNow,
    passages: (cited, scope, callIn) =>
      [...new Set(cited.flatMap((each) => (each.passageId ? [each.passageId] : [])))].flatMap(
        (passageId) => {
          const source = options.documents.citationSource(passageId);
          const inScope =
            source &&
            !source.documentDeleted &&
            !source.notCited &&
            !scope.excluded.has(source.documentId) &&
            (scope.documentIds === null || scope.documentIds.includes(source.documentId));
          if (!source || !inScope) return [];
          const { pageFrom, pageTo } = source;
          const location =
            pageFrom === null
              ? null
              : pageTo && pageTo !== pageFrom
                ? `pp. ${pageFrom}–${pageTo}`
                : `p. ${pageFrom}`;
          const call = options.callMark?.(callIn, source.documentId) ?? null;
          return [
            {
              passageId,
              documentName: source.documentName,
              location,
              text: source.text,
              ...(call && { call }),
            },
          ];
        },
      ),
    units: (citation) =>
      options.documents.pageTexts(citation.documentId, citation.contentHash, null, null),
    claimTimeLimitMs: options.claimTimeLimitMs ?? CLAIM_TIME_LIMIT_MS,
    ...(options.timers && { timers: options.timers }),
    ...(options.repliesOut && { repliesOut: options.repliesOut }),
    mostOf: (model, request) => {
      const estimate = options.estimateRead(model, { likely: [request], most: [request] });
      return estimate?.billing === "per-token" ? (estimate.upTo?.cost ?? null) : null;
    },
    spent: (runId, currency) => options.readSpent(runId, currency).amount,
    capLeft: () => options.capLeft(),
    look: async ({ sentence, context, citations, cited, scope, mindId, callIn, model, signal }) => {
      const outcome = await runCheck(
        unaskedCheck,
        {
          claim: sentence,
          context,
          cited,
          scope,
          ...(callIn !== null && { callIn }),
          model,
          ...(mindId && { cacheKey: mindId }),
          signal,
        },
        // Part of the Answer's own check, which started by itself: behind a reply, as its batches are (#2944).
        checkRunOf(options, model, signal, null, { behindReplies: true }),
      );
      return "result" in outcome ? lookResult(outcome.result, sentence, citations) : null;
    },
  });

  return {
    ...verify,

    /** What the assistant wrote in a Mind, checked once it lands, the turn not waiting (./written). */
    checkWritten: written.checkWritten,

    /** A Mind changed: the check of a write an Undo took away ends (./written). */
    mindChanged: written.mindChanged,

    /** An Answer's sentences with Citations, checked before it ends (./answerCheck). */
    checkAnswer: answerCheck.check,
    /** What judging an Answer's sentences would cost (#2311); null when nothing is left to judge. */
    async estimateAnswerCheck(
      input: Omit<AnswerCheckInput, "signal">,
    ): Promise<RunEstimate | null> {
      const shape = await chat.modelShape(input.model);
      if (options.closed.aborted) return null;
      const read = answerCheck.requests(input, {
        most: shape?.capabilities.facts.maxOutput,
        window: shape?.window?.outputTokens,
      });
      return read && options.estimateRead(input.model, read);
    },

    async checkSentences(input: unknown): Promise<CheckSentencesResult> {
      const parsed = parseCheck(input);
      options.requireMind(parsed.mindId);
      if (running.has(parsed.requestId)) {
        throw new InvalidInputError(`The check ${parsed.requestId} is already running.`);
      }
      const tracked = track(parsed.requestId, parsed.mindId);
      try {
        await options.evidence.ready(tracked.signal, () => leftOutOf(parsed.mindId));
        if (tracked.signal.aborted) return { kind: "cancelled" };
        return parsed.action === "contradiction-watch"
          ? await watch.checkSentences(parsed, tracked.signal)
          : await checkSentences(parsed, tracked.signal);
      } finally {
        tracked.done();
      }
    },

    async planContradictionCheck(mindId: unknown): Promise<ContradictionCheckPlan> {
      return watch.planContradictionCheck(parseMindId(mindId));
    },

    async checkContradictions(input: unknown): Promise<CheckContradictionsResult> {
      if (!isRecord(input) || typeof input.requestId !== "string" || input.requestId === "") {
        throw new InvalidInputError({ key: "error.contradictions.request" });
      }
      const mindId = parseMindId(input.mindId);
      options.requireMind(mindId);
      if (running.has(input.requestId)) {
        throw new InvalidInputError({ key: "error.contradictions.request" });
      }
      return watch.checkContradictions({
        requestId: input.requestId,
        mindId,
        model: parseModel(input.model),
      });
    },

    planMindCheck: async (
      mindId: unknown,
      mode: unknown,
      allDocuments?: unknown,
      figureIds?: unknown,
      blockIds?: unknown,
    ) => mindCheck.planMindCheck(mindId, mode, allDocuments === true, figureIds, blockIds),

    holdMindCheck: (input: unknown) => mindCheck.holdMindCheck(input),
    forgetCheckWindow: (clientId: string) => mindCheck.forgetCheckWindow(clientId),

    findMindClaims: (input: unknown) => mindCheck.findMindClaims(input),
    checkMind: (input: unknown) => mindCheck.checkMind(input),
    checkMindOutside: (mindId: string, reach: ReadonlySet<string>) =>
      mindCheck.checkOutside(mindId, reach),
    checkTaskOutside: judgedOutside.task,
    landJudgedOutside: judgedOutside.land,
    documentsAddedSinceChecks: (mindId: unknown) => mindCheck.documentsAddedSinceChecks(mindId),

    /** A Document's status changed: a new version has its Folder's Minds checked for contradictions. */
    documentChanged: (document: Document) => watch.documentChanged(document),

    /** A Note joined a Folder: the background watch a change in the Folder's contents starts. */
    mindJoinedFolder: (mindId: string) => watch.mindJoinedFolder(mindId),

    /** Documents joined a Folder: its Notes' background watch, as for a new version there. */
    folderContentsChanged: (folderId: string) => watch.folderContentsChanged(folderId),

    /** Starts watching for new versions of Documents. */
    startWatching: () => watch.start(),

    /** `signal` stops the check, for a caller in the core; the API's callers can't pass one. */
    async checkClaim(input: unknown, signal?: AbortSignal): Promise<ClaimCheckResult> {
      const parsed = parseClaim(input);
      const ready = await prepare(parsed.model ?? options.defaultModel());
      if (!ready.ok) {
        const { result } = ready;
        if (result.kind === "not-ready") throw new ChatNotReadyError(result.readiness);
        throw new InvalidInputError({
          key: result.kind === "local-mode" ? "error.check.localMode" : "error.check.declined",
        });
      }
      await options.evidence.ready(undefined, () => parsed.checked);
      const scope = options.evidence.scope(
        parsed.mindId,
        options.scopeDocuments(parsed.scope, parsed.mindId),
        parsed.checked,
      );
      // Nothing to check against: nothing backs it, and nothing is sent.
      if (options.documents.searchableCount(scope.documentIds) === 0) {
        const result: ClaimCheckResult = {
          verdict: "unsupported",
          evidence: null,
          says: null,
          unsupported: null,
          calculation: null,
          citedCaseUnchecked: caseCitations(parsed.claim).length > 0,
          citedCaseFound: false,
          versions: [],
          excluded: [],
          ...unplacedRecordCites(parsed.claim),
        };
        return resultFromParts([
          partWithResult({ kind: "fact", span: { start: 0, end: parsed.claim.length } }, result),
        ]);
      }
      const checksDocument =
        (parsed.checked.documentIds?.length ?? 0) + (parsed.checked.contentHashes?.length ?? 0) > 0;
      const ends = signal ?? new AbortController().signal;
      const outcome = await runCheck(
        claimCheck,
        {
          claim: parsed.claim,
          context: parsed.context,
          cited: citedNow(parsed.cited),
          scope,
          model: ready.prepared,
          ...(parsed.mindId !== null && { mindId: parsed.mindId }),
          // Reading the document being checked makes the Run third-party (#78).
          ...(checksDocument && { thirdParty: [{ via: "read", source: "checked-document" }] }),
          signal: ends,
        },
        checkRunOf(options, ready.prepared, ends, parsed.mindId),
      );
      return resultOf(outcome);
    },

    async chooseRecordCiteSource(value: unknown) {
      const input = chooseInput(value);
      const stored = content.read(input.mindId, (blocks) =>
        checkedSentences(blocks).find(({ check }) => check.id === input.checkId),
      );
      if (!stored) throw new InvalidInputError({ key: "error.recordCite.notFound" });
      // The cites' offsets are in the sentence as the Note holds it, its Citations included.
      const recordClaim = stored.noteText ?? stored.check.text;
      const sameCite = (cite: { raw: string; from?: number; to?: number }) =>
        cite.raw === input.raw &&
        (input.from === undefined || cite.from === input.from) &&
        (input.to === undefined || cite.to === input.to);
      const existing = (stored.check.recordCites ?? []).filter(sameCite);
      const cite = existing[0];
      if (existing.length !== 1 || !cite) {
        throw new InvalidInputError({ key: "error.recordCite.notFound" });
      }
      if (!(cite.candidates ?? []).some((candidate) => candidate.id === input.documentId)) {
        throw new InvalidInputError({ key: "error.recordCite.choiceInvalid" });
      }
      const wanted =
        stored.check.scope.chosen ??
        (stored.check.scope.widened ? null : folderScope(stored.check.scope.folderId));
      await options.evidence.ready(undefined, () => leftOutOf(input.mindId));
      // Resolved as the Mind's checks resolve theirs, so its wall bounds what a choice reads.
      const leftOut = leftOutOf(input.mindId);
      const scope = options.evidence.scope(
        input.mindId,
        options.scopeDocuments(wanted, input.mindId),
        leftOut,
      );
      const document = recordCiteLibrary(options.documents, scope).documents.find(
        (each) => each.id === input.documentId,
      );
      if (!document) {
        const live = (options.documents.names?.() ?? []).some(
          (each) => each.id === input.documentId,
        );
        const walled =
          options.walledFolder(input.mindId) !== null ||
          options.walledDocument(input.documentId) !== null;
        throw new InvalidInputError({
          key: live && walled ? "error.folder.wall" : "error.recordCite.documentGone",
        });
      }
      // Read as the check read it: a further range of a deposition ("…, 47:1–4") has its source.
      const read =
        recordCiteTokens(recordClaim).find((token) => token.kind === "cite" && sameCite(token)) ??
        null;
      const parsed = read?.kind === "cite" ? read.result : parseRecordCite(cite.raw);
      const resolved = resolveChosenRecordCite(
        { ...parsed, raw: cite.raw, from: cite.from, to: cite.to },
        document,
        depositionMapper,
      );
      if (resolved.outcome !== "found") {
        throw new InvalidInputError({ key: "error.recordCite.unresolved" });
      }
      const ready = await prepare(
        stored.check.providerId && stored.check.modelId
          ? { providerId: stored.check.providerId, modelId: stored.check.modelId }
          : options.defaultModel(),
      );
      if (!ready.ok) {
        const { result } = ready;
        const reason = result.kind === "not-ready" ? result.readiness.reason : result.kind;
        throw new InvalidInputError({
          key:
            reason === "local-mode"
              ? "error.check.localMode"
              : reason === "cancelled" || reason === "consent-declined"
                ? "error.check.declined"
                : "error.recordCite.modelNotReady",
        });
      }
      const judged = await judgeResolvedRecordCites(
        [resolved],
        ready.prepared,
        recordClaim,
        new AbortController().signal,
        options.language(),
        stored.check.recordCites ?? [resolved],
      );
      if (judged.failure) throw notJudgedError(judged.failure);
      const final = judged.recordCites[0];
      if (!final?.location) throw new InvalidInputError({ key: "error.recordCite.unresolved" });
      const alias = parsed.status === "parsed" ? recordCiteChoiceAlias(parsed) : null;
      let replaced = false;
      content.edit(input.mindId, (blocks) =>
        updateCheck(blocks, input.checkId, (check) => {
          if (check.text !== stored.check.text) return check;
          const recordCites = (check.recordCites ?? []).map((each) => {
            if (each.raw !== cite.raw || each.from !== cite.from || each.to !== cite.to) {
              return each;
            }
            replaced = true;
            return final;
          });
          return {
            ...check,
            recordCites,
            versions:
              final.documentId &&
              final.contentHash &&
              !check.versions.some((version) => version.documentId === final.documentId)
                ? [
                    ...check.versions,
                    { documentId: final.documentId, contentHash: final.contentHash },
                  ]
                : check.versions,
          };
        }),
      );
      // The sentence was edited or checked again meanwhile: its cites are no longer these.
      if (!replaced) throw new InvalidInputError({ key: "error.recordCite.notFound" });
      if (alias) {
        content.editSettings(input.mindId, (settings) =>
          writeRecordCiteChoice(settings, alias, {
            documentId: document.id,
            contentHash: document.contentHash,
          }),
        );
      }
      retainEvidence(input.mindId);
      return { cite: final };
    },

    /** Stops a request: its sentences not checked yet are marked "stopped", and a Note it kept is free. */
    cancel(requestId: string): void {
      const active = running.get(requestId);
      active?.controller.abort();
      // A running Check frees its Note as it unwinds, so no second one starts over it.
      if (!active) mindCheck.release(requestId);
    },

    /** Marks "stopped" the sentences a request that is no longer running left "checking", e.g. after a crash. */
    settleStale(mindId: string): void {
      const live = new Set(
        [...running].filter(([, run]) => run.mindId === mindId).map(([id]) => id),
      );
      const stale = content.read(mindId, (blocks) =>
        markedSentences(blocks).filter(
          ({ check }) => check.state === "checking" && !live.has(check.request),
        ),
      );
      if (stale.length === 0) return;
      const ids = stale.map(({ check }) => check.id);
      content.edit(mindId, (blocks) => {
        for (const id of ids) updateCheck(blocks, id, stopped);
      });
    },

    /** Stops every request, as IncarnaMind quits: their sentences not checked yet say "stopped". */
    stopAll(): void {
      watch.close();
      written.stopAll();
      for (const [requestId, { controller, mindId }] of running) {
        controller.abort();
        try {
          settleStopped(mindId, requestId);
        } catch (error) {
          console.error(`The check ${requestId} couldn't be marked stopped:`, error);
        }
      }
      running.clear();
    },
  };
}
