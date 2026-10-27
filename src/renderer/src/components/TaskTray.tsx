import { isMacOS } from "@tiptap/core";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ApprovalRequest, Task, TaskEffect } from "../../../core/api";
import { useApprovals } from "../approvals";
import { keysLabel } from "../commands/keys";
import { NO_MIND } from "../composer";
import { useConversations } from "../conversations";
import { ApprovalCard } from "../editor/AnswerView";
import { withShortcut } from "../editor/withShortcut";
import { useT } from "../i18n";
import { saidInLine } from "../lineNames";
import type { Translate } from "../objects";
import { useQuestionRoom } from "../questionRoom";
import { useQuestions } from "../questions";
import { useResearch } from "../research";
import { answerTaskAsk, loadTasks, useTasks } from "../tasks";
import { QuestionCard } from "./assistant/QuestionCard";
import { QueuedMessages } from "./QueuedMessages";
import { ResearchPlanCard } from "./ResearchPlanCard";
import { ResearchPlanView } from "./ResearchPlanView";

/** The share of the assistant's column the tray may take (DESIGN.md, Task tray). */
const TRAY_SHARE = 0.4;
/** The least the tray takes with an ask, room allowing: its count, its title and its buttons. */
const MIN_TRAY = 220;
/** The least it takes in a short column: its buttons stay in reach, the ask scrolling above them. */
const MIN_ROOM = 56;
/** What the conversation keeps above the tray and the composer, at the least: a few lines (#678). */
const MIN_THREAD = 120;
/** While the assistant's question waits, the conversation gives it room for its options: the Question's line stays. */
const MIN_THREAD_ASKING = 40;

const ALLOW_KEYS = "CmdOrCtrl+Enter";

function hiddenIn(card: HTMLElement): number {
  const head = card.querySelector<HTMLElement>(".approval-head");
  const options = card.querySelector<HTMLElement>(".choice-options");
  const cap = options ? Number.parseFloat(getComputedStyle(options).maxHeight) : Number.NaN;
  const rows = options
    ? Math.max(
        0,
        Math.min(options.scrollHeight + options.clientTop, cap || Infinity) - options.offsetHeight,
      )
    : 0;
  return (
    (head ? head.scrollHeight - head.clientHeight : 0) +
    rows +
    (card.scrollHeight - card.clientHeight)
  );
}

const isCommand = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

/** What an Effect was, in the ask: the file's name, or the Connector and its Tool. */
function effectText(effect: TaskEffect, t: Translate): string {
  if (effect.kind === "file-write") {
    const name = effect.path.split(/[\\/]/).pop() ?? effect.path;
    return t("task.unknown.file", { name });
  }
  return t("task.unknown.connector", { connector: effect.connectorName, tool: effect.tool });
}

/** IncarnaMind can't tell whether an Effect happened: do it again, or go on without it. */
function UnknownOutcomeCard({ task, effect }: { task: Task; effect: TaskEffect }) {
  const t = useT();
  const explained = saidInLine(t, (t) => effectText(effect, t));
  const titleId = useId();
  const mac = isMacOS();
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      data-testid="task-unknown-card"
      className="approval-card"
    >
      <div className="approval-head">
        <p id={titleId} className="approval-title">
          <span aria-hidden="true" className="approval-dot" />
          <span className="approval-title-text">{t("task.unknown.title")}</span>
        </p>
        <p title={explained.fullMessage} className="approval-explanation">
          {explained.message}
        </p>
      </div>
      <div className="approval-actions task-ask-actions">
        <button
          type="button"
          data-testid="task-redo"
          data-allow
          onClick={() => answerTaskAsk(task.id, "redo")}
          className="approval-button approval-button--primary"
          {...withShortcut(t("task.unknown.redo"), keysLabel(ALLOW_KEYS, mac))}
        >
          {t("task.unknown.redo")}
          <span className="approval-keys">{keysLabel(ALLOW_KEYS, mac)}</span>
        </button>
        <button
          type="button"
          data-testid="task-skip"
          data-deny
          onClick={() => answerTaskAsk(task.id, "skip")}
          className="approval-button"
        >
          {t("task.unknown.skip")}
        </button>
      </div>
    </div>
  );
}

/**
 * ⌘↵ or ⌘⌫ in the composer: the Mind's waiting ask is answered as its first
 * or last button would. False when none waits.
 */
export function answerAskFrom(mindId: string, allow: boolean): boolean {
  const task = Object.values(useTasks.getState().tasks).find(
    (each) => each.mindId === mindId && each.finishedAt === null && each.ask !== null,
  );
  if (!task?.ask) return false;
  if (task.ask.kind === "unknown-outcome") {
    void answerTaskAsk(task.id, allow ? "redo" : "skip");
    return true;
  }
  const approvals = useApprovals.getState();
  const request = Object.values(approvals.waiting).find((each) => each.taskId === task.id);
  if (!request) return false;
  approvals.respond(request.requestId, allow ? "allow-once" : "deny");
  return true;
}

/** The one ask waiting, nearest the keyboard: an approval or an Effect it can't check. */
function TaskAskView({ task }: { task: Task }) {
  const t = useT();
  const request = useApprovals((state) =>
    Object.values(state.waiting).find((each: ApprovalRequest) => each.taskId === task.id),
  );
  const ask = task.ask;
  if (!ask) return null;
  if (ask.kind === "approval" && !request) return null;
  // ⌘↵ takes the first choice, ⌘⌫ the last.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isCommand(event) || event.altKey || event.shiftKey) return;
    const card = event.currentTarget;
    const pick =
      event.key === "Enter"
        ? card.querySelector<HTMLButtonElement>("[data-allow], [data-testid='approval-allow-once']")
        : event.key === "Backspace"
          ? card.querySelector<HTMLButtonElement>("[data-deny], [data-testid='approval-deny']")
          : null;
    if (!pick) return;
    event.preventDefault();
    pick.click();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the ask's keys, heard while the focus is on its buttons.
    <div data-testid="task-ask" data-task={task.id} className="task-ask" onKeyDown={onKeyDown}>
      {ask.number > 1 && (
        <p data-testid="task-ask-count" className="task-ask-count">
          {t("task.ask.count", { number: ask.number, total: ask.number })}
        </p>
      )}
      {ask.kind === "approval" && request ? (
        <ApprovalCard request={request} keys={keysLabel(ALLOW_KEYS, isMacOS())} />
      ) : (
        ask.kind === "unknown-outcome" && <UnknownOutcomeCard task={task} effect={ask.effect} />
      )}
    </div>
  );
}

/**
 * The Task tray (#126, narrowed by #657; DESIGN.md, Task tray): joined to the
 * top of the assistant's composer, only what waits for the User, nearest the
 * keyboard. Top to bottom: the plan card before a Task starts, the one
 * waiting ask (a Task's, else the assistant's question in the open
 * conversation, #1374), then queued messages, which wrap. Progress is in the thread
 * (`TaskProgress`). The plan card is Research's (#130). It takes at most 40%
 * of the column, a question all the column's room (#1400), and at least room
 * for the ask's buttons; the ask scrolls inside with its buttons pinned.
 * Nothing in it goes into the Mind.
 */
export function TaskTray({ mindId }: { mindId: string | null }) {
  const t = useT();
  useEffect(loadTasks, []);
  const asking = useTasks((state) =>
    Object.values(state.tasks).find(
      (task) => task.mindId === mindId && task.finishedAt === null && task.ask !== null,
    ),
  );
  const openId = useConversations((state) => state.openId);
  const question = useQuestions((state) =>
    Object.values(state.waiting).find((each) => each.conversationId === openId),
  );
  // A plan made with no Mind in focus is the composer's own until Start makes its Mind.
  const planKey = mindId ?? NO_MIND;
  const planning = useResearch((state) => state.plans[planKey] !== undefined);
  const viewingId = useResearch((state) => state.viewing[planKey]);
  const viewing = useTasks((state) => (viewingId ? state.tasks[viewingId] : undefined));
  const queued = useTasks(
    useShallow((state) =>
      Object.values(state.tasks).filter(
        (task) => task.mindId === mindId && task.finishedAt === null && task.queued.length > 0,
      ),
    ),
  );
  const tray = useRef<HTMLElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const present =
    asking !== undefined ||
    question !== undefined ||
    planning ||
    viewing !== undefined ||
    queued.length > 0;
  const choosing = asking === undefined && question !== undefined;

  useLayoutEffect(() => {
    const element = tray.current;
    const column = element?.closest<HTMLElement>(".assistant-main");
    if (!present || !element || !column) return;
    const assistant = column.closest<HTMLElement>(".assistant");
    const fitTray = () => {
      // The composer and the room under it, which the slot's padding keeps.
      const slot = element.parentElement?.getBoundingClientRect().height ?? 0;
      const composer = slot - element.getBoundingClientRect().height;
      const thread = choosing ? MIN_THREAD_ASKING : MIN_THREAD;
      const room = Math.max(MIN_ROOM, column.clientHeight - composer - thread);
      const share = Math.floor(column.clientHeight * TRAY_SHARE);
      // A question takes what room the column has, as the prototype's card shows every row.
      setMaxHeight(choosing ? room : Math.min(room, Math.max(share, MIN_TRAY)));
      if (choosing && assistant) {
        const card = element.querySelector<HTMLElement>(".choice-card");
        const needs = element.offsetHeight + (card ? hiddenIn(card) : 0);
        useQuestionRoom.setState({ fits: assistant.offsetHeight - room + needs });
      }
    };
    fitTray();
    const observer = new ResizeObserver(fitTray);
    observer.observe(column);
    if (choosing) {
      observer.observe(element);
      for (const part of element.querySelectorAll(".choice-card > *")) observer.observe(part);
    }
    return () => {
      observer.disconnect();
      if (choosing) useQuestionRoom.setState({ fits: null, resized: false });
    };
  }, [present, choosing]);

  if (!present) return null;
  return (
    <section
      ref={tray}
      data-testid="task-tray"
      aria-label={t("task.tray.label")}
      className="task-tray"
      style={{ maxHeight }}
    >
      {planning && <ResearchPlanCard mindId={mindId} />}
      {!planning && viewing && <ResearchPlanView task={viewing} />}
      {asking ? (
        <TaskAskView task={asking} />
      ) : (
        question && (
          <div data-testid="task-ask" className="task-ask">
            <QuestionCard key={question.requestId} request={question} />
          </div>
        )
      )}
      {queued.map((task) => (
        <QueuedMessages key={task.id} task={task} />
      ))}
    </section>
  );
}
