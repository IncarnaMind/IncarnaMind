import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { AddedToNote, Meeting, UndoAddToNoteResult } from "../../../core/api";
import { writingTime } from "../../../shared/blockTimes";
import { clockTime } from "../../../shared/clock";
import { TypingTextarea } from "../components/TypingTextarea";
import { fieldClass } from "../components/ui";
import { AskArrowIcon } from "../editor/icons";
import { errorMessage } from "../errors";
import { useT } from "../i18n";

/** How long the field's placeholder says a quick note went in, with its Undo beside it. */
const ADDED_MS = 3000;

export interface QuickNotes {
  add(text: string, atMs: number | null): Promise<AddedToNote>;
  undo(added: AddedToNote): Promise<UndoAddToNoteResult>;
}

/** What the "/" list over the field tells it: where it is, and the row chosen. */
export interface FieldList {
  id: string;
  chosenId: string | undefined;
}

/**
 * The panel's field, for quick notes (#2925): Enter adds what it holds to the end of the
 * Meeting's Note, with the Meeting's time when typing began, and the cursor stays for the next
 * line; Shift-Enter starts a new line, and the field grows to three, then scrolls. For 3 s its
 * placeholder says it went in, with Undo at its right, so nothing under it moves. Keys a list over
 * it wants come to `listKeys` first, and no key that ends an input method's composition is acted
 * on. A press in it is what takes the keyboard (`onTakeKeyboard`).
 */
export function NoteField({
  meeting,
  field,
  text,
  onText,
  list,
  listKeys,
  notes,
  onTakeKeyboard,
}: {
  meeting: Meeting;
  field: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onText(text: string): void;
  list: FieldList | null;
  listKeys(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  notes: QuickNotes;
  onTakeKeyboard(): void;
}) {
  const t = useT();
  // When typing began, in the Meeting's time: null once a line has begun while it wasn't recording.
  const began = useRef<{ ms: number | null } | null>(null);
  const [added, setAdded] = useState<{ note: AddedToNote; atMs: number | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!added) return;
    const timer = setTimeout(() => setAdded(null), ADDED_MS);
    return () => clearTimeout(timer);
  }, [added]);

  const change = (value: string) => {
    onText(value);
    if (!value.trim() || value.startsWith("/")) began.current = null;
    else began.current ??= { ms: writingTime(meeting, Date.now()) };
  };

  const send = () => {
    const typed = text;
    if (!typed.trim() || typed.startsWith("/")) return;
    const atMs = began.current?.ms ?? null;
    began.current = null;
    onText("");
    setProblem(null);
    notes.add(typed, atMs).then(
      (note) => setAdded({ note, atMs }),
      (error: unknown) => {
        setProblem(errorMessage(error, t));
        // Back in the field, unless the User has started another line meanwhile.
        if (field.current?.value === "") {
          began.current = { ms: atMs };
          onText(typed);
        }
      },
    );
  };

  const undo = (note: AddedToNote) => {
    setAdded(null);
    setProblem(null);
    notes.undo(note).then(
      ({ kept }) => {
        if (kept > 0)
          setProblem(t(kept === 1 ? "answer.undoKept.one" : "answer.undoKept", { count: kept }));
      },
      (error: unknown) => setProblem(errorMessage(error, t)),
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

  const said =
    added &&
    (added.atMs === null
      ? t("meetings.quickNote.addedNoTime")
      : t("meetings.quickNote.added", { time: clockTime(added.atMs) }));
  return (
    <>
      <div data-testid="quick-note" className="ask-field">
        <TypingTextarea
          ref={field}
          value={text}
          rows={1}
          spellCheck={false}
          aria-label={t("meetings.quickNote")}
          aria-controls={list?.id}
          aria-activedescendant={list?.chosenId}
          placeholder={said ?? t("meetings.quickNote.placeholder")}
          data-testid="quick-note-field"
          onMouseDown={onTakeKeyboard}
          onChange={(event) => change(event.target.value)}
          onKeyDown={keyDown}
          className={`${fieldClass} ask-field-text`}
        />
        {added && (
          <button
            type="button"
            data-testid="quick-note-undo"
            onClick={() => undo(added.note)}
            className="panel-ghost ask-field-undo"
          >
            {t("move.undo")}
          </button>
        )}
        <button
          type="button"
          data-testid="quick-note-send"
          aria-label={t("meetings.quickNote.add")}
          title={t("meetings.quickNote.add")}
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
