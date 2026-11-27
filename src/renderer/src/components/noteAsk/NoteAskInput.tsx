import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { clearFieldUndoPending, markFieldUndoPending } from "../../commands/edit";
import { useT } from "../../i18n";
import { AskArrowIcon, MindLineIcon, RemoveIcon, StopLineIcon } from "../icons";
import { TypingTextarea } from "../TypingTextarea";
import { NoteModeChoice } from "./NoteModeChoice";
import { NoteModelChoice } from "./NoteModelChoice";

/**
 * Whether the input had the focus, and where its caret was, when it last left its place;
 * `composed`: it left while the IME was composing, so its words went back to these, before it.
 */
export interface InputCarry {
  focused: boolean;
  start: number;
  end: number;
  composed: string | null;
}

/**
 * The Note's one input (#3677, #3731): one rounded box, the only thing that draws its outline. Its
 * rows lay out inside it on the same left and right edges: the conversation when it opens upward,
 * the top row while the AI has a line, and the input row (a chip naming the Note this request is
 * about—plus selected text, or "Working in …" locked to the running Note while viewing another—
 * the words, the model, the mode, and Send/Stop).
 */
export function NoteAskInput({
  mindId,
  conversationId,
  noteTitle,
  workingMindId = null,
  workingNoteTitle = "",
  onOpenWorkingNote,
  words,
  onWords,
  quote,
  onWholeNote,
  working,
  onSend,
  onStop,
  onKeyDown,
  carry,
  line = null,
  panel = null,
}: {
  mindId: string;
  conversationId: string | null;
  noteTitle: string;
  workingMindId?: string | null;
  workingNoteTitle?: string;
  onOpenWorkingNote?(): void;
  words: string;
  onWords(words: string): void;
  quote: string;
  onWholeNote(): void;
  working: boolean;
  onSend(): void;
  onStop(): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  carry: RefObject<InputCarry | null>;
  /** The top row's left part: the AI's line, or the handle that opens the conversation. */
  line?: ReactNode;
  /** The conversation, opened upward inside the box. */
  panel?: ReactNode;
}) {
  const t = useT();
  const input = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef<{ words: string; at: number } | null>(null);
  const caretAfter = useRef<{ at: number; words: string } | null>(null);
  const wordsTo = useRef(onWords);
  wordsTo.current = onWords;
  useLayoutEffect(() => {
    const element = input.current;
    const was = carry.current;
    carry.current = null;
    if (element && was?.focused) {
      element.focus();
      element.setSelectionRange(was.start, was.end);
      if (was.composed !== null) caretAfter.current = { at: was.start, words: was.composed };
    }
    return () => {
      if (!element) return;
      const open = composing.current;
      carry.current = {
        focused: document.activeElement === element,
        start: open ? open.at : element.selectionStart,
        end: open ? open.at : element.selectionEnd,
        composed: open?.words ?? null,
      };
      if (open) wordsTo.current(open.words);
    };
  }, [carry]);
  useLayoutEffect(() => {
    const after = caretAfter.current;
    if (after === null || after.words !== words || !input.current) return;
    caretAfter.current = null;
    input.current.setSelectionRange(after.at, after.at);
  }, [words]);
  const placeholder = t("noteAsk.placeholder");
  const workingElsewhere =
    working && workingMindId !== null && workingMindId !== "" && workingMindId !== mindId;
  return (
    <div data-testid="note-ask-box" data-mind-id={mindId} className="note-ask-box">
      {panel}
      {line && (
        <div data-testid="note-ask-top" className="note-ask-top">
          {line}
        </div>
      )}
      <div data-testid="note-ask-row" className="note-ask-row">
        <div
          className={`note-ask-input-about ${workingElsewhere ? "note-ask-input-about--working" : quote !== "" ? "note-ask-input-about--quote" : ""}`}
        >
          {workingElsewhere ? (
            <button
              type="button"
              data-testid="note-ask-working-note"
              title={t("noteAsk.workingIn.open", { title: workingNoteTitle })}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onOpenWorkingNote}
              className="note-ask-input-quote note-ask-input-chip--working"
            >
              <span aria-hidden="true" className="note-ask-dots">
                <span />
                <span />
                <span />
              </span>
              <span className="truncate">
                {t("noteAsk.workingIn", { title: workingNoteTitle })}
              </span>
            </button>
          ) : quote !== "" ? (
            <span data-testid="note-ask-quote" className="note-ask-input-quote">
              <MindLineIcon className="note-ask-chip-icon" aria-hidden="true" />
              <span className="note-ask-chip-name">{noteTitle}</span>
              <span aria-hidden="true" className="note-ask-chip-sep">
                ·
              </span>
              <span className="note-ask-chip-quote">“{quote}”</span>
              <button
                type="button"
                data-testid="note-ask-quote-remove"
                aria-label={t("noteAsk.wholeNote")}
                title={t("noteAsk.wholeNote")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={onWholeNote}
                className="scope-chip-remove"
              >
                <RemoveIcon />
              </button>
            </span>
          ) : (
            <span
              data-testid="note-ask-note-chip"
              title={noteTitle}
              className="note-ask-input-quote note-ask-input-chip"
            >
              <MindLineIcon className="note-ask-chip-icon" aria-hidden="true" />
              <span className="truncate">{noteTitle}</span>
            </span>
          )}
        </div>
        <TypingTextarea
          ref={input}
          data-testid="note-ask-input"
          data-note-ask-input={mindId}
          aria-label={placeholder}
          placeholder={placeholder}
          rows={1}
          value={words}
          onChange={(event) => onWords(event.target.value)}
          onInput={(event) => {
            const native = event.nativeEvent;
            const inputType = "inputType" in native ? native.inputType : "";
            if (inputType === "historyUndo" && event.currentTarget.value === "") {
              markFieldUndoPending(event.currentTarget);
            } else {
              clearFieldUndoPending(event.currentTarget);
            }
          }}
          onBlur={(event) => clearFieldUndoPending(event.currentTarget)}
          onCompositionStart={(event) => {
            const element = event.currentTarget;
            element.setAttribute("data-composing", "");
            composing.current = { words: element.value, at: element.selectionStart };
          }}
          onCompositionEnd={(event) => {
            event.currentTarget.removeAttribute("data-composing");
            composing.current = null;
          }}
          onKeyDown={onKeyDown}
          className="note-ask-input-text"
        />
        <NoteModelChoice mindId={mindId} conversationId={conversationId} busy={working} />
        <NoteModeChoice mindId={mindId} conversationId={conversationId} />
        {working && words.trim() === "" ? (
          <button
            type="button"
            data-testid="note-ask-stop"
            aria-label={t("noteAsk.stop")}
            title={t("noteAsk.stop")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onStop}
            className="note-ask-round"
          >
            <StopLineIcon />
          </button>
        ) : (
          <button
            type="button"
            data-testid="note-ask-send"
            aria-label={t("noteAsk.send")}
            title={t("noteAsk.send")}
            disabled={words.trim() === ""}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onSend}
            className="note-ask-round"
          >
            <AskArrowIcon />
          </button>
        )}
      </div>
    </div>
  );
}
