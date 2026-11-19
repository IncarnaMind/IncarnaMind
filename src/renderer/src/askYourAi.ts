/**
 * Ask your AI (#3373): the agents the User can ask about a Note, kept as they change, and the one
 * action that hands one of them a request. Its app opens with the request typed where it has a
 * link for that; otherwise the request is copied and the sidebar's foot says where to paste it.
 * Nothing is sent: the User presses send in their own AI.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { AgentAsk, AgentPairing } from "../../core/api";
import { core } from "./core";
import { useNotices } from "./notices";
import { useAppStore } from "./store";

const NONE: readonly AgentPairing[] = [];
/** The key of the agents for no Note: a question in the assistant with none in focus. */
const keyOf = (mindId: string | null, documentId?: string) =>
  documentId ? `${mindId}/${documentId}` : (mindId ?? "");

const useAskable = create<{ byMind: Readonly<Record<string, readonly AgentPairing[]>> }>()(() => ({
  byMind: {},
}));

/** The agents the User can ask about `mindId` now, as last read, the one connected or used last first. */
export const agentsToAsk = (mindId: string | null): readonly AgentPairing[] =>
  useAskable.getState().byMind[keyOf(mindId)] ?? NONE;

export const useAgentsToAsk = (mindId: string | null): readonly AgentPairing[] =>
  useAskable((state) => state.byMind[keyOf(mindId)] ?? NONE);

/** As `useAgentsToAsk`, and null until they are first read, so nothing shows that would change. */
export const useAgentsToAskRead = (
  mindId: string | null,
  documentId?: string,
): readonly AgentPairing[] | null =>
  useAskable((state) => state.byMind[keyOf(mindId, documentId)] ?? null);

/**
 * Reads the agents for `mindId` while it is shown, and again as agents change and as the Note
 * or the Folders around it move or gain a wall, which change what an agent reads (#3394), so a
 * card or a line has them before it is opened.
 */
export function useReadAgentsToAsk(mindId: string | null, documentId?: string): void {
  const folderId = useAppStore((state) =>
    mindId === null ? null : (state.minds.find((mind) => mind.id === mindId)?.folderId ?? null),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a Note moved to another Folder can be read by other agents.
  useEffect(() => {
    let current = true;
    const read = () => {
      core.listAgentsToAsk(mindId, documentId).then((agents) => {
        if (!current) return;
        useAskable.setState(({ byMind }) => ({
          byMind: { ...byMind, [keyOf(mindId, documentId)]: agents },
        }));
      }, useAppStore.getState().reportError);
    };
    read();
    const stop = core.on("agents.changed", read);
    const stopLibrary = core.on("library.changed", read);
    return () => {
      current = false;
      stop();
      stopLibrary();
    };
  }, [mindId, folderId, documentId]);
}

const noModelIn = (state: ReturnType<typeof useAppStore.getState>) =>
  state.chatReadiness?.ready === false && state.chatReadiness.reason === "no-provider";

/** No model is set up in IncarnaMind: the User's own AI is the way to ask, where one is connected. */
export const noModel = (): boolean => noModelIn(useAppStore.getState());
export const useNoModel = (): boolean => useAppStore(noModelIn);

/** Hands `ask` to `agent`. Resolves to whether it went: a failure is a notice. */
export async function askAgent(
  agent: AgentPairing,
  mindId: string | null,
  ask: AgentAsk,
): Promise<boolean> {
  try {
    const result = await core.askAgent({ pairingId: agent.id, mindId, ask });
    if (result.kind === "copy") {
      await navigator.clipboard.writeText(result.text);
      useNotices.getState().confirm("agents.ask.copied", { agent: agent.name });
    }
    return true;
  } catch (error) {
    useAppStore.getState().reportError(error);
    return false;
  }
}
