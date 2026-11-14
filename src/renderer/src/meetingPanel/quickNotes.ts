import type {
  AddedToNote,
  AddQuickNoteInput,
  UndoAddToNoteInput,
  UndoAddToNoteResult,
} from "../../../core/api";

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
   * Ask isn't one (#2925): the core then forgets any line it held.
   */
  keep(draft: Draft, note?: boolean): void;
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
 * Note if the recording stops or the panel closes first. A line that couldn't go in comes back
 * into it, before any line begun since, though the field is collapsed meanwhile.
 */
export function quickNotesFor(
  meetingId: string,
  core: QuickNoteCore,
  drafts: Map<string, Draft>,
  report: (error: unknown) => void,
): QuickNotes {
  const draft = () => drafts.get(meetingId) ?? EMPTY;
  const keep = (next: Draft, note = true) => {
    drafts.set(meetingId, next);
    core
      .setQuickNoteDraft({
        meetingId,
        text: note ? next.text : "",
        atMs: note ? (next.began?.ms ?? null) : null,
      })
      .catch(report);
  };
  return {
    add: (text, atMs) =>
      core.addQuickNote({ meetingId, text, atMs }).catch((error: unknown) => {
        const since = draft().text;
        keep({ text: since ? `${text}\n${since}` : text, began: { ms: atMs } });
        throw error;
      }),
    undo: (added) => core.undoAddToNote(added),
    draft,
    keep,
  };
}
