/**
 * Check this Mind (#737), the window's side: "Check this Mind" (the check
 * badge's card, ⌘K, the Mind's menu) checks what changed since the last
 * check; when nothing did it sends nothing and says so in the card, whose
 * "Check every sentence again" (also ⌘K) checks them all for real. The card
 * asks with the number of sentences to check, the one count the badge and its
 * card show (#1909), and, billed per token, the estimate; a run that only
 * checks again asks so when it is large, and, for the Documents added since
 * (#993), whatever their number. The model names the claims once it runs. Plans and models on
 * this computer run without asking. While it runs, the badge counts the
 * claims checked, with Stop.
 */
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import type { CheckMindMode, MindCheckPlan, MindCheckRun } from "../../core/api";
import { mindCheckOf, observeMindCheck } from "../../shared/mindCheck";
import {
  type CheckProblem,
  dismissCheckProblem,
  setCheckCardOpen,
  setCheckProblem,
  setCheckRunning,
  setCheckSmallModel,
  useChecks,
  withCheckAll,
} from "./checks";
import { core } from "./core";
import { type EstimateLine, estimateLine } from "./cost";
import { languageNow, translateNow } from "./i18n";
import { frontTabOfMind, groupsMerged } from "./layoutSlice";
import { useAppStore } from "./store";

interface MindCheckState {
  /** By Mind: the question asked before a run billed per token, with its estimate. */
  asking: Readonly<Record<string, Asking>>;
  /** By Mind: Check this Mind was asked and found nothing changed; the card says so while the Mind's plan still does. */
  unchanged: Readonly<Record<string, true>>;
}

interface Asking {
  mode: CheckMindMode;
  allDocuments: boolean;
  /** The sentences the run will check: the one count the badge shows (#1909). */
  count: number;
  /** Checked against the Mind's Folder: the question names it. */
  inFolder: boolean;
  /** Null for a plan or a model on this computer, or when `estimateRun` failed. */
  estimate: EstimateLine | null;
  /** `estimateRun` failed: the ask says the cost couldn't be estimated. */
  unestimated: boolean;
}

/** A run that only checks again asks first, with the estimate, when it checks this many or more. */
const ASK_FROM = 10;

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

/** The Mind's last whole-Mind check, as it changes. */
export function useMindCheckRun(doc: Y.Doc): MindCheckRun | null {
  const [run, setRun] = useState(() => mindCheckOf(doc));
  useEffect(() => {
    setRun(mindCheckOf(doc));
    return observeMindCheck(doc, () => setRun(mindCheckOf(doc)));
  }, [doc]);
  return run;
}

const everywhere = (problem: CheckProblem, mindId: string, mode: CheckMindMode) =>
  withCheckAll(problem, () => void startMindCheck(mindId, mode, { allDocuments: true }));

/** Checks the Mind now, as `mode` says: against its Folder, or every Document. */
export async function checkMind(
  mindId: string,
  mode: CheckMindMode,
  { allDocuments = false }: { allDocuments?: boolean } = {},
): Promise<void> {
  if (useChecks.getState().running[mindId]) return;
  dismissMindCheck(mindId);
  dismissCheckProblem(mindId);
  const requestId = crypto.randomUUID();
  setCheckRunning(mindId, { requestId, action: "whole-mind" });
  try {
    const result = await core.checkMind({ requestId, mindId, mode, allDocuments });
    if (result.kind === "checked") setCheckSmallModel(mindId, result.smallModel);
    else if (result.kind === "failed") {
      setCheckProblem(mindId, { kind: "find-failed", error: result.error, mode, allDocuments });
    } else if (result.kind === "nothing") setCheckProblem(mindId, { kind: "no-claims" });
    else if (result.kind !== "cancelled") setCheckProblem(mindId, everywhere(result, mindId, mode));
  } catch (error) {
    setCheckProblem(mindId, { kind: "failed", error });
  } finally {
    setCheckRunning(mindId, null);
  }
}

/** What a run is to check, and what it would send. */
export interface Planned {
  mode: CheckMindMode;
  allDocuments: boolean;
  plan: MindCheckPlan;
}

/** Shows the Mind, plans the run, and says in place if it can't. */
async function start(mindId: string, planned: () => Promise<Planned>): Promise<void> {
  const { openMind } = useAppStore.getState();
  await openMind(mindId);
  if (useChecks.getState().running[mindId]) return;
  try {
    const { mode, allDocuments, plan } = await planned();
    await askOrCheck(mindId, mode, allDocuments, plan);
  } catch (error) {
    setCheckProblem(mindId, { kind: "failed", error });
  }
}

/** Shows the Mind, then has the model name the claims to check as `mode` says, and asks with their number and the estimate. */
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
    }),
  );
}

/** What "Check this Mind" runs now: what changed; or, with nothing changed, the checks the Documents added since could change. */
export async function planCheckThisMind(mindId: string): Promise<Planned> {
  const changed = await core.planMindCheck(mindId, "changed", false);
  if (changed.kind === "unchanged") {
    const added = await core.planMindCheck(mindId, "added", false);
    if (added.kind === "ready") return { mode: "added", allDocuments: false, plan: added };
  }
  return { mode: "changed", allDocuments: false, plan: changed };
}

/** "Check this Mind": what changed since the last check; when nothing did, no check, and the card says so. */
export const startCheckThisMind = (mindId: string): Promise<void> =>
  start(mindId, () => planCheckThisMind(mindId));

/**
 * A run of what changed that only checks again checks at once when small; any
 * run checks at once when nothing is billed per token and no claim is to be
 * named; the rest ask first, once the claims are named.
 */
async function askOrCheck(
  mindId: string,
  mode: CheckMindMode,
  allDocuments: boolean,
  plan: MindCheckPlan,
): Promise<void> {
  if (plan.kind === "unchanged") {
    dismissMindCheck(mindId);
    dismissCheckProblem(mindId);
    useMindCheck.setState((state) => ({ unchanged: { ...state.unchanged, [mindId]: true } }));
    showCheckCard(mindId);
    return;
  }
  if (plan.kind !== "ready") {
    dismissMindCheck(mindId);
    setCheckProblem(
      mindId,
      plan.kind === "nothing" ? { kind: "no-claims" } : everywhere(plan, mindId, mode),
    );
    return;
  }
  if (mode === "changed" && !plan.findsClaims && plan.sentences < ASK_FROM)
    return checkMind(mindId, mode, { allDocuments });
  dismissMindCheck(mindId);
  dismissCheckProblem(mindId);
  const count = plan.sentences;
  const estimated = await core
    .estimateRun({ items: count, each: "check", ...(plan.model && { model: plan.model }) })
    .catch((error: unknown) => {
      console.warn(`Couldn't estimate checking Mind ${mindId}; it asks without one.`, error);
      return null;
    });
  if (estimated && estimated.billing !== "per-token" && !plan.findsClaims)
    return checkMind(mindId, mode, { allDocuments });
  const estimate = estimated ? estimateLine(estimated, translateNow, languageNow()) : null;
  useMindCheck.setState((state) => ({
    asking: {
      ...state.asking,
      [mindId]: {
        mode,
        allDocuments,
        count,
        inFolder: plan.inFolder,
        estimate,
        unestimated: estimated === null,
      },
    },
  }));
}
