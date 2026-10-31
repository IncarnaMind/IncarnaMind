import { useLanguage, useT } from "../../i18n";
import {
  openSetupSteps,
  SETUP_STEPS,
  setupStepTitle,
  skipSetupSteps,
  useModelSetup,
} from "../../modelSetup";
import { CloseLineIcon } from "../lineIcons";

/**
 * What is still to set up after a model works, in one line just above the composer (#2310): the
 * steps left by name, Set up to open the next one, and ✕ to keep them in Settings › Models. The
 * composer and ⌘J keep their place throughout.
 */
export function SetupLine() {
  const t = useT();
  const language = useLanguage();
  const done = useModelSetup((state) => state.done);
  const remaining = SETUP_STEPS.filter((step) => done[step] === null);
  if (remaining.length === 0) return null;
  const steps = remaining
    .map((step) => t(setupStepTitle(step)))
    .join(language === "zh-CN" ? "、" : ", ");
  return (
    <p className="assistant-setup-line">
      <button
        type="button"
        data-testid="assistant-setup-line"
        onClick={openSetupSteps}
        className="rounded-sm text-left underline-offset-2 hover:text-ink hover:underline focus-visible:outline-offset-0"
      >
        {t("setup.steps.line", { count: remaining.length, steps })}
      </button>
      <button
        type="button"
        data-testid="assistant-setup-skip"
        aria-label={t("setup.steps.skip")}
        title={t("setup.steps.skip")}
        onClick={skipSetupSteps}
        className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-md text-ink-meta hover:bg-chip hover:text-ink focus-visible:outline-offset-0"
      >
        <CloseLineIcon strokeWidth={2.5} className="size-3" />
      </button>
    </p>
  );
}
