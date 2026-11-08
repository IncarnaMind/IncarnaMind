import { useState, useSyncExternalStore } from "react";
import type { Meeting, MeetingSourceState } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { useT } from "../../i18n";
import { LEVEL_BARS, useMeetingLevels } from "../../meetingLevels";
import { isWaitingForPermission } from "../../meetings";
import { motionMode, subscribeMotion } from "../../motion";
import { StopLineIcon, WarningLineIcon } from "../lineIcons";

/** Where a bar stands when the bars hold still: highest in the middle. */
const STILL_SHAPE = [0.55, 0.8, 1, 0.8, 0.55];
const LOWEST_PX = 2;
const HIGHEST_PX = 12;

const MICROPHONE_PROBLEMS: Partial<Record<MeetingSourceState, MessageKey>> = {
  silent: "meetings.line.microphoneSilent",
  denied: "meetings.line.microphoneDenied",
  unavailable: "meetings.line.microphoneUnavailable",
  ended: "meetings.line.microphoneEnded",
};

/**
 * Small level bars that move with the voices while a Meeting records: the one thing that
 * moves, so the User knows they're heard, as voice input's meter does. With reduced motion they
 * hold still and only change height. When the microphone fails, a warning mark says what to do.
 * `onStop`: hovered or focused, they become Stop (the folded panel).
 */
export function LevelBars({ meeting, onStop }: { meeting: Meeting; onStop?: () => void }) {
  const t = useT();
  const readings = useMeetingLevels((state) => state.levels[meeting.id]);
  const mode = useSyncExternalStore(subscribeMotion, motionMode);
  const [pointed, setPointed] = useState(false);
  if (isWaitingForPermission(meeting)) return null;
  const problem = MICROPHONE_PROBLEMS[meeting.sources.microphone];
  if (problem) {
    return (
      <span
        role="img"
        aria-label={t(problem)}
        title={t(problem)}
        data-testid="level-warning"
        className="level-warning"
      >
        <WarningLineIcon className="size-3.5" />
      </span>
    );
  }
  const recording = meeting.status === "recording";
  const latest = recording ? (readings ?? []) : [];
  const heights = Array.from({ length: LEVEL_BARS }, (_, index) => {
    const level =
      mode === "on"
        ? (latest[latest.length - LEVEL_BARS + index] ?? 0)
        : (latest.at(-1) ?? 0) * (STILL_SHAPE[index] ?? 1);
    return Math.round(LOWEST_PX + level * (HIGHEST_PX - LOWEST_PX));
  });
  const bars = (
    <span aria-hidden="true" data-testid="level-bars" data-motion={mode} className="level-bars">
      {heights.map((height, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the bars are fixed places, not items.
        <span key={index} data-testid="level-bar" className="level-bar" style={{ height }} />
      ))}
    </span>
  );
  if (!onStop) {
    return (
      <span role="img" aria-label={t("meetings.level.label")} className="level-meter">
        {bars}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="level-stop"
      aria-label={t("meetings.bar.stopLabel")}
      title={t("meetings.bar.stopLabel")}
      onMouseEnter={() => setPointed(true)}
      onMouseLeave={() => setPointed(false)}
      onFocus={() => setPointed(true)}
      onBlur={() => setPointed(false)}
      onClick={onStop}
      data-pointed={pointed}
      className="level-meter level-meter--stop"
    >
      {pointed ? <StopLineIcon data-testid="level-stop-icon" className="size-3.5" /> : bars}
    </button>
  );
}
