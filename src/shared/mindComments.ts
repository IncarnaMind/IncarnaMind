import type * as Y from "yjs";
import {
  type CommentMessage,
  MIND_COMMENTS_FIELD,
  type MindComment,
  type WordCommentMark,
} from "../core/api";
import { isRecord } from "../core/errors";

const text = (value: unknown): value is string => typeof value === "string" && value !== "";

const isDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

function readWordCommentMark(value: unknown): WordCommentMark | null {
  if (!isRecord(value) || typeof value.id !== "number" || !Number.isInteger(value.id)) return null;
  if (value.paraId !== null && !text(value.paraId)) return null;
  return { id: value.id, paraId: value.paraId };
}

export function readCommentMessage(value: unknown): CommentMessage | null {
  if (!isRecord(value) || !text(value.id) || !isDate(value.createdAt)) return null;
  if (typeof value.text !== "string") return null;
  if (value.author !== null && !text(value.author)) return null;
  const word = readWordCommentMark(value.word);
  return {
    id: value.id,
    author: value.author,
    createdAt: value.createdAt,
    text: value.text,
    ...(word && { word }),
  };
}

/** A record in a Mind's `comments` map, or null when it isn't one (a newer version may write more). */
export function readMindComment(value: unknown): MindComment | null {
  const message = readCommentMessage(value);
  if (!message || !isRecord(value)) return null;
  if (value.resolvedAt !== null && !isDate(value.resolvedAt)) return null;
  if (!Array.isArray(value.replies)) return null;
  const replies = value.replies.map(readCommentMessage);
  if (replies.some((reply) => reply === null)) return null;
  return {
    ...message,
    resolvedAt: value.resolvedAt,
    replies: replies as CommentMessage[],
  };
}

/** The Mind's comments in the order they were written, or imported. */
export function mindCommentsOf(doc: Y.Doc): MindComment[] {
  const map = doc.getMap(MIND_COMMENTS_FIELD);
  const comments: MindComment[] = [];
  map.forEach((value) => {
    const comment = readMindComment(value);
    if (comment) comments.push(comment);
  });
  return comments.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
