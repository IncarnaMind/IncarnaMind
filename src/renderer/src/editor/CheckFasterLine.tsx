import type { CheckDecisionStatus } from "../../../core/api";
import { MetaLine } from "../components/MetaLine";
import { LineAction } from "../components/ProblemLine";
import { Tip } from "../components/Tip";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { closeTip, TIP_SHOWS } from "../tips";

/**
 * The check card's one line about the decision model (#3118), for a User who never touched its
 * switch: a key they saved reaches it, and it reads none of their checks. It points at the switch
 * in Settings, where the line says what goes to the host, and never turns it on itself. ✕ ends it
 * for good; a User who turned the switch on or off has said, and never sees it.
 */
export function CheckFasterLine({ status }: { status: CheckDecisionStatus | null | undefined }) {
  const t = useT();
  const unsaid = useAppStore((state) => state.settings?.device.checkDecisionModel === null);
  const closed = useAppStore(
    (state) => (state.settings?.device.tips["check-faster"] ?? 0) >= TIP_SHOWS,
  );
  if (!status || !unsaid || closed || status.blocked !== null || status.reads !== null) return null;
  return (
    <div data-testid="check-faster" className="check-card-faster">
      <Tip id="check-faster" onClose={() => closeTip("check-faster")}>
        <MetaLine
          as="span"
          parts={[
            t("checkFaster.line", { model: status.model.name }),
            <LineAction
              key="settings"
              action={{
                label: t("checkFaster.settings"),
                testId: "check-faster-settings",
                onClick: () => useAppStore.getState().openSettings("ai", "check-decision"),
              }}
            />,
          ]}
        />
      </Tip>
    </div>
  );
}
