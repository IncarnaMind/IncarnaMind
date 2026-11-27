import type { RefObject } from "react";
import type { MessageKey } from "../../../../shared/i18n";
import { useT } from "../../i18n";
import { ChatLineIcon } from "../icons";
import type { AssistantDragging } from "./useAssistantDrag";

const ZONE_LABELS: Record<AssistantDragging["zones"][number]["dock"], MessageKey> = {
  right: "assistant.dock.right",
  left: "assistant.dock.left",
  bottom: "assistant.dock.bottom",
};

/**
 * While the assistant's header is dragged: a short bar on each edge it can
 * dock to, and the zone the pointer is near filled and named ("Dock on the
 * right"), as macOS shows a window's tile; and the stand-in under the pointer,
 * which says "Float here" away from the edges. Only while dragging, so a
 * target lights only while it accepts.
 */
export function SnapZones({
  dragging,
  standIn,
}: {
  dragging: AssistantDragging | null;
  standIn: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  if (!dragging) return null;
  return (
    <>
      {dragging.zones.map(({ dock, rect }) => (
        <div
          key={dock}
          data-testid="assistant-snap-zone"
          data-zone={dock}
          data-active={dragging.zone === dock || undefined}
          className="assistant-snap-zone"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          <span>{t(ZONE_LABELS[dock])}</span>
        </div>
      ))}
      <div
        ref={standIn}
        aria-hidden="true"
        data-testid="assistant-stand-in"
        data-over-zone={dragging.zone !== null || undefined}
        className="assistant-stand-in"
        style={{
          width: dragging.size.width,
          height: dragging.size.height,
          transform: `translate(${dragging.at.left}px, ${dragging.at.top}px)`,
        }}
      >
        <div className="assistant-stand-in-head">
          <ChatLineIcon className="size-4 shrink-0 text-ink-meta" />
          <span className="truncate">{t("conversation.untitled")}</span>
        </div>
        <div className="assistant-stand-in-body">{t("assistant.floatHere")}</div>
      </div>
    </>
  );
}
