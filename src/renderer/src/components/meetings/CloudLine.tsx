import type { TranscriptionServiceStatus } from "../../../../core/api";
import { useGap, useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";

/**
 * Where meeting audio goes while a cloud service transcribes it, naming who gets it and the words
 * to know that go with it, and what the service's own agreement says about that audio where we
 * have checked one: choosing it is the consent (ADR-0022). A route chosen before the words were
 * sent gets the audio alone, and says so, until the User sends them too (#1031). With Local mode on
 * nothing goes, so every page that shows it says the route is paused instead (#2913).
 */
export function CloudLine({
  service,
  className,
  testId,
}: {
  service: TranscriptionServiceStatus;
  className?: string;
  testId?: string;
}) {
  const t = useT();
  const gap = useGap();
  const words = useLanguage() === "zh-CN" ? "zh" : "en";
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  if (localMode) {
    return (
      <p data-testid={testId} className={className}>
        {t("meetings.route.paused")}
      </p>
    );
  }
  const provider = service.recipient[words];
  const sentence = service.wordsWaiting
    ? t("meetings.route.cloudLineAudio", { provider })
    : t("meetings.route.cloudLine", { provider });
  const summary = service.dataUse?.summary[words];
  const link = `${t("meetings.route.agreement")} ↗`;
  return (
    <p data-testid={testId} className={className}>
      {sentence}
      {summary && (
        <>
          {gap(sentence, summary)}
          {summary}
          {gap(summary, link)}
          <a
            href={service.dataUse?.url[words]}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-rule-strong underline-offset-2 hover:text-ink"
          >
            {link}
          </a>
        </>
      )}
    </p>
  );
}
