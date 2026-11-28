/**
 * The input at a Note's foot, for a User whose own AI is a command-line one IncarnaMind runs in
 * the background (ADR-0034, #3627, #3731): what is asked, how each request goes as the core tells
 * it ("agents.noteTurn"), and the changes it made in the Note it was asked from, applied at once
 * in the window that asked, with the applied-edit line and its Undo, as the assistant's are
 * (`applyTurn`). Active-conversation, History and persistence state live in `./noteConversations`.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { create } from "zustand";
import type {
  AgentPairing,
  NoteAnswer,
  NoteChangeApplied,
  NoteHeldEdit,
  NoteMode,
  NoteQuestion,
  NoteSelectionBlock,
  NoteStep,
  NoteTurnEvent,
  NoteTurnProblem,
} from "../../core/api";
import { NODE_CHARACTER } from "../../shared/proposals";
import { runnerName } from "./askedAgent";
import {
  agentsToAsk,
  askFirstAgent,
  ownAiRunsHereNow,
  useAgentsToAsk,
  useOwnAiRunsHere,
} from "./askYourAi";
import type { ChangedMind } from "./changedMinds";
import { clientId } from "./clientId";
import { core } from "./core";
import { currentTabOf } from "./layoutSlice";
import {
  connectNoteAskState,
  consumeNoteHistoryRequest,
  deleteNoteConversation,
  moveConversation,
  noteConversationTitle,
  openColumnAt,
  openNoteHistory,
  refreshNoteConversations,
  renameNoteConversation,
  seedConversationFor,
  selectConversation,
  setColumnOpen,
  startNewConversation,
  useColumnOpen,
  useNoteColumns,
  useNoteConversations,
} from "./noteConversations";
import { useNotices } from "./notices";
import { hiddenForOwnAiNow, runsInBackground, useHiddenForOwnAi } from "./ownAiPanel";
import { useAppStore } from "./store";

export {
  consumeNoteHistoryRequest,
  deleteNoteConversation,
  moveConversation,
  noteConversationTitle,
  openColumnAt,
  openNoteHistory,
  refreshNoteConversations,
  renameNoteConversation,
  seedConversationFor,
  selectConversation,
  setColumnOpen,
  startNewConversation,
  useColumnOpen,
  useNoteColumns,
  useNoteConversations,
};

/** What the User asked, and what it was about: the words selected, if any. */
export interface NoteAsked {
  words: string;
  quote: string;
  selection: NoteSelectionBlock[] | null;
  /** With nothing selected, the opening words of the paragraph the cursor is in; "" for none. */
  caret?: string;
}

/** A conversation's latest request, as the input line and conversation body show it. */
export interface NoteAsk {
  conversationId: string | null;
  /** The Note this turn was asked from. */
  mindId: string;
  turnId: string | null;
  pairingId: string;
  agent: string;
  state: NoteTurnEvent["state"];
  doing: NoteTurnEvent["doing"];
  /** When it was sent, ISO 8601 UTC: the line counts the seconds from it while it runs. */
  startedAt: string | null;
  problem: NoteTurnProblem | null;
  versions: { found: string; lowest: string } | null;
  reply: string;
  /** Paragraphs changed at once in the Note asked from (`mindId`). */
  changed: number;
  waiting: NoteTurnEvent["waiting"];
  made: NoteTurnEvent["made"];
  fresh: boolean;
  /** While it works, the AI has sent nothing for a while. */
  quiet: boolean;
  documentsFound: number;
  /** What its AI asks now and waits on, oldest first (#3653). */
  questions: NoteQuestion[];
  /** While it works, the AI's own mode when no earlier request of the conversation ran in it. */
  mode: string | null;
  /** The requests sent into its run meanwhile that the AI hasn't taken yet (#3765). */
  queued: string[];
  /** Its AI ended it at a question it was told no to: what it asked didn't run (#3653). */
  endedAtAsk?: true;
  /** The messages sent meanwhile that IncarnaMind holds until the reply ends, oldest first (#3765). */
  held: string[];
  /** Sent again once the User lets the agent propose changes. */
  asked: NoteAsked;
}

/** Terminal outcome of a turn, kept by turnId even when a follow-up takes the visible slot. */
export interface EndedNoteTurn {
  state: Exclude<NoteTurnEvent["state"], "working">;
  changed: number;
}

export const useNoteAsks = create<{
  byConversation: Readonly<Record<string, NoteAsk>>;
  /**
   * Brief preflight placeholder while a brand-new conversation waits for its id, keyed by
   * pairingId (or mindId when no pairing is cached yet) so switching Notes mid-preflight still
   * sees the pending start (#3731).
   */
  pendingByPairing: Readonly<Record<string, NoteAsk>>;
  /** Latest turn started per mindId, for callers such as Write notes. */
  lastByMind: Readonly<Record<string, { conversationId: string; turnId: string }>>;
  /** Terminal results keyed by turnId so callers waiting on a turn still settle after follow-ups. */
  endedByTurn: Readonly<Record<string, EndedNoteTurn>>;
}>(() => ({
  byConversation: {},
  pendingByPairing: {},
  lastByMind: {},
  endedByTurn: {},
}));

/**
 * Whether a conversation's run goes on: its request works, or one sent into it waits to be taken
 * after the request before ended (#3765). Stop stops it all.
 */
export const isGoing = (ask: NoteAsk | undefined): boolean =>
  ask !== undefined && (ask.state === "working" || ask.queued.length > 0);

/**
 * What the conversation shows of each request beyond IncarnaMind's record (#3677): its steps in
 * order, the model that answered, and how long it took, kept in the window while it is open.
 */
export interface NoteTrail {
  conversationId: string;
  mindId: string;
  state: NoteTurnEvent["state"];
  doing: NoteTurnEvent["doing"];
  steps: NoteStep[];
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  fresh: boolean;
  /** This request began a new conversation after an update changed its instructions (#3653, #3847). */
  renewed: boolean;
  documentsFound: number;
  /** The AI's own mode, as it named it (#3653). */
  mode: string | null;
  /** Since when, in ms since the epoch, a question of its waits on the User; null while none does. */
  askingSince: number | null;
  /** How long, in ms, its questions waited on the User's answers before this one. */
  waitedMs: number;
  /** Paragraphs changed at once in `mindId`. */
  changed: number;
}

export const useNoteTrails = create<{ byTurn: Readonly<Record<string, NoteTrail>> }>(() => ({
  byTurn: {},
}));

const sum = (applied: readonly NoteChangeApplied[], field: "changed" | "added" | "tables") =>
  applied.reduce((total, each) => total + each[field], 0);

const changedInNote = (event: Pick<NoteTurnEvent, "mindId" | "applied">) => {
  const here = event.applied.filter((each) => each.mindId === event.mindId);
  return sum(here, "changed") + sum(here, "added");
};

function keepTrail(event: NoteTurnEvent): void {
  const changed = changedInNote(event);
  useNoteTrails.setState((state) => {
    const was = state.byTurn[event.turnId];
    const ended = event.state !== "working";
    const now = Date.now();
    const asking = !ended && event.questions.length > 0;
    const since = was?.askingSince ?? null;
    return {
      byTurn: {
        ...state.byTurn,
        [event.turnId]: {
          conversationId: event.conversationId,
          mindId: event.mindId,
          state: event.state,
          doing: ended ? (was?.doing ?? null) : event.doing,
          steps: event.steps.length > 0 || !was ? event.steps : was.steps,
          model: event.model ?? was?.model ?? null,
          startedAt: was?.startedAt ?? event.startedAt,
          // An end told again, as a request sent meanwhile waits, ended when it was first told.
          endedAt: ended ? (was?.endedAt ?? new Date().toISOString()) : null,
          fresh: event.fresh || (was?.fresh ?? false),
          renewed: event.renewed || (was?.renewed ?? false),
          documentsFound: Math.max(event.documentsFound, was?.documentsFound ?? 0),
          mode: event.mode ?? was?.mode ?? null,
          askingSince: asking ? (since ?? now) : null,
          waitedMs: (was?.waitedMs ?? 0) + (since !== null && !asking ? now - since : 0),
          changed: Math.max(changed, was?.changed ?? 0),
        },
      },
    };
  });
}

/** The turns this window asked for, whose changes it applies. */
const askedHere = new Set<string>();
/** The tab a turn asked here came from, so its changes land on that tab's kept history (#3839). */
const askedTab = new Map<string, string>();
/** What this window sent into a running request, by its turn, for when its AI takes it (#3765). */
const sentHere = new Map<string, NoteAsked>();

/** By turn: the changes of a turn asked here that ended, being applied in this window. */
const applying = new Map<string, Promise<void>>();

/**
 * Once a turn asked here ended, its changes applied in this window: until then the core holds
 * them as waiting, so what reads the Note after the turn, such as its Check, waits for this.
 */
export const turnApplied = (turnId: string): Promise<void> =>
  applying.get(turnId) ?? Promise.resolve();

/** The background-runnable connected AI that can read `mindId`, or null. */
export function useBackgroundAgent(mindId: string): AgentPairing | null {
  const hidden = useHiddenForOwnAi();
  const agents = useAgentsToAsk(mindId);
  const runsHere = useOwnAiRunsHere();
  if (!hidden) return null;
  return agents.find((each) => runsInBackground(each, runsHere)) ?? null;
}

export function backgroundAgentNow(mindId: string): AgentPairing | null {
  if (!hiddenForOwnAiNow()) return null;
  const runsHere = ownAiRunsHereNow();
  return agentsToAsk(mindId).find((each) => runsInBackground(each, runsHere)) ?? null;
}

/** What a Note's conversation calls the agent that runs it: Codex on a connection still named as listed. */
const nameIn = (pairing: AgentPairing) => runnerName({ agent: pairing, background: true });

/** The name of the agent the Note's input runs on, or "" when none can run here. */
export function useNoteAgentName(mindId: string): string {
  const agents = useAgentsToAsk(mindId);
  const runsHere = useOwnAiRunsHere();
  const agent = agents.find((each) => runsInBackground(each, runsHere));
  return agent ? nameIn(agent) : "";
}

/** Whether the Note shows its input: only the User's own AI asks, and one of its agents can run so. */
export function useNoteAskShown(mindId: string): boolean {
  return useBackgroundAgent(mindId) !== null;
}

export const noteAskShownNow = (mindId: string): boolean => backgroundAgentNow(mindId) !== null;

/** Active conversation id and live ask state for `mindId`'s background agent. */
export function useActiveConversation(mindId: string): {
  pairing: AgentPairing | null;
  conversationId: string | null;
  seeded: boolean;
  ask: NoteAsk | undefined;
} {
  const pairing = useBackgroundAgent(mindId);
  const pairingId = pairing?.id ?? "";
  const conversationId = useNoteColumns((state) =>
    pairingId ? (state.activeByPairing[pairingId] ?? null) : null,
  );
  const seeded = useNoteColumns((state) => (pairingId ? Boolean(state.seeded[pairingId]) : false));
  const ask = useNoteAsks((state) =>
    conversationId !== null
      ? state.byConversation[conversationId]
      : ((pairingId ? state.pendingByPairing[pairingId] : undefined) ??
        state.pendingByPairing[mindId]),
  );
  return { pairing, conversationId, seeded, ask };
}

const putConversation = (conversationId: string, ask: NoteAsk | null) =>
  useNoteAsks.setState((state) => {
    const { [conversationId]: _gone, ...rest } = state.byConversation;
    return { byConversation: ask ? { ...rest, [conversationId]: ask } : rest };
  });

const putPending = (key: string, ask: NoteAsk | null) =>
  useNoteAsks.setState((state) => {
    const { [key]: _gone, ...rest } = state.pendingByPairing;
    return { pendingByPairing: ask ? { ...rest, [key]: ask } : rest };
  });

const nameOf = (mindId: string, pairingId: string) => {
  const pairing = agentsToAsk(mindId).find((each) => each.id === pairingId);
  if (pairing) return nameIn(pairing);
  return (
    useNoteConversations.getState().list.find((each) => each.pairingId === pairingId)?.agent ??
    "Claude Code"
  );
};

/** One Note's changes of a turn, as the applied-edit line counts them. */
const rowOf = (mindId: string, applied: readonly NoteChangeApplied[]): ChangedMind => ({
  mindId,
  created: false,
  filled: false,
  requests: applied.map((each) => each.request),
  wrote: sum(applied, "added"),
  changed: sum(applied, "changed"),
  tables: sum(applied, "tables"),
  charts: 0,
  chartNotDrawn: null,
  unlinkedSources: 0,
  droppedSources: 0,
  extraCells: 0,
});

function heard(event: NoteTurnEvent): void {
  keepTrail(event);
  const changedHere = changedInNote(event);
  if (event.state !== "working") {
    const endedState = event.state;
    useNoteAsks.setState((state) => ({
      endedByTurn: {
        ...state.endedByTurn,
        [event.turnId]: { state: endedState, changed: changedHere },
      },
    }));
  }
  const was = useNoteAsks.getState().byConversation[event.conversationId];
  // While a request works, the line is its own; the one its AI takes next, sent meanwhile, follows
  // it at once, as the earlier one may end a moment later, once a call of it still running has, and
  // never takes the line back (#3765).
  const shown =
    !was ||
    (was.turnId === null &&
      (was.state !== "working" || event.startedAt >= (was.startedAt ?? ""))) ||
    was.turnId === event.turnId ||
    ((was.state !== "working" || was.queued.includes(event.turnId)) &&
      (was.startedAt === null || event.startedAt >= was.startedAt));
  if (!shown) {
    // Not the line's, an ended request asked here still has its changes applied.
    if (event.state === "stopped") {
      askedHere.delete(event.turnId);
      askedTab.delete(event.turnId);
      sentHere.delete(event.turnId);
    } else if (event.state !== "working") applyEnded(event);
    return;
  }
  // A turn that ended stays ended: nothing of it said later takes it back to working.
  if (was?.turnId === event.turnId && was.state !== "working" && event.state === "working") return;
  // Stopped, the request leaves nothing behind: no line, no reply (#3677).
  if (event.state === "stopped") {
    askedHere.delete(event.turnId);
    askedTab.delete(event.turnId);
    sentHere.delete(event.turnId);
    putConversation(event.conversationId, null);
    return;
  }
  putConversation(event.conversationId, {
    conversationId: event.conversationId,
    mindId: event.mindId,
    turnId: event.turnId,
    pairingId: event.pairingId,
    agent: was?.agent || nameOf(event.mindId, event.pairingId),
    state: event.state,
    doing: event.state === "working" ? event.doing : null,
    startedAt: event.startedAt,
    problem: event.problem,
    versions: null,
    reply: event.reply,
    changed: changedHere,
    waiting: event.waiting,
    made: event.made,
    fresh: event.fresh,
    quiet: event.state === "working" && event.quiet,
    documentsFound: event.documentsFound,
    questions: event.state === "working" ? event.questions : [],
    mode: event.state === "working" && event.modeNew ? event.mode : null,
    queued: event.queued,
    ...(event.endedAtAsk && { endedAtAsk: true }),
    held: event.held,
    // Another turn's words are never this one's: a request another window sent has none here, and
    // its record gives it again.
    asked:
      was?.turnId === event.turnId
        ? was.asked
        : (sentHere.get(event.turnId) ?? { words: "", quote: "", selection: null }),
  });
  if (event.state !== "working") applyEnded(event);
}

/** An ended request asked in this window: its changes in the Notes, applied here once. */
function applyEnded(event: NoteTurnEvent): void {
  if (!askedHere.delete(event.turnId)) return;
  const askedTabId = askedTab.get(event.turnId);
  askedTab.delete(event.turnId);
  sentHere.delete(event.turnId);
  // Claude Code no longer had the Note's conversation, so this request began a new one.
  if (event.fresh) useNotices.getState().confirm("noteAsk.fresh");
  const byNote = new Map<string, NoteChangeApplied[]>();
  // A change in a Note the agent wrote applied already, with its own Undo there.
  for (const each of event.applied.filter((change) => !change.own))
    byNote.set(each.mindId, [...(byNote.get(each.mindId) ?? []), each]);
  const askedFrom = currentTabOf(useAppStore.getState().layout)?.item ?? null;
  const { turnId } = event;
  // Loaded when a turn ends: the selection menu's edits load this module, and the assistant's
  // applied edits load the menu's.
  const applied = import("./askedChanges")
    .then(async ({ applyTurn }) => {
      // One Note that fails never lets what reads the Notes after the turn start on the rest early.
      const settled = await Promise.allSettled(
        [...byNote].map(([mindId, changes]) => {
          const row = rowOf(mindId, changes);
          return applyTurn(turnId, row, () => row, {
            made: false,
            created: false,
            askedFrom,
            ...(askedTabId && { askedTabId }),
          });
        }),
      );
      for (const each of settled) {
        if (each.status === "rejected") useAppStore.getState().reportError(each.reason);
      }
    })
    .catch(useAppStore.getState().reportError)
    .finally(() => applying.delete(turnId));
  applying.set(turnId, applied);
}

let listening = false;
export function listen(): void {
  if (listening) return;
  listening = true;
  core.on("agents.noteTurn", heard);
  core.on("agents.noteConversationsChanged", () => {
    void refreshNoteConversations().catch(useAppStore.getState().reportError);
  });
}

connectNoteAskState({
  listen,
  hasAsk: (conversationId) => Boolean(useNoteAsks.getState().byConversation[conversationId]),
  dropAsk: (conversationId) => putConversation(conversationId, null),
  heard,
});

export interface AskInNoteOptions {
  tabId?: string;
  /** Explicit conversation to continue; null starts a fresh one; absent uses the active one. */
  conversationId?: string | null;
  pairingId?: string;
  mode?: NoteMode;
  /** True when the User explicitly typed into a running conversation from another Note (#3731). */
  intoRunning?: boolean;
  /** Send into the running request at once instead of holding until its reply ends (#3765). */
  now?: boolean;
}

/**
 * In-flight first request on a blank conversation, keyed by pairingId (or mindId when uncached),
 * so switching Notes mid-preflight sees the pending start and waits for its conversation id.
 */
const startingByPairing = new Map<string, Promise<void>>();

/**
 * Sends a request typed at the Note's foot. "sent": a request of the conversation runs, and this
 * one is held until its reply ends, about the whole Note, or with `now` goes into that run at once
 * (#3765). "busy": one runs, and this one, about words selected or targeting another Note without
 * joining the locked run, is not sent; a line says so. "link": no agent can run it in the
 * background now, and the caller asks by the link instead.
 */
export async function askInNote(
  mindId: string,
  asked: NoteAsked,
  optionsOrTab?: string | AskInNoteOptions,
): Promise<"started" | "sent" | "busy" | "problem" | "link"> {
  listen();
  const opts: AskInNoteOptions =
    typeof optionsOrTab === "string" ? { tabId: optionsOrTab } : (optionsOrTab ?? {});
  const { tabId } = opts;
  const agent = backgroundAgentNow(mindId);
  const pendingKey = opts.pairingId ?? agent?.id ?? mindId;
  const inflight = startingByPairing.get(pendingKey);
  if (inflight) await inflight;
  const cols = useNoteColumns.getState();
  const pairingId = opts.pairingId ?? agent?.id;
  const liveActive =
    pairingId && cols.seeded[pairingId] ? (cols.activeByPairing[pairingId] ?? null) : undefined;
  const targetConversationId =
    opts.conversationId !== undefined
      ? (opts.conversationId ??
        (inflight && opts.intoRunning && typeof liveActive === "string" ? liveActive : null))
      : liveActive;
  const modelKey = typeof targetConversationId === "string" ? targetConversationId : "";
  const model = cols.model[modelKey];
  // A new request brings the newest back into view in the column.
  useNoteColumns.setState({ at: null });

  // Sent, the request shows at once, as a chat shows a message sent: the core's answer settles it
  // once its AI is under way, or puts back the line before it.
  const before =
    typeof targetConversationId === "string"
      ? useNoteAsks.getState().byConversation[targetConversationId]
      : useNoteAsks.getState().pendingByPairing[pendingKey];
  const sending = isGoing(before)
    ? null
    : sendingAsk(
        mindId,
        typeof targetConversationId === "string" ? targetConversationId : null,
        asked,
      );
  if (sending) {
    if (typeof targetConversationId === "string") putConversation(targetConversationId, sending);
    else putPending(pendingKey, sending);
  }
  const unsent = () => {
    if (!sending) return;
    if (typeof targetConversationId === "string") {
      if (useNoteAsks.getState().byConversation[targetConversationId] === sending) {
        putConversation(targetConversationId, before ?? null);
      }
    } else if (useNoteAsks.getState().pendingByPairing[pendingKey] === sending) {
      putPending(pendingKey, before ?? null);
    }
  };
  let start: Awaited<ReturnType<typeof core.askInNote>>;
  const startingFirst = sending !== null && typeof targetConversationId !== "string";
  const pendingStart = startingFirst ? Promise.withResolvers<void>() : null;
  if (pendingStart) startingByPairing.set(pendingKey, pendingStart.promise);
  try {
    start = await core.askInNote({
      mindId,
      words: asked.words,
      ...(opts.pairingId !== undefined && { pairingId: opts.pairingId }),
      ...(targetConversationId !== undefined && { conversationId: targetConversationId }),
      ...(opts.intoRunning === true && { intoRunning: true }),
      ...(opts.mode !== undefined && { mode: opts.mode }),
      ...(model && { model }),
      ...(asked.quote !== "" && { quote: asked.quote }),
      ...(asked.selection && { selection: asked.selection }),
      ...(asked.caret && !asked.selection && { caret: asked.caret }),
    });
  } catch (error) {
    unsent();
    if (pendingStart) {
      startingByPairing.delete(pendingKey);
      pendingStart.resolve();
    }
    throw error;
  }
  if (start.kind === "link" || start.kind === "busy" || start.kind === "sent") unsent();
  if (start.kind === "link" || start.kind === "busy") {
    if (pendingStart) {
      startingByPairing.delete(pendingKey);
      pendingStart.resolve();
    }
    if (start.kind === "busy") {
      useNotices
        .getState()
        .confirm("noteAsk.busy", { agent: nameIn(start.pairing) }, { look: true });
    }
    return start.kind;
  }
  if (start.kind === "sent") {
    if (pendingStart) {
      startingByPairing.delete(pendingKey);
      pendingStart.resolve();
    }
    if (useNoteColumns.getState().activeByPairing[start.pairing.id] !== start.conversationId) {
      selectConversation(start.pairing.id, start.conversationId);
    }
    askedHere.add(start.turnId);
    if (tabId) askedTab.set(start.turnId, tabId);
    sentHere.set(start.turnId, asked);
    // Shown at once, whether or not the core's word of it came first.
    const running = useNoteAsks.getState().byConversation[start.conversationId];
    if (running && running.turnId !== start.turnId && !running.held.includes(start.turnId)) {
      putConversation(start.conversationId, {
        ...running,
        held: [...running.held, start.turnId],
      });
    }
    if (opts.now) await sendNowInNote(start.conversationId, start.turnId);
    return "sent";
  }
  if (start.kind === "started") {
    // Carry any model picked on a blank conversation onto the newly created conversation id.
    if (targetConversationId === null && model) {
      useNoteColumns.setState((state) => {
        const { "": _blank, ...rest } = state.model;
        return { model: { ...rest, [start.conversationId]: model } };
      });
    }
    if (sending) {
      if (typeof targetConversationId === "string") {
        if (
          targetConversationId !== start.conversationId &&
          useNoteAsks.getState().byConversation[targetConversationId] === sending
        ) {
          putConversation(targetConversationId, null);
        }
      } else if (useNoteAsks.getState().pendingByPairing[pendingKey] === sending) {
        putPending(pendingKey, null);
      }
    }
    selectConversation(start.pairing.id, start.conversationId);
    askedHere.add(start.turnId);
    if (tabId) askedTab.set(start.turnId, tabId);
    useNoteAsks.setState((state) => ({
      lastByMind: {
        ...state.lastByMind,
        [mindId]: { conversationId: start.conversationId, turnId: start.turnId },
      },
    }));
  }
  const conversationId =
    start.kind === "started"
      ? start.conversationId
      : typeof targetConversationId === "string"
        ? targetConversationId
        : null;
  const base: NoteAsk = {
    conversationId,
    mindId,
    turnId: start.kind === "started" ? start.turnId : null,
    pairingId: start.pairing.id,
    agent: nameIn(start.pairing),
    state: start.kind === "started" ? "working" : "failed",
    doing: null,
    startedAt: start.kind === "started" ? (sending?.startedAt ?? new Date().toISOString()) : null,
    problem: start.kind === "problem" ? start.problem : null,
    versions: start.kind === "problem" ? (start.versions ?? null) : null,
    reply: "",
    changed: 0,
    waiting: [],
    made: [],
    fresh: false,
    quiet: false,
    documentsFound: 0,
    questions: [],
    mode: null,
    queued: [],
    held: [],
    asked,
  };
  // An event can arrive before the reply to the request: it wins.
  if (conversationId !== null) {
    const current = useNoteAsks.getState().byConversation[conversationId];
    if (current?.turnId !== base.turnId || base.turnId === null) {
      putConversation(conversationId, base);
    } else {
      putConversation(conversationId, { ...current, asked });
    }
  } else {
    putPending(pendingKey, base);
  }
  if (pendingStart) {
    startingByPairing.delete(pendingKey);
    pendingStart.resolve();
  }
  return start.kind;
}

/** A request as it is sent, before the core answers: working, on the agent the Note's input runs. */
function sendingAsk(
  mindId: string,
  conversationId: string | null,
  asked: NoteAsked,
): NoteAsk | null {
  const agent = backgroundAgentNow(mindId);
  if (!agent) return null;
  return {
    conversationId,
    mindId,
    turnId: null,
    pairingId: agent.id,
    agent: nameIn(agent),
    state: "working",
    doing: null,
    startedAt: new Date().toISOString(),
    problem: null,
    versions: null,
    reply: "",
    changed: 0,
    waiting: [],
    made: [],
    fresh: false,
    quiet: false,
    documentsFound: 0,
    questions: [],
    mode: null,
    queued: [],
    held: [],
    asked,
  };
}

export const stopInNote = (conversationIdOrMindId: string): Promise<void> =>
  core.stopInNote(conversationIdOrMindId);

/** The held messages whose editor is open in this window, which ⌘↵ in the input leaves alone. */
const editingHere = new Set<string>();

const readAgain = () => useNoteColumns.setState((state) => ({ changed: state.changed + 1 }));

/**
 * Removes a request of the conversation that was never sent, or a message held for it, and reads
 * the conversation again.
 */
export async function discardInNote(conversationId: string, turnId: string): Promise<void> {
  editingHere.delete(turnId);
  await core.discardInNote(conversationId, turnId);
  sentHere.delete(turnId);
  askedTab.delete(turnId);
  askedHere.delete(turnId);
  readAgain();
}

/** Sends a message held for the conversation at once (#3765), and reads the conversation again. */
export async function sendNowInNote(conversationId: string, turnId: string): Promise<void> {
  editingHere.delete(turnId);
  await core.sendNowInNote(conversationId, turnId);
  readAgain();
}

/** ⌘↵ in an empty input: the oldest message held for the conversation goes now, unless its editor is open. */
export async function sendOldestNow(conversationId: string): Promise<boolean> {
  const turnId = useNoteAsks
    .getState()
    .byConversation[conversationId]?.held.find((each) => !editingHere.has(each));
  if (turnId === undefined) return false;
  await sendNowInNote(conversationId, turnId);
  return true;
}

/**
 * Opens or closes a held message's editor in this window (#3765): while it is open the message
 * isn't sent. Whether the message was still held; if not, it has gone, and the conversation is
 * read again to show it so, as it is once the editor closes.
 */
export async function editHeldInNote(
  conversationId: string,
  turnId: string,
  edit: NoteHeldEdit,
): Promise<boolean> {
  const held = await core.editHeldInNote({ conversationId, turnId, clientId, edit });
  if (edit.kind === "open" && held) editingHere.add(turnId);
  else {
    editingHere.delete(turnId);
    readAgain();
  }
  return held;
}

/**
 * Sends a request of the conversation again, by the link where no agent runs it in the background
 * now, as the input's Send does. Whether it went.
 */
export async function askAgainInNote(
  mindId: string,
  asked: NoteAsked,
  conversationId?: string | null,
): Promise<boolean> {
  const went = await askInNote(mindId, asked, {
    ...(conversationId !== undefined && { conversationId }),
  });
  return (
    went === "started" ||
    went === "sent" ||
    (went === "link" &&
      (await askFirstAgent(mindId, { kind: "question", text: asked.words })) === "asked")
  );
}

/** The requests never sent that are being sent again: a second press sends nothing more. */
const resending = new Set<string>();

/**
 * Sends a request that was never sent as a new one, by the link where no agent runs it here;
 * once it goes, the one not sent goes.
 */
export async function sendUnsent(
  conversationId: string,
  mindId: string,
  turn: { id: string; request: string },
) {
  if (resending.has(turn.id)) return;
  resending.add(turn.id);
  try {
    const asked = { words: turn.request, quote: "", selection: null };
    if (await askAgainInNote(mindId, asked, conversationId)) {
      await discardInNote(conversationId, turn.id);
    }
  } finally {
    resending.delete(turn.id);
  }
}

/** Answers what the User's own AI asks in the conversation (#3653). */
export const answerInNote = (conversationId: string, questionId: string, answer: NoteAnswer) =>
  core.answerInNote(conversationId, questionId, answer).catch(useAppStore.getState().reportError);

/**
 * A window opened while a request runs hears of it, and of what its AI asks, from the core: a
 * waiting question tells nothing more until it is answered (#3653).
 */
export async function seedRunning(conversationId: string): Promise<void> {
  if (useNoteAsks.getState().byConversation[conversationId]) return;
  listen();
  const now = await core.noteTurnNow(conversationId);
  if (now && !useNoteAsks.getState().byConversation[conversationId]) heard(now);
}

/**
 * Lets the agent propose changes, the switch Settings shows, and sends the request again: as this
 * window sent it, else from `turn`, the record of it a window that didn't send it has.
 */
export async function allowAndAskAgain(
  mindId: string,
  conversationId: string | null,
  turn?: { request: string; quote: string },
): Promise<void> {
  const state = useNoteAsks.getState();
  const agent = backgroundAgentNow(mindId);
  const ask =
    conversationId !== null
      ? state.byConversation[conversationId]
      : ((agent ? state.pendingByPairing[agent.id] : undefined) ?? state.pendingByPairing[mindId]);
  if (!ask) return;
  const asked = askedAgain(ask, turn);
  await core.updateAgent(ask.pairingId, { propose: true });
  if (asked) await askAgainInNote(ask.mindId || mindId, asked, conversationId);
  else clearNoteAsk(conversationId, mindId, ask.pairingId);
}

/**
 * What sending the last request again sends: as this window asked it, or from its turn's record.
 * The record keeps the words a request was about, not where they are: sent again without them,
 * its changes would no longer be held to them, so such a request is left for the User to ask
 * (null).
 */
export const askedAgain = (
  ask: NoteAsk,
  turn?: { request: string; quote: string },
): NoteAsked | null =>
  ask.asked.words !== ""
    ? ask.asked
    : turn && turn.request !== "" && turn.quote === ""
      ? { words: turn.request, quote: "", selection: null }
      : null;

/**
 * A selection toolbar action sent as a request of the Note's input (ADR-0034), with the words
 * selected as its context. "link": no agent runs it in the background now, and the caller hands
 * the selection over by the link as before; "none": nothing is selected; "busy": a request is
 * still running, and this one is not sent.
 */
export async function askFromSelection(
  state: EditorState,
  mindId: string,
  words: string,
): Promise<"started" | "problem" | "link" | "none" | "busy"> {
  const asks = useNoteAsks.getState();
  const agent = backgroundAgentNow(mindId);
  const cols = useNoteColumns.getState();
  const activeId = agent ? (cols.activeByPairing[agent.id] ?? null) : null;
  const lastConvId = asks.lastByMind[mindId]?.conversationId;
  // Words selected can't go into the run going, whose AI takes no new selection mid-run (#3765):
  // this one waits for Stop.
  const running =
    (activeId !== null ? asks.byConversation[activeId] : undefined) ??
    (lastConvId ? asks.byConversation[lastConvId] : undefined) ??
    (agent ? asks.pendingByPairing[agent.id] : undefined) ??
    asks.pendingByPairing[mindId];
  if (running && isGoing(running)) {
    useNotices.getState().confirm("noteAsk.busy", { agent: running.agent }, { look: true });
    return "busy";
  }
  const selected = selectedForRequest(state);
  if (!selected) return "none";
  // The core sends no request about words selected into a run: a run another window began
  // meanwhile makes it "busy", never "sent".
  const went = await askInNote(
    mindId,
    {
      words,
      quote: selected.quote,
      selection: selected.selection,
    },
    {
      ...(agent && cols.seeded[agent.id] && { conversationId: activeId }),
      ...(agent && { pairingId: agent.id }),
    },
  );
  return went === "sent" ? "busy" : went;
}

/**
 * Puts the keyboard in the Note's input, where ⌘J asks with the words selected as context: at the
 * Note's foot, or at the column's foot while it is open (#3677).
 */
export function focusNoteAsk(mindId: string): void {
  const field =
    document.querySelector<HTMLTextAreaElement>(`[data-note-ask-input="${CSS.escape(mindId)}"]`) ??
    document.querySelector<HTMLTextAreaElement>("[data-note-ask-input]");
  field?.focus();
}

/**
 * Words given back to the Note's input, which takes them once (#3765). `after`: they go after what
 * is typed there, on a line of their own, rather than only into an empty input.
 */
export const useEditedRequests = create<{
  byMind: Readonly<Record<string, { words: string; after: boolean }>>;
}>(() => ({ byMind: {} }));

/** Puts a sent request's words back in the Note's input, to change and send as a new request. */
export function editRequest(mindId: string, words: string): void {
  useEditedRequests.setState((state) => ({
    byMind: { ...state.byMind, [mindId]: { words, after: false } },
  }));
}

/**
 * Keeps words the User wrote for a message that has gone, in the input after what it holds, and
 * after any kept before that the input hasn't taken yet.
 */
export function keepInInput(mindId: string, words: string): void {
  useEditedRequests.setState((state) => {
    const waiting = state.byMind[mindId];
    const kept = waiting?.after ? `${waiting.words}\n${words}` : words;
    return { byMind: { ...state.byMind, [mindId]: { words: kept, after: true } } };
  });
}

/** What the input holds once it takes words given back: `typed`, then those on a line of their own. */
export function withGivenBack(typed: string, given: { words: string; after: boolean }): string {
  if (typed.trim() === "") return given.words;
  return given.after ? `${typed.trimEnd()}\n${given.words}` : typed;
}

/** The label goes once the User starts the next request, or closes it. */
export const clearNoteAsk = (
  conversationId: string | null,
  mindId: string,
  pairingId?: string,
): void => {
  if (conversationId !== null) {
    const ask = useNoteAsks.getState().byConversation[conversationId];
    if (ask && !isGoing(ask)) putConversation(conversationId, null);
    return;
  }
  const keys = pairingId && pairingId !== mindId ? [pairingId, mindId] : [mindId];
  for (const key of keys) {
    const pending = useNoteAsks.getState().pendingByPairing[key];
    if (pending && !isGoing(pending)) putPending(key, null);
  }
};

/** The opening words of the paragraph the cursor is in, with nothing selected: where to write. */
export function caretOf(state: EditorState): string {
  const { empty, $from } = state.selection;
  if (!empty || $from.depth === 0) return "";
  return state.doc
    .child($from.index(0))
    .textBetween(0, state.doc.child($from.index(0)).content.size, " ", "")
    .trim()
    .slice(0, CARET_WORDS);
}

const CARET_WORDS = 80;

/**
 * An inline node in the text around a selection, as the core reads it there
 * (src/core/agents/access.ts): a line break as a space, anything else (a Citation, a footnote) as
 * one mark, so a change that drops it is a change outside the selection.
 */
const leafOf = (node: ProseMirrorNode) => (node.type.name === "hardBreak" ? " " : NODE_CHARACTER);

/**
 * The words selected in the Note, as a request's context: their text, and for each top-level
 * Block they are in its plain text before and after them, which a change inside leaves alone.
 * Null when nothing is selected.
 */
export function selectedForRequest(
  state: EditorState,
): { quote: string; selection: NoteSelectionBlock[] } | null {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const selection: NoteSelectionBlock[] = [];
  state.doc.forEach((node, offset) => {
    const start = offset + 1;
    const end = offset + node.nodeSize - 1;
    if (end <= from || start >= to) return;
    const blockId = node.attrs.id;
    if (typeof blockId !== "string" || blockId === "") return;
    selection.push({
      blockId,
      before: state.doc.textBetween(start, Math.max(start, from), " ", leafOf),
      after: state.doc.textBetween(Math.min(end, to), end, " ", leafOf),
    });
  });
  const quote = state.doc.textBetween(from, to, " ", "").trim();
  return quote !== "" && selection.length > 0 ? { quote: quote.slice(0, 4000), selection } : null;
}

/**
 * A reply's Citation tokens, which the AI writes as it does in a Note; a Note shows them as chips,
 * and a reply leaves them out until it shows them as chips too.
 */
export const withoutCitations = (reply: string) =>
  reply.replace(/\s?\[cite:(?:[^\]\n[]|\[[^\]\n]*\])*(?:\]|$)/g, "");

/** The first words of a reply, as one line: its Markdown marks gone. */
export const firstWordsOf = (reply: string): string =>
  (
    withoutCitations(reply)
      .split(/\n/)
      .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "").trim())
      .find((line) => line !== "") ?? ""
  )
    .replace(/\*\*|__|`/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
