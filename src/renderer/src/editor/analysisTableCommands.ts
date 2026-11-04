import { type Editor, Extension } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  type AnalysisTableBinding,
  BLOCK_ID_ATTRIBUTE,
} from "../../../core/api";
import type { AnalysisTableShown } from "../../../shared/analysisTables";
import { readTableBinding, sameBinding } from "../../../shared/figureRuns";
import type { MessageKey } from "../../../shared/i18n";
import { tableAround } from "./chartCommands";

/** Whether the table at the cursor is an Analysis's own (#2378). */
export function inAnalysisTable(state: EditorState): boolean {
  const table = tableAround(state);
  return table !== null && readTableBinding(table.node.attrs[ANALYSIS_TABLE_ATTRIBUTE]) !== null;
}

/** The position of the marker on the caption of the Analysis table at the cursor; null without one. */
function markerOf(state: EditorState): number | null {
  const table = tableAround(state);
  const binding = table && readTableBinding(table.node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
  if (!table || !binding) return null;
  let found: number | null = null;
  state.doc.descendants((node, pos) => {
    if (pos >= table.pos) return false;
    const named =
      node.type.name === ANALYSIS_TABLE_NODE
        ? readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE])
        : null;
    if (named && sameBinding(named, binding)) found = pos;
    return true;
  });
  return found;
}

/** Opens the card of the Analysis table at the cursor, as its marker does (#2378). */
export function openAnalysisTableCard(editor: Editor): boolean {
  const at = markerOf(editor.state);
  const marker = at === null ? null : editor.view.nodeDOM(at);
  const button = marker instanceof HTMLElement ? marker.querySelector("button") : null;
  button?.click();
  return button !== null;
}

/**
 * Convert to text, in the table's menu (#2378): the table at the cursor becomes a table the User
 * typed, its cells then checked as any are, and its caption's marker goes; its caption's words stay.
 */
export function convertAnalysisTable(editor: Editor): boolean {
  const table = tableAround(editor.state);
  const binding = table && readTableBinding(table.node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
  if (!table || !binding) return false;
  const marker = markerOf(editor.state);
  return editor.commands.command(({ tr }) => {
    tr.setNodeAttribute(table.pos, ANALYSIS_TABLE_ATTRIBUTE, null);
    if (marker !== null) tr.delete(marker, marker + 1);
    return true;
  });
}

/**
 * `fragment` with every Analysis table's binding and caption marker taken off (#2378): pasted with
 * no record of its run, a table is the typed table its cells read as, and is checked as one.
 */
export function withoutTableBindings(fragment: Fragment): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.type.name === ANALYSIS_TABLE_NODE) return;
    if (node.isText) {
      nodes.push(node);
      return;
    }
    const attrs =
      node.type.name === "table" && node.attrs[ANALYSIS_TABLE_ATTRIBUTE] != null
        ? { ...node.attrs, [ANALYSIS_TABLE_ATTRIBUTE]: null }
        : node.attrs;
    nodes.push(node.type.create(attrs, withoutTableBindings(node.content), node.marks));
  });
  return Fragment.fromArray(nodes);
}

function markersIn(doc: ProseMirrorNode): { pos: number; binding: AnalysisTableBinding }[] {
  const found: { pos: number; binding: AnalysisTableBinding }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== ANALYSIS_TABLE_NODE) return true;
    const binding = readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
    if (binding) found.push({ pos, binding });
    return false;
  });
  return found;
}

/**
 * What keeps each Analysis table's caption whole after a change (#2378): one marker of the table's
 * stands in a line of the Note, its caption. Typing over the marker with the caption's words puts it
 * back at that line's end; a marker whose table is gone, or a second one of a table, goes; a table
 * whose caption line is gone, or that never had one, is a typed table, as Convert to text leaves
 * it. A line put between the caption and its table, as Enter at the caption's end puts one, leaves
 * both as they were. Null when every table's caption is whole.
 */
function captionsKept(
  transactions: readonly Transaction[],
  before: EditorState,
  after: EditorState,
): Transaction | null {
  const { doc } = after;
  const tables: { pos: number; binding: AnalysisTableBinding }[] = [];
  const lines: { node: ProseMirrorNode; from: number; to: number }[] = [];
  doc.forEach((node, pos) => {
    // A caption made a heading is still its table's caption.
    if (node.isTextblock) lines.push({ node, from: pos, to: pos + node.nodeSize });
    const binding =
      node.type.name === "table" ? readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]) : null;
    if (binding) tables.push({ pos, binding });
  });
  const lineAt = (pos: number) => lines.find((line) => pos > line.from && pos < line.to) ?? null;
  const markers = markersIn(doc);
  const captioned = new Set<number>();
  const steps: { at: number; run: (tr: Transaction) => void }[] = [];
  // Where the caret goes once the steps have run: set by the step that restores a marker.
  const caret: { at: { pos: number; from: number } | null } = { at: null };
  const markerType = doc.type.schema.nodes[ANALYSIS_TABLE_NODE];
  const mapping = new Mapping();
  for (const tr of transactions) mapping.appendMapping(tr.mapping);
  for (const table of tables) {
    const own = markers.find(
      ({ pos, binding }) => sameBinding(binding, table.binding) && lineAt(pos) !== null,
    );
    if (own) {
      captioned.add(own.pos);
      continue;
    }
    // The line its marker stood in before the change, its words typed over. A line with no id yet
    // is followed through the change by its place.
    const was = markersIn(before.doc).find(({ binding }) => sameBinding(binding, table.binding));
    const id = was ? before.doc.resolve(was.pos).parent.attrs[BLOCK_ID_ATTRIBUTE] : undefined;
    const mapped = was ? mapping.map(was.pos, -1) : -1;
    const line =
      was === undefined
        ? null
        : typeof id === "string"
          ? (lines.find((each) => each.node.attrs[BLOCK_ID_ATTRIBUTE] === id) ?? null)
          : lineAt(mapped);
    if (line && markerType) {
      const end = line.to - 1;
      steps.push({
        at: end,
        run: (tr) => {
          tr.insert(end, markerType.create({ [ANALYSIS_TABLE_ATTRIBUTE]: table.binding }));
          // Typing over the caption: the next letter goes before the marker, not behind it.
          if (after.selection.empty && after.selection.from === end)
            caret.at = { pos: end, from: tr.mapping.maps.length };
        },
      });
    } else {
      steps.push({
        at: table.pos,
        run: (tr) => tr.setNodeAttribute(table.pos, ANALYSIS_TABLE_ATTRIBUTE, null),
      });
    }
  }
  for (const { pos } of markers)
    if (!captioned.has(pos)) steps.push({ at: pos, run: (tr) => tr.delete(pos, pos + 1) });
  if (steps.length === 0) return null;
  const tr = after.tr;
  // From the end back, so each position is still the one it was read at.
  for (const step of steps.sort((a, b) => b.at - a.at)) step.run(tr);
  const typed = caret.at;
  if (typed)
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.slice(typed.from).map(typed.pos, -1)));
  return tr;
}

/** The marker just before or after the cursor in a caption line; null where there is none. */
function markerBeside(state: EditorState, side: "before" | "after"): number | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const node = side === "before" ? $from.nodeBefore : $from.nodeAfter;
  if (node?.type.name !== ANALYSIS_TABLE_NODE) return null;
  return side === "before" ? $from.pos - node.nodeSize : $from.pos;
}

/** Convert to text for the table a selected caption marker names: the marker goes, with its binding. */
function convertMarked(editor: Editor): boolean {
  const { selection } = editor.state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== ANALYSIS_TABLE_NODE)
    return false;
  const binding = readTableBinding(selection.node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
  if (!binding) return false;
  let table: number | null = null;
  editor.state.doc.forEach((node, pos) => {
    const named =
      node.type.name === "table" ? readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]) : null;
    if (table === null && pos > selection.from && named && sameBinding(named, binding)) table = pos;
  });
  const at = table;
  return editor.commands.command(({ tr }) => {
    if (at !== null) tr.setNodeAttribute(at, ANALYSIS_TABLE_ATTRIBUTE, null);
    tr.delete(selection.from, selection.to);
    return true;
  });
}

/**
 * The caption's marker, kept whole as a field is in Word (#2378): Backspace or Delete beside it
 * selects it, a second press takes it away, as Convert to text does, with one Undo. Every other edit
 * goes through: typing over the caption's words keeps the marker at its end (`captionsKept`).
 */
export const AnalysisTableGuard = Extension.create({
  name: "analysisTableGuard",
  // Ahead of the editor's own Backspace, which would delete the marker as any character.
  priority: 1000,
  addKeyboardShortcuts() {
    const press = (side: "before" | "after") => () => {
      const { editor } = this;
      if (convertMarked(editor)) return true;
      const at = markerBeside(editor.state, side);
      if (at === null) return false;
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)),
      );
      return true;
    };
    return { Backspace: press("before"), Delete: press("after") };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("analysisTableGuard"),
        appendTransaction(transactions, before, after) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          // The Note's other windows, the core and Undo change it through Yjs, which is the record.
          if (
            transactions.some(
              (tr) =>
                (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
                  ?.isChangeOrigin,
            )
          )
            return null;
          return captionsKept(transactions, before, after);
        },
      }),
    ];
  },
});

/** What an Analysis table's state reads as on its card, in the figure card's words (#2378). */
export const TABLE_STATE_WORDS: Record<AnalysisTableShown["state"]["kind"], MessageKey> = {
  recalculated: "claim.state.supported",
  calculated: "claim.state.not-checked",
  differs: "figures.filter.look",
  "needs-recheck": "claim.state.needs-recheck",
  "kept-inside": "claim.state.not-checked",
  unavailable: "claim.state.not-checked",
};

/** The state an Analysis table's marker gives as `data-state`, as a figure's marker does. */
export const TABLE_DATA_STATE: Record<AnalysisTableShown["state"]["kind"], string> = {
  recalculated: "supported",
  calculated: "not-checked",
  differs: "unsupported",
  "needs-recheck": "needs-recheck",
  "kept-inside": "not-checked",
  unavailable: "not-checked",
};
