import type { MessageKey } from "../../../../shared/i18n";
import { useComposer } from "../../composer";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";

const STARTERS: readonly MessageKey[] = [
  "meeting.ask.recap",
  "meeting.ask.next",
  "meeting.ask.actions",
];

/**
 * A new conversation during a call (#144): quick asks that follow the call, each asked at
 * once from the composer, as if typed there.
 */
export function MeetingStarters() {
  const t = useT();
  const readiness = useAppStore((state) => state.chatReadiness);
  // With no model, the call's help is the User's own AI, whose line stands at the Note's foot
  // (#3767): no model is set up here.
  if (readiness && !readiness.ready && readiness.reason === "no-provider") return null;
  return (
    <ul
      aria-label={t("meeting.ask.label")}
      data-testid="meeting-starters"
      className="assistant-starters"
    >
      {STARTERS.map((starter) => (
        <li key={starter}>
          <button
            type="button"
            data-testid="meeting-starter"
            onClick={() => useComposer.getState().requestAsk(t(starter))}
            className="assistant-starter"
          >
            {t(starter)}
          </button>
        </li>
      ))}
    </ul>
  );
}
