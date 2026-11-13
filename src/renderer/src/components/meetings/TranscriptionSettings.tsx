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
 * choosing one sends, so the choice is the consent (ADR-0022); in Local mode, where nothing is
 * sent and none can be chosen, it says the route is paused (#1031).
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
    const unnamed = localMode ? "meetings.route.paused" : "meetings.route.consent";
    return (
      <p id={id} data-testid="meetings-route-line">
        {chooseAgainLine(services, t, language, localMode) ??
          t(route === "local" ? "meetings.route.hereLine" : unnamed)}
      </p>
    );
  }
  return (
    <div id={id} data-testid="meetings-route-line" className="flex flex-col gap-0.5">
      <p className="tabular-nums">{serviceMeta(service, t, language)}</p>
      <CloudLine service={service} />
      <LanguagesLine service={service} />
    </div>
  );
}

/**
 * Where Settings › AI offers the Meetings choice: before a cloud
 * service is chosen, what choosing one sends, so the choice is the consent (ADR-0022); after,
 * where the audio goes. Nothing while no service has a key, as nothing else is offered. With Local
 * mode on none can be chosen, so nothing is said of choosing one (#2913).
 */
export function TranscriptionRouteConsent({ read }: { read: ServicesView }) {
  const t = useT();
  const language = useLanguage();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? "local";
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
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
    const line =
      chooseAgainLine(services, t, language, localMode) ??
      (localMode ? null : t("meetings.route.consent"));
    if (line === null) return null;
    return (
      <p data-testid="meetings-route-consent" className="text-[12px] leading-5 text-ink-meta">
        {line}
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
  localMode: boolean,
): string | null {
  const service = services.find((each) => each.chooseAgain);
  if (!service) return null;
  // Local mode refuses the choice this line asks for, so it asks once Local mode is off (#2999).
  if (localMode) return t("meetings.route.paused");
  const words = language === "zh-CN" ? "zh" : "en";
  return t("meetings.route.chooseAgain", {
    provider: t(ROUTE_LABELS[service.route]),
    region: (service.region ?? service.recipient)[words],
  });
}
