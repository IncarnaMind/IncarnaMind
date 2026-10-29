/**
 * The count of what a write's check flagged, on the assistant's card (#1635): counted now in the
 * Mind as saved, by the badge's rule (./editor/writeLook), so it goes once none remain, and where
 * it takes the User: the first of them, its card open with the keyboard in it.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useMemo } from "react";
import type { ChangedMind } from "./changedMinds";
import { noteHandle } from "./commands/handles";
import { goToClaim } from "./editor/goToClaim";
import { healthNow } from "./editor/healthNow";
import { whenMindEditor } from "./editor/openEditors";
import { firstBlockOf, lookPlaces } from "./editor/writeLook";
import { useMindNoteStates } from "./home";
import { useAppStore } from "./store";

type Look = Pick<ChangedMind, "mindId" | "look" | "lookIn">;

/** How many of a write's claims need a look in its Mind now; its record's count until that is read. */
export function useWriteLook(row: Look): number {
  const folderId = useAppStore(
    (state) => state.minds.find((mind) => mind.id === row.mindId)?.folderId ?? null,
  );
  const minds = useMemo(
    () => (row.look > 0 ? [{ id: row.mindId, folderId }] : []),
    [row.mindId, row.look, folderId],
  );
  const reading = useMindNoteStates(minds).get(row.mindId);
  return reading ? lookPlaces(reading.root, reading.health, row.lookIn).length : row.look;
}

/**
 * In an open Mind: the cursor at the first of a write's claims that need a look, its card open
 * with the keyboard in it. With none left, at the write's first Block instead, and false.
 */
export function showFirstLook(editor: Editor, blocks: readonly string[]): boolean {
  if (editor.isDestroyed) return false;
  const [at] = lookPlaces(editor.state.doc, healthNow(editor.state), blocks);
  // Focused, the editor lends itself to the commands, with its Mind and the place its cards open in.
  editor.view.focus();
  if (at === undefined) {
    const start = firstBlockOf(editor.state.doc, blocks);
    if (start !== null) {
      const { tr, doc } = editor.state;
      editor.view.dispatch(
        tr.setSelection(TextSelection.near(doc.resolve(start))).scrollIntoView(),
      );
    }
    return false;
  }
  const note = noteHandle.current?.editor === editor ? noteHandle.current : null;
  if (!note) return false;
  goToClaim(editor, { mindId: note.mindId, place: note.place, at, focusCard: true });
  return true;
}

/** How long the Mind may take to open in an editor, and its text to arrive there. */
const OPEN_MS = 3000;

const nextChange = (editor: Editor, ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      editor.off("update", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    editor.on("update", done);
  });

/** From the assistant's card: the Mind, at the first of its write's claims that need a look. */
export async function showLook(row: Look): Promise<void> {
  useAppStore.getState().openMind(row.mindId);
  const editor = await whenMindEditor(row.mindId, OPEN_MS);
  if (!editor || showFirstLook(editor, row.lookIn)) return;
  // A Mind just opened may not hold its text yet.
  if (firstBlockOf(editor.state.doc, row.lookIn) === null) {
    await nextChange(editor, OPEN_MS);
    showFirstLook(editor, row.lookIn);
  }
}
