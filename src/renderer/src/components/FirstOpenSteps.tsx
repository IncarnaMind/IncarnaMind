import { type ReactNode, useEffect, useRef } from "react";
import type { CommandId } from "../../../shared/commands";
import type { MessageKey } from "../../../shared/i18n";
import { addFilesLabel } from "../addFilesAction";
import { focusComposer } from "../commands/assistant";
import { shortcutLabel } from "../commands/keymap";
import { type CommandContext, commands, offered } from "../commands/registry";
import { askReadyQuestion } from "../conversations";
import { goToCitation } from "../editor/citationMark";
import { CheckMarkIcon } from "../editor/icons";
import { goToMistake } from "../editor/mistakeMark";
import { useT } from "../i18n";
import { openModelSetup } from "../modelSetup";
import { stepsShownOf } from "../nudges";
import { revealAssistant } from "../quietAssistant";
import { useAppStore } from "../store";
import { useUnreadFiles } from "../unreadFiles";
import { ExampleBanner } from "./GettingStarted";
import { ChatLineIcon, CheckLineIcon, CloseLineIcon, PlusLineIcon } from "./lineIcons";
import { ProblemLine } from "./ProblemLine";
import { SLOT, Slotted } from "./Slotted";
import { UnreadFilesLine } from "./UnreadFilesLine";
import { buttonStyle } from "./ui";

type StepKey = "citation" | "question" | "files";
type StepState = "open" | "later" | "done";

const STEPS: readonly StepKey[] = ["files", "question", "citation"];

const NEXT: readonly { id: CommandId; label: MessageKey }[] = [
  { id: "comparison.start", label: "firstOpen.next.compare" },
  { id: "meeting.record", label: "firstOpen.next.meeting" },
  { id: "mind.export", label: "firstOpen.next.export" },
];

// Each state the card can be in. They are laid out unseen in the live card's cell, so the tallest
// sets its height at whatever width the page has, and the page doesn't move as the steps tick.
const STATES: readonly { current: StepKey | undefined; modelReady: boolean }[] = [
  { current: "citation", modelReady: false },
  { current: "question", modelReady: false },
  { current: "files", modelReady: false },
  { current: undefined, modelReady: false },
  { current: undefined, modelReady: true },
];

const stateAt = (current: StepKey | undefined, key: StepKey): StepState => {
  if (current === undefined) return "done";
  const after = STEPS.indexOf(key) - STEPS.indexOf(current);
  return after < 0 ? "done" : after === 0 ? "open" : "later";
};

const DO_ICONS: Record<StepKey, typeof PlusLineIcon> = {
  citation: CheckLineIcon,
  question: ChatLineIcon,
  files: PlusLineIcon,
};

const CARD_PADDING = "px-3.5 pt-3.5 pb-2.5";

const HERE: CommandContext = { selection: [], focus: null, surface: "mind" };

function Mark({ number, state }: { number: number; state: StepState }) {
  if (state === "done") {
    return (
      <span
        aria-hidden="true"
        className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-success text-white"
      >
        <CheckMarkIcon check="found" className="size-2.5" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] leading-none font-bold ${
        state === "open" ? "bg-ink text-white" : "border-[1.5px] border-tab-divider text-ink-meta"
      }`}
    >
      {number}
    </span>
  );
}

function Step({
  step,
  number,
  state,
  live,
  onDo,
  children,
}: {
  step: StepKey;
  number: number;
  state: StepState;
  live: boolean;
  onDo: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const DoIcon = DO_ICONS[step];
  const action = t(`firstOpen.step.${step}.title`);
  const tone = state === "open" ? "font-semibold text-ink" : "text-ink-meta";
  const marks = live
    ? { "data-testid": "first-open-step", "data-step": step, "data-state": state }
    : {};
  return (
    <li {...marks} className="flex flex-col gap-1">
      <div className="flex items-center text-[14px] leading-5">
        {state === "done" && <span className="sr-only">{t("gettingStarted.done")}</span>}
        <button
          type="button"
          data-testid={live ? "first-open-step-do" : undefined}
          aria-label={action}
          title={action}
          onClick={onDo}
          className="group -mx-1.5 -my-0.5 flex items-center gap-2.5 rounded-md px-1.5 py-0.5 text-left hover:bg-chip"
        >
          <Mark number={number} state={state} />
          <span className={`${tone} group-hover:text-ink`}>
            {t(`firstOpen.step.${step}.${state === "done" ? "done" : "title"}`)}
          </span>
          <DoIcon
            data-testid={live ? "first-open-step-icon" : undefined}
            className="size-3.5 shrink-0 text-ink-meta group-hover:text-ink"
          />
        </button>
      </div>
      {state === "open" && <div className="flex flex-col gap-2 pl-7">{children}</div>}
    </li>
  );
}

export function FirstOpenSteps({ mindId }: { mindId: string }) {
  const t = useT();
  const progress = useAppStore((state) => state.settings?.device.gettingStarted);
  const pickDocumentsOrFolder = useAppStore((state) => state.pickDocumentsOrFolder);
  const updateGettingStarted = useAppStore((state) => state.updateGettingStarted);
  const ready = useAppStore((state) => state.examples?.ready ?? null);
  const modelReady = useAppStore((state) => state.chatReadiness?.ready === true);
  const placeAssistant = useAppStore((state) => state.placeAssistant);
  const skipped = useAppStore((state) => state.skippedFiles);
  const unread = useUnreadFiles(null);
  const addFiles = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  // The ready Question's button goes once it is asked: the focus moves on to the next step.
  const focusNext = useRef(false);
  const asked = progress?.askedOwn === true || progress?.askedReady === true;
  const filesOpen = asked && progress?.indexed !== true;
  const citationOpen = asked && progress?.indexed === true && progress?.citationChecked !== true;
  useEffect(() => {
    if (!focusNext.current || !(filesOpen || citationOpen)) return;
    focusNext.current = false;
    const next = filesOpen
      ? addFiles.current
      : card.current?.querySelector<HTMLElement>(
          '[data-step="citation"] [data-testid="first-open-step-do"]',
        );
    next?.focus();
  }, [filesOpen, citationOpen]);
  if (!progress) return null;

  const done: Record<StepKey, boolean> = {
    files: progress.indexed,
    question: progress.askedOwn || progress.askedReady,
    citation: progress.citationChecked,
  };
  const current = STEPS.find((key) => !done[key]);
  const liveState = (key: StepKey): StepState =>
    done[key] ? "done" : key === current ? "open" : "later";
  const chooseModel = () => {
    openModelSetup();
    revealAssistant();
    if (useAppStore.getState().layout?.assistant.folded) void placeAssistant({ folded: false });
  };

  const layer = (stateOf: (key: StepKey) => StepState, hasModel: boolean, live: boolean) => {
    const allDone = STEPS.every((key) => stateOf(key) === "done");
    // Done means a first checked Answer of one's own can come: the ready Question needs no model (#1027).
    const setUp = allDone && hasModel;
    const only = (testId: string) => (live ? testId : undefined);
    return (
      <>
        <div className="flex items-start justify-between gap-2">
          <h2
            id={live ? `first-open-${mindId}` : undefined}
            className="text-[16px] leading-6 font-semibold text-ink"
          >
            {t(setUp ? "firstOpen.done.title" : "firstOpen.title")}
          </h2>
          <button
            type="button"
            data-testid={only("first-open-hide")}
            aria-label={t("firstOpen.hide")}
            title={t("firstOpen.hide")}
            onClick={() => updateGettingStarted({ hidden: true })}
            className="inline-flex size-[22px] items-center justify-center rounded-md text-ink-meta hover:bg-chip hover:text-ink focus-visible:outline-offset-0"
          >
            <CloseLineIcon strokeWidth={2.5} className="size-3" />
          </button>
        </div>
        <ol className={`flex flex-col gap-3 ${allDone ? "pt-2" : ""}`}>
          <Step
            step="files"
            number={1}
            state={stateOf("files")}
            live={live}
            onDo={() => void pickDocumentsOrFolder()}
          >
            {live && unread.length > 0 ? (
              <UnreadFilesLine files={unread} testId="first-open-unread" />
            ) : (
              <p className="text-[13px] leading-5 text-ink-secondary">
                {t("firstOpen.step.files.body")}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                ref={live ? addFiles : undefined}
                type="button"
                data-testid={only("first-open-add-files")}
                onClick={() => void pickDocumentsOrFolder()}
                className={buttonStyle(stateOf("files") === "open" ? "primary" : "secondary", "sm")}
              >
                {t(addFilesLabel())}
              </button>
            </div>
            {live && skipped.length > 0 && (
              <ProblemLine testId="first-open-skipped">
                {t("documents.skipped", { names: skipped.join(", ") })}
              </ProblemLine>
            )}
          </Step>
          <Step
            step="question"
            number={2}
            state={stateOf("question")}
            live={live}
            onDo={focusComposer}
          >
            {ready ? (
              <>
                <p className="text-[13px] leading-5 text-ink-secondary">
                  {t("firstOpen.step.question.body")}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <button
                    type="button"
                    data-testid={only("first-open-ready")}
                    onClick={() => {
                      focusNext.current = true;
                      void askReadyQuestion();
                    }}
                    className={buttonStyle("secondary", "sm")}
                  >
                    {t("firstOpen.step.question.ready", { question: ready })}
                  </button>
                  <span className="text-[13px] leading-5 text-ink-meta">
                    <OwnQuestion message="firstOpen.step.question.own" />
                  </span>
                </div>
              </>
            ) : (
              <p className="text-[13px] leading-5 text-ink-secondary">
                <OwnQuestion message="firstOpen.step.question.ownOnly" />
              </p>
            )}
          </Step>
          <Step
            step="citation"
            number={3}
            state={stateOf("citation")}
            live={live}
            onDo={() => goToCitation()}
          >
            <p className="text-[13px] leading-5 text-ink-secondary">
              {t("firstOpen.step.citation.body")}
            </p>
            <button
              type="button"
              data-testid={only("first-open-example")}
              onClick={() => card.current && goToMistake(card.current)}
              className="w-fit rounded-sm text-left text-[13px] leading-5 text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0"
            >
              {t("firstOpen.step.citation.example")}
            </button>
          </Step>
        </ol>
        {allDone && !hasModel && (
          <div className="flex flex-col items-start gap-2 pt-3">
            <p className="text-[13px] leading-5 text-ink-secondary">{t("firstOpen.model.body")}</p>
            <button
              type="button"
              data-testid={only("first-open-choose-model")}
              onClick={chooseModel}
              className={buttonStyle("primary", "sm")}
            >
              {t("firstOpen.model.choose")}
            </button>
          </div>
        )}
        {setUp && (
          <p className="pt-3 text-[13px] leading-5 text-ink-secondary">
            {t("firstOpen.next.lead")}{" "}
            {NEXT.flatMap(({ id, label }) => {
              const command = commands.get(id);
              return command && offered(command, HERE) ? [{ id, label }] : [];
            }).map(({ id, label }, index) => (
              <span key={id}>
                {index > 0 && " · "}
                <button
                  type="button"
                  data-testid={only("first-open-next")}
                  data-command={live ? id : undefined}
                  onClick={() => void commands.run(id)}
                  className="rounded-sm text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0"
                >
                  {t(label)}
                </button>
              </span>
            ))}
          </p>
        )}
      </>
    );
  };

  return (
    <div className="mb-6 grid grid-cols-1 font-sans">
      <section
        ref={card}
        aria-labelledby={`first-open-${mindId}`}
        data-testid="first-open-steps"
        className={`col-start-1 row-start-1 ${CARD_PADDING} rounded-[10px] bg-sheet shadow-[inset_0_0_0_1px_var(--color-rule)]`}
      >
        {layer(liveState, modelReady, true)}
      </section>
      {STATES.map(({ current: at, modelReady: hasModel }) => (
        <div
          key={`${at}-${hasModel}`}
          aria-hidden="true"
          className={`pointer-events-none invisible col-start-1 row-start-1 ${CARD_PADDING}`}
        >
          {layer((key) => stateAt(at, key), hasModel, false)}
        </div>
      ))}
    </div>
  );
}

function OwnQuestion({ message }: { message: MessageKey }) {
  const t = useT();
  return (
    <Slotted
      message={t(message, { shortcut: SLOT })}
      slot={
        <kbd className="rounded-sm bg-chip px-[5px] py-px font-sans text-[12px] text-ink-strong">
          {shortcutLabel("composer.focus")}
        </kbd>
      }
    />
  );
}

export function ExampleIntro({ mindId }: { mindId: string }) {
  const stepsShown = useAppStore(
    (state) =>
      state.examples?.mindId === mindId && stepsShownOf(state.settings?.device.gettingStarted),
  );
  return stepsShown ? <FirstOpenSteps mindId={mindId} /> : <ExampleBanner mindId={mindId} />;
}
