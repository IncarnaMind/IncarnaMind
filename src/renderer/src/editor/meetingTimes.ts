import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type * as Y from "yjs";
import { ANSWER_BLOCK, BLOCK_ID_ATTRIBUTE, MIND_BLOCK_TIMES_FIELD } from "../../../core/api";
import { blockTimeOf, blockTimes, setBlockTimes } from "../../../shared/blockTimes";
import { clockTime } from "../../../shared/clock";

/** The lines the User writes in: a Question or an Answer is not one. */
const LINE_TYPES: ReadonlySet<string> = new Set(["paragraph", "heading", "codeBlock"]);

export interface MeetingTimesOptions {
  doc: Y.Doc;
  /** The Meeting's time for a line written now, in ms; null when no time is taken (not recording). */
  time(): number | null;
}

const timesKey = new PluginKey<DecorationSet>("meetingTimes");

/** The ids of the lines with text that the changes between two documents touched, and that have no time yet. */
export function linesWithoutTime(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  doc: Y.Doc,
): string[] {
  const start = before.content.findDiffStart(after.content);
  if (start === null) return [];
  const to = before.content.findDiffEnd(after.content)?.b ?? after.content.size;
  const ids: string[] = [];
  after.nodesBetween(start, Math.max(start, to), (node, _pos, parent) => {
    if (node.type.name === ANSWER_BLOCK || parent?.type.name === ANSWER_BLOCK) return false;
    const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
    if (
      LINE_TYPES.has(node.type.name) &&
      typeof id === "string" &&
      node.content.size > 0 &&
      blockTimeOf(doc, id) === null
    ) {
      ids.push(id);
    }
    return true;
  });
  return ids;
}

function timeMarks(state: EditorState, doc: Y.Doc): DecorationSet {
  const times = blockTimes(doc);
  if (times.size === 0) return DecorationSet.empty;
  const marks: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
    const ms = typeof id === "string" ? times.get(id) : undefined;
    if (ms !== undefined && LINE_TYPES.has(node.type.name)) {
      marks.push(Decoration.node(pos, pos + node.nodeSize, { "data-meeting-time": clockTime(ms) }));
    }
    return true;
  });
  return DecorationSet.create(state.doc, marks);
}

/**
 * Takes the time of each line the User writes while the Meeting records (#139):
 * the first time it has text, so a line keeps the moment it was begun at. What
 * the core or another computer writes (a change from the Yjs binding) takes
 * none. The times are shown on hover (`data-meeting-time`, see styles.css),
 * and live beside the Blocks in the Mind's document, not in them.
 */
export function meetingTimesPlugin({ doc, time }: MeetingTimesOptions): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: timesKey,
    state: {
      init: (_, state) => timeMarks(state, doc),
      apply: (tr, marks, _, state) =>
        tr.docChanged || tr.getMeta(timesKey) ? timeMarks(state, doc) : marks,
    },
    appendTransaction(transactions, before, after) {
      if (
        !transactions.some((tr) => tr.docChanged) ||
        transactions.some((tr) => isChangeOrigin(tr))
      ) {
        return null;
      }
      const ms = time();
      if (ms !== null) setBlockTimes(doc, linesWithoutTime(before.doc, after.doc, doc), ms);
      return null;
    },
    view(view) {
      const times = doc.getMap(MIND_BLOCK_TIMES_FIELD);
      // A time written while a change is applied can't be drawn in it: it is drawn just after.
      const redraw = () =>
        queueMicrotask(() => {
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(timesKey, true));
        });
      times.observe(redraw);
      return { destroy: () => times.unobserve(redraw) };
    },
    props: { decorations: (state) => timesKey.getState(state) },
  });
}
