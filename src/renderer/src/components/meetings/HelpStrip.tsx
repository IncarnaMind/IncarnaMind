import { askHelpInAssistant, useMeetingHelp } from "../../meetingHelp";
import { isLive, useMeetings } from "../../meetings";
import { HelpButtons } from "./HelpButtons";

/**
 * The help buttons at the top of the assistant while the Mind it reads records, when the
 * floating panel, which has them, isn't shown: one place with the buttons at a time.
 */
export function HelpStrip({ mindId }: { mindId: string | null }) {
  // A voice memo has no call to help with (#1568).
  const meeting = useMeetings((state) =>
    state.meetings.find(
      (each) => each.mindId === mindId && isLive(each) && each.kind === "meeting",
    ),
  );
  const panelShown = useMeetingHelp((state) => state.panel.shown);
  if (!meeting || panelShown) return null;
  return (
    <div data-testid="help-strip" className="help-strip">
      <HelpButtons
        meeting={meeting}
        layout="strip"
        onPress={(kind) => void askHelpInAssistant(kind)}
      />
    </div>
  );
}
