import { useLayoutEffect, useRef } from "react";
import { useDragState } from "../dragDrop";
import { useT } from "../i18n";

const EDGE_PX = 4;

export function DropLabel() {
  const t = useT();
  const said = useDragState((state) => state.over?.effect.said ?? state.refusal?.said ?? null);
  const refused = useDragState((state) => state.refusal !== null);
  const at = useDragState((state) => state.at);
  const label = useRef<HTMLDivElement>(null);
  // Under the pointer, and kept inside the window by its own width, so a short one stays by it.
  useLayoutEffect(() => {
    const element = label.current;
    if (!element || !at) return;
    const room = window.innerWidth - element.offsetWidth - EDGE_PX;
    element.style.left = `${Math.max(EDGE_PX, Math.min(at.x - 12, room))}px`;
    element.style.top = `${Math.min(at.y + 20, window.innerHeight - element.offsetHeight - EDGE_PX)}px`;
  });
  if (!said || !at) return null;
  return (
    <div
      ref={label}
      data-testid={refused ? "drop-refusal" : "drop-label"}
      aria-hidden="true"
      className={`pointer-events-none fixed z-[70] max-w-72 truncate rounded-md px-2 py-1 text-[12px] leading-4 font-semibold shadow-[0_4px_12px_rgba(23,25,28,0.18)] ${
        refused ? "bg-ink-secondary text-white" : "bg-ink text-white"
      }`}
    >
      {said(t)}
    </div>
  );
}
