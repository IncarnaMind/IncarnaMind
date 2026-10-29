import { isMacOS } from "@tiptap/core";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type ChatModelChoice, DEFAULT_MIND_KIND, type RunEstimate } from "../../../core/api";
import { mindName } from "../../../shared/naming";
import { MAX_RESEARCH_STEPS, researchItems, researchMinutes } from "../../../shared/research";
import { keysLabel } from "../commands/keys";
import { NO_MIND, useComposer } from "../composer";
import { core } from "../core";
import { formatMoney } from "../cost";
import { AnswerError } from "../editor/AnswerView";
import { RemoveIcon } from "../editor/icons";
import { useLanguage, useT } from "../i18n";
import { useModelInUse, useOwnModel } from "../modelInUse";
import { requestModelMenu } from "../modelMenu";
import { useModelNames } from "../modelNames";
import {
  addStep,
  type ResearchPlanCard as Card,
  cancelResearch,
  planAgain,
  removeStep,
  setStep,
  startResearch,
  stepsOf,
  updatePlan,
  useResearch,
  useWebMissing,
  useWebReach,
  type WebReach,
} from "../research";
import { useAppStore } from "../store";
import {
  CheckLineIcon,
  ChevronDownLineIcon,
  MindLineIcon,
  PlusLineIcon,
  SearchLineIcon,
} from "./lineIcons";
import { ProblemLine } from "./ProblemLine";
import { ReadinessLine } from "./providers/ChatReadinessNotice";
import { TypingTextarea } from "./TypingTextarea";
import { buttonStyle, menuClass, menuItemClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

const START_KEYS = "CmdOrCtrl+Enter";
/** The other Minds "Write into" offers, the most recently changed first. */
const OTHER_MINDS = 6;

const isCommand = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

/**
 * The Research plan card (#130; DESIGN.md, Task tray; the boards Tasks-Plan
 * and Tasks-Plan-ZH), at the top of the tray: the topic as a question, the
 * steps the model proposed, each edited in place (Enter adds one after it,
 * Backspace in an empty one takes it out), then the draft it always writes
 * last; the sources it searches; where it writes; the estimate, with the
 * composer's model; Cancel (Esc) and Start (⌘↵). It has no model chooser:
 * the composer's model chip is its model.
 */
export function ResearchPlanCard({ mindId }: { mindId: string | null }) {
  const t = useT();
  // With no Mind in focus, the plan is the composer's own until Start makes a new Mind for it.
  const key = mindId ?? NO_MIND;
  const card = useResearch((state) => state.plans[key]);
  const seat = useComposer((state) => state.seat);
  const doc = seat !== null && seat.mindId === mindId ? seat.doc : null;
  const model = useModelInUse(doc);
  const chosen = useOwnModel(doc);
  const web = useWebReach(model);
  const fields = useRef<(HTMLTextAreaElement | null)[]>([]);
  const focusStep = useRef<number | null>(null);

  // A step just added, or the one before a step taken out, takes the focus once drawn.
  useEffect(() => {
    const index = focusStep.current;
    if (index === null) return;
    focusStep.current = null;
    fields.current[index]?.focus();
  });

  if (!card) return null;
  const steps = stepsOf(card);
  const searchesWeb = card.sources.web && web === "ready";
  const blocked =
    card.planning || card.starting || steps.length === 0 || (!searchesWeb && !card.sources.library);

  const start = () => {
    if (!blocked) void startResearch(key, model);
  };
  const cancel = () => cancelResearch(key);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter" && isCommand(event)) {
      event.preventDefault();
      start();
    }
  };
  const onStepKey = (index: number) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (addStep(key, index)) focusStep.current = index + 1;
    } else if (event.key === "Backspace" && card.steps[index] === "" && card.steps.length > 1) {
      event.preventDefault();
      removeStep(key, index);
      focusStep.current = Math.max(0, index - 1);
    }
  };

  return (
    <section
      data-testid="research-plan"
      aria-label={t("research.plan.label")}
      aria-busy={card.planning || undefined}
      className="research-plan"
      onKeyDown={onKeyDown}
    >
      <div className="research-plan-body">
        <p className="research-plan-kind">
          <SearchLineIcon aria-hidden="true" className="size-3.5" />
          {t("research.plan.heading")}
        </p>
        <p data-testid="research-plan-title" className="research-plan-title">
          {card.title}
        </p>
        {card.planning && card.steps.length === 0 ? (
          <p data-testid="research-plan-planning" role="status" className="research-plan-planning">
            <span aria-hidden="true" className="task-dot" />
            {t("research.thread.planning")}
          </p>
        ) : (
          <ol className="research-plan-steps">
            {card.steps.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a step is its place in the plan while it is edited.
              <li key={index} className="research-plan-step">
                <span aria-hidden="true" className="research-plan-number">
                  {index + 1}.
                </span>
                <TypingTextarea
                  ref={(field) => {
                    fields.current[index] = field;
                  }}
                  rows={1}
                  data-testid="research-plan-step"
                  aria-label={t("research.plan.step", { number: index + 1 })}
                  value={step}
                  placeholder={card.steps.length === 1 ? t("research.plan.firstStep") : undefined}
                  disabled={card.planning}
                  onChange={(event) =>
                    setStep(key, index, event.target.value.replace(/\s*\n\s*/g, " "))
                  }
                  onKeyDown={onStepKey(index)}
                  className="research-plan-field"
                />
                {card.steps.length > 1 && (
                  <button
                    type="button"
                    data-testid="research-plan-remove"
                    aria-label={t("research.plan.removeStep", { number: index + 1 })}
                    title={t("research.plan.removeStep", { number: index + 1 })}
                    disabled={card.planning}
                    onClick={() => removeStep(key, index)}
                    className="research-plan-remove"
                  >
                    <RemoveIcon className="size-2.5" />
                  </button>
                )}
              </li>
            ))}
            <li className="research-plan-step research-plan-step--fixed">
              <span aria-hidden="true" className="research-plan-number">
                {card.steps.length + 1}.
              </span>
              <WriteStep card={card} />
            </li>
          </ol>
        )}
        {!card.planning && card.steps.length < MAX_RESEARCH_STEPS && (
          <button
            type="button"
            data-testid="research-plan-add"
            onClick={() => {
              if (addStep(key, card.steps.length - 1)) focusStep.current = card.steps.length;
            }}
            className="research-plan-add"
          >
            <PlusLineIcon className="size-3.5" />
            {t("research.plan.addStep")}
          </button>
        )}
        <div className="research-plan-settings">
          <div className="research-plan-row">
            <span className="research-plan-label">{t("research.plan.sources")}</span>
            <div className="research-plan-sources">
              <SourceToggle
                testId="research-plan-web"
                label={t("research.plan.web")}
                pressed={searchesWeb}
                disabled={web !== "ready"}
                onToggle={() =>
                  updatePlan(key, { sources: { ...card.sources, web: !card.sources.web } })
                }
              />
              <SourceToggle
                testId="research-plan-library"
                label={t("research.plan.library")}
                pressed={card.sources.library}
                onToggle={() =>
                  updatePlan(key, {
                    sources: { ...card.sources, library: !card.sources.library },
                  })
                }
              />
            </div>
          </div>
          <WebLine reach={web} model={model} />
          <div className="research-plan-row">
            <span className="research-plan-label">{t("research.plan.writeInto")}</span>
            <WriteInto mindId={mindId} card={card} />
          </div>
        </div>
      </div>
      <PlanProblem mindId={key} card={card} model={model} chosen={chosen} />
      <div className="research-plan-foot">
        <Estimate
          steps={Math.max(1, steps.length)}
          web={searchesWeb}
          model={model}
          note={
            !card.planning && steps.length === 0
              ? t("research.plan.noSteps")
              : !searchesWeb && !card.sources.library
                ? t("research.plan.noSource")
                : null
          }
        />
        <button
          type="button"
          data-testid="research-plan-cancel"
          onClick={cancel}
          className={buttonStyle("ghost", "sm")}
        >
          {t("research.plan.cancel")}
        </button>
        <button
          type="button"
          data-testid="research-plan-start"
          disabled={blocked}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          title={`${t("research.plan.start")} (${keysLabel(START_KEYS, isMacOS())})`}
          onClick={start}
          className={buttonStyle("primary", "sm")}
        >
          {t("research.plan.start")}
          <span className="approval-keys">{keysLabel(START_KEYS, isMacOS())}</span>
        </button>
      </div>
    </section>
  );
}

/** The step every plan ends with: the cited draft, where it goes. */
function WriteStep({ card }: { card: Card }) {
  const t = useT();
  const target = card.writeInto;
  const mind = useAppStore((state) =>
    "mindId" in target ? state.minds.find((each) => each.id === target.mindId) : undefined,
  );
  const text =
    "mindId" in target
      ? t("research.plan.writeStep", { mind: (mind && mindName(mind)) || t("mind.untitled") })
      : t("research.plan.writeStep.new");
  return (
    <span data-testid="research-plan-write-step" className="research-plan-fixed">
      {text}
    </span>
  );
}

function SourceToggle({
  testId,
  label,
  pressed,
  disabled = false,
  onToggle,
}: {
  testId: string;
  label: string;
  pressed: boolean;
  disabled?: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onToggle}
      className="research-plan-source"
    >
      {pressed && <CheckLineIcon aria-hidden="true" className="size-3" />}
      {label}
    </button>
  );
}

/** Why the web can't be searched with this model, with what fixes it. */
function WebLine({ reach, model }: { reach: WebReach; model: ChatModelChoice | null }) {
  const t = useT();
  const missing = useWebMissing(reach, model);
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (reach === "ready" || missing === null) return null;
  if (reach === "off") {
    return (
      <ProblemLine
        role="status"
        testId="research-plan-web-off"
        className="research-plan-note"
        action={{
          label: t("research.plan.webOff.action"),
          onClick: () => void updateSettings({ user: { webSearch: true } }),
        }}
      >
        {t("research.plan.webOff")}
      </ProblemLine>
    );
  }
  return (
    <p data-testid="research-plan-web-unavailable" className="research-plan-note">
      {t("research.plan.libraryOnly", { reason: missing })}
    </p>
  );
}

/**
 * "Write into: this Mind ▾": the Mind the assistant reads, other recent Minds, or a
 * new one (the only way in without a Mind in focus).
 */
function WriteInto({ mindId, card }: { mindId: string | null; card: Card }) {
  const t = useT();
  const minds = useAppStore((state) => state.minds);
  const menu = usePopoverMenu();
  const target = card.writeInto;
  const nameOf = (id: string) => {
    const mind = minds.find((each) => each.id === id);
    return (mind && mindName(mind)) || t("mind.untitled");
  };
  const label = "mindId" in target ? nameOf(target.mindId) : t("research.plan.newMind");
  const others = minds
    .filter((each) => each.id !== mindId && each.kind === DEFAULT_MIND_KIND)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, OTHER_MINDS);
  const choose = (writeInto: Card["writeInto"]) => {
    updatePlan(mindId ?? NO_MIND, { writeInto });
    menu.close();
  };
  const checked = (id: string | null) =>
    id === null ? "newMind" in target : "mindId" in target && target.mindId === id;
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="research-plan-write-into"
        title={label}
        className="research-plan-target"
      >
        <MindLineIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDownLineIcon aria-hidden="true" className="size-3 shrink-0" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("research.plan.writeInto")}
        className={menuClass}
      >
        {menu.open && (
          <>
            {[...(mindId === null ? [] : [mindId]), ...others.map((each) => each.id)].map((id) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={checked(id)}
                data-testid="research-plan-mind"
                className={menuItemClass}
                onClick={() => choose({ mindId: id })}
              >
                <span className="truncate">{nameOf(id)}</span>
              </button>
            ))}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={checked(null)}
              data-testid="research-plan-new-mind"
              className={menuItemClass}
              onClick={() => choose({ newMind: true })}
            >
              {t("research.plan.newMind")}
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** Why there is no plan from the model, or the Task didn't start: one line with what fixes it. */
function PlanProblem({
  mindId,
  card,
  model,
  chosen,
}: {
  mindId: string;
  card: Card;
  model: ChatModelChoice | null;
  /** The model picked in the Mind; null when it follows the last pick or the default. */
  chosen: ChatModelChoice | null;
}) {
  const t = useT();
  const openSettings = useAppStore((state) => state.openSettings);
  const problem = card.problem;
  const thinking =
    problem?.reason === "failed" &&
    problem.error.wording?.key === "error.research.plan.thoughtOnly";
  const failedWith = useRef(model);
  // Another model chosen is the way on from a model that only thinks: the plan is made again with it.
  useEffect(() => {
    const before = failedWith.current;
    failedWith.current = model;
    if (!thinking || !model) return;
    if (before?.providerId === model.providerId && before.modelId === model.modelId) return;
    void planAgain(mindId, model);
  }, [thinking, mindId, model]);
  if (!problem) return null;
  if (problem.reason === "not-ready") {
    return (
      <ReadinessLine
        readiness={problem.readiness}
        testId="research-plan-not-ready"
        className="research-plan-problem"
        setUpLabel={t("question.setUp")}
      />
    );
  }
  if (problem.reason === "consent-declined") {
    return (
      <ProblemLine testId="research-plan-not-sent" className="research-plan-problem">
        {t("answer.error.consent-declined")}
      </ProblemLine>
    );
  }
  const { error } = problem;
  const again = () => void planAgain(mindId, model);
  if (error.wording) {
    return (
      <ProblemLine
        testId="research-plan-failed"
        className="research-plan-problem"
        title={error.message}
        action={
          thinking
            ? {
                label: t("answer.error.chooseModel"),
                // The chip's model is the plan's: Settings' default can't change it.
                onClick: chosen ? requestModelMenu : () => openSettings("models"),
              }
            : { label: t("research.plan.tryAgain"), onClick: again }
        }
      >
        {t("research.plan.failedBecause", { reason: t(error.wording.key, error.wording.values) })}
      </ProblemLine>
    );
  }
  return (
    <div data-testid="research-plan-failed" className="research-plan-problem">
      <AnswerError
        kind={error.kind}
        modelId={model?.modelId ?? null}
        providerId={model?.providerId ?? null}
        resetsAt={error.resetsAt ?? null}
        signInRoute={error.signInRoute ?? null}
        details={error.message}
        onRetry={again}
        onOpenSettings={openSettings}
      />
    </div>
  );
}

/** "About $0.60 · 8–12 min · Sonnet 5.5": the cost on a model billed per token, the time, and the chip's model. */
function Estimate({
  steps,
  web,
  model,
  note,
}: {
  steps: number;
  /** It searches the web: a search a step, which its provider bills. */
  web: boolean;
  model: ChatModelChoice | null;
  note: string | null;
}) {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const [estimate, setEstimate] = useState<RunEstimate | null>(null);
  useEffect(() => {
    let current = true;
    const searches = web ? steps : 0;
    core.estimateRun({ items: researchItems(steps), searches, ...(model && { model }) }).then(
      (result) => {
        if (current) setEstimate(result);
      },
      () => {
        if (current) setEstimate(null);
      },
    );
    return () => {
      current = false;
    };
  }, [steps, web, model]);
  const { from, to } = researchMinutes(steps);
  const name = model ? nameOf(model.modelId, model.providerId).name : "";
  const text =
    note ??
    (estimate?.billing === "per-token" && estimate.cost
      ? t("research.plan.estimate", {
          cost: formatMoney(estimate.cost, language),
          from,
          to,
          model: name,
        })
      : t("research.plan.time", { from, to, model: name }));
  return (
    <span data-testid="research-plan-estimate" title={text} className="research-plan-estimate">
      {text}
    </span>
  );
}
