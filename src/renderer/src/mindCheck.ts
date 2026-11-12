/**
 * The one Check (#1941), the window's side: "Check" (the check badge's card,
 * ⌘K, the Note's menu) checks in one press everything a Note can be checked
 * for — its Citations and uncited sentences, its calculated figures, and, in
 * a Folder, the sentences it checks against the Folder's other Documents too —
 * as one question with the one count (#1909) and one estimate. It composes
 * the checks that stay separate: what changed since the last whole-Note check
 * (#737), which "Check every sentence again" (also ⌘K) runs to check them all
 * again, and the contradiction watch (#112), which ⌘K and the Note's menu
 * still offer alone. When nothing is left to check it sends nothing and says
 * so in the card. The model names the claims once it runs. Plans and models
 * on this computer run without asking. While it runs, the badge counts the
 * claims checked, with Stop.
 */
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import type {
  CheckMindMode,
  CheckMindResult,
  MindCheckPlan,
  MindCheckRun,
  RunEstimate,
  TextStretch,
} from "../../core/api";
import { TranslatableError } from "../../core/errors";
import { contradictionWatchOf } from "../../shared/contradictionWatch";
import { mindCheckOf, observeMindCheck } from "../../shared/mindCheck";
import { isClaim } from "../../shared/sentences";
import {
  dismissCheckProblem,
  setCheckCardOpen,
  setCheckProblem,
  setCheckRunning,
  setCheckSmallModel,
  useChecks,
  withCheckAll,
} from "./checks";
import { clientId } from "./clientId";
import { readinessKey, serviceName } from "./components/providers/shared";
import { checkContradictionsNow, dismissContradictions, watchSentencesNow } from "./contradictions";
import { core } from "./core";
import { type EstimateLine, estimateLine } from "./cost";
import { selectionForEdit } from "./editor/editSelection";
import { type SentencePlace, sentencesToCheck } from "./editor/healthCounts";
import { mindEditor, whenMindEditor } from "./editor/openEditors";
import { opinionSentenceRanges } from "./editor/opinionLocations";
import { editorDoc } from "./editor/proposalReview";
import { noteBusy } from "./editWithAi";
import { languageNow, translateNow } from "./i18n";
import { frontTabOfMind, groupsMerged } from "./layoutSlice";
import { modelInUseOf } from "./modelInUse";
import { useAppStore } from "./store";

interface MindCheckState {
  /** By Note: the question asked before a run billed per token, with its estimate. */
  asking: Readonly<Record<string, Asking>>;
  /** By Note: Check was asked and found nothing changed; the card says so while the Note's plan still does. */
  unchanged: Readonly<Record<string, true>>;
}

interface Asking {
  /** The request that keeps the Note from its planning until the User answers this question. */
  requestId: string;
  mode: CheckMindMode;
  allDocuments: boolean;
  /** The sentences the run will check: the one count the badge shows (#1909). */
  count: number;
  /** Checked against the Note's Folder: the question names it. */
  inFolder: boolean;
  /** The Note's Folder holds other Documents; `claims` is every cited claim a full watch reads. */
  watch: { claims: number } | null;
  /**
   * Null for a plan or a model on this computer, or when `estimateRun` failed. Put in words where
   * the question is shown, so they follow the interface's language while it is open (#2831).
   */
  estimate: RunEstimate | null;
  /** `estimateRun` failed: the ask says the cost couldn't be estimated. */
  unestimated: boolean;
  /** A run of the Figure schedule's chosen figures: the OK checks those figures, never the whole Note. */
  figureIds?: string[];
}

/** What a Check runs: what changed, and whether a Folder's other Documents are checked too. */
interface CheckToRun {
  mode: CheckMindMode;
  allDocuments: boolean;
  /** The Note's Folder holds other Documents; `claims` is every cited claim a full watch reads. */
  watch: { claims: number } | null;
  /** The figures to check, for a run from the Figure schedule; none for a whole-Note Check. */
  figureIds?: string[];
}

/** A problem with the model or a stop ends the Check: the contradiction watch needs the model too. */
const STOPS: ReadonlySet<string> = new Set([
  "failed",
  "not-ready",
  "local-mode",
  "cancelled",
  "running",
]);

/** How long the Note's editor may take to open before a Check runs without the contradiction watch. */
const OPEN_WAIT_MS = 10_000;

export const useMindCheck = create<MindCheckState>()(() => ({ asking: {}, unchanged: {} }));

/** Forgets the Note's question in this window; a Check it keeps the Note for is left alone. */
function clearAsk(mindId: string): void {
  useMindCheck.setState((state) => {
    const asking = { ...state.asking };
    const unchanged = { ...state.unchanged };
    delete asking[mindId];
    delete unchanged[mindId];
    return { asking, unchanged };
  });
}

/** Not now: the question goes as the User's no, and the Note is free for another window's Check. */
export function dismissMindCheck(mindId: string): void {
  void settleAskedNote(mindId, "declined");
}

/** The card closed on the question (Esc, ×, or the Note closing): it goes as closed, never Not now. */
export function closeMindCheckAsk(mindId: string): void {
  void settleAskedNote(mindId, "closed");
}

/**
 * What closing the card does to the Note's question: a click into the page keeps it for the
 * badge to reopen, while Esc, the badge's ×, and the Note closing close it.
 */
export function cardClosed(mindId: string, how: "escape" | "toggle" | "note" | "outside"): void {
  if (how === "outside") return;
  closeMindCheckAsk(mindId);
}

/**
 * A Check that starts while a question waits (a second request, Check every sentence again, a
 * retry): the question gives way as closed; the User never chose Not now.
 */
async function freeAskedNote(mindId: string): Promise<void> {
  await settleAskedNote(mindId, "closed");
}

async function settleAskedNote(mindId: string, answer: "declined" | "closed"): Promise<void> {
  const asking = useMindCheck.getState().asking[mindId];
  clearAsk(mindId);
  if (!asking) return;
  settle(asking.requestId, { kind: answer });
  await releaseHold(asking.requestId);
}

async function releaseHold(requestId: string): Promise<void> {
  try {
    await core.cancelCheck(requestId);
  } catch (error) {
    console.warn(`Couldn't free the Note a Check kept while it was planned (${requestId}).`, error);
  }
}

/** How a Check the window started ended: its result, a failure, or the question it asked. */
type CheckEnd = CheckMindResult | { kind: "threw"; error: unknown };
/** "busy": a rewrite works in the Note, which says so; nothing was planned. */
type CheckOutcome = CheckEnd | { kind: "asked"; requestId: string } | { kind: "busy" } | null;
type CheckAnswer = CheckEnd | { kind: "declined" } | { kind: "closed" };

/** What each Check that asked a question comes to, by the request it asked for. */
const answers = new Map<
  string,
  { promise: Promise<CheckAnswer>; resolve(answer: CheckAnswer): void }
>();

function waitForAnswer(requestId: string): void {
  let resolve!: (answer: CheckAnswer) => void;
  const promise = new Promise<CheckAnswer>((done) => {
    resolve = done;
  });
  answers.set(requestId, { promise, resolve });
}

function settle(requestId: string, answer: CheckAnswer): void {
  const waiting = answers.get(requestId);
  if (!waiting) return;
  answers.delete(requestId);
  waiting.resolve(answer);
}

export function showCheckCard(mindId: string): void {
  const tab = frontTabOfMind(useAppStore.getState().layout, mindId, groupsMerged());
  setCheckCardOpen(tab?.id ?? mindId, true);
}

/** The Note's last whole-Note check, as it changes. */
export function useMindCheckRun(doc: Y.Doc): MindCheckRun | null {
  const [run, setRun] = useState(() => mindCheckOf(doc));
  useEffect(() => {
    setRun(mindCheckOf(doc));
    return observeMindCheck(doc, () => setRun(mindCheckOf(doc)));
  }, [doc]);
  return run;
}

/**
 * Runs a whole-Note check again at once, without asking: the User already agreed to the run it is
 * offered for. A check of chosen figures checks those figures again, never the whole Note.
 */
const again =
  (mindId: string, mode: CheckMindMode, allDocuments: boolean, figureIds?: string[]) => () =>
    void checkMind(mindId, mode, { allDocuments, ...(figureIds && { figureIds }) });

/**
 * Checks the Note's claims now, as `mode` says: what changed, every sentence,
 * or what Documents added since could change. "Check every sentence again"
 * and a retry of a whole-Note check start here, without the contradiction
 * watch, which the one Check runs.
 */
export async function checkMind(
  mindId: string,
  mode: CheckMindMode,
  { allDocuments = false, figureIds }: { allDocuments?: boolean; figureIds?: string[] } = {},
): Promise<void> {
  if (useChecks.getState().running[mindId]) return;
  await freeAskedNote(mindId);
  // Read again once the asked Note is freed, which waits on the core: a second press meanwhile
  // found no question to free and started its run (#2302).
  if (useChecks.getState().running[mindId]) return;
  dismissCheckProblem(mindId);
  const requestId = crypto.randomUUID();
  setCheckRunning(mindId, { requestId, action: "whole-mind" });
  try {
    await checkMindNow(mindId, mode, allDocuments, requestId, figureIds);
  } finally {
    setCheckRunning(mindId, null);
  }
}

/** The claims part of a run, with the running state left to its caller; its result. */
async function checkMindNow(
  mindId: string,
  mode: CheckMindMode,
  allDocuments: boolean,
  requestId: string,
  figureIds?: string[],
): Promise<CheckEnd> {
  try {
    const result = await core.checkMind({
      requestId,
      mindId,
      mode,
      allDocuments,
      ...(figureIds && { figureIds }),
    });
    if (result.kind === "checked") setCheckSmallModel(mindId, result.smallModel);
    else if (result.kind === "failed") {
      setCheckProblem(mindId, {
        kind: "find-failed",
        error: result.error,
        retry: again(mindId, mode, allDocuments, figureIds),
      });
    } else if (result.kind === "nothing") setCheckProblem(mindId, { kind: "no-claims" });
    // Another window's Check of this Note is running: it says how it went.
    else if (result.kind !== "cancelled" && result.kind !== "running")
      setCheckProblem(
        mindId,
        withCheckAll(result, () => checkAllDocuments(mindId, mode, figureIds)),
      );
    return result;
  } catch (error) {
    setCheckProblem(mindId, {
      kind: "failed",
      error,
      retry: () => void checkMind(mindId, mode, { allDocuments, ...(figureIds && { figureIds }) }),
    });
    return { kind: "threw", error };
  }
}

/** Whether a claims run leaves anything for the watch: a throw, a stop, or a model that can't be used ends it. */
function endsCheck(outcome: CheckEnd): boolean {
  if (outcome.kind === "threw") return true;
  if (outcome.kind === "checked") return outcome.stop !== null;
  return STOPS.has(outcome.kind);
}

/**
 * What a Check reads in the Note as it is now: the sentences it checks, and
 * the cited ones among them, which a Folder's other Documents are checked
 * against. A sentence's place, not its words: the mind check writes marks in
 * place, which move nothing.
 */
interface SentencesToCheck {
  sentences: readonly SentencePlace[];
  /** The cited sentences' places, as the core reads a selection: where they are in the Note. */
  cited: TextStretch[];
  /** How many model checks the contradiction watch adds: one a cited sentence. */
  count: number;
  /** The model the Note uses, as its other checks do. */
  model: ReturnType<typeof modelInUseOf>;
}

async function readSentencesToCheck(mindId: string): Promise<SentencesToCheck | null> {
  const editor = mindEditor(mindId) ?? (await whenMindEditor(mindId, OPEN_WAIT_MS));
  const doc = editor && editorDoc(editor);
  if (!editor || editor.isDestroyed || !doc) return null;
  const skipped = new Set(mindCheckOf(doc)?.skipped ?? []);
  const sentences = sentencesToCheck(
    editor.state,
    skipped,
    undefined,
    opinionSentenceRanges(editor.state.doc, doc),
  );
  const cited = sentences.filter((place) => place.citations.length > 0 && isClaim(place.text));
  return {
    sentences,
    count: cited.length,
    model: modelInUseOf(doc),
    cited: cited.flatMap(({ from, to }) => {
      const read = selectionForEdit(editor.state, { from, to });
      return read ? [{ from: read.from, to: read.to }] : [];
    }),
  };
}

/** What a run is to check, and what it would send. */
export interface Planned extends CheckToRun {
  plan: MindCheckPlan;
}

/**
 * Shows the Note, keeps it for this Check from planning to its end, plans the run, and says in
 * place if it can't or another window checks it. `ask` is the question before a run whose price
 * is above $1 or that has a spending cap, which the card's own Check skips (#2313). `forceAsk`
 * asks without a price, for the card's press before its estimate arrived or after it failed.
 * `priced` is the plan the card's press showed the price for: a plan made since asks again.
 */
async function start(
  mindId: string,
  planned: () => Promise<Planned>,
  ask = true,
  forceAsk = false,
  priced?: Planned,
): Promise<CheckOutcome> {
  const { openMind } = useAppStore.getState();
  await openMind(mindId);
  if (useChecks.getState().running[mindId]) return { kind: "running" };
  // A rewrite writes its reply only into a Note nothing else started on meanwhile.
  if (useChecks.getState().rewriting[mindId]) {
    noteBusy(mindId);
    return { kind: "busy" };
  }
  // An earlier question about this Note, and the Note with it, gives way first.
  await freeAskedNote(mindId);
  const requestId = crypto.randomUUID();
  let held = false;
  let keeps = false;
  let ranCheck = false;
  try {
    if (!(await core.holdMindCheck({ requestId, mindId, clientId }))) {
      setCheckProblem(mindId, { kind: "running" });
      showCheckCard(mindId);
      return { kind: "running" };
    }
    held = true;
    const { mode, allDocuments, plan, watch, figureIds } = await planned();
    const outcome = await askOrCheck(
      mindId,
      requestId,
      { mode, allDocuments, watch, ...(figureIds && { figureIds }) },
      plan,
      () => {
        ranCheck = true;
      },
      ask,
      forceAsk,
      priced,
    );
    keeps = outcome !== null && outcome.kind === "asked";
    return outcome;
  } catch (error) {
    setCheckProblem(mindId, {
      kind: "failed",
      error,
      retry: () => void start(mindId, planned, ask, forceAsk),
    });
    return { kind: "threw", error };
  } finally {
    // A shown question keeps the Note for the run it asks for, and a run frees its own hold at its end.
    if (held && !keeps && !ranCheck) await releaseHold(requestId);
  }
}

/** Shows the Note, then has the model name the claims to check as `mode` says, and asks with their number and the estimate. */
export function startMindCheck(
  mindId: string,
  mode: CheckMindMode,
  { allDocuments = false }: { allDocuments?: boolean } = {},
): Promise<CheckOutcome> {
  return start(
    mindId,
    async (): Promise<Planned> => ({
      mode,
      allDocuments,
      plan: await core.planMindCheck(mindId, mode, allDocuments),
      watch: null,
    }),
  );
}

/**
 * What the one Check runs now: what changed since the last whole-Note check
 * (or, with nothing changed, the checks the Documents added since could
 * change), and whether the Note's Folder holds other Documents to check its
 * cited sentences against.
 */
export async function planCheckThisMind(mindId: string): Promise<Planned> {
  const changed = await core.planMindCheck(mindId, "changed", false);
  let mode: CheckMindMode = "changed";
  let plan = changed;
  if (changed.kind === "unchanged") {
    const added = await core.planMindCheck(mindId, "added", false);
    if (added.kind === "ready") {
      mode = "added";
      plan = added;
    }
  }
  const watch = await core.planContradictionCheck(mindId);
  return {
    mode,
    allDocuments: false,
    plan,
    watch: watch.kind === "ready" ? { claims: watch.claims } : null,
  };
}

/**
 * Whether the Note's cited sentences were never all watched, or the last full
 * watch stopped early (#1941): the cases a watch of only the sentences it is
 * checking would leave a stale Supported in. Without a Note to read the scope
 * from, every cited sentence is read: a full watch needs no editor.
 */
async function fullWatchNeeded(mindId: string, watch: { claims: number }): Promise<boolean> {
  const editor = mindEditor(mindId) ?? (await whenMindEditor(mindId, OPEN_WAIT_MS));
  const doc = editor && editorDoc(editor);
  if (!editor || editor.isDestroyed || !doc || watch.claims === 0) return true;
  const record = contradictionWatchOf(doc);
  return record === null || record.stop !== null;
}

/** What a run sends, as the estimate prices it: the Note's sentences and the watch's. */
async function checkItems(
  mindId: string,
  run: CheckToRun,
  plan: Extract<MindCheckPlan, { kind: "ready" }>,
): Promise<number> {
  const full = run.watch !== null && (await fullWatchNeeded(mindId, run.watch));
  const extra =
    run.watch === null
      ? 0
      : full
        ? run.watch.claims
        : ((await readSentencesToCheck(mindId))?.count ?? 0);
  return plan.sentences + extra;
}

/**
 * What the Note's card asks before its one Check runs: the price line above $1 or with a spending
 * cap (#1941), none when the run is cheap or free, or unknown when `estimateRun` failed.
 */
export type CheckedEstimate =
  | { kind: "price"; line: EstimateLine }
  | { kind: "none" }
  | { kind: "unknown" };

export async function checkEstimate(mindId: string, planned: Planned): Promise<CheckedEstimate> {
  const { plan } = planned;
  if (plan.kind !== "ready") return { kind: "none" };
  try {
    const estimated = await core.estimateRun({
      items: await checkItems(mindId, planned, plan),
      each: "check",
      ...(plan.model && { model: plan.model }),
    });
    const line = estimateLine(estimated, translateNow, languageNow());
    return line ? { kind: "price", line } : { kind: "none" };
  } catch (error) {
    console.warn(
      `Couldn't estimate checking Note ${mindId}; its card asks without a price.`,
      error,
    );
    return { kind: "unknown" };
  }
}

/** The card's one Check: the price line it shows before the press is the User's OK (#2313). */
export const startCheck = (mindId: string, priced?: Planned): Promise<CheckOutcome> =>
  start(mindId, () => planCheckThisMind(mindId), false, false, priced);

/** The card's Check when its price failed or hasn't arrived: it asks, with the couldn't-estimate line. */
export const startCheckUnpriced = (mindId: string): Promise<CheckOutcome> =>
  start(mindId, () => planCheckThisMind(mindId), true, true);

/**
 * A Check started from ⌘K, Home, the assistant or a line: it asks when its price is above $1 or a
 * spending cap is set, and runs at once below that (#2313).
 */
export const startCheckAsking = (mindId: string): Promise<CheckOutcome> =>
  start(mindId, () => planCheckThisMind(mindId), true);

/**
 * The Figure schedule's Check again: the figures the User chose, checked as every other way in
 * asks — its price above $1 or with a spending cap, and the couldn't-estimate line when the
 * estimate fails (#2313). With `allDocuments`, Check all Documents widens the same figures to
 * every Document, never to the whole Note.
 */
export const startFigureCheckAsking = (
  mindId: string,
  figureIds: string[],
  allDocuments = false,
): Promise<CheckOutcome> =>
  start(
    mindId,
    async (): Promise<Planned> => ({
      mode: "all",
      allDocuments,
      plan: await core.planMindCheck(mindId, "all", allDocuments, figureIds),
      watch: null,
      figureIds,
    }),
  );

/**
 * Check all Documents for a run that found none in its Folder: a run of chosen figures plans
 * and asks again for those figures, so widening never turns it into a whole-Note Check (#2313).
 */
function checkAllDocuments(mindId: string, mode: CheckMindMode, figureIds?: string[]): void {
  if (figureIds) void startFigureCheckAsking(mindId, figureIds, true);
  else void startMindCheck(mindId, mode, { allDocuments: true });
}

/**
 * The re-check after Change to the source's figure: only what changed since the last check,
 * with no Folder watch, asked as every other way in asks — its price above $1 or with a
 * spending cap, and the couldn't-estimate line when the estimate fails (#2313).
 */
export const startChangedCheckAsking = (mindId: string): Promise<CheckOutcome> =>
  start(
    mindId,
    async (): Promise<Planned> => ({
      mode: "changed",
      allDocuments: false,
      plan: await core.planMindCheck(mindId, "changed", false),
      watch: null,
    }),
  );

/**
 * The assistant's Check (#1421), in the window that asked: the Note's one Check, or every sentence
 * again. It never answers its own question: with `reply`, an asked run ends as a reply that says
 * the check waits for the User's OK on the Note. From ⌘K or a menu the Note's card is the answer:
 * it says how the Check went, so nothing is said again as a notice (#2831). A Note another window
 * checks, or is planning to, starts none, and its card says so.
 */
export async function checkFromAssistant(
  mindId: string,
  everySentence = false,
  reply = false,
): Promise<void> {
  const outcome = everySentence
    ? await startMindCheck(mindId, "all")
    : await startCheckAsking(mindId);
  if (!reply) return;
  if (outcome?.kind === "asked") {
    endAs(await answerOf(outcome.requestId));
    return;
  }
  // The Note already says it is busy; the assistant is told in the same words.
  if (outcome?.kind === "busy") throw new TranslatableError({ key: "edit.problem.busy" });
  endAs(outcome ?? null);
}

/** What the Note's question comes to: its run's result, Not now, or the card closing first. */
const answerOf = (requestId: string): Promise<CheckAnswer> =>
  answers.get(requestId)?.promise ?? Promise.resolve({ kind: "closed" });

/** Ends the assistant's Check as what it came to: only a run that checked is ever "Done". */
function endAs(outcome: CheckAnswer | null): void {
  if (outcome === null) throw new TranslatableError({ key: "mindCheck.nothingToCheck" });
  if (outcome.kind === "declined") throw new TranslatableError({ key: "mindCheck.declined" });
  if (outcome.kind === "closed") throw new TranslatableError({ key: "mindCheck.closed" });
  if (outcome.kind === "threw") {
    throw outcome.error instanceof Error
      ? outcome.error
      : new TranslatableError(String(outcome.error));
  }
  switch (outcome.kind) {
    case "checked":
      return;
    case "failed":
      throw new TranslatableError(outcome.error.wording ?? outcome.error.message);
    case "running":
      throw new TranslatableError({ key: "mindCheck.alreadyChecking" });
    case "cancelled":
      throw new TranslatableError({ key: "run.stopped.cancelled" });
    case "not-ready": {
      const service =
        "provider" in outcome.readiness
          ? serviceName(outcome.readiness.provider, translateNow, languageNow())
          : "";
      throw new TranslatableError({ key: readinessKey(outcome.readiness), values: { service } });
    }
    case "local-mode":
      throw new TranslatableError({ key: "checks.problem.local-mode" });
    case "no-documents":
      throw new TranslatableError({ key: "checks.problem.no-documents.all" });
    case "nothing":
      throw new TranslatableError({ key: "checks.problem.no-claims" });
  }
  const unhandled: never = outcome;
  throw new Error(`A Check ended as ${String(unhandled)}, which its card has no ending for.`);
}

/** Check, in the card's question before a run billed per token. */
export async function confirmCheck(mindId: string): Promise<void> {
  const asking = useMindCheck.getState().asking[mindId];
  if (!asking) return;
  try {
    await runCheck(mindId, asking.requestId, {
      mode: asking.mode,
      allDocuments: asking.allDocuments,
      watch: asking.watch,
      ...(asking.figureIds && { figureIds: asking.figureIds }),
    });
  } catch (error) {
    setCheckProblem(mindId, {
      kind: "failed",
      error,
      retry: again(mindId, asking.mode, asking.allDocuments, asking.figureIds),
    });
  }
}

/**
 * Runs the one Check: the claims part, then the cited sentences among them
 * against the Folder's other Documents, under one running state whose Stop
 * takes whichever part runs. A problem with the model, or a stop, ends both.
 */
async function runCheck(mindId: string, requestId: string, run: CheckToRun): Promise<CheckEnd> {
  let started = false;
  // Answered, the question goes whichever way the run goes.
  clearAsk(mindId);
  try {
    if (useChecks.getState().running[mindId]) {
      settle(requestId, { kind: "running" });
      return { kind: "running" };
    }
    dismissCheckProblem(mindId);
    dismissContradictions(mindId);
    // Recorded before the sentences are read: reading waits for an editor that may not be open
    // yet, and a second press during that wait must find the run already on (#1941).
    setCheckRunning(mindId, { requestId, action: "whole-mind" });
    started = true;
    const full = run.watch !== null && (await fullWatchNeeded(mindId, run.watch));
    // Read before the run: the marks it writes cover every sentence it checks.
    const toCheck = run.watch !== null && !full ? await readSentencesToCheck(mindId) : null;
    const result = await checkMindNow(mindId, run.mode, run.allDocuments, requestId, run.figureIds);
    const stopped = endsCheck(result);
    if (!stopped && run.watch !== null) {
      const watchRequest = crypto.randomUUID();
      setCheckRunning(mindId, { requestId: watchRequest, action: "contradiction-watch" });
      if (full) await checkContradictionsNow(mindId, watchRequest);
      else if (toCheck && toCheck.cited.length > 0) {
        await watchSentencesNow(mindId, watchRequest, toCheck.cited, toCheck.model);
      }
    }
    settle(requestId, result);
    return result;
  } catch (error) {
    settle(requestId, { kind: "threw", error });
    throw error;
  } finally {
    if (started) setCheckRunning(mindId, null);
    await releaseHold(requestId);
  }
}

/** Whether the plan made at the press is the one the card showed a price for. */
function samePriced(priced: Planned, run: CheckToRun, plan: MindCheckPlan): boolean {
  return (
    priced.mode === run.mode &&
    priced.allDocuments === run.allDocuments &&
    JSON.stringify(priced.plan) === JSON.stringify(plan) &&
    JSON.stringify(priced.watch) === JSON.stringify(run.watch)
  );
}

/**
 * A Check that did not run on its one press asks when its price is above $1 or a spending cap is
 * set, and runs at once below that; an estimate that failed asks without a price (#2313). A plan
 * made since the price shown asks again, so the press never runs on an old price.
 */
async function askOrCheck(
  mindId: string,
  requestId: string,
  run: CheckToRun,
  plan: MindCheckPlan,
  started: () => void,
  ask: boolean,
  forceAsk = false,
  priced?: Planned,
): Promise<CheckOutcome> {
  // A check of this Note that started while this one was held and planned has the badge, with
  // Stop: this one changes nothing beside it (#2302).
  if (useChecks.getState().running[mindId]) return { kind: "running" };
  if (plan.kind === "unchanged") {
    clearAsk(mindId);
    dismissCheckProblem(mindId);
    useMindCheck.setState((state) => ({ unchanged: { ...state.unchanged, [mindId]: true } }));
    showCheckCard(mindId);
    return null;
  }
  if (plan.kind !== "ready") {
    clearAsk(mindId);
    dismissCheckProblem(mindId);
    setCheckProblem(
      mindId,
      plan.kind === "nothing"
        ? { kind: "no-claims" }
        : withCheckAll(plan, () => checkAllDocuments(mindId, run.mode, run.figureIds)),
    );
    return null;
  }
  // No price arrived at the card's press: the question asks with the couldn't-estimate line.
  // Only the card's whole-Note press forces a question; a figures run asks with its price or
  // the couldn't-estimate line, so no figure ids reach this branch.
  if (forceAsk) {
    clearAsk(mindId);
    dismissCheckProblem(mindId);
    waitForAnswer(requestId);
    useMindCheck.setState((state) => ({
      asking: {
        ...state.asking,
        [mindId]: {
          requestId,
          mode: run.mode,
          allDocuments: run.allDocuments,
          count: plan.sentences,
          inFolder: plan.inFolder,
          watch: run.watch,
          estimate: null,
          unestimated: true,
        },
      },
    }));
    return { kind: "asked", requestId };
  }
  // The card's press carries the plan it priced: an edit or paste since makes another plan, whose
  // own estimate is asked for rather than running on the old price (#2313).
  if (!ask && priced !== undefined && !samePriced(priced, run, plan)) ask = true;
  // The one Check runs from its one press; the price line it shows is its card's, never a
  // question before the run (#2313).
  if (!ask) {
    started();
    return runCheck(mindId, requestId, run);
  }
  clearAsk(mindId);
  dismissCheckProblem(mindId);
  const estimated = await core
    .estimateRun({
      items: await checkItems(mindId, run, plan),
      each: "check",
      ...(plan.model && { model: plan.model }),
    })
    .catch((error: unknown) => {
      console.warn(`Couldn't estimate checking Note ${mindId}; it asks without one.`, error);
      return null;
    });
  // Nor one that started while the run was estimated.
  if (useChecks.getState().running[mindId]) return { kind: "running" };
  if (estimated !== null && estimateLine(estimated, translateNow, languageNow()) === null) {
    started();
    return runCheck(mindId, requestId, run);
  }
  waitForAnswer(requestId);
  useMindCheck.setState((state) => ({
    asking: {
      ...state.asking,
      [mindId]: {
        requestId,
        mode: run.mode,
        allDocuments: run.allDocuments,
        count: plan.sentences,
        inFolder: plan.inFolder,
        watch: run.watch,
        estimate: estimated,
        unestimated: estimated === null,
        ...(run.figureIds && { figureIds: run.figureIds }),
      },
    },
  }));
  return { kind: "asked", requestId };
}
