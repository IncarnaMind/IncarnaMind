/**
 * Where the count of what a write's check flagged takes the User (#1635), from the change's line
 * ("2 need a look", `lookText`): the first such sentence of the write, its check card open.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { BLOCK_ID_ATTRIBUTE } from "../../core/api";
import type { ChangedMind } from "./changedMinds";
import { setCheckCardOpen, setOpenClaim } from "./checks";
import { noteHandle, readMindHandle } from "./commands/handles";
import { shownClaims } from "./editor/claimChecks";
import { useAppStore } from "./store";

const FLAGGED: ReadonlySet<string> = new Set(["unsupported", "contradicted"]);

/** Puts the cursor in the first sentence of `blocks` a check flagged, with its card open; false when there is none. */
export function showFirstLook(editor: Editor, blocks: readonly string[]): boolean {
  if (editor.isDestroyed) return false;
  const { doc } = editor.state;
  const ids = new Set(blocks);
  const spans: { from: number; to: number }[] = [];
  doc.forEach((node, offset) => {
    if (ids.has(String(node.attrs[BLOCK_ID_ATTRIBUTE]))) {
      spans.push({ from: offset, to: offset + node.nodeSize });
    }
  });
  const claim = shownClaims(editor.state).find(
    (each) =>
      FLAGGED.has(each.shown.state) &&
      spans.some((span) => span.from <= each.sentence.from && each.sentence.from < span.to),
  );
  if (!claim) return false;
  editor.view.focus();
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.near(doc.resolve(claim.sentence.from)))
      .scrollIntoView(),
  );
  // Focused, the editor lends itself to the commands with the place its cards open in.
  const note = noteHandle.current;
  if (note?.editor === editor) {
    setCheckCardOpen(note.place, false);
    setOpenClaim(note.place, claim.check.id);
  }
  return true;
}

const SHOW_FRAMES = 60;

/** From the assistant's card: the Mind, at the first sentence its write's check flagged, once it shows. */
export function showLook(row: Pick<ChangedMind, "mindId" | "lookIn">): void {
  useAppStore.getState().openMind(row.mindId);
  const reveal = (frames: number) => {
    const read = readMindHandle.current;
    if (read?.mindId === row.mindId && showFirstLook(read.editor, row.lookIn)) return;
    if (frames > 0) requestAnimationFrame(() => reveal(frames - 1));
  };
  reveal(SHOW_FRAMES);
}
