import type { Editor } from "@tiptap/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { MessageKey } from "../../../../shared/i18n";
import { askFirstAgent, useReadAgentsToAsk } from "../../askYourAi";
import { core } from "../../core";
import { useT } from "../../i18n";
import {
  askInNote,
  caretOf,
  clearNoteAsk,
  focusNoteAsk,
  listen,
  moveConversation,
  openColumnAt,
  seedRunning,
  selectedForRequest,
  setColumnOpen,
  stopInNote,
  useColumnOpen,
  useNoteAskShown,
  useNoteAsks,
  useNoteColumns,
} from "../../ownAiInNote";
import { useAppStore } from "../../store";
import {
  ChevronRightLineIcon,
  ConversationLineIcon,
  DockBottomLineIcon,
  DockLeftLineIcon,
} from "../lineIcons";
import { useTabPlace } from "../tabs/tabItems";
import { WindowColumnContext } from "../tabs/windowColumn";
import { type InputCarry, NoteAskInput } from "./NoteAskInput";
import { NoteAskPill } from "./NoteAskPill";
import { NoteColumn, NoteConversationBody } from "./NoteColumn";
import { drawnNoteAskBox } from "./noteAskBox";
import { ASKS_NOTHING, QuestionCard } from "./OwnAsk";

/**
 * The window's column, where it is drawn while it fits beside the tab groups, and whether it follows
 * this tab's Note (#3759).
 */
function useWindowColumn(): { slot: HTMLElement | null; followed: boolean } {
  const column = useContext(WindowColumnContext);
  const tabId = useTabPlace()?.tabId;
  return { slot: column.slot, followed: tabId !== undefined && column.tabId === tabId };
}

/**
 * Whether the Note's conversation shows open: as each Note remembers it, upward in its own box; in
 * the window's one column, or upward when the column doesn't fit, only for the Note the column
 * follows.
 */
function useConversationOpen(mindId: string): boolean {
  const remembered = useColumnOpen(mindId);
  const place = useNoteColumns((state) => state.place);
  const { followed } = useWindowColumn();
  return remembered && (place === "upward" || followed);
}

/**
 * The Note's one input (ADR-0034, #3627), for a User whose own AI IncarnaMind runs in the
 * background: one box at the Note's foot, its top row the AI's line while there is one, saying what
 * the AI is doing and then its reply in one sentence. The conversation opens upward inside the same
 * box, or, moved there by the User, in the window's column left of the tab groups with the input
 * at its foot, while the column fits there (#3677, #3759). There is only ever one input, and
 * sending never folds the conversation.
 */
export function NoteAsk({ mindId, editor }: { mindId: string; editor: Editor }) {
  useReadAgentsToAsk(mindId);
  const shown = useNoteAskShown(mindId);
  if (!shown) return null;
  return <NoteAskBox mindId={mindId} editor={editor} />;
}

function NoteAskBox({ mindId, editor }: { mindId: string; editor: Editor }) {
  const t = useT();
  const ask = useNoteAsks((state) => state.byMind[mindId]);
  const [words, setWords] = useState("");
  const carry = useRef<InputCarry | null>(null);
  const [quote, setQuote] = useState(() => selectedForRequest(editor.state)?.quote ?? "");
  const [whole, setWhole] = useState(false);
  const open = useConversationOpen(mindId);
  const place = useNoteColumns((state) => state.place);
  const slot = useWindowColumn().slot;
  // With no column to open in, or none that fits beside the groups, it opens upward.
  const upward = place === "upward" || slot === null;
  useEffect(listen, []);
  // A window opened while a request runs hears of it, and of what its AI asks, from the record.
  useEffect(() => {
    seedRunning(mindId).catch((error: unknown) =>
      console.warn("The request running in this Note couldn't be read:", error),
    );
  }, [mindId]);
  const working = ask?.state === "working";
  const [question] = ask?.state === "working" ? ask.questions : [];
  // Folded, a question shows its card in the box, which grows over the Note as the conversation
  // does upward, and goes back once it is answered (#3653).
  const asking = question !== undefined && !open;
  // An AI set to ask nothing says so once in the box too, where the User sees it (#3653).
  const unasking = working && !open && ASKS_NOTHING.has(ask?.mode ?? "") ? ask?.mode : undefined;
  const floating = (upward && open) || asking || unasking !== undefined;
  // With no conversation yet there is nothing to open: no handle, and the box is its input row.
  const kept = useKeptConversation(mindId, ask?.state ?? null);

  useEffect(() => {
    const follow = () => {
      setQuote(selectedForRequest(editor.state)?.quote ?? "");
      setWhole(false);
    };
    editor.on("selectionUpdate", follow);
    return () => {
      editor.off("selectionUpdate", follow);
    };
  }, [editor]);

  const send = async () => {
    const typed = words.trim();
    if (typed === "" || working) return;
    const selected = whole ? null : selectedForRequest(editor.state);
    setWords("");
    try {
      const went = await askInNote(mindId, {
        words: typed,
        quote: selected?.quote ?? "",
        selection: selected?.selection ?? null,
        caret: selected ? "" : caretOf(editor.state),
      });
      if (went === "link") await askFirstAgent(mindId, { kind: "question", text: typed });
    } catch (error) {
      setWords(typed);
      useAppStore.getState().reportError(error);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The card never takes the focus: Shift+Tab from the input reaches its answers, on Deny (#3653).
    if (event.key === "Tab" && event.shiftKey && question) {
      const deny = document.querySelector<HTMLButtonElement>(
        `[data-testid="own-ask-card"][data-mind-id="${CSS.escape(mindId)}"] [data-testid="own-ask-deny"]`,
      );
      if (deny) {
        event.preventDefault();
        deny.focus();
        return;
      }
    }
    if (event.key === "Escape") {
      if (working) void stopInNote(mindId);
      else if (open) setColumnOpen(mindId, false);
      else return;
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // While a run goes, Return sends nothing new: only Stop and Esc act (#3677).
    if (!working) void send();
  };

  // Upward, the box keeps the folded box's height in the Note's foot and grows over the Note, so
  // nothing in the Note moves; a press on the Note outside it folds it.
  const foot = useRef<HTMLDivElement>(null);
  const folded = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!open && !asking && foot.current) folded.current = foot.current.offsetHeight;
  });
  const toggle = () => setColumnOpen(mindId, !open);
  // Grown over the Note's foot, it gives the Note's end as much more room, so the Note's last line
  // still scrolls up above it.
  useLayoutEffect(() => {
    const box = foot.current ? drawnNoteAskBox(foot.current) : null;
    const scroller = foot.current
      ?.closest(".mind-tab-page")
      ?.querySelector<HTMLElement>(".mind-scroller");
    if (!floating || !box || !scroller) return;
    const measure = () => {
      const over = scroller.getBoundingClientRect().bottom - box.getBoundingClientRect().top;
      scroller.style.setProperty("--note-ask-over", `${Math.max(0, Math.round(over))}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      scroller.style.removeProperty("--note-ask-over");
    };
  }, [floating]);
  useEffect(() => {
    if (!upward || !open) return;
    const fold = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || foot.current?.contains(target)) return;
      // A menu's popover; Show conversation at the Note's top right, which folds it itself: folding
      // here first would have its press open it again; and a change's bar, which stands above the
      // box: folding would move it from under the press.
      if (
        target instanceof Element &&
        target.closest("[popover], [data-conversation-toggle], .change-bar")
      )
        return;
      setColumnOpen(mindId, false);
    };
    document.addEventListener("pointerdown", fold, true);
    return () => document.removeEventListener("pointerdown", fold, true);
  }, [upward, open, mindId]);

  const line = ask ? (
    <NoteAskPill
      ask={ask}
      mindId={mindId}
      editor={editor}
      onOpen={() => {
        // The pressed line goes as the conversation opens: the keyboard goes to the input.
        focusNoteAsk(mindId);
        if (upward) toggle();
        else openColumnAt(mindId, ask.turnId);
      }}
    />
  ) : null;
  // Open, the conversation shows the line's reply and a failure of its request; a request that
  // failed before it began has no turn there, so its line stays above the input.
  const shownLine = open && !(ask?.state === "failed" && ask.turnId === null) ? null : line;
  const agent = ask?.agent || "Claude Code";
  const input = (
    <NoteAskInput
      mindId={mindId}
      words={words}
      onWords={(typed) => {
        setWords(typed);
        if (ask && ask.state !== "working") clearNoteAsk(mindId);
      }}
      quote={whole ? "" : quote}
      onWholeNote={() => setWhole(true)}
      working={working}
      onSend={() => void send()}
      onStop={() => void stopInNote(mindId)}
      onKeyDown={onKeyDown}
      carry={carry}
      // Folded, the box says how to see the conversation again in words, wherever it opens; open,
      // only a line the conversation can't show stays above the input.
      line={
        open ? shownLine : kept || ask ? <ConversationHandle line={line} onOpen={toggle} /> : null
      }
      panel={
        asking ? (
          <div data-testid="note-ask-panel" className="note-ask-panel own-ask-panel">
            <div className="note-ask-panel-body">
              <QuestionCard question={question} agent={agent} mindId={mindId} />
            </div>
          </div>
        ) : unasking ? (
          <div data-testid="note-ask-panel" className="note-ask-panel own-ask-panel">
            <p data-testid="note-ask-mode" className="note-ask-panel-body own-mode">
              {t(`ownAsk.mode.${unasking}` as MessageKey, { agent })}
            </p>
          </div>
        ) : upward && open ? (
          <div data-testid="note-ask-panel" className="note-ask-panel">
            <NoteConversationBody
              mindId={mindId}
              editor={editor}
              agent={agent}
              className="note-ask-panel-body"
            />
            <PanelTools column={slot !== null} onFold={toggle} />
          </div>
        ) : null
      }
    />
  );
  if (!upward && open && slot !== null) {
    return createPortal(
      <NoteColumn mindId={mindId} editor={editor} agent={agent} input={input} />,
      slot,
    );
  }
  return (
    <div
      ref={foot}
      data-testid="note-ask"
      data-mind-id={mindId}
      data-upward-open={floating ? "" : undefined}
      style={floating && folded.current !== null ? { height: folded.current } : undefined}
      className="note-ask"
    >
      {input}
    </div>
  );
}

/**
 * The folded box's top row: the AI's line, or "Show conversation" when there is none, and at its
 * end the chevron that opens the conversation.
 */
function ConversationHandle({ line, onOpen }: { line: ReactNode; onOpen(): void }) {
  const t = useT();
  return (
    <div data-testid="note-ask-handle" className="note-ask-handle">
      {line ?? (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onOpen}
          className="note-ask-pill note-ask-pill-text"
        >
          {t("noteAsk.showConversation")}
        </button>
      )}
      <button
        type="button"
        data-testid="note-ask-handle-toggle"
        aria-expanded="false"
        aria-label={t("noteAsk.showConversation")}
        title={t("noteAsk.showConversation")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onOpen}
        className="note-ask-chevron"
      >
        <ChevronRightLineIcon className="size-3.5 -rotate-90" />
      </button>
    </div>
  );
}

/**
 * The conversation's two controls while it is open upward, at its top right in line with the first
 * request, as the column has them in its top row: the move into the column, while the column fits
 * (`column`), and the fold. They take no row of their own.
 */
function PanelTools({ column, onFold }: { column: boolean; onFold(): void }) {
  const t = useT();
  return (
    <div className="note-ask-panel-tools">
      {column && <MoveConversation to="column" className="note-column-icon" />}
      <button
        type="button"
        data-testid="note-ask-fold"
        aria-expanded="true"
        aria-label={t("noteAsk.hideConversation")}
        title={t("noteAsk.hideConversation")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onFold}
        className="note-column-icon"
      >
        <ChevronRightLineIcon className="size-3.5 rotate-90" />
      </button>
    </div>
  );
}

/**
 * Moves the open conversation between its two places (#3677): up from the box at the Note's foot
 * into the window's column, and back. It stays open, and the one input goes with it.
 */
export function MoveConversation({
  to,
  className,
}: {
  to: "column" | "upward";
  className: string;
}) {
  const t = useT();
  const label = t(to === "column" ? "noteColumn.moveLeft" : "noteColumn.moveDown");
  return (
    <button
      type="button"
      data-testid={to === "column" ? "conversation-move-left" : "conversation-move-down"}
      aria-label={label}
      title={label}
      // The input keeps the focus as it moves with the conversation.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => moveConversation(to)}
      className={className}
    >
      {to === "column" ? (
        <DockLeftLineIcon className="size-3.5" />
      ) : (
        <DockBottomLineIcon className="size-4" />
      )}
    </button>
  );
}

/** Whether the Note has a conversation kept, read as it opens and as each request ends. */
function useKeptConversation(mindId: string, state: string | null): boolean {
  const [kept, setKept] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as each request ends.
  useEffect(() => {
    let current = true;
    core.noteConversationKept(mindId).then((kept) => {
      if (current) setKept(kept);
    }, useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [mindId, state]);
  return kept;
}

/**
 * Show conversation, at the Note's top right beside its menu, as the User's AI app has Show chat in
 * its page's header (#3677). It shows wherever the Note has its input, since the conversation is a
 * place to ask too.
 */
export function NoteConversationButton({ mindId }: { mindId: string }) {
  const t = useT();
  const shown = useNoteAskShown(mindId);
  const open = useConversationOpen(mindId);
  if (!shown) return null;
  return (
    <button
      type="button"
      data-testid="note-ask-conversation-toggle"
      data-conversation-toggle=""
      aria-expanded={open}
      aria-label={t(open ? "noteAsk.hideConversation" : "noteAsk.showConversation")}
      title={t(open ? "noteAsk.hideConversation" : "noteAsk.showConversation")}
      // The input keeps the focus as it moves between the Note's foot and the conversation.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setColumnOpen(mindId, !open)}
      className="note-conversation-button"
    >
      <ConversationLineIcon className="size-4" />
    </button>
  );
}
