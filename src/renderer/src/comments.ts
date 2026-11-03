/**
 * Comments on a Mind's text (#328), the window's side: the record in the
 * Mind's `comments` map, the mark on the words it is on, the cards beside the
 * text, and what each action does with Undo. The mark is only an anchor; the
 * comment lives in the map, so it stays when its words are deleted.
 */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { create } from "zustand";
import {
  COMMENT_MARK,
  type CommentMessage,
  MIND_COMMENTS_FIELD,
  type MindComment,
} from "../../core/api";
import { mindCommentsOf, readMindComment } from "../../shared/mindComments";
import { commentRuns } from "./editor/commentSchema";
import { translateNow } from "./i18n";
import type { Words } from "./lineNames";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

/** The assistant's name as a comment's author, in both languages. */
export const ASSISTANT_AUTHOR = "IncarnaMind";

/** Where the words a comment is on start and end, in the editor's document. */
export interface CommentPlace {
  from: number;
  to: number;
}

export const commentMapOf = (doc: Y.Doc | null): Y.Map<unknown> | null =>
  doc ? doc.getMap(MIND_COMMENTS_FIELD) : null;

export function commentById(doc: Y.Doc | null, id: string): MindComment | null {
  return readMindComment(commentMapOf(doc)?.get(id));
}

export function commentsOf(doc: Y.Doc | null): MindComment[] {
  return doc ? mindCommentsOf(doc) : [];
}

/** The ids of the comments a Mind holds, for drawing only live ones. */
export function commentIdsOf(doc: Y.Doc | null): ReadonlySet<string> {
  return new Set(commentsOf(doc).map((comment) => comment.id));
}

const write = (doc: Y.Doc, id: string, comment: MindComment | null): void => {
  const map = commentMapOf(doc);
  if (!map) return;
  if (comment) map.set(id, comment);
  else map.delete(id);
};

/**
 * One Undo step for a change to a comment: `before` and `after` are the
 * record as it was and as it is, by id, and the editor's own changes aren't
 * touched. Deleting a comment takes its record away and leaves the mark on
 * its words, so Undo puts it back where it was however the text has moved.
 */
function pushCommentChange(
  said: Words,
  doc: Y.Doc,
  id: string,
  before: MindComment | null,
  after: MindComment | null,
): void {
  useUndo.getState().push({
    said,
    undo: async () => write(doc, id, before),
    redo: async () => write(doc, id, after),
  });
}

/** What the interface shows as a message's author: its own name, the User's, or "Someone" when the file named none. */
export function authorName(author: string | null, me: string, someone: string): string {
  return author === null ? me : author === "" ? someone : author;
}

/** The name the User's own comments go under: Settings' name, or "Me". */
export function myName(): string {
  return useAppStore.getState().settings?.author?.trim() || translateNow("comments.me");
}

const now = (): string => new Date().toISOString();

/** A new message by the User: null author means theirs. */
export function localMessage(text: string): CommentMessage {
  return { id: crypto.randomUUID(), author: null, createdAt: now(), text };
}

function withReply(comment: MindComment, reply: CommentMessage): MindComment {
  return { ...comment, replies: [...comment.replies, reply] };
}

/**
 * The comment a new one starts as: no text yet, beside the words it is on.
 * It isn't an Undo step until it is saved: cancelling takes it away whole.
 */
export function startComment(doc: Y.Doc, id = crypto.randomUUID()): MindComment {
  const comment: MindComment = {
    id,
    author: null,
    createdAt: now(),
    text: "",
    resolvedAt: null,
    replies: [],
  };
  write(doc, id, comment);
  return comment;
}

export function unmarkSelection(editor: Editor, place: CommentPlace): void {
  if (editor.isDestroyed) return;
  editor.chain().focus().setTextSelection(place).unsetMark(COMMENT_MARK).run();
}

/** Saves a new comment's text: one Undo step takes the whole comment away. */
export function saveComment(doc: Y.Doc, id: string, text: string): void {
  const before = commentById(doc, id);
  if (!before) return;
  const after = { ...before, text };
  write(doc, id, after);
  pushCommentChange((t) => t("undo.addedComment"), doc, id, null, after);
}

/**
 * Starts a comment on the selection: its record, its mark, and its card open
 * to type. Words already commented on open that comment's thread instead: one
 * mark holds one comment, as the text can carry.
 */
export function commentOnSelection(editor: Editor, mindId: string, doc: Y.Doc): void {
  const { from, to, empty } = editor.state.selection;
  if (editor.isDestroyed || empty) return;
  // A comment still in the Mind opens its thread. A mark whose record is gone (a deleted
  // comment, or Undo hasn't put it back) is not a comment: the new mark replaces it.
  const touched = commentRuns(editor.state.doc).filter((run) => run.from < to && run.to > from);
  const existing = touched.find((run) => commentById(doc, run.id) !== null);
  if (existing) {
    useCommentsUi.getState().ask(mindId, existing.id);
    return;
  }
  const id = crypto.randomUUID();
  startComment(doc, id);
  editor.chain().focus().setMark(COMMENT_MARK, { id }).run();
  useCommentsUi.getState().startDraft({ mindId, id, place: { from, to } });
}

/** Cancels a comment that was never saved, with its mark. */
export function cancelComment(
  editor: Editor,
  doc: Y.Doc,
  id: string,
  place: CommentPlace | null,
): void {
  write(doc, id, null);
  if (place) unmarkSelection(editor, place);
}

export function replyToComment(
  doc: Y.Doc,
  id: string,
  text: string,
  author: string | null = null,
): void {
  const before = commentById(doc, id);
  if (!before || text.trim() === "") return;
  const after = withReply(before, { ...localMessage(text), author });
  write(doc, id, after);
  pushCommentChange((t) => t("undo.repliedToComment"), doc, id, before, after);
}

export function editComment(doc: Y.Doc, id: string, messageId: string | null, text: string): void {
  const before = commentById(doc, id);
  if (!before || text.trim() === "") return;
  const after =
    messageId === null
      ? { ...before, text }
      : {
          ...before,
          replies: before.replies.map((reply) =>
            reply.id === messageId ? { ...reply, text } : reply,
          ),
        };
  write(doc, id, after);
  pushCommentChange((t) => t("undo.editedComment"), doc, id, before, after);
}

export function resolveComment(doc: Y.Doc, id: string, resolved: boolean): void {
  const before = commentById(doc, id);
  if (!before) return;
  const after = { ...before, resolvedAt: resolved ? now() : null };
  if (before.resolvedAt === after.resolvedAt) return;
  write(doc, id, after);
  pushCommentChange(
    (t) => (resolved ? t("undo.resolvedComment") : t("undo.reopenedComment")),
    doc,
    id,
    before,
    after,
  );
}

export function deleteComment(doc: Y.Doc, id: string): void {
  const before = commentById(doc, id);
  if (!before) return;
  write(doc, id, null);
  pushCommentChange((t) => t("undo.deletedComment"), doc, id, before, null);
}

/** Where a comment is in the Mind's page: the text it's on, or none when all of it was deleted. */
export function placeOf(editor: Editor, id: string): CommentPlace | null {
  const runs = commentRuns(editor.state.doc).filter((run) => run.id === id);
  const first = runs[0];
  const last = runs.at(-1);
  return first && last ? { from: first.from, to: last.to } : null;
}

export function quoteAt(editor: Editor, place: CommentPlace): string {
  return editor.state.doc.textBetween(place.from, place.to, " ");
}

interface CommentsUi {
  /** The comment being typed, opened beside its words. */
  draft: { mindId: string; id: string; place: CommentPlace | null } | null;
  /** The card asked for by a click in the list: scrolled to, and focused. */
  asked: { mindId: string; id: string } | null;
  listOpen: string | null;
  startDraft(value: NonNullable<CommentsUi["draft"]>): void;
  /** The draft is saved or cancelled: the composer isn't asked for any more. */
  endDraft(): void;
  ask(mindId: string, id: string): void;
  askedShown(): void;
  showList(mindId: string | null): void;
}

export const useCommentsUi = create<CommentsUi>()((set) => ({
  draft: null,
  asked: null,
  listOpen: null,
  startDraft: (draft) => set({ draft }),
  endDraft: () => set({ draft: null }),
  ask: (mindId, id) => set({ asked: { mindId, id } }),
  askedShown: () => set({ asked: null }),
  showList: (mindId) => set({ listOpen: mindId }),
}));
