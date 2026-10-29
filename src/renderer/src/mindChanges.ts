/**
 * The Minds an Answer in the assistant changed or made (#202), as its card
 * shows them (`MindChangesCard`): one row for each Mind, with how many of its
 * changes still wait there. Review and Open bring the Mind up at its first
 * change; Accept all and Reject all act on every row at once, with Undo on
 * the Answer's line and ⌘Z. Rejecting a Mind the Answer made deletes it,
 * which closes its tab, unless something else is in it now; Undo brings it
 * back beside the Mind in focus.
 *
 * The card reads and changes each Mind through a copy of its document in this
 * window (./mindCopies), the editor's or not: its counts follow every change
 * made anywhere, and what Accept all or Reject all did is undone there. Only
 * the last few of those steps keep their copies, and can be undone.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import * as Y from "yjs";
import {
  MIND_CONTENT_FIELD,
  MIND_PROPOSAL_REQUESTS_FIELD,
  MIND_REVISIONS_FIELD,
  type ProposalRef,
} from "../../core/api";
import { originMaps } from "../../shared/blockOrigins";
import { holdsOnlyItsTitle } from "../../shared/madeMind";
import { aiUseOfAccepted, decideProposals, pendingProposals } from "../../shared/proposals";
import { nameOlderCitations } from "../../shared/signOffs";
import type { ChangedMind } from "./changedMinds";
import { readMindHandle } from "./commands/handles";
import { core } from "./core";
import { pendingIn } from "./editor/proposalReview";
import { openMindCopy } from "./mindCopies";
import { useAppStore } from "./store";
import { answerUndoPlace, type Undoable, useUndo } from "./undo";

/** A copy of a Mind's document, shared by everything in the window that reads it through here. */
interface Held {
  users: number;
  doc: Y.Doc | null;
  /** Resolves once the copy has arrived; null when it couldn't be opened. */
  ready: Promise<Y.Doc | null>;
  listeners: Set<() => void>;
  close(): void;
}

const held = new Map<string, Held>();

function hold(mindId: string): Held {
  const found = held.get(mindId);
  if (found) {
    found.users += 1;
    return found;
  }
  let arrived: (doc: Y.Doc | null) => void = () => undefined;
  const entry: Held = {
    users: 1,
    doc: null,
    ready: new Promise((resolve) => {
      arrived = resolve;
    }),
    listeners: new Set(),
    close: () => undefined,
  };
  const changed = () => {
    for (const listener of entry.listeners) listener();
  };
  entry.close = openMindCopy(
    mindId,
    ({ doc }) => {
      entry.doc = doc;
      doc?.on("update", changed);
      arrived(doc);
      changed();
    },
    (error) => {
      useAppStore.getState().reportError(error);
      arrived(null);
    },
  );
  held.set(mindId, entry);
  return entry;
}

function release(mindId: string): void {
  const entry = held.get(mindId);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  held.delete(mindId);
  entry.close();
}

const belongsTo = (requests: readonly string[]) => (proposal: ProposalRef) =>
  requests.includes(proposal.request);

/** Changes in a Mind: those of `requests`, or, for null, every change waiting there. */
interface WaitingIn {
  mindId: string;
  requests: readonly string[] | null;
}

/**
 * How many of a row's changes wait in its Mind, counted as the Mind's bar and its change card
 * count them (what Accept and Reject act on), or every change from anyone; null until its copy
 * has arrived.
 */
function waiting(row: WaitingIn): { count: number; ids: readonly string[] } | null {
  const doc = held.get(row.mindId)?.doc;
  if (!doc) return null;
  const belongs = row.requests ? belongsTo(row.requests) : () => true;
  const pending = pendingProposals(doc.getXmlFragment(MIND_CONTENT_FIELD)).filter(belongs);
  return { count: pending.length, ids: pending.map((each) => each.id) };
}

/** How many of a row's changes wait in its Mind, and which: a count, "gone" for a Mind deleted, null until its copy arrives. */
export type Waiting = number | "gone" | null;

export interface WaitingRow {
  count: Waiting;
  /** The changes still waiting there, so a card can tell its copy has taken the ones an apply took. */
  pending: readonly string[];
}

/**
 * How many of each row's changes wait in its Mind, as they change. Holds a
 * copy of each Mind still there while the card is shown.
 */
export function useWaitingChanges(rows: readonly WaitingIn[]): WaitingRow[] {
  const minds = useAppStore((state) => state.minds);
  const live = useMemo(
    () => rows.filter((row) => minds.some((mind) => mind.id === row.mindId)),
    [rows, minds],
  );
  // The Minds held, by id, one a line: the copies change only when they do.
  const key = live.map((row) => row.mindId).join("\n");
  useEffect(() => {
    const ids = key === "" ? [] : key.split("\n");
    for (const id of ids) hold(id);
    return () => {
      for (const id of ids) release(id);
    };
  }, [key]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const entries = (key === "" ? [] : key.split("\n")).flatMap((id) => held.get(id) ?? []);
      for (const entry of entries) entry.listeners.add(listener);
      return () => {
        for (const entry of entries) entry.listeners.delete(listener);
      };
    },
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, () =>
    rows
      .map((row) => {
        if (!live.includes(row)) return "gone|";
        const counted = waiting(row);
        return counted ? `${counted.count}|${counted.ids.join(" ")}` : "|";
      })
      .join(";"),
  );
  return snapshot.split(";").map((each) => {
    const [count = "", ids = ""] = each.split("|");
    return {
      count: count === "gone" ? "gone" : count === "" ? null : Number(count),
      pending: ids === "" ? [] : ids.split(" "),
    };
  });
}

/** How many changes wait in a Mind, from anyone, as they change. */
export function useWaitingIn(mindId: string | null): Waiting {
  const rows = useMemo(() => (mindId ? [{ mindId, requests: null }] : []), [mindId]);
  return useWaitingChanges(rows)[0]?.count ?? null;
}

/** Brings a Mind up beside the focused one, where it is open, else in a new tab. */
const openBeside = (mindId: string) =>
  useAppStore.getState().changeLayout({
    type: "open",
    item: { kind: "mind", mindId },
    where: { in: "place" },
  });

/** Frames to wait for a Mind just opened to show its changes. */
const REVEAL_FRAMES = 60;

/** Puts the cursor in the first of the changes `picked` picks in a Mind open in the editor, once it shows them. */
function revealChange(
  mindId: string,
  picked: (proposal: ProposalRef) => boolean,
  frames = REVEAL_FRAMES,
): void {
  const read = readMindHandle.current;
  if (read && read.mindId === mindId && !read.editor.isDestroyed) {
    const first = pendingIn(read.editor.state).find(picked);
    if (first) {
      const at = first.block ? first.from + 1 : first.from;
      read.editor
        .chain()
        .focus()
        .setTextSelection(Math.min(at, read.editor.state.doc.content.size))
        .scrollIntoView()
        .run();
      return;
    }
  }
  if (frames > 0) requestAnimationFrame(() => revealChange(mindId, picked, frames - 1));
}

/** Review and Open: the Mind, at its first change from the Answer. */
export function showChanges(row: ChangedMind): void {
  useAppStore.getState().openMind(row.mindId);
  revealChange(row.mindId, belongsTo(row.requests));
}

/** Review beside the Note's count of what waits: the Mind, at the change of this Answer that waits, else at the first of any. */
export function showNoteWaiting(row: ChangedMind): void {
  useAppStore.getState().openMind(row.mindId);
  const own = waiting({ mindId: row.mindId, requests: row.requests });
  revealChange(row.mindId, own && own.count > 0 ? belongsTo(row.requests) : () => true);
}

/** Review, where changes waiting kept the assistant from changing a Mind: the Mind, at its first change. */
export function showWaitingChanges(mindId: string): void {
  useAppStore.getState().openMind(mindId);
  revealChange(mindId, () => true);
}

/** One Mind's part of Accept all or Reject all: how many changes it took, and how to take it back and do it again. */
interface Done {
  count: number;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** It can't be undone any more: what it kept for that goes. */
  forget(): void;
}

/**
 * Reject all in a Mind the Answer made: its changes go, and so does the Mind,
 * closing its tab, once nothing else is in it (the User may have written in
 * it, or accepted some). Undo brings it back beside the focused one.
 */
async function rejectMade(row: ChangedMind): Promise<Done | null> {
  const rejected = await resolveRow(row, "reject");
  const doc = held.get(row.mindId)?.doc;
  const title = useAppStore.getState().minds.find((mind) => mind.id === row.mindId)?.title ?? "";
  if (!rejected || !doc || !holdsOnlyItsTitle(doc.getXmlFragment(MIND_CONTENT_FIELD), title)) {
    return rejected;
  }
  await core.deleteMind(row.mindId);
  return {
    count: rejected.count,
    undo: async () => {
      await core.restore([{ kind: "mind", id: row.mindId }]);
      await rejected.undo();
      await openBeside(row.mindId);
    },
    redo: async () => {
      await rejected.redo();
      await core.deleteMind(row.mindId);
    },
    forget: rejected.forget,
  };
}

/** Accepts or rejects a row's changes in its Mind's copy, which stays held so the step can be undone. */
async function resolveRow(row: ChangedMind, outcome: "accept" | "reject"): Promise<Done | null> {
  const entry = hold(row.mindId);
  const doc = await entry.ready;
  const picked = belongsTo(row.requests);
  const blocks = doc?.getXmlFragment(MIND_CONTENT_FIELD);
  if (!doc || !blocks || !pendingProposals(blocks).some(picked)) {
    release(row.mindId);
    return null;
  }
  // A Checkpoint of the Mind before an AI change goes in (#113).
  if (outcome === "accept") {
    try {
      await core.saveCheckpoint(row.mindId, "accept");
    } catch (error) {
      release(row.mindId);
      throw error;
    }
  }
  const origin = { mindChanges: row.mindId };
  // The requests' map too, which keeps what the User decided (`decideProposals`), the origins a
  // reject gives back (`restoreOrigins`) and the revisions it forgets (#1903).
  const steps = new Y.UndoManager(
    [
      blocks,
      doc.getMap(MIND_PROPOSAL_REQUESTS_FIELD),
      doc.getMap(MIND_REVISIONS_FIELD),
      ...originMaps(doc),
    ],
    { trackedOrigins: new Set([origin]) },
  );
  let resolved: ReturnType<typeof decideProposals> = [];
  nameOlderCitations(blocks);
  doc.transact(() => {
    resolved = decideProposals(blocks, picked, outcome);
  }, origin);
  if (outcome === "accept") {
    const entries = aiUseOfAccepted(doc, row.mindId, resolved, new Date().toISOString());
    if (entries.length > 0) core.recordAiUse(entries).catch(useAppStore.getState().reportError);
  }
  return {
    count: resolved.length,
    undo: async () => {
      steps.undo();
    },
    redo: async () => {
      steps.redo();
    },
    forget: () => {
      steps.destroy();
      release(row.mindId);
    },
  };
}

/** How many Accept all and Reject all steps keep their Minds' copies, to be undone: an older one leaves the Undo stack. */
const KEPT_STEPS = 5;

const kept: { change: Undoable; done: readonly Done[] }[] = [];

/** Keeps what a step needs to be undone, and lets go of the oldest step's beyond `KEPT_STEPS`. */
function keep(change: Undoable, done: readonly Done[]): void {
  kept.push({ change, done });
  for (const oldest of kept.splice(0, Math.max(0, kept.length - KEPT_STEPS))) {
    useUndo.getState().withdraw(oldest.change);
    for (const step of oldest.done) step.forget();
  }
}

/**
 * Accept all or Reject all on an Answer's card: every row's changes, in its
 * Mind; a Mind the Answer made goes, once rejected. One step of Undo takes
 * back all of it, on the Answer's line and with ⌘Z.
 */
export async function resolveAllChanges(
  answerId: string,
  rows: readonly ChangedMind[],
  outcome: "accept" | "reject",
): Promise<void> {
  const minds = useAppStore.getState().minds;
  const done: Done[] = [];
  try {
    for (const row of rows) {
      if (!minds.some((mind) => mind.id === row.mindId)) continue;
      const step =
        outcome === "reject" && row.created
          ? await rejectMade(row)
          : await resolveRow(row, outcome);
      if (step) done.push(step);
    }
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
  if (done.length === 0) return;
  const count = done.reduce((sum, step) => sum + step.count, 0);
  const change: Undoable = {
    said: (t) =>
      outcome === "accept"
        ? count === 1
          ? t("proposal.accepted.one")
          : t("proposal.accepted", { count })
        : count === 1
          ? t("proposal.rejected.one")
          : t("proposal.rejected", { count }),
    shownAt: answerUndoPlace(answerId),
    undo: async () => {
      for (const step of [...done].reverse()) await step.undo();
    },
    redo: async () => {
      for (const step of done) await step.redo();
    },
  };
  useUndo.getState().push(change);
  keep(change, done);
}
