/**
 * Each tab's copy of the Note it shows, and the Undo history every editor of that tab shares
 * (#3115). The copy opens when the tab first shows the Note and stays open, in step with the core,
 * until the tab leaves the window's layout. Showing another tab, moving the tab to another group or
 * the window's groups merging ends only the editor: the one drawn when the Note shows again binds
 * the same copy and history, so ⌘Z there takes back what the User did before. Another tab or window
 * showing the Note has a copy and a history of its own, and a Note opened later starts with none.
 */
import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, type WindowLayout } from "../../core/api";
import { core } from "./core";
import { keepHistory } from "./editor/keptHistories";
import { keepOthersWords } from "./editor/othersWords";
import { type OpenedCopy, openMindCopy } from "./mindCopies";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

export interface TabCopy {
  copy: OpenedCopy;
  /** The Note's Undo history in this tab; null for a copy that is only looked at. */
  history: Y.UndoManager | null;
}

/** Where the User was in the tab's Note as its editor ended: the cursor, held by Yjs, and the view. */
export interface NotePlace {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
  scrollTop: number;
  /** The Block at the view's top, and how far into it, in pixels, the view starts. */
  top: { blockId: string; into: number } | null;
}

interface Holder {
  opened(copy: TabCopy): void;
  failed(error: unknown): void;
}

interface Kept {
  tabId: string;
  mindId: string;
  ready: TabCopy | null;
  place: NotePlace | null;
  holders: Set<Holder>;
  close(): void;
  endHistory(): void;
}

const kept = new Map<string, Kept>();
const keyOf = (tabId: string, mindId: string) => `${tabId}\n${mindId}`;

/** The tab's copy of the Note once its state has arrived: an editor shown again draws it at once. */
export const tabCopyNow = (tabId: string, mindId: string): TabCopy | null =>
  kept.get(keyOf(tabId, mindId))?.ready ?? null;

/**
 * Holds the tab's copy of the Note, opening it the first time: `opened` hears it once its state has
 * arrived (at once when it has), `failed` why it couldn't be opened or kept in step. Returns what
 * stops hearing; the copy itself stays until the tab closes.
 */
export function holdTabCopy(
  tabId: string,
  mindId: string,
  opened: (copy: TabCopy) => void,
  failed: (error: unknown) => void,
): () => void {
  followLayout();
  const entry = kept.get(keyOf(tabId, mindId)) ?? open(tabId, mindId);
  const holder: Holder = { opened, failed };
  entry.holders.add(holder);
  if (entry.ready) {
    // Shown again from its copy, the Note isn't opened again: what opening it settles is settled now.
    core.settleUnfinished(mindId).catch((error: unknown) => {
      useAppStore.getState().reportError(error);
    });
    opened(entry.ready);
  }
  return () => {
    entry.holders.delete(holder);
  };
}

function open(tabId: string, mindId: string): Kept {
  const entry: Kept = {
    tabId,
    mindId,
    ready: null,
    place: null,
    holders: new Set(),
    close: () => undefined,
    endHistory: () => undefined,
  };
  kept.set(keyOf(tabId, mindId), entry);
  entry.close = openMindCopy(
    mindId,
    (copy) => {
      if (kept.get(keyOf(tabId, mindId)) !== entry) return;
      const history = copy.doc && copy.access === "edit" ? historyOf(copy.doc) : null;
      if (history && copy.doc) {
        const end = keepHistory(history, tabId, mindId);
        const unguard = keepOthersWords(copy.doc, history);
        endAppRedoOnNewStep(history);
        entry.endHistory = () => {
          unguard();
          end();
          history.destroy();
        };
      }
      entry.ready = { copy, history };
      for (const holder of [...entry.holders]) holder.opened(entry.ready);
    },
    (error) => {
      // One that never opened is opened again when its tab next shows the Note.
      if (!entry.ready) end(entry);
      const holders = [...entry.holders];
      if (holders.length === 0) useAppStore.getState().reportError(error);
      for (const holder of holders) holder.failed(error);
    },
  );
  return entry;
}

/** Keeps where the User was in the tab's Note, for when it shows there again. */
export function rememberPlace(tabId: string, mindId: string, place: NotePlace): void {
  const entry = kept.get(keyOf(tabId, mindId));
  if (entry) entry.place = place;
}

export const placeIn = (tabId: string, mindId: string): NotePlace | null =>
  kept.get(keyOf(tabId, mindId))?.place ?? null;

/** The history y-tiptap would make for one editor, made once for the tab (`yUndoPlugin`). */
const historyOf = (doc: Y.Doc) =>
  new Y.UndoManager(doc.getXmlFragment(MIND_CONTENT_FIELD), {
    trackedOrigins: new Set([ySyncPluginKey]),
    deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
    captureTransaction: (transaction) => transaction.meta.get("addToHistory") !== false,
  });

/**
 * A step the User makes in the Note ends what the app's Redo would do again, as any new change
 * does: ⇧⌘Z in the Note's text goes on to the app's Redo once the Note has nothing to do again.
 * The Note's own Undo and Redo add their reverse step with the history as the origin, and a step
 * the app's Undo or Redo writes is part of that change. A line still offering that Redo goes too.
 */
function endAppRedoOnNewStep(history: Y.UndoManager): void {
  const made = ({ origin }: { origin: unknown }) => {
    if (origin === history || useUndo.getState().running) return;
    useUndo.setState(({ line }) => ({
      undone: [],
      ...(line?.told && line.redoes && { line: null }),
    }));
  };
  history.on("stack-item-added", made);
  history.on("stack-item-updated", made);
}

function end(entry: Kept): void {
  if (kept.get(keyOf(entry.tabId, entry.mindId)) !== entry) return;
  kept.delete(keyOf(entry.tabId, entry.mindId));
  entry.endHistory();
  entry.close();
}

const showsNote = (layout: WindowLayout, entry: Kept) =>
  layout.groups.some((group) =>
    group.tabs.some(
      (tab) =>
        tab.id === entry.tabId && tab.item.kind === "mind" && tab.item.mindId === entry.mindId,
    ),
  );

let following = false;

/** A tab that leaves the layout, closed or its Note deleted, takes its copy and history with it. */
function followLayout(): void {
  if (following) return;
  following = true;
  useAppStore.subscribe(({ layout }, before) => {
    if (!layout || layout === before.layout) return;
    for (const entry of [...kept.values()]) if (!showsNote(layout, entry)) end(entry);
  });
}
