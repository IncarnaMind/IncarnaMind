import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CommandId } from "../../../shared/commands";
import { displayName } from "../../../shared/documentNames";
import type { MessageKey } from "../../../shared/i18n";
import { fitName } from "../../../shared/naming";
import { addFilesLabel } from "../addFilesAction";
import { type AskBlock, useAnswers } from "../answers";
import { focusComposer } from "../commands/assistant";
import { shortcutLabel } from "../commands/keymap";
import { type CommandContext, commands, offered } from "../commands/registry";
import { composerKey } from "../composer";
import { askReadyQuestion, stopReadyAsk, useConversations, useReadyAsk } from "../conversations";
import { AskProblem } from "../editor/AskProblem";
import { goToCitation } from "../editor/citationMark";
import { goToMistake } from "../editor/mistakeMark";
import { useLanguage, useT } from "../i18n";
import { openModelSetup } from "../modelSetup";
import { stepsShownOf } from "../nudges";
import { revealAssistant } from "../quietAssistant";
import { allExamples, isOwnDocument, useAppStore } from "../store";
import { useUnreadFiles } from "../unreadFiles";
import { ExampleBanner } from "./GettingStarted";
import { ChatLineIcon, CheckLineIcon, CloseLineIcon, PlusLineIcon } from "./lineIcons";
import { LineAction, ProblemLine } from "./ProblemLine";
import { SLOT, Slotted } from "./Slotted";
import { STEP_BUTTON_CLASS, StepNumber, type StepState } from "./StepNumber";
import { UnreadFilesLine } from "./UnreadFilesLine";
import { buttonStyle } from "./ui";

type StepKey = "citation" | "question" | "files";

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
          className={`${STEP_BUTTON_CLASS} items-center`}
        >
          <StepNumber number={number} state={state} />
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
  const ready = useAppStore((state) => state.readyQuestion);
  const modelReady = useAppStore((state) => state.chatReadiness?.ready === true);
  const skipped = useAppStore((state) => state.skippedFiles);
  const unread = useUnreadFiles(null);
  // Why the card's own ask didn't go ahead, under the no-Mind key it asks with: the example
  // Note's composer key is another, so that problem would never be seen there.
  const problem = useAnswers((state) => state.blocked[composerKey(null)]);
  const asking = useConversations((state) => state.asking !== null);
  const askingReady = useReadyAsk((state) => state.asking);
  const readyWaiting = useReadyAsk((state) => state.waitingFor);
  const writing = useAnswers((state) => state.writing.size > 0);
  // The newest of the User's own Documents still being read: the row says so while it waits.
  const reading = useAppStore((state) => {
    const found = state.documents.find(
      (each) =>
        isOwnDocument(each, allExamples(state)) &&
        (each.status === "queued" || each.status === "extracting"),
    );
    return found ? displayName(found) : null;
  });
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
  // Shown, it has been seen: an empty note of the User's own keeps no second guide after that (#1940).
  useEffect(() => {
    if (progress && !progress.seen) updateGettingStarted({ seen: true });
  }, [progress, updateGettingStarted]);
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
            <p className="text-[13px] leading-5 text-ink-secondary">
              {t("firstOpen.step.question.body")}
            </p>
            <ReadyLine
              question={ready?.question ?? null}
              waitingFor={
                askingReady
                  ? ready === null
                    ? readyWaiting
                    : ready.waitingFor
                  : (ready?.waitingFor ?? null)
              }
              asking={live && askingReady}
              reading={reading}
              unread={unread}
              testId={only("first-open-ready")}
              problem={live ? problem : undefined}
              busy={asking || writing}
              onAsk={() => {
                if (!ready) return;
                focusNext.current = true;
                revealAssistant();
                void askReadyQuestion(ready);
              }}
            />
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

function useFittedLine(text: string, atWords: boolean, room: RefObject<HTMLElement | null>) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      // Measuring writes each text tried into the line itself. A fit that hasn't changed doesn't
      // render again, and the last text tried would stay, cut where no word ends: put back what is
      // drawn before setting the fit.
      const drawn = element.textContent ?? "";
      const fitted = fitName(
        text,
        (each) => {
          element.textContent = each;
          return element.scrollWidth <= element.clientWidth;
        },
        atWords,
      );
      element.textContent = drawn;
      setShown(fitted);
    };
    update();
    // The line's width changes only as its text does, so the row it is given says when the room
    // changed; the line too, as a text that no longer fits must be measured again.
    const observer = new ResizeObserver(update);
    if (room.current) observer.observe(room.current);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, atWords, room]);
  return [ref, shown] as const;
}

function ReadyLine({
  question,
  waitingFor,
  asking,
  reading,
  unread,
  testId,
  problem,
  busy,
  onAsk,
}: {
  question: string | null;
  /** The Document the Answer waits for, while the ready Question is asked (#2218). */
  waitingFor: string | null;
  /** That Question is being asked, and its Answer isn't there yet. */
  asking: boolean;
  reading: string | null;
  unread: ReturnType<typeof useUnreadFiles>;
  testId: string | undefined;
  problem: AskBlock | undefined;
  busy: boolean;
  onAsk: () => void;
}) {
  const t = useT();
  const room = useRef<HTMLDivElement>(null);
  const label = question === null ? "" : t("firstOpen.step.question.ready", { question });
  const [ref, shown] = useFittedLine(label, useLanguage() !== "zh-CN", room);
  let line: ReactNode;
  // Asked, and its Answer waits for a Document still being read: the row says so, and stops.
  if (asking && waitingFor !== null)
    line = (
      <>
        <span
          data-testid={testId === undefined ? undefined : `${testId}-waiting`}
          title={waitingFor}
          className="min-w-0 truncate text-[13px] leading-5 text-ink-secondary"
        >
          {t("firstOpen.step.question.reading", { document: waitingFor })}
        </span>
        <LineAction
          action={{
            label: t("firstOpen.step.question.stop"),
            testId: testId === undefined ? undefined : `${testId}-stop`,
            onClick: stopReadyAsk,
          }}
        />
      </>
    );
  else if (question !== null)
    line = (
      <>
        <button
          type="button"
          data-testid={testId}
          aria-label={label}
          title={label}
          disabled={busy}
          onClick={onAsk}
          // A button keeps its size in a row; this one gives way so its line can cut, not overflow.
          style={{ flexShrink: 1, minWidth: 0 }}
          className={buttonStyle("secondary", "sm")}
        >
          <span ref={ref} className="block truncate">
            {shown}
          </span>
        </button>
        <span className="shrink-0 text-[13px] leading-5 text-ink-meta">
          <OwnQuestion message="firstOpen.step.question.own" />
        </span>
      </>
    );
  else if (reading !== null)
    line = (
      <span title={reading} className="min-w-0 truncate text-[13px] leading-5 text-ink-secondary">
        {t("firstOpen.step.question.reading", { document: reading })}
      </span>
    );
  else if (unread.length > 0)
    line =
      testId === undefined ? (
        // The unseen states hold the line's height; the line the User can act on is the live one.
        <span className="truncate text-[13px] leading-5 text-ink-secondary">
          {t(unread.length === 1 ? "unread.count.one" : "unread.count", { count: unread.length })}
        </span>
      ) : (
        <UnreadFilesLine files={unread} testId={`${testId}-unread`} />
      );
  else
    line = (
      <span className="text-[13px] leading-5 text-ink-secondary">
        <OwnQuestion message="firstOpen.step.question.ownOnly" />
      </span>
    );
  return (
    <div ref={room} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-7 min-w-0 items-center gap-x-3">{line}</div>
      {problem && (
        <AskProblem
          problem={problem}
          testIds={{
            notReady: "first-open-ready-not-ready",
            skillUnavailable: "first-open-ready-skill",
            error: "first-open-ready-error",
          }}
        />
      )}
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
