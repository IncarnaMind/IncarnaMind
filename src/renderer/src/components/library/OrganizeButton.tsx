import type { ReactNode } from "react";
import type { AgentPairing, OrganizeTarget } from "../../../../core/api";
import { useT } from "../../i18n";
import { askToOrganize, organizeTarget } from "../../organizeDocuments";
import { useAppStore } from "../../store";
import { useOrganizeAgents } from "../../useOrganizeAgents";
import { OtherAgents } from "../AskAgentLine";

export function OrganizeButton({
  target,
  testId,
  disabled,
  className,
  children,
}: {
  target: OrganizeTarget;
  testId: string;
  disabled?: boolean;
  className: string;
  children: ReactNode;
}) {
  const t = useT();
  const [first, ...others] = useOrganizeAgents(target)?.eligible ?? [];
  const ask = (agent: AgentPairing) => {
    void askToOrganize(agent, target);
  };
  const label = (agent: string) => t("library.organize.withAgent", { agent });
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        title={t("library.organize.explain")}
        disabled={disabled}
        onClick={() =>
          first ? ask(first) : void organizeTarget(target).catch(useAppStore.getState().reportError)
        }
        className={className}
      >
        {first ? label(first.name) : children}
      </button>
      {!disabled && others.length > 0 && (
        <OtherAgents agents={others} label={label} onAsk={ask} testId={testId} />
      )}
    </>
  );
}
