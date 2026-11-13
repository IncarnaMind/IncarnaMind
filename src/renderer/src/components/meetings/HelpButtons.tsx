import type { Meeting, MeetingHelpKind } from "../../../../core/api";
import { helpKindsFor, helpLabel, isGeneralHelpKind } from "../../../../shared/meetingHelp";
import { useT } from "../../i18n";
import { helpKeysLabel, useMeetingHelp } from "../../meetingHelp";
import { useAppStore } from "../../store";

/**
 * The help buttons at the top of the assistant during a call: the general ones, then the ones the
 * meeting's template adds, the keys in each tooltip. The one pressed last is marked. The floating
 * panel has its ask bar instead (meetingPanel/AskBar.tsx).
 */
export function HelpButtons({
  meeting,
  onPress,
}: {
  meeting: Meeting;
  onPress(kind: MeetingHelpKind): void;
}) {
  const t = useT();
  const settings = useAppStore((state) => state.settings);
  const pending = useMeetingHelp((state) => state.pending[meeting.id]);
  const pressed = pending?.kind ?? meeting.help?.kind;
  return (
    <fieldset
      aria-label={t("meetings.help.label")}
      data-testid="help-buttons"
      className="help-buttons"
    >
      {helpKindsFor(meeting.helpTemplate).map((kind) => {
        const name = t(helpLabel(kind));
        const shortcut = helpKeysLabel(kind, settings);
        return (
          <button
            key={kind}
            type="button"
            data-testid="help-button"
            data-kind={kind}
            data-general={isGeneralHelpKind(kind)}
            aria-pressed={pressed === kind}
            title={shortcut ? t("meetings.help.button", { name, shortcut }) : name}
            onClick={() => onPress(kind)}
            className="help-button"
          >
            <span className="help-button-name">{name}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
