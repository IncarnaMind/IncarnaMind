import type { TranscriptionServiceStatus } from "../../../../core/api";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ROUTE_LABELS, type ServicesView, serviceMeta } from "../../transcriptionServices";
import { ReadProblem } from "../ReadProblem";
import { CloudLine } from "./CloudLine";
import { LanguagesLine } from "./LanguagesLine";

/**
 * Under "Transcribe on" in Settings › Meetings (#141): the line describes the route chosen — this
 * computer, whatever cloud keys exist (#2661), or the cloud service, where its audio goes and what
 * it costs, or that Local mode holds it back. A cloud route the list can't name yet says what
 * choosing one sends, so the choice is the consent (ADR-0022).
 */
export function TranscriptionRouteLine({ id, read }: { id?: string; read: ServicesView }) {
  const t = useT();
  const language = useLanguage();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? "local";
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  // A list that couldn't be read says nothing of where the audio goes: the saved route stands.
  if (read.state === "failed") {
    return (
      <div id={id} data-read-host>
        <ReadProblem
          words={t("setup.services.failed")}
          read={read}
          testId="meetings-route-problem"
        />
      </div>
    );
  }
  const services = read.state === "ready" ? read.data : [];
  const service = services.find((each) => each.route === route);
  if (!service) {
    return (
      <p id={id} data-testid="meetings-route-line">
        {chooseAgainLine(services, t, language) ??
          t(route === "local" ? "meetings.route.hereLine" : "meetings.route.consent")}
      </p>
    );
  }
  return (
    <div id={id} data-testid="meetings-route-line" className="flex flex-col gap-0.5">
      <p className="tabular-nums">{serviceMeta(service, t, language)}</p>
      {localMode ? <p>{t("meetings.route.paused")}</p> : <CloudLine service={service} />}
      <LanguagesLine service={service} />
    </div>
  );
}

/**
 * Where a job list offers the Meetings choice (first run, Settings › Models): before a cloud
 * service is chosen, what choosing one sends, so the choice is the consent (ADR-0022); after,
 * where the audio goes. Nothing while no service has a key, as nothing else is offered.
 */
export function TranscriptionRouteConsent({ read }: { read: ServicesView }) {
  const t = useT();
  const language = useLanguage();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? "local";
  if (read.state === "failed") {
    return (
      <div data-read-host>
        <ReadProblem
          words={t("setup.services.failed")}
          read={read}
          testId="meetings-route-problem"
        />
      </div>
    );
  }
  const services = read.state === "ready" ? read.data : [];
  const service = services.find((each) => each.route === route);
  if (!service && !services.some((each) => each.hasKey)) return null;
  if (!service) {
    return (
      <p data-testid="meetings-route-consent" className="text-[12px] leading-5 text-ink-meta">
        {chooseAgainLine(services, t, language) ?? t("meetings.route.consent")}
      </p>
    );
  }
  return (
    <>
      <CloudLine
        service={service}
        testId="meetings-route-consent"
        className="text-[12px] leading-5 text-ink-meta"
      />
      <LanguagesLine service={service} className="text-[12px] leading-5 text-ink-meta" />
    </>
  );
}

function chooseAgainLine(
  services: readonly TranscriptionServiceStatus[],
  t: ReturnType<typeof useT>,
  language: ReturnType<typeof useLanguage>,
): string | null {
  const service = services.find((each) => each.chooseAgain);
  if (!service) return null;
  const words = language === "zh-CN" ? "zh" : "en";
  return t("meetings.route.chooseAgain", {
    provider: t(ROUTE_LABELS[service.route]),
    region: (service.region ?? service.recipient)[words],
  });
}
