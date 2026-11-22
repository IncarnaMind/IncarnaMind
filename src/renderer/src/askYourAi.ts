/**
 * Ask your AI (#3373): the agents the User can ask about a Note, kept as they change, and the one
 * action that hands one of them a request. Its app opens with the request's line typed where it
 * has a link for that; otherwise the line is copied. Either way the sidebar's foot says where the
 * line went: a link's app can open behind this window, and Claude Code's opens a new terminal
 * window, not the session the User has.
 * Nothing is sent: the User presses send in their own AI. The rest of the request waits in
 * IncarnaMind for that agent, and a check's card says whether it read it (#3419).
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { AgentAsk, AgentPairing, AgentRequest, SearchScope } from "../../core/api";
import { TranslatableError } from "../../core/errors";
import { type AskedFor, checkInBackground, rememberAsked } from "./askedAgent";
import { core } from "./core";
import { documentsOnScreen } from "./documentsOnScreen";
import { noModelSetUp } from "./noModelSetUp";
import { useNotices } from "./notices";
import { useAppStore } from "./store";

const NONE: readonly AgentPairing[] = [];
/** The key of the agents for no Note: a question in the assistant with none in focus. */
const keyOf = (mindId: string | null, documentId?: string) =>
  documentId ? `${mindId}/${documentId}` : (mindId ?? "");

const useAskable = create<{
  byMind: Readonly<Record<string, readonly AgentPairing[]>>;
  /** Whether the User's own command-line AI can run here in the background, as last read. */
  runsHere: boolean;
}>()(() => ({
  byMind: {},
  runsHere: false,
}));

/** Whether a Note's own input can run the User's command-line AI here (ADR-0034), as last read. */
export const ownAiRunsHereNow = (): boolean => useAskable.getState().runsHere;
export const useOwnAiRunsHere = (): boolean => useAskable((state) => state.runsHere);

/** The agents the User can ask about `mindId` now, as last read, the one connected or used last first. */
export const agentsToAsk = (mindId: string | null, documentId?: string): readonly AgentPairing[] =>
  useAskable.getState().byMind[keyOf(mindId, documentId)] ?? NONE;

export const useAgentsToAsk = (
  mindId: string | null,
  documentId?: string,
): readonly AgentPairing[] =>
  useAskable((state) => state.byMind[keyOf(mindId, documentId)] ?? NONE);

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
      // Read with the agents, as a Note opens: their command line may have been installed since.
      Promise.all([core.listAgentsToAsk(mindId, documentId), core.ownAiRunsHere()]).then(
        ([agents, runsHere]) => {
          if (!current) return;
          useAskable.setState(({ byMind }) => ({
            byMind: { ...byMind, [keyOf(mindId, documentId)]: agents },
            runsHere,
          }));
        },
        useAppStore.getState().reportError,
      );
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

const useRequests = create<{ byMind: Readonly<Record<string, readonly AgentRequest[]>> }>()(() => ({
  byMind: {},
}));

const keepRequest = (request: AgentRequest & { mindId: string }) =>
  useRequests.setState(({ byMind }) => {
    const list = byMind[request.mindId];
    if (!list) return { byMind };
    // A request read keeps its place: the newest made comes first.
    const known = list.some((each) => each.id === request.id);
    return {
      byMind: {
        ...byMind,
        [request.mindId]: known
          ? list.map((each) => (each.id === request.id ? request : each))
          : [request, ...list],
      },
    };
  });

/** Reads the requests made of the User's own AI about `mindId` while it is shown (#3419). */
export function useReadAgentRequests(mindId: string): void {
  useEffect(() => {
    let current = true;
    core.listAgentRequests(mindId).then((list) => {
      if (!current) return;
      useRequests.setState(({ byMind }) => ({ byMind: { ...byMind, [mindId]: list } }));
    }, useAppStore.getState().reportError);
    const stop = core.on("agents.request", (request) => {
      if (request.mindId === mindId) keepRequest({ ...request, mindId });
    });
    return () => {
      current = false;
      stop();
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
  noModelSetUp(state.chatReadiness);

/** No model is set up in IncarnaMind: the User's own AI is the way to ask, where one is connected. */
export const noModel = (): boolean => noModelIn(useAppStore.getState());
export const useNoModel = (): boolean => useAppStore(noModelIn);

/**
 * Hands `ask` to `agent`. A question goes with what the User is looking at, as the assistant is
 * told it: the Documents open on screen and the chat box's Search scope (#3533), or the Documents
 * a Library ask names (`onScreen`, #3612). `openChat`: for the chat the User has open there, the
 * line copied and no new chat opened (#3588). Resolves to whether it went: a failure is a notice.
 */
export async function askAgent(
  agent: AgentPairing,
  mindId: string | null,
  ask: AgentAsk,
  scope?: SearchScope,
  { openChat = false, onScreen }: { openChat?: boolean; onScreen?: readonly string[] } = {},
): Promise<boolean> {
  try {
    const at = new Date().toISOString();
    const result = await core.askAgent({
      pairingId: agent.id,
      mindId,
      ask,
      ...(ask.kind === "question" && {
        onScreen: onScreen ? [...onScreen] : documentsOnScreen(),
        scope: scope ?? null,
      }),
      ...(openChat && { openChat: true }),
    });
    if (result.kind === "copy") await navigator.clipboard.writeText(result.text);
    // Only once it is copied: the app can take the focus the copy needs.
    const fronted = openChat && (await core.frontAgent(agent.id));
    const about: AskedFor | null =
      ask.kind === "check" && mindId !== null
        ? { kind: "check", mindId }
        : ask.kind === "summary"
          ? { kind: "summary", documentId: ask.documentId }
          : ask.kind === "organize"
            ? { kind: "organize", target: ask.target }
            : ask.kind === "selection" && mindId !== null
              ? { kind: ask.action === "explain" ? "explain" : "change", mindId }
              : null;
    if (about) rememberAsked(agent, about, { copied: result.kind === "copy", at });
    useNotices
      .getState()
      .confirm(
        result.kind === "opened"
          ? "agents.ask.opened"
          : !openChat
            ? "agents.ask.copied"
            : fronted
              ? "agents.ask.continued"
              : "agents.ask.continueCopied",
        { agent: agent.name },
      );
    return true;
  } catch (error) {
    useAppStore.getState().reportError(error);
    return false;
  }
}

/**
 * Hands `ask` to the User's own AI the Ask pill asks, connected or used last, among those that can
 * read the Note, or the Document (`documentId`). "none": no AI of theirs reads it; "failed": the
 * notice says why.
 */
export async function askFirstAgent(
  mindId: string | null,
  ask: AgentAsk,
  {
    documentId,
    scope,
    onScreen,
  }: { documentId?: string; scope?: SearchScope; onScreen?: readonly string[] } = {},
): Promise<"asked" | "failed" | "none"> {
  try {
    const [agent] = await core.listAgentsToAsk(mindId, ...(documentId ? [documentId] : []));
    if (!agent) return "none";
    return (await askAgent(agent, mindId, ask, scope, { onScreen })) ? "asked" : "failed";
  } catch (error) {
    useAppStore.getState().reportError(error);
    return "failed";
  }
}

/**
 * A Check with no model set up goes to the User's own AI at once (#3587): in the background where
 * their command-line AI can run it (#3606), else by the link. Whether it went.
 */
export async function askToCheck(mindId: string): Promise<boolean> {
  try {
    if (await checkInBackground(mindId)) return true;
  } catch (error) {
    useAppStore.getState().reportError(error);
    return false;
  }
  return (await askFirstAgent(mindId, { kind: "check" })) === "asked";
}

/**
 * What the Ask pill and ⌘J hand over (#3612): the Note the User is in, or else the Document in
 * front, with no question yet: the User types it in their own AI.
 */
export const askOnPill = (
  agent: AgentPairing,
  on: { mindId: string | null; documentId: string | null },
  openChat = false,
): Promise<boolean> =>
  on.mindId !== null || on.documentId === null
    ? askAgent(agent, on.mindId, { kind: "note" }, undefined, { openChat })
    : askAgent(agent, null, { kind: "question", text: "" }, undefined, {
        openChat,
        onScreen: [on.documentId],
      });

/**
 * Ask about these Documents or this Folder, for a User with only their own AI (#3612): the line
 * names them, one Document as the one in front, and the User types their question there. With no
 * AI of theirs that reads the one Document, a notice says so.
 */
export async function askOwnAiAbout(scope: SearchScope): Promise<void> {
  const [only, ...more] = scope.documentIds;
  const one = only !== undefined && more.length === 0 && scope.folderIds.length === 0;
  const went = await askFirstAgent(
    null,
    { kind: "question", text: "" },
    one ? { documentId: only, onScreen: [only] } : { scope, onScreen: [] },
  );
  if (went === "none" && one) {
    useAppStore
      .getState()
      .reportError(new TranslatableError({ key: "error.agent.cantAskDocument" }));
  }
}
