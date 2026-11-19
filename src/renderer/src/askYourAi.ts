/**
 * Ask your AI (#3373): the agents the User can ask about a Note, kept as they change, and the one
 * action that hands one of them a request. Its app opens with the request's line typed where it
 * has a link for that; otherwise the line is copied and the sidebar's foot says where to paste it.
 * Nothing is sent: the User presses send in their own AI. The rest of the request waits in
 * IncarnaMind for that agent, and a check's card says whether it read it (#3419).
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { AgentAsk, AgentPairing, AgentRequest } from "../../core/api";
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

const NO_REQUESTS: readonly AgentRequest[] = [];

const useRequests = create<{ byMind: Readonly<Record<string, readonly AgentRequest[]>> }>()(
  () => ({ byMind: {} }),
);

const keepRequest = (request: AgentRequest) =>
  useRequests.setState(({ byMind }) => {
    const list = byMind[request.mindId];
    if (!list) return { byMind };
    return {
      byMind: {
        ...byMind,
        [request.mindId]: [request, ...list.filter((each) => each.id !== request.id)],
      },
    };
  });

core.on("agents.request", keepRequest);

/** Reads the requests made of the User's own AI about `mindId` while it is shown (#3419). */
export function useReadAgentRequests(mindId: string): void {
  useEffect(() => {
    let current = true;
    core.listAgentRequests(mindId).then((list) => {
      if (!current) return;
      useRequests.setState(({ byMind }) => ({ byMind: { ...byMind, [mindId]: list } }));
    }, useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [mindId]);
}

/** The requests made about `mindId`, the newest first, as last read. */
export const useAgentRequests = (mindId: string | null): readonly AgentRequest[] =>
  useRequests((state) => (mindId === null ? NO_REQUESTS : (state.byMind[mindId] ?? NO_REQUESTS)));

/**
 * Whom the User last asked to fix this sentence, on the check result it shows now, and whether
 * that agent read the request: null once the sentence is edited or checked again, or for an agent
 * that can't read the Note now.
 */
export function askedAbout(
  requests: readonly AgentRequest[],
  agents: readonly AgentPairing[],
  checkId: string,
  sentence: string,
): { agent: string; read: boolean } | null {
  for (const request of requests) {
    const on = request.sentences.some(
      (each) => each.checkId === checkId && each.sentence === sentence,
    );
    if (!on) continue;
    const agent = agents.find((each) => each.id === request.pairingId);
    return agent ? { agent: agent.name, read: request.readAt !== null } : null;
  }
  return null;
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
