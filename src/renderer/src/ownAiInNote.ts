/**
 * The input at a Note's foot, for a User whose own AI is a command-line one IncarnaMind runs in
 * the background (ADR-0034, #3627): what is asked, how each request goes as the core tells it
 * ("agents.noteTurn"), and the changes it made in the Note it was asked from, applied at once in
 * the window that asked, with the applied-edit line and its Undo, as the assistant's are
 * (`applyTurn`).
 */
import type { EditorState } from "@tiptap/pm/state";
import { create } from "zustand";
import type {
  NoteChangeApplied,
  NoteSelectionBlock,
  NoteTurnEvent,
  NoteTurnProblem,
} from "../../core/api";
import { agentsToAsk, ownAiRunsHereNow, useAgentsToAsk, useOwnAiRunsHere } from "./askYourAi";
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
}

/** A Note's latest request at its foot, as the input and its label show it. */
export interface NoteAsk {
  turnId: string | null;
  pairingId: string;
  agent: string;
  state: NoteTurnEvent["state"];
  doing: NoteTurnEvent["doing"];
  problem: NoteTurnProblem | null;
  versions: { found: string; lowest: string } | null;
  reply: string;
  /** Paragraphs changed at once in the Note asked from. */
  changed: number;
  waiting: NoteTurnEvent["waiting"];
  made: NoteTurnEvent["made"];
  fresh: boolean;
  /** Sent again once the User lets the agent propose changes. */
  asked: NoteAsked;
}

export const useNoteAsks = create<{ byMind: Readonly<Record<string, NoteAsk>> }>(() => ({
  byMind: {},
}));

/** The turns this window asked for, whose changes it applies. */
const askedHere = new Set<string>();

/** Whether the Note shows its input: only the User's own AI asks, and one of its agents can run so. */
export function useNoteAskShown(mindId: string): boolean {
  const hidden = useHiddenForOwnAi();
  const agents = useAgentsToAsk(mindId);
  const runsHere = useOwnAiRunsHere();
  return hidden && agents.some((each) => runsInBackground(each, runsHere));
}

export const noteAskShownNow = (mindId: string): boolean =>
  hiddenForOwnAiNow() &&
  agentsToAsk(mindId).some((each) => runsInBackground(each, ownAiRunsHereNow()));

const put = (mindId: string, ask: NoteAsk | null) =>
  useNoteAsks.setState((state) => {
    const { [mindId]: _gone, ...rest } = state.byMind;
    return { byMind: ask ? { ...rest, [mindId]: ask } : rest };
  });

const nameOf = (mindId: string, pairingId: string) =>
  agentsToAsk(mindId).find((each) => each.id === pairingId)?.name ?? "";

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
  const was = useNoteAsks.getState().byMind[event.mindId];
  if (was && was.turnId !== null && was.turnId !== event.turnId && was.state === "working") return;
  put(event.mindId, {
    turnId: event.turnId,
    pairingId: event.pairingId,
    agent: was?.agent || nameOf(event.mindId, event.pairingId),
    state: event.state,
    doing: event.doing ?? (event.state === "working" ? (was?.doing ?? null) : null),
    problem: event.problem,
    versions: null,
    reply: event.reply,
    changed: sum(event.applied, "changed") + sum(event.applied, "added"),
    waiting: event.waiting,
    made: event.made,
    fresh: event.fresh,
    asked: was?.asked ?? { words: "", quote: "", selection: null },
  });
  if (event.state === "working" || !askedHere.delete(event.turnId)) return;
  const byNote = new Map<string, NoteChangeApplied[]>();
  for (const each of event.applied)
    byNote.set(each.mindId, [...(byNote.get(each.mindId) ?? []), each]);
  const askedFrom = currentTabOf(useAppStore.getState().layout)?.item ?? null;
  // Loaded when a turn ends: the selection menu's edits load this module, and the assistant's
  // applied edits load the menu's.
  void import("./askedChanges")
    .then(({ applyTurn }) =>
      Promise.all(
        [...byNote].map(([mindId, applied]) => {
          const row = rowOf(mindId, applied);
          return applyTurn(event.turnId, row, () => row, {
            made: false,
            created: false,
            askedFrom,
          });
        }),
      ),
    )
    .catch(useAppStore.getState().reportError);
}

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  core.on("agents.noteTurn", heard);
}

/**
 * Sends a request typed at the Note's foot. "link": no agent can run it in the background now,
 * and the caller asks by the link instead.
 */
export async function askInNote(
  mindId: string,
  asked: NoteAsked,
): Promise<"started" | "problem" | "link"> {
  listen();
  const start = await core.askInNote({
    mindId,
    words: asked.words,
    ...(asked.quote !== "" && { quote: asked.quote }),
    ...(asked.selection && { selection: asked.selection }),
  });
  if (start.kind === "link") return "link";
  const base: NoteAsk = {
    turnId: start.kind === "started" ? start.turnId : null,
    pairingId: start.pairing.id,
    agent: start.pairing.name,
    state: start.kind === "started" ? "working" : "failed",
    doing: null,
    problem: start.kind === "problem" ? start.problem : null,
    versions: start.kind === "problem" ? (start.versions ?? null) : null,
    reply: "",
    changed: 0,
    waiting: [],
    made: [],
    fresh: false,
    asked,
  };
  if (start.kind === "started") askedHere.add(start.turnId);
  const current = useNoteAsks.getState().byMind[mindId];
  // An event can arrive before the reply to the request: it wins.
  if (current?.turnId !== base.turnId || base.turnId === null) put(mindId, base);
  else put(mindId, { ...current, asked });
  return start.kind;
}

export const stopInNote = (mindId: string): Promise<void> => core.stopInNote(mindId);

/** Lets the agent propose changes, the switch Settings shows, and sends the request again. */
export async function allowAndAskAgain(mindId: string): Promise<void> {
  const ask = useNoteAsks.getState().byMind[mindId];
  if (!ask) return;
  await core.updateAgent(ask.pairingId, { propose: true });
  await askInNote(mindId, ask.asked);
}

/**
 * A selection toolbar action sent as a request of the Note's input (ADR-0034), with the words
 * selected as its context. "link": no agent runs it in the background now, and the caller hands
 * the selection over by the link as before; "none": nothing is selected; "busy": a request of the
 * Note's is still running, and this one is not sent.
 */
export async function askFromSelection(
  state: EditorState,
  mindId: string,
  words: string,
): Promise<"started" | "problem" | "link" | "none" | "busy"> {
  const running = useNoteAsks.getState().byMind[mindId];
  // A new request waits for Stop, as Return at the input does while one runs (ADR-0034).
  if (running?.state === "working") {
    useNotices.getState().confirm("noteAsk.busy", { agent: running.agent }, { look: true });
    return "busy";
  }
  const selected = selectedForRequest(state);
  if (!selected) return "none";
  return askInNote(mindId, { words, quote: selected.quote, selection: selected.selection });
}

/** Puts the keyboard in the Note's input, where ⌘J asks with the words selected as context. */
export function focusNoteAsk(mindId: string): void {
  document
    .querySelector<HTMLTextAreaElement>(
      `[data-testid="note-ask"][data-mind-id="${CSS.escape(mindId)}"] [data-note-ask-input]`,
    )
    ?.focus();
}

/** The label goes once the User starts the next request, or closes it. */
export const clearNoteAsk = (mindId: string): void => {
  const ask = useNoteAsks.getState().byMind[mindId];
  if (ask && ask.state !== "working") put(mindId, null);
};

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
      before: state.doc.textBetween(start, Math.max(start, from), " ", ""),
      after: state.doc.textBetween(Math.min(end, to), end, " ", ""),
    });
  });
  const quote = state.doc.textBetween(from, to, " ", "").trim();
  return quote !== "" && selection.length > 0 ? { quote: quote.slice(0, 4000), selection } : null;
}
