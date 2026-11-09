import {
  combineTransactionSteps,
  Extension,
  findChildrenInRange,
  getChangedRanges,
} from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  COMPARISON_CELL_NODE,
  COMPARISON_TABLE_NODE,
  QUESTION_BLOCK,
} from "../../../core/api";
import { comparisonQuestionsOf, renewedQuestions } from "../../../shared/comparisons";

const count = (counts: Map<string, number>, id: string, by = 1) =>
  counts.set(id, (counts.get(id) ?? 0) + by);

/**
 * A copy of a Block is a Block of its own (#1885): no id of the original's comes with it, or a
 * menu, a fill or an export would find the original instead. Tiptap's UniqueID renews the id of
 * a pasted Block; this renews what it leaves:
 *
 * - the Questions of a pasted comparison table, and the cells that name them;
 * - a Block id the Note already holds, on a Block that arrived another way, such as a drop with
 *   the copy key. A Block that was moved has no other holder, so it keeps its id;
 * - the Question an Answer names, when the Answer is copied with its Question.
 *
 * Only this device's own edits are read, as for Citations' ids (`citationIds`).
 */
export const CopiedBlocks = Extension.create<{ types: readonly string[] }>({
  name: "copiedBlocks",

  addOptions() {
    return { types: [] };
  },

  addProseMirrorPlugins() {
    const types = new Set(this.options.types);
    return [
      new Plugin({
        key: new PluginKey("copiedBlocks"),
        appendTransaction(transactions, before, after) {
          const local = transactions.filter((tr) => tr.docChanged && !isChangeOrigin(tr));
          if (local.length === 0) return null;
          const transform = combineTransactionSteps(before.doc, [...transactions]);
          const back = transform.mapping.invert();
          const added = new Map<number, ProseMirrorNode>();
          for (const { newRange } of getChangedRanges(transform))
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
          const tr = after.tr;
          const inOrder = [...added].sort(([a], [b]) => a - b);
          for (const [pos, node] of inOrder) {
            const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
            if (typeof id === "string" && (holders.get(id) ?? 0) > 1) {
              count(holders, id, -1);
              tr.setNodeAttribute(pos, BLOCK_ID_ATTRIBUTE, crypto.randomUUID());
            }
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
