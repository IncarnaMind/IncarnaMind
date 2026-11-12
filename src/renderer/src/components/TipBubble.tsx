import { createPortal } from "react-dom";
import { Popover } from "../editor/Popover";
import { useTopModal } from "./useModal";
import type { useTip } from "./useTip";

/**
 * The app's one tip, beside `anchor` while `tip` is shown, and otherwise the same words hidden, so
 * `id` still describes its trigger to a screen reader.
 */
export function TipBubble({
  anchor,
  id,
  text,
  tip,
}: {
  anchor: HTMLElement | null;
  id: string;
  text: string;
  tip: ReturnType<typeof useTip>;
}) {
  const modal = useTopModal();
  if (!tip.shown || !anchor) {
    return (
      <span id={id} role="tooltip" hidden>
        {text}
      </span>
    );
  }
  return createPortal(
    <Popover
      anchor={anchor}
      role="tooltip"
      id={id}
      onDismiss={tip.close}
      onPointerMove={tip.point}
      onPointerLeave={tip.leave}
    >
      <div className="w-max max-w-[min(20rem,calc(100vw-32px))] rounded-md bg-sheet px-3 py-2 text-[12px] leading-5 font-normal text-ink shadow-popover">
        {text}
      </div>
    </Popover>,
    modal ?? document.body,
  );
}
