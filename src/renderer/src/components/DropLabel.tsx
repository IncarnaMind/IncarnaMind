import { useLayoutEffect, useRef } from "react";
import { useDragState } from "../dragDrop";
import { useT } from "../i18n";
import type { Words } from "../lineNames";
import { useWindowDrop } from "./FileDrop";

const EDGE_PX = 4;

/**
 * What the drop would do, under the pointer: a target's own words, or, where
 * no target takes it, the window's, such as a file's "Add to Library".
 */
export function DropLabel({ instead }: { instead?: Words | null }) {
  const t = useT();
  const targetSaid = useDragState(
    (state) => state.over?.effect.said ?? state.refusal?.said ?? null,
  );
  const targetAt = useDragState((state) => state.at);
  const windowAt = useWindowDrop((state) => state.at);
  const refused = useDragState((state) => state.refusal !== null);
  const said = targetSaid ?? instead ?? null;
  const at = targetAt ?? (instead ? windowAt : null);
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
      className={`pointer-events-none fixed z-[70] max-w-72 rounded-md px-2 py-1 text-[12px] leading-4 font-semibold shadow-[0_4px_12px_var(--color-shadow)] ${
        refused ? "bg-ink-secondary text-on-primary" : "bg-ink text-on-primary"
      } ${refused ? "whitespace-normal" : "truncate"}`}
    >
      {said(t)}
    </div>
  );
}
