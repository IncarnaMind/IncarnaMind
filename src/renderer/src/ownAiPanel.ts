/**
 * The assistant for a User whose own AI is connected and who set up no model (#3373, #3612): its
 * panel is never shown, whatever it was before, and the pill at the foot of a Note or a Document
 * asks their own AI about it, as ⌘J does. The one exception is a Conversation they already have,
 * opened to be read: the panel shows it until they fold it. Folded for their AI, it opens as it
 * was once a model is set up.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { AgentPairing } from "../../core/api";
import {
  agentsToAsk,
  noModel,
  useAgentsToAsk,
  useAgentsToAskRead,
  useNoModel,
  useReadAgentsToAsk,
} from "./askYourAi";
import { assistantTabOf, documentsOnScreenOf, groupsMerged } from "./layoutSlice";
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

/** A Conversation the User opened to read, which the panel shows until they fold it. */
const useReading = create<{ reading: boolean }>(() => ({ reading: false }));

export const readConversationForOwnAi = (): void => useReading.setState({ reading: true });

/** The panel is out of sight for a User with only their own AI: no rail, no commands, no keys. */
export function useHiddenForOwnAi(): boolean {
  const only = useOwnAiOnly();
  const reading = useReading((state) => state.reading);
  return only === true && !reading;
}

export const hiddenForOwnAiNow = (): boolean => ownAiOnlyNow() && !useReading.getState().reading;

/** IncarnaMind's own model, from the pill's ⌄: set up in Settings › AI, where the panel comes back once it works. */
export function setUpModelInstead(): void {
  useAppStore.getState().openSettings("ai", "model");
}

/**
 * Folds the assistant for a User with only their own AI, unless they are reading a Conversation
 * in it, so a window opened again doesn't show it before their AI is known (#3612), and ends the
 * reading when they fold it; unfolds it again when that ends, if it was folded for that alone.
 */
export function useFoldForOwnAi(): void {
  useReadAgentsToAsk(null);
  const only = useOwnAiOnly();
  const reading = useReading((state) => state.reading);
  const place = useAppStore((state) => state.layout?.assistant ?? null);
  useEffect(() => {
    if (only === null || !place) return;
    // Folded by the User, the Conversation they were reading goes out of sight with it.
    if (reading && place.folded) {
      useReading.setState({ reading: false });
      return;
    }
    const { placeAssistant } = useAppStore.getState();
    if (only && !place.folded && !reading) void placeAssistant({ folded: true, foldedBy: "agent" });
    else if (!only && place.folded && place.foldedBy === "agent") {
      void placeAssistant({ folded: false, foldedBy: null });
    }
  }, [only, place, reading]);
}

export interface OwnAiPill {
  /** The Note the User is in, which the request names; null on a Document. */
  mindId: string | null;
  /** The Document in front, with no Note on screen. */
  documentId: string | null;
  /** The one connected or used last first. */
  agents: readonly AgentPairing[];
}

/** What the pill asks about: the Note the assistant reads, else the Document in front. */
interface AskedOn {
  mindId: string | null;
  documentId: string | null;
}

const NOTHING: AskedOn = { mindId: null, documentId: null };

const askedOnOf = (merged: boolean): AskedOn => {
  const { layout } = useAppStore.getState();
  const tab = assistantTabOf(layout, merged);
  if (tab?.item.kind === "mind") return { mindId: tab.item.mindId, documentId: null };
  const [documentId] = documentsOnScreenOf(layout, merged);
  return documentId ? { mindId: null, documentId } : NOTHING;
};

/** An agent IncarnaMind can run in the background: a Note it can read has its own input (#3627). */
export const runsInBackground = (pairing: AgentPairing): boolean =>
  pairing.client === "claude-code";

const pillOf = (hidden: boolean, on: AskedOn, agents: readonly AgentPairing[]): OwnAiPill | null =>
  hidden &&
  (on.mindId !== null || on.documentId !== null) &&
  agents.length > 0 &&
  // The Note's own input asks in its place.
  !(on.mindId !== null && agents.some(runsInBackground))
    ? { ...on, agents }
    : null;

/** The Note or Document the pill asks about, followed. */
function useAskedOn(): AskedOn {
  const merged = useGroupsMerged();
  const mindId = useAppStore((state) => {
    const tab = assistantTabOf(state.layout, merged);
    return tab?.item.kind === "mind" ? tab.item.mindId : null;
  });
  const documentId = useAppStore((state) =>
    mindId === null ? (documentsOnScreenOf(state.layout, merged)[0] ?? null) : null,
  );
  return mindId !== null || documentId !== null ? { mindId, documentId } : NOTHING;
}

/** Whether the pill shows, as the Workbench reads its agents: for a page that makes room for it. */
export function useOwnAiPillShown(): boolean {
  const hidden = useHiddenForOwnAi();
  const on = useAskedOn();
  return pillOf(hidden, on, useAgentsToAsk(on.mindId, on.documentId ?? undefined)) !== null;
}

/** The pill's Note or Document and agents, with the panel out of sight for a User with only their own AI; null otherwise. */
export function useOwnAiPill(): OwnAiPill | null {
  const hidden = useHiddenForOwnAi();
  const on = useAskedOn();
  useReadAgentsToAsk(on.mindId, on.documentId ?? undefined);
  return pillOf(hidden, on, useAgentsToAsk(on.mindId, on.documentId ?? undefined));
}

/** The same, read once: what ⌘J asks while the pill shows. */
export function ownAiPillNow(): OwnAiPill | null {
  const on = askedOnOf(groupsMerged());
  return pillOf(hiddenForOwnAiNow(), on, agentsToAsk(on.mindId, on.documentId ?? undefined));
}

/** The Note a question typed elsewhere (⌘K, the Library) is about: the one the assistant reads. */
export const ownAiNoteNow = (): string | null => askedOnOf(groupsMerged()).mindId;
