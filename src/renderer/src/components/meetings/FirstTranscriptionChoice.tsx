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
import { KeysStay, SetupChoice, WorksRow } from "../firstRun/SetupPanel";
import { StepKeyField, useStepKey } from "../firstRun/StepKey";
import { ReadProblem } from "../ReadProblem";
import { fieldClass, fieldLabelClass } from "../ui";
import { CloudLine } from "./CloudLine";

const lineClass = "text-[12px] leading-5 text-ink-meta";

/**
 * Where meeting audio is turned into text, for a User who hasn't chosen yet: first run's last
 * step (#3296) and the first recording's sheet of a User who skipped it (#3305). A cloud service
 * leads, on a key the User already has where it transcribes, else on a service whose key is asked
 * for in place, with where the audio goes and what an hour costs above the press that finishes.
 * `finish` checks and keeps the key and chooses the service: that press is the consent to send it
 * the audio (ADR-0022), so nothing is chosen before it. This computer is last.
 */
export function useFirstTranscriptionChoice() {
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const read = useTranscriptionServicesRead();
  const services = read.state === "ready" ? read.data : [];
  const works = (each: TranscriptionServiceStatus) => each.hasKey && !each.refused;
  const withKey = services.find((each) => each.key === "provider" && works(each));
  const ownKeyed = services.filter((each) => each.key === "own");
  const [choice, setChoice] = useState<"cloud" | "local">(localOnly ? "local" : "cloud");
  const [picked, setPicked] = useState<CloudTranscriptionRoute | null>(null);
  const [saving, setSaving] = useState(false);
  const step = useStepKey();
  const shown = localOnly ? "local" : choice;
  const service =
    withKey ??
    ownKeyed.find((each) => each.route === picked) ??
    ownKeyed.find(works) ??
    ownKeyed[0];
  const working = service !== undefined && works(service);
  const asksKey = shown === "cloud" && service !== undefined && !working;
  const route: TranscriptionRoute | null =
    shown === "local" ? "local" : working && service ? service.route : null;
  const ready = asksKey ? step.typed : route !== null;

  const choose = async (chosen: TranscriptionRoute) => {
    await updateSettings({ device: { transcriptionRoute: chosen } });
    return useAppStore.getState().settings?.device.transcriptionRoute === chosen;
  };

  /** Whether the choice was kept: false while nothing is ready, or where a line says why not. */
  const finish = async (): Promise<boolean> => {
    if (!ready || saving || step.busy) return false;
    if (asksKey && service) {
      return step.save(async () => {
        await useTranscriptionServices.getState().setKey(service.route, step.key.text);
        // The choice's own failure is told where it happened.
        return (await choose(service.route)) ? null : "";
      });
    }
    if (!route) return false;
    setSaving(true);
    try {
      return await choose(route);
    } finally {
      setSaving(false);
    }
  };

  return {
    localOnly,
    read,
    withKey,
    ownKeyed,
    shown,
    service,
    working,
    step,
    ready,
    busy: saving || step.busy,
    setChoice,
    pick: (route: string) => {
      setPicked(ownKeyed.find((each) => each.route === route)?.route ?? null);
      step.reset();
    },
    finish,
  };
}

export type FirstTranscriptionChoice = ReturnType<typeof useFirstTranscriptionChoice>;

/** The two choices, and under a cloud service its key and where the audio goes. */
export function FirstTranscriptionChoiceFields({
  setup,
  onEnter,
}: {
  setup: FirstTranscriptionChoice;
  onEnter(): void;
}) {
  const t = useT();
  const id = useId();
  const { localOnly, read, withKey, ownKeyed, shown, service, working, step } = setup;
  return (
    <>
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
            onChange={() => setup.setChoice("cloud")}
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
          onChange={() => setup.setChoice("local")}
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
                onChange={(event) => setup.pick(event.target.value)}
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
                onEnter={onEnter}
              />
              <div className="flex flex-col gap-1">
                <KeysStay />
                <AudioGoes service={service} />
              </div>
            </>
          )}
        </div>
      )}
    </>
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
