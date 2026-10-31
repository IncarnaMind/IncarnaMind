import { useT } from "../../i18n";
import { openSetupSteps } from "../../modelSetup";

/**
 * What is still to set up after a model works — meeting transcription and sorting — as one quiet
 * line above the composer (#2310). While it waits, the composer and ⌘J keep their place; opening
 * it shows the steps in the composer's slot, and Set up later gives it back. The line goes once
 * they are done or put off.
 */
export function SetupLine() {
  const t = useT();
  return (
    <p className="assistant-setup-line">
      <button
        type="button"
        data-testid="assistant-setup-line"
        onClick={openSetupSteps}
        className="rounded-sm text-left underline-offset-2 hover:text-ink hover:underline focus-visible:outline-offset-0"
      >
        {t("setup.steps.line")}
      </button>
    </p>
  );
}
