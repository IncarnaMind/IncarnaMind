import type { Editor } from "@tiptap/core";
import { useEffect } from "react";
import { dismissEditProblem, stopEdit, useEdits } from "../editWithAi";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { appliedLineIn, setAppliedLine } from "./appliedEditLine";
import { editProblemParts } from "./EditStatus";

const SHOWN_AFTER_MS = 300;

/**
 * Where an edit asked in the selection menu reports once the menu is closed
 * (DESIGN.md, Selection menu): in the spot its Undo line lands, which replaces
 * the line there. "Making the changes… · Stop" after 300 ms, or why it gave
 * nothing, with the one thing that helps. Esc in the text stops it.
 */
export function useMenuEditLine(editor: Editor, mindId: string, readOnly: boolean): void {
  const t = useT();
  const language = useLanguage();
  const openSettings = useAppStore((state) => state.openSettings);
  const pending = useEdits((state) => state.pending[mindId]);
  const problem = useEdits((state) => state.problems[mindId]);
  const menuShown = useEdits((state) => state.menuShows[mindId] === true);

  useEffect(() => {
    if (readOnly || editor.isDestroyed) return;
    const clear = () => {
      const kind = appliedLineIn(editor.state)?.kind;
      if (kind === "running" || kind === "failed") setAppliedLine(editor, null);
    };
    if (menuShown) {
      clear();
      return;
    }
    if (pending?.menu) {
      if (pending.stopped) {
        clear();
        return;
      }
      const { blockId, at } = pending.menu;
      const timer = setTimeout(
        () => setAppliedLine(editor, { kind: "running", blockId, stop: () => stopEdit(mindId) }),
        Math.max(0, at + SHOWN_AFTER_MS - Date.now()),
      );
      return () => clearTimeout(timer);
    }
    if (!pending && problem?.menu && problem.kind !== "busy") {
      const { blockId } = problem.menu;
      const parts = editProblemParts(problem, t, language, openSettings, mindId);
      const retry = parts.action;
      setAppliedLine(editor, {
        kind: "failed",
        blockId,
        text: parts.text,
        action: retry
          ? {
              label: retry.label,
              run: () => {
                retry.run();
                // Asking again clears the line: put the working line back in the box it had, so
                // the text below it does not jump (#1417).
                if (
                  (problem.kind === "failed" || problem.kind === "cut-short") &&
                  useEdits.getState().pending[mindId]?.menu
                ) {
                  setAppliedLine(editor, {
                    kind: "running",
                    blockId,
                    stop: () => stopEdit(mindId),
                  });
                }
              },
            }
          : null,
        close: () => dismissEditProblem(mindId),
      });
      return;
    }
    clear();
  }, [editor, mindId, readOnly, pending, problem, menuShown, t, language, openSettings]);

  useEffect(() => {
    if (readOnly) return;
    const dom = editor.view.dom;
    const onKey = (event: KeyboardEvent) => {
      const running = useEdits.getState().pending[mindId];
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (!running?.menu || running.stopped || useEdits.getState().menuShows[mindId]) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stopEdit(mindId);
    };
    // Ahead of the editor's own use of Esc.
    dom.addEventListener("keydown", onKey, true);
    return () => dom.removeEventListener("keydown", onKey, true);
  }, [editor, mindId, readOnly]);
}
