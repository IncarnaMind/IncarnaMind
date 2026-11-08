import { useState } from "react";
import type { CloudTranscriptionRoute, TranscriptionServiceStatus } from "../../../../core/api";
import { deepgramServer } from "../../../../core/providers/catalog/transcription";
import { formatMoney, joinMeta } from "../../cost";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ROUTE_LABELS, type ServicesView } from "../../transcriptionServices";
import { hintClass } from "../ui";
import { CloudLine } from "./CloudLine";
import { LanguagesLine } from "./LanguagesLine";
import { TranscriptionKeyForm } from "./TranscriptionKeyForm";
import type { TranscriptionSetUpRows } from "./TranscriptionRouteSelect";

const consentClass = "text-[12px] leading-5 text-ink-meta";

/**
 * The Meeting transcription picker's "Set up another transcription service", wherever the picker
 * is a setting (Settings › Models › Defaults, Settings › Meetings): the services with a key of
 * their own that has none yet, at the picker's foot, and the one chosen there set up in place
 * under it. None in Local mode: each is a cloud service. `selectId`: the picker, which takes the
 * focus back when the setup closes.
 */
export function useTranscriptionSetUp(selectId: string, read: ServicesView) {
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const [open, setOpen] = useState<CloudTranscriptionRoute | null>(null);
  const services = localMode || read.state !== "ready" ? [] : read.data;
  // The one being set up stays offered once its key is kept, until it is chosen.
  const offers = services
    .filter((each) => each.key === "own" && (!each.hasKey || each.route === open))
    .map((each) => each.route);
  const service = services.find((each) => each.route === open);
  const close = () => {
    setOpen(null);
    document.getElementById(selectId)?.focus();
  };
  const rows: TranscriptionSetUpRows = {
    offers,
    open: service ? service.route : null,
    onChoose: setOpen,
  };
  return {
    rows,
    /** A route was chosen in the picker itself: the setup goes. */
    onChosen: () => setOpen(null),
    panel: service ? (
      <TranscriptionSetUp key={service.route} service={service} onDone={close} />
    ) : null,
  };
}

/**
 * Deepgram as the server typed would make it, before it is saved: who gets the audio, on what
 * terms and at what price, so the line above Use this names where the audio would go. An empty
 * or unreadable address is Deepgram's own, which saving then keeps or refuses.
 */
function asTyped(service: TranscriptionServiceStatus, typed: string): TranscriptionServiceStatus {
  const address = typed.trim();
  if (service.route !== "deepgram" || address === "" || !URL.canParse(address)) return service;
  const { recipient, dataUse, perHour } = deepgramServer(address);
  return { ...service, recipient, dataUse, perHour };
}

/**
 * A service chosen from the picker's foot: what it is, its key (and Deepgram's server), and where
 * the audio goes and what an hour costs above Use this, which keeps the key and chooses the service.
 */
function TranscriptionSetUp({
  service,
  onDone,
}: {
  service: TranscriptionServiceStatus;
  onDone(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const updateSettings = useAppStore((state) => state.updateSettings);
  const name = t(ROUTE_LABELS[service.route]);
  const consent = (typed: string) => {
    const shown = asTyped(service, typed);
    return (
      <div data-testid="transcription-set-up-consent" className="flex flex-col gap-0.5">
        <CloudLine service={shown} className={consentClass} />
        <p className={`${consentClass} tabular-nums`}>
          {shown.perHour.amount === 0
            ? t("meetings.setUp.ownServer")
            : t("meetings.route.perHourFirst", { price: formatMoney(shown.perHour, language) })}
        </p>
        <LanguagesLine service={shown} className={consentClass} />
      </div>
    );
  };
  return (
    <div data-testid="transcription-set-up" className="flex flex-col gap-2">
      <p data-testid="transcription-set-up-line" className={`${hintClass} mt-0`}>
        {joinMeta([
          t("meetings.setUp.line", { provider: name }),
          service.liveSpeakers ? t("meetings.route.speakers") : "",
        ])}
      </p>
      <TranscriptionKeyForm
        service={service}
        choosing={{
          consent,
          choose: async () => {
            await updateSettings({ device: { transcriptionRoute: service.route } });
            return useAppStore.getState().settings?.device.transcriptionRoute === service.route;
          },
        }}
        onSaved={({ chosen }) => {
          if (chosen) onDone();
        }}
        onCancel={onDone}
      />
    </div>
  );
}
