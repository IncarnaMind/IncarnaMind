/**
 * Research (#130), the window's side: the plan each Mind may have open in the
 * tray, from the topic asked until it is started or cancelled. The core plans
 * it with the composer's model; the User edits its steps, sources and where
 * it writes; Start makes it a Task, whose progress then shows in the thread.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import type {
  ChatModelChoice,
  ChatProviderKind,
  ProviderError,
  ResearchPlanResult,
  ResearchSources,
  ResearchStartResult,
  ResearchTarget,
  Task,
} from "../../core/api";
import { MAX_RESEARCH_STEPS } from "../../shared/research";
import { searchesTheWeb } from "../../shared/webSearch";
import { composerScope, NO_MIND, useComposer } from "./composer";
import { core } from "./core";
import { useT } from "./i18n";
import { useModelNames } from "./modelNames";
import { useAppStore } from "./store";
import { showTask, useTasks } from "./tasks";

const report = (error: unknown) => useAppStore.getState().reportError(error);

/** Whether a Research Task with this model can search the web, or why not. */
export type WebReach = "ready" | "off" | "local-mode" | "unsupported";

/** Whether research with `model` (the model in use) can search the web (#128): on, off this computer, a provider that searches. */
export function useWebReach(model: ChatModelChoice | null): WebReach {
  const on = useAppStore((state) => state.settings?.user.webSearch === true);
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const providerId = model?.providerId ?? null;
  const [kinds, setKinds] = useState<Readonly<Record<string, ChatProviderKind>>>({});
  const known = providerId !== null && kinds[providerId] !== undefined;
  useEffect(() => {
    if (providerId === null || known) return;
    let current = true;
    core.listChatProviders().then((providers) => {
      if (current) setKinds(Object.fromEntries(providers.map((each) => [each.id, each.kind])));
    }, report);
    return () => {
      current = false;
    };
  }, [providerId, known]);
  const kind = providerId === null ? undefined : kinds[providerId];
  if (localOnly) return "local-mode";
  if (!kind || !searchesTheWeb(kind)) return "unsupported";
  return on ? "ready" : "off";
}

/** Why research with `model` reads the Library only, in the interface's words; null when it can search the web. */
export function useWebMissing(reach: WebReach, model: ChatModelChoice | null): string | null {
  const t = useT();
  const nameOf = useModelNames();
  if (reach === "ready") return null;
  if (reach === "off") return t("research.plan.webOff");
  if (reach === "local-mode") return t("research.plan.localMode");
  return t("research.plan.webUnavailable", {
    model: model ? nameOf(model.modelId, model.providerId).name : t("answer.error.thisModel"),
  });
}

/** Why the plan has no steps from the model, or the Task didn't start. */
export type ResearchProblem =
  | Exclude<ResearchStartResult, { started: true }>
  | { reason: "failed"; error: ProviderError };

export interface ResearchPlanCard {
  topic: string;
  /** When it was asked: the thread shows the topic there. */
  askedAt: string;
  /** The model is making or redoing the plan. */
  planning: boolean;
  /** Asking the core to start it: Start waits, and a second press does nothing. */
  starting: boolean;
  title: string;
  steps: readonly string[];
  sources: ResearchSources;
  writeInto: ResearchTarget;
  problem: ResearchProblem | null;
}

interface ResearchStore {
  /** The open plans, by the Mind the assistant read when each was asked. */
  plans: Readonly<Record<string, ResearchPlanCard>>;
  /** A running Task's plan shown in the tray (Plan in its progress), by its Mind: the Task's id. */
  viewing: Readonly<Record<string, string>>;
}

export const useResearch = create<ResearchStore>()(() => ({ plans: {}, viewing: {} }));

/** Plan, in a running Research's progress: its plan shows in the tray, or goes again. */
export function togglePlanView(task: Task): void {
  const { mindId } = task;
  if (!mindId) return;
  if (useResearch.getState().viewing[mindId] === task.id) closePlanView(mindId);
  else useResearch.setState((state) => ({ viewing: { ...state.viewing, [mindId]: task.id } }));
}

export function closePlanView(mindId: string): void {
  useResearch.setState((state) => {
    const { [mindId]: _closed, ...viewing } = state.viewing;
    return { viewing };
  });
}

export function updatePlan(mindId: string, change: Partial<ResearchPlanCard>): void {
  useResearch.setState((state) => {
    const open = state.plans[mindId];
    return open ? { plans: { ...state.plans, [mindId]: { ...open, ...change } } } : {};
  });
}

function closePlan(mindId: string): void {
  useResearch.setState((state) => {
    const { [mindId]: _closed, ...plans } = state.plans;
    return { plans };
  });
}

/** Cancel: the card closes, and its topic comes back to the composer to be asked again. */
export function cancelResearch(mindId: string): void {
  const card = useResearch.getState().plans[mindId];
  if (!card) return;
  closePlan(mindId);
  useComposer.getState().update(mindId, { text: card.topic, research: true });
  useComposer.getState().requestFocus();
}

const problemOf = (result: Exclude<ResearchPlanResult, { planned: true }>): ResearchProblem =>
  result.reason === "failed"
    ? { reason: "failed", error: result.error }
    : result.reason === "not-ready"
      ? { started: false, reason: "not-ready", readiness: result.readiness }
      : { started: false, reason: "consent-declined" };

/** Asks the model for the plan, or to redo it as `change` says, and puts it on the card. */
async function plan(
  mindId: string,
  model: ChatModelChoice | null,
  change: string | null,
): Promise<void> {
  const card = useResearch.getState().plans[mindId];
  if (!card) return;
  updatePlan(mindId, { planning: true, problem: null });
  try {
    const result = await core.planResearch({
      mindId: mindId === NO_MIND ? null : mindId,
      topic: card.topic,
      sources: card.sources,
      model,
      change: change ? { steps: [...card.steps], text: change } : null,
    });
    if (useResearch.getState().plans[mindId]?.askedAt !== card.askedAt) return;
    if (result.planned) {
      updatePlan(mindId, { title: result.plan.title, steps: result.plan.steps, planning: false });
    } else {
      updatePlan(mindId, {
        planning: false,
        problem: problemOf(result),
        // With no plan, one empty step to write it by hand.
        steps: card.steps.length > 0 ? card.steps : [""],
      });
    }
  } catch (error) {
    updatePlan(mindId, { planning: false, steps: card.steps.length > 0 ? card.steps : [""] });
    report(error);
  }
}

/**
 * Research… then a topic: the plan card opens in the tray, and the model
 * proposes its steps. Web is on when the model can search it.
 */
export function openResearch(
  mindId: string,
  topic: string,
  model: ChatModelChoice | null,
  web: boolean,
): void {
  useResearch.setState((state) => ({
    plans: {
      ...state.plans,
      [mindId]: {
        topic,
        askedAt: new Date().toISOString(),
        planning: true,
        starting: false,
        title: topic,
        steps: [],
        sources: { web, library: true },
        // With no Mind in focus there is none to write into: a new one, as its card says.
        writeInto: mindId === NO_MIND ? { newMind: true } : { mindId },
        problem: null,
      },
    },
  }));
  void plan(mindId, model, null);
}

/** "Change the plan…": the model redoes the steps as the User said. */
export const changePlan = (mindId: string, text: string, model: ChatModelChoice | null) =>
  plan(mindId, model, text);

/** The model makes the plan again, after it failed. */
export const planAgain = (mindId: string, model: ChatModelChoice | null) =>
  plan(mindId, model, null);

/** A step's text changed, one added after `at` (Enter), or one taken out (Backspace in an empty one). */
export function setStep(mindId: string, at: number, text: string): void {
  const card = useResearch.getState().plans[mindId];
  if (!card) return;
  updatePlan(mindId, { steps: card.steps.map((step, index) => (index === at ? text : step)) });
}

export function addStep(mindId: string, after: number): boolean {
  const card = useResearch.getState().plans[mindId];
  if (!card || card.steps.length >= MAX_RESEARCH_STEPS) return false;
  updatePlan(mindId, {
    steps: [...card.steps.slice(0, after + 1), "", ...card.steps.slice(after + 1)],
  });
  return true;
}

export function removeStep(mindId: string, at: number): void {
  const card = useResearch.getState().plans[mindId];
  if (!card || card.steps.length <= 1) return;
  updatePlan(mindId, { steps: card.steps.filter((_, index) => index !== at) });
}

/** The steps as they would be started: their text, blank ones left out. */
export const stepsOf = (card: ResearchPlanCard) =>
  card.steps.map((step) => step.trim()).filter((step) => step !== "");

/**
 * Start: the plan becomes a Task, the card closes and its progress shows in
 * the thread. Resolves with whether it started (the card says why not).
 */
export async function startResearch(
  mindId: string,
  model: ChatModelChoice | null,
): Promise<boolean> {
  const card = useResearch.getState().plans[mindId];
  if (!card || card.starting || card.planning) return false;
  const steps = stepsOf(card);
  if (steps.length === 0) return false;
  const folderId = useAppStore.getState().minds.find((each) => each.id === mindId)?.folderId;
  const scope = composerScope(useComposer.getState().draft(mindId), folderId ?? null);
  updatePlan(mindId, { starting: true, problem: null });
  try {
    const result = await core.startResearch({
      mindId: mindId === NO_MIND ? null : mindId,
      topic: card.topic,
      plan: { title: card.title.trim() || card.topic, steps },
      sources: card.sources,
      writeInto: card.writeInto,
      scope,
      model,
    });
    if (!result.started) {
      updatePlan(mindId, { starting: false, problem: result });
      return false;
    }
    const { task } = result;
    useTasks.setState((state) => ({ tasks: { ...state.tasks, [task.id]: task } }));
    closePlan(mindId);
    // Its Mind is new: show it, where its progress is, as a Task started in a Mind does.
    if (mindId === NO_MIND) showTask(task);
    return true;
  } catch (error) {
    updatePlan(mindId, { starting: false });
    report(error);
    return false;
  }
}
