import { useT } from "../../i18n";
import { turnOffLocalMode } from "../../localMode";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { MODELS_UNDO_PLACE } from "./shared";

export function LocalModeUnavailable({ className }: { className?: string }) {
  const t = useT();
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  if (!localMode) return null;
  return (
    <ProblemLine
      role="status"
      testId="local-mode-unavailable"
      {...(className && { className })}
      action={{
        label: t("localMode.turnOff"),
        testId: "local-mode-turn-off",
        onClick: () =>
          turnOffLocalMode(MODELS_UNDO_PLACE).catch((error: unknown) =>
            useAppStore.getState().reportError(error),
          ),
      }}
    >
      {t("composer.model.localModeOff")}
    </ProblemLine>
  );
}
