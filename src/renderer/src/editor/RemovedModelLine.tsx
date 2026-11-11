import type * as Y from "yjs";
import { setMindModel } from "../../../shared/mindModel";
import { ProblemLine } from "../components/ProblemLine";
import { useT } from "../i18n";
import { useRemovedModel } from "../modelInUse";
import { requestModelMenu } from "../modelMenu";
import { useModelNames } from "../modelNames";

/**
 * Says once, under the composer's chip, that the Note's own model was removed and its requests go
 * to the Answers default now (#2853). Change opens the chip's menu; Close, like picking a model,
 * leaves the Note with no pick of its own to lose, so the line never comes back for it.
 */
export function RemovedModelLine({ doc }: { doc: Y.Doc }) {
  const t = useT();
  const nameOf = useModelNames();
  const gone = useRemovedModel(doc);
  if (!gone) return null;
  const { removed, now } = gone;
  return (
    <ProblemLine
      role="status"
      testId="composer-model-removed"
      className="composer-model-removed"
      action={{
        label: t("composer.model.removed.change"),
        ariaLabel: t("command.model.changeRemoved"),
        testId: "composer-model-removed-change",
        onClick: requestModelMenu,
      }}
      also={{
        label: t("composer.paste.close"),
        testId: "composer-model-removed-close",
        onClick: () => setMindModel(doc, null),
      }}
    >
      {t("composer.model.removed", {
        model: nameOf(removed.modelId, removed.providerId).name,
        default: nameOf(now.modelId, now.providerId).name,
      })}
    </ProblemLine>
  );
}
