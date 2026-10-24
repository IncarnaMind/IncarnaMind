import { useContext, useRef } from "react";
import { type UndoLineState, useUndo } from "../undo";
import { showsUndoPill } from "../undoPill";
import { useHeld } from "../useHeld";
import { SidebarControlContext } from "./SidebarToggle";
import { UndoLineBody } from "./UndoLine";

/**
 * The undo line with the sidebar out of sight (#1776): the same line, in the same words with the
 * same Undo, as a pill at the window's bottom left, in the card's corner — 16px in, above the
 * assistant's composer and right of one docked on the left. The pointer or the focus resting on
 * it keeps it, so the User can reach Undo with the mouse.
 */
export function UndoPill() {
  const sidebar = useContext(SidebarControlContext);
  const line = useUndo((state) => state.line);
  if (!showsUndoPill(sidebar) || !line || line.change?.shownAt) return null;
  return <Pill line={line} />;
}

function Pill({ line }: { line: UndoLineState }) {
  const pill = useRef<HTMLDivElement>(null);
  const held = useHeld(pill);
  return (
    <div ref={pill} role="status" aria-live="polite" data-testid="undo-pill" className="undo-pill">
      <UndoLineBody key={line.id} line={line} inPill held={held} />
    </div>
  );
}
