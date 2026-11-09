import { useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  ROUTE_LABELS,
  type ServicesView,
  useTranscriptionServices,
} from "../../transcriptionServices";
import { LineAction } from "../ProblemLine";
import { SettingsHelp } from "../settings/SettingsGroup";

/**
 * Under Words to know (#1031): a route chosen before its service was sent the words gets the
 * audio and not them, and says so, with what sending them gives it. Send is the consent for the
 * words alone (ADR-0022), given where the line says what goes; the route stays as it is. Nothing
 * in Local mode, which sends nothing.
 */
export function WordsWaitingLine({ read, onSent }: { read: ServicesView; onSent(): void }) {
  const t = useT();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute);
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const [sending, setSending] = useState(false);
  const service =
    read.state === "ready"
      ? read.data.find((each) => each.route === route && each.wordsWaiting)
      : undefined;
  if (!service || localMode) return null;
  const provider = t(ROUTE_LABELS[service.route]);
  const send = async () => {
    setSending(true);
    try {
      await useTranscriptionServices.getState().allowWords();
      onSent();
    } catch (failure) {
      useAppStore.getState().reportError(failure);
    } finally {
      setSending(false);
    }
  };
  return (
    <SettingsHelp role="status" data-testid="meeting-words-waiting">
      {t("meetings.words.waiting", { provider })}
      <span aria-hidden="true"> · </span>
      <LineAction
        action={{
          label: t("meetings.words.send", { provider }),
          testId: "meeting-words-send",
          disabled: sending,
          onClick: () => void send(),
        }}
      />
    </SettingsHelp>
  );
}
