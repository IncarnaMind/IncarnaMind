import type { Meeting } from "../../../../core/api";
import { useT } from "../../i18n";
import { helpKeysLabel } from "../../meetingHelp";
import { useMeetings } from "../../meetings";
import { useAppStore } from "../../store";
import { MicLineIcon, MicOffLineIcon } from "../lineIcons";

/**
 * Pause my mic (暂停我的麦克风), for when the User mutes themselves in the call to talk to someone
 * in the room: pressed while the microphone is paused. The other side is still recorded, which
 * its tooltip says. `keys`: the shortcut held now, which the panel shows; else the one set.
 * `worded`: its name beside the icon, where the row has room for words.
 */
export function MicrophoneButton({
  meeting,
  testId,
  className,
  keys,
  worded = false,
}: {
  meeting: Meeting;
  testId: string;
  className: string;
  keys?: string | null;
  worded?: boolean;
}) {
  const t = useT();
  const settings = useAppStore((state) => state.settings);
  const paused = meeting.microphonePausedAtMs !== null;
  const shortcut = keys === undefined ? helpKeysLabel("mic", settings) : keys;
  const title = paused
    ? shortcut
      ? t("meetings.mic.resumeTipKeys", { keys: shortcut })
      : t("meetings.mic.resume")
    : shortcut
      ? t("meetings.mic.pauseTipKeys", { keys: shortcut })
      : t("meetings.mic.pauseTip");
  const Icon = paused ? MicOffLineIcon : MicLineIcon;
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={paused}
      aria-label={t("meetings.mic.pause")}
      title={title}
      onClick={() => void useMeetings.getState().setMicrophonePaused(meeting.id, !paused)}
      className={className}
    >
      <Icon className={worded ? "size-4" : "size-3.5"} />
      {worded && (
        <span className="meeting-button-word">
          {t(paused ? "meetings.mic.resume" : "meetings.mic.pause")}
        </span>
      )}
    </button>
  );
}
