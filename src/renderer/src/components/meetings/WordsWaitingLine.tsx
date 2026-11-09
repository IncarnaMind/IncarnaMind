import { useState } from "react";
import type { TranscriptionServiceStatus } from "../../../../core/api";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  ROUTE_LABELS,
  type ServicesView,
  useTranscriptionServices,
} from "../../transcriptionServices";
import { MetaLine } from "../MetaLine";
import { LineAction } from "../ProblemLine";
import { SettingsHelp } from "../settings/SettingsGroup";

/**
 * The route chosen before its service was sent the meeting's words to know (#1031), which gets
 * the audio and not them; none in Local mode, which sends nothing.
 */
export function useWordsWaiting(read: ServicesView): TranscriptionServiceStatus | null {
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute);
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  if (read.state !== "ready" || localMode) return null;
  return read.data.find((each) => each.route === route && each.wordsWaiting) ?? null;
}

/**
 * Under Words to know: the route whose words wait says so, with what sending them gives it. Send
 * is the consent for the words alone (ADR-0022), given where the line says what goes; the route
 * stays as it is.
 */
export function WordsWaitingLine({
  service,
  onSent,
}: {
  service: TranscriptionServiceStatus;
  onSent(): void;
}) {
  const t = useT();
  const [sending, setSending] = useState(false);
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
      <MetaLine
        as="div"
        parts={[
          t("meetings.words.waiting", { provider }),
          <LineAction
            key="send"
            action={{
              label: t("meetings.words.send", { provider }),
              testId: "meeting-words-send",
              disabled: sending,
              onClick: () => void send(),
            }}
          />,
        ]}
      />
    </SettingsHelp>
  );
}
