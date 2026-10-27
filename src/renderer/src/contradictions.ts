/**
 * Contradiction watch (#112), the window's side: the one Check runs the
 * Note's cited claims against the other Documents in its Folder, and "Check
 * for contradictions" (⌘K, the Note's menu) still runs them alone. On a model
 * billed per token the check badge's card asks first, with the estimate;
 * otherwise it starts at once. While it runs, the badge says so with Stop, as
 * the Note's other checks do; what it found is the contradicted marks and the
 * card's own counts.
 */
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import type {
  ChatModelChoice,
  ContradictionCheckPlan,
  ContradictionWatchRun,
  TextStretch,
} from "../../core/api";
import { contradictionWatchOf, observeContradictionWatch } from "../../shared/contradictionWatch";
import {
  type CheckProblem,
  setCheckProblem,
  setCheckRunning,
  setCheckSmallModel,
  useChecks,
} from "./checks";
import { core } from "./core";
import { type EstimateLine, estimateLine } from "./cost";
import { languageNow, translateNow } from "./i18n";
import { useAppStore } from "./store";

interface ContradictionsState {
  /** By Note: the question asked before a run billed per token, with its estimate. */
  asking: Readonly<Record<string, { claims: number; estimate: EstimateLine | null }>>;
}

export const useContradictions = create<ContradictionsState>()(() => ({ asking: {} }));

function setFor<K extends keyof ContradictionsState>(
  key: K,
  mindId: string,
  value: ContradictionsState[K][string] | null,
) {
  useContradictions.setState((state) => {
    const next = { ...state[key] } as Record<string, ContradictionsState[K][string]>;
    if (value === null) delete next[mindId];
    else next[mindId] = value;
    return { [key]: next } as Partial<ContradictionsState>;
  });
}

const problemOf = (plan: Exclude<ContradictionCheckPlan, { kind: "ready" }>): CheckProblem =>
  plan.kind === "nothing" ? { kind: "no-cited" } : plan;

/** What the check badge's card shows of it, if anything. */
export type ContradictionLineShown =
  | { kind: "asking"; claims: number; estimate: EstimateLine | null }
  | { kind: "watched"; run: ContradictionWatchRun };

/**
 * The question before a run billed per token; else the last run a new version
 * of a Document started, kept in the Note (`src/shared/contradictionWatch.ts`),
 * as it changes.
 */
export function useContradictionLine(doc: Y.Doc, mindId: string): ContradictionLineShown | null {
  const asking = useContradictions((state) => state.asking[mindId]);
  const [watched, setWatched] = useState(() => contradictionWatchOf(doc));
  useEffect(() => {
    setWatched(contradictionWatchOf(doc));
    return observeContradictionWatch(doc, () => setWatched(contradictionWatchOf(doc)));
  }, [doc]);
  if (asking) return { kind: "asking", ...asking };
  if (watched) return { kind: "watched", run: watched };
  return null;
}

export const dismissContradictions = (mindId: string) => setFor("asking", mindId, null);

/** The check's own part, with the running state left to its caller. */
export async function checkContradictionsNow(mindId: string, requestId: string): Promise<void> {
  try {
    const result = await core.checkContradictions({ requestId, mindId });
    if (result.kind === "checked") setCheckSmallModel(mindId, result.smallModel);
    else if (result.kind !== "cancelled") {
      setCheckProblem(mindId, result.kind === "nothing" ? { kind: "no-cited" } : result);
    }
  } catch (error) {
    setCheckProblem(mindId, {
      kind: "failed",
      error,
      retry: () => void startContradictionCheck(mindId),
    });
  }
}

/** Checks the Note's cited claims for contradictions now, from "Check for contradictions". */
export async function checkContradictions(mindId: string): Promise<void> {
  if (useChecks.getState().running[mindId]) return;
  dismissContradictions(mindId);
  const requestId = crypto.randomUUID();
  setCheckRunning(mindId, { requestId, action: "contradiction-watch" });
  try {
    await checkContradictionsNow(mindId, requestId);
  } finally {
    setCheckRunning(mindId, null);
  }
}

/**
 * The cited sentences the one Check is checking, against the Folder's other
 * Documents, with the running state left to its caller. A Folder that holds
 * no other Document than those cited says nothing here: the Check itself
 * succeeded, so that is not a problem to report.
 */
export async function watchSentencesNow(
  mindId: string,
  requestId: string,
  stretches: readonly TextStretch[],
  model: ChatModelChoice | null,
): Promise<void> {
  const [first, ...more] = stretches;
  if (!first) return;
  try {
    const result = await core.checkSentences({
      requestId,
      mindId,
      from: first.from,
      to: first.to,
      ...(more.length > 0 && { more: more.map(({ from, to }) => ({ from, to })) }),
      action: "contradiction-watch",
      model,
    });
    if (result.kind === "checked") setCheckSmallModel(mindId, result.smallModel);
    else if (result.kind === "not-ready" || result.kind === "local-mode") {
      setCheckProblem(mindId, result);
    }
  } catch (error) {
    setCheckProblem(mindId, { kind: "failed", error });
  }
}

/**
 * "Check for contradictions": shows the Note, then asks first on a model
 * billed per token, with the estimate when it would show one, or checks at
 * once.
 */
export async function startContradictionCheck(mindId: string): Promise<void> {
  const running = useChecks.getState().running[mindId];
  try {
    await useAppStore.getState().openMind(mindId);
    if (running) return;
    const plan = await core.planContradictionCheck(mindId);
    if (plan.kind !== "ready") {
      dismissContradictions(mindId);
      setCheckProblem(mindId, problemOf(plan));
      return;
    }
    const estimate = await core
      .estimateRun({ items: plan.claims, each: "check", ...(plan.model && { model: plan.model }) })
      .catch(() => null);
    if (estimate === null || estimate.billing !== "per-token") return checkContradictions(mindId);
    setFor("asking", mindId, {
      claims: plan.claims,
      estimate: estimateLine(estimate, translateNow, languageNow()),
    });
  } catch (error) {
    setCheckProblem(mindId, {
      kind: "failed",
      error,
      retry: () => void startContradictionCheck(mindId),
    });
  }
}
