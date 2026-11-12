import { Extension, Mark } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { COMMENT_MARK } from "../../../core/api";
import { ySyncOf } from "../../../shared/markKeys";

/** The comment a mark holds, by the record's id: null when it holds none. */
export const commentOfMark = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
};

/**
 * The mark on the words a comment is on (#328): only its id is stored, in the
 * Mind's own text. It carries no HTML in or out, so pasted text never becomes
 * a comment; the comment layer draws the quiet underline for live comments, so
 * a deleted comment leaves no mark on the page.
 */
export const Comment = Mark.create({
  name: COMMENT_MARK,
  inclusive: false,
  addAttributes: () => ({
    id: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
  }),
  parseHTML: () => [],
  renderHTML: () => ["span", {}, 0],
  // Each comment under a key of its own in the editor's Yjs sync (patches/y-tiptap/marks.mjs, #2996).
  extendMarkSchema: (extension) => (extension.name === COMMENT_MARK ? ySyncOf(COMMENT_MARK) : {}),
});

export const COMMENTS_REDRAWN = "commentsRedrawn";

const commentDecorationsKey = new PluginKey("commentDecorations");

/** Runs of text with a comment mark, as `{from, to, id, text}` in document order. */
export function commentRuns(doc: ProseMirrorNode): { from: number; to: number; id: string }[] {
  const runs: { from: number; to: number; id: string }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((each) => each.type.name === COMMENT_MARK);
    const id = mark && commentOfMark(mark.attrs);
    if (!id) return;
    const last = runs.at(-1);
    if (last && last.to === pos && last.id === id) last.to = pos + node.nodeSize;
    else runs.push({ from: pos, to: pos + node.nodeSize, id });
  });
  return runs;
}

/**
 * The marks live comments draw, as decorations rather than mark HTML: the
 * quiet underline, and the data the cards and clicks find their words by. A
 * comment the User deleted keeps its mark on the words but draws nothing, and
 * Undo brings the line back.
 */
export function commentDecorations(live: () => ReadonlySet<string>): Extension {
  const build = (doc: ProseMirrorNode): DecorationSet => {
    const shown = live();
    const marks = commentRuns(doc)
      .filter((run) => shown.has(run.id))
      .map((run) =>
        Decoration.inline(run.from, run.to, {
          class: "comment-mark",
          "data-comment-id": run.id,
        }),
      );
    return DecorationSet.create(doc, marks);
  };
  return Extension.create({
    name: "commentDecorations",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: commentDecorationsKey,
          state: {
            init: (_config, state) => build(state.doc),
            apply: (tr: Transaction, value: DecorationSet) =>
              tr.docChanged || tr.getMeta(COMMENTS_REDRAWN)
                ? build(tr.doc)
                : value.map(tr.mapping, tr.doc),
          },
          props: {
            decorations: (state) => commentDecorationsKey.getState(state),
          },
        }),
      ];
    },
  });
}
