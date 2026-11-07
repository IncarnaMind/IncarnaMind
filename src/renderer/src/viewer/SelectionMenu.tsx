import { flip, hide, offset, shift, type VirtualElement } from "@floating-ui/dom";
import { isMacOS } from "@tiptap/core";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AskedQuote, Document } from "../../../core/api";
import { type CitationPick, citeChosenWords, usePickIn } from "../citationPick";
import { useViewerHandle } from "../commands/handles";
import { keysHere, shortcutLabel } from "../commands/keymap";
import { AddToMindPicker } from "../components/assistant/AddToMindPicker";
import { ChatLineIcon, CopyLineIcon, LinkLineIcon, PlusLineIcon } from "../components/lineIcons";
import { holdsQuote, useComposer } from "../composer";
import { Popover } from "../editor/Popover";
import { useT } from "../i18n";
import { useSettingUp } from "../modelSetup";
import { type SelectionReader, selectionEnd } from "./selectedText";
import {
  addRangeToNote,
  addSelectionToNote,
  addsWithoutAsking,
  askAboutRange,
  askAboutSelection,
  citedSelection,
  citeRange,
  copyRange,
  copySelectionWithCitation,
  type RangeSelection,
  type ViewerSelection,
} from "./selectionActions";

interface Held {
  selection: ViewerSelection;
  range: Range;
}

// The focus in a field elsewhere (⌘K, the composer, the Mind picker) takes the page's selection
// with it, but the words selected are still the ones acted on.
const typesInField = (element: Element | null) =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;

const inPopover = (target: EventTarget | null) =>
  target instanceof Element && target.closest(".editor-popover") !== null;

const HELD = "viewer-held-selection";

// Shift and the arrows change a selection a key at a time: it is read once they stop.
const SETTLE_MS = 120;

function rangeIn(section: HTMLElement): Range | null {
  const selection = window.getSelection();
  const range =
    selection && !selection.isCollapsed && selection.rangeCount > 0
      ? selection.getRangeAt(0)
      : null;
  return range && section.contains(range.commonAncestorContainer) ? range : null;
}

// Chromium draws no selection the focus has left: the words acted on are drawn in the
// inactive-selection grey instead, as a Mind's are (#565).
function drawHeld(range: Range | null): void {
  const highlights = globalThis.CSS?.highlights;
  if (!highlights) return;
  if (range) highlights.set(HELD, new Highlight(range));
  else highlights.delete(HELD);
}

/**
 * The small menu under text selected in a Document's view (#101; DESIGN.md ›
 * Viewer › Selecting to ask), as the view reads it: Ask about this, Add to
 * note and Copy with citation. It shows once the mouse comes up on a selection,
 * or Shift extends one, and goes with it. ⌘/ moves into it, ↑ ↓ go through it,
 * Esc closes it, as the Mind's selection menu does. ⌘K reaches all three while
 * the selection lasts, and ⌘J asks about it.
 */
export function SelectionMenu({
  document,
  section,
  reader,
}: {
  document: Document;
  section: HTMLElement | null;
  reader: SelectionReader;
}) {
  const t = useT();
  const settingUp = useSettingUp();
  const [held, setHeld] = useState<Held | null>(null);
  const [asked, setAsked] = useState<AskedQuote | null>(null);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const firstAdd = useRef<HTMLButtonElement>(null);
  const pick = usePickIn(document.id);
  const [adding, setAdding] = useState<HTMLButtonElement | null>(null);
  const addButton = useCallback((element: HTMLButtonElement | null) => {
    setAdding(element);
    firstAdd.current = element;
  }, []);
  const focusBeforeMenu = useRef<HTMLElement | null>(null);
  const [focusWanted, setFocusWanted] = useState(false);
  const [away, setAway] = useState(false);

  useEffect(() => {
    if (!section) return;
    let pressed = false;
    let settling: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const range = rangeIn(section);
      if (!range) return;
      const { parts, shown } = reader(range);
      setHeld(
        parts.length > 0
          ? { selection: { document, parts, shown }, range: range.cloneRange() }
          : null,
      );
      setOpen(parts.length > 0);
      setPicking(false);
      setAway(false);
      setAsked(null);
    };
    const onDown = (event: PointerEvent) => {
      if (inPopover(event.target)) return;
      pressed = true;
      setOpen(false);
      setHeld(null);
      setAsked(null);
    };
    const onReleased = () => {
      pressed = false;
    };
    // Once the browser has settled the selection the press made.
    const onUp = (event: PointerEvent) => {
      if (event.button === 0 && !inPopover(event.target)) setTimeout(read);
    };
    const onChange = () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        if (!section.contains(selection.getRangeAt(0).commonAncestorContainer)) setHeld(null);
        // After a drag the focus is on the page's body, which no key event of the viewer reaches.
        else if (!pressed) {
          clearTimeout(settling);
          settling = setTimeout(read, SETTLE_MS);
        }
        return;
      }
      const focused = window.document.activeElement;
      if (typesInField(focused) || inPopover(focused)) {
        if (!inPopover(focused)) setOpen(false);
        setAway(true);
      } else setHeld(null);
    };
    section.addEventListener("pointerdown", onDown);
    section.addEventListener("pointerup", onUp);
    window.addEventListener("pointerup", onReleased);
    window.document.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(settling);
      section.removeEventListener("pointerdown", onDown);
      section.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointerup", onReleased);
      window.document.removeEventListener("selectionchange", onChange);
    };
  }, [section, document, reader]);

  // ⌘/ moves into the menu, opening it again over the selection if Esc closed it.
  useEffect(() => {
    if (!held) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const command = isMacOS() ? event.metaKey : event.ctrlKey;
      if (event.key !== "/" || !command || event.altKey || event.shiftKey || event.isComposing) {
        return;
      }
      if (typesInField(window.document.activeElement)) return;
      event.preventDefault();
      if (!menu.current?.contains(window.document.activeElement)) {
        focusBeforeMenu.current = window.document.activeElement as HTMLElement | null;
      }
      if (open) (settingUp && !pick ? firstAdd : firstItem).current?.focus();
      else {
        setFocusWanted(true);
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [held, open, settingUp, pick]);

  // Asked about, the words stay drawn while their chip waits in the composer, and go with it.
  useEffect(() => {
    if (!asked) return;
    return useComposer.subscribe(({ drafts }) => {
      if (!Object.values(drafts).some((draft) => holdsQuote(draft.quotes ?? [], asked))) {
        setHeld(null);
        setAsked(null);
      }
    });
  }, [asked]);

  useEffect(() => {
    drawHeld(held && away ? held.range : null);
    return () => drawHeld(null);
  }, [held, away]);

  const anchor = useMemo<VirtualElement | null>(
    () =>
      held && {
        getBoundingClientRect: () => selectionEnd(held.range),
        contextElement:
          held.range.endContainer instanceof Element
            ? held.range.endContainer
            : (held.range.endContainer.parentElement ?? undefined),
      },
    [held],
  );

  const close = useCallback(() => {
    setOpen(false);
    setPicking(false);
    setFocusWanted(false);
    if (menu.current?.contains(window.document.activeElement)) focusBeforeMenu.current?.focus();
  }, []);

  // What is selected when the User acts, should Shift have changed it since it was read.
  const heldNow = useCallback((): Held | null => {
    const range = section && rangeIn(section);
    const { parts, shown } = range ? reader(range) : { parts: [], shown: undefined };
    return range && parts.length > 0
      ? { selection: { document, parts, shown }, range: range.cloneRange() }
      : null;
  }, [section, reader, document]);

  const ask = useMemo(
    () =>
      held && !settingUp
        ? () => {
            close();
            void askAboutSelection((heldNow() ?? held).selection).then(setAsked);
          }
        : null,
    [held, settingUp, close, heldNow],
  );

  const cite = useMemo(
    () =>
      held && pick
        ? () => {
            close();
            const now = heldNow() ?? held;
            void citeChosenWords(pick, document, (mindId) => citedSelection(now.selection, mindId));
          }
        : null,
    [held, pick, close, heldNow, document],
  );

  useEffect(() => {
    if (!cite) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing || event.metaKey || event.ctrlKey) return;
      const focused = window.document.activeElement;
      if (typesInField(focused) || focused instanceof HTMLButtonElement) return;
      event.preventDefault();
      cite();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cite]);

  const actions = useMemo(
    () =>
      held && {
        ...(cite && { cite }),
        ...(ask && { ask }),
        addToNote: () => {
          const now = heldNow() ?? held;
          if (addsWithoutAsking()) {
            close();
            void addSelectionToNote(now.selection);
          } else {
            if (now !== held) setHeld(now);
            setOpen(true);
            setPicking(true);
            setAway(true);
          }
        },
        copy: () => {
          close();
          void copySelectionWithCitation((heldNow() ?? held).selection);
        },
      },
    [held, cite, ask, close, heldNow],
  );
  // Only while there is a selection, filed under this viewer's tab: another tab may hold one.
  useViewerHandle("selection", actions ?? null);

  if (!held || !actions || !anchor || !open) return null;
  return (
    <>
      <Popover
        anchor={anchor}
        placement="bottom-start"
        middleware={() => [offset(6), flip(), shift({ padding: 8 }), hide()]}
        role="menu"
        aria-label={t("viewer.selection.label")}
        data-testid="viewer-selection-menu"
        {...(focusWanted && { initialFocus: settingUp && !pick ? firstAdd : firstItem })}
        onDismiss={close}
        onKeyDown={menuKeys(menu)}
        className="viewer-selection-menu"
      >
        <SelectionMenuBody
          menu={menu}
          actions={actions}
          firstItem={firstItem}
          addButton={addButton}
        />
      </Popover>
      {picking && adding && (
        <AddToMindPicker
          anchor={adding}
          focusedMindId={null}
          atCursor={false}
          newFolderId={document.folderId}
          onChoose={(target) => {
            close();
            void addSelectionToNote(held.selection, target);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

/** What a viewer selection's menu offers, shared by words and by a range of cells (#101, #118). */
export interface SelectionMenuActions {
  /** Use as Citation, while a sentence waits for its Citation in this Document (#1554). */
  cite?: () => void;
  /** Not offered while a Question waits for a model (#1789). */
  ask?: () => void;
  addToNote(): void;
  copy(): void;
}

/** The arrows, Home and End move through a menu's items: shared by words and a range of cells. */
export function menuKeys(menu: RefObject<HTMLDivElement | null>) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(window.document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const next =
      event.key === "Home"
        ? items[0]
        : event.key === "End"
          ? items.at(-1)
          : step
            ? items[(at + step + items.length) % items.length]
            : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
}

/**
 * The menu's items in one order, and the arrows, Home and End through them: the words selected in
 * a Document and the cells of a sheet offer the same three actions.
 */
export function SelectionMenuBody({
  menu,
  actions,
  firstItem,
  addButton,
  size,
}: {
  menu: RefObject<HTMLDivElement | null>;
  actions: SelectionMenuActions;
  /** The first item, which takes the focus as the menu opens: Use as Citation while a sentence waits, else Ask. */
  firstItem: RefObject<HTMLButtonElement | null>;
  addButton: (element: HTMLButtonElement | null) => void;
  /** A range's size, above its actions: "3 rows × 4 columns". */
  size?: string;
}) {
  const t = useT();
  return (
    <div ref={menu} className="editor-menu">
      {size && (
        <p data-testid="viewer-selection-size" className="editor-menu-note">
          {size}
        </p>
      )}
      {actions.cite && <UseAsCitationItem ref={firstItem} onClick={actions.cite} />}
      {actions.ask && (
        <button
          ref={actions.cite ? undefined : firstItem}
          type="button"
          role="menuitem"
          data-testid="viewer-selection-ask"
          onMouseDown={(event) => event.preventDefault()}
          onClick={actions.ask}
          className="editor-menu-item"
        >
          <ChatLineIcon className="size-4 shrink-0 text-ink-secondary" />
          <span className="flex-1 truncate">{t("viewer.selection.ask")}</span>
          <kbd className="editor-menu-shortcut">{shortcutLabel("composer.focus")}</kbd>
        </button>
      )}
      <button
        ref={addButton}
        type="button"
        role="menuitem"
        aria-haspopup={addsWithoutAsking() ? undefined : "dialog"}
        data-testid="viewer-selection-add"
        onMouseDown={(event) => event.preventDefault()}
        onClick={actions.addToNote}
        className="editor-menu-item"
      >
        <PlusLineIcon className="size-4 shrink-0 text-ink-secondary" />
        <span className="flex-1 truncate">{t("viewer.selection.addToNote")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="viewer-selection-copy"
        onMouseDown={(event) => event.preventDefault()}
        onClick={actions.copy}
        className="editor-menu-item"
      >
        <CopyLineIcon className="size-4 shrink-0 text-ink-secondary" />
        <span className="flex-1 truncate">{t("viewer.selection.copy")}</span>
      </button>
    </div>
  );
}

/** Use as Citation (#1554): the item that gives the waiting sentence these words as its Citation. */
function UseAsCitationItem({
  ref,
  onClick,
}: {
  ref: RefObject<HTMLButtonElement | null>;
  onClick(): void;
}) {
  const t = useT();
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      data-testid="viewer-selection-cite"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="editor-menu-item"
    >
      <LinkLineIcon className="size-4 shrink-0 text-ink-secondary" />
      <span className="flex-1 truncate">{t("claim.useAsCitation")}</span>
      <kbd className="editor-menu-shortcut">{keysHere("Enter")}</kbd>
    </button>
  );
}

/** Use as Citation for a range of cells, while a sentence waits for its Citation in their sheet. */
export const citeRangeAction = (
  selection: RangeSelection,
  pick: CitationPick | null,
  then?: () => void,
): Pick<SelectionMenuActions, "cite"> =>
  pick
    ? {
        cite: () => {
          then?.();
          void citeChosenWords(pick, selection.document, (mindId) => citeRange(selection, mindId));
        },
      }
    : {};

/**
 * The menu for a range of cells selected in a sheet (#118): the same three
 * actions as words, with the range's size first. It closes on Esc or a press
 * outside it, and ⌘K reaches its actions while the cells stay selected.
 */
export function SheetSelectionMenu({
  selection,
  anchor,
  size,
  askable,
  onClose,
}: {
  selection: RangeSelection;
  /** Where its menu opens; null while it is closed, and the range's actions stay in ⌘K. */
  anchor: VirtualElement | null;
  size: string;
  /** Not offered while a Question waits for a model (#1789). */
  askable: boolean;
  onClose(): void;
}) {
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const [adding, setAdding] = useState<HTMLButtonElement | null>(null);
  const addButton = useCallback((element: HTMLButtonElement | null) => {
    addRef.current = element;
    setAdding(element);
  }, []);
  const [picking, setPicking] = useState(false);
  const { document } = selection;
  const pick = usePickIn(document.id);
  const actions = useMemo<SelectionMenuActions>(
    () => ({
      ...citeRangeAction(selection, pick, onClose),
      ...(askable && {
        ask: () => {
          onClose();
          void askAboutRange(selection);
        },
      }),
      addToNote: () => {
        if (addsWithoutAsking()) {
          onClose();
          void addRangeToNote(selection);
        } else setPicking(true);
      },
      copy: () => {
        onClose();
        void copyRange(selection);
      },
    }),
    [selection, pick, askable, onClose],
  );
  return (
    <>
      {anchor && (
        <Popover
          anchor={anchor}
          placement="bottom-start"
          middleware={() => [offset(6), flip(), shift({ padding: 8 }), hide()]}
          role="menu"
          aria-label={t("viewer.selection.range")}
          data-testid="viewer-selection-menu"
          initialFocus={askable || pick ? firstItem : addRef}
          onDismiss={onClose}
          onKeyDown={menuKeys(menu)}
          className="viewer-selection-menu"
        >
          <SelectionMenuBody
            menu={menu}
            actions={actions}
            firstItem={firstItem}
            addButton={addButton}
            size={size}
          />
        </Popover>
      )}
      {picking && adding && (
        <AddToMindPicker
          anchor={adding}
          focusedMindId={null}
          atCursor={false}
          newFolderId={document.folderId}
          onChoose={(target) => {
            onClose();
            void addRangeToNote(selection, target);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
