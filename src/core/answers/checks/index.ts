/**
 * Check against Documents (#96) on the User's own sentences in a Mind, and
 * the claim-check function the other checks share with it (./claimCheck).
 *
 * 1. The sentences the selection touches are read from the Mind, whole, and
 *    each gets a "checking" mark at once (./sentences).
 * 2. They are checked one at a time against the Mind's Folder (every
 *    Document for a Mind in none, or when the User widens it), each in a
 *    check Run that can only search and cite.
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
import { keepRecordCites, restsOn } from "../../../shared/claimChecks";
import {
  boundedCheck,
  boundedCheckParts,
  checkWithParts,
  figuresByPart,
  partWithResult,
  pendingPart,
  resultFromParts,
  withFigureFacts,
} from "../../../shared/claimParts";
import {
  beginFigureCheck,
  readFigureFinding,
  settleFigureCheck,
} from "../../../shared/figureChecks";
import { mindScopeIn } from "../../../shared/mindScope";
import {
  budgetStopOf,
  judgesAbsence,
  resumesRead,
  stoppedAtBudget,
} from "../../../shared/readBudget";
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
  type ClaimJudgment,
  type ClaimPartSpan,
  type ContradictionCheckPlan,
  type Currency,
  claimCheckActions,
  type Document,
  type DocumentCheckPlan,
  type DocumentCheckProgress,
  type ExternalService,
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
import { augmentFigureFooting } from "../../figureSchedule";
import type { Language } from "../../language";
import type { MindContent } from "../../mindContent";
import { parseMindId } from "../../minds";
import type { PreparedChatModel } from "../../providers/chat";
import { type RecordCiteSource, recordCiteLibrary } from "../../recordCites/documents";
import { parseRecordCite, recordCiteTokens } from "../../recordCites/parser";
import { recordCiteChoiceAlias, resolveChosenRecordCite } from "../../recordCites/resolver";
import { currentTask } from "../../runs/current";
import { parseSearchScope } from "../../scope";
import type { AnswerEngine } from "../engine";
import { createAnswerCheck } from "./answerCheck";
import {
  type AtomicClaimCheckResult,
  type CheckedCitation,
  type ClaimCheckDependencies,
  type ClaimCheckRequest,
  checkRunStart,
  createClaimCheck,
  recordJudged,
} from "./claimCheck";
import { createMindCheck, type MindCheckOptions } from "./mindCheck";
import { recordOpinions, removeOpinion, unmarkedOpinion } from "./opinions";
import { createPartCheck, partRequest } from "./partCheck";
import {
  judgeResolvedRecordCites,
  notJudgedError,
  unplacedRecordCites,
  withRecordCites,
} from "./recordCites";
import { pendingParts } from "./runChecks";
import {
  markedSentences as allMarks,
  checkedSentences,
  checkText,
  citedQuoteOf,
  everySentence,
  markedSentences,
  markSentence,
  noteTextOf,
  recordCiteParagraphs,
  type SelectedSentence,
  selectedSentences,
  updateCheck,
} from "./sentences";
import { createVerify, type NoDocuments, type VerifyOptions } from "./verify";
import { createContradictionWatch, type WatchOptions } from "./watch";
import {
  createWholeRead,
  DOCUMENT_CHECK_FLOW_SENDS,
  type ModelShape,
  type PlannedCheck,
} from "./wholeRead";
import { createWrittenCheck, type WrittenCheckOptions } from "./written";

/**
 * What the "checks" flow sends: the sentences checked, with their paragraphs,
 * the Passages found, a verified document's sentences, to find its claims
 * (#97), and a Mind's sentences when the whole Mind is checked (#737).
 */
export const CHECKS_FLOW_SENDS = ["selection", "passages", "verified-document", "blocks"] as const;

/** The longest claim one check takes, in characters: a sentence, not a page. */
const MAX_CLAIM_CHARACTERS = 2_000;

type CheckFlow = "checks" | "document-check";

export interface ChecksOptions
  extends Pick<
    VerifyOptions,
    | "requireFolder"
    | "addFile"
    | "document"
    | "onStatus"
    | "readText"
    | "readTables"
    | "readScanned"
    | "createMind"
    | "wordRefusal"
    | "importWord"
    | "wordWritten"
    | "discardWordMind"
    | "recordAiUse"
    | "unread"
  > {
  /** The interface language: what a check's sentence is written in. */
  language(): Language;
  content: Pick<MindContent, "read" | "edit" | "readSettings" | "editSettings">;
  /** What contradiction watch needs besides (#112). */
  watch: Pick<
    WatchOptions,
    "minds" | "documentVersions" | "background" | "runCost" | "delayMs" | "claimTimeLimitMs" | "log"
  >;
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
  /** The Documents a pick covers on its Note's side of a Folder wall, as its searches see them. */
  pickedDocuments(within: SearchScope, mindId: string): string[];
  /** The file a Mind was imported from (#720), which its own checks never use as evidence. */
  originalOf(mindId: string): CheckedDocument | null;
  /** The default chat model, used when the Mind has none of its own. */
  defaultModel(): ChatModelChoice | null;
  /** The model a Mind whose own pick is `own` is checked with: see `modelInUse`. */
  modelInUse(own: ChatModelChoice | null): ChatModelChoice | null;
  chat: {
    readiness(choice: ChatModelChoice | undefined, flow: CheckFlow): Promise<ChatReadiness>;
    prepareModel(choice: ChatModelChoice | undefined, flow: CheckFlow): Promise<PreparedChatModel>;
    modelShape(choice: ChatModelChoice | undefined): Promise<ModelShape | null>;
    /** The service the default chat model sends to; null with none, or one on this computer. */
    defaultService(): ExternalService | null;
  };
  consent: Consent;
  /** Local mode: only models on this computer. */
  localOnly(): boolean;
  resolveScope(scope: SearchScope, mindId?: string | null): string[] | null;
  /** The Documents a Search scope covers; with none, the User's own (`scopeDocuments`). */
  scopeDocuments(scope: SearchScope | null, mindId: string | null): string[] | null;
  evidence: Pick<Evidence, "scope" | "search">;
  documents: ClaimCheckDependencies["documents"] &
    MindCheckOptions["documents"] &
    Pick<RecordCiteSource, "batesHolders"> & {
      /** Every live Document's names: what the Citations a sentence already has are named by. */
      names(): readonly LiveDocument[];
      /** The live Documents of these, in the order given. */
      live(documentIds: readonly string[]): Document[];
      /** A live Document's Passages, in reading order. */
      passages(documentId: string): WindowedPassage[];
    };
  /** The estimate of a whole read's requests. */
  estimateRead(model: ChatModelChoice | null, read: EstimatedRead): RunEstimate | null;
  /** What a whole read's requests have settled at, by its request id, in `currency`. */
  readSpent(requestId: string, currency: Currency): Money;
  /** How far a whole read is, as it goes (#1554). */
  documentCheckProgress(event: DocumentCheckProgress): void;
  engine: AnswerEngine;
  retention: Pick<VersionRetention, "retain" | "retainedBy">;
  /** Edit with AI's new text for a passage not in a Mind, for what the assistant writes (#1111). */
  editText: WrittenCheckOptions["editText"];
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
  /** "check-against-document": what to read whole. */
  within: SearchScope | null;
  plan: string | null;
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
  const within = known === "check-against-document" ? parseWithin(input.within) : null;
  const plan = typeof input.plan === "string" && input.plan !== "" ? input.plan : null;
  // A whole read sends a Document's text at a cost the User saw: never without its plan.
  if (within && plan === null) throw new InvalidInputError({ key: "error.check.readUnplanned" });
  return {
    requestId,
    mindId: parseMindId(input.mindId),
    from: parsePlace(input.from, "from"),
    to: parsePlace(input.to, "to"),
    more: parseStretches(input.more),
    action: known,
    allDocuments: input.allDocuments === true,
    within,
    plan: within ? plan : null,
    model: parseModel(input.model),
    ...(part && { part }),
  };
}

function parseWithin(value: unknown): SearchScope {
  const within = parseSearchScope(value);
  if (!within) throw new InvalidInputError({ key: "error.check.noDocumentPicked" });
  return within;
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
    checked: parseCheckedDocument(input.checked),
    model: parseModel(input.model),
  };
}

/** A Citation as a mark stores it: the Passage that decides a claim, or that covers part of it. */
const evidenceOf = (citation: CitationAttributes | null): CitationAttributes | null =>
  citation && {
    passageId: citation.passageId,
    documentId: citation.documentId,
    documentName: citation.documentName,
    contentHash: citation.contentHash,
    pageFrom: citation.pageFrom,
    pageTo: citation.pageTo,
    location: citation.location,
    quote: citation.quote,
    check: citation.check,
    checkReason: citation.checkReason,
    ...(citation.id && { id: citation.id }),
  };

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
  // Verify anchors a whole row to its first cell (#1368); its contextual claim has different offsets.
  if (result.parts && sourceText !== check.text) {
    const evidence = result.parts.flatMap((part) => part.evidence);
    result = {
      ...result,
      ...resultFromParts([
        partWithResult(
          { span: { start: 0, end: check.text.length }, kind: "fact" },
          result,
          evidence,
        ),
      ]),
    };
  }
  if (result.parts) {
    // A mark holds no key without a value: with one, Tie out figures never saw its checks end.
    const { recordCites: _earlier, ...basis } = check;
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
  const next = withJudgment(basis, result, at);
  const { parts: _parts, ...childBasis } = basis;
  if (!result.figures) {
    if (!check.figures) return next;
    const settled = settleFigureCheck(check, (child) =>
      result.verdict === "not-checked"
        ? withJudgment(child, result, at)
        : { ...child, state: "not-checked", reason: "malformed", detail: null, checkedAt: at },
    );
    return next.parts ? { ...settled, parts: next.parts } : settled;
  }
  const figures = result.figures.flatMap((figure) => {
    const finding = readFigureFinding(figure);
    return finding
      ? [{ ...withJudgment({ ...childBasis, id: finding.id }, figure.result, at), ...finding }]
      : [];
  });
  if (figures.length !== result.figures.length)
    return settleFigureCheck(check, (child) => ({
      ...child,
      state: "not-checked",
      reason: "malformed",
      detail: null,
      checkedAt: at,
    }));
  if (!check.figures)
    return {
      ...next,
      figures,
      ...(result.remainder !== undefined && {
        remainder:
          result.remainder === null
            ? null
            : withJudgment({ ...childBasis, id: `${basis.id}:remainder` }, result.remainder, at),
      }),
    };
  const pending = check.figures.filter(
    (child) => child.request === check.request && child.state === "checking",
  );
  const received = new Map(figures.map((child) => [child.id, child]));
  if (
    received.size !== figures.length ||
    received.size !== pending.length ||
    pending.some((child) => !received.has(child.id))
  )
    return settleFigureCheck(check, (child) => ({
      ...child,
      state: "not-checked",
      reason: "malformed",
      detail: null,
      checkedAt: at,
    }));
  const remainderPending =
    check.remainder?.request === check.request && check.remainder.state === "checking";
  return {
    ...next,
    figures: check.figures.map((child) => received.get(child.id) ?? child),
    ...(remainderPending
      ? result.remainder === undefined
        ? {}
        : {
            remainder:
              result.remainder === null
                ? null
                : withJudgment(check.remainder ?? childBasis, result.remainder, at),
          }
      : check.remainder === undefined
        ? {}
        : { remainder: check.remainder }),
  };
}

const stopped = (check: ClaimCheckAttributes): ClaimCheckAttributes => {
  const settled = settleFigureCheck(check, (basis) => ({
    ...basis,
    state: "not-checked",
    reason: "stopped",
  }));
  if (!check.parts) return settled;
  const parts = (settled.parts ?? check.parts).map(
    (part): ClaimCheckPart =>
      part.verdict === "checking"
        ? { ...part, verdict: "not-checked", reason: "stopped", detail: null }
        : part,
  );
  return withResult({ ...settled, parts }, resultFromParts(parts), check.checkedAt);
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

/** A sentence as a whole read finds it again: the Note can be reloaded while it reads. */
const sentenceKey = (
  mindId: string,
  { blockId, occurrence, text }: Pick<SelectedSentence, "blockId" | "occurrence" | "text">,
) => JSON.stringify([mindId, blockId, occurrence, text]);

const isSentence = (
  a: Pick<SelectedSentence, "element" | "from" | "to">,
  b: Pick<SelectedSentence, "element" | "from" | "to">,
) => a.element === b.element && a.from === b.from && a.to === b.to;

/**
 * A whole read's result with one figure for what the read spent on every line its budget stopped,
 * what its requests settled at once the sentence's check ended, however its parts were refused;
 * and on each part it stopped, whether that part's read judges its absence, as the read planned it.
 */
function withSpent(
  result: ClaimCheckResult,
  spent: (currency: Currency) => Money,
  previous: readonly ClaimCheckPart[] | undefined,
): ClaimCheckResult {
  const settle = (detail: string | null, planned?: boolean) => {
    const stop = budgetStopOf(detail);
    if (!stop) return detail;
    return JSON.stringify({
      most: stop.most,
      spent: spent(stop.most.currency),
      ...(planned !== undefined && { judgesAbsence: planned }),
    });
  };
  const parts = result.parts?.map((part) => {
    if (!stoppedAtBudget(part)) return part;
    const before = previous?.find(
      (each) => each.span.start === part.span.start && each.span.end === part.span.end,
    );
    return { ...part, detail: settle(part.detail, before ? judgesAbsence(before) : true) };
  });
  const settled = parts ? { ...result, parts } : result;
  return settled.verdict === "not-checked" && settled.reason === "read-budget"
    ? { ...settled, detail: settle(settled.detail) }
    : settled;
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
  ): ClaimCheckAttributes {
    const before = previous ?? check;
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
    return withResult(
      check,
      {
        ...result,
        ...augmentFigureFooting(blocks, result, options.documents, {
          versions: options.watch.documentVersions(),
          folderId: options.mindFolder(mindId),
          scope: content.readSettings(mindId, mindScopeIn),
        }),
      },
      at,
      sourceText,
      priorParts,
    );
  }
  /** The requests running, by id: how to stop each, and its Mind. */
  const running = new Map<string, { controller: AbortController; mindId: string }>();
  /** Which of them read a picked Document or Folder whole. */
  const wholeReads = new Set<string>();
  const recordCiteDocuments = {
    ...options.documents,
    recordChoices: (mindId: string) => content.readSettings(mindId, readRecordCiteChoices),
    noteParagraphs: (mindId: string) => content.read(mindId, recordCiteParagraphs),
  };
  const withCites = (check: ReturnType<typeof createClaimCheck>) =>
    withRecordCites(check, { language: options.language, documents: recordCiteDocuments });
  const claimCheck = withCites(createPartCheck(options));
  const atomicCheck = createClaimCheck(options);
  // The background watch only adds a Contradicted with its quote: it checks each sentence whole.
  const wholeCheck = withCites(createClaimCheck(options));

  const services = async () => {
    const service = chat.defaultService();
    return service ? [service] : [];
  };
  options.consent.registry.register({ id: "checks", sends: CHECKS_FLOW_SENDS, services });
  options.consent.registry.register({
    id: "document-check",
    sends: DOCUMENT_CHECK_FLOW_SENDS,
    services,
  });

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
      return { ok: true, prepared: await chat.prepareModel(choice ?? undefined, flow) };
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
          evidence.documentId && evidence.contentHash
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
        // A Passage of an older version isn't what the Document says now.
        ...(each.passageId &&
          current?.contentHash === each.contentHash && { passageId: each.passageId }),
      };
    });
  }

  /** Marks a request's sentences not checked yet "stopped". */
  function settleStopped(mindId: string, request: string): void {
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
    const scope = options.evidence.scope(resolved, leftOut);
    const searchable = options.documents.searchableCount(scope.documentIds);
    const empty = (): NoDocuments => {
      const none: NoDocuments = { kind: "no-documents", folderId };
      if (!inChosen || !wanted) return none;
      if (
        options.documents.searchableCount(
          options.evidence.scope(options.scopeDocuments(null, mindId), leftOut).documentIds,
        ) === 0
      )
        return none;
      const onlyLeftOut =
        options.documents.searchableCount(options.evidence.scope(resolved).documentIds) > 0;
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

  /** The part's owner as the Note is now; null once the part has changed. */
  function currentPartOwner(blocks: Y.XmlFragment, target: NonNullable<ParsedCheck["part"]>) {
    try {
      return partOwner(blocks, target);
    } catch (error) {
      if (error instanceof InvalidInputError) return null;
      throw error;
    }
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
    const plans = previous?.map(({ span, kind }) => ({ span, kind }));
    const parts =
      owner?.parts.map(
        (part): ClaimCheckPart =>
          input.part &&
          part.span.start === input.part.span.start &&
          part.span.end === input.part.span.end
            ? { ...pendingPart(part), verdict: "checking" }
            : part,
      ) ??
      (plans && pendingParts(plans, previous));
    const check: ClaimCheckAttributes = {
      // A whole read writes onto the mark it was asked from, so that mark's open card shows it.
      id: input.part?.id ?? (input.within ? physicalPrior?.id : undefined) ?? randomUUID(),
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
      // A whole read's mark says what it read: the pick, whichever part it was asked about.
      scope: input.within ? scope : (owner?.check?.scope ?? scope),
      versions: [],
      excluded: [],
      checkedAt: startedAt,
      ...(parts && { parts }),
    };
    const priorFigures =
      allMarks(blocks).find(
        (mark) =>
          mark.element === sentence.element && mark.from < sentence.to && mark.to > sentence.from,
      )?.check ?? null;
    const pending = sentence.figures?.length
      ? beginFigureCheck(priorFigures, check, sentence.figures, null, sentence.projection)
      : check;
    return {
      pending,
      queued: {
        id: check.id,
        ...checkText(sentence),
        cited: sentence.cited,
        recordClaim: noteTextOf(sentence),
        place: { blockId: sentence.blockId, from: sentence.from },
        ...(plans && { parts: plans }),
        ...(input.part && { only: input.part.span }),
        ...(previous && { previous }),
        ...(input.within && prior && resumesRead(prior, input.within) && { resumesStopped: true }),
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
      ...(sentence.projection && { projection: sentence.projection }),
      context: sentence.context,
      ...(sentence.figures && { figures: sentence.figures }),
      cited: citedNow(sentence.cited),
      ...("parts" in sentence && sentence.parts && { parts: sentence.parts }),
      ...("only" in sentence && sentence.only && { only: sentence.only }),
      ...("previous" in sentence && sentence.previous && { previous: sentence.previous }),
      ...("resumesStopped" in sentence && sentence.resumesStopped && { resumesStopped: true }),
      scope,
      model: prepared,
      mindId,
      recordClaim: sentence.recordClaim,
      place: sentence.place,
      cacheKey: mindId,
      signal,
    };
  }

  /** Every check marking a sentence, as it reads now: what a whole read's result may replace. */
  const marksOn = (blocks: Y.XmlFragment, sentence: SelectedSentence) =>
    JSON.stringify(
      markedSentences(blocks)
        .filter(
          (each) =>
            each.element === sentence.element && each.from < sentence.to && each.to > sentence.from,
        )
        .map(({ check }) => check),
    );

  /**
   * The sentences a whole read of these stretches reads (as `sentenceKey`s, with the part asked
   * about), and how many of their parts it checks against the pick: a part asked about; after a
   * read of the same pick stopped at its budget, each part it stopped before judging; else each
   * not yet Supported or Contradicted, as the part check reads them, with each one's check. Null
   * parts: a sentence with none yet is sorted as it is read, its check naming its parts first.
   */
  function readTarget(
    mindId: string,
    stretches: readonly TextStretch[],
    part: ParsedCheck["part"],
    within: SearchScope,
  ): { sentences: string; parts: number | null; checks: PlannedCheck[] } {
    return content.read(mindId, (blocks) => {
      const selected = selectedSentences(blocks, stretches);
      const sentences = selected.ok ? selected.sentences : [];
      const owner = part ? partOwner(blocks, part) : null;
      const read = sentences.filter((sentence) => !owner || isSentence(owner.sentence, sentence));
      let parts: number | null = 0;
      const checks: PlannedCheck[] = [];
      for (const sentence of read) {
        const marks = markedSentences(blocks).filter(
          (each) =>
            each.element === sentence.element && each.from < sentence.to && each.to > sentence.from,
        );
        const prior =
          marks.length === 1 && marks[0]?.check.text === sentence.text ? marks[0] : null;
        const all = owner?.parts ?? prior?.check.parts;
        const open = part
          ? owner?.parts.filter(
              (each) => each.span.start === part.span.start && each.span.end === part.span.end,
            )
          : prior && resumesRead(prior.check, within)
            ? prior.check.parts?.filter(stoppedAtBudget)
            : prior?.check.parts?.filter(
                (each) =>
                  each.verdict !== "supported" &&
                  each.verdict !== "contradicted" &&
                  !(each.kind === "opinion" && each.verdict === null),
              );
        parts = parts === null || open === undefined ? null : parts + open.length;
        const asked = { ...checkText(sentence), cited: citedNow(sentence.cited) };
        if (!all || !open) {
          checks.push({ ...asked, findsParts: true, judgesAbsence: true });
          continue;
        }
        const figures = asked.figures ?? [];
        const plans = withFigureFacts(asked.claim, all, figures, asked.projection);
        const owned = figuresByPart(asked.claim, plans, figures, asked.projection);
        for (const each of open) {
          checks.push({
            ...partRequest(asked, each.span, owned?.[all.indexOf(each)] ?? []),
            judgesAbsence: judgesAbsence(each),
          });
        }
      }
      return {
        sentences: JSON.stringify([read.map((each) => sentenceKey(mindId, each)), part ?? null]),
        parts,
        checks,
      };
    });
  }

  /**
   * Check against a Document… (./wholeRead). A sentence's mark stays as it was until its read
   * ends, so Stop or a crash leaves it so; a newer read of the sentence, or any change to its mark
   * meanwhile, wins over the result.
   */
  async function readSentences(
    input: ParsedCheck,
    within: SearchScope,
    planned: () => boolean,
    signal: AbortSignal,
  ): Promise<CheckSentencesResult> {
    const { mindId } = input;
    const current = () => !signal.aborted && planned();
    const stretches = [{ from: input.from, to: input.to }, ...input.more];
    const found = content.read(mindId, (blocks) => {
      const selected = selectedSentences(blocks, stretches);
      if (!selected.ok) return selected;
      if (input.part) partOwner(blocks, input.part);
      // Its mark stays until the read ends, so a check already running would outlast a newer read.
      const checking = selected.sentences.some((sentence) =>
        markedSentences(blocks).some(
          (each) =>
            each.element === sentence.element &&
            each.from < sentence.to &&
            each.to > sentence.from &&
            each.check.state === "checking",
        ),
      );
      if (checking) throw new InvalidInputError({ key: "error.check.partChecking" });
      return selected;
    });
    if (!found.ok) return { kind: found.reason };
    const read = wholeRead.toRead(mindId, within);
    if ("kind" in read) return { kind: "cannot-read", plan: read };
    const ready = await prepare(input.model ?? options.defaultModel(), "document-check");
    if (!ready.ok) return ready.result;
    // Consent or the model can take a while: a pick replaced meanwhile sends nothing.
    if (!current()) return { kind: "cancelled" };
    const { prepared } = ready;
    const scope: ClaimCheckScope = {
      folderId: options.mindFolder(mindId),
      widened: false,
      chosen: within,
    };
    const startedAt = options.now().toISOString();
    const started = content.read(mindId, (blocks) => {
      const again = selectedSentences(blocks, stretches);
      if (!again.ok) return { waiting: found.waiting, sentences: [] };
      const owner = input.part ? partOwner(blocks, input.part) : null;
      const sentences = again.sentences.flatMap((sentence) =>
        owner && !isSentence(owner.sentence, sentence)
          ? []
          : [
              {
                key: sentenceKey(mindId, sentence),
                marks: marksOn(blocks, sentence),
                queued: startCheck(blocks, sentence, owner, input, prepared, scope, startedAt)
                  .queued,
              },
            ],
      );
      return { waiting: again.waiting, sentences };
    });
    const { waiting } = started;
    if (started.sentences.length === 0) {
      return waiting.sentences.length > 0 ? { kind: "waiting", waiting } : { kind: "nothing" };
    }

    // Every request of the read counts toward the most it may spend, which it never passes.
    const budget = wholeRead.budget(mindId, input.plan ?? "");
    const task = { id: input.requestId, ...(budget && { budget }) };
    /** The first check the budget stopped: no part after it sends anything. */
    let stopped: AtomicClaimCheckResult | null = null;
    const atomic = async (request: ClaimCheckRequest): Promise<AtomicClaimCheckResult> => {
      if (stopped) return stopped;
      const result = await atomicCheck(request);
      if (result.verdict === "not-checked" && result.reason === "read-budget") {
        stopped ??= { ...result, versions: [], excluded: [] };
      }
      return result;
    };
    let checked = 0;
    for (const { key, marks, queued } of started.sentences) {
      if (!current()) break;
      wholeRead.claim(key, input.requestId);
      try {
        const reading = wholeRead.reader(input, read, prepared, atomic, current);
        const result = withSpent(
          await currentTask.run(task, () =>
            withCites(createPartCheck(options, reading.readPart))({
              ...checkRequest(queued, read.scope, prepared, mindId, signal),
              undecidedOnly: true,
            }),
          ),
          (currency) => options.readSpent(input.requestId, currency),
          "previous" in queued ? queued.previous : undefined,
        );
        if (!current()) break;
        const at = options.now().toISOString();
        recordJudged(options.recordAiUse, mindId, prepared, result, at);
        const kept = content.edit(mindId, (blocks) => {
          if (!wholeRead.owns(key, input.requestId)) return false;
          const again = selectedSentences(blocks, stretches);
          const now = again.ok
            ? again.sentences.find((each) => sentenceKey(mindId, each) === key)
            : undefined;
          if (!now || marksOn(blocks, now) !== marks) return false;
          const owner = input.part ? currentPartOwner(blocks, input.part) : null;
          if (input.part && !owner) return false;
          const begun = startCheck(blocks, now, owner, input, prepared, scope, startedAt);
          const settled = noteResult(
            begun.pending,
            result,
            at,
            blocks,
            mindId,
            begun.queued.claim,
            begun.queued.priorParts,
            begun.queued.before,
          );
          markSentence(now.element, now.from, now.to, {
            ...settled,
            read: { pages: reading.pagesRead(), of: read.pages },
          });
          if (input.part) removeOpinion(blocks, input.part.id);
          recordOpinions(blocks, []);
          return true;
        });
        if (!kept) continue;
        if (result.verdict !== "not-checked") checked++;
        retainEvidence(mindId);
      } finally {
        wholeRead.release(key, input.requestId);
      }
    }
    if (!current()) return { kind: "cancelled" };
    return {
      kind: "checked",
      sentences: started.sentences.length,
      checked,
      smallModel: judgesUnreliably(prepared),
      ...(waiting.sentences.length > 0 && { waiting }),
    };
  }

  async function checkSentences(
    input: ParsedCheck,
    signal: AbortSignal,
  ): Promise<CheckSentencesResult> {
    const { mindId } = input;
    const stretches = [{ from: input.from, to: input.to }, ...input.more];
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
        if (owner && !isSentence(owner.sentence, sentence)) return [];
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
    for (const sentence of queued) {
      if (signal.aborted) break;
      const result = await claimCheck(
        checkRequest(sentence, evidenceScope, ready.prepared, mindId, signal),
      );
      if (signal.aborted) break;
      if (result.verdict !== "not-checked") checked++;
      const at = options.now().toISOString();
      recordJudged(options.recordAiUse, mindId, ready.prepared, result, at);
      const kept = content.edit(mindId, (blocks) =>
        updateCheck(blocks, sentence.id, (check) =>
          noteResult(
            check,
            result,
            at,
            blocks,
            mindId,
            sentence.claim,
            sentence.priorParts,
            sentence.before,
          ),
        ),
      );
      if (kept) retainEvidence(mindId);
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

  /** The model, when it can be used now without asking the User: never in the background. */
  async function prepareQuietly(choice: ChatModelChoice | null): Promise<PreparedChatModel | null> {
    const readiness = await chat.readiness(choice ?? undefined, "checks");
    if (!readiness.ready) return null;
    const { service } = readiness.provider;
    if (
      service &&
      (options.localOnly() || options.consent.status("checks", service) !== "accepted")
    ) {
      return null;
    }
    try {
      return await chat.prepareModel(choice ?? undefined, "checks");
    } catch (error) {
      if (error instanceof ChatNotReadyError || error instanceof ConsentDeclinedError) return null;
      throw error;
    }
  }

  const watch = createContradictionWatch({
    ...options,
    ...options.watch,
    folderDocuments: (folderId) =>
      options.resolveScope({ folderIds: [folderId], tagIds: [], documentIds: [] }) ?? [],
    evidenceScope: (mindId, documentIds, citedIds) =>
      options.evidence.scope(documentIds, leftOutOf(mindId, { documentIds: [...citedIds] })),
    searchableCount: (documentIds) => options.documents.searchableCount(documentIds),
    prepare,
    prepareQuietly,
    claimCheck: wholeCheck,
    withResult: noteResult,
    retainEvidence,
    track,
  });

  const verify = createVerify({
    ...options,
    prepare,
    evidenceScope: (mindId, allDocuments, verification) =>
      scopeOf(mindId, allDocuments, { documentIds: [verification.documentId] }),
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
    scopeOf: (mindId, allDocuments) => scopeOf(mindId, allDocuments),
    citedNow,
    recordUnread,
    isRunning: (requestId) => running.has(requestId),
    claimCheck,
    withResult: noteResult,
    retainEvidence,
    settleStopped,
    track,
  });

  const checkWritten = createWrittenCheck({
    ...options,
    prepare: (answer) =>
      prepareQuietly({ providerId: answer.provider.id, modelId: answer.modelId }),
    claimCheck,
    scopeOf: (mindId) => scopeOf(mindId, false),
    citedNow,
    withResult: noteResult,
    read: (mindId, look) => content.read(mindId, look),
    retainEvidence,
    claimTimeLimitMs: options.watch.claimTimeLimitMs,
  });

  const checkAnswer = createAnswerCheck({
    prepare: prepareQuietly,
    claimCheck,
    scope: (documentIds) => options.evidence.scope(documentIds),
    searchableCount: (documentIds) => options.documents.searchableCount(documentIds),
    citedNow,
    claimTimeLimitMs: options.watch.claimTimeLimitMs,
  });

  const wholeRead = createWholeRead({
    documents: options.documents,
    pickedDocuments: options.pickedDocuments,
    evidenceScope: (mindId, documentIds) => options.evidence.scope(documentIds, leftOutOf(mindId)),
    defaultModel: options.defaultModel,
    model: (choice) => chat.modelShape(choice ?? undefined),
    runStart: (check, model) => checkRunStart(options, check, model),
    estimate: options.estimateRead,
    progress: options.documentCheckProgress,
    newId: randomUUID,
  });

  return {
    ...verify,

    /** What the assistant wrote in a Mind, checked before it lands (./written). */
    checkWritten,

    /** An Answer's sentences with Citations, checked before it ends (./answerCheck). */
    checkAnswer,

    async checkSentences(input: unknown): Promise<CheckSentencesResult> {
      const parsed = parseCheck(input);
      options.requireMind(parsed.mindId);
      if (running.has(parsed.requestId)) {
        throw new InvalidInputError(`The check ${parsed.requestId} is already running.`);
      }
      const { within, plan } = parsed;
      const target =
        within && plan
          ? readTarget(
              parsed.mindId,
              [{ from: parsed.from, to: parsed.to }, ...parsed.more],
              parsed.part,
              within,
            ).sentences
          : null;
      const planned = () =>
        within !== null &&
        plan !== null &&
        target !== null &&
        wholeRead.planned(parsed.mindId, plan, within, target);
      if (within && !planned()) throw new InvalidInputError({ key: "error.check.pickReplaced" });
      const tracked = track(parsed.requestId, parsed.mindId);
      if (within) wholeReads.add(parsed.requestId);
      try {
        if (within) return await readSentences(parsed, within, planned, tracked.signal);
        return parsed.action === "contradiction-watch"
          ? await watch.checkSentences(parsed, tracked.signal)
          : await checkSentences(parsed, tracked.signal);
      } finally {
        wholeReads.delete(parsed.requestId);
        tracked.done();
      }
    },

    async planDocumentCheck(input: unknown): Promise<DocumentCheckPlan> {
      if (!isRecord(input)) throw new InvalidInputError("planDocumentCheck expects an object.");
      const mindId = parseMindId(input.mindId);
      options.requireMind(mindId);
      const within = parseWithin(input.within);
      const stretches = [
        { from: parsePlace(input.from, "from"), to: parsePlace(input.to, "to") },
        ...parseStretches(input.more),
      ];
      const target = readTarget(mindId, stretches, parsePart(input.part), within);
      // A newer pick replaces the read of the one before: it stops, and its result never lands.
      for (const requestId of wholeReads) {
        const run = running.get(requestId);
        if (run?.mindId === mindId) run.controller.abort();
      }
      return wholeRead.plan(mindId, within, parseModel(input.model), target);
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

    planMindCheck: async (mindId: unknown, mode: unknown, allDocuments?: unknown) =>
      mindCheck.planMindCheck(mindId, mode, allDocuments === true),

    holdMindCheck: (input: unknown) => mindCheck.holdMindCheck(input),
    forgetCheckWindow: (clientId: unknown) => mindCheck.forgetCheckWindow(clientId),

    findMindClaims: (input: unknown) => mindCheck.findMindClaims(input),
    checkMind: (input: unknown) => mindCheck.checkMind(input),
    documentsAddedSinceChecks: (mindId: unknown) => mindCheck.documentsAddedSinceChecks(mindId),

    /** A Document's status changed: a new version has its Folder's Minds checked for contradictions. */
    documentChanged: (document: Document) => watch.documentChanged(document),

    /** A Note joined a Folder: the background watch a change in the Folder's contents starts. */
    mindJoinedFolder: (mindId: string) => watch.mindJoinedFolder(mindId),

    /** Documents joined a Folder: its Notes' background watch, as for a new version there. */
    folderContentsChanged: (folderId: string) => watch.folderContentsChanged(folderId),

    /** Starts watching for new versions of Documents. */
    startWatching: () => watch.start(),

    async checkClaim(input: unknown): Promise<ClaimCheckResult> {
      const parsed = parseClaim(input);
      const ready = await prepare(parsed.model ?? options.defaultModel());
      if (!ready.ok) {
        const { result } = ready;
        if (result.kind === "not-ready") throw new ChatNotReadyError(result.readiness);
        throw new InvalidInputError({
          key: result.kind === "local-mode" ? "error.check.localMode" : "error.check.declined",
        });
      }
      const scope = options.evidence.scope(
        options.scopeDocuments(parsed.scope, null),
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
      return claimCheck({
        claim: parsed.claim,
        context: parsed.context,
        cited: citedNow(parsed.cited),
        scope,
        model: ready.prepared,
        // Reading the document being checked makes the Run third-party (#78).
        ...(checksDocument && { thirdParty: [{ via: "read", source: "checked-document" }] }),
        signal: new AbortController().signal,
      });
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
      // Resolved as the Mind's checks resolve theirs, so its wall bounds what a choice reads.
      const scope = options.evidence.scope(
        options.scopeDocuments(wanted, input.mindId),
        leftOutOf(input.mindId),
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
