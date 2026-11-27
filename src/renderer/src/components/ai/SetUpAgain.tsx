import { useT } from "../../i18n";
import { useAppStore } from "../../store";

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
        className="rounded-sm text-ui leading-5 text-accent-strong underline-offset-2 hover:underline"
      >
        {t("setupPage.again")}
      </button>
    </div>
  );
}
