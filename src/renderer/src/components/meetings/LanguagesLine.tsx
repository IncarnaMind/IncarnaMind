import type { TranscriptionServiceStatus } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { useLanguage, useT } from "../../i18n";
import { ROUTE_LABELS } from "../../transcriptionServices";

/** A language's name in the interface's language ("Korean", "韩语"), or its code when none is known. */
function languageName(language: Language, code: string): string {
  try {
    return new Intl.DisplayNames(language, { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Where a route is chosen, and before a meeting on it: the languages the User speaks that it
 * doesn't transcribe, so what is said in them isn't lost unseen (#866). Nothing when it covers all.
 */
export function LanguagesLine({
  service,
  className,
}: {
  service: TranscriptionServiceStatus;
  className?: string;
}) {
  const t = useT();
  const language = useLanguage();
  if (service.missingLanguages.length === 0) return null;
  const names = service.missingLanguages.map((code) => languageName(language, code));
  return (
    <p data-testid={`meetings-route-languages-${service.route}`} className={className}>
      {t("meetings.route.languages", {
        provider: t(ROUTE_LABELS[service.route]),
        languages: new Intl.ListFormat(language, { type: "conjunction" }).format(names),
      })}
    </p>
  );
}
