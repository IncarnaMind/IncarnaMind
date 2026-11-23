import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { AskArrowIcon, RemoveIcon } from "../../editor/icons";
import { useT } from "../../i18n";
import { StopIcon } from "../icons";
import { TypingTextarea } from "../TypingTextarea";
import { NoteModelChoice } from "./NoteModelChoice";

/** Whether the input had the focus, and where its caret was, when it last left its place. */
export interface InputCarry {
  focused: boolean;
  start: number;
  end: number;
}

/**
 * The Note's one input (#3677): one rounded box, the only thing that draws its outline. Its rows
 * lay out inside it on the same left and right edges: the conversation when it opens upward, the
 * top row while the AI has a line, and the input row (the selection it is about, the words, the
 * model and Send, which is Stop while a request runs). It is at the Note's foot, or at the column's
 * foot while the column is open, drawn anew in each place, so it takes the focus and the caret
 * along with the words its owner keeps.
 */
export function NoteAskInput({
  mindId,
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
  useLayoutEffect(() => {
    const element = input.current;
    const was = carry.current;
    carry.current = null;
    if (element && was?.focused) {
      element.focus();
      element.setSelectionRange(was.start, was.end);
    }
    return () => {
      if (!element) return;
      carry.current = {
        focused: document.activeElement === element,
        start: element.selectionStart,
        end: element.selectionEnd,
      };
    };
  }, [carry]);
  const placeholder = t("noteAsk.placeholder");
  return (
    <div data-testid="note-ask-box" data-mind-id={mindId} className="note-ask-box">
      {panel}
      {line && (
        <div data-testid="note-ask-top" className="note-ask-top">
          {line}
        </div>
      )}
      <div data-testid="note-ask-row" className="note-ask-row">
        {quote !== "" && (
          <div className="note-ask-input-about">
            <span data-testid="note-ask-quote" className="note-ask-input-quote">
              <span className="truncate">“{quote}”</span>
              <button
                type="button"
                data-testid="note-ask-quote-remove"
                aria-label={t("noteAsk.wholeNote")}
                title={t("noteAsk.wholeNote")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={onWholeNote}
                className="scope-chip-remove"
              >
                <RemoveIcon className="size-2.5" />
              </button>
            </span>
          </div>
        )}
        <TypingTextarea
          ref={input}
          data-testid="note-ask-input"
          data-note-ask-input={mindId}
          aria-label={placeholder}
          placeholder={placeholder}
          rows={1}
          value={words}
          onChange={(event) => onWords(event.target.value)}
          onKeyDown={onKeyDown}
          className="note-ask-input-text"
        />
        <NoteModelChoice mindId={mindId} busy={working} />
        {working ? (
          <button
            type="button"
            data-testid="note-ask-stop"
            aria-label={t("noteAsk.stop")}
            title={t("noteAsk.stop")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onStop}
            className="note-ask-round"
          >
            <StopIcon className="size-3" />
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
            <AskArrowIcon className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}
