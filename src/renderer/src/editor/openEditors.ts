/**
 * The editors open in this window, by the Mind each shows: where a change the
 * User asked the assistant for applies (#880), in a Mind that may only just
 * have opened in a tab.
 */
import type { Editor } from "@tiptap/core";

const open = new Map<string, Editor[]>();
const waiting = new Map<string, ((editor: Editor) => void)[]>();

export function registerMindEditor(mindId: string, editor: Editor): () => void {
  open.set(mindId, [...(open.get(mindId) ?? []), editor]);
  for (const resolve of waiting.get(mindId) ?? []) resolve(editor);
  waiting.delete(mindId);
  return () => {
    const left = (open.get(mindId) ?? []).filter((each) => each !== editor);
    if (left.length > 0) open.set(mindId, left);
    else open.delete(mindId);
  };
}

export const mindEditor = (mindId: string): Editor | null =>
  open.get(mindId)?.find((each) => !each.isDestroyed) ?? null;

/** Every editor open in this window, each Mind's. */
export const openMindEditors = (): Editor[] =>
  [...open.values()].flat().filter((each) => !each.isDestroyed);

/** The Mind's editor once one is open, or null after `timeoutMs`; null `timeoutMs`: however long that takes. */
export function whenMindEditor(mindId: string, timeoutMs: number | null): Promise<Editor | null> {
  const found = mindEditor(mindId);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const done = (editor: Editor | null) => {
      if (timer !== null) clearTimeout(timer);
      waiting.set(
        mindId,
        (waiting.get(mindId) ?? []).filter((each) => each !== done),
      );
      resolve(editor);
    };
    const timer = timeoutMs === null ? null : setTimeout(() => done(null), timeoutMs);
    waiting.set(mindId, [...(waiting.get(mindId) ?? []), done]);
  });
}
