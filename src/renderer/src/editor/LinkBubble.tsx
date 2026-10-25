import { type Editor, useEditorState } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import { caretAnchor, LinkField } from "./LinkField";
import { Popover } from "./Popover";
import { applyLink, LINK_EDIT } from "./selectionCommands";

/** The link the cursor is in, with no text selected: where it is, and where it goes. */
function linkAtCursor(editor: Editor): { href: string; anchor: HTMLAnchorElement } | null {
  const { selection } = editor.state;
  if (!selection.empty || !editor.isActive("link")) return null;
  const href = editor.getAttributes("link").href;
  const node = editor.view.domAtPos(selection.from).node;
  const anchor = (node instanceof Element ? node : node.parentElement)?.closest("a");
  return typeof href === "string" && anchor ? { href, anchor } : null;
}

/**
 * What shows when the cursor is in a link and no text is selected (a click on
 * it, or the arrow keys): where it goes, with Open, Edit and Remove. ⌘K edits
 * it from the keyboard. Esc puts it away until the cursor leaves the link.
 */
export function LinkBubble({ editor }: { editor: Editor }) {
  const t = useT();
  const link = useEditorState({
    editor,
    selector: ({ editor: current }) => linkAtCursor(current),
    equalityFn: (a, b) => a?.href === b?.href && a?.anchor === b?.anchor,
  });
  const [focused, setFocused] = useState(editor.view.hasFocus());
  const [editing, setEditing] = useState(false);
  const [dismissed, setDismissed] = useState<Element | null>(null);

  useEffect(() => {
    const dom = editor.view.dom;
    const edit = () => {
      if (linkAtCursor(editor)) setEditing(true);
    };
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    dom.addEventListener(LINK_EDIT, edit);
    editor.on("focus", focus);
    editor.on("blur", blur);
    return () => {
      dom.removeEventListener(LINK_EDIT, edit);
      editor.off("focus", focus);
      editor.off("blur", blur);
    };
  }, [editor]);

  useEffect(() => {
    if (!link) {
      setEditing(false);
      setDismissed(null);
    }
  }, [link]);

  // Taken when the field opens, so it sits beside the link being edited; and the same one on every
  // render of the session, since a new anchor would open the popover again (#1705).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `editing` is when a new anchor is taken.
  const anchor = useMemo(() => caretAnchor(editor), [editor, editing]);

  if (!link) return null;
  if (editing) {
    return (
      <LinkField
        anchor={anchor}
        current={link.href}
        onApply={(typed) => {
          setEditing(false);
          applyLink(editor, typed);
        }}
        onClose={() => {
          setEditing(false);
          editor.commands.focus();
        }}
      />
    );
  }
  if (!focused || dismissed === link.anchor) return null;

  // The buttons don't take the focus from the text, so the cursor stays in the link.
  const keepCursor = (event: { preventDefault(): void }) => event.preventDefault();
  return (
    <Popover
      anchor={link.anchor}
      role="group"
      aria-label={t("editor.link.label")}
      onDismiss={() => setDismissed(link.anchor)}
      className="editor-menu link-bubble"
    >
      <span className="link-bubble-address" data-testid="link-bubble-address" title={link.href}>
        {link.href}
      </span>
      <button
        type="button"
        data-testid="link-open"
        onMouseDown={keepCursor}
        onClick={() => window.open(link.href, "_blank", "noreferrer")}
        className="selection-format"
      >
        {t("editor.link.open")}
      </button>
      <button
        type="button"
        data-testid="link-edit"
        onMouseDown={keepCursor}
        onClick={() => setEditing(true)}
        className="selection-format"
      >
        {t("editor.link.edit")}
      </button>
      <button
        type="button"
        data-testid="link-remove"
        onMouseDown={keepCursor}
        onClick={() => applyLink(editor, "")}
        className="selection-format"
      >
        {t("editor.link.remove")}
      </button>
    </Popover>
  );
}
