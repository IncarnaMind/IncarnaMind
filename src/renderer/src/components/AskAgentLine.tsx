import { useEffect, useRef } from "react";
import type { AgentPairing } from "../../../core/api";
import { useT } from "../i18n";
import { ChevronDownLineIcon } from "./lineIcons";
import { MetaLine } from "./MetaLine";
import { LineAction, type ProblemAction } from "./ProblemLine";
import { menuClass, menuItemClass, menuRuleClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

/**
 * The User's own AI where IncarnaMind has no model (#3373): "Ask {agent}…", for the agent
 * connected or used last, with the others behind its ⌄, and setting up a model after it.
 */
export function AskAgentLine({
  agents,
  label,
  onAsk,
  setUp,
  testId,
  className = "",
  focusAsk = false,
}: {
  /** The one connected or used last first. */
  agents: readonly AgentPairing[];
  label(agent: string): string;
  onAsk(agent: AgentPairing): void;
  setUp: ProblemAction;
  testId: string;
  className?: string;
  /** Its Ask takes the focus as it shows: the line Enter brought, in place of the setup card. */
  focusAsk?: boolean;
}) {
  const ask = useRef<HTMLButtonElement>(null);
  const [first, ...others] = agents;
  useEffect(() => {
    if (focusAsk) ask.current?.focus();
  }, [focusAsk]);
  if (!first) return null;
  return (
    <div
      role="status"
      data-testid={testId}
      className={`font-sans text-[13px] leading-5 break-words text-ink-meta ${className}`}
    >
      <MetaLine
        as="div"
        parts={[
          <span key="ask" className="inline-flex items-center gap-0.5">
            <LineAction
              ref={ask}
              action={{
                label: label(first.name),
                testId: `${testId}-ask`,
                onClick: () => onAsk(first),
              }}
            />
            {others.length > 0 && (
              <OtherAgents agents={others} label={label} onAsk={onAsk} testId={testId} />
            )}
          </span>,
          <LineAction key="set-up" action={setUp} />,
        ]}
      />
    </div>
  );
}

/** The other agents behind a ⌄, one step away: a small menu, never a dialog; `foot` under a rule. */
export function OtherAgents({
  agents,
  label,
  onAsk,
  testId,
  className = "text-accent hover:bg-hover",
  name: named,
  foot,
}: {
  agents: readonly AgentPairing[];
  label(agent: string): string;
  onAsk(agent: AgentPairing): void;
  testId: string;
  className?: string;
  /** The ⌄'s name, where its menu holds more than agents. */
  name?: string;
  foot?: { label: string; testId: string; onClick(): void };
}) {
  const t = useT();
  const menu = usePopoverMenu({ focus: "first" });
  const name = named ?? t("agents.ask.others");
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid={`${testId}-others`}
        aria-label={name}
        title={name}
        className={`inline-flex items-center rounded-sm px-0.5 ${className}`}
      >
        <ChevronDownLineIcon className="size-3.5" />
      </button>
      <div {...menu.menuProps} role="menu" aria-label={name} className={menuClass}>
        {menu.open &&
          agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="menuitem"
              data-testid={`${testId}-other`}
              className={`${menuItemClass} pl-2`}
              onClick={() => {
                menu.close();
                onAsk(agent);
              }}
            >
              {label(agent.name)}
            </button>
          ))}
        {menu.open && foot && (
          <>
            {agents.length > 0 && <div className={menuRuleClass} />}
            <button
              type="button"
              role="menuitem"
              data-testid={foot.testId}
              className={`${menuItemClass} pl-2`}
              onClick={() => {
                menu.close();
                foot.onClick();
              }}
            >
              {foot.label}
            </button>
          </>
        )}
      </div>
    </>
  );
}
