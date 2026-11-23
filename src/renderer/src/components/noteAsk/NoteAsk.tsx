import type { Editor } from "@tiptap/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { askFirstAgent, useReadAgentsToAsk } from "../../askYourAi";
import { core } from "../../core";
import { useT } from "../../i18n";
import {
  askInNote,
  caretOf,
  clearNoteAsk,
  listen,
  moveConversation,
  openColumnAt,
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
  DockRightLineIcon,
} from "../lineIcons";
import { type InputCarry, NoteAskInput } from "./NoteAskInput";
import { NoteAskPill } from "./NoteAskPill";
import { NoteColumn, NoteConversationBody } from "./NoteColumn";

/** Under this width the column can't stand beside the Note: it opens as a sheet over it. */
const BESIDE_FROM = 1100;

function useBeside(): boolean {
  const [beside, setBeside] = useState(() => window.innerWidth >= BESIDE_FROM);
  useEffect(() => {
    const follow = () => setBeside(window.innerWidth >= BESIDE_FROM);
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, []);
  return beside;
}

/**
 * The Note's one input (ADR-0034, #3627), for a User whose own AI IncarnaMind runs in the
 * background: one box at the Note's foot, its top row the AI's line while there is one, saying what
 * the AI is doing and then its reply in one sentence. The conversation opens upward inside the same
 * box, or, moved there by the User, as a column at the Note's right with the input at its foot
 * (#3677). There is only ever one input, and sending never folds the conversation.
 */
export function NoteAsk({
  mindId,
  editor,
  columnSlot,
  overSlot,
}: {
  mindId: string;
  editor: Editor;
  columnSlot: HTMLElement | null;
  overSlot: HTMLElement | null;
}) {
  useReadAgentsToAsk(mindId);
  const shown = useNoteAskShown(mindId);
  if (!shown) return null;
  return <NoteAskBox mindId={mindId} editor={editor} columnSlot={columnSlot} overSlot={overSlot} />;
}

function NoteAskBox({
  mindId,
  editor,
  columnSlot,
  overSlot,
}: {
  mindId: string;
  editor: Editor;
  columnSlot: HTMLElement | null;
  overSlot: HTMLElement | null;
}) {
  const ask = useNoteAsks((state) => state.byMind[mindId]);
  const [words, setWords] = useState("");
  const carry = useRef<InputCarry | null>(null);
  const [quote, setQuote] = useState(() => selectedForRequest(editor.state)?.quote ?? "");
  const [whole, setWhole] = useState(false);
  const open = useColumnOpen(mindId);
  const place = useNoteColumns((state) => state.place);
  const beside = useBeside();
  const slot = beside ? columnSlot : overSlot;
  // With no column to open in, it opens upward.
  const upward = place === "upward" || slot === null;
  useEffect(listen, []);
  const working = ask?.state === "working";
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
    if (!open && foot.current) folded.current = foot.current.offsetHeight;
  });
  const toggle = () => setColumnOpen(mindId, !open);
  useEffect(() => {
    if (!upward || !open) return;
    const fold = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || foot.current?.contains(target)) return;
      // A menu's popover, or Show conversation at the Note's top right, which folds it itself:
      // folding here first would have its press open it again.
      if (target instanceof Element && target.closest("[popover], [data-conversation-toggle]"))
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
      onOpen={() => (upward ? toggle() : openColumnAt(mindId, ask.turnId))}
    />
  ) : null;
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
      line={
        upward ? (
          kept || ask ? (
            <ConversationHandle mindId={mindId} line={line} open={open} onToggle={toggle} />
          ) : null
        ) : open ? null : (
          line
        )
      }
      panel={
        upward && open ? (
          <div data-testid="note-ask-panel" className="note-ask-panel">
            <NoteConversationBody
              mindId={mindId}
              editor={editor}
              agent={agent}
              className="note-ask-panel-body"
            />
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
      data-upward-open={upward && open ? "" : undefined}
      style={upward && open && folded.current !== null ? { height: folded.current } : undefined}
      className="note-ask"
    >
      {input}
    </div>
  );
}

/**
 * The box's top row with the conversation upward: the AI's line, or "Show conversation" when there
 * is none, and the chevron that opens and folds it. Open, it holds only what the conversation above
 * it doesn't: a run's words while one goes, the move to the right, and the fold; the reply and its
 * one action are in the conversation then.
 */
function ConversationHandle({
  mindId,
  line,
  open,
  onToggle,
}: {
  mindId: string;
  line: ReactNode;
  open: boolean;
  onToggle(): void;
}) {
  const t = useT();
  const ask = useNoteAsks((state) => state.byMind[mindId]);
  const shownLine = open ? (ask?.state === "working" ? line : null) : line;
  return (
    <div data-testid="note-ask-handle" className="note-ask-handle">
      {shownLine ??
        (open ? (
          <span className="flex-1" />
        ) : (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onToggle}
            className="note-ask-pill note-ask-pill-text"
          >
            {t("noteAsk.showConversation")}
          </button>
        ))}
      {open && <MoveConversation to="column" className="note-ask-chevron" />}
      <button
        type="button"
        data-testid="note-ask-handle-toggle"
        aria-expanded={open}
        aria-label={t(open ? "noteAsk.hideConversation" : "noteAsk.showConversation")}
        title={t(open ? "noteAsk.hideConversation" : "noteAsk.showConversation")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggle}
        className="note-ask-chevron"
      >
        <ChevronRightLineIcon className={`size-3.5 ${open ? "rotate-90" : "-rotate-90"}`} />
      </button>
    </div>
  );
}

/**
 * Moves the open conversation between its two places (#3677): up from the box at the Note's foot
 * into the column at the Note's right, and back. It stays open, and the one input goes with it.
 */
export function MoveConversation({
  to,
  className,
}: {
  to: "column" | "upward";
  className: string;
}) {
  const t = useT();
  const label = t(to === "column" ? "noteColumn.moveRight" : "noteColumn.moveDown");
  return (
    <button
      type="button"
      data-testid={to === "column" ? "conversation-move-right" : "conversation-move-down"}
      aria-label={label}
      title={label}
      // The input keeps the focus as it moves with the conversation.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => moveConversation(to)}
      className={className}
    >
      {to === "column" ? (
        <DockRightLineIcon className="size-3.5" />
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
    core.noteConversation(mindId).then((turns) => {
      if (current) setKept(turns.length > 0);
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
  const open = useColumnOpen(mindId);
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
