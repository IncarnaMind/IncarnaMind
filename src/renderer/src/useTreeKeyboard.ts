import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import type { CommandId } from "../../shared/commands";
import { objectAt } from "./commands/keymap";
import { commands } from "./commands/registry";
import type { ObjectKind } from "./objects";
import { extendThroughRows, selectedOn } from "./selection";
import { useAppStore } from "./store";
import { isTreeDeleteKey, moveThroughRows, SHOWN_ROW_EVENT } from "./treeKeys";
import { firstChildOf, jumpTo, parentOf, type TreeRow, typedAfter } from "./treeNavigation";

/*
 * The sidebar's tree by keyboard (docs/agents/interaction.md, rule 7): one
 * stop in the Tab order, and from it ↑ ↓ Home End move (Shift extends the
 * selection), → opens a row or steps into it, ← closes it or steps out,
 * typing a name jumps to it, and ⌘⌫ (Delete on Windows and Linux) deletes.
 * Enter, Space and F2 are the rows' own. The rows are `treeitem`s (see
 * `useTreeItem`); they say what they hold with `aria-level` and `aria-expanded`.
 */

const ROW = '[role="treeitem"]';
const OBJECT_ROW = "[data-object-row]";

/** What the key moves to Recently deleted, by kind. A Linked folder is unlinked after a question, so not by a key. */
const DELETES: Partial<Record<ObjectKind, CommandId>> = {
  mind: "mind.delete",
  document: "document.delete",
  folder: "folder.delete",
  tag: "tag.delete",
};

const rowsIn = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>(ROW));

const modelOf = (row: HTMLElement): TreeRow => ({
  level: Number(row.getAttribute("aria-level")) || 1,
  expanded: row.hasAttribute("aria-expanded")
    ? row.getAttribute("aria-expanded") === "true"
    : undefined,
  name: row.textContent ?? "",
});

// The focus in a row's ⋯ button or menu is the row's: a Delete from the menu hands it on from there.
const rowOf = (element: Element): HTMLElement | null =>
  element instanceof HTMLElement && element.matches(ROW)
    ? element
    : (element.closest(OBJECT_ROW)?.querySelector<HTMLElement>(ROW) ?? null);

/** What a row stands for, to find it again once the list has drawn it anew or moved it. */
const thingOf = (row: HTMLElement): string | null => {
  const object = objectAt(row);
  return object ? `${object.kind}:${object.id}` : null;
};

/** A letter, digit or sign that adds to the name typed: not Space, which a row keeps for itself, nor a shortcut. */
const isNameKey = (event: KeyboardEvent) =>
  !event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  event.key !== " " &&
  Array.from(event.key).length === 1;

/** Deletes the object of the focused row, or the whole selection if the row is part of it. */
function deleteFrom(row: HTMLElement): void {
  const object = objectAt(row);
  if (!object) return;
  const chosen = selectedOn("sidebar");
  const selection = chosen.some((each) => each.kind === object.kind && each.id === object.id)
    ? chosen
    : [];
  const mixed = new Set(selection.map((each) => each.kind)).size > 1;
  const command = mixed ? "selection.delete" : DELETES[object.kind];
  if (!command) return;
  commands
    .run(command, { selection, focus: object, surface: "sidebar" })
    .catch(useAppStore.getState().reportError);
}

/**
 * Keeps exactly one row in the Tab order (the last to have the focus, else the
 * first) and puts the focus back when its row goes: on what the row stood for,
 * wherever the list has put it now (renamed, so sorted elsewhere; moved to
 * another Folder), else on the row that took its place (deleted).
 */
function useOneTabStop(tree: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = tree.current;
    if (!root) return;
    let stop: HTMLElement | null = null;
    let last: HTMLElement | null = null;
    let lastAt = 0;
    let lastThing: string | null = null;
    let holdsFocus = false;

    const remembered = (rows: HTMLElement[]) =>
      (lastThing && rows.find((row) => thingOf(row) === lastThing)) ||
      rows[Math.min(lastAt, rows.length - 1)] ||
      null;
    // With no row left in the tree, the focus goes to the one above it, such as the Library's.
    const rowAbove = () =>
      Array.from(root.parentElement?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? [])
        .filter((row) => root.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING)
        .at(-1) ?? null;
    const remember = (row: HTMLElement) => {
      last = row;
      lastAt = Math.max(rowsIn(root).indexOf(row), 0);
      lastThing = thingOf(row);
    };

    const sync = () => {
      const rows = rowsIn(root);
      const keep = last && rows.includes(last) ? last : remembered(rows);
      for (const row of rows) {
        const tabindex = row === keep ? "0" : "-1";
        if (row.getAttribute("tabindex") !== tabindex) row.setAttribute("tabindex", tabindex);
      }
      stop = keep;
    };

    const keepFocus = () => {
      const lost = last;
      if (!holdsFocus || !lost || lost.isConnected) return;
      const rows = rowsIn(root);
      // A row that's gone hands the focus on at once, not a frame or two later: on a slow
      // machine a key pressed straight after a Delete went to the page and did nothing.
      if (!rows.some((row) => thingOf(row) === lastThing)) {
        if (document.activeElement === document.body) (remembered(rows) ?? rowAbove())?.focus();
        return;
      }
      // After a renamed row has taken the focus back itself (`useRename`), if it will.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (last !== lost || document.activeElement !== document.body) return;
          remembered(rowsIn(root))?.focus();
        }),
      );
    };

    const holdsRows = (nodes: NodeList) =>
      Array.from(nodes).some(
        (node) => node instanceof Element && (node.matches(ROW) || node.querySelector(ROW)),
      );
    const observer = new MutationObserver((records) => {
      if (!records.some((record) => holdsRows(record.addedNodes) || holdsRows(record.removedNodes)))
        return;
      sync();
      keepFocus();
    });
    observer.observe(root, { childList: true, subtree: true });

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      const row = target instanceof Element ? rowOf(target) : null;
      if (!row) return;
      remember(row);
      holdsFocus = true;
      if (target !== row || stop === row) return;
      stop?.setAttribute("tabindex", "-1");
      row.setAttribute("tabindex", "0");
      stop = row;
    };
    // A row still there with the focus gone elsewhere is not one to put the focus back on.
    const onFocusOut = (event: FocusEvent) => {
      const left = event.target instanceof Element ? rowOf(event.target) : null;
      requestAnimationFrame(() => {
        if (last === left && last?.isConnected && !root.contains(document.activeElement)) {
          holdsFocus = false;
        }
      });
    };
    const onShown = (event: Event) => {
      const row = event.target;
      if (!(row instanceof HTMLElement) || !row.matches(ROW)) return;
      remember(row);
      sync();
    };
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener(SHOWN_ROW_EVENT, onShown);
    sync();
    return () => {
      observer.disconnect();
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener(SHOWN_ROW_EVENT, onShown);
    };
  }, [tree]);
}

/**
 * The keys of the sidebar's tree: `tree` is the element with `role="tree"`,
 * and `onKeyDown` goes on it. Keys typed in a field (a name being renamed) or
 * the note never reach it as a row's, and nothing happens while an input
 * method is composing.
 */
export function useTreeKeyboard(tree: RefObject<HTMLElement | null>) {
  useOneTabStop(tree);
  const typed = useRef({ text: "", at: Number.NEGATIVE_INFINITY });

  return {
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const row = event.target;
      if (!(row instanceof HTMLElement) || !row.matches(ROW)) return;
      if (isTreeDeleteKey(event)) {
        event.preventDefault();
        // A held key deletes the row it was pressed on, not the ones that come after it.
        if (!event.repeat) deleteFrom(row);
        return;
      }
      if (moveThroughRows(event) || extendThroughRows(event, "sidebar")) return;

      const stepsInOrOut =
        (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey;
      const typing = isNameKey(event);
      if (!stepsInOrOut && !typing) return;

      const rows = rowsIn(event.currentTarget);
      const model = rows.map(modelOf);
      const at = rows.indexOf(row);
      if (stepsInOrOut) {
        const to = event.key === "ArrowRight" ? firstChildOf(model, at) : parentOf(model, at);
        if (to === null) return;
        event.preventDefault();
        rows[to]?.focus();
        return;
      }
      const text = typedAfter(typed.current.text, event.key, event.timeStamp - typed.current.at);
      typed.current = { text, at: event.timeStamp };
      const to = jumpTo(model, at, text);
      if (to === null || to === at) return;
      event.preventDefault();
      rows[to]?.focus();
    },
  };
}
