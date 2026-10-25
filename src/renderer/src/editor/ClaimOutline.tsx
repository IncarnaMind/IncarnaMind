import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";
import { shownClaims } from "./claimChecks";
import { type Box, lineBoxes } from "./lineBoxes";

const sameBoxes = (a: readonly Box[], b: readonly Box[]) =>
  a.length === b.length &&
  a.every((box, at) => {
    const other = b[at];
    return (
      other !== undefined &&
      box.left === other.left &&
      box.top === other.top &&
      box.width === other.width &&
      box.height === other.height
    );
  });

/**
 * The 2px accent outline of a sentence whose check card is open, a box on each line it covers. It
 * is drawn over the words in the margin layer, since the editor's own decorations would outline
 * each differently formatted run of the sentence on its own.
 */
export function ClaimOutline({
  editor,
  id,
  layer,
}: {
  editor: Editor;
  id: string;
  /** The margin layer, whose top left corner the boxes are measured from. */
  layer: HTMLElement;
}) {
  const [boxes, setBoxes] = useState<readonly Box[]>([]);

  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (editor.isDestroyed) return;
      const sentence = shownClaims(editor.state).find((claim) => claim.check.id === id)?.sentence;
      if (!sentence) {
        setBoxes([]);
        return;
      }
      const start = editor.view.domAtPos(sentence.from);
      const end = editor.view.domAtPos(sentence.to);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const origin = layer.getBoundingClientRect();
      const next = lineBoxes(
        Array.from(range.getClientRects(), (rect) => ({
          left: rect.left - origin.left,
          top: rect.top - origin.top,
          width: rect.width,
          height: rect.height,
        })),
      );
      setBoxes((shown) => (sameBoxes(shown, next) ? shown : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    editor.on("transaction", schedule);
    const resizes = new ResizeObserver(schedule);
    resizes.observe(editor.view.dom);
    document.fonts.addEventListener("loadingdone", schedule);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", schedule);
      resizes.disconnect();
      document.fonts.removeEventListener("loadingdone", schedule);
    };
  }, [editor, id, layer]);

  return boxes.map((box) => (
    <div
      key={`${box.top}:${box.left}`}
      data-testid="claim-outline"
      aria-hidden="true"
      className="claim-outline"
      style={box}
    />
  ));
}
