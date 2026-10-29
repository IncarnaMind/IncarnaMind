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
import { restsOn } from "../../../shared/claimChecks";
import {
  beginFigureCheck,
  readFigureFinding,
  settleFigureCheck,
} from "../../../shared/figureChecks";
import { mindScopeIn } from "../../../shared/mindScope";
import { folderScope, oneFolderOf } from "../../../shared/searchScope";
import { judgesUnreliably } from "../../../shared/smallModel";
import { recordCheckUnread } from "../../../shared/unreadFiles";
import {
  type ChatModelChoice,
  type ChatReadiness,
  type CheckContradictionsResult,
  type CheckedDocument,
  type CheckSentencesResult,
  type CitationAttributes,
  type CitedQuote,
  type ClaimCheckAction,
  type ClaimCheckAttributes,
  type ClaimCheckBasis,
  type ClaimCheckResult,
  type ClaimCheckScope,
  type ClaimJudgment,
  type ContradictionCheckPlan,
  claimCheckActions,
  type Document,
  type ExternalService,
  type SearchScope,
  type TextPlace,
  type TextStretch,
  type UnreadFile,
  type UnsupportedReason,
} from "../../api";
import type { Consent } from "../../consent";
import type { Evidence } from "../../documents/evidence";
import { parseCheckedDocument } from "../../documents/evidence";
import type { RetainVersion, VersionRetention } from "../../documents/retention";
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
import { parseSearchScope } from "../../scope";
import type { AnswerEngine } from "../engine";
import {
  type CheckedCitation,
  type ClaimCheckDependencies,
  createClaimCheck,
  recordJudged,
} from "./claimCheck";
import { createMindCheck, type MindCheckOptions } from "./mindCheck";
import {
  markedSentences as allMarks,
  checkText,
  citedQuoteOf,
  markedSentences,
  markSentence,
  selectedSentences,
  updateCheck,
} from "./sentences";
import { createVerify, type NoDocuments, type VerifyOptions } from "./verify";
import { createContradictionWatch, type WatchOptions } from "./watch";
import { createWrittenCheck, type WrittenCheckOptions } from "./written";

/**
 * What the "checks" flow sends: the sentences checked, with their paragraphs,
 * the Passages found, a verified document's sentences, to find its claims
 * (#97), and a Mind's sentences when the whole Mind is checked (#737).
 */
export const CHECKS_FLOW_SENDS = ["selection", "passages", "verified-document", "blocks"] as const;

/** The longest claim one check takes, in characters: a sentence, not a page. */
const MAX_CLAIM_CHARACTERS = 2_000;

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
  /** What a check from a Mind searches, by the one rule (`mindSearchScope`); null: every Document. */
  searchedScope(scope: SearchScope | null, mindId: string): SearchScope | null;
  /** The file a Mind was imported from (#720), which its own checks never use as evidence. */
  originalOf(mindId: string): CheckedDocument | null;
  /** The default chat model, used when the Mind has none of its own. */
  defaultModel(): ChatModelChoice | null;
  /** The model a Mind whose own pick is `own` is checked with: see `modelInUse`. */
  modelInUse(own: ChatModelChoice | null): ChatModelChoice | null;
  chat: {
    readiness(choice: ChatModelChoice | undefined, flow: "checks"): Promise<ChatReadiness>;
    prepareModel(choice: ChatModelChoice | undefined, flow: "checks"): Promise<PreparedChatModel>;
    /** The service the default chat model sends to; null with none, or one on this computer. */
    defaultService(): ExternalService | null;
  };
  consent: Consent;
  /** Local mode: only models on this computer. */
  localOnly(): boolean;
  resolveScope(scope: SearchScope): string[] | null;
  /** The Documents a Search scope covers; with none, the User's own (`scopeDocuments`). */
  scopeDocuments(scope: SearchScope | null, mindId: string | null): string[] | null;
  evidence: Pick<Evidence, "scope" | "search">;
  documents: ClaimCheckDependencies["documents"] &
    MindCheckOptions["documents"] & {
      /** Every live Document's names: what the Citations a sentence already has are named by. */
      names(): readonly LiveDocument[];
    };
  engine: AnswerEngine;
  retention: Pick<VersionRetention, "retain">;
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
  model: ChatModelChoice | null;
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
  return {
    requestId,
    mindId: parseMindId(input.mindId),
    from: parsePlace(input.from, "from"),
    to: parsePlace(input.to, "to"),
    more: parseStretches(input.more),
    action: known,
    allDocuments: input.allDocuments === true,
    model: parseModel(input.model),
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
  };

const withQuoted = ({ quoted, ...why }: UnsupportedReason): UnsupportedReason => {
  const kept = quoted ? evidenceOf(quoted) : null;
  return kept ? { ...why, quoted: kept } : why;
};

/** A result written onto its mark. */
function withJudgment(check: ClaimCheckBasis, result: ClaimJudgment, at: string): ClaimCheckBasis {
  const common = { versions: result.versions, excluded: result.excluded, checkedAt: at };
  return result.verdict === "not-checked"
    ? { ...check, ...common, state: "not-checked", reason: result.reason, detail: result.detail }
    : {
        ...check,
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
      };
}

function withResult(
  check: ClaimCheckAttributes,
  result: ClaimCheckResult,
  at: string,
): ClaimCheckAttributes {
  const { figures: _figures, remainder: _remainder, ...basis } = check;
  const next = withJudgment(basis, result, at);
  if (!result.figures)
    return check.figures
      ? settleFigureCheck(check, (child) =>
          result.verdict === "not-checked"
            ? withJudgment(child, result, at)
            : { ...child, state: "not-checked", reason: "malformed", detail: null, checkedAt: at },
        )
      : next;
  const figures = result.figures.flatMap((figure) => {
    const finding = readFigureFinding(figure);
    return finding
      ? [{ ...withJudgment({ ...basis, id: finding.id }, figure.result, at), ...finding }]
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
            : withJudgment({ ...basis, id: `${basis.id}:remainder` }, result.remainder, at),
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
                : withJudgment(check.remainder ?? basis, result.remainder, at),
          }
      : check.remainder === undefined
        ? {}
        : { remainder: check.remainder }),
  };
}

const stopped = (check: ClaimCheckAttributes): ClaimCheckAttributes =>
  settleFigureCheck(check, (basis) => ({ ...basis, state: "not-checked", reason: "stopped" }));

export function createChecks(options: ChecksOptions) {
  const { content, chat } = options;

  function noteResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
    blocks: Y.XmlFragment,
    mindId: string,
  ): ClaimCheckAttributes {
    return withResult(
      check,
      augmentFigureFooting(blocks, result, options.documents, {
        versions: options.watch.documentVersions(),
        folderId: options.mindFolder(mindId),
        scope: content.readSettings(mindId, mindScopeIn),
      }),
      at,
    );
  }
  /** The requests running, by id: how to stop each, and its Mind. */
  const running = new Map<string, { controller: AbortController; mindId: string }>();
  const claimCheck = createClaimCheck(options);

  options.consent.registry.register({
    id: "checks",
    sends: CHECKS_FLOW_SENDS,
    async services() {
      const service = chat.defaultService();
      return service ? [service] : [];
    },
  });

  /** The model to check with, or why there is none; the consent dialog shows before anything is sent. */
  async function prepare(choice: ChatModelChoice | null): Promise<
    | { ok: true; prepared: PreparedChatModel }
    | {
        ok: false;
        result: Extract<CheckSentencesResult, { kind: "not-ready" | "local-mode" | "cancelled" }>;
      }
  > {
    const readiness = await chat.readiness(choice ?? undefined, "checks");
    if (!readiness.ready) return { ok: false, result: { kind: "not-ready", readiness } };
    if (readiness.provider.service && options.localOnly()) {
      return { ok: false, result: { kind: "local-mode" } };
    }
    try {
      return { ok: true, prepared: await chat.prepareModel(choice ?? undefined, "checks") };
    } catch (error) {
      if (error instanceof ChatNotReadyError) {
        return { ok: false, result: { kind: "not-ready", readiness: error.readiness } };
      }
      if (error instanceof LocalModeError) return { ok: false, result: { kind: "local-mode" } };
      if (error instanceof ConsentDeclinedError) {
        const now = await chat.readiness(choice ?? undefined, "checks");
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
    const versions = content.read(mindId, (blocks) =>
      markedSentences(blocks).flatMap(({ check }): RetainVersion[] =>
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
      ),
    );
    options.retention.retain("check-result", mindId, versions);
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
    const wanted = allDocuments ? null : options.searchedScope(chosen ?? folderScope(own), mindId);
    const folderId = oneFolderOf(wanted);
    const inChosen = chosen !== null && wanted !== null && (own === null || folderId !== own);
    // An own Folder that holds no Document searches everything, as "Search all Documents" does.
    const marked: ClaimCheckScope = inChosen
      ? { folderId: own, widened: false, chosen: wanted }
      : { folderId: own, widened: allDocuments || own !== folderId };
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

  async function checkSentences(
    input: ParsedCheck,
    signal: AbortSignal,
  ): Promise<CheckSentencesResult> {
    const { mindId } = input;
    const stretches = [{ from: input.from, to: input.to }, ...input.more];
    const read = content.read(mindId, (blocks) => selectedSentences(blocks, stretches));
    if (!read.ok) return { kind: read.reason };

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
      const marked = again.sentences.map((sentence) => {
        const check: ClaimCheckAttributes = {
          id: randomUUID(),
          request: input.requestId,
          action: input.action,
          state: "checking",
          reason: null,
          detail: null,
          providerId: ready.prepared.provider.id,
          modelId: ready.prepared.modelId,
          text: sentence.text,
          evidence: null,
          says: null,
          unsupported: null,
          calculation: null,
          citedCaseUnchecked: false,
          citedCaseFound: false,
          scope,
          versions: [],
          excluded: [],
          checkedAt: startedAt,
        };
        const previous =
          allMarks(blocks).find(
            (mark) =>
              mark.element === sentence.element &&
              mark.from < sentence.to &&
              mark.to > sentence.from,
          )?.check ?? null;
        const pending = sentence.figures?.length
          ? beginFigureCheck(previous, check, sentence.figures, null)
          : check;
        markSentence(sentence.element, sentence.from, sentence.to, pending);
        return {
          id: check.id,
          ...checkText(sentence),
          cited: sentence.cited,
        };
      });
      if (marked.length > 0) recordUnread(blocks, input.requestId, unread);
      return marked;
    });
    if (queued.length === 0) {
      return waiting.sentences.length > 0 ? { kind: "waiting", waiting } : { kind: "nothing" };
    }

    let checked = 0;
    for (const sentence of queued) {
      if (signal.aborted) break;
      const result = await claimCheck({
        claim: sentence.claim,
        context: sentence.context,
        ...(sentence.figures && { figures: sentence.figures }),
        cited: citedNow(sentence.cited),
        scope: evidenceScope,
        model: ready.prepared,
        cacheKey: mindId,
        signal,
      });
      if (signal.aborted) break;
      if (result.verdict !== "not-checked") checked++;
      const at = options.now().toISOString();
      recordJudged(options.recordAiUse, mindId, ready.prepared, result, at);
      const kept = content.edit(mindId, (blocks) =>
        updateCheck(blocks, sentence.id, (check) => noteResult(check, result, at, blocks, mindId)),
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
    claimCheck,
    withResult,
    retainEvidence,
    track,
  });

  const verify = createVerify({
    ...options,
    prepare,
    evidenceScope: (mindId, allDocuments, verification) =>
      scopeOf(mindId, allDocuments, { documentIds: [verification.documentId] }),
    claimCheck,
    withResult,
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

  return {
    ...verify,

    /** What the assistant wrote in a Mind, checked before it lands (./written). */
    checkWritten,

    async checkSentences(input: unknown): Promise<CheckSentencesResult> {
      const parsed = parseCheck(input);
      options.requireMind(parsed.mindId);
      if (running.has(parsed.requestId)) {
        throw new InvalidInputError(`The check ${parsed.requestId} is already running.`);
      }
      const tracked = track(parsed.requestId, parsed.mindId);
      try {
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

    planMindCheck: async (mindId: unknown, mode: unknown, allDocuments?: unknown) =>
      mindCheck.planMindCheck(mindId, mode, allDocuments === true),

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
        return {
          verdict: "unsupported",
          evidence: null,
          says: null,
          unsupported: null,
          calculation: null,
          citedCaseUnchecked: caseCitations(parsed.claim).length > 0,
          citedCaseFound: false,
          versions: [],
          excluded: [],
        };
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

    /** Stops a request: its sentences not checked yet are marked "stopped". */
    cancel(requestId: string): void {
      running.get(requestId)?.controller.abort();
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
