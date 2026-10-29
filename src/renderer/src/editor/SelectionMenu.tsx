import type { VirtualElement } from "@floating-ui/dom";
import { isMacOS } from "@tiptap/core";
import { PluginKey, TextSelection } from "@tiptap/pm/state";
import { type Editor, useEditorState } from "@tiptap/react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { MessageKey } from "../../../shared/i18n";
import { keysHere, shortcutLabel } from "../commands/keymap";
import { ChevronIcon } from "../components/icons";
import { PageBreakLineIcon } from "../components/lineIcons";
import { useT } from "../i18n";
import { isComposing } from "./composing";
import { EditField, EditWorking } from "./EditField";
import { selectionForEdit } from "./editSelection";
import { CustomSpacing, FormatMenu } from "./FormatMenu";
import { footnotePlace, insertFootnote } from "./footnoteSchema";
import { FORMAT_OPEN, setLineSpacing } from "./formatCommands";
import { caretAnchor, LinkField } from "./LinkField";
import { Popover } from "./Popover";
import { canInsertPageBreak, insertPageBreak, PAGE_BREAK_KEYS } from "./pageBreakSchema";
import {
  applyLink,
  asOwnUndoStep,
  canTurnInto,
  clearFormatting,
  currentTurnInto,
  EDIT_FIELD,
  inOneTextblock,
  LINK_EDIT,
  selectionToMath,
  TURN_INTO,
} from "./selectionCommands";
import { forgetMenuClosed, keepMenuClosed, menuClosedOver } from "./selectionDismissal";
import { type EditWithAiField, useEditField } from "./useEditField";

/**
 * One action of the menu's AI section: Edit with AI, Check against Documents
 * and the like. The section is hidden while there are none.
 */
export interface SelectionAction {
  /** A stable name; tests find the action by it (`selection-action-<id>`). */
  id: string;
  label: MessageKey;
  icon: ReactNode;
  /** The keys that do it too, as the menu shows them. */
  keys?: string;
  /** Whether it applies to the selection now; it isn't shown when it doesn't. */
  available?(editor: Editor): boolean;
  /** Choices it asks for first (Translate… into which language), in a menu beside it. */
  choices?: readonly SelectionChoice[];
  run(editor: Editor): void;
}

/** One choice of an AI action that asks for one. */
export interface SelectionChoice {
  /** A stable name; tests find the choice by it (`selection-choice-<id>`). */
  id: string;
  /** In words that need no translating (a language in its own name). */
  label: string;
  run(editor: Editor): void;
}

type Mark = "bold" | "italic" | "underline" | "strike" | "link" | "code" | "highlight";

const PLUGIN_KEY = new PluginKey("selectionMenu");

/** A shortcut as the menu shows it: ⌘⇧H on macOS, Ctrl+Shift+H elsewhere. */
const shortcut = (key: string, shift = false) =>
  isMacOS() ? `⌘${shift ? "⇧" : ""}${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;

/** The format buttons in the order of the design: the glyph says what the mark does. */
const MARKS: readonly {
  mark: Mark;
  label: MessageKey;
  glyph: ReactNode;
  keys?: string;
  toggle(editor: Editor): boolean;
}[] = [
  {
    mark: "bold",
    label: "editor.format.bold",
    glyph: <span className="font-bold">B</span>,
    keys: shortcut("B"),
    toggle: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    mark: "italic",
    label: "editor.format.italic",
    glyph: <span className="italic">I</span>,
    keys: shortcut("I"),
    toggle: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    mark: "underline",
    label: "editor.format.underline",
    glyph: <span className="underline">U</span>,
    keys: shortcut("U"),
    toggle: (editor) => editor.chain().focus().toggleUnderline().run(),
  },
  {
    mark: "strike",
    label: "editor.format.strike",
    glyph: <span className="line-through">S</span>,
    keys: shortcut("S", true),
    toggle: (editor) => editor.chain().focus().toggleStrike().run(),
  },
  {
    mark: "code",
    label: "editor.format.code",
    glyph: <span className="font-mono">{"</>"}</span>,
    keys: shortcut("E"),
    toggle: (editor) => editor.chain().focus().toggleCode().run(),
  },
  {
    mark: "highlight",
    label: "editor.format.highlight",
    glyph: <span className="format-highlight">H</span>,
    keys: shortcut("H", true),
    toggle: (editor) => editor.chain().focus().toggleHighlight().run(),
  },
];

/** The menu's controls, in the order the arrow keys go through them. */
const controlsOf = (menu: HTMLElement | null) =>
  Array.from(
    menu?.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not([aria-disabled="true"]), [data-menu-field]',
    ) ?? [],
  );

function fitToView(frame: HTMLElement | null) {
  const view = frame?.closest(".mind-scroller");
  // A short view can't hold the whole menu: its rows scroll and the field stays at its foot. The
  // room leaves the 8px padding at both ends of the view, and the 8px offset that comes after the slide.
  frame?.style.setProperty("--selection-menu-room", view ? `${view.clientHeight - 24}px` : "100vh");
}

function hideMenu(editor: Editor) {
  keepMenuClosed(editor, editor.state.selection.from, editor.state.selection.to);
  editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, "hide"));
}

// While the menu is hidden Tiptap takes its contents off the page, where a popover can't open
// (#1461): what the keys open then goes at the caret, outside the menu.
function openedAt<Anchor extends Element | VirtualElement>(
  editor: Editor,
  menuShown: boolean,
  inMenu: Anchor | null | undefined,
) {
  return menuShown && inMenu
    ? { at: "menu" as const, anchor: inMenu }
    : { at: "caret" as const, anchor: caretAnchor(editor) };
}

/** Shown over selected text, not over code or a selected Block, nor while a mouse button or an input method is working on the selection. */
function showsOver(editor: Editor, pressed: boolean): boolean {
  const { selection, doc } = editor.state;
  if (pressed || editor.view.composing || !editor.isEditable) return false;
  if (menuClosedOver(editor)) return false;
  if (selection.empty || !(selection instanceof TextSelection)) return false;
  if (editor.isActive("codeBlock")) return false;
  return doc.textBetween(selection.from, selection.to).length > 0;
}

/**
 * The menu under selected text: "Text ›" to turn Blocks into headings, lists
 * and quotes, the format buttons, and `ai`, the actions of the AI section.
 * The mouse and the keyboard (⌘/ moves into it from the text, arrows go
 * through it, Esc closes the innermost thing open) reach every action, and
 * none runs while an input method is composing.
 */
export function SelectionMenu({
  editor,
  ai = [],
  edit,
}: {
  editor: Editor;
  ai?: readonly SelectionAction[];
  /** What the "Edit with AI…" field at the menu's foot asks with; with none the field isn't there. */
  edit?: EditWithAiField;
}) {
  const t = useT();
  const frame = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const turnRow = useRef<HTMLButtonElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const formatButton = useRef<HTMLButtonElement>(null);
  const shown = useRef(false);
  const pressed = useRef(false);
  const [turning, setTurning] = useState<"mouse" | "keyboard" | null>(null);
  const [linking, setLinking] = useState<{
    at: "menu" | "caret";
    anchor: Element | VirtualElement;
  } | null>(null);
  /**
   * The Aa menu: beside this menu, or at the caret (⌘K), or only its custom line spacing there.
   * Its anchor is made once, as the popover places itself again whenever its anchor changes;
   * beside this menu, it stays where it opened, though a choice moves the text and this menu with it.
   */
  const [formatting, setFormatting] = useState<{
    at: "menu" | "caret" | "custom";
    focus: boolean;
    anchor: VirtualElement;
  } | null>(null);
  const besideMenu = (): VirtualElement | null => {
    const rect = menu.current?.getBoundingClientRect();
    return rect ? { getBoundingClientRect: () => rect } : null;
  };
  const formatBeside = (focus: boolean) => {
    const anchor = besideMenu();
    if (anchor) setFormatting({ at: "menu", focus, anchor });
  };
  /** The AI action whose choices are open, and how it was opened. */
  const [choosing, setChoosing] = useState<{
    action: SelectionAction;
    anchor: HTMLElement;
    focus: boolean;
  } | null>(null);
  const actions = useRef(ai);
  actions.current = ai;

  const closeMenu = useCallback(() => {
    const active = document.activeElement;
    if (!active || active === document.body || frame.current?.contains(active)) {
      editor.view.focus();
    }
    hideMenu(editor);
  }, [editor]);
  const field = useEditField(editor, edit, closeMenu);
  const fieldNow = useRef(field);
  fieldNow.current = field;
  const withField = useRef(edit !== undefined);
  withField.current = edit !== undefined;

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      underline: current.isActive("underline"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      highlight: current.isActive("highlight"),
      link: current.isActive("link"),
      turnable: canTurnInto(current),
      turn: currentTurnInto(current).label,
      // A formula replaces text in a Note only: not in a Question or an Answer.
      oneLine: inOneTextblock(current) && canTurnInto(current),
      // A footnote goes after the selection, in text: not in a Question or code.
      footnote: footnotePlace(current.state) !== null,
      pageBreak: canInsertPageBreak(current.state),
      ai: actions.current
        .filter((action) => action.available?.(current) ?? true)
        .map((action) => action.id),
      editable: selectionForEdit(current.state) !== null,
    }),
  });
  const shownAi = ai.filter((action) => state.ai.includes(action.id));

  const working = field.working;
  const shouldShow = useCallback<NonNullable<BubbleMenuProps["shouldShow"]>>(
    ({ editor: current, element, view }) =>
      working.current
        ? element.contains(document.activeElement)
        : showsOver(current, pressed.current) &&
          (view.hasFocus() || element.contains(document.activeElement)),
    [working],
  );

  // While a mouse button is down the menu waits: it opens under what the User
  // has selected once they let go, rather than chasing the pointer.
  useEffect(() => {
    const dom = editor.view.dom;
    const press = () => {
      pressed.current = true;
    };
    // A press changes nothing by itself: only a selection change under it is the User's own (#1355).
    const selectionMoved = () => {
      if (pressed.current) forgetMenuClosed(editor);
    };
    const release = () => {
      if (!pressed.current) return;
      pressed.current = false;
      if (editor.isDestroyed || !showsOver(editor, false)) return;
      editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, "show"));
      editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, "updatePosition"));
    };
    // Over a selection of all of the Mind the menu can't open, and ⌘J is left to the composer.
    const takeEditField = (event: Event) => {
      const anywhere = event instanceof CustomEvent && event.detail?.anywhere === true;
      const current = fieldNow.current;
      const inField = current.input.current === document.activeElement;
      if (!withField.current || !current.input.current || current.working.current) return;
      const inMenu = frame.current?.contains(document.activeElement) === true;
      if (!anywhere && !inMenu && !editor.view.hasFocus()) return;
      if (!inField) {
        if (selectionForEdit(editor.state) === null) return;
        forgetMenuClosed(editor);
        if (!showsOver(editor, false)) return;
      }
      event.preventDefault();
      if (inField) return;
      if (!shown.current) {
        editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, "show"));
        editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, "updatePosition"));
      }
      current.focus();
    };
    // ⌘/ moves into the menu; Esc, with the focus still in the text, closes it, ahead of the editor's own use of Esc.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!shown.current || event.isComposing || event.keyCode === 229) return;
      const modifier = isMacOS() ? event.metaKey : event.ctrlKey;
      if (event.key === "/" && modifier) {
        event.preventDefault();
        controlsOf(menu.current)[0]?.focus();
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopImmediatePropagation();
        hideMenu(editor);
      }
    };
    // The menu doesn't update while an input method composes, and ProseMirror
    // ends the composition a moment after its last change: look again then.
    const afterComposition = () =>
      setTimeout(() => {
        if (!editor.isDestroyed && shown.current && !showsOver(editor, false)) hideMenu(editor);
      }, 50);
    // ⌘K on a selection: its link's address.
    const editLink = () => {
      if (!editor.state.selection.empty) {
        setLinking(openedAt(editor, shown.current, linkButton.current));
      }
    };
    const openFormat = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === "custom") {
        setFormatting({ at: "custom", focus: true, anchor: caretAnchor(editor) });
        return;
      }
      const rect = menu.current?.getBoundingClientRect();
      const beside = rect && { getBoundingClientRect: () => rect };
      setFormatting({ ...openedAt(editor, shown.current, beside), focus: true });
    };
    dom.addEventListener(LINK_EDIT, editLink);
    dom.addEventListener(EDIT_FIELD, takeEditField);
    dom.addEventListener(FORMAT_OPEN, openFormat);
    dom.addEventListener("compositionend", afterComposition);
    dom.addEventListener("mousedown", press);
    editor.on("selectionUpdate", selectionMoved);
    document.addEventListener("mouseup", release);
    dom.addEventListener("keydown", onKey, true);
    return () => {
      dom.removeEventListener(LINK_EDIT, editLink);
      dom.removeEventListener(EDIT_FIELD, takeEditField);
      dom.removeEventListener(FORMAT_OPEN, openFormat);
      dom.removeEventListener("compositionend", afterComposition);
      dom.removeEventListener("mousedown", press);
      editor.off("selectionUpdate", selectionMoved);
      document.removeEventListener("mouseup", release);
      dom.removeEventListener("keydown", onKey, true);
    };
  }, [editor]);

  const options = useRef({
    placement: "bottom-start" as const,
    offset: 8,
    // With the AI section the menu is tall: where it fits neither above nor below the
    // selection, it slides into the Mind's view rather than lose its top row (the offset comes after).
    shift: { crossAxis: true, padding: 8 },
    onShow: () => {
      shown.current = true;
      fitToView(frame.current);
    },
    onUpdate: () => fitToView(frame.current),
    onHide: () => {
      shown.current = false;
      fieldNow.current.reset();
      setTurning(null);
      setLinking((open) => (open?.at === "menu" ? null : open));
      setChoosing(null);
      setFormatting((open) => (open?.at === "menu" ? null : open));
    },
  }).current;

  /** Runs an action unless an input method is composing; the selection stays, so the next one can follow. */
  const act = (run: () => unknown) => {
    if (editor.view.composing) return;
    // Back in the text at once, so a key pressed right after the action reaches it.
    if (!editor.view.hasFocus()) editor.view.focus();
    asOwnUndoStep(editor, run);
  };

  const closeTurning = (refocus: boolean) => {
    setTurning(null);
    if (refocus) turnRow.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      editor.view.focus();
      editor.commands.focus();
      hideMenu(editor);
      return;
    }
    const all = controlsOf(menu.current);
    const index = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowRight" && document.activeElement === turnRow.current) {
      event.preventDefault();
      setTurning("keyboard");
      return;
    }
    if (event.key === "ArrowRight" && document.activeElement === formatButton.current) {
      event.preventDefault();
      formatBeside(true);
      return;
    }
    const withChoices = shownAi.find(
      (action) =>
        action.choices && document.activeElement?.getAttribute("data-action") === action.id,
    );
    if (
      event.key === "ArrowRight" &&
      withChoices &&
      document.activeElement instanceof HTMLElement
    ) {
      event.preventDefault();
      setChoosing({ action: withChoices, anchor: document.activeElement, focus: true });
      return;
    }
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    const next =
      event.key === "Home"
        ? all[0]
        : event.key === "End"
          ? all.at(-1)
          : step
            ? all[(index + step + all.length) % all.length]
            : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const turnInto = (run: () => boolean) => {
    act(() => {
      setTurning(null);
      run();
    });
  };

  const keepSelection = (event: { preventDefault(): void }) => event.preventDefault();

  const closeFormat = () => {
    setFormatting(null);
    editor.commands.focus();
  };

  const leaveField = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (
      next instanceof Element &&
      (frame.current?.contains(next) || next.closest(".editor-popover"))
    ) {
      return;
    }
    // A click in the text moves the selection, which closes the menu over the field; the working line has no selection to follow.
    if (field.working.current || (next instanceof Element && !editor.view.dom.contains(next))) {
      hideMenu(editor);
    }
  };

  const handOff = () => {
    edit?.handOff?.(editor, field.text);
    hideMenu(editor);
  };

  const linkField = linking && (
    <LinkField
      anchor={linking.anchor}
      current={editor.getAttributes("link").href as string | undefined}
      onApply={(typed) => {
        setLinking(null);
        applyLink(editor, typed);
      }}
      onClose={() => {
        setLinking(null);
        editor.commands.focus();
      }}
    />
  );

  return (
    <>
      <BubbleMenu
        ref={frame}
        editor={editor}
        pluginKey={PLUGIN_KEY}
        updateDelay={50}
        shouldShow={shouldShow}
        getReferencedVirtualElement={field.anchor}
        options={options}
        className="selection-menu-frame"
      >
        {field.phase === "working" && edit && (
          <EditWorking mindId={edit.mindId} pill={field.pill} onLeave={leaveField} />
        )}
        <div
          ref={menu}
          role="menu"
          hidden={field.phase === "working"}
          aria-label={t("editor.selection.label")}
          data-testid="selection-menu"
          onKeyDown={onMenuKeyDown}
          className="editor-menu selection-menu"
        >
          {state.turnable && (
            <>
              <button
                ref={turnRow}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={turning !== null}
                data-testid="selection-turn-into"
                title={t("editor.turnInto.label")}
                onMouseDown={keepSelection}
                onClick={(event) =>
                  setTurning(turning ? null : event.detail === 0 ? "keyboard" : "mouse")
                }
                className="editor-menu-item selection-turn"
              >
                <span className="editor-menu-icon">T</span>
                <span className="flex-1 truncate">{t(state.turn)}</span>
                <ChevronIcon className="size-4 text-ink-meta" />
              </button>
              <hr className="selection-rule" />
            </>
          )}
          {/* biome-ignore lint/a11y/useSemanticElements: a group of a menu's items, which a fieldset can't hold. */}
          <div role="group" aria-label={t("editor.format.label")} className="selection-formats">
            <button
              ref={formatButton}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={formatting?.at === "menu"}
              data-testid="format-aa"
              title={t("format.menu")}
              aria-label={t("format.menu")}
              onMouseDown={keepSelection}
              onClick={(event) => {
                if (formatting) setFormatting(null);
                else formatBeside(event.detail === 0);
              }}
              className="selection-format"
            >
              <span aria-hidden="true">Aa</span>
            </button>
            {MARKS.slice(0, 4).map((each) => (
              <FormatButton
                key={each.mark}
                {...each}
                on={state[each.mark]}
                editor={editor}
                act={act}
              />
            ))}
            <button
              ref={linkButton}
              type="button"
              role="menuitemcheckbox"
              aria-checked={state.link}
              aria-haspopup="dialog"
              data-testid="format-link"
              title={`${t("editor.format.link")} ${shortcutLabel("link.edit")}`}
              aria-label={t("editor.format.link")}
              onMouseDown={keepSelection}
              onClick={(event) => {
                const anchor = event.currentTarget;
                act(() => setLinking({ at: "menu", anchor }));
              }}
              className="selection-format"
            >
              <span aria-hidden="true">↗</span>
            </button>
            {MARKS.slice(4, 5).map((each) => (
              <FormatButton
                key={each.mark}
                {...each}
                on={state[each.mark]}
                editor={editor}
                act={act}
              />
            ))}
            <button
              type="button"
              role="menuitem"
              aria-disabled={!state.oneLine}
              data-testid="format-math"
              title={t("editor.format.math")}
              aria-label={t("editor.format.math")}
              onMouseDown={keepSelection}
              onClick={() =>
                act(() => {
                  const at = selectionToMath(editor);
                  if (at !== null) editor.commands.editMath(at);
                })
              }
              className="selection-format"
            >
              <span aria-hidden="true">∑</span>
            </button>
            <button
              type="button"
              role="menuitem"
              aria-disabled={!state.footnote}
              data-testid="format-footnote"
              title={`${t("editor.format.footnote")} (${shortcutLabel("footnote.insert")})`}
              aria-label={t("editor.format.footnote")}
              onMouseDown={keepSelection}
              onClick={() => {
                // After the selection, as Word and Google Docs put one, and open to be written.
                if (state.footnote) act(() => insertFootnote(editor));
              }}
              className="selection-format"
            >
              <span aria-hidden="true" className="format-footnote">
                a<sup>1</sup>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              aria-disabled={!state.pageBreak}
              data-testid="format-page-break"
              title={`${t("editor.pageBreak.insert")} (${keysHere(PAGE_BREAK_KEYS)})`}
              aria-label={t("editor.pageBreak.insert")}
              onMouseDown={keepSelection}
              onClick={() => {
                if (state.pageBreak) act(() => insertPageBreak(editor));
              }}
              className="selection-format"
            >
              <PageBreakLineIcon className="size-4" />
            </button>
            {MARKS.slice(5).map((each) => (
              <FormatButton
                key={each.mark}
                {...each}
                on={state[each.mark]}
                editor={editor}
                act={act}
              />
            ))}
            <button
              type="button"
              role="menuitem"
              data-testid="format-clear"
              title={t("editor.format.clear")}
              aria-label={t("editor.format.clear")}
              onMouseDown={keepSelection}
              onClick={() => act(() => clearFormatting(editor))}
              className="selection-format"
            >
              <span aria-hidden="true">T×</span>
            </button>
          </div>
          {(shownAi.length > 0 || (edit && state.editable)) && (
            <>
              <hr className="selection-rule" />
              {/* biome-ignore lint/a11y/useSemanticElements: a group of a menu's items, which a fieldset can't hold. */}
              <div role="group" aria-label={t("editor.selection.ai")}>
                <p aria-hidden="true" className="selection-section">
                  {t("editor.selection.ai")}
                </p>
                {shownAi.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    role="menuitem"
                    data-action={action.id}
                    data-testid={`selection-action-${action.id}`}
                    aria-haspopup={action.choices ? "menu" : undefined}
                    aria-expanded={action.choices ? choosing?.action.id === action.id : undefined}
                    aria-keyshortcuts={action.keys}
                    onMouseDown={keepSelection}
                    onClick={(event) => {
                      if (!action.choices) {
                        act(() => action.run(editor));
                        return;
                      }
                      const anchor = event.currentTarget;
                      setChoosing((open) =>
                        open?.action.id === action.id
                          ? null
                          : { action, anchor, focus: event.detail === 0 },
                      );
                    }}
                    className="editor-menu-item"
                  >
                    <span className="editor-menu-icon">{action.icon}</span>
                    <span className="flex-1 truncate">{t(action.label)}</span>
                    {action.keys && <span className="editor-menu-shortcut">{action.keys}</span>}
                    {action.choices && <ChevronIcon className="size-4 text-ink-meta" />}
                  </button>
                ))}
                {edit && state.editable && (
                  <EditField
                    editor={editor}
                    edit={edit}
                    field={field}
                    keys={shortcutLabel("composer.focus")}
                    onLeave={leaveField}
                    onHandOff={handOff}
                  />
                )}
              </div>
            </>
          )}
        </div>
        {turning && turnRow.current && (
          <TurnIntoMenu
            editor={editor}
            anchor={turnRow.current}
            focus={turning === "keyboard"}
            onChoose={turnInto}
            onClose={closeTurning}
          />
        )}
        {choosing?.action.choices && (
          <ChoiceMenu
            label={t(choosing.action.label)}
            choices={choosing.action.choices}
            anchor={choosing.anchor}
            focus={choosing.focus}
            testId={`selection-choices-${choosing.action.id}`}
            onChoose={(choice) => {
              setChoosing(null);
              act(() => choice.run(editor));
            }}
            onClose={(refocus) => {
              const anchor = choosing.anchor;
              setChoosing(null);
              if (refocus) anchor.focus();
            }}
          />
        )}
        {formatting?.at === "menu" && (
          <FormatMenu
            editor={editor}
            anchor={formatting.anchor}
            placement="right-start"
            focus={formatting.focus}
            onClose={(refocus) => {
              // Opened by mouse, the focus never left the text.
              if (refocus && formatting.focus) formatButton.current?.focus();
              setFormatting(null);
            }}
          />
        )}
        {linking?.at === "menu" && linkField}
      </BubbleMenu>
      {/* While the menu isn't shown, what is in it isn't on the page. */}
      {linking?.at === "caret" && linkField}
      {formatting?.at === "caret" && (
        <FormatMenu
          editor={editor}
          anchor={formatting.anchor}
          placement="bottom-start"
          focus={formatting.focus}
          onClose={closeFormat}
        />
      )}
      {formatting?.at === "custom" && (
        <CustomSpacing
          anchor={formatting.anchor}
          current={null}
          onApply={(multiple) => {
            closeFormat();
            setLineSpacing(editor, multiple);
          }}
          onClose={closeFormat}
        />
      )}
    </>
  );
}

function FormatButton({
  mark,
  label,
  glyph,
  keys,
  toggle,
  on,
  editor,
  act,
}: {
  mark: Mark;
  label: MessageKey;
  glyph: ReactNode;
  keys?: string;
  toggle(editor: Editor): boolean;
  on: boolean;
  editor: Editor;
  act(run: () => unknown): void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      data-testid={`format-${mark}`}
      title={keys ? `${t(label)} (${keys})` : t(label)}
      aria-label={t(label)}
      // Keep the selection in the editor.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => act(() => toggle(editor))}
      className="selection-format"
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

function TurnIntoMenu({
  editor,
  anchor,
  focus,
  onChoose,
  onClose,
}: {
  editor: Editor;
  anchor: HTMLElement;
  focus: boolean;
  onChoose(run: () => boolean): void;
  onClose(refocus: boolean): void;
}) {
  const t = useT();
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const current = TURN_INTO.findIndex((each) => each.active(editor));
  const chosen = useRef<HTMLButtonElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(event)) return;
    const all = items.current.filter((each): each is HTMLButtonElement => each !== null);
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? all[(index + 1) % all.length]
        : event.key === "ArrowUp"
          ? all[(index - 1 + all.length) % all.length]
          : event.key === "Home"
            ? all[0]
            : event.key === "End"
              ? all.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <Popover
      anchor={anchor}
      placement="right-start"
      initialFocus={focus ? chosen : undefined}
      role="menu"
      aria-label={t("editor.turnInto.label")}
      data-testid="selection-turn-into-menu"
      onDismiss={() => onClose(false)}
      onKeyDown={onKeyDown}
      className="editor-menu w-[200px]"
    >
      {TURN_INTO.map((kind, index) => (
        <button
          key={kind.id}
          ref={(element) => {
            items.current[index] = element;
            if (index === Math.max(current, 0)) chosen.current = element;
          }}
          type="button"
          role="menuitemradio"
          aria-checked={index === current}
          data-testid={`turn-into-${kind.id}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(() => kind.run(editor))}
          className="editor-menu-item"
        >
          <span className="editor-menu-icon">{index === current ? "✓" : ""}</span>
          <span className="truncate">{t(kind.label)}</span>
        </button>
      ))}
    </Popover>
  );
}

/** The choices of an AI action that asks for one (Translate… into which language), beside it. */
function ChoiceMenu({
  label,
  choices,
  anchor,
  focus,
  testId,
  onChoose,
  onClose,
}: {
  label: string;
  choices: readonly SelectionChoice[];
  anchor: HTMLElement;
  focus: boolean;
  testId: string;
  onChoose(choice: SelectionChoice): void;
  onClose(refocus: boolean): void;
}) {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const first = useRef<HTMLButtonElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(event)) return;
    const all = items.current.filter((each): each is HTMLButtonElement => each !== null);
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? all[(index + 1) % all.length]
        : event.key === "ArrowUp"
          ? all[(index - 1 + all.length) % all.length]
          : event.key === "Home"
            ? all[0]
            : event.key === "End"
              ? all.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <Popover
      anchor={anchor}
      placement="right-start"
      initialFocus={focus ? first : undefined}
      role="menu"
      aria-label={label}
      data-testid={testId}
      onDismiss={() => onClose(false)}
      onKeyDown={onKeyDown}
      className="editor-menu w-[200px]"
    >
      {choices.map((choice, index) => (
        <button
          key={choice.id}
          ref={(element) => {
            items.current[index] = element;
            if (index === 0) first.current = element;
          }}
          type="button"
          role="menuitem"
          data-testid={`selection-choice-${choice.id}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(choice)}
          className="editor-menu-item"
        >
          <span className="editor-menu-icon" />
          <span className="truncate">{choice.label}</span>
        </button>
      ))}
    </Popover>
  );
}
