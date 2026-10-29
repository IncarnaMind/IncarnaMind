import { type Editor, isMacOS } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { type ReactNode, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import type * as Y from "yjs";
import { setCheckCardOpen, setClaimFocus, setOpenClaim, useChecks } from "../checks";
import { pressed } from "../commands/keys";
import { commands } from "../commands/registry";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { useCardPlace } from "./checkPlace";
import { checkOpinion, type OpinionCheck, opinionAt, opinionChecks } from "./opinionChecks";
import { keepMenuClosed } from "./selectionDismissal";

export function OpinionMenu({
  editor,
  mindId,
  doc,
  children,
}: {
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  children: ReactNode;
}) {
  const t = useT();
  const place = useCardPlace(mindId);
  const [opinion, setOpinion] = useState<OpinionCheck | null>(null);
  const menu = useObjectMenu(null, (row, point) => {
    if (editor.isDestroyed || !editor.isEditable || useChecks.getState().running[mindId])
      return null;
    const at = point && editor.view.posAtCoords({ left: point.x, top: point.y });
    const chosen =
      point === undefined
        ? opinionAt(editor, doc)
        : at &&
          opinionChecks(editor, doc).find(
            (each) => each.range.from <= at.pos && at.pos < each.range.to,
          );
    if (!chosen) return null;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, chosen.range.from, chosen.range.to),
      ),
    );
    keepMenuClosed(editor, chosen.range.from, chosen.range.to);
    editor.view.focus();
    setCheckCardOpen(place, false);
    setClaimFocus(place, null);
    setOpenClaim(place, null);
    flushSync(() => setOpinion(chosen));
    return row.querySelector<HTMLButtonElement>('[data-testid="opinion-context-menu"]');
  });
  const { onKeyDown, ...rowProps } = menu.rowProps;

  useEffect(() => {
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
    element.addEventListener("keydown", openPalette, true);
    return () => {
      element.removeEventListener("keydown", openPalette, true);
    };
  }, [editor, doc]);

  return (
    <div
      className="contents"
      {...rowProps}
      onKeyDownCapture={(event) => {
        // The editor takes Shift+F10 before a bubbling row handler can open the opinion menu (#2002).
        if (event.target instanceof Node && editor.view.dom.contains(event.target))
          onKeyDown(event);
      }}
    >
      {children}
      {opinion && (
        <ObjectMenu
          key={`${opinion.id}:${opinion.span.start}:${opinion.span.end}`}
          target={{ kind: "check", id: opinion.id }}
          label={t("claim.more")}
          className="sr-only"
          tabIndex={-1}
          testId="opinion-context"
          without={["check.findSources", "check.useDocumentWording"]}
          here={{
            "check.anyway": () => {
              checkOpinion(editor, mindId, doc, opinion, place);
            },
          }}
        />
      )}
    </div>
  );
}
