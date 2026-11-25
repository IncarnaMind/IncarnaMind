/**
 * The assistant for a User whose own AI is the way to ask and who set up no model (#3373, #3612):
 * its panel is never shown, whatever it was before, and a Note asks their own AI from its foot.
 * Their AI is the way once they connected one, and stays it after they disconnect it, so the
 * panel never comes back for that (#3764). The one exception is a Conversation they already have,
 * opened to be read: the panel shows it until they fold it. Folded for their AI, it opens as it
 * was once a model is set up.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { AgentPairing } from "../../core/api";
import {
  agentsToAsk,
  noModel,
  ownAiRunsHereNow,
  useAgentsToAsk,
  useAgentsToAskRead,
  useNoModel,
  useOwnAiRunsHere,
  useReadAgentsToAsk,
} from "./askYourAi";
import { useClaudeCodeInstallAvailability } from "./claudeCodeInstall";
import { core } from "./core";
import { assistantTabOf, documentsOnScreenOf, groupsMerged } from "./layoutSlice";
import { useAppStore } from "./store";
import { useGroupsMerged } from "./useWindowWidth";

/**
 * Connecting the User's own AI is on: connecting one turns it on, and disconnecting it leaves it
 * on; null until read.
 */
const useAgentsOn = create<{ on: boolean | null }>(() => ({ on: null }));

function useReadAgentsOn(): void {
  useEffect(() => {
    let current = true;
    core.getAgents().then((settings) => {
      if (current) useAgentsOn.setState({ on: settings.enabled });
    }, useAppStore.getState().reportError);
    const stop = core.on("agents.changed", (settings) =>
      useAgentsOn.setState({ on: settings.enabled }),
    );
    return () => {
      current = false;
      stop();
    };
  }, []);
}

/**
 * Only their own AI asks for the User: no model in IncarnaMind, and an AI of theirs connected
 * now or before; null until all three are known.
 */
export function useOwnAiOnly(): boolean | null {
  const known = useAppStore((state) => state.chatReadiness !== null);
  const without = useNoModel();
  const agents = useAgentsToAskRead(null);
  const on = useAgentsOn((state) => state.on);
  if (!known || agents === null || on === null) return null;
  return without && (agents.length > 0 || on);
}

export const ownAiOnlyNow = (): boolean =>
  noModel() && (agentsToAsk(null).length > 0 || useAgentsOn.getState().on === true);

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
  useReadAgentsOn();
  useClaudeCodeInstallAvailability();
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

/**
 * What the pill asks about: the Note the assistant reads, else the Document in front. A Note no
 * connected AI may read (an example's, which a new User has open) gives way to the Document opened
 * beside it, so the pill doesn't go when the User opens one there.
 */
interface AskedOn {
  mindId: string | null;
  documentId: string | null;
}

const NOTHING: AskedOn = { mindId: null, documentId: null };

/** `noteAgents`: the agents that may read `mindId`; null until they are read, when the Note stands. */
const askedOn = (
  mindId: string | null,
  documentId: string | null,
  noteAgents: readonly AgentPairing[] | null,
): AskedOn =>
  mindId !== null && (noteAgents === null || noteAgents.length > 0 || documentId === null)
    ? { mindId, documentId: null }
    : documentId !== null
      ? { mindId: null, documentId }
      : NOTHING;

const askedOnOf = (merged: boolean): AskedOn => {
  const { layout } = useAppStore.getState();
  const tab = assistantTabOf(layout, merged);
  const mindId = tab?.item.kind === "mind" ? tab.item.mindId : null;
  const [documentId = null] = documentsOnScreenOf(layout, merged);
  return askedOn(mindId, documentId, mindId === null ? null : agentsToAsk(mindId));
};

/**
 * An agent IncarnaMind can run in the background, its command line on this computer: a Note it can
 * read has its own input (#3627).
 */
export const runsInBackground = (pairing: AgentPairing, runsHere: boolean): boolean =>
  runsHere && pairing.client === "claude-code";

const pillOf = (
  hidden: boolean,
  on: AskedOn,
  agents: readonly AgentPairing[],
  runsHere: boolean,
): OwnAiPill | null =>
  hidden &&
  (on.mindId !== null || on.documentId !== null) &&
  agents.length > 0 &&
  // The Note's own input asks in its place.
  !(on.mindId !== null && agents.some((each) => runsInBackground(each, runsHere)))
    ? { ...on, agents }
    : null;

/** The Note or Document the pill asks about, followed. */
function useAskedOn(): AskedOn {
  const merged = useGroupsMerged();
  const mindId = useAppStore((state) => {
    const tab = assistantTabOf(state.layout, merged);
    return tab?.item.kind === "mind" ? tab.item.mindId : null;
  });
  const documentId = useAppStore((state) => documentsOnScreenOf(state.layout, merged)[0] ?? null);
  useReadAgentsToAsk(mindId);
  const noteAgents = useAgentsToAskRead(mindId);
  return askedOn(mindId, documentId, mindId === null ? null : noteAgents);
}

/**
 * The pill stands at the foot of the Note it asks about, as the Note's own input does, never over
 * a Document (#3764): a Document is asked about from the Note beside it or from its own menu.
 */
const atNote = (pill: OwnAiPill | null): OwnAiPill | null => (pill?.mindId ? pill : null);

/** Whether a Note's Ask pill shows. */
export function useOwnAiPillShown(): boolean {
  return useOwnAiPill() !== null;
}

/** The pill's Note and agents, with the panel out of sight for a User with only their own AI; null otherwise. */
export function useOwnAiPill(): OwnAiPill | null {
  const hidden = useHiddenForOwnAi();
  const on = useAskedOn();
  useReadAgentsToAsk(on.mindId, on.documentId ?? undefined);
  const runsHere = useOwnAiRunsHere();
  return atNote(
    pillOf(hidden, on, useAgentsToAsk(on.mindId, on.documentId ?? undefined), runsHere),
  );
}

/**
 * What ⌘J hands their own AI, read once: the Note the pill asks about, or the Document in front
 * with no Note to ask from, as the viewer's Ask about this names ⌘J.
 */
export function ownAiPillNow(): OwnAiPill | null {
  const on = askedOnOf(groupsMerged());
  return pillOf(
    hiddenForOwnAiNow(),
    on,
    agentsToAsk(on.mindId, on.documentId ?? undefined),
    ownAiRunsHereNow(),
  );
}

/**
 * With only their own AI as the way to ask, none of theirs reads this Note, disconnected or never
 * given its Folder: its foot says so, with the one way to fix it (#3764).
 */
export function useNoAiForNote(mindId: string): boolean {
  const only = useOwnAiOnly();
  useReadAgentsToAsk(mindId);
  const agents = useAgentsToAskRead(mindId);
  return only === true && agents !== null && agents.length === 0;
}

/** With only their own AI as the way to ask, none of theirs is connected: nothing offers to ask. */
export function useNoAiConnected(): boolean {
  const only = useOwnAiOnly();
  const agents = useAgentsToAskRead(null);
  return only === true && agents !== null && agents.length === 0;
}
