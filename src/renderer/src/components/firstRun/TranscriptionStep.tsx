import { useId, useState } from "react";
import type { CloudTranscriptionRoute, TranscriptionRoute } from "../../../../core/api";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ROUTE_LABELS, useTranscriptionServicesRead } from "../../transcriptionServices";
import { CloudLine } from "../meetings/CloudLine";
import { TranscriptionSetUp } from "../meetings/TranscriptionSetUp";
import { ReadProblem } from "../ReadProblem";
import { buttonStyle, fieldClass, fieldLabelClass, hintClass } from "../ui";
import { KeysStay, SetupChoice, SetupPanel, type StepPlace, WorksRow } from "./SetupPanel";

/**
 * The setup's last step (#3296): where meeting audio is turned into text. A cloud service leads,
 * on the key the User already added where it transcribes, else on a service whose key is asked
 * for in place, with where the audio goes and what an hour costs above its Use this; this computer
 * is last. Choosing a cloud service is the consent to send it the audio (ADR-0022). "Set up when I
 * record" leaves it to the first recording, which asks.
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
  const shown = localOnly ? "local" : choice;
  const service = withKey ?? ownKeyed.find((each) => each.route === picked) ?? ownKeyed[0];
  const working = service?.hasKey === true && !service.refused;
  const route: TranscriptionRoute | null =
    shown === "local" ? "local" : working && service ? service.route : null;

  const choose = async (chosen: TranscriptionRoute) => {
    setSaving(true);
    try {
      await updateSettings({ device: { transcriptionRoute: chosen } });
      if (useAppStore.getState().settings?.device.transcriptionRoute === chosen) place.next();
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
            className={buttonStyle("ghost", "lg")}
          >
            {t("setupPage.meetings.later")}
          </button>
          <button
            type="button"
            data-testid="setup-next"
            disabled={route === null || saving}
            onClick={() => route && void choose(route)}
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
                onChange={(event) =>
                  setPicked(
                    ownKeyed.find((each) => each.route === event.target.value)?.route ?? null,
                  )
                }
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
              <CloudLine service={service} className={`${hintClass} mt-0`} />
            </>
          ) : (
            <>
              <TranscriptionSetUp
                key={service.route}
                service={service}
                onDone={() => {
                  if (useAppStore.getState().settings?.device.transcriptionRoute === service.route)
                    place.next();
                }}
              />
              <KeysStay />
            </>
          )}
        </div>
      )}
    </SetupPanel>
  );
}
