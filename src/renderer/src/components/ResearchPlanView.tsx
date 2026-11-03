import { useEffect, useState } from "react";
import type { ResearchPlanView as Plan, Task } from "../../../core/api";
import { mindName } from "../../../shared/naming";
import { core } from "../core";
import { useT } from "../i18n";
import { closePlanView } from "../research";
import { useAppStore } from "../store";
import { CheckLineIcon, SearchLineIcon } from "./lineIcons";
import { buttonStyle } from "./ui";

/** The plan, asked again as the Task moves on; done, it stays as it ran. */
function usePlan(task: Task): Plan | null {
  const [plan, setPlan] = useState<Plan | null>(null);
  const report = useAppStore((state) => state.reportError);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again as it moves on.
  useEffect(() => {
    let current = true;
    core.getResearchPlan(task.id).then((each) => {
      if (current) setPlan(each);
    }, report);
    return () => {
      current = false;
    };
  }, [task.id, task.stepCount, task.updatedAt, report]);
  return plan;
}

function StepMark({
  status,
  number,
  live,
}: {
  status: Plan["steps"][number]["status"];
  number: number;
  live: boolean;
}) {
  if (status === "done")
    return <CheckLineIcon aria-hidden="true" className="task-progress-check" />;
  if (status === "running") {
    return (
      <span aria-hidden="true" className="task-progress-mark">
        <span className={live ? "task-dot" : "task-dot task-dot--idle"} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span aria-hidden="true" className="task-progress-mark task-progress-mark--failed">
        !
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="research-plan-number">
      {number}.
    </span>
  );
}

/**
 * A running Research's plan (Plan in its progress), in the tray where its
 * plan card was: its steps, each with how far it is, the sources and where
 * it writes. It can't be edited once started; Tell it… changes what comes
 * next. Close or Esc puts it away.
 */
export function ResearchPlanView({ task }: { task: Task }) {
  const t = useT();
  const plan = usePlan(task);
  const mind = useAppStore((state) =>
    plan?.writeInto ? state.minds.find((each) => each.id === plan.writeInto) : undefined,
  );
  if (!plan || !task.mindId) return null;
  const mindId = task.mindId;
  const sources = [
    ...(plan.sources.web ? [t("research.plan.web")] : []),
    ...(plan.sources.library ? [t("research.plan.library")] : []),
  ].join(" · ");
  return (
    <section
      data-testid="research-plan-view"
      aria-label={t("research.plan.view")}
      className="research-plan"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closePlanView(mindId);
      }}
    >
      <div className="research-plan-body">
        <p className="research-plan-kind">
          <SearchLineIcon aria-hidden="true" className="size-3.5" />
          {t("research.plan.heading")}
        </p>
        <p className="research-plan-title">{plan.title}</p>
        <ol className="research-plan-steps">
          {plan.steps.map((step, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a step is its place in the plan.
              key={index}
              data-testid="research-plan-view-step"
              data-status={step.status}
              className="research-plan-step research-plan-step--fixed"
            >
              <StepMark
                status={step.status}
                number={index + 1}
                live={task.status === "running" && task.ask === null}
              />
              <span className="research-plan-fixed research-plan-fixed--ink">{step.text}</span>
            </li>
          ))}
        </ol>
        <div className="research-plan-row">
          <span className="research-plan-label">{t("research.plan.sources")}</span>
          <span>{sources}</span>
        </div>
        <div className="research-plan-row">
          <span className="research-plan-label">{t("research.plan.writeInto")}</span>
          <span className="research-plan-view-mind">
            {plan.writeInto === null
              ? t("research.plan.newMind")
              : (mind && mindName(mind)) || t("mind.untitled")}
          </span>
        </div>
      </div>
      <div className="research-plan-foot">
        <span className="research-plan-estimate" />
        <button
          type="button"
          // biome-ignore lint/a11y/noAutofocus: opened by the User's Plan, so Esc puts it away.
          autoFocus
          data-testid="research-plan-view-close"
          onClick={() => closePlanView(mindId)}
          className={buttonStyle("ghost", "sm")}
        >
          {t("research.plan.close")}
        </button>
      </div>
    </section>
  );
}
