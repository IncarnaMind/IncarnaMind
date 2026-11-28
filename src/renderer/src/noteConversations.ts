/**
 * Active-conversation, History, persistence and seeding store for the User's own command-line AI
 * (#3677, #3759, #3731): whether the conversation is open, which conversation is active per
 * connected AI, the chosen model per conversation, draft input carried across Note switches,
 * cached turns so Note switches never flash empty, and where the conversation opens (upward from
 * the Note's foot, or in the window's left column).
 */
import { create } from "zustand";
import type { NoteConversationSummary, NoteTurn, NoteTurnEvent } from "../../core/api";
import { core } from "./core";

/** Display title of a conversation: user-chosen title, else its first request's words. */
export const noteConversationTitle = (
  conversation: Pick<NoteConversationSummary, "title" | "firstRequest">,
  fallback: string,
): string => conversation.title?.trim() || conversation.firstRequest.trim() || fallback;

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

interface NoteAskBridge {
  listen(): void;
  hasAsk(conversationId: string): boolean;
  dropAsk(conversationId: string): void;
  heard(event: NoteTurnEvent): void;
}

let askBridge: NoteAskBridge = {
  listen: () => undefined,
  hasAsk: () => false,
  dropAsk: () => undefined,
  heard: () => undefined,
};

/** Connects live-turn state from `ownAiInNote` without a circular import. */
export function connectNoteAskState(bridge: NoteAskBridge): void {
  askBridge = bridge;
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
  /** Counts each change to the conversation no request's state tells: it is read again on it. */
  changed: number;
  /** Last loaded turns for the active conversation, avoiding blank flashes on Note switch. */
  turnsCache: Readonly<{ conversationId: string; turns: readonly NoteTurn[] } | null>;
  /** Set when History should open once the conversation header is mounted (e.g. ⌘K while folded). */
  historyOpenRequested: boolean;
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
  historyOpenRequested: false,
}));

/** Opens the conversation at a reply, as pressing the line does. */
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

/** Opens the conversation (if folded) and asks its header to open the History popover (e.g. ⌘K). */
export function openNoteHistory(): void {
  useNoteColumns.setState({ open: true, historyOpenRequested: true });
}

/** Clears the pending History-open request once the header opens the popover. */
export function consumeNoteHistoryRequest(): void {
  useNoteColumns.setState({ historyOpenRequested: false });
}

/** Renames a conversation and refreshes History. */
export async function renameNoteConversation(conversationId: string, title: string): Promise<void> {
  await core.renameNoteConversation(conversationId, title);
  await refreshNoteConversations();
}

/** Permanently deletes a conversation from IncarnaMind and purges its agent transcript. */
export async function deleteNoteConversation(conversationId: string): Promise<void> {
  await core.deleteNoteConversation(conversationId);
  askBridge.dropAsk(conversationId);
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
        if (id !== null && !liveIds.has(id) && !askBridge.hasAsk(id)) {
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
 * shows the newest conversation that touched `mindId` for this pairing (or a previously remembered
 * conversation on subsequent launches if it still exists). From then on, it follows the User (#3731).
 */
export function seedConversationFor(mindId: string, pairingId: string): Promise<void> {
  if (useNoteColumns.getState().seeded[pairingId]) return Promise.resolve();
  const pending = seedingPairings.get(pairingId);
  if (pending) return pending;
  askBridge.listen();
  const task = (async () => {
    const [list, running] = await Promise.all([
      refreshNoteConversations(),
      core.noteRunningTurns(),
    ]);
    for (const event of running) {
      if (!askBridge.hasAsk(event.conversationId)) askBridge.heard(event);
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
            : await core.latestNoteConversation(mindId, pairingId);
    } else {
      chosen = await core.latestNoteConversation(mindId, pairingId);
    }
    selectConversation(pairingId, chosen);
  })().finally(() => {
    seedingPairings.delete(pairingId);
  });
  seedingPairings.set(pairingId, task);
  return task;
}
