import type { VirtualElement } from "@floating-ui/dom";
import { type Editor, posToDOMRect } from "@tiptap/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { noteBusy, setMenuShows, useEdits } from "../editWithAi";
import { selectionForEdit } from "./editSelection";
import { holdSelection } from "./heldSelection";
import { blockAt } from "./writingPlace";

export interface EditWithAiField {
  mindId: string;
  send(editor: Editor, instruction: string): void;
  /** Absent where there is no assistant to hand the request to. */
  handOff?(editor: Editor, instruction: string): void;
}

export type EditPhase = "idle" | "working" | "settled";

/**
 * What the selection menu's Edit with AI… field is doing: what is typed, the
 * request it sends, and where that stands. While the AI works the menu is one
 * line under the text, with the keys: Esc stops, Enter does nothing. When it is
 * done the menu goes, or, if it gave nothing and the User hasn't moved, comes
 * back over the selection with the field and the reason.
 */
export function useEditField(editor: Editor, edit: EditWithAiField | undefined, hide: () => void) {
  const mindId = edit?.mindId;
  const [phase, setPhase] = useState<EditPhase>("idle");
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const working = useRef(false);
  const sent = useRef<{ from: number; to: number } | null>(null);
  // The working line is under the last Block of the text being changed, at its left edge: it never
  // lies over the text and doesn't slide as the new words come in. A Block's id outlives the rewrite
  // that collapses the text's range, and its last box stands in while it is rewritten.
  const place = useRef<{ blockId: string | null; box: DOMRect | null }>({
    blockId: null,
    box: null,
  });
  const pending = useEdits((state) => (mindId ? state.pending[mindId] : undefined));

  const asked = () => {
    // Set before the request collapses the selection, which would otherwise close the menu.
    working.current = true;
    setPhase("working");
  };

  const send = () => {
    const instruction = text.trim();
    if (!edit || instruction === "" || working.current) return;
    if (useEdits.getState().pending[edit.mindId]) {
      noteBusy(edit.mindId, { blockId: null, at: Date.now() });
      setPhase("settled");
      return;
    }
    const { from, to } = editor.state.selection;
    place.current = { blockId: selectionForEdit(editor.state)?.to.blockId ?? null, box: null };
    asked();
    edit.send(editor, instruction);
    sent.current = { from, to };
  };

  useEffect(() => {
    if (phase !== "working" || pending) return;
    working.current = false;
    const kept = sent.current;
    const { selection } = editor.state;
    const problem = mindId ? useEdits.getState().problems[mindId] : undefined;
    // The request leaves the cursor at the end of the text; the User has moved it if it is elsewhere.
    if (problem && kept && !editor.isDestroyed && selection.empty && selection.from === kept.to) {
      const size = editor.state.doc.content.size;
      editor.commands.setTextSelection({
        from: Math.min(kept.from, size),
        to: Math.min(kept.to, size),
      });
      setPhase("settled");
      return;
    }
    hide();
  }, [phase, pending, editor, mindId, hide]);

  useLayoutEffect(() => {
    if (phase === "working") pill.current?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => {
    if (phase === "settled") input.current?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => {
    if (!mindId || phase === "idle") return;
    setMenuShows(mindId, true);
    return () => setMenuShows(mindId, false);
  }, [mindId, phase]);

  const reset = useCallback(() => {
    working.current = false;
    sent.current = null;
    setPhase("idle");
    setText("");
    holdSelection(editor, false, "edit-field");
  }, [editor]);

  const anchor = useCallback((): VirtualElement | null => {
    if (!working.current) return null;
    return {
      getBoundingClientRect: () => {
        const { blockId } = place.current;
        const block = blockId ? blockAt(editor.state.doc, blockId) : null;
        const dom = block ? editor.view.nodeDOM(block.pos) : null;
        if (dom instanceof HTMLElement) place.current.box = dom.getBoundingClientRect();
        const { from, to } = editor.state.selection;
        return place.current.box ?? posToDOMRect(editor.view, from, to);
      },
    };
  }, [editor]);

  return {
    phase,
    text,
    setText,
    input,
    pill,
    working,
    send,
    asked,
    reset,
    anchor,
    focus: () => input.current?.focus({ preventScroll: true }),
  };
}
