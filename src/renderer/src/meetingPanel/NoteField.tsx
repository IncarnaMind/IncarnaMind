import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { AddedToNote, Meeting } from "../../../core/api";
import { writingTime } from "../../../shared/blockTimes";
import { clockTime } from "../../../shared/clock";
import type { FieldMode } from "../../../shared/meetingPanel";
import { TypingTextarea } from "../components/TypingTextarea";
import { fieldClass, segmentClass, segmentedClass } from "../components/ui";
import { AskArrowIcon } from "../editor/icons";
import { errorMessage } from "../errors";
import { useT } from "../i18n";
import type { QuickNotes } from "./quickNotes";

/** How long the field's placeholder says a quick note went in, with its Undo beside it. */
const ADDED_MS = 3000;

const MODES = ["note", "ask"] as const satisfies readonly FieldMode[];

/** A quick note the field says went in, with the time it took. */
interface Added {
  note: AddedToNote;
  atMs: number | null;
}

/** What the "/" list over the field tells it: where it is, and the row chosen. */
export interface FieldList {
  id: string;
  chosenId: string | undefined;
}

/**
 * The panel's field (#2925), with Note | Ask at its left. In Note, Enter adds what it holds to the
 * end of the Meeting's Note, with the Meeting's time when typing began, and for 3 s its placeholder
 * says it went in, with Undo at its right, so nothing under it moves. In Ask, Enter asks it about
 * the call (`onQuestion`); a question that couldn't be asked comes back into an empty field. Either
 * way the cursor stays for the next line; Shift-Enter starts a new line, and the field grows to
 * three, then scrolls. Keys a list over it wants come to `listKeys` first, and no key that ends an
 * input method's composition is acted on. A press in it is what takes the keyboard
 * (`onTakeKeyboard`). What it holds is kept (`notes.keep`) as it changes, but never while an input
 * method is still composing: text not committed yet isn't the User's line. Only a line in Note is
 * kept to go into the Note if the panel closes or the recording stops.
 */
export function NoteField({
  meeting,
  field,
  text,
  onText,
  mode,
  onMode,
  list,
  listKeys,
  notes,
  onQuestion,
  onTakeKeyboard,
}: {
  meeting: Meeting;
  field: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onText(text: string): void;
  mode: FieldMode;
  onMode(mode: FieldMode): void;
  list: FieldList | null;
  listKeys(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  notes: QuickNotes;
  /** Asks the question; resolves to whether it was asked. */
  onQuestion(text: string): Promise<boolean>;
  onTakeKeyboard(): void;
}) {
  const t = useT();
  const began = useRef(notes.draft().began);
  const composing = useRef(false);
  const [added, setAdded] = useState<Added | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const asking = mode === "ask";

  useEffect(() => {
    if (!added) return;
    const timer = setTimeout(() => setAdded(null), ADDED_MS);
    return () => clearTimeout(timer);
  }, [added]);

  // Only a change: a field just shown, empty, must not tell the core to forget a line it holds.
  // A change of mode too, as a question is never kept for the Note.
  const keptAs = useRef(mode);
  useEffect(() => {
    if (composing.current) return;
    if (text === notes.draft().text && keptAs.current === mode) return;
    keptAs.current = mode;
    notes.keep({ text, began: began.current }, mode === "note");
  }, [text, mode, notes]);

  const change = (value: string) => {
    onText(value);
    if (!value.trim() || value.startsWith("/")) began.current = null;
    else began.current ??= { ms: writingTime(meeting, Date.now()) };
  };

  const addNote = (typed: string) => {
    const atMs = began.current?.ms ?? null;
    began.current = null;
    onText("");
    // Before the core answers: a refusal puts the line back into what is kept now.
    notes.keep({ text: "", began: null }, true);
    notes.add(typed, atMs).then(
      (note) => setAdded({ note, atMs }),
      (error: unknown) => {
        setProblem(errorMessage(error, t));
        // `notes` put it back, before any line begun since: the field shows what it kept.
        const back = notes.draft();
        began.current = back.began;
        onText(back.text);
      },
    );
  };

  const ask = (typed: string) => {
    began.current = null;
    onText("");
    notes.keep({ text: "", began: null }, false);
    void onQuestion(typed.trim()).then((asked) => {
      if (asked || notes.draft().text) return;
      began.current = null;
      onText(typed);
    });
  };

  const send = () => {
    const typed = text;
    if (!typed.trim() || typed.startsWith("/")) return;
    setProblem(null);
    if (asking) ask(typed);
    else addNote(typed);
  };

  const undo = (shown: Added) => {
    setAdded(null);
    setProblem(null);
    notes.undo(shown.note).then(
      ({ kept }) => {
        if (kept > 0)
          setProblem(t(kept === 1 ? "answer.undoKept.one" : "answer.undoKept", { count: kept }));
      },
      (error: unknown) => {
        setProblem(errorMessage(error, t));
        // The note is still in the Note: its Undo stays offered, to try again.
        setAdded(shown);
      },
    );
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (listKeys(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const shownAdded = asking ? null : added;
  const said =
    shownAdded &&
    (shownAdded.atMs === null
      ? t("meetings.quickNote.addedNoTime")
      : t("meetings.quickNote.added", { time: clockTime(shownAdded.atMs) }));
  const name = t(asking ? "meetings.question" : "meetings.quickNote");
  const sendName = t(asking ? "meetings.question.send" : "meetings.quickNote.add");
  return (
    <>
      <div data-testid="quick-note" data-mode={mode} className="ask-field">
        <div
          role="radiogroup"
          aria-label={t("meetings.field.mode")}
          data-testid="field-mode"
          className={`${segmentedClass} ask-field-mode`}
        >
          {MODES.map((each) => (
            <label key={each} className={`${segmentClass} ask-field-segment`}>
              <input
                type="radio"
                name={`field-mode-${meeting.id}`}
                value={each}
                data-testid={`field-mode-${each}`}
                checked={mode === each}
                onChange={() => onMode(each)}
                className="sr-only"
              />
              {t(each === "note" ? "meetings.field.note" : "meetings.field.ask")}
            </label>
          ))}
        </div>
        <TypingTextarea
          ref={field}
          value={text}
          rows={1}
          spellCheck={false}
          aria-label={name}
          aria-controls={list?.id}
          aria-activedescendant={list?.chosenId}
          placeholder={
            said ?? t(asking ? "meetings.question.placeholder" : "meetings.quickNote.placeholder")
          }
          data-testid="quick-note-field"
          onMouseDown={onTakeKeyboard}
          onChange={(event) => change(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            notes.keep({ text: event.currentTarget.value, began: began.current }, !asking);
          }}
          onKeyDown={keyDown}
          className={`${fieldClass} ask-field-text`}
        />
        {shownAdded && (
          <button
            type="button"
            data-testid="quick-note-undo"
            onClick={() => undo(shownAdded)}
            className="panel-ghost ask-field-undo"
          >
            {t("move.undo")}
          </button>
        )}
        <button
          type="button"
          data-testid="quick-note-send"
          aria-label={sendName}
          title={sendName}
          onClick={send}
          className="composer-ask ask-field-send"
        >
          <AskArrowIcon className="size-3" />
        </button>
        <span role="status" className="sr-only">
          {said}
        </span>
      </div>
      {problem && (
        <p role="alert" data-testid="quick-note-problem" className="panel-line ask-field-problem">
          {problem}
        </p>
      )}
    </>
  );
}
