import type { MessageKey } from "../../../../shared/i18n";
import { useComposer } from "../../composer";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { NeedsModelCard } from "../providers/NeedsModelCard";

const STARTERS: readonly MessageKey[] = [
  "meeting.ask.recap",
  "meeting.ask.next",
  "meeting.ask.actions",
];

/**
 * A new conversation during a call (#144): quick asks that follow the call, each asked at
 * once from the composer, as if typed there. With no AI model ready, first run's key field
 * in place (#1922), and the asks come back once a model works.
 */
export function MeetingStarters() {
  const t = useT();
  const readiness = useAppStore((state) => state.chatReadiness);
  if (readiness && !readiness.ready && readiness.reason === "no-provider") {
    return (
      <div data-testid="meeting-set-up" className="assistant-empty">
        <NeedsModelCard
          line="needsModel.help"
          testId="meeting-needs-model"
          autoFocus={false}
          onDone={() => undefined}
        />
      </div>
    );
  }
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
