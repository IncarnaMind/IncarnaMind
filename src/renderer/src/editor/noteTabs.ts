/**
 * Tabs in a Note (#3414). A Note stays one sequence of Blocks: a tab starts at a tab Block
 * (`NOTE_TAB_NODE`), which holds its title, and is the Blocks after it up to the next; those
 * before the first tab Block are a tab with no title of its own. The page shows one tab at a time:
 * the one the selection is in. Every other top-level Block, and every tab Block, is hidden by a
 * decoration, so the editor, its Undo, its marks, comments, find and the Yjs binding keep the
 * whole Note as they always have.
 *
 * - Anything that puts the selection in another tab (a jump to a check, a Citation, a heading or a
 *   find's match) opens that tab, as the page then shows where the selection is.
 * - A key in the page never takes the selection, or a change, out of the tab it is in: Backspace
 *   at the tab's start and Delete at its end do nothing, as at a Note's ends, and ⌘A selects the
 *   tab. A selection reaching across tabs another way (the Edit menu's Select All) is cut to one.
 * - Each tab keeps its own cursor and scroll place while the Note is open in this window.
 */
import { type Editor, Extension, isMacOS } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  AllSelection,
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { BLOCK_ID_ATTRIBUTE, NOTE_TAB_NODE, NOTE_TAB_TITLE_ATTRIBUTE } from "../../../core/api";
import type { WordsInLine } from "../lineNames";
import { asOneStep, offerEditorUndo } from "./editorUndo";

export interface NoteTab {
  /** Its tab Block's id; null for the Blocks before the first tab Block, which have none. */
  id: string | null;
  /** "" when it has none: the panel names it by its number. */
  title: string;
  /** Where its tab Block is; null for none. */
  at: number | null;
  /** Where its own Blocks start and end: from the one after its tab Block up to the next tab Block. */
  from: number;
  to: number;
}

/** A Note's tabs, in order; none for a Note without a tab Block, which is one tab. */
export function tabsOf(doc: ProseMirrorNode): NoteTab[] {
  const starts: { id: string; title: string; at: number }[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name !== NOTE_TAB_NODE) return;
    const title = node.attrs[NOTE_TAB_TITLE_ATTRIBUTE];
    starts.push({
      id: String(node.attrs[BLOCK_ID_ATTRIBUTE] ?? ""),
      title: typeof title === "string" ? title.trim() : "",
      at: pos,
    });
  });
  if (starts.length === 0) return [];
  const tabs: NoteTab[] = [];
  const first = starts[0]?.at ?? 0;
  if (first > 0) tabs.push({ id: null, title: "", at: null, from: 0, to: first });
  starts.forEach((start, index) => {
    const node = doc.nodeAt(start.at);
    tabs.push({
      ...start,
      from: start.at + (node?.nodeSize ?? 1),
      to: starts[index + 1]?.at ?? doc.content.size,
    });
  });
  return tabs;
}

/**
 * The tab a position is in: a tab's own Blocks, and the end of its last one, which is where the
 * next tab Block starts. -1 before the first tab Block's own place.
 */
export function tabIndexAt(tabs: readonly NoteTab[], pos: number): number {
  return tabs.findIndex((tab) => tab.from <= pos && pos <= tab.to);
}

/** How a tab is known while the Note is open: its tab Block's id, "" for the one without. */
const keyOf = (tab: NoteTab) => tab.id ?? "";

interface TabsState {
  tabs: readonly NoteTab[];
  /** The tab shown, by its index; -1 in a Note without tabs. */
  open: number;
  decorations: DecorationSet;
  /** Where the cursor was in each tab the User left, by its key, as the text has changed since. */
  places: ReadonlyMap<string, { anchor: number; head: number }>;
}

const KEY = new PluginKey<TabsState>("noteTabs");
const NONE: TabsState = {
  tabs: [],
  open: -1,
  decorations: DecorationSet.empty,
  places: new Map(),
};

/** The tab's first Block, spaced from the page's top as a Note's first Block is, not from the hidden one before it. */
function tabStart(doc: ProseMirrorNode, tab: NoteTab): Decoration[] {
  const first = tab.from < tab.to ? doc.nodeAt(tab.from) : null;
  return first
    ? [
        Decoration.node(
          tab.from,
          tab.from + first.nodeSize,
          { class: "note-tab-start" },
          { tabStart: true },
        ),
      ]
    : [];
}

function hiding(doc: ProseMirrorNode, tab: NoteTab | undefined): DecorationSet {
  if (!tab) return DecorationSet.empty;
  const hidden: Decoration[] = [];
  doc.forEach((node, pos) => {
    const shown = node.type.name !== NOTE_TAB_NODE && pos >= tab.from && pos < tab.to;
    if (!shown)
      hidden.push(Decoration.node(pos, pos + node.nodeSize, { class: "note-tab-hidden" }));
  });
  return DecorationSet.create(doc, [...hidden, ...tabStart(doc, tab)]);
}

/** What hides the other tabs, moved with the text typed in the tab shown, its first Block found again. */
function typedIn(before: DecorationSet, tr: Transaction, doc: ProseMirrorNode, tab: NoteTab) {
  const mapped = before.map(tr.mapping, doc);
  const start = mapped.find(undefined, undefined, (spec) => spec.tabStart === true);
  return mapped.remove(start).add(doc, tabStart(doc, tab));
}

const openIn = (tabs: readonly NoteTab[], selection: Selection) =>
  tabs.length === 0 ? -1 : Math.max(0, tabIndexAt(tabs, selection.from));

function stateFor(
  state: EditorState,
  before: TabsState | null,
  change?: { tr: Transaction; old: EditorState },
): TabsState {
  const tr = change?.tr;
  const tabs = before && tr && !tr.docChanged ? before.tabs : tabsOf(state.doc);
  if (tabs.length === 0) return NONE;
  const open = openIn(tabs, state.selection);
  const places = new Map<string, { anchor: number; head: number }>();
  for (const [key, place] of before?.places ?? []) {
    places.set(
      key,
      tr ? { anchor: tr.mapping.map(place.anchor), head: tr.mapping.map(place.head) } : place,
    );
  }
  const left = before?.tabs[before.open];
  const now = tabs[open];
  if (change && left && now && keyOf(left) !== keyOf(now)) {
    const { anchor, head } = change.old.selection;
    places.set(keyOf(left), {
      anchor: change.tr.mapping.map(anchor),
      head: change.tr.mapping.map(head),
    });
  }
  const same = before !== null && before.open === open && before.tabs === tabs;
  // Typing in the tab shown changes no other: what hides them only moves with the text.
  const typed =
    before !== null &&
    tr !== undefined &&
    left !== undefined &&
    keyOf(left) === (now ? keyOf(now) : null) &&
    sameTabs(before.tabs, tabs) &&
    !stepsLeave(tr, left);
  return {
    tabs,
    open,
    decorations: same
      ? before.decorations
      : typed && tr && now
        ? typedIn(before.decorations, tr, state.doc, now)
        : hiding(state.doc, now),
    places,
  };
}

const sameTabs = (a: readonly NoteTab[], b: readonly NoteTab[]) =>
  a.length === b.length && a.every((tab, index) => keyOf(tab) === keyOf(b[index] ?? tab));

/** Set while a key that moves the cursor or joins lines is handled: what it does stays in the tab. */
let keying = false;

/** The keys ProseMirror, the lists, the tables and the gap cursor move the cursor or join lines with. */
const MOVING_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Tab",
]);

/** Where `tab`'s Blocks are once a transaction's steps are done; null if one reached out of them. */
function tabAfter(tr: Transaction, tab: NoteTab): { from: number; to: number } | null {
  let from = tab.from;
  let to = tab.to;
  for (const step of tr.steps) {
    let out = false;
    step.getMap().forEach((oldStart, oldEnd) => {
      out ||= oldStart < from || oldEnd > to;
    });
    if (out) return null;
    from = step.getMap().map(from, -1);
    to = step.getMap().map(to, 1);
  }
  return { from, to };
}

const stepsLeave = (tr: Transaction, tab: NoteTab) => tabAfter(tr, tab) === null;

/** Whether a change, or the selection it leaves, reaches out of `tab`. */
function leaves(tr: Transaction, tab: NoteTab): boolean {
  const after = tabAfter(tr, tab);
  return after === null || tr.selection.from < after.from || tr.selection.to > after.to;
}

/**
 * The selection cut to one tab, or null when it is in one: the tab that was shown (`was`, by its
 * key), when the selection reaches into it, or else the tab its head is in.
 */
function cutToTab(state: EditorState, was: string | null): Selection | null {
  const { selection, doc } = state;
  const { tabs } = noteTabsOf(state);
  const start = tabIndexAt(tabs, selection.from);
  const end = tabIndexAt(tabs, selection.to);
  if (start === end && start >= 0 && !(selection instanceof AllSelection)) return null;
  const shown = tabs.findIndex((tab) => keyOf(tab) === was);
  const reached = shown >= 0 && (start <= shown || start < 0) && (end >= shown || end < 0);
  const tab = tabs[reached ? shown : Math.max(0, tabIndexAt(tabs, selection.head))];
  if (!tab) return null;
  const first = Selection.findFrom(doc.resolve(tab.from), 1, true);
  const last = Selection.findFrom(doc.resolve(tab.to), -1, true);
  if (!first || !last || first.from > last.to) return null;
  const clamp = (pos: number) => Math.min(Math.max(pos, first.from), last.to);
  return TextSelection.between(
    doc.resolve(clamp(selection.anchor)),
    doc.resolve(clamp(selection.head)),
  );
}

/** A selection resting in a tab Block, as a Yjs render can leave it, moved to its tab's text. */
function outOfTabBlock(state: EditorState): Selection | null {
  const { $from } = state.selection;
  if ($from.depth !== 1 || $from.parent.type.name !== NOTE_TAB_NODE) return null;
  return Selection.findFrom(state.doc.resolve($from.after()), 1) ?? null;
}

/** Where a tab Block has nothing after it, up to the next or the Note's end: an empty line goes there. */
function emptyTabs(doc: ProseMirrorNode): number[] {
  const ends: number[] = [];
  doc.forEach((node, pos, index) => {
    if (node.type.name !== NOTE_TAB_NODE) return;
    const next = index + 1 < doc.childCount ? doc.child(index + 1) : null;
    if (!next || next.type.name === NOTE_TAB_NODE) ends.push(pos + node.nodeSize);
  });
  return ends;
}

/** Where the page's scroll was in each tab of each Note, while the window is open. */
const scrolls = new Map<string, Map<string, number>>();

export interface NoteTabsOptions {
  /** The Note shown: each tab's scroll place is kept by it. */
  mindId: string;
}

export const NoteTabs = Extension.create<NoteTabsOptions>({
  name: "noteTabs",
  // Before the editor's keys, the lists', the tables' and the gap cursor's, which would move the
  // cursor, or join a line, across a tab Block.
  priority: 1200,

  addOptions() {
    return { mindId: "" };
  },

  addProseMirrorPlugins() {
    const { mindId } = this.options;
    const { editor } = this;
    return [
      new Plugin<TabsState>({
        key: KEY,
        state: {
          init: (_config, state) => stateFor(state, null),
          apply: (tr, before, old, state) =>
            !tr.docChanged && !tr.selectionSet && before.tabs.length === 0
              ? before
              : stateFor(state, before, { tr, old }),
        },
        filterTransaction(tr, state) {
          if (!keying || !(tr.docChanged || tr.selectionSet)) return true;
          if (tr.getMeta(ySyncPluginKey) !== undefined) return true;
          const mine = KEY.getState(state);
          const tab = mine?.tabs[mine.open];
          return !tab || !leaves(tr, tab);
        },
        appendTransaction(transactions, old, state) {
          if (noteTabsOf(state).tabs.length === 0) return null;
          // A tab left with no Blocks gets an empty line, so it can be written in (#3414).
          if (editor.isEditable && transactions.some((each) => each.docChanged)) {
            const ends = emptyTabs(state.doc);
            if (ends.length > 0) {
              const tr = state.tr;
              for (const end of ends.reverse()) {
                const line = newLine(state);
                if (line) tr.insert(end, line);
              }
              const remote = transactions.some(
                (each) => each.getMeta(ySyncPluginKey) !== undefined,
              );
              return remote ? tr.setMeta("addToHistory", false) : tr;
            }
          }
          const before = noteTabsOf(old);
          const was = before.tabs[before.open];
          const cut = outOfTabBlock(state) ?? cutToTab(state, was ? keyOf(was) : null);
          return cut ? state.tr.setSelection(cut).setMeta("addToHistory", false) : null;
        },
        props: {
          decorations: (state) => KEY.getState(state)?.decorations ?? null,
          handleKeyDown(view, event) {
            const mine = KEY.getState(view.state);
            if (!mine || mine.tabs.length === 0) return false;
            const mod = isMacOS() ? event.metaKey : event.ctrlKey;
            if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
              return selectTab(view, mine.tabs[mine.open]);
            }
            if (!MOVING_KEYS.has(event.key)) return false;
            keying = true;
            queueMicrotask(() => {
              keying = false;
            });
            return false;
          },
        },
        view: (view) => keptScroll(view, mindId),
      }),
    ];
  },
});

/** ⌘A in a tab: its text, as ⌘A in a Note without tabs selects the Note's. */
function selectTab(view: EditorView, tab: NoteTab | undefined): boolean {
  if (!tab) return false;
  const { doc } = view.state;
  const first = Selection.findFrom(doc.resolve(tab.from), 1, true);
  const last = Selection.findFrom(doc.resolve(tab.to), -1, true);
  if (!first || !last || first.from > last.to) return true;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, first.from, last.to)));
  return true;
}

/** Keeps each tab's scroll place, and brings it back as the tab opens again. */
function keptScroll(view: EditorView, mindId: string) {
  const kept = scrolls.get(mindId) ?? new Map<string, number>();
  scrolls.set(mindId, kept);
  const shownKey = (state: EditorState) => {
    const mine = KEY.getState(state);
    const tab = mine?.tabs[mine.open];
    return tab ? keyOf(tab) : null;
  };
  let shown = shownKey(view.state);
  let scroller: HTMLElement | null = null;
  const onScroll = () => {
    if (scroller && shown !== null) kept.set(shown, scroller.scrollTop);
  };
  const attach = () => {
    if (scroller || typeof view.dom?.closest !== "function") return;
    scroller = view.dom.closest<HTMLElement>(".mind-scroller");
    scroller?.addEventListener("scroll", onScroll, { passive: true });
  };
  return {
    update(current: EditorView) {
      attach();
      const now = shownKey(current.state);
      if (now === shown) return;
      shown = now;
      if (scroller && now !== null) scroller.scrollTop = kept.get(now) ?? 0;
    },
    destroy() {
      scroller?.removeEventListener("scroll", onScroll);
    },
  };
}

/** The Note's tabs, and the one shown; no tabs in a Note without a tab Block. */
export function noteTabsOf(state: EditorState): { tabs: readonly NoteTab[]; open: number } {
  const mine = KEY.getState(state);
  return { tabs: mine?.tabs ?? [], open: mine?.open ?? -1 };
}

/** The top-level stretches the page doesn't show: every tab but the open one. */
export function tabHiddenRanges(state: EditorState): { from: number; to: number }[] {
  const { tabs, open } = noteTabsOf(state);
  const tab = tabs[open];
  if (!tab) return [];
  const ranges: { from: number; to: number }[] = [];
  if (tab.from > 0) ranges.push({ from: 0, to: tab.from });
  if (tab.to < state.doc.content.size) ranges.push({ from: tab.to, to: state.doc.content.size });
  return ranges;
}

/** Where the open tab ends, or the Note does: what Add to note and a click below the text reach. */
export function shownEnd(state: EditorState): number {
  const { tabs, open } = noteTabsOf(state);
  return tabs[open]?.to ?? state.doc.content.size;
}

/** A selection in the tab: where its cursor was left, else at its start. */
function placeIn(state: EditorState, tab: NoteTab, index: number): Selection {
  const { doc } = state;
  const kept = KEY.getState(state)?.places.get(keyOf(tab));
  if (kept && kept.anchor >= tab.from && kept.head <= tab.to && kept.head >= tab.from) {
    try {
      return TextSelection.between(doc.resolve(kept.anchor), doc.resolve(kept.head));
    } catch {
      // A place the text no longer has: the tab's start.
    }
  }
  const text = Selection.findFrom(doc.resolve(tab.from), 1, true);
  if (text && text.from <= tab.to) return text;
  const node = Selection.findFrom(doc.resolve(tab.from), 1, false);
  if (node && node.to <= tab.to) return node;
  const block = doc.nodeAt(tab.from);
  return block && index >= 0 && NodeSelection.isSelectable(block)
    ? NodeSelection.create(doc, tab.from)
    : Selection.near(doc.resolve(tab.from));
}

/** Shows a tab: the cursor goes where it was in it, and the page to where it was read. */
export function openNoteTab(editor: Editor, index: number, { focus = false } = {}): void {
  if (editor.isDestroyed) return;
  const { tabs, open } = noteTabsOf(editor.state);
  const tab = tabs[index];
  if (!tab) return;
  if (index !== open) {
    const tr = editor.state.tr
      .setSelection(placeIn(editor.state, tab, index))
      .setMeta("addToHistory", false);
    editor.view.dispatch(tr);
  }
  // At once, not on the next frame as the focus command does: a double-click's second press
  // takes the focus to the tab's name field after it, never before it.
  if (focus && editor.isEditable) editor.view.focus();
}

/** Opens the tab a position is in, before something there is shown that isn't a selection. */
export function openTabAt(editor: Editor, pos: number): void {
  const { tabs, open } = noteTabsOf(editor.state);
  const index = tabIndexAt(tabs, pos);
  if (index >= 0 && index !== open) openNoteTab(editor, index);
}

/**
 * An empty line with its own id: UniqueID would give a new line after a new tab Block the tab
 * Block's id, as it does a line split at its start, and the tab another.
 */
const newLine = (state: EditorState) =>
  state.schema.nodes.paragraph?.create({ [BLOCK_ID_ATTRIBUTE]: crypto.randomUUID() });

const tabBlock = (state: EditorState, title: string) =>
  state.schema.nodes[NOTE_TAB_NODE]?.create({
    [BLOCK_ID_ATTRIBUTE]: crypto.randomUUID(),
    [NOTE_TAB_TITLE_ATTRIBUTE]: title,
  });

/** A name for a new tab no other has: "Tab 3", from the number it will be. */
function freshTitle(tabs: readonly NoteTab[], named: (n: number) => string, n: number): string {
  const taken = new Set(tabs.map((tab) => tab.title));
  let at = n;
  while (taken.has(named(at))) at++;
  return named(at);
}

/**
 * Adds a tab at the end of the Note and opens it, one step of Undo. In a Note without tabs, its
 * text becomes the first tab, titled as `named` numbers it. Returns the new tab's id.
 */
export function addNoteTab(editor: Editor, named: (n: number) => string): string | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { tabs } = noteTabsOf(editor.state);
  const state = editor.state;
  const paragraph = newLine(state);
  const count = tabs.length === 0 ? 2 : tabs.length + 1;
  const title = freshTitle(tabs, named, count);
  const added = tabBlock(state, title);
  const first = tabs.length === 0 ? tabBlock(state, named(1)) : null;
  if (!paragraph || !added || (tabs.length === 0 && !first)) return null;
  asOneStep(editor, () => {
    const tr = state.tr;
    if (first) tr.insert(0, first);
    const end = tr.doc.content.size;
    tr.insert(end, [added, paragraph]);
    tr.setSelection(TextSelection.create(tr.doc, end + added.nodeSize + 1));
    editor.view.dispatch(tr);
  });
  return String(added.attrs[BLOCK_ID_ATTRIBUTE]);
}

/** Gives a tab a new title, one step of Undo: the first tab of a Note gains its tab Block. */
export function renameNoteTab(editor: Editor, index: number, title: string): void {
  const name = title.trim();
  const tab = noteTabsOf(editor.state).tabs[index];
  if (editor.isDestroyed || !tab || name === "" || name === tab.title) return;
  asOneStep(editor, () => {
    const { tr } = editor.state;
    if (tab.at === null) {
      const block = tabBlock(editor.state, name);
      if (block) tr.insert(0, block);
    } else {
      tr.setNodeAttribute(tab.at, NOTE_TAB_TITLE_ATTRIBUTE, name);
    }
    editor.view.dispatch(tr);
  });
}

/**
 * Moves a tab, with its Blocks, to be the `to`th, one step of Undo with its line. The Blocks before
 * the first tab Block gain one first, so they move as a tab too.
 */
export function moveNoteTab(
  editor: Editor,
  index: number,
  to: number,
  named: (n: number) => string,
  said: WordsInLine,
): void {
  const before = noteTabsOf(editor.state).tabs;
  if (editor.isDestroyed || !editor.isEditable || !before[index] || to === index) return;
  if (to < 0 || to >= before.length) return;
  const state = editor.state;
  const tr = state.tr;
  const lead = before[0]?.at === null ? tabBlock(state, named(1)) : null;
  if (lead) tr.insert(0, lead);
  const tabs = tabsOf(tr.doc);
  const moved = tabs[index];
  const target = tabs[to];
  if (!moved || moved.at === null || !target || target.at === null) return;
  const start = moved.at;
  const end = moved.to;
  const content = tr.doc.slice(start, end).content;
  const { selection } = state;
  const mapped = tr.mapping.map(selection.from);
  const inside = mapped >= moved.from && mapped <= moved.to;
  const offset = {
    anchor: tr.mapping.map(selection.anchor) - start,
    head: tr.mapping.map(selection.head) - start,
  };
  tr.delete(start, end);
  const place = tr.mapping
    .slice(tr.mapping.maps.length - 1)
    .map(to > index ? target.to : target.at, to > index ? 1 : -1);
  tr.insert(place, content);
  if (inside) {
    try {
      tr.setSelection(
        TextSelection.between(
          tr.doc.resolve(place + offset.anchor),
          tr.doc.resolve(place + offset.head),
        ),
      );
    } catch {
      // The selection's place didn't come through: the mapping's is kept.
    }
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, said);
}

/**
 * Deletes a tab and its Blocks, one step of Undo with its line; the tab after it opens, or the
 * one before. A Note keeps at least one tab.
 */
export function deleteNoteTab(editor: Editor, index: number, said: WordsInLine): void {
  const { tabs, open } = noteTabsOf(editor.state);
  const tab = tabs[index];
  if (editor.isDestroyed || !editor.isEditable || !tab || tabs.length < 2) return;
  const state = editor.state;
  const tr = state.tr.delete(tab.at ?? 0, tab.to);
  if (index === open) {
    const next = tabsOf(tr.doc)[Math.min(index, tabs.length - 2)];
    if (next) tr.setSelection(placeIn(state.apply(tr), next, index));
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, said);
}
