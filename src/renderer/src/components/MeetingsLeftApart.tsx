import { type ReactNode, useEffect, useRef, useState } from "react";
import type { MeetingLeftApart } from "../../../core/api";
import { mindName } from "../../../shared/naming";
import { useDismissOnEscape } from "../escapeDismiss";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { LineAction } from "./ProblemLine";

/**
 * Show on the sidebar's line about meetings left apart from their Transcripts (#2528): the
 * meetings, each opening its Note; Esc folds the list again. Nothing here moves one; that is the
 * User's own act.
 */
export function useMeetingsLeftApartDetails(left: readonly MeetingLeftApart[]): {
  toggle: ReactNode;
  panel: ReactNode;
} {
  const t = useT();
  const minds = useAppStore((state) => state.minds);
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (left.length === 0) setOpen(false);
  }, [left.length]);
  useDismissOnEscape(open, () => {
    setOpen(false);
    toggle.current?.focus();
  });
  const notes = left.flatMap((each) => minds.find((mind) => mind.id === each.mindId) ?? []);
  return {
    toggle: (
      <LineAction
        ref={toggle}
        action={{
          label: open ? t("unread.hide") : t("meetings.leftApart.show"),
          testId: "meetings-left-apart-show",
          onClick: () => setOpen((now) => !now),
        }}
      />
    ),
    panel: open ? (
      <ul data-testid="meetings-left-apart-list" className="mt-1 flex flex-col gap-1">
        {notes.map((mind) => (
          <li key={mind.id} className="min-w-0">
            <button
              type="button"
              data-testid="meetings-left-apart-note"
              title={mindName(mind) || t("mind.untitled")}
              onClick={() => useAppStore.getState().openMind(mind.id)}
              className="block max-w-full truncate rounded-sm text-left text-ink-secondary hover:text-ink"
            >
              {mindName(mind) || t("mind.untitled")}
            </button>
          </li>
        ))}
      </ul>
    ) : null,
  };
}
