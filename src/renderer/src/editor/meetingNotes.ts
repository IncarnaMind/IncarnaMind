import { type Editor, Extension, type JSONContent } from "@tiptap/core";
import { type EditorState, TextSelection } from "@tiptap/pm/state";
import type * as Y from "yjs";
import { BLOCK_ID_ATTRIBUTE, CITATION_NODE, type CitationAttributes } from "../../../core/api";
import { setBlockTimes } from "../../../shared/blockTimes";
import { useAppStore } from "../store";
import { asOneStep } from "./editorUndo";
import { type MeetingTimesOptions, meetingTimesPlugin } from "./meetingTimes";
import { notePlace } from "./notePlace";
import { shownEnd } from "./noteTabs";

/**
 * The notes written in a Meeting's Mind (#139): where a Mark and a transcript
 * line go, and the times of the lines. An editor lends itself here, by Mind,
 * while it is open.
 */
export interface MeetingNote {
  editor: Editor;
  doc: Y.Doc;
}

const open = new Map<string, MeetingNote>();
const waiting = new Map<string, Set<(note: MeetingNote) => void>>();
/** The editors the User has put the cursor in: the others have their cursor at the start, by default. */
const visited = new WeakSet<Editor>();

export const MeetingNotes = Extension.create<MeetingTimesOptions & { mindId: string }>({
  name: "meetingNotes",

  onCreate() {
    const note = { editor: this.editor, doc: this.options.doc };
    open.set(this.options.mindId, note);
    for (const resolve of waiting.get(this.options.mindId) ?? []) resolve(note);
    waiting.delete(this.options.mindId);
  },

  onFocus() {
    visited.add(this.editor);
  },

  onDestroy() {
    if (open.get(this.options.mindId)?.editor === this.editor) open.delete(this.options.mindId);
  },

  addProseMirrorPlugins() {
    return [meetingTimesPlugin(this.options)];
  },
});

/** How long to wait for a Mind's editor to open, once its tab is shown. */
const OPEN_WAIT_MS = 3000;

/**
 * The editor of this Mind's notes. When none is open (a narrow window shows
 * one tab at a time, and the User is reading the Transcript), the Mind's tab
 * is shown and its editor waited for. Null if it never opens.
 */
export async function noteOf(mindId: string): Promise<MeetingNote | null> {
  const current = open.get(mindId);
  if (current) return current;
  const opened = new Promise<MeetingNote | null>((resolve) => {
    const set = waiting.get(mindId) ?? new Set();
    waiting.set(mindId, set);
    set.add(resolve);
    setTimeout(() => {
      set.delete(resolve);
      resolve(null);
    }, OPEN_WAIT_MS);
  });
  await useAppStore.getState().changeLayout({ type: "open", item: { kind: "mind", mindId } });
  return opened;
}

/**
 * Where a new bullet goes: after the bullet the cursor is in, else where Add
 * to note puts an Answer (`notePlace`): after the Block the cursor is in, in
 * an empty line's place, at the end if the cursor was never in the notes.
 */
function placeOf(
  state: EditorState,
  visitedBefore: boolean,
): { from: number; to: number; inList: boolean } {
  if (visitedBefore) {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name === "listItem") {
        const after = $from.after(depth);
        return { from: after, to: after, inList: true };
      }
    }
  }
  return {
    ...notePlace(state.doc, visitedBefore ? state.selection : null, shownEnd(state)),
    inList: false,
  };
}

/**
 * Puts a new bullet with this content in the Mind's notes, taking the time
 * `ms` (null: none, as when nothing records), as one step of the note's Undo.
 * It moves the cursor into the bullet only with `focus`. Returns its line's
 * id, or null if the editor can't take it.
 */
export function addBullet(
  { editor, doc }: MeetingNote,
  content: JSONContent[],
  ms: number | null,
  focus: boolean,
): string | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { state } = editor;
  const { schema } = state;
  const bullets = schema.nodes.bulletList;
  const itemType = schema.nodes.listItem;
  if (!bullets || !itemType) return null;
  const item = itemType.create(null, schema.nodeFromJSON({ type: "paragraph", content }));
  const place = placeOf(state, visited.has(editor));
  const tr = state.tr;
  tr.replaceWith(place.from, place.to, place.inList ? item : bullets.create(null, item));
  const paragraph = place.from + (place.inList ? 1 : 2);
  if (focus) tr.setSelection(TextSelection.create(tr.doc, paragraph + 1)).scrollIntoView();
  asOneStep(editor, () => editor.view.dispatch(tr));
  if (focus) editor.view.focus();

  // The id is given as the line is added, by the editor's unique IDs.
  const id: unknown = editor.state.doc.nodeAt(paragraph)?.attrs[BLOCK_ID_ATTRIBUTE];
  if (typeof id !== "string") return null;
  if (ms !== null) setBlockTimes(doc, [id], ms);
  return id;
}

/** A new empty bullet with the time of this moment, the cursor in it. */
export function markNow(note: MeetingNote, ms: number): string | null {
  return addBullet(note, [], ms, true);
}

/** The position of the Citation of this quote in this Document, if the notes hold one. */
export function citationIn(editor: Editor, documentId: string, quote: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (
      found === null &&
      node.type.name === CITATION_NODE &&
      node.attrs.documentId === documentId &&
      node.attrs.quote === quote
    ) {
      found = pos;
    }
    return found === null;
  });
  return found;
}

/**
 * A line of the Transcript as a bullet: its words, then a Citation that
 * points at it. The cursor stays where it is (the User is reading the
 * Transcript). "already" if the notes hold that Citation: it is shown instead; null if the
 * notes can't take it.
 */
export function addTranscriptLine(
  note: MeetingNote,
  line: { text: string; citation: CitationAttributes },
  ms: number | null,
): string | null | "already" {
  const { editor } = note;
  const { documentId, quote } = line.citation;
  if (documentId && quote) {
    const there = citationIn(editor, documentId, quote);
    if (there !== null) {
      editor.view.dispatch(
        editor.state.tr
          .setSelection(TextSelection.near(editor.state.doc.resolve(there)))
          .scrollIntoView(),
      );
      return "already";
    }
  }
  return addBullet(
    note,
    [
      { type: "text", text: line.text },
      { type: CITATION_NODE, attrs: line.citation },
    ],
    ms,
    false,
  );
}
