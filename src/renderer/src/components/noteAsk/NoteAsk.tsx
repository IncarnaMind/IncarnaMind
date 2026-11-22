import type { Editor } from "@tiptap/react";
import { type KeyboardEvent, useEffect, useState } from "react";
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
  stopInNote,
  useNoteAskShown,
  useNoteAsks,
} from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { StopIcon } from "../icons";
import { TypingTextarea } from "../TypingTextarea";
import { NoteAskCard, NoteAskPill, Reply } from "./NoteAskPill";

/**
 * The input at a Note's foot (ADR-0034, #3627), for a User whose own AI IncarnaMind runs in the
 * background, as the User's AI app shows its own (#3677): they say what they want, with the words
 * selected as its context; one pill above it says what the AI is doing and then the first words
 * of its reply; Send is Stop while it runs; and the Note's conversation opens on request.
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
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState(false);
  const kept = useKeptConversation(mindId, ask?.state ?? null);
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
    setOpen(false);
    setCard(false);
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
      else if (card) setCard(false);
      else if (open) setOpen(false);
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
      {open && <NoteConversation mindId={mindId} onClose={() => setOpen(false)} />}
      {ask && card && !working ? (
        <NoteAskCard
          ask={ask}
          mindId={mindId}
          editor={editor}
          onClose={() => setCard(false)}
          onOpenChat={() => {
            setCard(false);
            setOpen(true);
          }}
        />
      ) : (
        <div className="note-ask-over">
          {/* The reply is in one place at a time: the pill, its card, or the conversation. */}
          {ask && (working || !open) && (
            <NoteAskPill ask={ask} mindId={mindId} editor={editor} onOpen={() => setCard(true)} />
          )}
          {(kept || ask) && !working && (
            <ConversationToggle open={open} onToggle={() => setOpen((was) => !was)} />
          )}
        </div>
      )}
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
              if (ask && ask.state !== "working") {
                clearNoteAsk(mindId);
                setCard(false);
              }
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

function ConversationToggle({ open, onToggle }: { open: boolean; onToggle(): void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="note-ask-conversation-toggle"
      aria-expanded={open}
      onClick={onToggle}
      className="note-ask-toggle"
    >
      {t(open ? "noteAsk.hideConversation" : "noteAsk.showConversation")}
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

/** The Note's conversation, as IncarnaMind keeps it: each request and its reply, oldest first. */
function NoteConversation({ mindId, onClose }: { mindId: string; onClose(): void }) {
  const t = useT();
  const [turns, setTurns] = useState<readonly NoteTurn[] | null>(null);
  const latest = useNoteAsks((state) => state.byMind[mindId]?.state);
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
      {turns?.map((turn) => (
        <div key={turn.id} data-testid="note-ask-turn" className="note-ask-turn">
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
