/**
 * Conversations with the User's own command-line AI (ADR-0034, #3627, #3731): what is asked, how
 * each request goes as the core tells it ("agents.noteTurn"), the changes it made in the Note it
 * was asked from (applied at once in the window that asked, with Undo), and the active
 * conversation per connected AI that follows the User across Notes.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { create } from "zustand";
import type {
  AgentPairing,
  NoteAnswer,
  NoteChangeApplied,
  NoteConversationSummary,
  NoteMode,
  NoteQuestion,
  NoteSelectionBlock,
  NoteStep,
  NoteTurn,
  NoteTurnEvent,
  NoteTurnProblem,
} from "../../core/api";
import { NODE_CHARACTER } from "../../shared/proposals";
import {
  agentsToAsk,
  askFirstAgent,
  ownAiRunsHereNow,
  useAgentsToAsk,
  useOwnAiRunsHere,
} from "./askYourAi";
import type { ChangedMind } from "./changedMinds";
import { core } from "./core";
import { currentTabOf } from "./layoutSlice";
import { useNotices } from "./notices";
import { hiddenForOwnAiNow, runsInBackground, useHiddenForOwnAi } from "./ownAiPanel";
import { useAppStore } from "./store";

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
  /** Paragraphs changed at once in `mindId`. */
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
  /** Sent again once the User lets the agent propose changes. */
  asked: NoteAsked;
}

export const useNoteAsks = create<{
  byConversation: Readonly<Record<string, NoteAsk>>;
  /** Brief preflight placeholder while a brand-new conversation waits for its id, keyed by mindId. */
  pendingByMind: Readonly<Record<string, NoteAsk>>;
  /** Latest turn started per mindId, for callers such as Write notes. */
  lastByMind: Readonly<Record<string, { conversationId: string; turnId: string }>>;
}>(() => ({
  byConversation: {},
  pendingByMind: {},
  lastByMind: {},
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
  /** This request began a new conversation that can use the AI's own tools (#3653). */
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

/** Cached list of own-AI conversations for History and active headers, newest first (#3731). */
export const useNoteConversations = create<{
  list: readonly NoteConversationSummary[];
  loaded: boolean;
}>(() => ({ list: [], loaded: false }));

/** Where the User last moved the conversation, on this computer: it opens there after a restart. */
const PLACE_KEY = "incarnamind.noteConversation.place";
/** Last active conversation per pairing on this computer; absent on first open after upgrade. */
const ACTIVE_KEY = "incarnamind.noteConversation.active";

function savedPlace(): "upward" | "column" {
  try {
    return localStorage.getItem(PLACE_KEY) === "column" ? "column" : "upward";
  } catch {
    return "upward";
  }
}

function savedActive(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" || value === null) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function persistActive(activeByPairing: Readonly<Record<string, string | null>>): void {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeByPairing));
  } catch {
    // Not remembered across restarts if storage is unavailable.
  }
}

/**
 * Window-level conversation state (#3677, #3759, #3731): whether the conversation is open, which
 * conversation is active per connected AI, the chosen model per conversation, draft input carried
 * across Note switches, cached turns so Note switches never flash empty, and where the
 * conversation opens (upward from the Note's foot, or in the window's left column).
 */
export const useNoteColumns = create<{
  open: boolean;
  activeByPairing: Readonly<Record<string, string | null>>;
  /** Pairings whose first-open-after-upgrade conversation has been chosen in this window. */
  seeded: Readonly<Record<string, true>>;
  /** Chosen model per conversationId (or "" for a blank new conversation). */
  model: Readonly<Record<string, string>>;
  /** Draft words in the input, kept when switching Notes. */
  draft: string;
  /** The reply turnId the conversation opens scrolled to, from clicking the foot line. */
  at: string | null;
  place: "upward" | "column";
  /** Counts each change to the active conversation no request's state tells. */
  changed: number;
  /** Last loaded turns for the active conversation, avoiding blank flashes on Note switch. */
  turnsCache: Readonly<{ conversationId: string; turns: readonly NoteTurn[] } | null>;
  /** Requests opening the History popover (e.g. from ⌘K). */
  historyRequest: number;
}>(() => ({
  open: false,
  activeByPairing: {},
  seeded: {},
  model: {},
  draft: "",
  at: null,
  place: savedPlace(),
  changed: 0,
  turnsCache: null,
  historyRequest: 0,
}));

/** Opens the conversation at a reply, as pressing the foot line does. */
export const openColumnAt = (turnId: string | null) =>
  useNoteColumns.setState({ open: true, at: turnId });

export const setColumnOpen = (open: boolean) => useNoteColumns.setState({ open });

export const useColumnOpen = (): boolean => useNoteColumns((state) => state.open);

/** Moves the open conversation between its two places; it stays open, and the input goes with it. */
export function moveConversation(place: "upward" | "column"): void {
  useNoteColumns.setState({ place });
  try {
    localStorage.setItem(PLACE_KEY, place);
  } catch {
    // Not remembered, then: it opens upward after the next restart.
  }
}

/** Sets the active conversation for a connected AI and keeps it across Note switches. */
export function selectConversation(pairingId: string, conversationId: string | null): void {
  useNoteColumns.setState((state) => {
    const activeByPairing = { ...state.activeByPairing, [pairingId]: conversationId };
    persistActive(activeByPairing);
    return {
      activeByPairing,
      seeded: { ...state.seeded, [pairingId]: true as const },
      at: null,
      turnsCache:
        conversationId && state.turnsCache?.conversationId === conversationId
          ? state.turnsCache
          : null,
    };
  });
}

/** Starts a fresh empty conversation for `pairingId`; the earlier one stays in History (#3731). */
export function startNewConversation(pairingId: string): void {
  selectConversation(pairingId, null);
  useNoteColumns.setState({ open: true, at: null });
}

/** Requests opening the History popover from outside the column header (e.g. ⌘K). */
export function openNoteHistory(): void {
  useNoteColumns.setState((state) => ({
    open: true,
    historyRequest: state.historyRequest + 1,
  }));
}

/** Renames a conversation and refreshes History. */
export async function renameNoteConversation(conversationId: string, title: string): Promise<void> {
  await core.renameNoteConversation(conversationId, title);
  await refreshNoteConversations();
}

/** Permanently deletes a conversation from IncarnaMind and purges its agent transcript. */
export async function deleteNoteConversation(conversationId: string): Promise<void> {
  await core.deleteNoteConversation(conversationId);
  useNoteAsks.setState((state) => {
    const { [conversationId]: _gone, ...byConversation } = state.byConversation;
    return { byConversation };
  });
  useNoteColumns.setState((state) => {
    const activeByPairing = { ...state.activeByPairing };
    let changed = false;
    for (const [pairingId, active] of Object.entries(activeByPairing)) {
      if (active === conversationId) {
        activeByPairing[pairingId] = null;
        changed = true;
      }
    }
    if (changed) persistActive(activeByPairing);
    const { [conversationId]: _m, ...model } = state.model;
    return {
      activeByPairing,
      model,
      turnsCache: state.turnsCache?.conversationId === conversationId ? null : state.turnsCache,
      changed: state.changed + 1,
    };
  });
  await refreshNoteConversations();
}

let refreshing: Promise<readonly NoteConversationSummary[]> | null = null;

/** Refreshes the cached History list from the core. */
export function refreshNoteConversations(): Promise<readonly NoteConversationSummary[]> {
  if (refreshing) return refreshing;
  refreshing = core
    .noteConversations()
    .then((list) => {
      useNoteConversations.setState({ list, loaded: true });
      const liveIds = new Set(list.map((each) => each.id));
      const cols = useNoteColumns.getState();
      let pruned = false;
      const activeByPairing = { ...cols.activeByPairing };
      for (const [pairingId, id] of Object.entries(activeByPairing)) {
        if (id !== null && !liveIds.has(id) && !useNoteAsks.getState().byConversation[id]) {
          activeByPairing[pairingId] = null;
          pruned = true;
        }
      }
      if (pruned) {
        persistActive(activeByPairing);
        useNoteColumns.setState({ activeByPairing });
      }
      return list;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const seedingPairings = new Map<string, Promise<void>>();

/**
 * Seeds the active conversation for `pairingId` on the first Note opened after upgrade or launch:
 * shows the newest conversation that touched `mindId` (or a previously remembered conversation on
 * subsequent launches if it still exists). From then on, the conversation follows the User (#3731).
 */
export function seedConversationFor(mindId: string, pairingId: string): Promise<void> {
  if (useNoteColumns.getState().seeded[pairingId]) return Promise.resolve();
  const pending = seedingPairings.get(pairingId);
  if (pending) return pending;
  listen();
  const task = (async () => {
    const [list, running] = await Promise.all([
      refreshNoteConversations(),
      core.noteRunningTurns(),
    ]);
    for (const event of running) {
      if (!useNoteAsks.getState().byConversation[event.conversationId]) heard(event);
    }
    if (useNoteColumns.getState().seeded[pairingId]) return;
    const liveIds = new Set(list.map((each) => each.id));
    const saved = savedActive();
    const hasSaved = Object.hasOwn(saved, pairingId);
    const savedId = saved[pairingId];
    let chosen: string | null = null;
    const runningHere = running.find((each) => each.pairingId === pairingId);
    if (runningHere) {
      chosen = runningHere.conversationId;
    } else if (hasSaved) {
      chosen =
        savedId !== null && savedId !== undefined && liveIds.has(savedId)
          ? savedId
          : savedId === null
            ? null
            : await core.latestNoteConversation(mindId);
    } else {
      chosen = await core.latestNoteConversation(mindId);
    }
    selectConversation(pairingId, chosen);
  })().finally(() => {
    seedingPairings.delete(pairingId);
  });
  seedingPairings.set(pairingId, task);
  return task;
}

function keepTrail(event: NoteTurnEvent): void {
  const changed = sum(event.applied, "changed") + sum(event.applied, "added");
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
    conversationId !== null ? state.byConversation[conversationId] : state.pendingByMind[mindId],
  );
  return { pairing, conversationId, seeded, ask };
}

const putConversation = (conversationId: string, ask: NoteAsk | null) =>
  useNoteAsks.setState((state) => {
    const { [conversationId]: _gone, ...rest } = state.byConversation;
    return { byConversation: ask ? { ...rest, [conversationId]: ask } : rest };
  });

const putPending = (mindId: string, ask: NoteAsk | null) =>
  useNoteAsks.setState((state) => {
    const { [mindId]: _gone, ...rest } = state.pendingByMind;
    return { pendingByMind: ask ? { ...rest, [mindId]: ask } : rest };
  });

const nameOf = (mindId: string, pairingId: string) =>
  agentsToAsk(mindId).find((each) => each.id === pairingId)?.name ??
  useNoteConversations.getState().list.find((each) => each.pairingId === pairingId)?.agent ??
  "Claude Code";

const sum = (applied: readonly NoteChangeApplied[], field: "changed" | "added" | "tables") =>
  applied.reduce((total, each) => total + each[field], 0);

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
    changed: sum(event.applied, "changed") + sum(event.applied, "added"),
    waiting: event.waiting,
    made: event.made,
    fresh: event.fresh,
    quiet: event.state === "working" && event.quiet,
    documentsFound: event.documentsFound,
    questions: event.state === "working" ? event.questions : [],
    mode: event.state === "working" && event.modeNew ? event.mode : null,
    queued: event.queued,
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
  // Claude Code no longer had the conversation, so this request began a new one.
  if (event.fresh) useNotices.getState().confirm("noteAsk.fresh");
  const byNote = new Map<string, NoteChangeApplied[]>();
  // A change in a Note the agent wrote applied already, with its own Undo there.
  for (const each of event.applied.filter((change) => !change.own))
    byNote.set(each.mindId, [...(byNote.get(each.mindId) ?? []), each]);
  const askedFrom = currentTabOf(useAppStore.getState().layout)?.item ?? null;
  const { turnId } = event;
  const applied = import("./askedChanges")
    .then(async ({ applyTurn }) => {
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

export interface AskInNoteOptions {
  tabId?: string;
  /** Explicit conversation to continue; null starts a fresh one; absent uses the active one. */
  conversationId?: string | null;
  pairingId?: string;
  mode?: NoteMode;
}

/** In-flight first request on a blank conversation so a quick follow-up waits for its id. */
const startingByMind = new Map<string, Promise<void>>();

/**
 * Sends a request typed for a Note. "sent": a request of the conversation runs, and this one went
 * into its run (#3765). "busy": one runs, and this one, about words selected, is not sent; a line
 * says so. "link": no agent can run it in the background now, and the caller asks by the link.
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
  const inflight = startingByMind.get(mindId);
  if (inflight) await inflight;
  const agent = backgroundAgentNow(mindId);
  const cols = useNoteColumns.getState();
  const liveActive =
    agent && cols.seeded[agent.id] ? (cols.activeByPairing[agent.id] ?? null) : undefined;
  const targetConversationId =
    opts.conversationId !== undefined
      ? (opts.conversationId ?? (inflight && typeof liveActive === "string" ? liveActive : null))
      : liveActive;
  const modelKey = typeof targetConversationId === "string" ? targetConversationId : "";
  const model = cols.model[modelKey];
  // A new request brings the newest back into view in the column.
  useNoteColumns.setState({ at: null });

  const before =
    typeof targetConversationId === "string"
      ? useNoteAsks.getState().byConversation[targetConversationId]
      : useNoteAsks.getState().pendingByMind[mindId];
  const sending = isGoing(before)
    ? null
    : sendingAsk(
        mindId,
        typeof targetConversationId === "string" ? targetConversationId : null,
        asked,
      );
  if (sending) {
    if (typeof targetConversationId === "string") putConversation(targetConversationId, sending);
    else putPending(mindId, sending);
  }
  const unsent = () => {
    if (!sending) return;
    if (typeof targetConversationId === "string") {
      if (useNoteAsks.getState().byConversation[targetConversationId] === sending) {
        putConversation(targetConversationId, before ?? null);
      }
    } else if (useNoteAsks.getState().pendingByMind[mindId] === sending) {
      putPending(mindId, before ?? null);
    }
  };
  let start: Awaited<ReturnType<typeof core.askInNote>>;
  const startingFirst = sending !== null && typeof targetConversationId !== "string";
  const pendingStart = startingFirst ? Promise.withResolvers<void>() : null;
  if (pendingStart) startingByMind.set(mindId, pendingStart.promise);
  try {
    start = await core.askInNote({
      mindId,
      words: asked.words,
      ...(opts.pairingId !== undefined && { pairingId: opts.pairingId }),
      ...(targetConversationId !== undefined && { conversationId: targetConversationId }),
      ...(opts.mode !== undefined && { mode: opts.mode }),
      ...(model && { model }),
      ...(asked.quote !== "" && { quote: asked.quote }),
      ...(asked.selection && { selection: asked.selection }),
      ...(asked.caret && !asked.selection && { caret: asked.caret }),
    });
  } catch (error) {
    unsent();
    if (pendingStart) {
      startingByMind.delete(mindId);
      pendingStart.resolve();
    }
    throw error;
  }
  if (start.kind === "link" || start.kind === "busy" || start.kind === "sent") unsent();
  if (start.kind === "link" || start.kind === "busy") {
    if (pendingStart) {
      startingByMind.delete(mindId);
      pendingStart.resolve();
    }
    if (start.kind === "busy") {
      useNotices.getState().confirm("noteAsk.busy", { agent: start.pairing.name }, { look: true });
    }
    return start.kind;
  }
  if (start.kind === "sent") {
    if (pendingStart) {
      startingByMind.delete(mindId);
      pendingStart.resolve();
    }
    if (useNoteColumns.getState().activeByPairing[start.pairing.id] !== start.conversationId) {
      selectConversation(start.pairing.id, start.conversationId);
    }
    askedHere.add(start.turnId);
    if (tabId) askedTab.set(start.turnId, tabId);
    sentHere.set(start.turnId, asked);
    const running = useNoteAsks.getState().byConversation[start.conversationId];
    if (running && running.turnId !== start.turnId && !running.queued.includes(start.turnId)) {
      putConversation(start.conversationId, {
        ...running,
        queued: [...running.queued, start.turnId],
      });
    }
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
    if (sending && typeof targetConversationId !== "string") {
      if (useNoteAsks.getState().pendingByMind[mindId] === sending) putPending(mindId, null);
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
    agent: start.pairing.name,
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
    asked,
  };
  if (conversationId !== null) {
    const current = useNoteAsks.getState().byConversation[conversationId];
    if (current?.turnId !== base.turnId || base.turnId === null) {
      putConversation(conversationId, base);
    } else {
      putConversation(conversationId, { ...current, asked });
    }
  } else {
    putPending(mindId, base);
  }
  if (pendingStart) {
    startingByMind.delete(mindId);
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
    agent: agent.name,
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
    asked,
  };
}

export const stopInNote = (conversationIdOrMindId: string): Promise<void> =>
  core.stopInNote(conversationIdOrMindId);

/** Removes a request of the conversation that was never sent, and reads the conversation again. */
export async function discardInNote(conversationId: string, turnId: string): Promise<void> {
  await core.discardInNote(conversationId, turnId);
  sentHere.delete(turnId);
  askedTab.delete(turnId);
  askedHere.delete(turnId);
  useNoteColumns.setState((state) => ({ changed: state.changed + 1 }));
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
  const ask =
    conversationId !== null
      ? useNoteAsks.getState().byConversation[conversationId]
      : useNoteAsks.getState().pendingByMind[mindId];
  if (!ask) return;
  const asked = askedAgain(ask, turn);
  await core.updateAgent(ask.pairingId, { propose: true });
  if (asked) await askAgainInNote(mindId, asked, conversationId);
  else clearNoteAsk(conversationId, mindId);
}

/**
 * What sending the last request again sends: as this window asked it, or from its turn's record.
 * The record keeps the words a request was about, not where they are: sent again without them,
 * its changes would no longer be held to them, so such a request is left for the User to ask.
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
 * selected as its context.
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
  const running =
    (activeId !== null ? asks.byConversation[activeId] : undefined) ??
    (lastConvId ? asks.byConversation[lastConvId] : undefined) ??
    asks.pendingByMind[mindId];
  if (running && isGoing(running)) {
    useNotices.getState().confirm("noteAsk.busy", { agent: running.agent }, { look: true });
    return "busy";
  }
  const selected = selectedForRequest(state);
  if (!selected) return "none";
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

/** Words a sent request's Edit gives back to the input, which takes them once (#3765). */
export const useEditedRequests = create<{ pending: string | null }>(() => ({
  pending: null,
}));

/** Puts a sent request's words back in the input, to change and send as a new request. */
export function editRequest(words: string): void {
  useEditedRequests.setState({ pending: words });
}

/** The label goes once the User starts the next request, or closes it. */
export const clearNoteAsk = (conversationId: string | null, mindId: string): void => {
  if (conversationId !== null) {
    const ask = useNoteAsks.getState().byConversation[conversationId];
    if (ask && !isGoing(ask)) putConversation(conversationId, null);
    return;
  }
  const pending = useNoteAsks.getState().pendingByMind[mindId];
  if (pending && !isGoing(pending)) putPending(mindId, null);
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
export const withoutCitations = (reply: string) => reply.replace(/\s?\[cite:[a-z0-9]{1,32}\]/g, "");

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
