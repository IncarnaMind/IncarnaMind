import { useContext, useRef } from "react";
import { useFade } from "../motion";
import { useQuietAssistant } from "../quietAssistant";
import { lineShownAt, type UndoLineState, useUndo } from "../undo";
import { showsUndoPill } from "../undoPill";
import { useHeld } from "../useHeld";
import { SidebarControlContext } from "./SidebarToggle";
import { UndoLineBody } from "./UndoLine";

/**
 * The line with the sidebar out of sight (#1776): in the card's bottom left corner, where a User
 * working with the mouse can reach Undo.
 */
export function UndoPill() {
  const sidebar = useContext(SidebarControlContext);
  const line = useUndo((state) => (lineShownAt(state) === null ? state.line : null));
  const quiet = useQuietAssistant();
  if (!showsUndoPill(sidebar)) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="undo-pill-place"
      data-quiet={quiet || undefined}
      className="undo-pill-place"
    >
      {line && <Pill key={line.id} line={line} />}
    </div>
  );
}

/** The pill fades as a whole: its background and shadow with its words, never the words alone. */
function Pill({ line }: { line: UndoLineState }) {
  const pill = useRef<HTMLDivElement>(null);
  useFade(pill);
  const held = useHeld(pill, { focusHolds: true });
  return (
    <div ref={pill} data-testid="undo-pill" className="undo-pill">
      <UndoLineBody line={line} inPill held={held} fade={false} />
    </div>
  );
}
