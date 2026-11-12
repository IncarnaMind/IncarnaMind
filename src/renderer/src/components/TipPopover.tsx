import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Popover } from "../editor/Popover";
import { useTopModal } from "./useModal";
import type { useTip } from "./useTip";

/**
 * The shared tip's bubble (`useTip`) beside `anchor`. It is drawn inside the modal dialog on top
 * when one is open, since everything outside a modal is inert.
 */
export function TipPopover({
  anchor,
  tip,
  id,
  children,
}: {
  anchor: HTMLElement;
  tip: Pick<ReturnType<typeof useTip>, "close" | "point" | "leave">;
  id?: string;
  children: ReactNode;
}) {
  const modal = useTopModal();
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
        {children}
      </div>
    </Popover>,
    modal ?? document.body,
  );
}
