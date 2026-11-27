import type { Editor } from "@tiptap/react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NoteQuestion, NoteStep, NoteTurn } from "../../../../core/api";
import { formatDateTime } from "../../../../shared/dates";
import type { MessageKey } from "../../../../shared/i18n";
import { mindName } from "../../../../shared/naming";
import { useLanguage, useT } from "../../i18n";
import {
  askAgainInNote,
  discardInNote,
  editRequest,
  firstWordsOf,
  isGoing,
  type NoteAsk,
  type NoteTrail,
  sendUnsent,
  setColumnOpen,
  useNoteAsks,
  useNoteColumns,
  useNoteTrails,
  withoutCitations,
} from "../../ownAiInNote";
import { useAppStore } from "../../store";
import {
  AskArrowIcon,
  ChevronRightLineIcon,
  CopyLineIcon,
  MindLineIcon,
  PencilLineIcon,
  RetryLineIcon,
  TrashLineIcon,
} from "../icons";
import { SidebarToggle } from "../SidebarToggle";
import { ConversationMenu } from "./ConversationMenu";
import { EndAction, FailureLine, useWaitingInNote } from "./NoteAskPill";
import { ASKS_NOTHING, OwnStepText, QuestionCard, useAnnounce, WaitingLine } from "./OwnAsk";
import { Reply } from "./Reply";
import { SavedFileCard } from "./SavedFileCard";

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
 * The Note's conversation, opened as the window's column beside the tab groups (#3677, #3759):
 * each request as a bubble, its steps, what it made or changed, and its reply. While it is open the
 * Note's one input is at its foot, so the User reads and asks in one place.
 */
export function NoteColumn({
  mindId,
  pairingId,
  conversationId,
  editor,
  agent,
  turns,
  input,
}: {
  mindId: string;
  pairingId: string;
  conversationId: string | null;
  editor: Editor;
  agent: string;
  turns: readonly NoteTurn[] | null;
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
          setColumnOpen(false);
        }
      }}
    >
      <header className="note-column-head">
        <SidebarToggle place="band" />
        <ConversationMenu
          mindId={mindId}
          pairingId={pairingId}
          conversationId={conversationId}
          place="column"
          canMove
          onHide={() => setColumnOpen(false)}
        />
      </header>
      <NoteConversationBody
        mindId={mindId}
        conversationId={conversationId}
        editor={editor}
        agent={agent}
        turns={turns}
        className="note-column-body"
      />
      <div className="note-column-foot">{input}</div>
    </aside>
  );
}

/** Marks the turns scrolled past their start, where their top fades out (styles.css). */
const markScrolled = (element: HTMLElement) =>
  element.toggleAttribute("data-scrolled", element.scrollTop > 0);

/**
 * Gives the last of the turns the turns' whole height, so at their end it starts under the top
 * row (#3765): the newest request sent here once they overflow, as a chat moves a request up when
 * it is sent, rather than below the tail of the turn before it.
 */
const roomForNewest = (element: HTMLElement) => {
  element.style.removeProperty("--newest-room");
  const last = element.lastElementChild;
  if (!last?.hasAttribute("data-newest")) return;
  if (element.scrollHeight <= element.clientHeight) return;
  const style = getComputedStyle(element);
  const most = Number.parseFloat(style.maxHeight);
  const room =
    (Number.isNaN(most) ? element.clientHeight : Math.max(most, element.clientHeight)) -
    Number.parseFloat(style.paddingTop) -
    Number.parseFloat(style.paddingBottom);
  element.style.setProperty("--newest-room", `${room}px`);
};

/**
 * The conversation's turns, `turns` as read while it is open (null until then), newest in view,
 * scrolling in their own place: the column's body, or the panel that opens upward inside the
 * input's box.
 */
export function NoteConversationBody({
  mindId,
  conversationId,
  editor,
  agent,
  turns,
  className,
}: {
  mindId: string;
  conversationId: string | null;
  editor: Editor;
  agent: string;
  turns: readonly NoteTurn[] | null;
  className: string;
}) {
  const t = useT();
  const waiting = useWaitingInNote(editor);
  const ask = useNoteAsks((state) =>
    conversationId !== null ? state.byConversation[conversationId] : state.pendingByMind[mindId],
  );
  const working = ask?.state === "working";
  const going = isGoing(ask);
  const trails = useNoteTrails((state) => state.byTurn);
  const ranAt =
    turns
      ?.map((turn) => turn.outcome !== "waiting" && turn.outcome !== "unsent")
      .lastIndexOf(true) ?? -1;
  const at = useNoteColumns((state) => state.at);
  const body = useRef<HTMLDivElement>(null);
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

  const atEnd = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows what it shows.
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const turn = at
      ? element.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(at)}"]`)
      : null;
    atEnd.current = !turn;
    roomForNewest(element);
    if (turn) element.scrollTop = turn.offsetTop - 8;
    else element.scrollTop = element.scrollHeight;
    markScrolled(element);
  }, [turns, trails, waiting, at, ask?.questions]);

  const sizes = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    let was = element.scrollTop;
    const scrolled = () => {
      if (element.scrollHeight - element.scrollTop - element.clientHeight <= 2)
        atEnd.current = true;
      else if (element.scrollTop < was - 1) atEnd.current = false;
      was = element.scrollTop;
      markScrolled(element);
    };
    const observer = new ResizeObserver(() => {
      roomForNewest(element);
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
          conversationId={conversationId}
          turn={turn}
          showNoteLabel={index === 0 || turns[index - 1]?.mindId !== turn.mindId}
          trail={trails[turn.id]}
          agent={agent}
          questions={working && ask?.turnId === turn.id ? ask.questions : turn.questions}
          first={turn.id === firstOwn}
          modeLine={turn.id === modeTurn}
          newest={
            index === turns.length - 1 &&
            (ask?.turnId === turn.id || (ask?.queued.includes(turn.id) ?? false))
          }
          // Accept all and Undo appear only when the edited Note is the one in front (#3731).
          accept={
            index === ranAt && !going && ask && ask.turnId === turn.id && turn.mindId === mindId ? (
              <EndAction ask={ask} mindId={mindId} editor={editor} named />
            ) : null
          }
          changedInTurn={Math.max(
            turn.changedCount,
            trails[turn.id]?.changed ?? 0,
            ask?.turnId === turn.id ? ask.changed : 0,
          )}
          failed={index === ranAt && ask?.state === "failed" && ask.turnId === turn.id ? ask : null}
        />
      ))}
    </div>
  );
}

function Turn({
  mindId,
  conversationId,
  turn,
  showNoteLabel,
  trail,
  agent,
  questions,
  first,
  modeLine,
  newest,
  accept,
  changedInTurn,
  failed,
}: {
  mindId: string;
  conversationId: string | null;
  turn: NoteTurn;
  /** First turn or switched Note since previous turn: show which Note it was asked from (#3731). */
  showNoteLabel: boolean;
  trail?: NoteTrail;
  agent: string;
  questions: readonly NoteQuestion[];
  first: boolean;
  modeLine: boolean;
  newest: boolean;
  accept: ReactNode;
  changedInTurn: number;
  failed: NoteAsk | null;
}) {
  const t = useT();
  const minds = useAppStore((state) => state.minds);
  const [open, setOpen] = useState(false);
  const state = trail?.state ?? (turn.outcome === "working" ? "working" : turn.outcome);
  const steps = (trail?.steps ?? []).filter(
    (step) => !(step.kind === "said" && turn.reply !== "" && turn.reply.startsWith(step.text)),
  );
  const made = steps.filter((step) => madeKind(step) !== null);
  const liveTurnMind = minds.find((each) => each.id === turn.mindId);
  const turnNoteTitle = (liveTurnMind && mindName(liveTurnMind)) || turn.mindTitle;
  const editedElsewhere =
    state === "landed" && turn.mindId !== "" && turn.mindId !== mindId && changedInTurn > 0;
  const stopSaid =
    steps.some((step) => step.kind === "own" && step.by === "stopped") && readOf(steps, t) === null;
  const elsewhereCard = editedElsewhere ? (
    <ChangedElsewhereCard
      mindId={turn.mindId}
      title={turnNoteTitle}
      deleted={turn.mindDeleted && !liveTurnMind}
      count={changedInTurn}
    />
  ) : null;
  return (
    <div
      data-testid="note-column-turn"
      data-turn-id={turn.id}
      data-newest={newest || undefined}
      className="note-column-turn"
    >
      {trail?.fresh && <p className="note-column-notice">{t("noteAsk.fresh")}</p>}
      {trail?.renewed && (
        <p data-testid="note-column-renewed" className="note-column-notice">
          {t("noteAsk.renewed", { agent })}
        </p>
      )}
      <div className="note-column-sent">
        {showNoteLabel && turnNoteTitle !== "" && (
          <span
            data-testid="note-column-turn-note"
            title={turnNoteTitle}
            className="note-column-turn-note"
          >
            <MindLineIcon aria-hidden="true" />
            <span className="truncate">{turnNoteTitle}</span>
          </span>
        )}
        <div className="note-column-bubble">
          {turn.quote !== "" && <p className="note-column-bubble-quote">“{turn.quote}”</p>}
          <p>{turn.request}</p>
        </div>
        {state === "waiting" ? (
          <Waiting words={turn.request} />
        ) : state === "unsent" ? (
          <NotSent mindId={mindId} conversationId={conversationId} turn={turn} />
        ) : (
          <SentActions mindId={mindId} conversationId={conversationId} turn={turn} />
        )}
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
        <QuestionCard
          question={questions[0]}
          agent={agent}
          mindId={mindId}
          conversationId={conversationId}
        />
      )}
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
      {(state === "stopped" || state === "failed") && <MadeCards steps={made} />}
      {state === "stopped" &&
        !stopSaid &&
        (turn.closed.length > 0 && !trail ? (
          <ol data-testid="note-column-interrupted" className="note-column-list own-closed">
            {turn.closed.map((action, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: what was asked never reorders
              <li key={index} className="note-column-step-item">
                <OwnStepText action={action} by="closed" className="note-column-step" />
                {index === turn.closed.length - 1 && turn.quote === "" && (
                  <button
                    type="button"
                    data-testid="own-ask-again"
                    onClick={() =>
                      void askAgainInNote(
                        mindId,
                        { words: turn.request, quote: "", selection: null },
                        conversationId,
                      ).catch(useAppStore.getState().reportError)
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
          {open && (
            <ol className="note-column-list">
              {steps.map((step, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: steps never reorder
                <li key={index} className="note-column-step-item">
                  {first && step === steps.find(unasked) && <FirstOwnLine agent={agent} />}
                  <StepLine step={step} going={false} />
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
          )}
        </div>
      )}
      {/* What it made or changed, under the reply's words, or under its steps when it wrote none. */}
      {state === "landed" && turn.reply === "" && (
        <>
          {elsewhereCard}
          <MadeCards steps={made} />
        </>
      )}
      {state === "landed" && turn.reply !== "" && (
        <div data-testid="note-column-reply" className="note-column-reply">
          <Reply text={turn.reply} citations={turn.citations} />
          {elsewhereCard}
          <MadeCards steps={made} />
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
                <CopyLineIcon />
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

/**
 * Change card for a turn that edited a Note not currently in front (#3731): names the Note and
 * offers Open, never Undo or Accept all.
 */
function ChangedElsewhereCard({
  mindId,
  title,
  deleted,
  count,
}: {
  mindId: string;
  title: string;
  deleted: boolean;
  count: number;
}) {
  const t = useT();
  const what = t(count === 1 ? "noteColumn.changed.one" : "noteColumn.changed.other", { count });
  return (
    <div className="note-column-made">
      <button
        type="button"
        data-testid="note-column-changed-elsewhere"
        disabled={deleted}
        onClick={() => {
          if (!deleted) useAppStore.getState().openMind(mindId);
        }}
        className="note-column-made-card"
      >
        <span className="note-column-made-icon" aria-hidden="true">
          <MindLineIcon />
        </span>
        <span className="note-column-made-text">
          <span className="note-column-made-title">{title}</span>
          <span className="note-column-made-kind">{what}</span>
        </span>
        {!deleted && <span className="note-column-made-open">{t("noteColumn.made.open")}</span>}
      </button>
    </div>
  );
}

function SentActions({
  mindId,
  conversationId,
  turn,
}: {
  mindId: string;
  conversationId: string | null;
  turn: NoteTurn;
}) {
  const t = useT();
  const language = useLanguage();
  const report = useAppStore.getState().reportError;
  return (
    <div data-testid="note-column-sent-actions" className="note-column-sent-actions">
      <span className="note-column-sent-time">{formatDateTime(turn.at, language)}</span>
      {turn.quote === "" && (
        <button
          type="button"
          data-testid="note-column-send-again"
          aria-label={t("noteColumn.sendAgain")}
          title={t("noteColumn.sendAgain")}
          onClick={() =>
            void askAgainInNote(
              mindId,
              { words: turn.request, quote: "", selection: null },
              conversationId,
            ).catch(report)
          }
          className="note-column-icon"
        >
          <RetryLineIcon />
        </button>
      )}
      <EditRequest words={turn.request} />
      <CopyRequest words={turn.request} />
    </div>
  );
}

/** Puts a request's words back in the input, to change and send as a new request. */
function EditRequest({ words }: { words: string }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="note-column-edit"
      aria-label={t("noteColumn.edit")}
      title={t("noteColumn.edit")}
      onClick={() => editRequest(words)}
      className="note-column-icon"
    >
      <PencilLineIcon />
    </button>
  );
}

function CopyRequest({ words }: { words: string }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="note-column-copy-request"
      aria-label={t("noteColumn.copy")}
      title={t("noteColumn.copy")}
      onClick={() =>
        void navigator.clipboard.writeText(words).catch(useAppStore.getState().reportError)
      }
      className="note-column-icon"
    >
      <CopyLineIcon />
    </button>
  );
}

function Waiting({ words }: { words: string }) {
  const t = useT();
  return (
    <div data-testid="note-column-waiting" className="note-column-sent-state" data-waiting="">
      <span aria-hidden="true" className="note-ask-dots">
        <span />
        <span />
        <span />
      </span>
      <span role="status" className="note-column-sent-word">
        {t("noteColumn.waiting")}
      </span>
      <CopyRequest words={words} />
    </div>
  );
}

function NotSent({
  mindId,
  conversationId,
  turn,
}: {
  mindId: string;
  conversationId: string | null;
  turn: NoteTurn;
}) {
  const t = useT();
  const report = useAppStore.getState().reportError;
  return (
    <div data-testid="note-column-not-sent" className="note-column-sent-state">
      <span className="note-column-sent-word">{t("noteColumn.notSent")}</span>
      <button
        type="button"
        data-testid="note-column-send"
        aria-label={t("noteAsk.send")}
        title={t("noteAsk.send")}
        onClick={() => {
          if (conversationId) void sendUnsent(conversationId, mindId, turn).catch(report);
        }}
        className="note-column-icon"
      >
        <AskArrowIcon />
      </button>
      <EditRequest words={turn.request} />
      <CopyRequest words={turn.request} />
      <button
        type="button"
        data-testid="note-column-discard"
        aria-label={t("noteColumn.discard")}
        title={t("noteColumn.discard")}
        onClick={() => {
          if (conversationId) void discardInNote(conversationId, turn.id).catch(report);
        }}
        className="note-column-icon"
      >
        <TrashLineIcon />
      </button>
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

/** What a reply made or changed, other than the Note in front, a card each. */
function MadeCards({ steps }: { steps: readonly NoteStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="note-column-made">
      {steps.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps never reorder
        <MadeCard key={index} step={step} />
      ))}
    </div>
  );
}

/** A card for what the AI made or changed: its kind's icon, its name and kind; a press opens it. */
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
      <span className="note-column-made-icon" aria-hidden="true">
        <MindLineIcon />
      </span>
      <span className="note-column-made-text">
        <span className="note-column-made-title">{step.summary}</span>
        <span className="note-column-made-kind">{what}</span>
      </span>
      <span className="note-column-made-open">{t("noteColumn.made.open")}</span>
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
