import type {
  AddedToNote,
  AddQuickNoteInput,
  UndoAddToNoteInput,
  UndoAddToNoteResult,
} from "../../../core/api";
import type { FieldMode } from "../../../shared/meetingPanel";

/** The line in the field, and the Meeting's time when typing it began (null: not recording then). */
export interface Draft {
  text: string;
  began: { ms: number | null } | null;
}

export interface QuickNotes {
  add(text: string, atMs: number | null): Promise<AddedToNote>;
  undo(added: AddedToNote): Promise<UndoAddToNoteResult>;
  /** The line in the field as last kept: what the field shows again after a collapse. */
  draft(): Draft;
  /**
   * Keeps the line in the field; for the Note too unless `note` is false, as a question typed in
   * Ask isn't one (#2925): the core then holds only the notes that couldn't go in.
   */
  keep(draft: Draft, note?: boolean): void;
  /** A question that couldn't be asked (#2925): it waits, never kept for the Note, for Ask. */
  refuse(question: string): void;
  /**
   * What came back for the field in `mode`, now taken into it, oldest first, a line each: in Note
   * the notes that couldn't go in, with when the first was begun; in Ask the questions that
   * couldn't be asked. Null when none.
   */
  take(mode: FieldMode): Draft | null;
  /** Calls `show` when a line or a question comes back, for the field on screen; returns the stop. */
  watch(show: () => void): () => void;
}

/** What quick notes ask of the core. */
export interface QuickNoteCore {
  addQuickNote(input: AddQuickNoteInput): Promise<AddedToNote>;
  undoAddToNote(input: UndoAddToNoteInput): Promise<UndoAddToNoteResult>;
  setQuickNoteDraft(input: AddQuickNoteInput): Promise<void>;
}

const EMPTY: Draft = { text: "", began: null };

/**
 * A Meeting's quick notes from the call-help panel's field (#2925). Its unsent line is kept here,
 * by Meeting, outside the field, which a collapse unmounts, and in the core, which adds it to the
 * Note if the recording stops or the panel closes first. A line that couldn't go in, or a question
 * that couldn't be asked, comes back into the field the next time it is in its own mode, before
 * what it holds, and shows in the field on screen, though the panel was collapsed and shown again
 * meanwhile. Until then the core still holds such a line for the Note; a question waiting goes
 * with the panel or the recording.
 */
export function quickNotesFor(
  meetingId: string,
  core: QuickNoteCore,
  drafts: Map<string, Draft>,
  report: (error: unknown) => void,
): QuickNotes {
  const unsent: { text: string; atMs: number | null }[] = [];
  const waiting: string[] = [];
  let forNote = true;
  const shown = new Set<() => void>();
  const comeBack = () => {
    for (const show of shown) show();
  };
  const draft = () => drafts.get(meetingId) ?? EMPTY;
  const tell = () => {
    const { text, began } = draft();
    const line = forNote ? text : "";
    core
      .setQuickNoteDraft({
        meetingId,
        text: [...unsent.map((each) => each.text), ...(line ? [line] : [])].join("\n"),
        atMs: unsent[0]?.atMs ?? (forNote ? (began?.ms ?? null) : null),
      })
      .catch(report);
  };
  const keep = (next: Draft, note = true) => {
    drafts.set(meetingId, next);
    forNote = note;
    tell();
  };
  return {
    add: (text, atMs) =>
      core.addQuickNote({ meetingId, text, atMs }).catch((error: unknown) => {
        unsent.push({ text, atMs });
        tell();
        comeBack();
        throw error;
      }),
    undo: (added) => core.undoAddToNote(added),
    draft,
    keep,
    refuse: (question) => {
      waiting.push(question);
      comeBack();
    },
    take: (mode) => {
      if (mode === "ask") {
        const questions = waiting.splice(0);
        return questions.length > 0 ? { text: questions.join("\n"), began: null } : null;
      }
      const lines = unsent.splice(0);
      const [first] = lines;
      return first
        ? { text: lines.map((each) => each.text).join("\n"), began: { ms: first.atMs } }
        : null;
    },
    watch: (show) => {
      shown.add(show);
      return () => shown.delete(show);
    },
  };
}
