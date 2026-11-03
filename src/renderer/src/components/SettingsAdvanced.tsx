import type { ReactNode } from "react";
import { useT } from "../i18n";

/**
 * What a Settings section works with, folded away: the section says what it
 * does, and its model names and figures wait here (#763).
 */
export function SettingsAdvanced({ testId, children }: { testId: string; children: ReactNode }) {
  const t = useT();
  return (
    <details data-testid={testId} className="mt-3">
      <summary
        data-testid={`${testId}-toggle`}
        className="cursor-default text-[13px] leading-5 font-semibold text-ink-secondary select-none hover:text-ink"
      >
        {t("settings.advanced")}
      </summary>
      <div className="mt-2 flex flex-col gap-1">{children}</div>
    </details>
  );
}
