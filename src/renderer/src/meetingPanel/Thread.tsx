import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Meeting, MeetingHelp } from "../../../core/api";
import { MEETING_PANEL_BRIDGE_KEY } from "../../../shared/meetingPanel";
import { ChevronRightLineIcon } from "../components/lineIcons";
import {
  HelpHeading,
  HelpOutline,
  HelpSuggestion,
  saysAloud,
  useHelpAnswer,
} from "../components/meetings/HelpSuggestion";
import { ReadinessExplanation } from "../components/providers/ChatReadinessNotice";
import { core } from "../core";
import { errorMessage } from "../errors";
import { helpItems, helpToKeep, piecesText } from "../helpReply";
import { translateNow, useT } from "../i18n";
import { addHelpToNotes, askHelp, askQuestion, helpAsked, useMeetingHelp } from "../meetingHelp";
import { clockTime } from "../meetingTime";
import { useAppStore } from "../store";

const bridge = () => window[MEETING_PANEL_BRIDGE_KEY];

/** How long a suggestion's "Added to note" stays, with its Undo. */
const ADDED_MS = 6000;
/** The earlier items shown as lines before "Show earlier". */
const EARLIER_SHOWN = 3;
/** How near the foot the thread counts as at its foot, in px. */
const AT_FOOT = 4;

/** Whether the pointer is over the panel, which is its whole window, as its moves last said. */
function usePointed(): RefObject<boolean> {
  const over = useRef(false);
  useEffect(() => {
    const page = document.documentElement;
    const on = () => {
      over.current = true;
    };
    const off = () => {
      over.current = false;
    };
    page.addEventListener("pointermove", on);
    page.addEventListener("pointerenter", on);
    page.addEventListener("pointerleave", off);
    return () => {
      page.removeEventListener("pointermove", on);
      page.removeEventListener("pointerenter", on);
      page.removeEventListener("pointerleave", off);
    };
  }, []);
  return over;
}

/**
 * Scrolls the thread so the newest item's foot is in view, never past its top: a reply taller than
 * the thread is read from its start. The thread alone scrolls, never the page around it, whose top
 * is where the window is anchored.
 */
function reveal(box: HTMLElement | null, item: HTMLElement | null): void {
  if (!box || !item) return;
  const within = box.getBoundingClientRect();
  const at = item.getBoundingClientRect();
  if (at.top < within.top) box.scrollTop -= within.top - at.top;
  else if (at.bottom > within.bottom)
    box.scrollTop += Math.min(at.bottom - within.bottom, at.top - within.top);
}

const retry = (meeting: Meeting, help: Pick<MeetingHelp, "kind" | "question">) =>
  void (help.kind === "question"
    ? askQuestion(meeting, help.question ?? "")
    : askHelp(meeting, help.kind));

/**
 * The Meeting's help in the panel (#2925), oldest first, as its conversation in the assistant
 * holds it: a button's under its name, a typed question as the question. The newest shows whole,
 * or the one the User opened, which closes the one open before; each other is one line with its
 * time, what was asked and the start of its reply: the three before the newest, then "Show
 * earlier". A pinned one stays whole. A new ask opens below and comes into view; the thread
 * follows a reply as it grows, its start kept in view, and never by itself while the pointer is on
 * the panel.
 */
export function Thread({
  meeting,
  pinned,
  onPin,
}: {
  meeting: Meeting;
  pinned: readonly string[];
  onPin(help: MeetingHelp): void;
}) {
  const t = useT();
  const pending = useMeetingHelp((state) => state.pending[meeting.id]);
  const askedHere = useMeetingHelp((state) => state.asked[meeting.id] ?? 0);
  const blocked = useMeetingHelp((state) => state.blocked[meeting.id]);
  const { helps } = meeting;
  const [opened, setOpened] = useState<string | null>(null);
  const [everything, setEverything] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const newest = useRef<HTMLDivElement>(null);
  const atFoot = useRef(true);
  const pointed = usePointed();
  // Kept here, by Answer, so a reply closed to its line and opened again within its time still
  // offers Undo for what it added.
  const [added, setAdded] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const addedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = addedTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);
  const markAdded = (answerId: string, blockIds: readonly string[] | null) => {
    clearTimeout(addedTimers.current.get(answerId));
    addedTimers.current.delete(answerId);
    setAdded((now) => {
      const next = new Map(now);
      if (blockIds) next.set(answerId, blockIds);
      else next.delete(answerId);
      return next;
    });
    if (blockIds) {
      addedTimers.current.set(
        answerId,
        setTimeout(() => markAdded(answerId, null), ADDED_MS),
      );
    }
  };

  // A new ask opens: one made here, which comes into view, or one from the app's window, which
  // does when the pointer isn't on the panel. A help that arrives for an ask made here is that ask,
  // and leaves open what the User opened meanwhile. Before the paint, so it is never drawn out of
  // view first.
  const seen = useRef({ count: helps.length, askedHere });
  const awaiting = useRef(0);
  const [revealed, setRevealed] = useState(0);
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = { count: helps.length, askedHere };
    const here = askedHere - before.askedHere;
    const grew = Math.max(0, helps.length - before.count);
    const settled = Math.min(grew, awaiting.current + here);
    // An ask that won't bring a help (it couldn't be asked, or the call stopped) awaits nothing.
    awaiting.current = pending ? awaiting.current + here - settled : 0;
    const elsewhere = grew - settled;
    if (here === 0 && elsewhere === 0) return;
    setOpened(null);
    if (here > 0 || !pointed.current) setRevealed((now) => now + 1);
  }, [helps.length, askedHere, pending, pointed]);

  useLayoutEffect(() => {
    if (revealed > 0) reveal(scroller.current, newest.current);
  }, [revealed]);

  const empty = helps.length === 0 && !pending && !blocked;
  useEffect(() => {
    const box = scroller.current;
    const inner = content.current;
    if (empty || !box || !inner) return;
    const follow = () => {
      if (atFoot.current && !pointed.current) reveal(box, newest.current);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [empty, pointed]);

  const last = pending || blocked ? undefined : helps.at(-1);
  const earlier = last ? helps.slice(0, -1) : helps;
  const isOpen = (help: MeetingHelp) =>
    pinned.includes(help.answerId) || (opened === null ? help === last : opened === help.answerId);
  const kept = everything ? earlier : earlier.slice(-EARLIER_SHOWN);
  const shown = earlier.filter((help) => kept.includes(help) || isOpen(help));
  const hidden = earlier.length - shown.length;
  const item = (help: MeetingHelp, at: "newest" | "earlier") =>
    isOpen(help) ? (
      <Suggestion
        key={help.answerId}
        meeting={meeting}
        help={help}
        pinned={pinned.includes(help.answerId)}
        onPin={onPin}
        added={added.get(help.answerId) ?? null}
        onAdded={(blockIds) => markAdded(help.answerId, blockIds)}
        holder={at === "newest" ? newest : undefined}
      />
    ) : (
      <EarlierLine
        key={help.answerId}
        help={help}
        holder={at === "newest" ? newest : undefined}
        onOpen={() => setOpened(help.answerId)}
      />
    );
  if (empty) return null;
  return (
    <div
      ref={scroller}
      data-testid="help-thread"
      onScroll={(event) => {
        const box = event.currentTarget;
        atFoot.current = box.scrollHeight - box.scrollTop - box.clientHeight <= AT_FOOT;
      }}
      className="panel-thread"
    >
      <div ref={content} className="panel-thread-items">
        {hidden > 0 && (
          <button
            type="button"
            data-testid="help-show-earlier"
            onClick={() => setEverything(true)}
            className="help-show-earlier"
          >
            {t("meetings.help.earlier", { count: hidden })}
          </button>
        )}
        {shown.map((help) => item(help, "earlier"))}
        {last && item(last, "newest")}
        {pending && (
          <div ref={newest} className="panel-suggestion" data-testid="help-pending">
            <HelpHeading asked={pending} />
            <HelpOutline count={2} />
          </div>
        )}
        {blocked && (
          <div ref={newest} className="panel-suggestion">
            {"readiness" in blocked ? (
              <p data-testid="help-set-up" className="panel-line">
                {blocked.readiness.reason === "no-provider" ? (
                  t("meetings.help.setUp")
                ) : (
                  <ReadinessExplanation readiness={blocked.readiness} inLine />
                )}
                <span aria-hidden="true"> · </span>
                <button type="button" onClick={() => bridge().setUp()} className="panel-link">
                  {t("providers.readiness.setUp")}
                </button>
              </p>
            ) : (
              <p role="alert" data-testid="help-problem" className="panel-line">
                {blocked.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * An earlier item as one line: "12:04 · Answer their question · “Yes, SSO is included…”", an
 * option to say in quotation marks. A click opens it.
 */
function EarlierLine({
  help,
  holder,
  onOpen,
}: {
  help: MeetingHelp;
  holder: RefObject<HTMLDivElement | null> | undefined;
  onOpen(): void;
}) {
  const t = useT();
  const answer = useHelpAnswer(help);
  const first = answer ? helpItems(answer, help.kind)[0] : undefined;
  const start = answer && first ? piecesText(first.lead, answer.figures) : "";
  const said = first !== undefined && saysAloud(help.kind, first);
  return (
    <div ref={holder} className="help-earlier-row">
      <button
        type="button"
        data-testid="help-earlier"
        data-kind={help.kind}
        aria-expanded={false}
        onClick={onOpen}
        className="help-earlier"
      >
        <ChevronRightLineIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="help-earlier-time">{clockTime(help.atMs)}</span>
        <span aria-hidden="true">·</span>
        <b className="help-earlier-asked">{helpAsked(help, t)}</b>
        {start && (
          <>
            <span aria-hidden="true">·</span>
            <span data-testid="help-earlier-start" className="help-earlier-start">
              {said ? `“${start}”` : start}
            </span>
          </>
        )}
      </button>
    </div>
  );
}

/**
 * An item shown whole: its reply, Pin, Add to note and, for a typed question, Open in assistant,
 * which goes on with it in the app's window.
 */
function Suggestion({
  meeting,
  help,
  pinned,
  onPin,
  added,
  onAdded,
  holder,
}: {
  meeting: Meeting;
  help: MeetingHelp;
  pinned: boolean;
  onPin(help: MeetingHelp): void;
  /** The Blocks its Add to note added, while its Undo is offered; null: none. */
  added: readonly string[] | null;
  onAdded(blockIds: readonly string[] | null): void;
  holder?: RefObject<HTMLDivElement | null> | undefined;
}) {
  const t = useT();
  const answer = useHelpAnswer(help);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  // Closed or gone before Add to note or its Undo ends: its failure is still told.
  const failed = (error: unknown) => {
    if (shown.current) setProblem(errorMessage(error, translateNow));
    else useAppStore.getState().reportError(error);
  };
  if (!answer) {
    return (
      <div ref={holder} className="panel-suggestion">
        <HelpHeading asked={help} heard={help.heard} />
        <HelpOutline count={2} />
      </div>
    );
  }
  const keeps = helpToKeep(answer, help.kind);
  const addToNotes = async () => {
    setProblem(null);
    try {
      const { blockIds } = await addHelpToNotes(meeting, help);
      onAdded(blockIds);
    } catch (error) {
      failed(error);
    }
  };
  const undoAdd = (blockIds: readonly string[]) => {
    onAdded(null);
    core.undoAddToNote({ mindId: meeting.mindId, blockIds: [...blockIds] }).catch(failed);
  };
  const typed = help.kind === "question";
  return (
    <div ref={holder} className="panel-suggestion" data-pinned={pinned}>
      <HelpSuggestion help={help} answer={answer} onRetry={() => retry(meeting, help)} />
      {(keeps || pinned || typed) && answer.status !== "streaming" && (
        <div className="panel-actions">
          {(keeps || pinned) && (
            <button
              type="button"
              data-testid="help-pin"
              aria-pressed={pinned}
              onClick={() => onPin(help)}
              className="panel-ghost"
            >
              {t(pinned ? "meetings.help.unpin" : "meetings.help.pin")}
            </button>
          )}
          {keeps &&
            (added ? (
              <p role="status" data-testid="help-added" className="panel-line">
                {t("meetings.help.added")}
                <span aria-hidden="true"> · </span>
                <button type="button" onClick={() => undoAdd(added)} className="panel-link">
                  {t("move.undo")}
                </button>
              </p>
            ) : (
              <button
                type="button"
                data-testid="help-add"
                onClick={() => void addToNotes()}
                className="panel-ghost"
              >
                {t("meetings.help.addToNotes")}
              </button>
            ))}
          {typed && (
            <button
              type="button"
              data-testid="help-open-assistant"
              onClick={() =>
                bridge().openInAssistant({
                  conversationId: help.conversationId,
                  answerId: help.answerId,
                })
              }
              className="panel-ghost panel-actions-end"
            >
              {t("meetings.help.openInAssistant")}
            </button>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" className="panel-line">
          {problem}
        </p>
      )}
    </div>
  );
}
