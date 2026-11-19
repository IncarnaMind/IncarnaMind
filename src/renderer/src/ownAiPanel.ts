/**
 * The assistant for a User whose own AI is connected and who set up no model (#3373): its panel
 * starts folded and out of sight, as the quiet assistant of a first open is, until the User opens
 * or folds it themselves; while it is folded the pill at the foot of the page asks their own AI
 * about the Note, as ⌘J does.
 */
import { useEffect } from "react";
import type { AgentPairing, AssistantPlace } from "../../core/api";
import {
  agentsToAsk,
  noModel,
  useAgentsToAsk,
  useAgentsToAskRead,
  useNoModel,
  useReadAgentsToAsk,
} from "./askYourAi";
import { assistantTabOf, groupsMerged } from "./layoutSlice";
import { chooseModelInPlace } from "./modelSetup";
import { useAppStore } from "./store";
import { useGroupsMerged } from "./useWindowWidth";

/** Only their own AI asks for the User: connected, and no model in IncarnaMind; null until both are known. */
export function useOwnAiOnly(): boolean | null {
  const known = useAppStore((state) => state.chatReadiness !== null);
  const without = useNoModel();
  const agents = useAgentsToAskRead(null);
  if (!known || agents === null) return null;
  return without && agents.length > 0;
}

export const ownAiOnlyNow = (): boolean => noModel() && agentsToAsk(null).length > 0;

const foldedForOwnAi = (place: AssistantPlace | undefined) =>
  place?.folded === true && place.foldedBy === "agent";

/** Folded for their own AI, never by the User: no rail, the panel out of sight. */
export function useHiddenForOwnAi(): boolean {
  const only = useOwnAiOnly();
  return useAppStore((state) => only === true && foldedForOwnAi(state.layout?.assistant));
}

export const hiddenForOwnAiNow = (): boolean =>
  ownAiOnlyNow() && foldedForOwnAi(useAppStore.getState().layout?.assistant);

/** IncarnaMind's own chat, from the pill: the panel opens, as the User's own choice, on model setup. */
export function setUpModelInstead(): void {
  void useAppStore.getState().placeAssistant({ folded: false });
  chooseModelInPlace();
}

/**
 * Folds the assistant for a User with only their own AI, while they have never folded or unfolded
 * it themselves, and unfolds it again when that ends, if it was folded for that alone.
 */
export function useFoldForOwnAi(): void {
  useReadAgentsToAsk(null);
  const only = useOwnAiOnly();
  const place = useAppStore((state) => state.layout?.assistant ?? null);
  useEffect(() => {
    if (only === null || !place || place.foldedBy === "user") return;
    const { placeAssistant } = useAppStore.getState();
    if (only && !place.folded) void placeAssistant({ folded: true, foldedBy: "agent" });
    else if (!only && place.folded && place.foldedBy === "agent") {
      void placeAssistant({ folded: false, foldedBy: null });
    }
  }, [only, place]);
}

export interface OwnAiPill {
  /** The Note the User is in, which the request names. */
  mindId: string;
  /** The one connected or used last first. */
  agents: readonly AgentPairing[];
}

const pillOf = (
  only: boolean | null,
  folded: boolean,
  mindId: string | null,
  agents: readonly AgentPairing[],
): OwnAiPill | null =>
  only && folded && mindId !== null && agents.length > 0 ? { mindId, agents } : null;

const mindIn = (merged: boolean) => {
  const tab = assistantTabOf(useAppStore.getState().layout, merged);
  return tab?.item.kind === "mind" ? tab.item.mindId : null;
};

/** The Note the User is in, as the assistant reads it. */
function useMindIn(): string | null {
  const merged = useGroupsMerged();
  return useAppStore((state) => {
    const tab = assistantTabOf(state.layout, merged);
    return tab?.item.kind === "mind" ? tab.item.mindId : null;
  });
}

/** Whether the pill shows, as the Workbench reads its agents: for a page that makes room for it. */
export function useOwnAiPillShown(): boolean {
  const only = useOwnAiOnly();
  const folded = useAppStore((state) => only === true && state.layout?.assistant.folded === true);
  const mindId = useMindIn();
  return pillOf(only, folded, mindId, useAgentsToAsk(mindId)) !== null;
}

/** The pill's Note and agents, with the assistant folded for a User with only their own AI; null otherwise. */
export function useOwnAiPill(): OwnAiPill | null {
  const only = useOwnAiOnly();
  const folded = useAppStore((state) => only === true && state.layout?.assistant.folded === true);
  const mindId = useMindIn();
  useReadAgentsToAsk(mindId);
  return pillOf(only, folded, mindId, useAgentsToAsk(mindId));
}

/** The same, read once: what ⌘J asks while the pill shows. */
export function ownAiPillNow(): OwnAiPill | null {
  const mindId = mindIn(groupsMerged());
  return pillOf(
    ownAiOnlyNow(),
    useAppStore.getState().layout?.assistant.folded === true,
    mindId,
    agentsToAsk(mindId),
  );
}
