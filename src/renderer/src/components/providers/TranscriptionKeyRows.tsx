import { useMemo, useState } from "react";
import type { TranscriptionServiceStatus } from "../../../../core/api";
import { useT } from "../../i18n";
import type { SettingsTarget } from "../../settingsPages";
import { ROUTE_LABELS, useTranscriptionServices } from "../../transcriptionServices";
import { MicLineIcon } from "../lineIcons";
import { TranscriptionKeyForm } from "../meetings/TranscriptionKeyForm";
import { KeyRow } from "./KeyRow";
import { KeyNotCheckedLine } from "./ProviderForm";

/**
 * The keys Your providers keeps only for meeting transcription, each its own row, "For meeting
 * transcription", Deepgram's with the server it sends to. Removing the key of the service
 * Meetings use sends them back to this computer, in the core.
 */
export function TranscriptionKeyRows({
  services,
}: {
  services: readonly TranscriptionServiceStatus[];
}) {
  return (
    <>
      {services
        .filter((service) => service.key === "own" && service.hasKey)
        .map((service) => (
          <TranscriptionKeyRow key={service.route} service={service} />
        ))}
    </>
  );
}

function TranscriptionKeyRow({ service }: { service: TranscriptionServiceStatus }) {
  const t = useT();
  const [notChecked, setNotChecked] = useState(false);
  const name = t(ROUTE_LABELS[service.route]);
  const reachedBy = useMemo<SettingsTarget[]>(
    () => [`transcription-key:${service.route}`],
    [service.route],
  );
  return (
    <KeyRow
      testId="transcription-key"
      id={service.route}
      name={name}
      logo={null}
      fallback={<MicLineIcon className="size-[18px]" />}
      status={
        service.server
          ? t("models.providers.forTranscription.server", { server: service.server })
          : t("models.providers.forTranscription")
      }
      change={t("models.providers.changeKey")}
      remove={t("models.providers.removeKey")}
      onRemove={() => useTranscriptionServices.getState().removeKey(service.route)}
      note={notChecked ? <KeyNotCheckedLine provider={name} /> : null}
      reachedBy={reachedBy}
      form={(done) => (
        <TranscriptionKeyForm
          service={service}
          onSaved={({ unchecked }) => {
            setNotChecked(unchecked);
            done();
          }}
          onCancel={done}
        />
      )}
    />
  );
}
