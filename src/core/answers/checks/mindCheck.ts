/**
 * Check this Mind (#737): every sentence of a Mind that makes a claim,
 * checked in one run, as Verify checks someone else's PDF (#97).
 *
 * 1. The Mind's sentences are read, as for note health: those in paragraphs,
 *    lists, quotes and Answers, not headings or Questions, nor those the User
 *    keeps as their own view (#1111).
 * 2. The model names the claims among them, leaving out questions and the
 *    User's own opinions (./findClaims), before the run is asked for, so its
 *    estimate counts them (`findMindClaims`), and only once. In "changed"
 *    mode it is shown only the sentences never checked since the last run,
 *    and the checks that need a re-check, or that couldn't be made, are made
 *    again without asking it; with none of those, nothing is sent and the
 *    plan says so (`unchanged`). "All" mode checks every marked sentence
 *    again, and names claims only among the sentences never marked or
 *    skipped. In "added" mode only the checks that Documents added since
 *    could change are made again, each in the scope it used (#993).
 * 3. Each claim gets a "checking" mark at once, then its result, as Check
 *    against Documents gives it (./runChecks).
 * 4. The run is recorded in the Mind's settings (`MindCheckRun`): when, how
 *    many sentences have a check, and which sentences make no claim, so the
 *    next run doesn't send them again.
 */
import { randomUUID } from "node:crypto";
import {
  addedCouldChange,
  checkedSentence,
  claimCheckShown,
  restsOn,
} from "../../../shared/claimChecks";
import { beginFigureCheck } from "../../../shared/figureChecks";
import { readMindCheck, sentenceKey, writeMindCheck } from "../../../shared/mindCheck";
import { mindModelOf } from "../../../shared/mindModel";
import { mindScopeIn } from "../../../shared/mindScope";
import { oneFolderOf } from "../../../shared/searchScope";
import { isClaim } from "../../../shared/sentences";
import { judgesUnreliably } from "../../../shared/smallModel";
import type {
  ChatModelChoice,
  CheckMindMode,
  CheckMindResult,
  CitedQuote,
  ClaimCheckAttributes,
  DocumentsAddedSince,
  FindMindClaimsResult,
  MindCheckPlan,
} from "../../api";
import { parseModel } from "../../edits";
import { InvalidInputError, isRecord } from "../../errors";
import type { MindContent } from "../../mindContent";
import { parseMindId } from "../../minds";
import type { PreparedChatModel } from "../../providers/chat";
import type { CheckedCitation } from "./claimCheck";
import { inTableCell } from "./figureOccurrences";
import { type ClaimsFound, claimsAmong } from "./findClaims";
import { type QueuedClaim, type RunChecksOptions, runChecks } from "./runChecks";
import {
  checkedSentences,
  checkText,
  everySentence,
  figuresNow,
  keptAsView,
  markedSentences,
  markSentence,
  type SelectedSentence,
} from "./sentences";
import type { MindCheckScope, VerifyOptions } from "./verify";

export interface MindCheckOptions extends RunChecksOptions {
  content: Pick<MindContent, "read" | "edit" | "readSettings" | "editSettings">;
  modelInUse(own: ChatModelChoice | null): ChatModelChoice | null;
  prepare: VerifyOptions["prepare"];
  unread: VerifyOptions["unread"];
  recordUnread: VerifyOptions["recordUnread"];
  scopeOf(mindId: string, allDocuments: boolean): MindCheckScope;
  /** The Folder the Mind is in; null for none. */
  mindFolder(mindId: string): string | null;
  /** What the Citations quote, each Document named as it is now. */
  citedNow(cited: readonly CitedQuote[]): CheckedCitation[];
  /** Each live Document's version now, for which checks need a re-check. */
  documentVersions(): ReadonlyMap<string, string>;
  documents: {
    /**
     * The live Documents with Passages to search, of these (null: of all), that joined after
     * `since`: added then, or, with `folderId`, filed into that Folder then.
     */
    joinedAfter(
      documentIds: readonly string[] | null,
      since: string,
      folderId: string | null,
    ): { id: string; joinedAt: string }[];
  };
  settleStopped(mindId: string, request: string): void;
  track(requestId: string, mindId: string): { signal: AbortSignal; done(): void };
  isRunning(requestId: string): boolean;
  /** Throws unless the Mind exists and this version may write to it. */
  requireMind(mindId: string): void;
}

const MODES: readonly CheckMindMode[] = ["all", "changed", "added"];

function parseCheckMind(input: unknown) {
  if (!isRecord(input)) throw new InvalidInputError({ key: "error.mindCheck.request" });
  const { requestId } = input;
  if (typeof requestId !== "string" || requestId === "") {
    throw new InvalidInputError({ key: "error.mindCheck.request" });
  }
  let figureIds: string[] | null = null;
  if (input.figureIds !== undefined) {
    if (
      !Array.isArray(input.figureIds) ||
      input.figureIds.length === 0 ||
      !input.figureIds.every((id): id is string => typeof id === "string" && id !== "") ||
      new Set(input.figureIds).size !== input.figureIds.length
    )
      throw new InvalidInputError({ key: "error.mindCheck.request" });
    figureIds = input.figureIds;
  }
  return {
    requestId,
    figureIds,
    mindId: parseMindId(input.mindId),
    mode: parseMode(input.mode),
    allDocuments: input.allDocuments === true,
    model: parseModel(input.model),
  };
}

function parseMode(mode: unknown): CheckMindMode {
  const known = MODES.find((each) => each === mode);
  if (!known) throw new InvalidInputError({ key: "error.mindCheck.request" });
  return known;
}

/** What a run sends: sentences to find the claims among, and sentences whose checks are made again. */
interface Sending {
  fresh: SelectedSentence[];
  again: SelectedSentence[];
  /** Every sentence that could make a claim now, by key: what the run's skipped list keeps to. */
  keys: Set<string>;
  skipped: Set<string>;
  /** In "added" mode, the checks to make again in every Document, as they were made. */
  widened: Set<SelectedSentence>;
  /** In "changed" mode, when each check that still holds was made. */
  held: string[];
}

export function createMindCheck(options: MindCheckOptions) {
  /**
   * The Note each Check request keeps from its planning until it runs or is dropped, and the
   * window that keeps it (#2240).
   */
  const checking = new Map<string, { requestId: string; clientId: string | null }>();
  const { content } = options;

  const release = (requestId: string) => {
    for (const [mindId, held] of checking)
      if (held.requestId === requestId) checking.delete(mindId);
  };

  const modelOf = (mindId: string): ChatModelChoice | null =>
    options.modelInUse(
      content.readSettings(mindId, (settings) => (settings.doc ? mindModelOf(settings.doc) : null)),
    );

  /**
   * What the model named among each Mind's sentences, by key: the ask before
   * a run counts the claims exactly, and neither Check nor a later run sends a
   * sentence to be sorted again (#973).
   */
  const sorted = new Map<string, { claims: Set<string>; left: Set<string> }>();

  async function sort(
    mindId: string,
    fresh: readonly SelectedSentence[],
    prepared: PreparedChatModel,
    signal: AbortSignal,
  ): Promise<
    | {
        kind: "found";
        claims: SelectedSentence[];
        left: SelectedSentence[];
        /** Sentences no reply decided: they stay to check, and the next run asks about them again. */
        undecided: SelectedSentence[];
      }
    | Exclude<ClaimsFound, { kind: "found" }>
  > {
    const known = sorted.get(mindId) ?? { claims: new Set<string>(), left: new Set<string>() };
    sorted.set(mindId, known);
    for (const sentence of fresh) {
      if (sentence.figures?.length) known.claims.add(sentenceKey(sentence.text));
    }
    const unsorted = fresh.filter((sentence) => {
      const key = sentenceKey(sentence.text);
      return !known.claims.has(key) && !known.left.has(key);
    });
    if (unsorted.length > 0) {
      const found = await claimsAmong(
        prepared,
        unsorted.map((sentence) => checkText(sentence).claim),
        "own",
        signal,
      );
      if (found.kind !== "found") return found;
      for (const [index, sentence] of unsorted.entries()) {
        const key = sentenceKey(sentence.text);
        // The same words twice are one sentence to the run: named a claim once, it is checked.
        if (found.claims.has(index)) {
          known.claims.add(key);
          known.left.delete(key);
        } else if (!found.undecided.has(index) && !known.claims.has(key)) known.left.add(key);
      }
    }
    const decided = (sentence: SelectedSentence, as: Set<string>) =>
      as.has(sentenceKey(sentence.text));
    return {
      kind: "found",
      claims: fresh.filter((sentence) => decided(sentence, known.claims)),
      left: fresh.filter((sentence) => decided(sentence, known.left)),
      undecided: fresh.filter(
        (sentence) => !decided(sentence, known.claims) && !decided(sentence, known.left),
      ),
    };
  }

  function addedSince(mindId: string): Map<string, string[]> {
    const versions = options.documentVersions();
    const folderId = options.mindFolder(mindId);
    const scope = content.readSettings(mindId, mindScopeIn);
    const changeable = content.read(mindId, (blocks) => {
      const { figureContexts, figured } = figuresNow(blocks);
      return checkedSentences(blocks).flatMap((marked) =>
        addedCouldChange(
          marked.check,
          claimCheckShown(marked.check, {
            text: marked.sentence,
            versions,
            folderId,
            scope,
            figureContexts,
            figured: figured(marked),
          }),
        )
          ? [marked.check]
          : [],
      );
    });
    const found = new Map<string, string[]>();
    const since = changeable.map((check) => check.checkedAt).sort()[0];
    if (since === undefined) return found;
    const joined = new Map<boolean, { id: string; joinedAt: string }[]>();
    const joinedIn = (widened: boolean) => {
      const { check } = options.scopeOf(mindId, widened);
      const known =
        joined.get(widened) ??
        options.documents.joinedAfter(
          check.scope.documentIds,
          since,
          widened
            ? null
            : check.marked.chosen
              ? oneFolderOf(check.marked.chosen)
              : check.marked.folderId,
        );
      joined.set(widened, known);
      return known;
    };
    for (const check of changeable) {
      const ids = joinedIn(check.scope.widened)
        .filter((document) => document.joinedAt > check.checkedAt)
        .map((document) => document.id);
      if (ids.length > 0) found.set(check.id, ids);
    }
    return found;
  }

  const everywhere = (allDocuments: boolean, { fresh, again, widened }: Sending) =>
    allDocuments ||
    (fresh.length === 0 && again.length > 0 && again.every((each) => widened.has(each)));

  /** The sentences a run in `mode` sends now. */
  function sending(
    mindId: string,
    mode: CheckMindMode,
    figureIds: readonly string[] | null = null,
  ): Sending {
    const skipped = new Set(content.readSettings(mindId, readMindCheck)?.skipped ?? []);
    const versions = options.documentVersions();
    const folderId = options.mindFolder(mindId);
    const scope = content.readSettings(mindId, mindScopeIn);
    const added = mode === "added" ? addedSince(mindId) : null;
    return content.read(mindId, (blocks) => {
      const { figureContexts } = figuresNow(blocks);
      // Every sentence is read; the one count decides which have a check to make, whatever makes a claim (#1909).
      const sentences = everySentence(blocks);
      const keys = new Set(
        sentences
          .filter((sentence) => sentence.figures?.length || isClaim(sentence.text))
          .map((sentence) => sentenceKey(sentence.text)),
      );
      const widened = new Set<SelectedSentence>();
      const marks = markedSentences(blocks);
      const markOf = (sentence: SelectedSentence) =>
        marks.find(
          (mark) =>
            mark.element === sentence.element && mark.from < sentence.to && mark.to > sentence.from,
        );
      if (figureIds !== null) {
        const selected = new Set(figureIds);
        const known = new Set(
          sentences.flatMap((sentence) => sentence.figures?.map((figure) => figure.id) ?? []),
        );
        if (figureIds.some((id) => !known.has(id)))
          throw new InvalidInputError({ key: "error.mindCheck.request" });
        return {
          fresh: [],
          again: sentences.filter((sentence) =>
            sentence.figures?.some((figure) => selected.has(figure.id)),
          ),
          keys,
          skipped,
          widened,
          held: [],
        };
      }
      if (mode === "all") {
        const fresh: SelectedSentence[] = [];
        const again: SelectedSentence[] = [];
        for (const sentence of sentences) {
          const mark = markOf(sentence);
          const state = checkedSentence({
            text: sentence.text,
            hasFigures: (sentence.figures?.length ?? 0) > 0,
            check: mark
              ? claimCheckShown(mark.check, {
                  text: sentence.text,
                  versions,
                  folderId,
                  scope,
                  figureContexts,
                  figured: inTableCell(sentence.figures),
                })
              : null,
            skipped: skipped.has(sentenceKey(sentence.text)),
            kept: keptAsView(marks, sentence),
          });
          if (state.kind === "kept" || state.kind === "checking" || state.kind === "not-claim") {
            continue;
          }
          if (mark) again.push(sentence);
          else fresh.push(sentence);
        }
        return { fresh, again, keys, skipped, widened, held: [] };
      }
      const fresh: SelectedSentence[] = [];
      const again: SelectedSentence[] = [];
      const held: string[] = [];
      const inScope = new Map<boolean, ReadonlySet<string> | null>();
      const leftScope = (check: ClaimCheckAttributes) => {
        const { widened: everyDocument } = check.scope;
        if (!inScope.has(everyDocument)) {
          const ids = options.scopeOf(mindId, everyDocument).check.scope.documentIds;
          inScope.set(everyDocument, ids && new Set(ids));
        }
        const ids = inScope.get(everyDocument);
        return (
          !!ids &&
          restsOn(check).some((cited) => cited.documentId !== null && !ids.has(cited.documentId))
        );
      };
      for (const sentence of sentences) {
        const mark = markOf(sentence);
        if (added) {
          if (!mark || !added.has(mark.check.id)) continue;
          again.push(sentence);
          if (mark.check.scope.widened) widened.add(sentence);
          continue;
        }
        const state = checkedSentence({
          text: sentence.text,
          hasFigures: (sentence.figures?.length ?? 0) > 0,
          check: mark
            ? claimCheckShown(mark.check, {
                text: sentence.text,
                versions,
                folderId,
                scope,
                figureContexts,
                figured: inTableCell(sentence.figures),
              })
            : null,
          skipped: skipped.has(sentenceKey(sentence.text)),
          kept: keptAsView(marks, sentence),
        });
        if (state.kind === "to-check") {
          if (state.fresh) fresh.push(sentence);
          else again.push(sentence);
          continue;
        }
        if (state.kind !== "covered" || !mark) continue;
        if (leftScope(mark.check)) again.push(sentence);
        else held.push(mark.check.checkedAt);
      }
      return { fresh, again, keys, skipped, widened, held };
    });
  }

  function unchangedSince(mindId: string, held: readonly string[]): string | null {
    const oldest = held.filter((at) => at !== "").sort()[0];
    return oldest ?? content.readSettings(mindId, readMindCheck)?.at ?? null;
  }

  function plan(mindId: string, mode: CheckMindMode, allDocuments: boolean): MindCheckPlan {
    const sent = sending(mindId, mode);
    if (sent.fresh.length + sent.again.length === 0 && sent.held.length > 0) {
      return { kind: "unchanged", since: unchangedSince(mindId, sent.held) };
    }
    const { fresh, again } = sent;
    if (fresh.length + again.length === 0) return { kind: "nothing" };
    const { empty, folderId } = options.scopeOf(mindId, everywhere(allDocuments, sent));
    if (empty) return empty;
    return {
      kind: "ready",
      sentences: fresh.length + again.length,
      findsClaims: fresh.length > 0,
      inFolder: folderId !== null && sent.widened.size === 0,
      model: modelOf(mindId),
    };
  }

  async function findClaims(
    input: ReturnType<typeof parseCheckMind>,
    signal: AbortSignal,
  ): Promise<FindMindClaimsResult> {
    const { mindId, mode } = input;
    const sent = sending(mindId, mode, input.figureIds);
    const { fresh, again } = sent;
    if (fresh.length + again.length === 0) return { kind: "nothing" };
    const { empty } = options.scopeOf(mindId, everywhere(input.allDocuments, sent));
    if (empty) return empty;
    const ready = await options.prepare(input.model ?? modelOf(mindId));
    if (!ready.ok) return ready.result;
    if (signal.aborted) return { kind: "cancelled" };
    const found = await sort(mindId, fresh, ready.prepared, signal);
    if (found.kind !== "found") return found;
    const claims = found.claims.length + again.length;
    return claims === 0 ? { kind: "nothing" } : { kind: "found", claims };
  }

  async function check(
    input: ReturnType<typeof parseCheckMind>,
    signal: AbortSignal,
  ): Promise<CheckMindResult> {
    const { mindId, requestId, mode } = input;
    const sent = sending(mindId, mode, input.figureIds);
    const { fresh, again, keys, skipped, widened } = sent;
    if (fresh.length + again.length === 0) return { kind: "nothing" };
    const { empty, check: scope } = options.scopeOf(mindId, everywhere(input.allDocuments, sent));
    if (empty) return empty;
    const wide = widened.size > 0 ? options.scopeOf(mindId, true).check : scope;
    const scopeFor = (claim: SelectedSentence) => (widened.has(claim) ? wide : scope);
    const ready = await options.prepare(input.model ?? modelOf(mindId));
    if (!ready.ok) return ready.result;
    if (signal.aborted) return { kind: "cancelled" };

    let claims = again;
    const unexamined = new Set(content.readSettings(mindId, readMindCheck)?.unexamined ?? []);
    if (fresh.length > 0) {
      const found = await sort(mindId, fresh, ready.prepared, signal);
      if (found.kind !== "found") return found;
      for (const sentence of found.left) skipped.add(sentenceKey(sentence.text));
      for (const sentence of [...found.claims, ...found.left]) {
        unexamined.delete(sentenceKey(sentence.text));
      }
      for (const sentence of found.undecided) unexamined.add(sentenceKey(sentence.text));
      claims = [...found.claims, ...again];
    }

    const startedAt = options.now().toISOString();
    const unread = options.unread(scope.wanted);
    // The User may have written on while the model named the claims: each is found again by its words.
    const queued = content.edit(mindId, (blocks) => {
      const now = everySentence(blocks);
      const marked = claims.flatMap((claim): QueuedClaim[] => {
        const sentence = now.find(
          (each) => each.blockId === claim.blockId && each.text === claim.text,
        );
        if (!sentence) return [];
        const within = scopeFor(claim);
        const mark: ClaimCheckAttributes = {
          id: randomUUID(),
          request: requestId,
          action: "check-against-documents",
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
          scope: within.marked,
          versions: [],
          excluded: [],
          checkedAt: startedAt,
        };
        const selected = input.figureIds === null ? null : new Set(input.figureIds);
        const previous =
          markedSentences(blocks).find(
            (known) =>
              known.element === sentence.element &&
              known.from < sentence.to &&
              known.to > sentence.from,
          )?.check ?? null;
        const pending = sentence.figures?.length
          ? beginFigureCheck(previous, mark, sentence.figures, selected)
          : mark;
        markSentence(sentence.element, sentence.from, sentence.to, pending);
        return [
          {
            id: mark.id,
            ...checkText(
              selected === null
                ? sentence
                : {
                    ...sentence,
                    figures: sentence.figures?.filter((figure) => selected.has(figure.id)),
                  },
            ),
            cited: options.citedNow(sentence.cited),
            scope: within.scope,
          },
        ];
      });
      if (marked.length > 0) options.recordUnread(blocks, requestId, unread);
      return marked;
    });

    const { checked, stop } = await runChecks(options, {
      mindId,
      queued,
      scope: scope.scope,
      prepared: ready.prepared,
      signal,
    });
    if (signal.aborted) {
      options.settleStopped(mindId, requestId);
      return { kind: "cancelled" };
    }
    const sentences = content.read(mindId, (blocks) => markedSentences(blocks).length);
    if (input.figureIds === null)
      content.editSettings(mindId, (settings) =>
        writeMindCheck(settings, {
          at: options.now().toISOString(),
          sentences,
          stop,
          skipped: [...skipped].filter((key) => keys.has(key)),
          unexamined: [...unexamined].filter((key) => keys.has(key)),
        }),
      );
    return {
      kind: "checked",
      sentences: queued.length,
      checked,
      smallModel: judgesUnreliably(ready.prepared),
      stop,
    };
  }

  return {
    /** See `CoreApi.planMindCheck`. */
    planMindCheck(mindId: unknown, mode: unknown, allDocuments: boolean): MindCheckPlan {
      const id = parseMindId(mindId);
      options.requireMind(id);
      return plan(id, parseMode(mode), allDocuments);
    },

    /** See `CoreApi.findMindClaims`. */
    async findMindClaims(input: unknown): Promise<FindMindClaimsResult> {
      const parsed = parseCheckMind(input);
      options.requireMind(parsed.mindId);
      if (options.isRunning(parsed.requestId)) {
        throw new InvalidInputError({ key: "error.mindCheck.request" });
      }
      // Planning holds the Note too: two requests can't both name claims and ask (#2240).
      const held = checking.get(parsed.mindId);
      if (held && held.requestId !== parsed.requestId) return { kind: "running" };
      const planning = held === undefined;
      if (planning) checking.set(parsed.mindId, { requestId: parsed.requestId, clientId: null });
      const tracked = options.track(parsed.requestId, parsed.mindId);
      try {
        return await findClaims(parsed, tracked.signal);
      } finally {
        tracked.done();
        if (planning) release(parsed.requestId);
      }
    },

    /** See `CoreApi.documentsAddedSinceChecks`. */
    documentsAddedSinceChecks(mindId: unknown): DocumentsAddedSince[] {
      const id = parseMindId(mindId);
      options.requireMind(id);
      return [...addedSince(id)].map(([checkId, documentIds]) => ({ checkId, documentIds }));
    },

    /** See `CoreApi.holdMindCheck`. */
    holdMindCheck(input: unknown): boolean {
      if (!isRecord(input)) throw new InvalidInputError({ key: "error.mindCheck.request" });
      const { requestId } = input;
      if (typeof requestId !== "string" || requestId === "") {
        throw new InvalidInputError({ key: "error.mindCheck.request" });
      }
      const mindId = parseMindId(input.mindId);
      options.requireMind(mindId);
      if (options.isRunning(requestId)) {
        throw new InvalidInputError({ key: "error.mindCheck.request" });
      }
      const held = checking.get(mindId);
      if (held && held.requestId !== requestId) return false;
      checking.set(mindId, {
        requestId,
        clientId:
          typeof input.clientId === "string" && input.clientId !== "" ? input.clientId : null,
      });
      return true;
    },

    /** See `CoreApi.forgetCheckWindow`. */
    forgetCheckWindow(clientId: unknown): void {
      if (typeof clientId !== "string" || clientId === "") {
        throw new InvalidInputError({ key: "error.mindCheck.request" });
      }
      for (const [mindId, held] of checking)
        if (held.clientId === clientId) checking.delete(mindId);
    },

    /** Frees the Note a request kept, whether or not it ran (#2240). */
    release,

    /** See `CoreApi.checkMind`. */
    async checkMind(input: unknown): Promise<CheckMindResult> {
      const parsed = parseCheckMind(input);
      options.requireMind(parsed.mindId);
      if (options.isRunning(parsed.requestId)) {
        throw new InvalidInputError({ key: "error.mindCheck.request" });
      }
      // One Check of a Note at a time, from its planning to its end, whichever window asks (#2240).
      const held = checking.get(parsed.mindId);
      if (held && held.requestId !== parsed.requestId) return { kind: "running" };
      // The run holds the Note now, not the window: a window gone frees only a planned Check.
      checking.set(parsed.mindId, { requestId: parsed.requestId, clientId: null });
      const tracked = options.track(parsed.requestId, parsed.mindId);
      try {
        return await check(parsed, tracked.signal);
      } finally {
        tracked.done();
        if (checking.get(parsed.mindId)?.requestId === parsed.requestId)
          checking.delete(parsed.mindId);
      }
    },
  };
}
