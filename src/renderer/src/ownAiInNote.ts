/**
 * The input at a Note's foot, for a User whose own AI is a command-line one IncarnaMind runs in
 * the background (ADR-0034, #3627): what is asked, how each request goes as the core tells it
 * ("agents.noteTurn"), and the changes it made in the Note it was asked from, applied at once in
 * the window that asked, with the applied-edit line and its Undo, as the assistant's are
 * (`applyTurn`).
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { create } from "zustand";
import type {
  NoteAnswer,
  NoteChangeApplied,
  NoteQuestion,
  NoteSelectionBlock,
  NoteStep,
  NoteTurnEvent,
  NoteTurnProblem,
} from "../../core/api";
import { NODE_CHARACTER } from "../../shared/proposals";
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
  /** With nothing selected, the opening words of the paragraph the cursor is in; "" for none. */
  caret?: string;
}

/** A Note's latest request at its foot, as the input and its label show it. */
export interface NoteAsk {
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
  /** Paragraphs changed at once in the Note asked from. */
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
  /** Sent again once the User lets the agent propose changes. */
  asked: NoteAsked;
}

export const useNoteAsks = create<{ byMind: Readonly<Record<string, NoteAsk>> }>(() => ({
  byMind: {},
}));

/**
 * What the conversation shows of each request beyond IncarnaMind's record (#3677): its steps in
 * order, the model that answered, and how long it took, kept in the window while it is open.
 */
export interface NoteTrail {
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
}

export const useNoteTrails = create<{ byTurn: Readonly<Record<string, NoteTrail>> }>(() => ({
  byTurn: {},
}));

/** Where the User last moved the conversation, on this computer: it opens there after a restart. */
const PLACE_KEY = "incarnamind.noteConversation.place";

function savedPlace(): "upward" | "column" {
  try {
    return localStorage.getItem(PLACE_KEY) === "column" ? "column" : "upward";
  } catch {
    return "upward";
  }
}

/**
 * Each Note's conversation: whether it is open, the model it asks on, whether it was just started
 * anew, and the reply it opens at. It opens in one place for every Note, the User's to move: upward
 * from the input's box at the Note's foot, or in the window's column (#3677, #3759).
 */
export const useNoteColumns = create<{
  open: Readonly<Record<string, boolean>>;
  model: Readonly<Record<string, string>>;
  started: Readonly<Record<string, boolean>>;
  /** The reply the conversation opens at, from the line. */
  at: Readonly<Record<string, string>>;
  place: "upward" | "column";
}>(() => ({ open: {}, model: {}, started: {}, at: {}, place: savedPlace() }));

/** Opens the conversation at a reply, as pressing the line does. */
export const openColumnAt = (mindId: string, turnId: string | null) =>
  useNoteColumns.setState((state) => ({
    open: { ...state.open, [mindId]: true },
    at: turnId ? { ...state.at, [mindId]: turnId } : state.at,
  }));

export const setColumnOpen = (mindId: string, open: boolean) =>
  useNoteColumns.setState((state) => ({ open: { ...state.open, [mindId]: open } }));

export const useColumnOpen = (mindId: string): boolean =>
  useNoteColumns((state) => state.open[mindId] ?? false);

/** Moves the open conversation between its two places; it stays open, and the input goes with it. */
export function moveConversation(place: "upward" | "column"): void {
  useNoteColumns.setState({ place });
  try {
    localStorage.setItem(PLACE_KEY, place);
  } catch {
    // Not remembered, then: it opens upward after the next restart.
  }
}

function keepTrail(event: NoteTurnEvent): void {
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
          mindId: event.mindId,
          state: event.state,
          doing: ended ? (was?.doing ?? null) : event.doing,
          steps: event.steps.length > 0 || !was ? event.steps : was.steps,
          model: event.model ?? was?.model ?? null,
          startedAt: was?.startedAt ?? event.startedAt,
          endedAt: ended ? new Date().toISOString() : null,
          fresh: event.fresh || (was?.fresh ?? false),
          renewed: event.renewed || (was?.renewed ?? false),
          documentsFound: Math.max(event.documentsFound, was?.documentsFound ?? 0),
          mode: event.mode ?? was?.mode ?? null,
          askingSince: asking ? (since ?? now) : null,
          waitedMs: (was?.waitedMs ?? 0) + (since !== null && !asking ? now - since : 0),
        },
      },
    };
  });
}

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
  keepTrail(event);
  const was = useNoteAsks.getState().byMind[event.mindId];
  if (was && was.turnId !== null && was.turnId !== event.turnId && was.state === "working") return;
  // A turn that ended stays ended: nothing of it said later takes it back to working.
  if (was?.turnId === event.turnId && was.state !== "working" && event.state === "working") return;
  // Stopped, the request leaves nothing behind: no line, no reply (#3677).
  if (event.state === "stopped") {
    askedHere.delete(event.turnId);
    put(event.mindId, null);
    return;
  }
  put(event.mindId, {
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
    asked: was?.asked ?? { words: "", quote: "", selection: null },
  });
  if (event.state === "working" || !askedHere.delete(event.turnId)) return;
  // Claude Code no longer had the Note's conversation, so this request began a new one.
  if (event.fresh) useNotices.getState().confirm("noteAsk.fresh");
  const byNote = new Map<string, NoteChangeApplied[]>();
  // A change in a Note the agent wrote applied already, with its own Undo there.
  for (const each of event.applied.filter((change) => !change.own))
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
export function listen(): void {
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
  const model = useNoteColumns.getState().model[mindId];
  // A new request brings the newest back into view in the column.
  useNoteColumns.setState((state) => {
    const { [mindId]: _shown, ...at } = state.at;
    return { started: { ...state.started, [mindId]: false }, at };
  });
  const start = await core.askInNote({
    mindId,
    words: asked.words,
    ...(model && { model }),
    ...(asked.quote !== "" && { quote: asked.quote }),
    ...(asked.selection && { selection: asked.selection }),
    ...(asked.caret && !asked.selection && { caret: asked.caret }),
  });
  if (start.kind === "link") return "link";
  const base: NoteAsk = {
    turnId: start.kind === "started" ? start.turnId : null,
    pairingId: start.pairing.id,
    agent: start.pairing.name,
    state: start.kind === "started" ? "working" : "failed",
    doing: null,
    startedAt: start.kind === "started" ? new Date().toISOString() : null,
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

/** Answers what the User's own AI asks in the Note's conversation (#3653). */
export const answerInNote = (mindId: string, questionId: string, answer: NoteAnswer) =>
  core.answerInNote(mindId, questionId, answer).catch(useAppStore.getState().reportError);

/**
 * A window opened while a request runs at the Note's foot hears of it, and of what its AI asks,
 * from the core: a waiting question tells nothing more until it is answered (#3653).
 */
export async function seedRunning(mindId: string): Promise<void> {
  if (useNoteAsks.getState().byMind[mindId]) return;
  listen();
  const now = await core.noteTurnNow(mindId);
  if (now && !useNoteAsks.getState().byMind[mindId]) heard(now);
}

/**
 * Lets the agent propose changes, the switch Settings shows, and sends the request again: as this
 * window sent it, else from `turn`, the record of it a window that didn't send it has.
 */
export async function allowAndAskAgain(
  mindId: string,
  turn?: { request: string; quote: string },
): Promise<void> {
  const ask = useNoteAsks.getState().byMind[mindId];
  if (!ask) return;
  // The record keeps the words a request was about, not where they are: sent again without them,
  // its changes would no longer be held to them, so such a request is left for the User to ask.
  const asked =
    ask.asked.words !== ""
      ? ask.asked
      : turn && turn.request !== "" && turn.quote === ""
        ? { words: turn.request, quote: "", selection: null }
        : null;
  await core.updateAgent(ask.pairingId, { propose: true });
  if (asked) await askInNote(mindId, asked);
  else clearNoteAsk(mindId);
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

/**
 * Puts the keyboard in the Note's input, where ⌘J asks with the words selected as context: at the
 * Note's foot, or at the column's foot while it is open (#3677).
 */
export function focusNoteAsk(mindId: string): void {
  document
    .querySelector<HTMLTextAreaElement>(`[data-note-ask-input="${CSS.escape(mindId)}"]`)
    ?.focus();
}

/** The label goes once the User starts the next request, or closes it. */
export const clearNoteAsk = (mindId: string): void => {
  const ask = useNoteAsks.getState().byMind[mindId];
  if (ask && ask.state !== "working") put(mindId, null);
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
