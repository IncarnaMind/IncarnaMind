/**
 * What the app needs to know of the User's own AI (#3362): the agents connected, as their
 * pairings say, and the apps they can be set up in.
 */
import { useEffect, useState } from "react";
import type { AgentClient, AgentPairing } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";
import { type Read, useRead } from "./useRead";

// The last read of each, so a step that shows them has them as it opens and its focus lands on
// its first choice, not on whatever was there before they came.
let pairingsRead: AgentPairing[] | null = null;
let clientsRead: AgentClient[] | null = null;

/** The pairings there are, as Settings › AI lists them, kept as they change. */
export function useAgentPairings(): AgentPairing[] | null {
  const reportError = useAppStore((state) => state.reportError);
  const [pairings, setPairings] = useState<AgentPairing[] | null>(pairingsRead);
  useEffect(() => {
    const keep = (list: AgentPairing[]) => {
      pairingsRead = list;
      setPairings(list);
    };
    core.getAgents().then((settings) => keep(settings.pairings), reportError);
    return core.on("agents.changed", (settings) => keep(settings.pairings));
  }, [reportError]);
  return pairings;
}

/**
 * The pairings there are, read as a screen that depends on them reads: a read that failed is said
 * where it failed, with Try again; kept as they change once read.
 */
export function useAgentPairingsRead(): Read<AgentPairing[]> {
  const [changed, setChanged] = useState<AgentPairing[] | null>(null);
  useEffect(
    () =>
      core.on("agents.changed", (settings) => {
        pairingsRead = settings.pairings;
        setChanged(settings.pairings);
      }),
    [],
  );
  const read = useRead("The connected AI apps", () =>
    core.getAgents().then((settings) => {
      pairingsRead = settings.pairings;
      return settings.pairings;
    }),
  );
  if (changed) return { state: "ready", data: changed };
  return read.state === "loading" && pairingsRead ? { state: "ready", data: pairingsRead } : read;
}

/** The agents IncarnaMind can be set up in, those on this computer first (src/core/agents/clients.ts). */
export function useAgentClients(): Read<AgentClient[]> {
  const read = useRead("The agents IncarnaMind can be set up in", () =>
    core.listAgentClients().then((list) => {
      clientsRead = list;
      return list;
    }),
  );
  return read.state === "loading" && clientsRead ? { state: "ready", data: clientsRead } : read;
}

/** The User's own AI is connected, and no model in IncarnaMind works yet. */
export function useAgentAlone(): boolean {
  const pairings = useAgentPairings();
  const modelReady = useAppStore((state) => state.chatReadiness?.ready === true);
  return (pairings?.length ?? 0) > 0 && !modelReady;
}

/** Marks that need no look: what the page shows only with every result shown, or still going. */
const QUIET = new Set(["supported", "own-view", "checking"]);

/**
 * Opens a Note and takes the User to its first mark that needs a look, in view and focused, its
 * card closed; the Note's top when none does. The marks draw once the Note has opened.
 */
export function openAtFirstLook(mindId: string, focus: (element: HTMLElement) => void): void {
  useAppStore.getState().openMind(mindId);
  const until = performance.now() + 3000;
  const look = () => {
    const pane = document.querySelector(`[data-testid="mind-pane"][data-mind-id="${mindId}"]`);
    const mark = [
      ...(pane?.querySelectorAll<HTMLElement>('[data-testid="claim-mark"]') ?? []),
    ].find((each) => !QUIET.has(each.dataset.check ?? ""));
    if (mark) focus(mark);
    else if (performance.now() < until) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}
