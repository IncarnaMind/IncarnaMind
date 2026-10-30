import type { Editor } from "@tiptap/core";
import { useEffect } from "react";
import type * as Y from "yjs";
import type { WindowLayout } from "../../../core/api";
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
  choices(): { update: (() => void) | null; keepOld: (() => void) | null };
  /** What its card offers, for ⌘K, which takes them as it opens: a click there closes the card. */
  here(): CommandContext["here"];
}> = { current: null };

/** The open Mind's find bar: what "Find next" and "Find previous" do. */
export const findHandle: Handle<{ next(): void; previous(): void }> = { current: null };

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
  if (!layout) return null;
  const shown = (group: { activeTabId: string | null } | undefined) =>
    group?.activeTabId ? (citedVersionHandles.get(group.activeTabId) ?? null) : null;
  const focused = shown(layout.groups.find((group) => group.id === layout.focusedGroupId));
  if (focused) return focused;
  for (const group of layout.groups) {
    const active = shown(group);
    if (active) return active;
  }
  // A window of one group shows a Document beside the Mind without making its tab the active one.
  return [...citedVersionHandles.values()].at(-1) ?? null;
}

export const homeNextHandle: Handle<{ label: string; busy: boolean; run(): Promise<void> }> = {
  current: null,
};

export const sidebarHandle: Handle<{ hidden: boolean; toggle(): void }> = { current: null };

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

/** The words selected in a Document's viewer (#101), while they are: what its selection menu does with them. */
export const viewerSelectionHandle: Handle<{
  /** Not offered while a Question waits for a model (#1789). */
  ask?: () => void;
  addToNote(): void;
  copy(): void;
}> = {
  current: null,
};

/** The Transcript in view (#139): the line the User is on, which "Add transcript line to note" adds. */
export const transcriptHandle: Handle<{ hasLine(): boolean; addLine(): Promise<void> }> = {
  current: null,
};
