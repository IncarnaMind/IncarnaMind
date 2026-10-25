import { useEffect, useState } from "react";
import type { AiUseCleared } from "../../../core/api";
import { core } from "../core";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { buttonStyle, rowStatusClass, rowTextClass, sectionTitleClass } from "./ui";

const reportError = (failure: unknown) => useAppStore.getState().reportError(failure);

/**
 * Settings → Privacy: the record of AI use stays on this computer (#292). One
 * line saying so, how many entries it holds, and Clear, which happens at once
 * and offers Undo here, beside the button, since the sidebar's undo line is
 * behind this dialog.
 */
export function AiUseSettings() {
  const t = useT();
  const [entries, setEntries] = useState<number | null>(null);
  const [cleared, setCleared] = useState<AiUseCleared | null>(null);

  useEffect(() => {
    core.getAiUseStatus().then((status) => setEntries(status.entries), reportError);
    return core.on("aiUse.changed", (status) => setEntries(status.entries));
  }, []);

  const clear = async () => {
    try {
      const result = await core.clearAiUse();
      setCleared(result.count > 0 ? result : null);
    } catch (failure) {
      reportError(failure);
    }
  };
  const undo = async () => {
    if (!cleared) return;
    setCleared(null);
    try {
      await core.restoreAiUse(cleared.clearedAt);
    } catch (failure) {
      reportError(failure);
    }
  };

  return (
    <section data-testid="ai-use-record" className="flex flex-col">
      <h4 className={sectionTitleClass}>{t("privacy.aiUse.title")}</h4>
      <p className={`mt-0.5 ${rowTextClass}`}>{t("privacy.aiUse.body")}</p>
      <p className={rowTextClass}>{t("privacy.aiUse.private")}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
        <span data-testid="ai-use-entries" className={rowStatusClass}>
          {t("privacy.aiUse.entries", { count: entries ?? 0 })}
        </span>
        <button
          type="button"
          data-testid="ai-use-clear"
          disabled={!entries}
          onClick={() => void clear()}
          className={buttonStyle("secondary", "sm")}
        >
          {t("privacy.aiUse.clear")}
        </button>
        {cleared && (
          <span role="status" className="flex items-center gap-2">
            <span data-testid="ai-use-cleared" className={rowStatusClass}>
              {t("privacy.aiUse.cleared")}
            </span>
            <button
              type="button"
              data-testid="ai-use-undo"
              onClick={() => void undo()}
              className="rounded-sm px-1 text-[13px] leading-5 font-semibold text-accent hover:underline"
            >
              {t("move.undo")}
            </button>
          </span>
        )}
      </div>
    </section>
  );
}
