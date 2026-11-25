import type { Editor } from "@tiptap/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentSavedFile, NoteQuestion, NoteStep, NoteTurn } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { core, files } from "../../core";
import { KIND_LABELS, showFileLabelKey } from "../../fileInfo";
import { useT } from "../../i18n";
import { SAVED_OPEN_BUTTON, SAVED_SHOW_BUTTON, savedFileFailure } from "../../outputFiles";
import {
  askInNote,
  firstWordsOf,
  type NoteAsk,
  type NoteTrail,
  setColumnOpen,
  useNoteAsks,
  useNoteColumns,
  useNoteTrails,
  withoutCitations,
} from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { ChevronRightLineIcon, CloseLineIcon, CopyLineIcon } from "../lineIcons";
import { ProblemLine } from "../ProblemLine";
import { MoveConversation } from "./NoteAsk";
import { EndAction, FailureLine, Reply, useWaitingInNote } from "./NoteAskPill";
import { ASKS_NOTHING, OwnStepText, QuestionCard, useAnnounce, WaitingLine } from "./OwnAsk";

type Translate = ReturnType<typeof useT>;

/** Each Tool's step, while it is the one going and once it is done. */
const DOING: Partial<Record<string, MessageKey>> = {
  read_mind: "noteAsk.doing.read_mind",
  list_minds: "noteAsk.doing.list_minds",
  search: "noteAsk.doing.search",
  read_passages: "noteAsk.doing.read_passages",
  cite: "noteAsk.doing.cite",
  check_citations: "noteAsk.doing.cite",
  propose_changes: "noteAsk.doing.propose_changes",
  create_mind: "noteAsk.doing.create_mind",
  run_analysis: "noteAsk.doing.run_analysis",
  calculate: "noteAsk.doing.run_analysis",
  publish_canvas: "noteAsk.doing.publish_canvas",
  update_canvas: "noteAsk.doing.publish_canvas",
  save_as_word: "noteAsk.doing.save_as_word",
};
const DID: Partial<Record<string, MessageKey>> = {
  read_mind: "noteAsk.did.read_mind",
  list_minds: "noteAsk.did.list_minds",
  search: "noteAsk.did.search",
  read_passages: "noteAsk.did.read_passages",
  cite: "noteAsk.did.cite",
  check_citations: "noteAsk.did.cite",
  propose_changes: "noteAsk.did.propose_changes",
  create_mind: "noteAsk.did.create_mind",
  run_analysis: "noteAsk.did.run_analysis",
  calculate: "noteAsk.did.run_analysis",
  publish_canvas: "noteAsk.did.publish_canvas",
  update_canvas: "noteAsk.did.publish_canvas",
  save_as_word: "noteAsk.did.save_as_word",
};

/** The Tools whose steps make or change a Note the User may open. */
const MAKES = new Set(["create_mind", "propose_changes", "save_as_word"]);

/** The Documents a run read, each once: how many, and how many only in part. */
function readsOf(steps: readonly NoteStep[]) {
  const last = new Map<string, number | undefined>();
  for (const step of steps) {
    if (step.kind === "call" && step.documentId) last.set(step.documentId, step.part);
  }
  return { count: last.size, part: [...last.values()].filter((each) => each !== undefined).length };
}

const stepText = (step: NoteStep, t: Translate, going: boolean): string => {
  if (step.kind === "said") return firstWordsOf(step.text);
  if (step.kind === "own") return step.action.value;
  if (!going && step.tool === "read_passages" && step.part !== undefined) {
    return t("noteColumn.readPart", { summary: step.summary, part: step.part });
  }
  const key = (going ? DOING : DID)[step.tool];
  return key ? t(key, { summary: step.summary, agent: "" }) : t("noteAsk.did.other");
};

/** "claude-sonnet-5-5" as people say it: "Sonnet 5.5". */
export const shortModel = (id: string): string => {
  const found = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
  if (!found) return id;
  const [, family = "", major = "", minor] = found;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
};

/** Seconds since the request, less `waitedMs`. */
const secondsOf = (trail: NoteTrail, waitedMs = 0) =>
  Math.max(
    1,
    Math.floor(
      (Date.parse(trail.endedAt ?? new Date().toISOString()) -
        Date.parse(trail.startedAt) -
        waitedMs) /
        1000,
    ),
  );

/** How long it worked, the time its questions waited on the User left out. */
const workedOf = (trail: NoteTrail) => secondsOf(trail, trail.waitedMs);

/** The steps folded to one line: how many Documents it read of those it found, and how long it took. */
function foldedOf(trail: NoteTrail, t: Translate): string {
  const seconds = workedOf(trail);
  const { count, part } = readsOf(trail.steps);
  if (count === 0) return t("noteColumn.worked", { seconds });
  const total = Math.max(trail.documentsFound, count);
  if (part > 0) return t("noteColumn.readOf.part", { n: count, total, part, seconds });
  return t("noteColumn.readOf", { n: count, total, seconds });
}

/** One step as a line of the conversation: a step of the AI's own, or a Tool call or its words. */
function StepLine({ step, going }: { step: NoteStep; going: boolean }) {
  const t = useT();
  if (step.kind === "own") {
    return (
      <OwnStepText
        action={step.action}
        by={step.by}
        going={going || step.going}
        className="note-column-step"
      />
    );
  }
  return <span className="note-column-step">{stepText(step, t, going)}</span>;
}

/** Whether a step is one the AI took with a tool of its own and didn't ask about. */
export const unasked = (step: NoteStep) => step.kind === "own" && step.by === undefined;

/** The AI's own modes that ask nothing: its auto mode, and the one that skips every question. */

/** What a stopped run had done: what it read, as one line. */
function stoppedOf(steps: readonly NoteStep[], t: Translate): string {
  const what = readOf(steps, t);
  return what ? t("noteColumn.stopped", { what }) : t("noteColumn.stopped.nothing");
}

/** What a run read, in words: the Note and the Documents; null when it read none. */
function readOf(steps: readonly NoteStep[], t: Translate): string | null {
  const mind = steps.find((step) => step.kind === "call" && step.tool === "read_mind");
  const documents = [
    ...new Set(
      steps.flatMap((step) => (step.kind === "call" && step.documentId ? [step.summary] : [])),
    ),
  ];
  const [only] = documents;
  const named = mind?.kind === "call" ? mind.summary : null;
  return named && documents.length > 1
    ? t("noteColumn.what.mindAnd", { mind: named, count: documents.length })
    : named && only
      ? t("noteColumn.what.mindAndOne", { mind: named, document: only })
      : named
        ? t("noteColumn.what.mind", { mind: named })
        : documents.length > 1
          ? t("noteColumn.what.docs", { count: documents.length })
          : only
            ? t("noteColumn.what.doc", { document: only })
            : null;
}

/**
 * The Note's conversation, opened as a column at the Note's right (#3677): each request as a
 * bubble, its steps, what it made or changed, and its reply. While it is open the Note's one input
 * is at its foot, so the User reads and asks in one place.
 */
export function NoteColumn({
  mindId,
  editor,
  agent,
  input,
}: {
  mindId: string;
  editor: Editor;
  agent: string;
  input: ReactNode;
}) {
  const t = useT();
  return (
    <aside
      data-testid="note-column"
      aria-label={t("noteAsk.conversation")}
      className="note-column"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          setColumnOpen(mindId, false);
        }
      }}
    >
      <header className="note-column-head">
        <h2 className="note-column-title">{t("noteColumn.title")}</h2>
        <MoveConversation to="upward" className="note-column-icon" />
        <button
          type="button"
          data-testid="note-column-close"
          aria-label={t("noteColumn.close")}
          title={t("noteColumn.close")}
          // The input keeps the focus as it goes back to the Note's foot.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setColumnOpen(mindId, false)}
          className="note-column-icon"
        >
          <CloseLineIcon className="size-4" />
        </button>
      </header>
      <NoteConversationBody
        mindId={mindId}
        editor={editor}
        agent={agent}
        className="note-column-body"
      />
      <div className="note-column-foot">{input}</div>
    </aside>
  );
}

/**
 * The conversation's turns, newest in view, scrolling in their own place: the column's body, or
 * the panel that opens upward inside the input's box.
 */
export function NoteConversationBody({
  mindId,
  editor,
  agent,
  className,
}: {
  mindId: string;
  editor: Editor;
  agent: string;
  className: string;
}) {
  const t = useT();
  const waiting = useWaitingInNote(editor);
  const ask = useNoteAsks((state) => state.byMind[mindId]);
  const working = ask?.state === "working";
  const trails = useNoteTrails((state) => state.byTurn);
  const at = useNoteColumns((state) => state.at[mindId] ?? null);
  const body = useRef<HTMLDivElement>(null);
  const [turns, setTurns] = useState<readonly NoteTurn[] | null>(null);
  const changed = `${ask?.turnId ?? ""}:${ask?.state ?? ""}`;
  // Once in the conversation, above the first step the AI took with a tool of its own, a line says
  // it does so (#3653), unless that step asked, whose card said it already; and once, at the first
  // request its own mode asks nothing in.
  const firstStep = turns
    ?.flatMap((turn) =>
      (trails[turn.id]?.steps ?? []).flatMap((step) =>
        step.kind === "own" ? [{ turn: turn.id, step }] : [],
      ),
    )
    .at(0);
  const firstOwn = firstStep && unasked(firstStep.step) ? firstStep.turn : null;
  const modeTurn =
    turns?.find((turn) => ASKS_NOTHING.has(trails[turn.id]?.mode ?? turn.mode ?? ""))?.id ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as each request starts and ends.
  useEffect(() => {
    let current = true;
    core
      .noteConversation(mindId)
      .then((read) => {
        if (current) setTurns(read);
      })
      .catch(useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [mindId, changed]);

  const atEnd = useRef(true);
  // Opened from the foot line, it shows that reply; otherwise the newest is in view, as in every chat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows what it shows.
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const turn = at
      ? element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(at)}"]`)
      : null;
    atEnd.current = !turn;
    if (turn) element.scrollTop = turn.offsetTop - 8;
    else element.scrollTop = element.scrollHeight;
  }, [turns, trails, waiting, at, ask?.questions]);

  // With the newest in view, it stays in view in the same frame as anything above it grows or
  // shrinks (a turn above settling, say), not a moment later: a card's answers never move under a
  // press on its way to them.
  const sizes = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    // Only the User scrolling up leaves the end: content that grows before this hears of a scroll
    // makes the end look farther, though nothing moved.
    let was = element.scrollTop;
    const scrolled = () => {
      if (element.scrollHeight - element.scrollTop - element.clientHeight <= 2)
        atEnd.current = true;
      else if (element.scrollTop < was - 1) atEnd.current = false;
      was = element.scrollTop;
    };
    const observer = new ResizeObserver(() => {
      if (atEnd.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    sizes.current = observer;
    element.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      observer.disconnect();
      sizes.current = null;
      element.removeEventListener("scroll", scrolled);
    };
  }, []);
  useLayoutEffect(() => {
    for (const child of body.current?.children ?? []) {
      sizes.current?.observe(child, { box: "border-box" });
    }
  });

  return (
    <div ref={body} data-testid="note-conversation-body" className={className}>
      {turns?.length === 0 && (
        <p className="note-column-notice">{t("noteAsk.conversationEmpty")}</p>
      )}
      {turns?.map((turn, index) => (
        <Turn
          key={turn.id}
          mindId={mindId}
          turn={turn}
          trail={trails[turn.id]}
          agent={agent}
          questions={
            index === turns.length - 1 && working && ask?.turnId === turn.id
              ? ask.questions
              : turn.questions
          }
          first={turn.id === firstOwn}
          modeLine={turn.id === modeTurn}
          // The reply's one action, Accept all or Undo, is under the last reply, as the line's is.
          accept={
            index === turns.length - 1 && !working && ask && ask.turnId === turn.id ? (
              <EndAction ask={ask} mindId={mindId} editor={editor} named />
            ) : null
          }
          failed={
            index === turns.length - 1 && ask?.state === "failed" && ask.turnId === turn.id
              ? ask
              : null
          }
        />
      ))}
    </div>
  );
}

function Turn({
  mindId,
  turn,
  trail,
  agent,
  questions,
  first,
  modeLine,
  accept,
  failed,
}: {
  mindId: string;
  turn: NoteTurn;
  trail?: NoteTrail;
  agent: string;
  questions: readonly NoteQuestion[];
  first: boolean;
  modeLine: boolean;
  accept: ReactNode;
  /** The request, while this turn is its newest and failed: its line has the one thing to do. */
  failed: NoteAsk | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const state = trail?.state ?? (turn.outcome === "working" ? "working" : turn.outcome);
  const steps = (trail?.steps ?? []).filter(
    // The reply's own words come as a line too: the reply shows them.
    (step) => !(step.kind === "said" && turn.reply !== "" && turn.reply.startsWith(step.text)),
  );
  const made = steps.filter((step) => madeKind(step) !== null);
  // A step that didn't run for the stop already says it stopped: the line goes, unless it says
  // what the run had read.
  const stopSaid =
    steps.some((step) => step.kind === "own" && step.by === "stopped") && readOf(steps, t) === null;
  return (
    <div data-testid="note-column-turn" data-turn-id={turn.id} className="note-column-turn">
      {trail?.fresh && <p className="note-column-notice">{t("noteAsk.fresh")}</p>}
      {trail?.renewed && (
        <p data-testid="note-column-renewed" className="note-column-notice">
          {t("noteAsk.renewed", { agent })}
        </p>
      )}
      <div className="note-column-bubble">
        {turn.quote !== "" && <p className="note-column-bubble-quote">“{turn.quote}”</p>}
        <p>{turn.request}</p>
      </div>
      {modeLine && (
        <p data-testid="own-mode" className="note-column-notice">
          {t(`ownAsk.mode.${trail?.mode ?? turn.mode}` as MessageKey, { agent })}
        </p>
      )}
      {state === "working" && trail && (
        <LiveSteps
          trail={trail}
          steps={steps}
          first={first}
          question={questions[0]}
          agent={agent}
        />
      )}
      {state === "working" && questions[0] && (
        <QuestionCard question={questions[0]} agent={agent} mindId={mindId} />
      )}
      {/* What it did with its own tools before it stopped or failed, a file it wrote among them. */}
      {(state === "stopped" || state === "failed") &&
        trail &&
        steps.some((step) => step.kind === "own") && (
          <ol data-testid="note-column-own-steps" className="note-column-list">
            {steps
              .filter((step) => step.kind === "own")
              .map((step, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: steps never reorder
                <li key={index} className="note-column-step-item">
                  <StepLine step={step} going={false} />
                </li>
              ))}
          </ol>
        )}
      {state === "stopped" &&
        !stopSaid &&
        (turn.closed.length > 0 && !trail ? (
          <ol data-testid="note-column-interrupted" className="note-column-list own-closed">
            {turn.closed.map((action, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: what was asked never reorders
              <li key={index} className="note-column-step-item">
                <OwnStepText action={action} by="closed" className="note-column-step" />
                {/* The words it was asked about can't be selected again for it: only a request
                    on the whole Note is sent again, or its changes would apply unlimited. */}
                {index === turn.closed.length - 1 && turn.quote === "" && (
                  <button
                    type="button"
                    data-testid="own-ask-again"
                    onClick={() =>
                      void askInNote(mindId, {
                        words: turn.request,
                        quote: "",
                        selection: null,
                      }).catch(useAppStore.getState().reportError)
                    }
                    className="note-ask-pill-action"
                  >
                    {t("ownAsk.askAgain")}
                  </button>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p data-testid="note-column-interrupted" className="note-column-interrupted">
            {/* What a run read lives in the window: after a restart only that it stopped is known. */}
            {trail ? stoppedOf(steps, t) : t("noteAsk.stopped")}
          </p>
        ))}
      {state === "failed" &&
        turn.problem &&
        (failed ? (
          <FailureLine
            ask={failed}
            mindId={mindId}
            className="note-column-interrupted"
            turn={{ request: turn.request, quote: turn.quote }}
          />
        ) : (
          <p className="note-column-interrupted">
            {t(`noteAsk.problem.${turn.problem}`, { agent, found: "", lowest: "" })}
          </p>
        ))}
      {state === "landed" && trail && (
        <div className="note-column-steps">
          <button
            type="button"
            data-testid="note-column-steps-toggle"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
            className="answer-steps-line note-column-fold"
          >
            <span className="answer-steps-text">{foldedOf(trail, t)}</span>
            <ChevronRightLineIcon
              className={`answer-steps-icon ${open ? "rotate-90" : ""}`}
              aria-hidden="true"
            />
          </button>
          {open ? (
            <ol className="note-column-list">
              {steps.map((step, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: steps never reorder
                <li key={index} className="note-column-step-item">
                  {first && step === steps.find(unasked) && <FirstOwnLine agent={agent} />}
                  <StepLine step={step} going={false} />
                  {madeKind(step) && <MadeCard step={step} />}
                </li>
              ))}
              {trail.model && (
                <li className="note-column-step">
                  {t("noteColumn.answered", {
                    model: shortModel(trail.model),
                    seconds: workedOf(trail),
                  })}
                </li>
              )}
            </ol>
          ) : (
            made.length > 0 && (
              <div className="note-column-made">
                {made.map((step, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps never reorder
                  <MadeCard key={index} step={step} />
                ))}
              </div>
            )
          )}
        </div>
      )}
      {state === "landed" && turn.reply !== "" && (
        <div data-testid="note-column-reply" className="note-column-reply">
          <Reply text={turn.reply} citations={turn.citations} />
          <div className="note-column-reply-foot">
            <span className="note-column-reply-meta">
              <button
                type="button"
                data-testid="note-column-copy"
                aria-label={t("noteColumn.copy")}
                title={t("noteColumn.copy")}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(withoutCitations(turn.reply))
                    .catch(useAppStore.getState().reportError)
                }
                className="note-column-icon"
              >
                <CopyLineIcon className="size-3.5" />
              </button>
              {trail?.model && <span>{shortModel(trail.model)}</span>}
            </span>
          </div>
        </div>
      )}
      {accept && <div className="note-column-accept">{accept}</div>}
    </div>
  );
}

const madeKind = (step: NoteStep): "note" | "changed" | "file" | null => {
  if (step.kind !== "call" || !MAKES.has(step.tool) || step.done === false) return null;
  if (step.tool === "create_mind") return "note";
  if (step.tool === "propose_changes" && step.mindId && step.waiting) return "changed";
  if (step.tool === "save_as_word" && step.file) return "file";
  return null;
};

/** A file the AI saved for the User (#3751): opened or shown, as a file Export saved is. */
function SavedFileCard({ file }: { file: AgentSavedFile }) {
  const t = useT();
  const [problem, setProblem] = useState<string | null>(null);
  const run = (
    act: (path: string) => Promise<void>,
    failed: "export.failed.open" | "export.failed.show",
  ) => {
    setProblem(null);
    act(file.path).catch((failure: unknown) => setProblem(savedFileFailure(failure, failed, t)));
  };
  return (
    <div data-testid="note-column-saved" className="note-column-made-card note-column-saved">
      <div className="note-column-saved-row">
        <span className="note-column-saved-what">
          <span className="note-column-made-title" title={file.name}>
            {file.name}
          </span>
          <span data-testid="note-column-saved-kind" className="note-column-made-kind">
            {t(KIND_LABELS.docx)}
          </span>
        </span>
        <span className="note-column-saved-actions">
          <button
            type="button"
            data-testid="note-column-saved-open"
            onClick={() => run(files.openSavedFile, "export.failed.open")}
            className={SAVED_OPEN_BUTTON}
          >
            {t("export.open")}
          </button>
          <button
            type="button"
            data-testid="note-column-saved-show"
            onClick={() => run(files.showSavedFile, "export.failed.show")}
            className={SAVED_SHOW_BUTTON}
          >
            {t(showFileLabelKey(navigator.platform))}
          </button>
        </span>
      </div>
      {problem && (
        <ProblemLine testId="note-column-saved-problem" className="w-full">
          {problem}
        </ProblemLine>
      )}
    </div>
  );
}

/** What the AI made or changed, other than the Note in front: a press opens it. */
function MadeCard({ step }: { step: NoteStep }) {
  const t = useT();
  const kind = madeKind(step);
  const minds = useAppStore((state) => state.minds);
  if (step.kind !== "call" || !kind) return null;
  if (kind === "file") return step.file ? <SavedFileCard file={step.file} /> : null;
  const mindId =
    step.mindId ?? minds.find((each) => kind === "note" && each.title === step.summary)?.id;
  const what =
    kind === "note"
      ? t("noteColumn.made.note")
      : t(step.waiting === 1 ? "noteColumn.made.waiting.one" : "noteColumn.made.waiting.other", {
          count: step.waiting ?? 0,
        });
  return (
    <button
      type="button"
      data-testid="note-column-made"
      onClick={() => {
        if (mindId) useAppStore.getState().openMind(mindId);
      }}
      className="note-column-made-card"
    >
      <span className="note-column-made-title">{step.summary}</span>
      <span className="note-column-made-kind">{what}</span>
    </button>
  );
}

/** Said once in a conversation, above the first step the AI took with a tool of its own unasked. */
function FirstOwnLine({ agent }: { agent: string }) {
  const t = useT();
  return (
    <p data-testid="own-first" className="own-first">
      {t("ownAsk.first", { agent })}
    </p>
  );
}

/**
 * The steps as they happen: each done one in the past tense, the one going grey and in the
 * present; while the AI's question waits, the waiting line in the going one's place (#3653).
 */
function LiveSteps({
  trail,
  steps,
  first,
  question,
  agent,
}: {
  trail: NoteTrail;
  steps: readonly NoteStep[];
  first: boolean;
  question: NoteQuestion | undefined;
  agent: string;
}) {
  const t = useT();
  const announce = useAnnounce(question, agent);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const thinking = trail.doing?.kind === "thinking";
  const last = steps.at(-1) ?? null;
  // A step of its own that waits on the question is listed only once it is answered.
  const shown =
    question && last?.kind === "own" && last.by === undefined ? steps.slice(0, -1) : steps;
  const done = thinking || question ? shown : shown.slice(0, -1);
  const going = thinking || question ? null : (shown.at(-1) ?? null);
  const seconds = secondsOf(trail);
  const reads = readsOf(steps).count;
  const total = Math.max(trail.documentsFound, reads);
  const firstOwn = first ? steps.find(unasked) : undefined;
  const time =
    seconds >= 3 ? (
      <span className="note-ask-pill-time">{t("noteAsk.seconds", { count: seconds })}</span>
    ) : null;
  return (
    <ol data-testid="note-column-live" className="note-column-list">
      {done.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps never reorder
        <li key={index} className="note-column-step-item">
          {step === firstOwn && <FirstOwnLine agent={agent} />}
          <StepLine step={step} going={false} />
          {madeKind(step) && <MadeCard step={step} />}
        </li>
      ))}
      {question ? (
        <li
          data-testid="own-waiting"
          className="note-column-step note-column-step--now own-waiting"
        >
          <WaitingLine
            seconds={seconds >= 3 ? t("noteAsk.seconds", { count: seconds }) : null}
            announce={announce}
          />
        </li>
      ) : (
        <>
          {going === firstOwn && going && <FirstOwnLine agent={agent} />}
          <li className="note-column-step note-column-step--now">
            <span aria-hidden="true" className="note-ask-dots">
              <span />
              <span />
              <span />
            </span>
            {going?.kind === "own" ? (
              <OwnStepText action={going.action} by={going.by} going className="min-w-0 flex-1" />
            ) : (
              <span className="min-w-0 flex-1 truncate">
                {going?.kind === "call" && going.tool === "read_passages" && total > 1
                  ? t("noteAsk.doing.read_passages.of", {
                      n: reads,
                      total,
                      summary: going.summary,
                    })
                  : going
                    ? stepText(going, t, true)
                    : t(thinking ? "noteAsk.pill.thinking" : "noteAsk.pill.working")}
              </span>
            )}
            {time}
          </li>
        </>
      )}
    </ol>
  );
}
