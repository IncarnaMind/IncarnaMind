import {
  combineTransactionSteps,
  Extension,
  findChildrenInRange,
  getChangedRanges,
} from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import UniqueID from "@tiptap/extension-unique-id";
import type { Fragment, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  CHART_NODE,
  COMPARISON_CELL_NODE,
  COMPARISON_TABLE_NODE,
  QUESTION_BLOCK,
} from "../../../core/api";
import { readChart } from "../../../shared/charts";
import { comparisonQuestionsOf, renewedQuestions } from "../../../shared/comparisons";

const TABLE_NODE = "table";

const isTable = (node: ProseMirrorNode) =>
  node.type.name === TABLE_NODE || node.type.name === COMPARISON_TABLE_NODE;

interface CopiedStorage {
  /** The tables this device's edits took out of the Note. */
  taken: Set<string>;
}

interface CarriedStorage {
  /** The ids the tables of the last paste or drop held, in order, read before UniqueID cleared them. */
  ids: string[];
}

declare module "@tiptap/core" {
  interface Storage {
    carriedTableIds: CarriedStorage;
  }
}

function tableIdsIn(fragment: Fragment): string[] {
  const ids: string[] = [];
  fragment.descendants((node) => {
    if (!isTable(node)) return true;
    const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
    ids.push(typeof id === "string" ? id : "");
    return true;
  });
  return ids;
}

const count = (counts: Map<string, number>, id: string, by = 1) =>
  counts.set(id, (counts.get(id) ?? 0) + by);

const CarriedTableIds = Extension.create<unknown, CarriedStorage>({
  name: "carriedTableIds",
  // UniqueID clears a pasted Block's id in its own transformPasted, which runs first.
  priority: (UniqueID.config.priority ?? 0) + 1,

  addStorage() {
    return { ids: [] };
  },

  addProseMirrorPlugins() {
    const { storage } = this;
    return [
      new Plugin({
        key: new PluginKey("carriedTableIds"),
        props: {
          transformPasted(slice) {
            storage.ids = tableIdsIn(slice.content);
            return slice;
          },
        },
      }),
    ];
  },
});

/**
 * A copy of a Block is a Block of its own (#1885): no id of the original's comes with it, or a
 * menu, a fill or an export would find the original instead. Tiptap's UniqueID renews the id of
 * a pasted Block; this renews what it leaves:
 *
 * - the Questions of a pasted comparison table, and the cells that name them;
 * - a Block id the Note already holds, on a Block that arrived another way, such as a drop with
 *   the copy key. A Block that was moved has no other holder, so it keeps its id;
 * - the Question an Answer names, when the Answer is copied with its Question;
 * - the table a chart is drawn from, when the table is pasted with the chart.
 *
 * A table cut and pasted back into the Note it left is a move: it comes back with its own table
 * id and Question ids, which its cells' marks and the charts drawn from it are kept under. A
 * second paste of the same cut, or a paste into another Note, is a copy.
 *
 * Only this device's own edits are read, as for Citations' ids (`citationIds`).
 */
export const CopiedBlocks = Extension.create<{ types: readonly string[] }, CopiedStorage>({
  name: "copiedBlocks",

  addOptions() {
    return { types: [] };
  },

  addStorage() {
    return { taken: new Set() };
  },

  addExtensions() {
    return [CarriedTableIds];
  },

  addProseMirrorPlugins() {
    const types = new Set(this.options.types);
    const { editor, storage } = this;
    return [
      new Plugin({
        key: new PluginKey("copiedBlocks"),
        appendTransaction(transactions, before, after) {
          const local = transactions.filter((tr) => tr.docChanged && !isChangeOrigin(tr));
          if (local.length === 0) return null;
          const carriedStorage = editor.storage.carriedTableIds;
          const carried = carriedStorage.ids;
          carriedStorage.ids = [];
          const transform = combineTransactionSteps(before.doc, [...transactions]);
          const back = transform.mapping.invert();
          const ranges = getChangedRanges(transform);
          for (const { oldRange } of ranges)
            for (const { node, pos } of findChildrenInRange(before.doc, oldRange, isTable)) {
              const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
              if (typeof id === "string" && transform.mapping.mapResult(pos).deleted)
                storage.taken.add(id);
            }
          const added = new Map<number, ProseMirrorNode>();
          for (const { newRange } of ranges)
            for (const { node, pos } of findChildrenInRange(after.doc, newRange, (each) =>
              types.has(each.type.name),
            ))
              if (back.mapResult(pos).deleted) added.set(pos, node);
          if (added.size === 0) return null;

          const holders = new Map<string, number>();
          const columns = new Map<string, number>();
          after.doc.descendants((node) => {
            const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
            if (types.has(node.type.name) && typeof id === "string") count(holders, id);
            if (node.type.name === COMPARISON_TABLE_NODE)
              for (const question of comparisonQuestionsOf(node.attrs)) count(columns, question.id);
          });

          const pasted = local.some((tr) => tr.getMeta("paste") === true);
          const arrived = pasted || local.some((tr) => tr.getMeta("uiEvent") === "drop");
          const tr = after.tr;
          const inOrder = [...added].sort(([a], [b]) => a - b);
          const tableCount = inOrder.filter(([, node]) => isTable(node)).length;
          const named = arrived && carried.length === tableCount ? carried : [];
          const copies = new Map<string, string>();
          let tableAt = 0;
          for (const [pos, node] of inOrder) {
            const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
            const held = typeof id === "string" ? id : undefined;
            const from = isTable(node) ? named[tableAt++] || held : undefined;
            if (
              held !== undefined &&
              from !== undefined &&
              from !== held &&
              storage.taken.has(from) &&
              (holders.get(from) ?? 0) === 0 &&
              comparisonQuestionsOf(node.attrs).every(
                (question) => (columns.get(question.id) ?? 0) <= 1,
              )
            ) {
              count(holders, held, -1);
              count(holders, from);
              tr.setNodeAttribute(pos, BLOCK_ID_ATTRIBUTE, from);
              continue;
            }
            let renewedId = held;
            if (held !== undefined && (holders.get(held) ?? 0) > 1) {
              count(holders, held, -1);
              renewedId = crypto.randomUUID();
              tr.setNodeAttribute(pos, BLOCK_ID_ATTRIBUTE, renewedId);
            }
            if (from !== undefined && renewedId !== undefined && from !== renewedId)
              copies.set(from, renewedId);
            if (node.type.name !== COMPARISON_TABLE_NODE) continue;
            const questions = comparisonQuestionsOf(node.attrs);
            if (questions.length === 0) continue;
            if (!pasted && !questions.some((question) => (columns.get(question.id) ?? 0) > 1))
              continue;
            const renewed = renewedQuestions(node.attrs);
            for (const question of questions) count(columns, question.id, -1);
            tr.setNodeAttribute(pos, "questions", renewed.questions);
            node.descendants((child, offset) => {
              if (child.type.name !== COMPARISON_CELL_NODE) return true;
              const own = renewed.ids.get(String(child.attrs.questionId ?? ""));
              if (own) tr.setNodeAttribute(pos + 1 + offset, "questionId", own);
              return false;
            });
          }

          for (const [pos, node] of inOrder) {
            if (node.type.name !== CHART_NODE) continue;
            const { source } = readChart(node.attrs);
            const copy =
              source.kind === "table" && source.blockId ? copies.get(source.blockId) : undefined;
            if (copy) tr.setNodeAttribute(pos, "source", { ...source, blockId: copy });
          }

          for (const [pos, node] of inOrder) {
            if (node.type.name !== ANSWER_BLOCK || typeof node.attrs.questionId !== "string")
              continue;
            const question = tr.doc.resolve(pos).nodeBefore;
            const id: unknown = question?.attrs[BLOCK_ID_ATTRIBUTE];
            if (
              question?.type.name === QUESTION_BLOCK &&
              added.has(pos - question.nodeSize) &&
              typeof id === "string" &&
              id !== node.attrs.questionId
            )
              tr.setNodeAttribute(pos, "questionId", id);
          }

          if (!tr.docChanged) return null;
          // Kept out of Undo where the edit it rides on is.
          if (local.at(-1)?.getMeta("addToHistory") === false) tr.setMeta("addToHistory", false);
          return tr;
        },
      }),
    ];
  },
});
