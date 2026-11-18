import { useId, useState } from "react";
import type {
  CloudTranscriptionRoute,
  TranscriptionRoute,
  TranscriptionServiceStatus,
} from "../../../../core/api";
import { formatMoney } from "../../cost";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  ROUTE_LABELS,
  shownPerHour,
  useTranscriptionServices,
  useTranscriptionServicesRead,
} from "../../transcriptionServices";
import { CloudLine } from "../meetings/CloudLine";
import { ReadProblem } from "../ReadProblem";
import { buttonStyle, fieldClass, fieldLabelClass } from "../ui";
import { KeysStay, SetupChoice, SetupPanel, type StepPlace, WorksRow } from "./SetupPanel";
import { StepKeyField, useStepKey } from "./StepKey";

const lineClass = "text-[12px] leading-5 text-ink-meta";

/**
 * The setup's last step (#3296): where meeting audio is turned into text. A cloud service leads,
 * on the key the User already added where it transcribes, else on a service whose key is asked
 * for in place, with where the audio goes and what an hour costs above Finish, which checks and
 * keeps the key and chooses the service: that press is the consent to send it the audio
 * (ADR-0022); this computer is last. "Set up when I record" leaves it to the first recording.
 */
export function TranscriptionStep({ place }: { place: StepPlace }) {
  const t = useT();
  const id = useId();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const read = useTranscriptionServicesRead();
  const services = read.state === "ready" ? read.data : [];
  const withKey = services.find((each) => each.key === "provider" && each.hasKey && !each.refused);
  const ownKeyed = services.filter((each) => each.key === "own");
  const [choice, setChoice] = useState<"cloud" | "local">(localOnly ? "local" : "cloud");
  const [picked, setPicked] = useState<CloudTranscriptionRoute | null>(null);
  const [saving, setSaving] = useState(false);
  const step = useStepKey();
  const shown = localOnly ? "local" : choice;
  const service = withKey ?? ownKeyed.find((each) => each.route === picked) ?? ownKeyed[0];
  const working = service?.hasKey === true && !service.refused;
  const asksKey = shown === "cloud" && service !== undefined && !working;
  const route: TranscriptionRoute | null =
    shown === "local" ? "local" : working && service ? service.route : null;
  const ready = asksKey ? step.typed : route !== null;

  const choose = async (chosen: TranscriptionRoute) => {
    await updateSettings({ device: { transcriptionRoute: chosen } });
    return useAppStore.getState().settings?.device.transcriptionRoute === chosen;
  };

  const next = async () => {
    if (!ready || saving || step.busy) return;
    if (asksKey && service) {
      const kept = await step.save(async () => {
        await useTranscriptionServices.getState().setKey(service.route, step.key.text);
        // The choice's own failure is told where it happened.
        return (await choose(service.route)) ? null : "";
      });
      if (kept) place.next();
      return;
    }
    if (!route) return;
    setSaving(true);
    try {
      if (await choose(route)) place.next();
    } finally {
      setSaving(false);
    }
  };

  return (
    <SetupPanel
      place={place}
      view="meetings"
      title={t("setupPage.meetings.title")}
      lead={t("setupPage.meetings.lead")}
      foot={
        <>
          {place.back && (
            <button
              type="button"
              data-testid="setup-back"
              onClick={place.back}
              className={`-ml-2.5 ${buttonStyle("ghost", "lg")}`}
            >
              {t("setupPage.back")}
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            data-testid="setup-skip"
            onClick={place.next}
            disabled={step.busy}
            className={buttonStyle("ghost", "lg")}
          >
            {t("setupPage.meetings.later")}
          </button>
          <button
            type="button"
            data-testid="setup-next"
            disabled={!ready || saving || step.busy}
            onClick={() => void next()}
            className={buttonStyle("primary", "lg")}
          >
            {t("setupPage.finish")}
          </button>
        </>
      }
    >
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">{t("setupPage.meetings.title")}</legend>
        {!localOnly && (
          <SetupChoice
            type="radio"
            name="transcription"
            value="cloud"
            testId="setup-transcription"
            checked={shown === "cloud"}
            title={t("setupPage.meetings.cloud")}
            line={t(withKey ? "setupPage.meetings.cloud.ownKey" : "setupPage.meetings.cloud.line")}
            onChange={() => setChoice("cloud")}
          />
        )}
        <SetupChoice
          type="radio"
          name="transcription"
          value="local"
          testId="setup-transcription"
          checked={shown === "local"}
          title={t("setupPage.meetings.local")}
          line={t("setupPage.meetings.local.line")}
          onChange={() => setChoice("local")}
        />
      </fieldset>
      {shown === "cloud" && read.state === "failed" && (
        <ReadProblem
          words={t("setup.services.failed")}
          read={read}
          testId="setup-services-problem"
        />
      )}
      {shown === "cloud" && service && (
        <div data-testid="setup-cloud" className="flex flex-col gap-3">
          {!withKey && (
            <label className={`${fieldLabelClass} flex flex-col gap-1`} htmlFor={`${id}-service`}>
              <span className="font-semibold">{t("setupPage.meetings.service")}</span>
              <select
                id={`${id}-service`}
                data-testid="setup-transcription-service"
                value={service.route}
                disabled={step.busy}
                onChange={(event) => {
                  setPicked(
                    ownKeyed.find((each) => each.route === event.target.value)?.route ?? null,
                  );
                  step.reset();
                }}
                className={`${fieldClass} w-fit min-w-48`}
              >
                {ownKeyed.map((each) => (
                  <option key={each.route} value={each.route}>
                    {t(ROUTE_LABELS[each.route])}
                  </option>
                ))}
              </select>
            </label>
          )}
          {working ? (
            <>
              <WorksRow
                text={t(withKey ? "setupPage.usesKey" : "setupPage.keyWorks", {
                  provider: service.name,
                })}
                testId="setup-transcription-works"
              />
              <AudioGoes service={service} />
            </>
          ) : (
            <>
              <StepKeyField
                step={step}
                label={t("setupPage.key", { provider: t(ROUTE_LABELS[service.route]) })}
                keyUrl={service.keyUrl}
                testId="setup-transcription-key"
                onEnter={() => void next()}
              />
              <div className="flex flex-col gap-1">
                <KeysStay />
                <AudioGoes service={service} />
              </div>
            </>
          )}
        </div>
      )}
    </SetupPanel>
  );
}

/** Where the audio goes and what an hour of it costs: what choosing the service consents to. */
function AudioGoes({ service }: { service: TranscriptionServiceStatus }) {
  const t = useT();
  const language = useLanguage();
  return (
    <div data-testid="setup-transcription-sends" className="flex flex-col gap-0.5">
      <CloudLine service={service} className={lineClass} />
      <p className={`${lineClass} tabular-nums`}>
        {t("meetings.route.perHourFirst", {
          price: formatMoney(shownPerHour(service), language),
        })}
      </p>
    </div>
  );
}
