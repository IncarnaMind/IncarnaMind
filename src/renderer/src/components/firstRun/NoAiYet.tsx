import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { buttonStyle } from "../ui";

/**
 * Settings › AI with no account or key (#3296): what is missing, in one line, with the two ways to
 * add it, under the page's lede.
 */
export function NoAiYet({ onAdd }: { onAdd(): void }) {
  const t = useT();
  const openSetup = useAppStore((state) => state.openSetup);
  return (
    <section
      data-testid="ai-none"
      aria-labelledby="ai-none-title"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[10px] py-3.5 pr-3.5 pl-4 shadow-[inset_0_0_0_1px_var(--color-rule-strong)]"
    >
      <div className="flex min-w-0 flex-[1_1_180px] flex-col">
        <h3 id="ai-none-title" className="text-ui font-semibold text-ink">
          {t("setupPage.empty.title")}
        </h3>
        <p className="text-[13px] leading-5 text-ink-secondary">{t("setupPage.empty.line")}</p>
      </div>
      <div data-testid="ai-none-actions" className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="ai-none-step-by-step"
          onClick={openSetup}
          className={buttonStyle("secondary", "md")}
        >
          {t("setupPage.stepByStep")}
        </button>
        <button
          type="button"
          data-testid="ai-none-add"
          onClick={onAdd}
          className={buttonStyle("primary", "md")}
        >
          {t("ai.accounts.add")}
        </button>
      </div>
    </section>
  );
}

/** Once a model is set up: the setup's model steps again, quietly. */
export function SetUpAgain() {
  const t = useT();
  const openSetup = useAppStore((state) => state.openSetup);
  return (
    <div className="px-4">
      <button
        type="button"
        data-testid="ai-set-up-again"
        onClick={openSetup}
        className="rounded-sm text-[13px] leading-5 font-semibold text-accent-strong underline-offset-2 hover:underline"
      >
        {t("setupPage.again")}
      </button>
    </div>
  );
}
