import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { type ReactNode, useEffect, useState } from "react";
import type { AgentToolName } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";

type Translate = ReturnType<typeof useT>;

import { mindName } from "../../../../shared/naming";
import { latestReasoning } from "../../answerSteps";
import { undoAsked, useAskedState } from "../../askedChanges";
import { openClaudeCodeSignIn } from "../../claudeCodeInstall";
import { CheckOnLine } from "../../editor/CheckButton";
import { pendingIn } from "../../editor/proposalReview";
import { resolveProposalsIn } from "../../editWithAi";
import { useT } from "../../i18n";
import { showMeetingNoteView, useMeetingNoteView } from "../../meetingViews";
import { showWaitingChanges } from "../../mindChanges";
import { useNamedChanges } from "../../namedChanges";
import {
  allowAndAskAgain,
  askAgainInNote,
  askedAgain,
  clearNoteAsk,
  firstWordsOf,
  type NoteAsk,
} from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { type ProblemAction, ProblemLine } from "../ProblemLine";
import { useTabPlace } from "../tabs/tabItems";
import { useAnnounce, WaitingLine } from "./OwnAsk";
import { ownDoingWords } from "./ownAskWords";

/** What the pill says of each Tool while it runs, with what the call names as `{summary}`. */
const DOING: Partial<Record<AgentToolName, MessageKey>> = {
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

/** What the pill says of a call as it starts, before it names what it reads or writes. */
const STARTED: Partial<Record<AgentToolName, MessageKey>> = {
  read_mind: "noteAsk.doing.read_mind.any",
  search: "noteAsk.doing.search.any",
  read_passages: "noteAsk.doing.read_passages.any",
  propose_changes: "noteAsk.doing.propose_changes.any",
  create_mind: "noteAsk.doing.create_mind.any",
  save_as_word: "noteAsk.doing.save_as_word.any",
};

/** The seconds appear once a request has run this long, as the User's AI app shows them. */
const SECONDS_FROM = 3;

/** The changes the AI made that wait in the Note, as its Accept all takes them. */
export function useWaitingInNote(editor: Editor): number {
  return useEditorState({
    editor,
    selector: ({ editor: current }) =>
      pendingIn(current.state).filter((each) => !each.theirs).length,
  });
}

/** The other Notes it wrote, or left changes waiting in: the one in front has them before the User. */
const elsewhereOf = (ask: NoteAsk, mindId: string) => ({
  made: ask.made.filter((each) => each.mindId !== mindId),
  waiting: ask.waiting.filter((each) => each.mindId !== mindId),
});

const openNote = (mindId: string) => useAppStore.getState().openMind(mindId);

/** A sentence of the line, with the Note it names as a button that opens it. */
function Naming({
  said,
  title,
  onOpen,
}: {
  said: (title: string) => string;
  title: string;
  onOpen(): void;
}) {
  const [before = "", after = ""] = said("\u0000").split("\u0000");
  return (
    <span>
      {before}
      <button
        type="button"
        data-testid="note-ask-open-note"
        onClick={onOpen}
        className="note-ask-pill-name"
      >
        {title}
      </button>
      {after}
    </span>
  );
}

/** What the AI did, in IncarnaMind's words, for a reply that says nothing of it. */
function Facts({ ask, mindId }: { ask: NoteAsk; mindId: string }) {
  const t = useT();
  const { made, waiting } = elsewhereOf(ask, mindId);
  const named = useNamedChanges((state) => (ask.turnId ? state.byTurn[ask.turnId] : undefined));
  const changed =
    ask.changed === 1 && named
      ? t(named.added ? "noteAsk.done.added.named" : "noteAsk.done.changed.named", {
          start: named.start,
        })
      : t(ask.changed === 1 ? "noteAsk.done.changed.one" : "noteAsk.done.changed.other", {
          count: ask.changed,
        });
  const did: ReactNode[] = [
    ...(ask.changed > 0 ? [changed] : []),
    ...waiting.map((each) => (
      <Naming
        key={`waiting-${each.mindId}`}
        said={(title) =>
          t(each.count === 1 ? "noteAsk.done.waiting.one" : "noteAsk.done.waiting.other", {
            count: each.count,
            title,
          })
        }
        title={each.title}
        onOpen={() => showWaitingChanges(each.mindId)}
      />
    )),
    ...made.map((each) => (
      <Naming
        key={`made-${each.mindId}`}
        said={(title) => t("noteAsk.done.wrote", { title })}
        title={each.title}
        onOpen={() => openNote(each.mindId)}
      />
    )),
  ];
  return (
    <span data-testid="note-ask-facts" className="note-ask-pill-text note-ask-pill-reply">
      {did.length > 0
        ? did.flatMap((each, at) => (at === 0 ? [each] : [" ", each]))
        : t("noteAsk.done.nothing", { agent: ask.agent })}
    </span>
  );
}

/**
 * What a running request is doing, in the AI's own words where it wrote some; else in plain words,
 * never the name of a tool or a server, a path or a command.
 */
function doingOf(ask: NoteAsk, t: Translate): ReactNode {
  const { doing } = ask;
  if (ask.quiet) return t("noteAsk.pill.quiet", { agent: ask.agent });
  if (doing?.kind === "own") return ownDoingWords(t, doing.action);
  if (doing === null) return t("noteAsk.pill.working");
  if (doing.kind === "thinking") {
    // The summary as the assistant's step line shows a provider's (#1076).
    const latest = latestReasoning(doing.summary);
    return latest === "" ? t("noteAsk.pill.thinking") : `${t("noteAsk.pill.thinking")} · ${latest}`;
  }
  if (doing.kind === "compacting") return t("noteAsk.pill.compacting");
  if (doing.kind === "writing") {
    const words = firstWordsOf(doing.text);
    const any = STARTED[doing.tool];
    if (words !== "") return t("noteAsk.doing.writing", { words });
    return any ? t(any) : t("noteAsk.pill.working");
  }
  if (doing.kind === "quoting") return t("noteAsk.doing.cite.from", { document: doing.document });
  if (doing.kind === "said") {
    const lines = doing.text
      .split(/\n/)
      .map((line) => firstWordsOf(line))
      .filter(Boolean);
    return lines.at(-1) ?? t("noteAsk.pill.working");
  }
  const key = DOING[doing.tool];
  if (!key) return t("noteAsk.pill.working");
  if (doing.summary === "" && key !== "noteAsk.doing.list_minds" && key !== "noteAsk.doing.cite") {
    // A call as it starts, before it names what it reads or writes.
    const any = STARTED[doing.tool];
    return any ? t(any) : t("noteAsk.pill.working");
  }
  if (doing.tool === "read_passages" && ask.documentsFound > 1) {
    return t("noteAsk.doing.read_passages.of", {
      n: doing.count,
      total: Math.max(ask.documentsFound, doing.count),
      summary: doing.summary,
    });
  }
  if (doing.tool === "read_passages" && doing.count > 1) {
    return t("noteAsk.doing.read_passages.counted", {
      summary: doing.summary,
      count: doing.count,
    });
  }
  return t(key, { summary: doing.summary, agent: ask.agent });
}

/** Seconds since `startedAt`, counting each second while `counting`. */
function useSeconds(startedAt: string | null, counting: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
}

/**
 * The one line above a Note's input (#3677), as the User's AI app shows it: while a request runs, a
 * small line in the middle of what the AI is doing, in its own words where it wrote some, and the
 * seconds since the request; when it ends, a line as wide as the input of its reply's first words,
 * with the one thing to do next at its end. Pressed, the reply opens in the conversation.
 */
export function NoteAskPill({
  ask,
  mindId,
  editor,
  onOpen,
}: {
  ask: NoteAsk;
  mindId: string;
  editor: Editor;
  onOpen(): void;
}) {
  const t = useT();
  const working = ask.state === "working";
  const seconds = useSeconds(ask.startedAt, working);
  const [question] = ask.questions;
  const announce = useAnnounce(question, ask.agent);
  // Undone, the change the line reports is no longer in the Note: the line goes, and the
  // conversation keeps the reply.
  const undone = useAskedState(ask.turnId ?? "", ask.mindId) === "undone";
  useEffect(() => {
    if (undone && ask.state === "landed") clearNoteAsk(ask.conversationId, ask.mindId);
  }, [undone, ask.state, ask.conversationId, ask.mindId]);
  if (working && question) {
    return (
      <div
        data-testid="note-ask-pill"
        data-state="waiting"
        role="status"
        aria-live="polite"
        className="note-ask-pill own-ask-pill"
      >
        <WaitingLine
          seconds={seconds >= SECONDS_FROM ? t("noteAsk.seconds", { count: seconds }) : null}
          announce={announce}
        />
      </div>
    );
  }
  if (working) {
    return (
      <div
        data-testid="note-ask-pill"
        data-state="working"
        role="status"
        aria-live="polite"
        className="note-ask-pill"
      >
        <span aria-hidden="true" className="note-ask-dots">
          <span />
          <span />
          <span />
        </span>
        <span data-testid="note-ask-pill-text" className="note-ask-pill-text">
          {doingOf(ask, t)}
        </span>
        {seconds >= SECONDS_FROM && (
          <span data-testid="note-ask-seconds" className="note-ask-pill-time">
            {t("noteAsk.seconds", { count: seconds })}
          </span>
        )}
      </div>
    );
  }
  if (ask.state === "failed") {
    return (
      <div data-testid="note-ask-pill" data-state="failed" className="note-ask-pill note-ask-end">
        <FailureLine ask={ask} mindId={mindId} className="note-ask-problem-line" />
      </div>
    );
  }
  // Its last words say what it would do, which it didn't: the line says that.
  const words = ask.endedAtAsk
    ? t("ownAsk.endedAtAsk", { agent: ask.agent })
    : firstWordsOf(ask.reply);
  return (
    <div data-testid="note-ask-pill" data-state="landed" className="note-ask-pill note-ask-end">
      {words === "" ? (
        <Facts ask={ask} mindId={mindId} />
      ) : (
        <button
          type="button"
          data-testid="note-ask-pill-open"
          // It goes as the conversation opens: a press never leaves the focus on it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onOpen}
          className="note-ask-pill-text note-ask-pill-reply"
        >
          {words}
        </button>
      )}
      <EndAction ask={ask} mindId={mindId} editor={editor} named={words === ""} />
    </div>
  );
}

/** The ways a run stops part way that sending it again can mend. */
const RETRIED: ReadonlySet<string> = new Set([
  "plan-limit",
  "timeout",
  "stalled",
  "compaction",
  "failed",
  "outside",
  "unreadable",
  "service",
]);

/**
 * Why a request failed, in one line that wraps, with the one thing to do when there is one. In a
 * turn of the conversation, `turn` is that turn's record: the line is part of it, read out only as
 * a status, and what Allow sends again comes from it where this window didn't send the request.
 */
export function FailureLine({
  ask,
  mindId,
  className,
  turn,
}: {
  ask: NoteAsk;
  mindId: string;
  className: string;
  turn?: { request: string; quote: string };
}) {
  const t = useT();
  const readOnly = ask.problem === "read-only";
  // A request that never started keeps its words in the input, where Send is: only a run that
  // stopped part way is sent again from its line.
  const again =
    ask.turnId !== null && RETRIED.has(ask.problem ?? "failed") ? askedAgain(ask, turn) : null;
  const retryMindId = ask.mindId || mindId;
  const action: ProblemAction | undefined = readOnly
    ? {
        label: t("noteAsk.allow"),
        testId: "note-ask-allow",
        onClick: () =>
          void allowAndAskAgain(retryMindId, ask.conversationId, turn).catch(
            useAppStore.getState().reportError,
          ),
      }
    : ask.problem === "signed-out"
      ? {
          label: t("noteAsk.signIn"),
          testId: "note-ask-sign-in",
          onClick: () => void openClaudeCodeSignIn(),
        }
      : again
        ? {
            label: t("noteAsk.tryAgain"),
            testId: "note-ask-try-again",
            onClick: () =>
              void askAgainInNote(retryMindId, again, ask.conversationId).catch(
                useAppStore.getState().reportError,
              ),
          }
        : undefined;
  return (
    <ProblemLine
      testId="note-ask-problem"
      role={readOnly || turn ? "status" : "alert"}
      className={className}
      action={action}
    >
      {readOnly
        ? t("noteAsk.readOnly", { agent: ask.agent })
        : t(`noteAsk.problem.${ask.problem ?? "failed"}`, {
            agent: ask.agent,
            found: ask.versions?.found ?? "",
            lowest: ask.versions?.lowest ?? "",
          })}
    </ProblemLine>
  );
}

/**
 * The one thing to do next, at the line's end: Accept all while its changes wait in the Note; else
 * open the Note it wrote, or left changes waiting in, unless the line names it already; else Undo,
 * while what it changed here can still be undone, with the Note's Check beside it (#3794), where
 * the User is looking. In a meeting's My notes, which hides the AI's
 * lines, the change is in Notes, and the one thing is to show it there (#3762).
 */
export function EndAction({
  ask,
  mindId,
  editor,
  named,
}: {
  ask: NoteAsk;
  mindId: string;
  editor: Editor;
  named: boolean;
}) {
  const t = useT();
  const minds = useAppStore((state) => state.minds);
  const waiting = useWaitingInNote(editor);
  const sameNote = ask.mindId === mindId;
  const undoable = useAskedState(ask.turnId ?? "", mindId) === "can-undo";
  const tabId = useTabPlace()?.tabId;
  const inMyNotes = useMeetingNoteView(tabId, mindId) === "mine";
  // A reply about a Note that is not in front offers a way to open that Note, never Undo or
  // Accept all: a press never accepts or undoes changes in a Note out of sight (#3731).
  if (!sameNote) {
    const targetMind = minds.find((each) => each.id === ask.mindId);
    const waitingTarget = ask.waiting.find((each) => each.mindId === ask.mindId);
    if (targetMind && (ask.changed > 0 || waitingTarget)) {
      const targetTitle = mindName(targetMind) || t("mind.untitled");
      return (
        <button
          type="button"
          data-testid="note-ask-open"
          onClick={() => (waitingTarget ? showWaitingChanges(ask.mindId) : openNote(ask.mindId))}
          className="note-ask-pill-action note-ask-pill-open-note"
        >
          {t("noteAsk.open", { title: targetTitle })}
        </button>
      );
    }
    const { made, waiting: elsewhere } = elsewhereOf(ask, mindId);
    const [wrote] = made;
    const [left] = elsewhere;
    const other = named
      ? undefined
      : wrote
        ? { ...wrote, waits: false }
        : left && { ...left, waits: true };
    if (!other) return null;
    return (
      <button
        type="button"
        data-testid="note-ask-open"
        onClick={() => (other.waits ? showWaitingChanges(other.mindId) : openNote(other.mindId))}
        className="note-ask-pill-action note-ask-pill-open-note"
      >
        {t("noteAsk.open", { title: other.title })}
      </button>
    );
  }
  if (waiting > 0) {
    return (
      <button
        type="button"
        data-testid="note-ask-accept-all"
        onClick={() => resolveProposalsIn(editor, mindId, "all", "accept")}
        className="note-ask-pill-action"
      >
        {t("proposal.acceptAll")}
      </button>
    );
  }
  const { made, waiting: elsewhere } = elsewhereOf(ask, mindId);
  const [wrote] = made;
  const [left] = elsewhere;
  const other = named
    ? undefined
    : wrote
      ? { ...wrote, waits: false }
      : left && { ...left, waits: true };
  if (other) {
    return (
      <button
        type="button"
        data-testid="note-ask-open"
        onClick={() => (other.waits ? showWaitingChanges(other.mindId) : openNote(other.mindId))}
        className="note-ask-pill-action note-ask-pill-open-note"
      >
        {t("noteAsk.open", { title: other.title })}
      </button>
    );
  }
  if (!undoable || ask.turnId === null) return null;
  const { turnId } = ask;
  if (inMyNotes && tabId) {
    return (
      <button
        type="button"
        data-testid="note-ask-show-in-notes"
        onClick={() => showMeetingNoteView(tabId, mindId, "notes")}
        className="note-ask-pill-action"
      >
        {t("noteAsk.showInNotes")}
      </button>
    );
  }
  // The finished change is said once, here: the page draws no line of its own (#3762). The Check
  // comes before Undo: it shows once the Note's sentences are counted, a moment after the line, and
  // there it takes the room of the words before it, never moving Undo from under the pointer.
  return (
    <>
      <CheckOnLine mindId={mindId} />
      <button
        type="button"
        data-testid="note-ask-undo"
        onClick={() => undoAsked(turnId, mindId)}
        className="note-ask-pill-action"
      >
        {t("edit.applied.undo")}
      </button>
    </>
  );
}
