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
import type { AnnotationColour, AskedQuote, Document } from "../../../core/api";
import { ANNOTATION_COLOURS } from "../../../core/api";
import { ANNOTATION_COLOUR_LABELS } from "../../../shared/annotationColours";
import { highlightSelection } from "../annotationActions";
import { useNoteEditor } from "../annotationNote";
import { useAnnotations } from "../annotations";
import { type CitationPick, citeChosenWords, usePickIn } from "../citationPick";
import { paletteOpen, useViewerHandle } from "../commands/handles";
import { keysHere, shortcutLabel } from "../commands/keymap";
import { AddToMindPicker } from "../components/assistant/AddToMindPicker";
import {
  ChatLineIcon,
  CopyLineIcon,
  LinkLineIcon,
  NoteLineIcon,
  PlusLineIcon,
} from "../components/lineIcons";
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
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  // ⌘K takes the page's selection before its dialog has the focus, and a modal blocks the page:
  // whatever moved the selection, the words selected in the page still hold.
  paletteOpen.current ||
  window.document.querySelector("dialog[open]") !== null;

const inPopover = (target: EventTarget | null) =>
  target instanceof Element && target.closest(".editor-popover") !== null;

const HELD = "viewer-held-selection";

// Shift and the arrows change a selection a key at a time: it is read once they stop.
const SETTLE_MS = 120;

const sameRange = (a: Range | null | undefined, b: Range): boolean =>
  a !== null &&
  a !== undefined &&
  a.startContainer === b.startContainer &&
  a.startOffset === b.startOffset &&
  a.endContainer === b.endContainer &&
  a.endOffset === b.endOffset;

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
  // The range the menu holds now: a selection change to the same words, as closing the menu moves
  // the focus, is not a new selection and must not open it again.
  const heldRange = useRef<Range | null>(null);
  heldRange.current = held?.range ?? null;
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
      // The words the menu holds, read again as the drag settles: the menu stays as the User left
      // it, so an Esc pressed before the last read keeps it closed.
      if (sameRange(heldRange.current, range)) return;
      const { parts, shown } = reader(range);
      const next =
        parts.length > 0
          ? { selection: { document, parts, shown }, range: range.cloneRange() }
          : null;
      heldRange.current = next?.range ?? null;
      setHeld(next);
      setOpen(parts.length > 0);
      setPicking(false);
      setAway(false);
      setAsked(null);
    };
    const onDown = (event: PointerEvent) => {
      if (inPopover(event.target)) return;
      pressed = true;
      heldRange.current = null;
      setOpen(false);
      setHeld(null);
      setAsked(null);
    };
    const onReleased = () => {
      pressed = false;
    };
    // Once the browser has settled the selection the press made, and at once, so a key pressed
    // before it settles (⌘K) still finds the words selected. A loaded browser can apply the
    // drag's selection after the pointer has come up, so read it again once it has.
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0 || inPopover(event.target)) return;
      read();
      setTimeout(read);
      clearTimeout(settling);
      settling = setTimeout(read, SETTLE_MS);
    };
    const onChange = () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        if (section.contains(selection.getRangeAt(0).commonAncestorContainer)) {
          // After a drag the focus is on the page's body, which no key event of the viewer reaches.
          if (!pressed && !sameRange(heldRange.current, selection.getRangeAt(0))) {
            clearTimeout(settling);
            settling = setTimeout(read, SETTLE_MS);
          }
        } else {
          const focused = window.document.activeElement;
          // Words typed in ⌘K's field are a selection too, and not the page's.
          if (typesInField(focused) || inPopover(focused)) {
            if (!inPopover(focused)) setOpen(false);
            setAway(true);
          } else setHeld(null);
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

  // Its words redrawn or gone, as another file version or a PDF zoom does: the menu goes with them.
  useEffect(() => {
    if (!held || !section) return;
    const range = held.range;
    const observer = new MutationObserver(() => {
      if (
        !range.collapsed &&
        range.startContainer.isConnected &&
        section.contains(range.startContainer)
      ) {
        return;
      }
      setOpen(false);
      setHeld(null);
    });
    observer.observe(section, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [held, section]);

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

  const colour = useAnnotations((state) => state.colour);
  const highlightIn = useCallback(
    (chosen: AnnotationColour) => {
      const now = heldNow() ?? held;
      close();
      if (now) void highlightSelection(now.selection, chosen);
      // The menu is gone: the keys go on with the page, not with the window's body.
      section?.focus();
    },
    [held, close, heldNow, section],
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
        highlight: () => highlightIn(colour),
        note: () => {
          const now = heldNow() ?? held;
          if (!now) return;
          close();
          void highlightSelection(now.selection, colour).then((annotation) => {
            if (annotation) useNoteEditor.getState().open(annotation.id, document.id);
          });
        },
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
    [held, cite, ask, close, heldNow, highlightIn, colour, document.id],
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
        still
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
          annotations={{ colour, highlight: highlightIn, note: actions.note }}
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
  annotations,
}: {
  menu: RefObject<HTMLDivElement | null>;
  actions: SelectionMenuActions;
  /** The first item, which takes the focus as the menu opens: Use as Citation while a sentence waits, else Ask. */
  firstItem: RefObject<HTMLButtonElement | null>;
  addButton: (element: HTMLButtonElement | null) => void;
  /** A range's size, above its actions: "3 rows × 4 columns". */
  size?: string;
  /** Words in a Document offer Highlight and Add a note… (#327); a range of cells does not. */
  annotations?: {
    colour: AnnotationColour;
    highlight(colour: AnnotationColour): void;
    note(): void;
  };
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
      {annotations && (
        <>
          <div
            role="menuitem"
            tabIndex={0}
            data-testid="viewer-selection-highlight"
            aria-label={t("annotations.highlight")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => annotations.highlight(annotations.colour)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              annotations.highlight(annotations.colour);
            }}
            className="editor-menu-item"
          >
            <NoteLineIcon className="size-4 shrink-0 text-ink-secondary" />
            <span className="flex-1 truncate">{t("annotations.highlight")}</span>
            <span className="annotation-swatches">
              {ANNOTATION_COLOURS.map((each) => (
                <button
                  key={each}
                  type="button"
                  role="menuitemradio"
                  data-testid={`viewer-selection-highlight-${each}`}
                  aria-label={t(ANNOTATION_COLOUR_LABELS[each])}
                  title={t(ANNOTATION_COLOUR_LABELS[each])}
                  aria-checked={annotations.colour === each}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    annotations.highlight(each);
                  }}
                  className={`annotation-colour annotation-colour--${each}${
                    annotations.colour === each ? " annotation-colour--chosen" : ""
                  }`}
                />
              ))}
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="viewer-selection-note"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => annotations.note()}
            className="editor-menu-item"
          >
            <PlusLineIcon className="size-4 shrink-0 text-ink-secondary" />
            <span className="flex-1 truncate">{t("annotations.addNote")}</span>
            <kbd className="editor-menu-shortcut">{shortcutLabel("comment.add")}</kbd>
          </button>
        </>
      )}
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
