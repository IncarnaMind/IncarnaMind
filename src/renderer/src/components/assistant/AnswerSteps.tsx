import {
  type FocusEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  AnswerToolCall,
  AskedFrom,
  ConversationAnswer,
  ConversationQuestion,
} from "../../../../core/api";
import { shownDocumentName } from "../../../../shared/citations";
import { citationLocation, formatLocation } from "../../../../shared/locations";
import { mindName } from "../../../../shared/naming";
import { NO_SCOPE } from "../../../../shared/searchScope";
import { analysisCallText } from "../../analysisCall";
import {
  type FoldedLine,
  foldedLine,
  type LiveStep,
  liveStep,
  liveStepKey,
  plainSummary,
  type ReadDocument,
  type StepRow,
  type StepSource,
  stepRows,
} from "../../answerSteps";
import {
  checkedWords,
  checkingWords,
  documentReadText,
  documentsReadText,
  foldedWords,
  mindLabel,
  mindStepText,
} from "../../answerStepWords";
import { useAnswers } from "../../answers";
import { stepsScope } from "../../assistantContext";
import { namedMind } from "../../changeProblems";
import { commandCallText } from "../../commandFacts";
import { CallRow, SkillRow } from "../../editor/AnswerView";
import { CheckMarkIcon, RegenerateSmallIcon } from "../../editor/icons";
import { holdSteps, type ShownStep, type StepHold, takeOver } from "../../heldStep";
import { useT } from "../../i18n";
import { useMeetings } from "../../meetings";
import { useModelNames } from "../../modelNames";
import type { Translate } from "../../objects";
import { openCitedFollowing, quoteSaysSo } from "../../openCited";
import { scopeChips } from "../../scope";
import { skillTitle } from "../../skills";
import { useAppStore } from "../../store";
import { SearchIcon } from "../icons";
import {
  CalculatorLineIcon,
  ChevronRightLineIcon,
  CloseLineIcon,
  DocumentLineIcon,
  MindLineIcon,
  SparkLineIcon,
} from "../lineIcons";
import { ProblemLine } from "../ProblemLine";
import { AnswerWait } from "./AnswerWait";
import { askCallText } from "./AskCall";
import { mindCallText } from "./MindCall";

/** Sources shown under a search before "+N more". */
const SHOWN_SOURCES = 3;

/**
 * An Answer's steps in the assistant (#391), at the top of the Answer: while
 * it is written, the step it is on; once written, one folded line, as
 * Claude's and ChatGPT's "Thought for 5s ›", which opens, at once, to a
 * timeline of what it did, with Regenerate at its end.
 */
export function AnswerSteps({
  answer,
  question,
  askedAgain,
  streaming,
  waitingForApproval,
  wait,
  onRegenerate,
}: {
  answer: ConversationAnswer;
  question: ConversationQuestion | undefined;
  /** It was asked again with this many Documents an earlier Answer didn't use: the line says so. */
  askedAgain?: number;
  streaming: boolean;
  waitingForApproval: boolean;
  wait: { usual: number | null } | null;
  onRegenerate(): void;
}) {
  const t = useT();
  const phase = useAnswers((state) => state.phases[answer.id]);
  const askedFrom = question?.askedFrom ?? null;
  const askedInMeeting = useAskedInMeeting(question);
  const meeting = answer.steps?.sent ? answer.steps.sent.transcript === true : askedInMeeting;
  const selection = (question?.focus?.selection ?? "").trim() !== "";
  const scopeOf = useStepsScopeOf(question);
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const focusOnToggle = useRef(false);
  const onToggle = () => setOpen((was) => !was);
  // The live line and the folded one are two buttons: the one that replaces the other takes its focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs when the Answer starts or ends being written.
  useLayoutEffect(() => {
    // Without scrolling: the folded line is at the Answer's start, and the reader is at its end.
    if (focusOnToggle.current) toggle.current?.focus({ preventScroll: true });
  }, [streaming]);
  const focus = {
    onFocus: () => {
      focusOnToggle.current = true;
    },
    // A button taken out of the page while it has the focus may say it lost it: that is the swap.
    onBlur: (event: FocusEvent<HTMLButtonElement>) => {
      if (event.currentTarget.isConnected) focusOnToggle.current = false;
    },
  };
  const checking = useRef<number | null>(null);
  if (streaming) {
    const step = liveStep({ answer, phase, waitingForApproval });
    if (step.kind === "checking") checking.current = step.count;
    return (
      <div className="answer-steps">
        <LiveLine
          step={step}
          scope={scopeOf(0)}
          askedFrom={askedFrom}
          toggle={{ open, onToggle, ref: toggle, ...focus }}
        />
        {wait && <AnswerWait answer={answer} usual={wait.usual} />}
        {open && (
          <Timeline
            rows={stepRows({ answer, askedFrom, meeting, selection }, step, checking.current)}
            scope={scopeOf(0)}
            onRegenerate={onRegenerate}
          />
        )}
      </div>
    );
  }
  checking.current = null;
  if (answer.steps?.example) {
    return (
      <div className="answer-steps">
        <p data-testid="answer-example" className="answer-steps-line">
          {t("examples.answer")}
        </p>
      </div>
    );
  }
  const line = foldedLine({ answer, askedFrom, meeting, selection });
  if (!line) return null;
  return (
    <div className="answer-steps">
      <FoldedToggle
        line={line}
        scopeOf={scopeOf}
        askedAgain={askedAgain}
        open={open}
        onToggle={onToggle}
        toggleRef={toggle}
        {...focus}
      />
      {open && (
        <>
          <Timeline
            rows={stepRows({ answer, askedFrom, meeting, selection })}
            scope={scopeOf(0)}
            onRegenerate={onRegenerate}
          />
          <button
            type="button"
            data-testid="answer-regenerate"
            onClick={onRegenerate}
            className="answer-steps-regenerate"
          >
            <RegenerateSmallIcon className="size-3.5" />
            {t("answer.regenerate")}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The line of an Answer on its way or being written: its step, with the
 * pulsing accent dot, or what it waits for, with the attention dot. `scope`
 * is what its Question searches (`stepsScope`).
 */
export function LiveLine({
  step,
  scope,
  askedFrom = null,
  toggle,
}: {
  step: LiveStep;
  scope: string;
  /** The Mind the Question was asked from: the one a Minds' Tool changes when it names none. */
  askedFrom?: AskedFrom | null;
  /** Opens and folds the steps, by a button over the whole line. */
  toggle?: {
    open: boolean;
    onToggle(): void;
    ref: Ref<HTMLButtonElement>;
    onFocus(): void;
    onBlur(event: FocusEvent<HTMLButtonElement>): void;
  };
}) {
  const t = useT();
  const shown = useHeldStep(step);
  const minds = useAppStore((state) => state.minds);
  // A Minds' Tool's call names its Mind once it has changed it; before, by its input, else the one asked from.
  const mindOf = (call: AnswerToolCall) => {
    const changed = minds.find((mind) => mind.id === call.mindChange?.mindId);
    if (changed) return mindName(changed);
    if (call.tool === "create_mind")
      return typeof call.input.title === "string" ? call.input.title : "";
    return typeof call.input.mind === "string"
      ? call.input.mind
      : askedFrom?.name || namedMind(t, call);
  };
  const waitingSeconds = useSecondsOn(liveStepKey(shown));
  const summary = shown.kind === "thinking" ? shown.summary : "";
  const label = liveText(t, shown, scope, mindOf);
  const waiting = shown.kind === "waiting" || shown.kind === "consent";
  return (
    <p
      role="status"
      data-testid="answer-steps-live"
      data-step={shown.kind}
      className="answer-steps-line answer-steps-live"
    >
      <span
        aria-hidden="true"
        className={`answer-steps-dot ${waiting ? "answer-steps-dot--waiting" : ""}`}
      />
      <span
        data-testid="answer-writing"
        title={summary ? `${label} · ${summary}` : label}
        className={summary ? "answer-steps-label" : "answer-steps-text"}
      >
        {label}
      </span>
      {/* Not read out: it changes with every word, and the steps hold it whole. */}
      {summary && (
        <span
          aria-hidden="true"
          data-testid="answer-steps-summary"
          className="answer-steps-text answer-steps-summary"
        >
          {`· ${summary}`}
        </span>
      )}
      {/* A step that takes over two seconds counts them, so the line is never still while it works. */}
      {!waiting && waitingSeconds >= 2 && (
        <span
          aria-hidden="true"
          data-testid="answer-steps-elapsed"
          className="answer-steps-elapsed"
        >
          {t("steps.live.seconds", { seconds: waitingSeconds })}
        </span>
      )}
      {toggle && (
        <button
          type="button"
          data-testid="answer-steps"
          aria-expanded={toggle.open}
          aria-label={t("steps.label")}
          ref={toggle.ref}
          onClick={toggle.onToggle}
          onFocus={toggle.onFocus}
          onBlur={toggle.onBlur}
          className="answer-steps-live-toggle"
        >
          <ChevronRightLineIcon aria-hidden="true" className="answer-steps-chevron" />
        </button>
      )}
    </p>
  );
}

/** Whole seconds the step with this key has been on the line, counted each second. */
function useSecondsOn(key: string): number {
  const since = useRef({ key, at: Date.now() });
  const [, tick] = useState(0);
  if (since.current.key !== key) since.current = { key, at: Date.now() };
  useEffect(() => {
    const timer = setInterval(() => tick((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.floor((Date.now() - since.current.at) / 1000);
}

/** The step to show (see `holdSteps`). */
function useHeldStep(step: LiveStep): LiveStep {
  const taken = useRef<ShownStep | null | undefined>(undefined);
  if (taken.current === undefined) taken.current = takeOver(step);
  const [shown, setShown] = useState(taken.current?.step ?? step);
  const hold = useRef<StepHold | null>(null);
  hold.current ??= holdSteps(taken.current ?? { step, since: Date.now() }, setShown);
  const latest = useRef(step);
  latest.current = step;
  // The step on screen with the latest it said, such as the summary, while a later one waits its turn.
  const said = useRef(shown);
  const key = liveStepKey(step);
  useEffect(() => hold.current?.mount(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a step is offered when its kind changes; its count rides along in `step`.
  useEffect(() => {
    hold.current?.offer(latest.current);
    return () => hold.current?.stop();
  }, [key]);
  if (key === liveStepKey(shown)) said.current = step;
  else if (liveStepKey(said.current) !== liveStepKey(shown)) said.current = shown;
  // The same step with a new count (Citations) shows the new one.
  return key === liveStepKey(shown) ? step : said.current;
}

function liveText(
  t: Translate,
  step: LiveStep,
  scope: string,
  mindOf: (call: AnswerToolCall) => string,
): string {
  switch (step.kind) {
    case "waiting":
      return t("approvals.answer.waiting");
    case "consent":
      return t("answer.phase.waiting-for-consent");
    case "loading":
      return t("answer.phase.loading");
    case "reading":
      return t("steps.live.reading", { mind: mindLabel(t, step.mind) });
    case "searching":
      return t("steps.live.searching", { scope });
    case "call":
      return runningText(t, step.call, mindOf);
    case "thinking":
      return t(step.summary ? "steps.live.thinkingAbout" : "steps.live.thinking");
    case "writing":
      return t("answer.phase.writing");
    case "checking":
      return checkingWords(t, step.count);
    case "checking-figures":
      return t("answer.phase.checking-figures");
    case "checking-claims":
      return t("answer.phase.checking-claims");
  }
}

/** A text field of what a Tool call was asked, or "". */
const field = (call: AnswerToolCall, name: string): string => {
  const value: unknown = call.input?.[name];
  return typeof value === "string" ? value : "";
};

/** What a call that runs is doing, in the words its row uses. */
function runningText(
  t: Translate,
  call: AnswerToolCall,
  mindOf: (call: AnswerToolCall) => string,
): string {
  if (call.source === "connector") {
    return t("connectors.call.running", { connector: call.connector?.name ?? "", tool: call.tool });
  }
  if (call.source === "sources") return t("sources.call.running", { query: field(call, "query") });
  if (call.source === "minds") return mindCallText(t, call, mindOf(call));
  if (call.source === "analysis") return analysisCallText(t, call);
  if (call.source === "commands") return commandCallText(t, call);
  if (call.source === "asks") return askCallText(t, call);
  if (call.tool === "read_document") return documentReadText(t, call, true);
  if (call.source === "web") {
    return call.tool === "search_web"
      ? t("web.call.searching", { query: field(call, "query") })
      : t("web.call.reading", { address: field(call, "url") });
  }
  if (call.tool === "run_skill_script") {
    return t("scripts.call.running", {
      skill: skillTitle(field(call, "skill"), t),
      script: field(call, "script"),
    });
  }
  const skill = call.tool === "use_skill" ? field(call, "name") : field(call, "skill");
  return t("skills.answer.loading", { name: skillTitle(skill, t) });
}

/** A share read as a whole percent, at least 1 and at most 99: "about 40%" is part, never none or all. */
const percentOf = (share: number) => Math.min(99, Math.max(1, Math.round(share * 100)));

/** Stands for the Mind's name in a line, to split the line around it. */
const NAME = "\u0001";

/**
 * The folded line: a click, Enter or Space opens and folds it. Its tooltip is
 * the whole line. When it names the Mind read (or asked from), its timeline
 * leaves that step out, and the name goes to the Mind, as the step's row does.
 */
function FoldedToggle({
  line,
  scopeOf,
  askedAgain,
  open,
  onToggle,
  toggleRef,
  onFocus,
  onBlur,
}: {
  line: FoldedLine;
  scopeOf(extra: number): string;
  askedAgain?: number | undefined;
  open: boolean;
  onToggle(): void;
  toggleRef: Ref<HTMLButtonElement>;
  onFocus(): void;
  onBlur(event: FocusEvent<HTMLButtonElement>): void;
}) {
  const t = useT();
  const nameOf = useModelNames();
  const documentOf = useDocumentNames();
  const documentKind = useOnlyDocumentKind(line.kind === "read-documents" ? line.documents : []);
  const words = { scope: scopeOf, modelOf: (id: string) => nameOf(id).name, documentOf };
  const label =
    askedAgain === undefined
      ? foldedWords(t, line, words)
      : askedAgain === 1
        ? t("coverage.askedAgain.one")
        : t("coverage.askedAgain", { count: askedAgain });
  const step =
    askedAgain !== undefined
      ? null
      : line.kind === "read" || line.kind === "asked"
        ? line
        : line.kind === "read-documents"
          ? line.read
          : null;
  const mind = step?.mind;
  const icon =
    line.kind === "read-documents" ? (
      <DocumentLineIcon kind={documentKind ?? "text"} className="answer-steps-icon" />
    ) : mind ? (
      <MindLineIcon className="answer-steps-icon" />
    ) : line.kind === "answered" ? (
      <SparkLineIcon className="answer-steps-icon" />
    ) : (
      <SearchIcon className="answer-steps-icon" />
    );
  const parts =
    step && !step.mind.deleted
      ? foldedWords(t, line, { ...words, mindName: NAME }).split(NAME)
      : [];
  if (mind && parts.length === 2) {
    const [before, after] = parts;
    return (
      <div
        data-testid="answer-steps-line"
        title={label}
        className="answer-steps-line answer-steps-split"
      >
        <button
          type="button"
          data-testid="answer-steps"
          data-kind={line.kind}
          aria-expanded={open}
          aria-label={label}
          ref={toggleRef}
          onClick={onToggle}
          onFocus={onFocus}
          onBlur={onBlur}
          className="answer-steps-toggle answer-steps-part"
        >
          {icon}
          {before}
        </button>
        <button
          type="button"
          data-testid="answer-steps-mind"
          onClick={() => useAppStore.getState().openMind(mind.mindId)}
          className="answer-steps-mind answer-step-link"
        >
          {mindLabel(t, mind)}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          aria-expanded={open}
          onClick={onToggle}
          className={`answer-steps-toggle answer-steps-part ${
            !after ? "answer-steps-part--end" : after.length > 1 ? "answer-steps-part--tail" : ""
          }`}
        >
          {after && after.length > 1 ? <span className="answer-steps-tail">{after}</span> : after}
          <ChevronRightLineIcon className="answer-steps-chevron" />
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="answer-steps"
      data-kind={line.kind}
      aria-expanded={open}
      title={line.kind === "answered" ? `${label} · ${line.model}` : label}
      ref={toggleRef}
      onClick={onToggle}
      onFocus={onFocus}
      onBlur={onBlur}
      className="answer-steps-line answer-steps-toggle"
    >
      {icon}
      <span className="answer-steps-text">{label}</span>
      <ChevronRightLineIcon aria-hidden="true" className="answer-steps-chevron" />
    </button>
  );
}

/** The unfolded steps, one row each, their icons joined by a rule. */
function Timeline({
  rows,
  scope,
  onRegenerate,
}: {
  rows: StepRow[];
  scope: string;
  onRegenerate(): void;
}) {
  const t = useT();
  return (
    <ol aria-label={t("steps.label")} data-testid="answer-timeline" className="answer-timeline">
      {rows.map((row, index) => (
        <StepItem
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows are in a fixed order for one Answer.
          key={index}
          row={row}
          scope={scope}
          onRegenerate={onRegenerate}
        />
      ))}
    </ol>
  );
}

function StepItem({
  row,
  scope,
  onRegenerate,
}: {
  row: StepRow;
  scope: string;
  onRegenerate(): void;
}) {
  const t = useT();
  const shown = useModelNames()(
    row.kind === "reasoning" || row.kind === "answered" ? row.model : "",
  );
  switch (row.kind) {
    case "reasoning":
      return (
        <Step kind={row.kind} icon={<SparkLineIcon />} running={row.thinking}>
          <p className="answer-step-title" title={shown.id}>
            {row.thinking || !row.summary
              ? t("steps.live.thinking")
              : t("steps.thought", { model: shown.name, seconds: row.seconds })}
          </p>
          {row.summary && <ReasoningSummary summary={row.summary} />}
        </Step>
      );
    case "answered":
      return (
        <Step kind={row.kind} icon={<SparkLineIcon />}>
          <p className="answer-step-title" title={shown.id}>
            {row.seconds === null
              ? t("steps.answered", { model: shown.name })
              : t("steps.answered.in", { model: shown.name, seconds: row.seconds })}
          </p>
        </Step>
      );
    case "read":
    case "asked": {
      const label = mindStepText(t, row);
      return (
        <Step kind={row.kind} icon={<MindLineIcon />}>
          {row.mind.deleted ? (
            <p className="answer-step-title">{label}</p>
          ) : (
            <button
              type="button"
              data-testid={`answer-step-${row.kind}`}
              onClick={() => useAppStore.getState().openMind(row.mind.mindId)}
              className="answer-step-title answer-step-link"
            >
              {label}
            </button>
          )}
          {row.kind === "read" && row.share !== null && (
            <p data-testid="answer-step-read-share" className="answer-step-detail">
              {t("steps.read.share", { percent: percentOf(row.share) })}
            </p>
          )}
        </Step>
      );
    }
    case "read-documents":
      return <ReadDocumentsStep row={row} />;
    case "search":
      return <SearchStep row={row} scope={scope} />;
    case "stopped-search":
      return (
        <Step kind={row.kind} icon={<SearchIcon />}>
          <p className="answer-step-title">
            {t("steps.search.stopped", { scope, query: field(row.call, "query") })}
          </p>
        </Step>
      );
    case "failed-search":
      return (
        <Step kind={row.kind} icon={<CloseLineIcon />}>
          <FailedSearch call={row.call} scope={scope} onRegenerate={onRegenerate} />
        </Step>
      );
    case "failed-read":
      return (
        <Step kind={row.kind} icon={<CloseLineIcon />}>
          <FailedRead call={row.call} onRegenerate={onRegenerate} />
        </Step>
      );
    case "call":
      return (
        <li
          data-testid="answer-step"
          data-step={row.kind}
          data-running={row.call.status === "running" || undefined}
          className="answer-step answer-step--call"
        >
          <CallRow call={row.call} />
        </li>
      );
    case "skill":
      return (
        <li
          data-testid="answer-step"
          data-step={row.kind}
          data-running={row.use?.status === "running" || undefined}
          className="answer-step answer-step--call"
        >
          <SkillRow name={row.name} use={row.use} reads={row.reads} />
        </li>
      );
    case "asked-again":
      return (
        <Step kind={row.kind} icon={<SparkLineIcon />}>
          {row.tools.map((tool) => (
            <p key={tool} data-testid="answer-asked-again" className="answer-step-title">
              {t(tool === "search" ? "steps.askedAgain.search" : "steps.askedAgain.calculate")}
            </p>
          ))}
        </Step>
      );
    case "calculated":
      return (
        <Step kind={row.kind} icon={<CalculatorLineIcon />}>
          <p data-testid="answer-figures" className="answer-step-title">
            {row.count === 1
              ? t("answer.figures.calculated.one")
              : t("answer.figures.calculated", { count: row.count })}
          </p>
        </Step>
      );
    case "check":
      return <CheckStep count={row.count} notFound={row.notFound} running={row.running} />;
  }
}

function Step({
  kind,
  icon,
  running,
  children,
}: {
  kind: StepRow["kind"];
  icon: ReactNode;
  /** The step is going on: the pulsing dot of the live line stands for its icon. */
  running?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <li
      data-testid="answer-step"
      data-step={kind}
      data-running={running || undefined}
      className="answer-step"
    >
      <span aria-hidden="true" className="answer-step-icon">
        {running ? <span className="answer-steps-dot" /> : icon}
      </span>
      <div className="answer-step-body">{children}</div>
    </li>
  );
}

/** The model's reasoning summary, cut at three lines; Show more only when it is cut. */
function ReasoningSummary({ summary }: { summary: string }) {
  const t = useT();
  const text = useRef<HTMLParagraphElement>(null);
  const [whole, setWhole] = useState(false);
  const [cut, setCut] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a summary that grows while it streams is measured again.
  useLayoutEffect(() => {
    const element = text.current;
    if (!element || whole) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [whole, summary]);
  return (
    <>
      <p
        ref={text}
        data-testid="answer-reasoning"
        data-whole={whole || undefined}
        className="answer-step-detail answer-step-reasoning"
      >
        {plainSummary(summary)}
      </p>
      {(cut || whole) && (
        <button
          type="button"
          data-testid="answer-reasoning-more"
          aria-expanded={whole}
          onClick={() => setWhole((was) => !was)}
          className="answer-step-more"
        >
          {t(whole ? "steps.showLess" : "steps.showMore")}
        </button>
      )}
    </>
  );
}

/** A search, or several in a row: what was searched for, what was found and used, and its sources. */
function SearchStep({ row, scope }: { row: Extract<StepRow, { kind: "search" }>; scope: string }) {
  const t = useT();
  const searches = row.calls.filter((call) => call.tool === "search_documents");
  const reads = row.calls.filter((call) => call.tool === "read_document");
  const queries = searches.map((call) => field(call, "query"));
  const current = row.calls.at(-1);
  return (
    <Step kind={row.kind} icon={<SearchIcon />} running={row.running}>
      <p className="answer-step-title">
        {row.running
          ? current?.tool === "read_document"
            ? documentReadText(t, current, true)
            : t("steps.search.running", { scope, query: queries.at(-1) ?? "" })
          : searches.length === 0 && reads.length > 0
            ? reads.length > 1
              ? t("steps.readDocument.times", { count: reads.length })
              : documentReadText(t, reads[0] as AnswerToolCall)
            : queries.length > 1
              ? t("steps.search.times", { scope, count: queries.length })
              : t("steps.search", { scope, query: queries[0] ?? "" })}
      </p>
      {queries.length > 1 && (
        <ul className="answer-step-queries">
          {queries.map((query, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same query may be searched twice.
            <li key={index} className="answer-step-detail">
              {t("search.query", { query })}
            </li>
          ))}
        </ul>
      )}
      {(searches.length > 0 || reads.length > 1) && (
        <ul className="answer-step-queries">
          {reads.map((call) => (
            <li key={call.id} className="answer-step-detail">
              {documentReadText(t, call)}
            </li>
          ))}
        </ul>
      )}
      {!row.running && (
        <p data-testid="answer-step-found" className="answer-step-detail">
          {row.found === 1
            ? t("steps.search.found.one", { used: row.used })
            : t("steps.search.found", { found: row.found, used: row.used })}
        </p>
      )}
      <SourceList sources={row.sources} />
    </Step>
  );
}

function ReadDocumentsStep({ row }: { row: Extract<StepRow, { kind: "read-documents" }> }) {
  const t = useT();
  const nameOf = useDocumentNames();
  const kind = useOnlyDocumentKind(row.documents);
  return (
    <Step kind={row.kind} icon={<DocumentLineIcon kind={kind ?? "text"} />}>
      <p className="answer-step-title">{documentsReadText(t, row.documents, nameOf)}</p>
      <SourceList sources={row.sources} />
    </Step>
  );
}

function SourceList({ sources }: { sources: StepSource[] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, SHOWN_SOURCES);
  const more = sources.length - shown.length;
  if (sources.length === 0) return null;
  return (
    <ul className="answer-step-sources">
      {shown.map((source) => (
        <li key={`${source.marker}`}>
          <SourceRow source={source} />
        </li>
      ))}
      {more > 0 && (
        <li>
          <button
            type="button"
            data-testid="answer-step-sources-more"
            onClick={() => setAll(true)}
            className="answer-step-source answer-step-detail"
          >
            {t("steps.sources.more", { count: more })}
          </button>
        </li>
      )}
    </ul>
  );
}

function useDocumentNames(): (document: ReadDocument) => string | null {
  const documents = useAppStore((state) => state.documents);
  return ({ documentId, name }) =>
    shownDocumentName({ documentId, documentName: name }, documents) || name;
}

/** The kind of the one Document `documents` holds, for its icon; none for several. */
function useOnlyDocumentKind(documents: readonly ReadDocument[]) {
  return useAppStore((state) =>
    documents.length === 1
      ? state.documents.find((document) => document.id === documents[0]?.documentId)?.kind
      : undefined,
  );
}

/** A source of a step: its Document and Location, which open beside the Mind as its Citation does. */
function SourceRow({ source }: { source: StepSource }) {
  const t = useT();
  const kind = useAppStore(
    (state) => state.documents.find((document) => document.id === source.documentId)?.kind,
  );
  const name = useAppStore(
    (state) => shownDocumentName(source, state.documents) || source.documentName,
  );
  const location = citationLocation(source);
  const where = location ? formatLocation(location, t) : null;
  return (
    <button
      type="button"
      data-testid="answer-step-source"
      data-document-id={source.documentId}
      title={where ? t("citation.where", { document: name, location: where }) : name}
      onClick={() =>
        void openCitedFollowing(
          source,
          { check: source.check, withQuote: quoteSaysSo(source.check), label: where },
          null,
        )
      }
      className="answer-step-source"
    >
      <DocumentLineIcon kind={kind ?? "text"} className="answer-step-source-icon" />
      <span className="answer-step-source-name">{name}</span>
      {where && <span className="answer-step-detail answer-step-source-where">{where}</span>}
    </button>
  );
}

/** A Document read that failed: its own words, never a search's settings. */
function FailedRead({ call, onRegenerate }: { call: AnswerToolCall; onRegenerate(): void }) {
  const t = useT();
  return (
    <ProblemLine
      testId="answer-step-failed"
      title={call.error?.message}
      action={{ label: t("answer.error.retry"), onClick: onRegenerate }}
      className="answer-step-problem"
    >
      {t("steps.failed.readDocument", { document: field(call, "document") })}
    </ProblemLine>
  );
}

/** A search that failed: one line in plain words, and the one way on. */
function FailedSearch({
  call,
  scope,
  onRegenerate,
}: {
  call: AnswerToolCall;
  scope: string;
  onRegenerate(): void;
}) {
  const t = useT();
  const refused = call.error?.kind === "auth";
  return (
    <ProblemLine
      testId="answer-step-failed"
      title={call.error?.message}
      action={
        refused
          ? {
              label: t("answer.error.checkKey"),
              onClick: () => useAppStore.getState().openSettings("search"),
            }
          : { label: t("answer.error.retry"), onClick: onRegenerate }
      }
      className="answer-step-problem"
    >
      {t(refused ? "steps.failed.search.auth" : "steps.failed.search", { scope })}
    </ProblemLine>
  );
}

/** The Citations checked against their sources: all found, or how many weren't, with the margin's mark. */
function CheckStep({
  count,
  notFound,
  running,
}: {
  count: number;
  notFound: number;
  running?: boolean | undefined;
}) {
  const t = useT();
  if (running) {
    return (
      <Step kind="check" icon={null} running>
        <p className="answer-step-title">{checkingWords(t, count)}</p>
      </Step>
    );
  }
  const allFound = notFound === 0;
  const result = allFound
    ? t(count === 1 ? "steps.check.found" : "steps.check.allFound")
    : t("steps.check.notFound", { count: notFound });
  return (
    <Step
      kind="check"
      icon={
        <CheckMarkIcon
          check={allFound ? "found" : "not-found"}
          data-check={allFound ? "found" : "not-found"}
          className="answer-step-check"
        />
      }
    >
      <p className="answer-step-title">
        {checkedWords(t, count)}
        <span aria-hidden="true"> · </span>
        {result}
      </p>
    </Step>
  );
}

/** Whether a Question was asked from a Mind while its meeting was recording. */
function useAskedInMeeting(question: ConversationQuestion | undefined): boolean {
  const meetings = useMeetings((state) => state.meetings);
  const from = question?.askedFrom;
  if (!question || !from) return false;
  const at = Date.parse(question.createdAt);
  return meetings.some(
    (meeting) =>
      meeting.mindId === from.mindId &&
      meeting.startedAt !== null &&
      Date.parse(meeting.startedAt) <= at &&
      (meeting.stoppedAt === null || at <= Date.parse(meeting.stoppedAt)),
  );
}

/** What a Question searched, with `extra` scopes besides (see `stepsScope`). */
export function useStepsScopeOf(
  question: ConversationQuestion | undefined,
): (extra: number) => string {
  const t = useT();
  const folders = useAppStore((state) => state.folders);
  const groups = useAppStore((state) => state.library?.groups);
  const deletedGroups = useAppStore((state) => state.library?.deletedGroups);
  const tags = useAppStore((state) => state.tags);
  const documents = useAppStore((state) => state.documents);
  const chips = scopeChips(
    { folders, groups, deletedGroups, tags, documents },
    question?.scope ?? NO_SCOPE,
  );
  return (extra) => stepsScope(t, chips, extra);
}
