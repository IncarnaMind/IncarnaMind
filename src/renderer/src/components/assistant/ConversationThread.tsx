import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type {
  AskedQuote,
  ConversationAnswer,
  ConversationQuestion,
  SearchScope,
  Task,
} from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import { mindSearchScope } from "../../../../shared/searchScope";
import { type AddTarget, addAnswer, openTable } from "../../addToNote";
import { notesToAdd } from "../../answerEditors";
import { readsLine, stepsScope } from "../../assistantContext";
import { readMindHandle } from "../../commands/handles";
import { NO_MIND, useComposer } from "../../composer";
import {
  conversationLabel,
  useAnswerOnItsWay,
  useConversations,
  useOpenConversation,
} from "../../conversations";
import { askedAgainCounts } from "../../coverage";
import { AskedQuoteLines } from "../../editor/AskedQuotes";
import { useT } from "../../i18n";
import { isLive, useMeetings } from "../../meetings";
import { useModelSetup } from "../../modelSetup";
import { stepsShownOf } from "../../nudges";
import { useCitedSource } from "../../openCited";
import { togglePlanView, useResearch } from "../../research";
import { type ScopeChip, scopeChips } from "../../scope";
import { useFolderHoldsDocuments } from "../../scopeDocuments";
import { skillTitle } from "../../skills";
import { exampleMindIds, useAppStore } from "../../store";
import { interleave, type ThreadStart, threadTasks } from "../../taskGroups";
import { loadTasks, useTasks } from "../../tasks";
import { aimAt } from "../../taskTell";
import { SearchIcon } from "../icons";
import { PlanLineIcon, SearchLineIcon, SparkLineIcon } from "../lineIcons";
import { AddToMindPicker } from "./AddToMindPicker";
import { WritingLine } from "./AnswerActions";
import { LiveLine } from "./AnswerSteps";
import { type AnswerKeeping, AssistantAnswer } from "./AssistantAnswer";
import { MeetingStarters } from "./MeetingStarters";
import { useReadMindEmpty } from "./readMind";
import { TaskProgress, type TaskProgressActions } from "./TaskProgress";
import { useThreadScroll } from "./useThreadScroll";

const TASK_ACTIONS: TaskProgressActions = { plan: togglePlanView, tell: aimAt };

/** How long an Answer a link back led to stays flashed. */
const SOUGHT_MS = 1600;

/**
 * The conversation the assistant shows (#201): the Questions as bubbles at the
 * right, as in Claude and ChatGPT, and the Answers with their steps,
 * Citations, checks and actions (`AssistantAnswer`); empty, what the next
 * Question reads and searches, and what asking here does. A Question shows
 * the moment it is sent, with its Answer's first step and Stop under it
 * before the core has checked the model, so asking never looks like nothing
 * happened. The Tasks of the Mind it reads show their progress where each
 * started, by time among the messages (#657). It keeps up with an Answer
 * being written while the User is at its foot, and brings an Answer a link
 * back led to into view, flashed.
 */
export function ConversationThread({
  focusedMindId,
  focusedDoc,
}: {
  focusedMindId: string | null;
  focusedDoc: Y.Doc | null;
}) {
  const t = useT();
  const messages = useConversations((state) => state.messages);
  const asking = useConversations((state) => state.asking);
  const waitingQuestion = useModelSetup((state) => state.waiting);
  const modelWorks = useModelSetup((state) => state.ready);
  const askingQuote = useConversations((state) => state.askingQuote);
  const askingQuotes = useConversations((state) => state.askingQuotes);
  const onItsWay = useAnswerOnItsWay();
  const stopWanted = useConversations((state) => state.stopWanted);
  const sought = useConversations((state) => state.sought);
  const conversation = useOpenConversation();
  useEffect(loadTasks, []);
  const allTasks = useTasks((state) => state.tasks);
  const shownTask = useTasks((state) => state.shown);
  const thread = useThreadStart(conversation ?? null);
  const tasks = threadTasks(Object.values(allTasks), focusedMindId, thread, shownTask);
  // A plan made with no Mind in focus is the composer's own until Start makes its Mind.
  const plan = useResearch((state) => state.plans[focusedMindId ?? NO_MIND]);
  const focusedMind = useAppStore((state) => state.minds.find((mind) => mind.id === focusedMindId));
  const examples = useAppStore((state) => state.examples);
  const otherExamples = useAppStore((state) => state.otherExamples);
  const focusedMindName = focusedMindId
    ? (focusedMind && mindName(focusedMind)) || t("mind.untitled")
    : null;
  // The example is never a target of Add to note (#1940): a note of the User's own is.
  const addTarget =
    focusedMindId !== null && !exampleMindIds({ examples, otherExamples }).includes(focusedMindId)
      ? focusedMindName
      : null;
  const mindEmpty = useReadMindEmpty(focusedMindId);
  const nextScope = useNextScope(focusedMindId);
  // While the Mind's meeting records, the assistant listens to its live transcript (#144). A
  // voice memo has no call to ask about (#1568).
  const listening = useMeetings((state) =>
    state.meetings.some(
      (meeting) =>
        meeting.mindId === focusedMindId && isLive(meeting) && meeting.kind === "meeting",
    ),
  );
  // Until the first Question is asked, the card's ready Question is the next one, and it reads
  // no Note: an empty conversation names what it reads, as the line while it waits does (#2245).
  const ready = useAppStore((state) => state.readyQuestion);
  const progress = useAppStore((state) => state.settings?.device.gettingStarted);
  const readyAhead =
    ready !== null &&
    ready.scope !== null &&
    progress !== undefined &&
    stepsShownOf(progress) &&
    progress.indexed === true &&
    !(progress.askedOwn || progress.askedReady);
  const readyScope = useScopeChips(readyAhead && ready !== null ? ready.scope : null);
  const nextIsReady = readyAhead && readyScope.some((chip) => !chip.deleted);
  const reads =
    listening && focusedMindName
      ? t("assistant.reads.listening", { mind: focusedMindName })
      : nextIsReady
        ? readsLine(t, null, readyScope)
        : readsLine(t, focusedMind ? focusedMindName : null, nextScope);
  // A Question on its way, or one the core has and whose Answer is still to come: the line names
  // what that Question reads, not the Note in focus (#2245).
  const askingReads = useConversations((state) => state.askingReads);
  const last = messages.at(-1);
  const pending = last?.kind === "question" ? last : null;
  const pendingMindId = pending
    ? (pending.askedFrom?.mindId ?? null)
    : (askingReads?.mindId ?? null);
  const pendingMind = useAppStore((state) =>
    pendingMindId === null ? undefined : state.minds.find((each) => each.id === pendingMindId),
  );
  const pendingScope = useScopeChips(pending ? pending.scope : (askingReads?.scope ?? null));
  const [picking, setPicking] = useState<{
    answer: ConversationAnswer;
    anchor: HTMLElement;
    blocks: ReturnType<typeof notesToAdd>;
  } | null>(null);
  const log = useRef<HTMLDivElement>(null);
  // A Research topic asked, or a Task started, grows it too; a Task's every step doesn't move it.
  const started = tasks.length;
  const askedAt = plan?.askedAt;
  useThreadScroll(log, {
    asking: asking !== null,
    holdOff: sought !== null,
    conversationId: conversation?.id ?? null,
    changed: [messages, started, askedAt],
  });

  // A link back led here: that Answer comes into view, flashed, once it shows (its conversation's
  // messages may come a moment after it is opened).
  const shownSought = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Answer may show only once the messages come.
  useEffect(() => {
    if (!sought || shownSought.current === sought) return;
    const answer = log.current?.querySelector<HTMLElement>(`[data-answer-id="${sought}"]`);
    if (!answer) return;
    shownSought.current = sought;
    answer.scrollIntoView({ block: "nearest" });
    setTimeout(() => {
      shownSought.current = null;
      if (useConversations.getState().sought === sought) {
        useConversations.setState({ sought: null });
      }
    }, SOUGHT_MS);
  }, [sought, messages]);

  const add = (answer: ConversationAnswer, target: AddTarget, blocks = notesToAdd(answer)) =>
    void addAnswer({ answer, conversation, blocks }, target, focusedMindId === null);
  const keeping: AnswerKeeping = {
    focusedMindName: addTarget,
    mindEmpty,
    add(answer) {
      if (focusedMindId && addTarget !== null) {
        add(answer, { kind: "mind", mindId: focusedMindId });
      }
    },
    pick(answer, anchor) {
      setPicking({ answer, anchor, blocks: notesToAdd(answer) });
    },
    newMind(answer) {
      add(answer, { kind: "new" });
    },
    openTable(answer, table) {
      void openTable({ answer, conversation, blocks: [table] });
    },
  };

  const questions = new Map(
    messages.flatMap((message) =>
      message.kind === "question" ? [[message.id, message] as const] : [],
    ),
  );
  const askedAgain = askedAgainCounts(messages);
  return (
    <div
      ref={log}
      role="log"
      aria-label={t("assistant.log", { title: conversationLabel(conversation) })}
      data-testid="assistant-log"
      className="assistant-log"
    >
      {messages.length === 0 &&
        asking === null &&
        !waitingQuestion &&
        !plan &&
        !tasks.some(asked) && (
          <>
            <div data-testid="assistant-empty" className="assistant-empty">
              <p data-testid="assistant-reads" title={reads} className="assistant-reads">
                <SearchIcon aria-hidden="true" className="assistant-reads-icon" />
                <span className="assistant-reads-text">{reads}</span>
              </p>
            </div>
            {listening && <MeetingStarters />}
          </>
        )}
      {interleave(messages, tasks).map((entry) => {
        if (entry.kind === "task") {
          const { task } = entry;
          return task.question ? (
            <div key={task.id} className="assistant-task">
              <QuestionBubble text={task.question} research />
              <TaskProgress task={task} actions={TASK_ACTIONS} />
            </div>
          ) : (
            <TaskProgress key={task.id} task={task} actions={TASK_ACTIONS} />
          );
        }
        const message = entry.message;
        return message.kind === "question" ? (
          <QuestionBubble key={message.id} question={message} />
        ) : (
          <AssistantAnswer
            key={message.id}
            answer={message}
            question={questions.get(message.questionId)}
            sought={message.id === sought}
            keeping={keeping}
            askedAgain={askedAgain.get(message.id)}
            doc={focusedDoc}
          />
        );
      })}
      {asking !== null && (
        <QuestionBubble text={asking} quote={askingQuote} quotes={askingQuotes} />
      )}
      {waitingQuestion && (
        <>
          <QuestionBubble
            text={waitingQuestion.text}
            quote=""
            quotes={waitingQuestion.quotes ?? []}
          />
          {!modelWorks && (
            <p data-testid="assistant-waiting-model" className="assistant-empty">
              {t("setup.waiting")}
            </p>
          )}
        </>
      )}
      {plan && (
        <>
          <QuestionBubble text={plan.topic} research />
          <p data-testid="research-plan-line" className="assistant-reads">
            {plan.planning ? (
              <span aria-hidden="true" className="assistant-reads-icon task-dot" />
            ) : (
              <PlanLineIcon aria-hidden="true" className="assistant-reads-icon" />
            )}
            <span className="assistant-reads-text">
              {plan.planning ? t("research.thread.planning") : t("research.thread.planBelow")}
            </span>
          </p>
        </>
      )}
      {onItsWay && (
        // Its line shows at rest, as an Answer's being written does, with room kept for its first
        // line of text, so the Question above doesn't move when the Answer starts.
        <div
          data-testid="assistant-answer-on-its-way"
          data-status="streaming"
          className="assistant-answer"
        >
          <LiveLine
            step={
              pendingMindId === null
                ? { kind: "searching" }
                : {
                    kind: "reading",
                    mind: {
                      mindId: pendingMindId,
                      name: pendingMind ? mindName(pendingMind) : (pending?.askedFrom?.name ?? ""),
                      deleted: false,
                    },
                  }
            }
            scope={stepsScope(
              t,
              pendingScope.filter((chip) => !chip.deleted),
            )}
          />
          <div aria-hidden="true" className="assistant-answer-first-line" />
          <WritingLine
            // Stopped before it started: it says so at once, and stops as it starts.
            status={
              stopWanted ? (
                <span data-testid="answer-stopped" className="assistant-answer-status">
                  {t("answer.status.stopped")}
                </span>
              ) : undefined
            }
          />
        </div>
      )}
      {picking && (
        <AddToMindPicker
          anchor={picking.anchor}
          focusedMindId={addTarget === null ? null : focusedMindId}
          atCursor={readMindHandle.current?.cursorInMind() ?? false}
          newFolderId={conversation?.folderId ?? null}
          onChoose={(target) => {
            setPicking(null);
            add(picking.answer, target, picking.blocks);
          }}
          onClose={() => {
            const { anchor } = picking;
            setPicking(null);
            anchor.focus();
          }}
        />
      )}
    </div>
  );
}

/** A Task the User asked in their words: a Research Task, whose topic is its Question. */
const asked = (task: Task) => task.question !== null;

/**
 * A Question the User asked: their words in a bubble at the right, with the
 * Skill forced on it, or the Research it started.
 */
function QuestionBubble({
  question,
  text,
  quote,
  quotes = [],
  research = false,
}: {
  question?: ConversationQuestion;
  text?: string;
  quote?: string;
  quotes?: readonly AskedQuote[];
  research?: boolean;
}) {
  const t = useT();
  const skill = question?.forcedSkill ?? null;
  const about = (question ? question.focus?.selection : quote) ?? "";
  return (
    <div
      data-testid="assistant-question"
      data-pending={question || research ? undefined : true}
      className="assistant-question"
    >
      <p className="assistant-question-bubble">
        <span className="sr-only">{t("assistant.youAsked")}</span>
        {about.trim() !== "" && (
          <span
            data-testid="assistant-question-quote"
            title={about}
            className="assistant-question-quote"
          >
            <span className="sr-only">{t("assistant.question.quote")}</span>“{about.trim()}”
          </span>
        )}
        <AskedQuoteLines quotes={question?.quotes ?? quotes} />
        {skill && (
          <span data-testid="assistant-question-skill" className="assistant-question-skill">
            <SparkLineIcon aria-hidden="true" className="size-3" />
            {skillTitle(skill, t)}
          </span>
        )}
        {research && (
          <span data-testid="assistant-question-research" className="assistant-question-skill">
            <SearchLineIcon aria-hidden="true" className="size-3" />
            {t("research.chip")}
          </span>
        )}
        {question?.text ?? text}
      </p>
    </div>
  );
}

/** The Folders, Tags and Documents a Search scope names, as chips; none for no scope. */
function useScopeChips(scope: SearchScope | null): ScopeChip[] {
  const folders = useAppStore((state) => state.folders);
  const groups = useAppStore((state) => state.library?.groups);
  const deletedGroups = useAppStore((state) => state.library?.deletedGroups);
  const tags = useAppStore((state) => state.tags);
  const documents = useAppStore((state) => state.documents);
  return scope === null
    ? []
    : scopeChips({ folders, groups, deletedGroups, tags, documents }, scope);
}

/** What the next Question searches: the Search scope of the composer of the Mind in focus, or of the composer with none. */
function useNextScope(mindId: string | null): ScopeChip[] {
  const citedSource = useCitedSource();
  const scopeMindId = mindId ?? citedSource?.mindId ?? null;
  const mind = useAppStore((state) => state.minds.find((each) => each.id === scopeMindId));
  // Only the scope: a keystroke in the composer makes the draft new, and the whole Conversation must not draw again for it.
  const draftScope = useComposer((state) => state.drafts[scopeMindId ?? NO_MIND]?.scope ?? null);
  const folderHolds = useFolderHoldsDocuments(mind?.folderId ?? null);
  const scope =
    scopeMindId !== null && !mind
      ? null
      : mindSearchScope(draftScope, mind?.folderId ?? null, folderHolds);
  return useScopeChips(scope);
}

/**
 * When the thread on screen began, and the Tasks it has shown running, for
 * the Tasks it shows: its conversation's start, or, for a new chat, when it
 * opened. A conversation that a new chat on screen became, with its first
 * Question, keeps the new chat's start and Tasks, so a Task started before
 * that Question stays where it was.
 */
function useThreadStart(conversation: { id: string; createdAt: string } | null): ThreadStart {
  const id = conversation?.id ?? null;
  const [thread, setThread] = useState(() => ({
    id,
    start: {
      since: conversation?.createdAt ?? new Date().toISOString(),
      seen: new Set<string>(),
    },
  }));
  if (thread.id === id) return thread.start;
  const born = conversation !== null && thread.id === null;
  const start: ThreadStart = born
    ? {
        since:
          thread.start.since < conversation.createdAt ? thread.start.since : conversation.createdAt,
        seen: thread.start.seen,
      }
    : { since: conversation?.createdAt ?? new Date().toISOString(), seen: new Set() };
  setThread({ id, start });
  return start;
}
