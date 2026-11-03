import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ProblemLine } from "../ProblemLine";
import { useTaggingService } from "../useTaggingService";

/**
 * Said once, where the Documents are (#1617): automatic tagging and sorting went off for a cloud
 * model, since it sent each Document's name and an excerpt. The way back is one click away.
 */
export function AutomaticOffNotice() {
  const t = useT();
  const shown = useAppStore((state) => state.library?.automaticOffNotice === true);
  const sent = useTaggingService("tagging", shown);
  if (!shown || sent.route.where !== "cloud") return null;
  const close = () =>
    core.dismissAutomaticOffNotice().catch((error: unknown) => {
      useAppStore.getState().reportError(error);
    });
  return (
    <ProblemLine
      role="status"
      testId="library-automatic-off"
      className="mt-1"
      action={{
        label: t("library.automaticOff.turnOn"),
        testId: "library-automatic-off-settings",
        onClick: () => {
          void close();
          useAppStore.getState().openSettings("models", "tagging");
        },
      }}
      also={{
        label: t("library.automaticOff.dismiss"),
        testId: "library-automatic-off-dismiss",
        onClick: () => void close(),
      }}
    >
      {t("library.automaticOff", { service: sent.route.service.name })}
    </ProblemLine>
  );
}
