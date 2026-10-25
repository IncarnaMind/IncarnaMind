import type { VirtualElement } from "@floating-ui/dom";
import { isMacOS } from "@tiptap/core";
import { type Editor, useEditorState } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "../../../shared/i18n";
import {
  NUMBERING_SCHEMES,
  type NumberingScheme,
  numberingMarker,
} from "../../../shared/numbering";
import { keysHere } from "../commands/keymap";
import { ChevronIcon } from "../components/icons";
import { CheckLineIcon } from "../components/lineIcons";
import { files } from "../core";
import { useT } from "../i18n";
import { useNotices } from "../notices";
import { caretAnchor } from "./LinkField";
import { keepSelection, submenuOpensOnRight, useMenuKeys } from "./menuKeys";
import {
  continueNumbering,
  NUMBERING_OPEN,
  numberingState,
  restartNumbering,
  setNumbering,
} from "./numbering";
import { Popover } from "./Popover";

export const SCHEME_NAMES = {
  default: "numbering.default",
  outline: "numbering.outline",
  clauses: "numbering.clauses",
  chinese: "numbering.chinese",
} as const satisfies Record<NumberingScheme, MessageKey>;

/** A scheme as its first three levels draw it: "1. a. i.". */
export const schemePreview = (scheme: NumberingScheme) =>
  [0, 1, 2]
    .map((level) => numberingMarker(scheme, level, new Array<number>(level + 1).fill(1)))
    .join(" ");

const useNumbering = (editor: Editor) =>
  useEditorState({ editor, selector: ({ editor: current }) => numberingState(current) });

export function NumberingChoices({
  editor,
  anchor,
  placement,
  focus,
  withOrder,
  submenu,
  onChosen,
  onClose,
}: {
  editor: Editor;
  anchor: Element | VirtualElement;
  placement: "right-start" | "bottom-start";
  focus: boolean;
  withOrder: boolean;
  submenu: boolean;
  onChosen(): void;
  onClose(refocus: boolean): void;
}) {
  const t = useT();
  const state = useNumbering(editor);
  const first = useRef<HTMLButtonElement>(null);
  const { menu, onKeyDown } = useMenuKeys(onClose, submenu);
  const focused = Math.max(0, NUMBERING_SCHEMES.indexOf(state.scheme ?? "default"));
  const choose = (change: () => unknown) => {
    if (editor.view.composing) return;
    change();
    onChosen();
  };
  return (
    <Popover
      anchor={anchor}
      placement={placement}
      initialFocus={focus ? first : undefined}
      role="menu"
      aria-label={t("numbering.menu")}
      data-testid="numbering-menu"
      onDismiss={(how) => onClose(how === "escape")}
      onKeyDown={onKeyDown}
      className="editor-menu numbering-menu"
    >
      <div ref={menu} className="contents">
        {NUMBERING_SCHEMES.map((scheme, index) => (
          <button
            key={scheme}
            ref={index === focused ? first : undefined}
            type="button"
            role="menuitemradio"
            aria-checked={state.scheme === scheme}
            data-testid={`numbering-${scheme}`}
            onMouseDown={keepSelection}
            onClick={() => choose(() => setNumbering(editor, scheme))}
            className="editor-menu-item"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {state.scheme === scheme && <CheckLineIcon className="size-4" />}
            </span>
            <span className="numbering-preview">{schemePreview(scheme)}</span>
            <span className="editor-menu-shortcut">{t(SCHEME_NAMES[scheme])}</span>
          </button>
        ))}
        {withOrder && (
          <>
            <hr className="selection-rule" />
            <OrderItems editor={editor} state={state} onChosen={onChosen} indent />
          </>
        )}
      </div>
    </Popover>
  );
}

function OrderItems({
  editor,
  state,
  onChosen,
  indent,
}: {
  editor: Editor;
  state: ReturnType<typeof numberingState>;
  onChosen(): void;
  indent: boolean;
}) {
  const t = useT();
  const items = [
    { id: "restart", label: t("numbering.restart"), on: state.canRestart, run: restartNumbering },
    {
      id: "continue",
      label: t("numbering.continue"),
      on: state.canContinue,
      run: continueNumbering,
    },
  ];
  return items.map((item) => (
    <button
      key={item.id}
      type="button"
      role="menuitem"
      aria-disabled={!item.on || undefined}
      data-testid={`numbering-${item.id}`}
      onMouseDown={keepSelection}
      onClick={() => {
        if (!item.on || editor.view.composing) return;
        item.run(editor);
        onChosen();
      }}
      className="editor-menu-item"
    >
      {indent && <span className="size-4 shrink-0" />}
      <span className="min-w-0 truncate">{item.label}</span>
    </button>
  ));
}

function paragraphAnchor(editor: Editor): Element | VirtualElement {
  const { $from } = editor.state.selection;
  const dom = $from.depth > 0 ? editor.view.nodeDOM($from.before()) : null;
  return dom instanceof HTMLElement ? dom : caretAnchor(editor);
}

type Open =
  | { kind: "item"; anchor: VirtualElement; submenu: HTMLElement | null; focus: boolean }
  | { kind: "numbering"; anchor: Element | VirtualElement };

export function ListMenu({ editor }: { editor: Editor }) {
  const t = useT();
  const [open, setOpen] = useState<Open | null>(null);
  const state = useNumbering(editor);
  const selected = useEditorState({
    editor,
    selector: ({ editor: current }) => !current.state.selection.empty,
  });
  const first = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    setOpen(null);
    if (refocus) editor.commands.focus();
  };
  const { menu, onKeyDown } = useMenuKeys(close, false);

  useEffect(() => {
    editor.storage.numbering.openMenu = ({ x, y }) => {
      const point = new DOMRect(x, y, 0, 0);
      setOpen({
        kind: "item",
        anchor: { getBoundingClientRect: () => point },
        submenu: null,
        focus: false,
      });
    };
    const fromPalette = () => setOpen({ kind: "numbering", anchor: paragraphAnchor(editor) });
    const dom = editor.view.dom;
    dom.addEventListener(NUMBERING_OPEN, fromPalette);
    return () => {
      editor.storage.numbering.openMenu = null;
      dom.removeEventListener(NUMBERING_OPEN, fromPalette);
    };
  }, [editor]);

  if (!open) return null;
  if (open.kind === "numbering") {
    return (
      <NumberingChoices
        editor={editor}
        anchor={open.anchor}
        placement="bottom-start"
        focus
        withOrder
        submenu={false}
        onChosen={() => close(true)}
        onClose={close}
      />
    );
  }

  const copyLabel = isMacOS() ? "menu.copy" : "menu.copy.other";
  const clipboard = (command: "cut" | "copy" | "paste") => {
    // Focused at once, not a frame later as Tiptap's focus does: each acts where the focus is.
    editor.view.focus();
    if (command === "paste") files.paste();
    else if (!document.execCommand(command)) {
      useNotices.getState().showError(new Error(t("menu.clipboardFailed")));
    }
    setOpen(null);
  };
  const edits = [
    { id: "cut", label: t("menu.cut"), keys: "CmdOrCtrl+X", on: selected },
    { id: "copy", label: t(copyLabel), keys: "CmdOrCtrl+C", on: selected },
    { id: "paste", label: t("menu.paste"), keys: "CmdOrCtrl+V", on: true },
  ] as const;
  const toggleSchemes = (button: HTMLElement, focus: boolean) =>
    setOpen((now) =>
      now?.kind === "item" ? { ...now, submenu: now.submenu ? null : button, focus } : now,
    );
  return (
    <Popover
      anchor={open.anchor}
      placement="bottom-start"
      initialFocus={first}
      role="menu"
      aria-label={t("numbering.listMenu")}
      data-testid="list-item-menu"
      onDismiss={(how) => {
        if (!open.submenu) close(how === "escape");
      }}
      onKeyDown={(event) => {
        if (submenuOpensOnRight(event)) return;
        onKeyDown(event);
      }}
      className="editor-menu list-item-menu"
    >
      <div ref={menu} className="contents">
        {edits.map((edit, index) => (
          <button
            key={edit.id}
            ref={index === 0 ? first : undefined}
            type="button"
            role="menuitem"
            aria-disabled={!edit.on || undefined}
            aria-keyshortcuts={keysHere(edit.keys)}
            data-testid={`list-item-${edit.id}`}
            onMouseDown={keepSelection}
            onClick={() => {
              if (edit.on) clipboard(edit.id);
            }}
            className="editor-menu-item"
          >
            <span className="min-w-0 flex-1 truncate">{edit.label}</span>
            <span className="editor-menu-shortcut">{keysHere(edit.keys)}</span>
          </button>
        ))}
        <hr className="selection-rule" />
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open.submenu !== null}
          data-testid="list-item-numbering"
          onMouseDown={keepSelection}
          onClick={(event) => toggleSchemes(event.currentTarget, event.detail === 0)}
          className="editor-menu-item"
        >
          <span className="min-w-0 flex-1 truncate">{t("numbering.menu")}</span>
          <ChevronIcon className="size-3 shrink-0 text-ink-meta" />
        </button>
        <OrderItems editor={editor} state={state} onChosen={() => close(true)} indent={false} />
      </div>
      {open.submenu && (
        <NumberingChoices
          editor={editor}
          anchor={open.submenu}
          placement="right-start"
          focus={open.focus}
          withOrder={false}
          submenu
          onChosen={() => close(true)}
          onClose={(refocus) => {
            const back = open.submenu;
            setOpen({ ...open, submenu: null });
            if (refocus) back?.focus();
          }}
        />
      )}
    </Popover>
  );
}
