import { focusComposer } from "../../commands/assistant";
import { shortcutLabel } from "../../commands/keymap";
import { useComparisons } from "../../comparisons";
import { useT } from "../../i18n";
import { isShown } from "../../layoutSlice";
import { useMeetings } from "../../meetings";
import { hasMeetingViews } from "../../meetingViews";
import { useAppStore } from "../../store";
import { useGroupsMerged } from "../../useWindowWidth";

export function AskPill() {
  const t = useT();
  // The Compare Documents sheet's Make button sits where the pill floats (#1839).
  const comparing = useComparisons((state) => Object.keys(state.sheets).length > 0);
  // So does a recorded call's control, at its Note's foot (#3762): in a narrow window the pill
  // would lie over it and take its press.
  const merged = useGroupsMerged();
  const meetings = useMeetings((state) => state.meetings);
  const callAtFoot = useAppStore((state) =>
    meetings.some(
      (meeting) =>
        hasMeetingViews(meeting) &&
        isShown(state.layout, { kind: "mind", mindId: meeting.mindId }, merged),
    ),
  );
  if (comparing || callAtFoot) return null;
  return (
    <button
      type="button"
      data-testid="ask-pill"
      data-ask-pill=""
      onClick={focusComposer}
      className="absolute bottom-5 left-1/2 z-10 flex h-10 -translate-x-1/2 items-center gap-3 rounded-full bg-sheet pr-2 pl-5 font-sans text-[14px] text-ink-meta shadow-[inset_0_0_0_1px_var(--color-rule-strong),0_4px_16px_var(--color-shadow-soft)] hover:text-ink"
    >
      {t("assistant.pill")}
      <kbd className="rounded-sm bg-chip px-[5px] py-px font-sans text-[12px] text-ink-strong">
        {shortcutLabel("composer.focus")}
      </kbd>
    </button>
  );
}
