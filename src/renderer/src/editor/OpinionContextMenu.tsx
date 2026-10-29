import { type Editor, isMacOS } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { setCheckCardOpen, setClaimFocus, setOpenClaim, useChecks } from "../checks";
import { pressed } from "../commands/keys";
import { commands } from "../commands/registry";
import { ObjectMenu } from "../components/ObjectMenu";
import { openMenuFromRightClick } from "../components/usePopoverMenu";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { useCardPlace } from "./checkPlace";
import { checkOpinion, type OpinionCheck, opinionAt, opinionChecks } from "./opinionChecks";
import { keepMenuClosed } from "./selectionDismissal";

export function OpinionContextMenu({
  editor,
  mindId,
  doc,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
}) {
  const t = useT();
  const place = useCardPlace(mindId);
  const host = useRef<HTMLDivElement>(null);
  const [request, setRequest] = useState<{
    opinion: OpinionCheck;
    x: number;
    y: number;
    buttons: number;
  } | null>(null);

  useEffect(() => {
    const open = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        editor.isDestroyed ||
        !editor.isEditable ||
        useChecks.getState().running[mindId]
      )
        return;
      const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!at) return;
      const opinion = opinionChecks(editor, doc).find(
        (each) => each.range.from <= at.pos && at.pos < each.range.to,
      );
      if (!opinion) return;
      event.preventDefault();
      event.stopPropagation();
      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, opinion.range.from, opinion.range.to),
        ),
      );
      keepMenuClosed(editor, opinion.range.from, opinion.range.to);
      editor.view.focus();
      setCheckCardOpen(place, false);
      setClaimFocus(place, null);
      setOpenClaim(place, null);
      setRequest({ opinion, x: event.clientX, y: event.clientY, buttons: event.buttons });
    };
    const element = editor.view.dom;
    const openPalette = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.target !== element ||
        editor.isDestroyed ||
        !editor.view.hasFocus() ||
        !editor.isEditable ||
        editor.state.selection.empty ||
        !pressed("CmdOrCtrl+K", event, isMacOS()) ||
        !opinionAt(editor, doc)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void commands.run("palette.open").catch(useAppStore.getState().reportError);
    };
    element.addEventListener("contextmenu", open);
    element.addEventListener("keydown", openPalette, true);
    return () => {
      element.removeEventListener("contextmenu", open);
      element.removeEventListener("keydown", openPalette, true);
    };
  }, [editor, doc, mindId, place]);

  useLayoutEffect(() => {
    if (!request) return;
    const button = host.current?.querySelector<HTMLButtonElement>("[data-object-menu]");
    if (button) openMenuFromRightClick(button, request.buttons, request);
  }, [request]);

  return (
    <div ref={host} className="contents">
      {request && (
        <ObjectMenu
          key={`${request.opinion.id}:${request.opinion.span.start}:${request.opinion.span.end}`}
          target={{ kind: "check", id: request.opinion.id }}
          label={t("claim.more")}
          className="sr-only"
          tabIndex={-1}
          testId="opinion-context"
          without={["check.findSources", "check.useDocumentWording"]}
          here={{
            "check.anyway": () => {
              checkOpinion(editor, mindId, doc, request.opinion, place);
            },
          }}
        />
      )}
    </div>
  );
}
