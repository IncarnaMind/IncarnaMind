import type { Editor } from "@tiptap/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { NoteTurn } from "../../../../core/api";
import { askFirstAgent, useReadAgentsToAsk } from "../../askYourAi";
import { core } from "../../core";
import { AskArrowIcon, RemoveIcon } from "../../editor/icons";
import { useT } from "../../i18n";
import {
  askInNote,
  caretOf,
  clearNoteAsk,
  selectedForRequest,
  showConversation,
  stopInNote,
  useConversationShown,
  useNoteAskShown,
  useNoteAsks,
} from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { StopIcon } from "../icons";
import { TypingTextarea } from "../TypingTextarea";
import { NoteAskPill, Reply } from "./NoteAskPill";

/**
 * The input at a Note's foot (ADR-0034, #3627), for a User whose own AI IncarnaMind runs in the
 * background, as the User's AI app shows its own (#3677): they say what they want, with the words
 * selected as its context; one line above it says what the AI is doing and then the first words
 * of its reply; Send is Stop while it runs; and the Note's conversation opens from its top right,
 * or from the line, at the reply.
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
  const [quote, setQuote] = useState(() => selectedForRequest(editor.state)?.quote ?? "");
  const [whole, setWhole] = useState(false);
  const open = useConversationShown((state) => state.byMind[mindId] === true);
  const working = ask?.state === "working";

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
      else if (open) showConversation(mindId, false);
      else return;
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // While a run goes, Return sends nothing new: only Stop and Esc act (the owner, 2026-11-22).
    if (!working) void send();
  };

  const placeholder = t("noteAsk.placeholder");
  return (
    <div data-testid="note-ask" data-mind-id={mindId} className="note-ask">
      {open && <NoteConversation mindId={mindId} onClose={() => showConversation(mindId, false)} />}
      <div className="note-ask-over">
        {/* The reply is in one place at a time: the line, or the conversation. */}
        {ask && (working || !open) && (
          <NoteAskPill
            ask={ask}
            mindId={mindId}
            editor={editor}
            onOpen={() => showConversation(mindId, true)}
          />
        )}
      </div>
      <div className="composer">
        {quote !== "" && !whole && (
          <div className="note-ask-quote">
            <span data-testid="note-ask-quote" className="question-skill">
              <span className="truncate">“{quote}”</span>
              <button
                type="button"
                data-testid="note-ask-quote-remove"
                aria-label={t("noteAsk.wholeNote")}
                title={t("noteAsk.wholeNote")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setWhole(true)}
                className="scope-chip-remove"
              >
                <RemoveIcon className="size-2.5" />
              </button>
            </span>
          </div>
        )}
        <div className="composer-row">
          <TypingTextarea
            data-testid="note-ask-input"
            data-note-ask-input=""
            aria-label={placeholder}
            placeholder={placeholder}
            rows={1}
            value={words}
            onChange={(event) => {
              setWords(event.target.value);
              if (ask && ask.state !== "working") clearNoteAsk(mindId);
            }}
            onKeyDown={onKeyDown}
            className="composer-input"
          />
          {working ? (
            <button
              type="button"
              data-testid="note-ask-stop"
              aria-label={t("noteAsk.stop")}
              title={t("noteAsk.stop")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void stopInNote(mindId)}
              className="composer-ask"
            >
              <StopIcon className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              data-testid="note-ask-send"
              aria-label={t("noteAsk.send")}
              title={t("noteAsk.send")}
              disabled={words.trim() === ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void send()}
              className="composer-ask"
            >
              <AskArrowIcon className="size-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The Note's conversation, as IncarnaMind keeps it: each request and its reply, oldest first. */
function NoteConversation({ mindId, onClose }: { mindId: string; onClose(): void }) {
  const t = useT();
  const [turns, setTurns] = useState<readonly NoteTurn[] | null>(null);
  const latest = useNoteAsks((state) => state.byMind[mindId]?.state);
  const last = useRef<HTMLDivElement | null>(null);
  // Opened from the line, it shows that reply: the latest, at its foot.
  useEffect(() => {
    if (turns?.length) last.current?.scrollIntoView({ block: "end" });
  }, [turns]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as each request ends.
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
  }, [mindId, latest]);
  return (
    <section
      data-testid="note-ask-conversation"
      aria-label={t("noteAsk.conversation")}
      className="note-ask-conversation"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {turns?.length === 0 && <p className="note-ask-empty">{t("noteAsk.conversationEmpty")}</p>}
      {turns?.map((turn, at) => (
        <div
          key={turn.id}
          ref={at === turns.length - 1 ? last : undefined}
          data-testid="note-ask-turn"
          className="note-ask-turn"
        >
          <p className="note-ask-request">
            {turn.request}
            {turn.quote !== "" && <span className="note-ask-turn-quote"> “{turn.quote}”</span>}
          </p>
          {turn.reply !== "" && <Reply text={turn.reply} />}
        </div>
      ))}
    </section>
  );
}
