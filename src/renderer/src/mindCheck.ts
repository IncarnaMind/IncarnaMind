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
  TextStretch,
} from "../../core/api";
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
import { checkContradictionsNow, dismissContradictions, watchSentencesNow } from "./contradictions";
import { core } from "./core";
import { type EstimateLine, estimateLine } from "./cost";
import { selectionForEdit } from "./editor/editSelection";
import { type SentencePlace, sentencesToCheck } from "./editor/healthCounts";
import { mindEditor, whenMindEditor } from "./editor/openEditors";
import { editorDoc } from "./editor/proposalReview";
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
  mode: CheckMindMode;
  allDocuments: boolean;
  /** The sentences the run will check: the one count the badge shows (#1909). */
  count: number;
  /** Checked against the Note's Folder: the question names it. */
  inFolder: boolean;
  /** The Note's Folder holds other Documents; `claims` is every cited claim a full watch reads. */
  watch: { claims: number } | null;
  /** Null for a plan or a model on this computer, or when `estimateRun` failed. */
  estimate: EstimateLine | null;
  /** `estimateRun` failed: the ask says the cost couldn't be estimated. */
  unestimated: boolean;
}

/** What a Check runs: what changed, and whether a Folder's other Documents are checked too. */
interface CheckToRun {
  mode: CheckMindMode;
  allDocuments: boolean;
  /** The Note's Folder holds other Documents; `claims` is every cited claim a full watch reads. */
  watch: { claims: number } | null;
}

/** A run that only checks again asks first, with the estimate, when it checks this many or more. */
const ASK_FROM = 10;

/** A problem with the model or a stop ends the Check: the contradiction watch needs the model too. */
const STOPS: ReadonlySet<string> = new Set(["failed", "not-ready", "local-mode", "cancelled"]);

/** How long the Note's editor may take to open before a Check runs without the contradiction watch. */
const OPEN_WAIT_MS = 10_000;

export const useMindCheck = create<MindCheckState>()(() => ({ asking: {}, unchanged: {} }));

export const dismissMindCheck = (mindId: string) =>
  useMindCheck.setState((state) => {
    const asking = { ...state.asking };
    const unchanged = { ...state.unchanged };
    delete asking[mindId];
    delete unchanged[mindId];
    return { asking, unchanged };
  });

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
 * Runs a whole-Note check again: a check of chosen figures checks those figures again, never the
 * whole Note; any other is planned and asked again.
 */
const again =
  (mindId: string, mode: CheckMindMode, allDocuments: boolean, figureIds?: string[]) => () =>
    void (figureIds
      ? checkMind(mindId, mode, { allDocuments, figureIds })
      : startMindCheck(mindId, mode, { allDocuments }));

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
  dismissMindCheck(mindId);
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
): Promise<CheckMindResult | "error"> {
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
    else if (result.kind !== "cancelled")
      setCheckProblem(mindId, withCheckAll(result, again(mindId, mode, true, figureIds)));
    return result;
  } catch (error) {
    setCheckProblem(mindId, {
      kind: "failed",
      error,
      retry: () => void checkMind(mindId, mode, { allDocuments, ...(figureIds && { figureIds }) }),
    });
    return "error";
  }
}

/** Whether a claims run leaves anything for the watch: a throw, a stop, or a model that can't be used ends it. */
function endsCheck(outcome: CheckMindResult | "error"): boolean {
  if (outcome === "error") return true;
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
  const cited = sentencesToCheck(editor.state, skipped).filter(
    (place: SentencePlace) => place.citations.length > 0 && isClaim(place.text),
  );
  return {
    count: cited.length,
    model: modelInUseOf(doc),
    cited: cited.flatMap(({ from, to }) => {
      const read = selectionForEdit(editor.state, { from, to });
      return read ? [{ from: read.from, to: read.to }] : [];
    }),
  };
}

/** What a run is to check, and what it would send. */
export interface Planned {
  mode: CheckMindMode;
  allDocuments: boolean;
  plan: MindCheckPlan;
  /** The Note's Folder holds other Documents; `claims` is every cited claim a full watch reads. */
  watch: { claims: number } | null;
}

/** Shows the Note, plans the run, and says in place if it can't. */
async function start(mindId: string, planned: () => Promise<Planned>): Promise<void> {
  const { openMind } = useAppStore.getState();
  await openMind(mindId);
  if (useChecks.getState().running[mindId]) return;
  try {
    const { mode, allDocuments, plan, watch } = await planned();
    await askOrCheck(mindId, { mode, allDocuments, watch }, plan);
  } catch (error) {
    setCheckProblem(mindId, { kind: "failed", error, retry: () => void start(mindId, planned) });
  }
}

/** Shows the Note, then has the model name the claims to check as `mode` says, and asks with their number and the estimate. */
export function startMindCheck(
  mindId: string,
  mode: CheckMindMode,
  { allDocuments = false }: { allDocuments?: boolean } = {},
): Promise<void> {
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

/** The one Check: everything the Note can be checked for, in one press. */
export const startCheck = (mindId: string): Promise<void> =>
  start(mindId, () => planCheckThisMind(mindId));

/** Check, in the card's question before a run billed per token. */
export function confirmCheck(mindId: string): Promise<void> {
  const asking = useMindCheck.getState().asking[mindId];
  if (!asking) return Promise.resolve();
  return runCheck(mindId, asking);
}

/**
 * Runs the one Check: the claims part, then the cited sentences among them
 * against the Folder's other Documents, under one running state whose Stop
 * takes whichever part runs. A problem with the model, or a stop, ends both.
 */
async function runCheck(mindId: string, run: CheckToRun): Promise<void> {
  if (useChecks.getState().running[mindId]) return;
  dismissMindCheck(mindId);
  dismissCheckProblem(mindId);
  dismissContradictions(mindId);
  const requestId = crypto.randomUUID();
  // Recorded before the sentences are read: reading waits for an editor that may not be open
  // yet, and a second press during that wait must find the run already on (#1941).
  setCheckRunning(mindId, { requestId, action: "whole-mind" });
  try {
    const full = run.watch !== null && (await fullWatchNeeded(mindId, run.watch));
    // Read before the run: the marks it writes cover every sentence it checks.
    const toCheck = run.watch !== null && !full ? await readSentencesToCheck(mindId) : null;
    const stopped = endsCheck(await checkMindNow(mindId, run.mode, run.allDocuments, requestId));
    if (!stopped && run.watch !== null) {
      const watchRequest = crypto.randomUUID();
      setCheckRunning(mindId, { requestId: watchRequest, action: "contradiction-watch" });
      if (full) await checkContradictionsNow(mindId, watchRequest);
      else if (toCheck && toCheck.cited.length > 0) {
        await watchSentencesNow(mindId, watchRequest, toCheck.cited, toCheck.model);
      }
    }
  } finally {
    setCheckRunning(mindId, null);
  }
}

/**
 * A run of what changed that only checks again checks at once when small; any
 * run checks at once when nothing is billed per token and no claim is to be
 * named; the rest ask first, once the claims are named.
 */
async function askOrCheck(mindId: string, run: CheckToRun, plan: MindCheckPlan): Promise<void> {
  if (plan.kind === "unchanged") {
    dismissMindCheck(mindId);
    dismissCheckProblem(mindId);
    useMindCheck.setState((state) => ({ unchanged: { ...state.unchanged, [mindId]: true } }));
    showCheckCard(mindId);
    return;
  }
  if (plan.kind !== "ready") {
    dismissMindCheck(mindId);
    dismissCheckProblem(mindId);
    setCheckProblem(
      mindId,
      plan.kind === "nothing"
        ? { kind: "no-claims" }
        : withCheckAll(plan, again(mindId, run.mode, true)),
    );
    return;
  }
  if (run.mode === "changed" && !plan.findsClaims && plan.sentences < ASK_FROM) {
    return runCheck(mindId, run);
  }
  dismissMindCheck(mindId);
  dismissCheckProblem(mindId);
  const full = run.watch !== null && (await fullWatchNeeded(mindId, run.watch));
  const extra =
    run.watch === null
      ? 0
      : full
        ? run.watch.claims
        : ((await readSentencesToCheck(mindId))?.count ?? 0);
  const estimated = await core
    .estimateRun({
      items: plan.sentences + extra,
      each: "check",
      ...(plan.model && { model: plan.model }),
    })
    .catch((error: unknown) => {
      console.warn(`Couldn't estimate checking Note ${mindId}; it asks without one.`, error);
      return null;
    });
  if (estimated && estimated.billing !== "per-token" && !plan.findsClaims) {
    return runCheck(mindId, run);
  }
  const estimate = estimated ? estimateLine(estimated, translateNow, languageNow()) : null;
  useMindCheck.setState((state) => ({
    asking: {
      ...state.asking,
      [mindId]: {
        mode: run.mode,
        allDocuments: run.allDocuments,
        count: plan.sentences,
        inFolder: plan.inFolder,
        watch: run.watch,
        estimate,
        unestimated: estimated === null,
      },
    },
  }));
}
