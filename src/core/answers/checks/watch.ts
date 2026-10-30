/**
 * Contradiction watch (#112): a Mind's cited sentences, each checked against
 * the other Documents in its Folder, with the claim-check function.
 *
 * - A sentence is checked against the Folder's Documents but those it cites
 *   (and their versions and copies), and IncarnaMind's own files (#80).
 * - Only a contradiction is marked: a "contradiction-watch" `claimCheck` mark,
 *   whose card names the other Document and page. A sentence found otherwise
 *   loses any such mark; one the model couldn't check keeps its mark, saying
 *   why, or stays unmarked. Marks go "needs re-check" as #96's do.
 * - On demand, "Check for contradictions" checks every cited sentence of a
 *   Mind, and Check again on a mark checks its one sentence.
 * - A new version of a Document in a Folder starts the same check for each
 *   of the Folder's Minds, a moment later, in the background queue: Answers
 *   come first. It sends only once the User has allowed the "checks" flow for
 *   the model's service, never asks, respects the monthly cap, and records
 *   what it found and cost in the Mind (src/shared/contradictionWatch.ts).
 */
import { randomUUID } from "node:crypto";
import type * as Y from "yjs";
import { writeContradictionWatch } from "../../../shared/contradictionWatch";
import { beginFigureCheck } from "../../../shared/figureChecks";
import { mindModelOf } from "../../../shared/mindModel";
import { comparableSentence, isClaim } from "../../../shared/sentences";
import { judgesUnreliably } from "../../../shared/smallModel";
import type { Logger } from "../../adapters";
import type {
  ChatModelChoice,
  CheckContradictionsResult,
  CheckFigure,
  CheckSentencesResult,
  ClaimCheckAttributes,
  ClaimCheckResult,
  ContradictionCheckOutcome,
  ContradictionCheckPlan,
  Document,
  DocumentStatus,
  Money,
  RecordAiUseInput,
  RunStop,
  TextPlace,
  TextStretch,
  WatchStop,
} from "../../api";
import type { BackgroundQueue } from "../../backgroundQueue";
import type { EvidenceScope } from "../../documents/evidence";
import type { MindContent } from "../../mindContent";
import type { PreparedChatModel } from "../../providers/chat";
import type { RecordCitePlace } from "../../recordCites/referents";
import { currentTask } from "../../runs/current";
import { RunItemError, runItems } from "../../runs/stop";
import { type ClaimCheckRequest, recordJudged, runFailureOf } from "./claimCheck";
import { claimsAtOnce } from "./runChecks";
import {
  everySentence,
  keptAsView,
  markedSentences,
  markSentence,
  noteTextOf,
  type SelectedSentence,
  selectedSentences,
  unmarkSentence,
  updateCheck,
} from "./sentences";

const ACTION = "contradiction-watch";

/** A Document whose text is read: a new version of it can be searched. */
const READ: readonly DocumentStatus[] = ["waiting-for-model", "embedding", "ready"];

/** How long after a new version arrives its Folder's Minds are checked: more versions may follow. */
export const AFTER_NEW_VERSION_MS = 30_000;

/**
 * How long a background check of one claim may take. A request whose reply
 * never comes would otherwise hold the background queue for good (seen once
 * with GPT-6 Luna); no one is there to press Stop.
 */
export const CLAIM_TIME_LIMIT_MS = 3 * 60_000;

type Prepared =
  | { ok: true; prepared: PreparedChatModel }
  | {
      ok: false;
      result: Extract<CheckSentencesResult, { kind: "not-ready" | "local-mode" | "cancelled" }>;
    };

export interface WatchOptions {
  content: Pick<MindContent, "read" | "edit" | "readSettings" | "editSettings">;
  requireMind(mindId: string): void;
  /** The Folder the Mind is in; null for none. */
  mindFolder(mindId: string): string | null;
  /** The live Minds and their Folders. */
  minds(): { id: string; folderId: string | null }[];
  /** The live Documents in a Folder. */
  folderDocuments(folderId: string): string[];
  /**
   * The evidence a check of a Mind's sentence may use among `documentIds`:
   * the cited ones, and the file the Mind was imported from, left out.
   */
  evidenceScope(
    mindId: string,
    documentIds: readonly string[],
    citedIds: readonly string[],
  ): EvidenceScope;
  searchableCount(documentIds: readonly string[] | null): number;
  /** Every live Document's current version, for telling a new one when it arrives. */
  documentVersions(): ReadonlyMap<string, string>;
  defaultModel(): ChatModelChoice | null;
  modelInUse(own: ChatModelChoice | null): ChatModelChoice | null;
  /** The model to check with, or why not; the consent dialog shows before anything is sent. */
  prepare(choice: ChatModelChoice | null): Promise<Prepared>;
  /** The model, when it can be used now without asking the User anything; null otherwise. */
  prepareQuietly(choice: ChatModelChoice | null): Promise<PreparedChatModel | null>;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  withResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
    blocks: Y.XmlFragment,
    mindId: string,
    sourceText?: string,
  ): ClaimCheckAttributes;
  retainEvidence(mindId: string): void;
  recordAiUse(inputs: RecordAiUseInput[]): void;
  track(requestId: string, mindId: string): { signal: AbortSignal; done(): void };
  background: Pick<BackgroundQueue, "add">;
  /** What a run's requests billed per token cost; null when none was priced. */
  runCost(runId: string): Money | null;
  /** How long after a new version its Folder's Minds are checked, in ms (`AFTER_NEW_VERSION_MS`). */
  delayMs: number;
  /** How long a background check of one claim may take, in ms (`CLAIM_TIME_LIMIT_MS`). */
  claimTimeLimitMs: number;
  log: Logger;
  now(): Date;
}

/** A cited sentence to check: where it is, and the Documents it may be checked against. */
interface Claim {
  blockId: string;
  place: RecordCitePlace;
  text: string;
  /** The sentence as the Note holds it, its Citations included: what its record cites read. */
  noteText: string;
  context: string;
  scope: EvidenceScope;
  figures?: CheckFigure[];
  projection?: ClaimCheckRequest["projection"];
}

type Plan =
  | { kind: "ready"; folderId: string; claims: Claim[] }
  | Exclude<ContradictionCheckPlan, { kind: "ready" }>;

const citedIdsOf = (sentence: SelectedSentence) => [
  ...new Set(sentence.cited.flatMap((each) => (each.documentId ? [each.documentId] : []))),
];

export function createContradictionWatch(options: WatchOptions) {
  const { content } = options;

  /** What a check of the Mind's cited sentences (or those `stretches` touch) would check. */
  function plan(mindId: string, stretches?: readonly TextStretch[]): Plan {
    const folderId = options.mindFolder(mindId);
    const read = content.read(mindId, (blocks) => {
      if (!stretches) {
        const marks = markedSentences(blocks);
        const sentences = everySentence(blocks).filter((each) => !keptAsView(marks, each));
        return { ok: true as const, sentences };
      }
      return selectedSentences(blocks, stretches);
    });
    if (!read.ok) return { kind: read.reason };
    const cited = read.sentences.filter(
      (sentence) => sentence.cited.length > 0 && isClaim(sentence.text),
    );
    if (cited.length === 0) return { kind: "nothing" };
    if (folderId === null) return { kind: "no-folder" };
    const inFolder = options.folderDocuments(folderId);
    if (options.searchableCount(options.evidenceScope(mindId, inFolder, []).documentIds) === 0) {
      return { kind: "no-documents", folderId };
    }
    const claims = cited.flatMap((sentence): Claim[] => {
      const scope = options.evidenceScope(mindId, inFolder, citedIdsOf(sentence));
      if (options.searchableCount(scope.documentIds) === 0) return [];
      return [
        {
          blockId: sentence.blockId,
          place: { blockId: sentence.blockId, from: sentence.from },
          text: sentence.text,
          noteText: noteTextOf(sentence),
          context: sentence.context,
          scope,
          ...(sentence.figures?.length && { figures: sentence.figures }),
          ...(sentence.projection && { projection: sentence.projection }),
        },
      ];
    });
    if (claims.length === 0) return { kind: "only-cited", folderId };
    return { kind: "ready", folderId, claims };
  }

  /**
   * Writes a claim's result: a contradiction's mark, in place of any check
   * there; otherwise any watch mark goes, or, if the model couldn't check it,
   * says why. False when the sentence has changed or gone meanwhile.
   */
  function write(
    mindId: string,
    request: string,
    folderId: string,
    claim: Claim,
    result: ClaimCheckResult,
    prepared: PreparedChatModel,
  ) {
    const at = options.now().toISOString();
    recordJudged(options.recordAiUse, mindId, prepared, result, at);
    const kept = content.edit(mindId, (blocks) => {
      const sentence = everySentence(blocks).find(
        (each) => each.blockId === claim.blockId && each.text === claim.text,
      );
      if (!sentence) return false;
      if (result.verdict === "not-checked") {
        const marked = markedSentences(blocks).find(
          ({ element, from, to, check }) =>
            check.action === ACTION &&
            element === sentence.element &&
            from < sentence.to &&
            to > sentence.from,
        );
        if (marked)
          updateCheck(blocks, marked.check.id, (check) =>
            options.withResult(check, result, at, blocks, mindId, claim.text),
          );
        return Boolean(marked);
      }
      if (result.verdict !== "contradicted") {
        unmarkSentence(sentence.element, sentence.from, sentence.to, ACTION);
        return true;
      }
      const check: ClaimCheckAttributes = {
        id: randomUUID(),
        request,
        action: ACTION,
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
        scope: { folderId, widened: false },
        versions: [],
        excluded: [],
        checkedAt: at,
      };
      // Each figure keeps its own result, as the one Check gives it.
      const pending = sentence.figures?.length
        ? beginFigureCheck(null, check, sentence.figures, null, sentence.projection)
        : check;
      markSentence(
        sentence.element,
        sentence.from,
        sentence.to,
        options.withResult(pending, result, at, blocks, mindId, claim.text),
      );
      return true;
    });
    if (kept) options.retainEvidence(mindId);
    return kept;
  }

  /** Checks the claims, writing each result as it comes; `concurrency` at a time. */
  async function check(
    mindId: string,
    request: string,
    ready: Extract<Plan, { kind: "ready" }>,
    prepared: PreparedChatModel,
    signal: AbortSignal,
  ): Promise<ContradictionCheckOutcome> {
    const runId = randomUUID();
    let checked = 0;
    let contradicted = 0;
    const { stop } = await runItems(
      ready.claims,
      (claim) =>
        currentTask.run(runId, async () => {
          const result = await options.claimCheck({
            claim: claim.projection?.text ?? comparableSentence(claim.text),
            ...(claim.projection && { projection: claim.projection }),
            recordClaim: claim.noteText,
            context: claim.context,
            scope: claim.scope,
            ...(claim.figures && { figures: claim.figures }),
            model: prepared,
            mindId,
            place: claim.place,
            cacheKey: mindId,
            signal,
          });
          const failure = runFailureOf(result);
          if (failure) throw new RunItemError(failure);
          return result;
        }),
      {
        concurrency: claimsAtOnce(prepared),
        signal,
        onOutcome(claim, outcome) {
          if (outcome.status !== "done" || signal.aborted) return;
          const result = outcome.value;
          if (result.verdict !== "not-checked") checked++;
          if (result.verdict === "contradicted") contradicted++;
          write(mindId, request, ready.folderId, claim, result, prepared);
        },
      },
    );
    return {
      claims: ready.claims.length,
      checked,
      contradicted,
      cost: options.runCost(runId),
      stop,
      smallModel: judgesUnreliably(prepared),
    };
  }

  const modelOf = (mindId: string): ChatModelChoice | null =>
    options.modelInUse(
      content.readSettings(mindId, (settings) => (settings.doc ? mindModelOf(settings.doc) : null)),
    );

  // In the background ---------------------------------------------------------------------------

  /** Each live Document's version as last seen: a different one read is a new version. */
  let versions: Map<string, string> | null = null;
  /** Minds waiting to be watched after a change in their Folder, with the Document that started it. */
  const waiting = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; documentName: string | null }
  >();
  let closed = false;

  /**
   * The Folder's contents changed: these of its Notes are watched again a
   * moment later, in the background queue. A Note already waiting is watched
   * once, for the change that came last.
   */
  function contentsChanged(
    minds: readonly { mindId: string; documentName: string | null }[],
  ): void {
    if (closed) return;
    for (const { mindId, documentName } of minds) {
      const queued = waiting.get(mindId);
      if (queued) clearTimeout(queued.timer);
      const timer = setTimeout(() => {
        waiting.delete(mindId);
        checkInBackground(mindId, documentName).catch((error: unknown) => {
          options.log.error("contradictions.backgroundFailed", { error: nameOf(error) });
        });
      }, options.delayMs);
      // A check waiting doesn't keep IncarnaMind from quitting.
      timer.unref();
      waiting.set(mindId, { timer, documentName });
    }
  }

  /** The Folder's contents changed: each Note in it is watched again, a moment later. */
  function watchFolder(folderId: string, documentName: string | null): void {
    contentsChanged(
      options
        .minds()
        .flatMap((mind) => (mind.folderId === folderId ? [{ mindId: mind.id, documentName }] : [])),
    );
  }

  /** Queues each claim of the Mind as a background job, and records the run once all are done. */
  async function checkInBackground(mindId: string, documentName: string | null): Promise<void> {
    if (closed) return;
    const ready = plan(mindId);
    if (ready.kind !== "ready") return;
    const prepared = await options.prepareQuietly(modelOf(mindId));
    if (!prepared || closed) return;
    const runId = randomUUID();
    const request = randomUUID();
    let left = ready.claims.length;
    let checked = 0;
    let contradicted = 0;
    let stop: RunStop | null = null;
    const record = (end: WatchStop | null) => {
      try {
        options.requireMind(mindId);
        content.editSettings(mindId, (settings) =>
          writeContradictionWatch(settings, {
            at: options.now().toISOString(),
            documentName,
            claims: ready.claims.length,
            checked,
            contradicted,
            cost: options.runCost(runId),
            stop: end,
            smallModel: judgesUnreliably(prepared),
          }),
        );
      } catch (error) {
        options.log.error("contradictions.recordFailed", { error: nameOf(error) });
      }
    };
    const finish = () => {
      if (--left > 0) return;
      record(stop);
    };
    for (const claim of ready.claims) {
      options.background.add({
        kind: ACTION,
        async run(call) {
          try {
            if (stop || closed) return;
            if (!prepared.provider.service) call.runsLocally();
            const timedOut = AbortSignal.timeout(options.claimTimeLimitMs);
            const ended = AbortSignal.any([call.signal, timedOut]);
            // A reply that never comes, even once aborted, is given up on all the same.
            const givenUp = new Promise<null>((resolve) =>
              ended.addEventListener("abort", () => resolve(null), { once: true }),
            );
            const checking = currentTask.run(runId, () =>
              options.claimCheck({
                claim: claim.projection?.text ?? comparableSentence(claim.text),
                ...(claim.projection && { projection: claim.projection }),
                ...(claim.figures && { figures: claim.figures }),
                recordClaim: claim.noteText,
                context: claim.context,
                scope: claim.scope,
                model: prepared,
                mindId,
                place: claim.place,
                cacheKey: mindId,
                signal: ended,
              }),
            );
            const replied = await Promise.race([checking, givenUp]);
            // Given way to an Answer, it runs again later; closing, it never does.
            if (call.signal.aborted) return;
            const result: ClaimCheckResult =
              replied === null || timedOut.aborted
                ? {
                    verdict: "not-checked",
                    reason: "failed",
                    detail: `No reply within ${Math.round(options.claimTimeLimitMs / 1000)} seconds.`,
                    versions: [],
                    excluded: [],
                  }
                : replied;
            const failure = runFailureOf(result);
            if (failure?.kind === "cost-cap") stop = { reason: "cost-cap" };
            else if (failure?.kind === "plan-limit")
              stop = { reason: "plan-limit", resetsAt: null };
            else {
              if (result.verdict !== "not-checked") checked++;
              if (result.verdict === "contradicted") contradicted++;
              options.requireMind(mindId);
              write(mindId, request, ready.folderId, claim, result, prepared);
            }
          } finally {
            // A run that gives way or closes ends without finishing: its record says so, so a
            // scoped Check never stands on it (#1941).
            if (call.signal.aborted || closed) record(stop ?? { reason: "cancelled" });
            else finish();
          }
        },
      });
    }
  }

  return {
    /** See `CoreApi.planContradictionCheck`. */
    planContradictionCheck(mindId: string): ContradictionCheckPlan {
      options.requireMind(mindId);
      const ready = plan(mindId);
      if (ready.kind !== "ready") return ready;
      return { kind: "ready", claims: ready.claims.length, model: modelOf(mindId) };
    },

    /** See `CoreApi.checkContradictions`. */
    async checkContradictions(input: {
      requestId: string;
      mindId: string;
      model: ChatModelChoice | null;
    }): Promise<CheckContradictionsResult> {
      const { requestId, mindId } = input;
      const ready = plan(mindId);
      if (ready.kind !== "ready") return ready;
      const model = await options.prepare(input.model ?? modelOf(mindId));
      if (!model.ok) return model.result;
      const tracked = options.track(requestId, mindId);
      try {
        const outcome = await check(mindId, requestId, ready, model.prepared, tracked.signal);
        // A full watch, so the next Check knows every cited sentence has been watched, and how
        // this one ended (#1941). No Document started it: the card shows no "changed" line. One
        // the User stopped says so: it can never stand for a watched Note.
        content.editSettings(mindId, (settings) =>
          writeContradictionWatch(settings, {
            at: options.now().toISOString(),
            documentName: null,
            claims: outcome.claims,
            checked: outcome.checked,
            contradicted: outcome.contradicted,
            cost: outcome.cost,
            stop: tracked.signal.aborted ? { reason: "cancelled" } : outcome.stop,
            smallModel: outcome.smallModel,
          }),
        );
        if (tracked.signal.aborted) return { kind: "cancelled" };
        return { kind: "checked", ...outcome };
      } finally {
        tracked.done();
      }
    },

    /** Check again on a watch mark: the cited sentences `from`..`to` touches, as `checkSentences` does. */
    async checkSentences(
      input: {
        requestId: string;
        mindId: string;
        from: TextPlace;
        to: TextPlace;
        more?: readonly TextStretch[];
        model: ChatModelChoice | null;
      },
      signal: AbortSignal,
    ): Promise<CheckSentencesResult> {
      const ready = plan(input.mindId, [{ from: input.from, to: input.to }, ...(input.more ?? [])]);
      if (ready.kind !== "ready") return ready;
      const model = await options.prepare(input.model ?? options.defaultModel());
      if (!model.ok) return model.result;
      const outcome = await check(input.mindId, input.requestId, ready, model.prepared, signal);
      if (signal.aborted) return { kind: "cancelled" };
      return {
        kind: "checked",
        sentences: outcome.claims,
        checked: outcome.checked,
        smallModel: outcome.smallModel,
      };
    },

    /**
     * Hears each Document's status: a Document added to a Folder, or a new
     * version of one there, has that Folder's Minds watched a moment later, in
     * the background. A Document leaving a Folder, by deletion or by a move,
     * cannot add a contradiction, so it starts nothing.
     */
    documentChanged(document: Document): void {
      if (closed) return;
      versions ??= new Map(options.documentVersions());
      if (!READ.includes(document.status)) return;
      const before = versions.get(document.id);
      // One this watch has never seen was added while IncarnaMind runs: wait until it can be
      // searched, so the run reads it. A version that changes is read already.
      if (before === undefined && document.status !== "ready") return;
      versions.set(document.id, document.contentHash);
      if (before === document.contentHash) return;
      // An added Document changed nothing, so the run names none.
      const documentName = before === undefined ? null : document.name;
      const folders = new Set(
        options.minds().flatMap((mind) => (mind.folderId === null ? [] : [mind.folderId])),
      );
      for (const folderId of folders) {
        if (options.folderDocuments(folderId).includes(document.id)) {
          watchFolder(folderId, documentName);
        }
      }
    },

    /** A Note joined a Folder: the same watch a Document's new version starts, for that Note. */
    mindJoinedFolder(mindId: string): void {
      contentsChanged([{ mindId, documentName: null }]);
    },

    /** Documents joined a Folder: its Notes are watched again, as for any change in it. */
    folderContentsChanged(folderId: string): void {
      watchFolder(folderId, null);
    },

    /** Seeds the versions known now, so the first change after start-up counts. */
    start(): void {
      versions ??= new Map(options.documentVersions());
    },

    close(): void {
      closed = true;
      for (const { timer } of waiting.values()) clearTimeout(timer);
      waiting.clear();
    },
  };
}

const nameOf = (error: unknown) => (error instanceof Error ? error.name : "unknown");
