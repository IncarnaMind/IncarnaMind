import type { Editor } from "@tiptap/core";
import { createContext, useContext, useEffect } from "react";
import type * as Y from "yjs";
import type { WindowLayout } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import type { CommandContext } from "./registry";

/** Something a command acts on that lives in a component, there while the component is. */
export interface Handle<T> {
  current: T | null;
}

/** The window's one assistant (#253): what only it can do, such as open its History. */
export const assistantHandle: Handle<{ openHistory(): void }> = { current: null };

/** The Citation whose card is open: what "Open cited page" opens, and its needs re-check choices (#99). */
export const citationHandle: Handle<{
  open(): void;
  choices(): {
    update: (() => void) | null;
    keepOld: (() => void) | null;
    pageChecked: (() => void) | null;
  };
  /** What its card offers, for ⌘K, which takes them as it opens: a click there closes the card. */
  here(): CommandContext["here"];
}> = { current: null };

/** The open Mind's find bar: what "Find next" and "Find previous" do. */
export const findHandle: Handle<{ next(): void; previous(): void }> = { current: null };

/**
 * The command palette is open, or opening: its dialog takes the page's selection a frame after
 * ⌘K, so a viewer keeps the words selected until it has.
 */
export const paletteOpen = { current: false };

/** One version a Citation was made from, open in a viewer: what "Open the current version" opens (#2159). */
export interface CitedVersionAction {
  openCurrent(): void;
}

/** The versions Citations were made from, open in viewers (#2159), by tab: they can be open in more than one. */
export const citedVersionHandles = new Map<string, CitedVersionAction>();

/** The open cited version the User is in, else one a group shows, else the one opened last (#2159). */
export function citedVersionInUse(
  layout: Pick<WindowLayout, "groups" | "focusedGroupId"> | null,
): CitedVersionAction | null {
  // Without a layout there is no tab in use yet.
  return layout ? handleInUse(citedVersionHandles, layout) : null;
}

export const homeNextHandle: Handle<{ label: string; busy: boolean; run(): Promise<void> }> = {
  current: null,
};

export const sidebarHandle: Handle<{ hidden: boolean; toggle(): void }> = { current: null };

/** From ⌘K, the Mind last written in; from the keys, only while its text has the focus. */
export function noteToWrite(ctx: CommandContext): Editor | null {
  const editor = noteHandle.current?.editor;
  if (!editor || editor.isDestroyed || !editor.isEditable) return null;
  return ctx.surface === "palette" || editor.view.hasFocus() ? editor : null;
}

/** The Mind the User last wrote in: its editor and its document, for the commands on its text. */
export const noteHandle: Handle<{
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  /** The tab it is drawn in, else the Mind: where its check card opens. */
  place: string;
}> = {
  current: null,
};

/**
 * The Mind the assistant reads (#253), open in its editor: where Add to note
 * puts an Answer, at its cursor (`cursorInMind`) or at its end (#201), and
 * where a second Esc in the assistant goes back to (`returnToNote`).
 */
export const readMindHandle: Handle<{
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  /** Whether the Mind's cursor is where an Answer goes: else, at the Mind's end. */
  cursorInMind(): boolean;
  /**
   * Whether the User has put the cursor in the Mind since it opened: a quote from a Document
   * beside it goes there, however the focus went to the Document (#101).
   */
  cursorPlaced(): boolean;
  /** Puts the focus back in the note, where its cursor was, or at its end. */
  returnToNote(): void;
}> = { current: null };

/** Lends `value` to commands through `handle` while the calling component is mounted. */
export function useHandle<T>(handle: Handle<T>, value: T): void {
  useEffect(() => {
    handle.current = value;
    return () => {
      if (handle.current === value) handle.current = null;
    };
  }, [handle, value]);
}

/** The words or cells selected in a Document's viewer (#101, #118): what its menu does with them. */
export interface ViewerAskActions {
  /** Use as Citation, while a sentence waits for its Citation in this Document (#1554). */
  cite?: () => void;
  /** Not offered while a Question waits for a model (#1789). */
  ask?: () => void;
  addToNote(): void;
  copy(): void;
  /** Highlights the words in the colour last chosen (#327); absent for a range of cells. */
  highlight?(): void;
  /** Highlights the words, then opens their note ready to type (#327). */
  note?(): void;
}

/** What a viewer offers the commands: by tab, so two viewers never take each other's (#118). */
interface ViewerActions {
  selection: ViewerAskActions;
  range: ViewerAskActions;
  slide: { ask?: () => void };
  area: {
    select?: () => void;
    /** Starts a pick whose release highlights the region (#327); absent where areas aren't picked. */
    highlight?: () => void;
  };
}

const viewerActions: { [K in keyof ViewerActions]: Map<string, ViewerActions[K]> } = {
  selection: new Map(),
  range: new Map(),
  slide: new Map(),
  area: new Map(),
};

/** The tab a viewer is drawn in: what the handle it lends the commands is filed under. */
export const ViewerTabContext = createContext<string | null>(null);

/** Lends `value` to the commands for this viewer's tab: the focused viewer's wins when two are open. */
export function useViewerHandle<K extends keyof ViewerActions>(
  kind: K,
  value: ViewerActions[K] | null,
  tabId?: string | null,
): void {
  const fromContext = useContext(ViewerTabContext);
  const id = tabId ?? fromContext;
  useEffect(() => {
    if (!id || value === null) return;
    const actions = viewerActions[kind] as Map<string, ViewerActions[K]>;
    actions.set(id, value);
    return () => {
      if (actions.get(id) === value) actions.delete(id);
    };
  }, [kind, id, value]);
}

/** The actions of the tab a layout puts in use: its focused group's, else a group's shown one, else the last. */
export function handleInUse<T>(
  actions: ReadonlyMap<string, T>,
  layout: Pick<WindowLayout, "groups" | "focusedGroupId"> | null,
): T | null {
  const shown = (group: { activeTabId: string | null } | undefined) =>
    group?.activeTabId ? (actions.get(group.activeTabId) ?? null) : null;
  const focused = layout
    ? shown(layout.groups.find((group) => group.id === layout.focusedGroupId))
    : null;
  if (focused) return focused;
  if (layout) {
    for (const group of layout.groups) {
      const active = shown(group);
      if (active) return active;
    }
  }
  return [...actions.values()].at(-1) ?? null;
}

/** The viewer's actions the commands act on: never whichever viewer mounted last (#118). */
export function viewerHandleInUse<K extends keyof ViewerActions>(
  kind: K,
  layout: Pick<WindowLayout, "groups" | "focusedGroupId"> | null,
): ViewerActions[K] | null {
  return handleInUse(viewerActions[kind] as Map<string, ViewerActions[K]>, layout);
}

/**
 * The Transcript in view (#139): the line the User is on, which "Add transcript line to note"
 * adds, and whose Speaker "Change who speaks…" opens (#138). Its audio plays from the word the
 * caret is at, else the line's start, and the line splits at the caret (#138). A `can…` says
 * true, or why not.
 */
export const transcriptHandle: Handle<{
  hasLine(): boolean;
  addLine(): Promise<void>;
  canChangeSpeaker(): boolean;
  changeSpeaker(): void;
  canPlay(): true | MessageKey;
  play(): void;
  /** Whether its player plays now; null while it has none open. */
  playing(): boolean | null;
  togglePlayback(): Promise<void>;
  canSplit(): true | MessageKey;
  split(): Promise<void>;
}> = {
  current: null,
};
