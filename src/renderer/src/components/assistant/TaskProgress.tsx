import { Fragment, type ReactNode, useEffect, useId, useState } from "react";
import type { Task, TaskStep } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import type { CommandId } from "../../../../shared/commands";
import { formatDateTime } from "../../../../shared/dates";
import { RESEARCH_TASK } from "../../../../shared/research";
import { shortcutLabel } from "../../commands/keymap";
import { core } from "../../core";
import { formatMoney } from "../../cost";
import { withShortcut } from "../../editor/withShortcut";
import { useLanguage, useT } from "../../i18n";
import type { Translate } from "../../objects";
import { useAppStore } from "../../store";
import { taskOffers } from "../../taskActions";
import { needsYou } from "../../taskGroups";
import { pauseTask, resumeTask, reviewTask, stopTask, useTasks } from "../../tasks";
import { failedLine, stepLine, taskName } from "../../taskText";
import { CheckLineIcon } from "../lineIcons";
import { MetaLine } from "../MetaLine";

/**
 * What a Task's progress offers that its kind brings (#130's plan card, and
 * its messages through Tell it…): the plan and the composer's Task target
 * live there. Pause, Resume and Stop are every Task's, handled here.
 */
export interface TaskProgressActions {
  plan?(task: Task): void;
  tell?(task: Task): void;
}

/** The minutes since `since`, rounded, at least 1, as of the minute shown. */
function useMinutes(since: string, until: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [until]);
  const end = until ? new Date(until).getTime() : now;
  return Math.max(1, Math.round((end - new Date(since).getTime()) / 60_000));
}

/** Its head's right side: how far it is and for how long, or how it ended. */
function headLine(task: Task, minutes: number, t: Translate): string[] {
  const time = t("task.minutes", { count: minutes });
  if (task.status === "done") return [t("task.progress.doneIn", { time })];
  if (task.status === "failed") return [failedLine(task, t)];
  if (task.status === "stopped") return [t("task.status.stopped")];
  const progress = task.progress;
  if (!progress || progress.total === 0) return [time];
  const counted = t(
    task.kind === "comparison"
      ? "task.progress.cells"
      : task.kind === RESEARCH_TASK
        ? "task.progress.steps"
        : "task.progress.items",
    { done: progress.done, total: progress.total },
  );
  return [counted, time];
}

/** What it waits for, where the step it is on would be: the User below, or a limit. */
function waitingLine(task: Task, t: Translate, language: Language): string | null {
  if (task.finishedAt !== null) return null;
  if (task.ask) {
    if (task.pausedReason === "closed") return t("task.thread.pausedClosed");
    return task.ask.kind === "approval"
      ? t("task.thread.waitingApproval")
      : t("task.thread.needsYou");
  }
  return task.status === "paused" ? stepLine(task, t, language) : null;
}

function details(task: Task, t: Translate, language: Language): string[] {
  const parts: string[] = [];
  if (task.kind === "comparison" && task.progress) {
    parts.push(t("task.details.cells", { done: task.progress.done, total: task.progress.total }));
  }
  parts.push(t("task.details.started", { time: formatDateTime(task.startedAt, language) }));
  if (task.cost) parts.push(t("task.details.cost", { cost: formatMoney(task.cost, language) }));
  return parts;
}

function StepMark({ step, live }: { step: TaskStep; live: boolean }) {
  switch (step.status) {
    case "done":
      return <CheckLineIcon aria-hidden="true" className="task-progress-check" />;
    case "failed":
      return (
        <span aria-hidden="true" className="task-progress-mark task-progress-mark--failed">
          !
        </span>
      );
    case "skipped":
      return (
        <span aria-hidden="true" className="task-progress-mark">
          –
        </span>
      );
    case "running":
      return (
        <span aria-hidden="true" className="task-progress-mark">
          <span className={live ? "task-dot" : "task-dot task-dot--idle"} />
        </span>
      );
  }
}

function stepText(step: TaskStep, t: Translate): string {
  if (step.status === "failed") return t("task.progress.stepFailed", { step: step.text });
  if (step.status === "skipped") return t("task.progress.stepSkipped", { step: step.text });
  return step.text;
}

/** Every step, once asked for, as it goes on. */
function useAllSteps(task: Task, wanted: boolean): readonly TaskStep[] | null {
  const [all, setAll] = useState<readonly TaskStep[] | null>(null);
  const report = useAppStore((state) => state.reportError);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again as it moves on.
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    core.listTaskSteps(task.id).then((steps) => {
      if (current) setAll(steps);
    }, report);
    return () => {
      current = false;
    };
  }, [wanted, task.id, task.stepCount, task.updatedAt, report]);
  return wanted ? all : null;
}

/**
 * A Task's progress in the thread (#657; DESIGN.md, Task progress in the
 * thread; the boards Tasks-*), where it started, as an Answer shows its
 * steps: the live dot and its name, how far it is; a 3px bar; "Show all N
 * steps"; its latest steps, ✓ when done and a dot on the one it is on; then
 * what its kind lets the User do (Plan · Tell it… · Pause · Stop). Done, it
 * says how long it took, and offers Plan (a Research's steps it ran), Review
 * and Details; Stop names the keys that do it.
 */
export function TaskProgress({
  task,
  actions = {},
}: {
  task: Task;
  actions?: TaskProgressActions;
}) {
  const t = useT();
  const language = useLanguage();
  const openSettings = useAppStore((state) => state.openSettings);
  const shown = useTasks((state) => state.shown === task.id);
  const [allWanted, setAllWanted] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const finished = task.finishedAt !== null;
  const minutes = useMinutes(task.startedAt, task.finishedAt);
  const all = useAllSteps(task, allWanted || detailsOpen);
  const waiting = waitingLine(task, t, language);
  // What it waits for takes the place of the step it is on.
  const steps = (all ?? task.steps).filter((step) => !waiting || step.status !== "running");
  const hidden = task.stepCount - task.steps.length;
  const live = task.status === "running" && task.ask === null;
  const name = taskName(task, t);
  const percent =
    task.progress && task.progress.total > 0
      ? Math.round((task.progress.done / task.progress.total) * 100)
      : 0;

  /** Its actions, in the design's order; Pause and Resume are one place, so the focus stays on it. */
  const offered: {
    key: string;
    testId: string;
    label: string;
    onClick(): void;
    strong?: boolean;
    /** The keys that do the same, for the tooltip. */
    shortcut?: CommandId;
  }[] = [];
  const offer = (key: string, label: string, onClick: () => void, testId = key) =>
    offered.push({ key, testId, label, onClick });
  const has = (action: Task["actions"][number]) => task.actions.includes(action);
  if (finished) {
    // Its plan stays: a finished Research shows the steps it ran.
    if (has("plan") && actions.plan) {
      const showPlan = actions.plan;
      offer("plan", t("task.action.plan"), () => showPlan(task));
    }
    if (task.status === "done") {
      offered.push({
        key: "review",
        testId: "review",
        label: t("task.action.review"),
        onClick: () => reviewTask(task),
        strong: true,
      });
    }
    offer("details", t("task.action.details"), () => setDetailsOpen(!detailsOpen));
  } else {
    const { plan, tell } = actions;
    if (has("plan") && plan) offer("plan", t("task.action.plan"), () => plan(task));
    if (has("tell") && tell && live) offer("tell", t("task.action.tell"), () => tell(task));
    if (task.status === "paused" && task.pausedReason === "cost-cap") {
      offer("cap", t("answer.error.changeCap"), () => openSettings("general"));
    }
    if (taskOffers(task, "pause")) {
      offer("pause", t("task.pause"), () => void pauseTask(task.id));
    }
    if (taskOffers(task, "resume")) {
      offer("pause", t("task.resume"), () => void resumeTask(task.id), "resume");
    }
    if (taskOffers(task, "stop")) {
      offered.push({
        key: "stop",
        testId: "stop",
        label: t("task.stop"),
        onClick: () => void stopTask(task.id),
        shortcut: "task.stop",
      });
    }
  }

  return (
    <section
      aria-label={t("task.progress.label", { task: name })}
      data-testid="task-progress"
      data-task={task.id}
      data-status={task.status}
      data-needs-you={needsYou(task) || undefined}
      data-shown={shown || undefined}
      className="task-progress"
    >
      <div className="task-progress-head">
        {task.status === "done" ? (
          <CheckLineIcon aria-hidden="true" className="task-progress-check" />
        ) : (
          <span aria-hidden="true" className="task-progress-mark">
            <span
              className={
                needsYou(task)
                  ? "task-dot task-dot--attention"
                  : live
                    ? "task-dot"
                    : "task-dot task-dot--idle"
              }
            />
          </span>
        )}
        <span className="task-progress-name">{name}</span>
        <MetaLine
          as="div"
          data-testid="task-progress-meta"
          className="task-progress-meta"
          parts={headLine(task, minutes, t)}
        />
      </div>
      {!finished && (
        <div
          role="progressbar"
          aria-label={t("task.progress.label", { task: name })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="task-progress-bar"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      {hidden > 0 && !detailsOpen && (
        <button
          type="button"
          data-testid="task-progress-all"
          aria-expanded={allWanted}
          onClick={() => setAllWanted(!allWanted)}
          className="task-progress-more"
        >
          {allWanted
            ? t("task.progress.showFewer")
            : t("task.progress.showAll", { count: task.stepCount })}
        </button>
      )}
      <ol data-testid="task-progress-steps" className="task-progress-steps">
        {steps.map((step) => (
          <li key={step.key} data-status={step.status} className="task-progress-step">
            <StepMark step={step} live={live} />
            <span>{stepText(step, t)}</span>
          </li>
        ))}
        {waiting && (
          <li data-testid="task-progress-waiting" className="task-progress-step">
            <span aria-hidden="true" className="task-progress-mark">
              <span
                className={
                  needsYou(task) ? "task-dot task-dot--attention" : "task-dot task-dot--idle"
                }
              />
            </span>
            <span>{waiting}</span>
          </li>
        )}
      </ol>
      {task.remaining.length > 0 && (
        <div data-testid="task-progress-remaining" className="task-progress-remaining">
          <p className="task-progress-remaining-label">{t("task.progress.remaining")}</p>
          <ul className="task-progress-steps">
            {task.remaining.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: what is left, in its order.
              <li key={index} className="task-progress-step">
                <span aria-hidden="true" className="task-progress-mark">
                  –
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {detailsOpen && (
        <MetaLine
          id={detailsId}
          data-testid="task-progress-record"
          className="task-progress-details"
          parts={details(task, t, language)}
        />
      )}
      <div data-testid="task-progress-actions" className="task-progress-actions">
        {task.summary && (
          <span data-testid="task-progress-summary" className="task-progress-summary">
            {task.summary}
          </span>
        )}
        {offered.map((action, index) => (
          <Fragment key={action.key}>
            {(index > 0 || task.summary) && <Dot />}
            <button
              type="button"
              data-testid={`task-progress-${action.testId}`}
              aria-expanded={action.key === "details" ? detailsOpen : undefined}
              aria-controls={action.key === "details" && detailsOpen ? detailsId : undefined}
              onClick={action.onClick}
              className={
                action.strong
                  ? "task-progress-action task-progress-action--strong"
                  : "task-progress-action"
              }
              {...withShortcut(
                action.label,
                action.shortcut ? shortcutLabel(action.shortcut) : undefined,
              )}
            >
              {action.label}
            </button>
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function Dot(): ReactNode {
  return (
    <span aria-hidden="true" className="task-progress-dot">
      ·
    </span>
  );
}
