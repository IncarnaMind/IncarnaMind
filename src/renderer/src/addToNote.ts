/**
 * Add to note (#201): an Answer in the assistant, or the part of it selected,
 * goes into a Mind's note as Notes, Citations and all, its words AI text, each
 * Citation checked again where it lands, with a link back to the Answer and
 * its conversation (src/shared/blockOrigins.ts).
 *
 * - Into the Mind the assistant reads, open in its editor: at its cursor, or
 *   at its end, through the editor, as one step of its Undo, so ⌘Z in the
 *   note takes it back too.
 * - Into another Mind: at its end, through the core. With no Mind in focus
 *   (`openIt`), it is shown too, in a new tab beside the focused one if it isn't open,
 *   never replacing it.
 * - Into a new Mind ("Write as a note" under the Answer, #1940): the empty Mind the
 *   User's own that the assistant reads, when there is one, as at its cursor; else a new
 *   Mind in the conversation's Folder, named by its first line (" 2" after a name another
 *   Mind has), with the Answer in it at once, opened in a new tab beside the focused one.
 *   The example is never filled.
 *
 * Each says what it did under the Answer, with Undo (and ⌘Z), and what went
 * in at once is recorded as AI use (#292); a change, once it is accepted.
 */
import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import {
  BLOCK_ID_ATTRIBUTE,
  type BlockOrigin,
  type Conversation,
  type ConversationAnswer,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
} from "../../core/api";
import { messageReference } from "../../core/references";
import { asGenerated } from "../../shared/aiText";
import type { NodeJSON } from "../../shared/blockJson";
import { setOrigins } from "../../shared/blockOrigins";
import { holdsNothing } from "../../shared/madeMind";
import { carryAnswerScope } from "../../shared/mindScope";
import { cutTitle, mindName, numberedName } from "../../shared/naming";
import {
  citedTables,
  firstLineOfBlocks,
  recheckCitations,
  textLength,
  withoutIds,
} from "../../shared/noteBlocks";
import { readMindHandle } from "./commands/handles";
import { questionOf } from "./conversations";
import { core } from "./core";
import { flashBlocks } from "./editor/blockOrigins";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { notePlace } from "./editor/notePlace";
import { exampleMindIds, useAppStore } from "./store";
import { answerUndoPlace, useUndo } from "./undo";

/** Where Add to note puts an Answer: a Mind, by id, or a new Mind made from it. */
export type AddTarget = { kind: "mind"; mindId: string } | { kind: "new" };

/** What is added, and from where. */
export interface AddedAnswer {
  answer: ConversationAnswer;
  conversation: Conversation | undefined;
  /** The Notes to add: the part of the Answer selected, or all of it. */
  blocks: NodeJSON[];
}

/** The Mind's name, which an unnamed Mind is about to take from the first line of what goes in (the core names it a moment after the Note is in). */
const nameOfMind = (mindId: string, blocks: readonly NodeJSON[]) => {
  const mind = useAppStore.getState().minds.find((each) => each.id === mindId);
  return (mind && mindName(mind)) || cutTitle(firstLineOfBlocks(blocks));
};

const originOf = ({ answer }: AddedAnswer): BlockOrigin => ({
  from: messageReference(answer.conversationId, answer.id),
  question: questionOf(answer)?.text ?? "",
});

/**
 * Puts checked Blocks into the open Mind where its cursor is (or at its end),
 * as one step of the note's Undo. Returns their new ids, or null when the
 * editor couldn't take them.
 */
export function addInEditor(
  editor: Editor,
  blocks: readonly NodeJSON[],
  atCursor: boolean,
  inTheSameStep: () => void,
) {
  const place = notePlace(editor.state.doc, atCursor ? editor.state.selection : null);
  const ids = blocks.map(() => crypto.randomUUID());
  let nodes: ProseMirrorNode[];
  try {
    nodes = blocks.map((block, index) =>
      editor.schema.nodeFromJSON({
        ...block,
        attrs: { ...block.attrs, [BLOCK_ID_ATTRIBUTE]: ids[index] },
      }),
    );
  } catch (error) {
    // Blocks this editor can't hold: nothing goes in, and the User is told.
    useAppStore.getState().reportError(error);
    return null;
  }
  const done = asOneStep(editor, () => {
    const added = editor.commands.command(({ tr }) => {
      const fragment = Fragment.from(nodes);
      tr.replaceWith(place.from, place.to, fragment);
      // The cursor goes after what came in, so the next Answer added goes after it, in order.
      const end = Math.min(place.from + fragment.size, tr.doc.content.size);
      tr.setSelection(Selection.near(tr.doc.resolve(end), -1));
      return true;
    });
    if (added) inTheSameStep();
    return added;
  });
  if (!done) return null;
  const first = editor.view.nodeDOM(place.from);
  if (first instanceof HTMLElement) first.scrollIntoView({ block: "nearest" });
  return ids;
}

/** Into the Mind the assistant reads, through its editor; false when it isn't open in one. */
async function addToReadMind(added: AddedAnswer, mindId: string): Promise<boolean> {
  const read = readMindHandle.current;
  if (!read || read.mindId !== mindId || read.editor.isDestroyed) return false;
  const checked = asGenerated(
    await recheckCitations(citedTables(withoutIds(added.blocks)), (input) =>
      core.recheckCitation(input),
    ),
  );
  const { editor, doc } = read;
  if (editor.isDestroyed) return false;
  const folderId = useAppStore.getState().minds.find((each) => each.id === mindId)?.folderId;
  // As the editor's own change, so the note's Undo takes the scope back with the Blocks.
  const bringScope = () => {
    yUndoPluginKey.getState(editor.state)?.undoManager.addToScope(doc.getMap(MIND_SETTINGS_FIELD));
    doc.transact(
      () => carryAnswerScope(doc, questionOf(added.answer)?.scope ?? null, folderId ?? null),
      ySyncPluginKey,
    );
  };
  const ids = addInEditor(editor, checked, read.cursorInMind(), bringScope);
  if (!ids) return true;
  setOrigins(doc, ids, originOf(added));
  flashBlocks(editor, ids);
  const { model } = added.answer;
  // After the Mind's own update, so the record finds the Blocks there.
  core
    .recordAiUse([
      {
        mindId,
        kind: "answer-added",
        providerId: model?.providerId ?? null,
        modelId: model?.modelId ?? null,
        characters: textLength(checked),
        blockIds: ids,
      },
    ])
    .catch(useAppStore.getState().reportError);
  const mind = nameOfMind(mindId, added.blocks);
  offerEditorUndo(
    editor,
    (t) => t("answer.added", { mind: mind || t("mind.untitled") }),
    answerUndoPlace(added.answer.id),
  );
  return true;
}

/** Into a Mind that isn't the one the assistant reads, at its end, through the core. */
async function addToOtherMind(added: AddedAnswer, mindId: string, openIt: boolean): Promise<void> {
  const { blockIds } = await core.addToNote({
    mindId,
    blocks: added.blocks,
    origin: originOf(added),
    model: added.answer.model,
  });
  const mind = nameOfMind(mindId, added.blocks);
  useUndo.getState().push({
    said: (t) => t("answer.added", { mind: mind || t("mind.untitled") }),
    undo: () => core.undoAddToNote({ mindId, blockIds }),
    shownAt: answerUndoPlace(added.answer.id),
  });
  if (openIt) await openBeside(mindId);
}

/** Shows a Mind where it is open, else in a new tab beside the focused one. */
const openBeside = (mindId: string) =>
  useAppStore.getState().changeLayout({
    type: "open",
    item: { kind: "mind", mindId },
    where: { in: "place" },
  });

/**
 * A new Mind for an Answer, in the conversation's Folder. It is named by its first line, like
 * any Mind; the conversation's name goes on it only when the User gave the conversation one,
 * never the name it takes from the first Question, which is an instruction (#1174). A table's
 * first cell is no name either, so "Open as a table" passes the Question as the title (#1345).
 */
const newMindFor = (added: AddedAnswer, title = added.conversation?.title ?? "") =>
  core.createMind({ title, folderId: added.conversation?.folderId ?? null });

const putIn = (mindId: string, added: AddedAnswer) =>
  core.addToNote({
    mindId,
    blocks: added.blocks,
    origin: originOf(added),
    model: added.answer.model,
  });

/**
 * Into a new Mind: the empty Mind of the User's own the assistant reads, when there is one;
 * else one in its conversation's Folder, the Answer in it at once, in a new tab beside the
 * focused one, with Undo for what went in. The example is never filled (#1940). Making the
 * Mind itself says nothing, as for any Mind made: Delete takes it back.
 */
async function addToNewMind(added: AddedAnswer): Promise<void> {
  const read = readMindHandle.current;
  const own = read && !exampleMindIds(useAppStore.getState()).includes(read.mindId) ? read : null;
  const empty =
    own && !own.editor.isDestroyed && holdsNothing(own.doc.getXmlFragment(MIND_CONTENT_FIELD));
  if (own && empty && (await addToReadMind(added, own.mindId))) return;
  // A name another Mind has gets a number, so a second Mind of the same Answer reads apart.
  const given = added.conversation?.title ?? "";
  const named = given || cutTitle(firstLineOfBlocks(added.blocks));
  const taken = useAppStore.getState().minds.map((mind) => mindName(mind));
  const mind = await newMindFor(added, numberedName(named, taken) ?? given);
  const { blockIds } = await putIn(mind.id, added);
  await openBeside(mind.id);
  const name = nameOfMind(mind.id, added.blocks);
  useUndo.getState().push({
    said: (t) => t("answer.added", { mind: name || t("mind.untitled") }),
    undo: () => core.undoAddToNote({ mindId: mind.id, blockIds }),
    shownAt: answerUndoPlace(added.answer.id),
  });
}

let openingTable = false;

/**
 * "Open as a table": the one table in `added.blocks` in a Mind of its own, as it is (to copy or
 * export from its tab). Its tab opens beside the focused one first and the table is put in after,
 * so a big table never keeps the tab from showing. Like any Mind made, it says nothing, and
 * Delete takes it back. A table that can't go in
 * is shown as a problem and its Mind deleted. A second call while one is under way does nothing.
 */
export async function openTable(added: AddedAnswer): Promise<void> {
  if (openingTable) return;
  openingTable = true;
  try {
    const asked = added.conversation?.title || cutTitle(questionOf(added.answer)?.text ?? "");
    const taken = useAppStore.getState().minds.map((mind) => mindName(mind));
    const mind = await newMindFor(added, numberedName(asked, taken) ?? asked);
    await openBeside(mind.id);
    try {
      await putIn(mind.id, added);
    } catch (error) {
      useAppStore.getState().reportError(error);
      await core.deleteMind(mind.id);
      return;
    }
  } catch (error) {
    useAppStore.getState().reportError(error);
  } finally {
    openingTable = false;
  }
}

/**
 * Adds an Answer to a Mind or a new Mind (see the module's comment). `openIt`:
 * no Mind is in focus, so a Mind chosen from the list is opened too.
 */
export async function addAnswer(
  added: AddedAnswer,
  target: AddTarget,
  openIt = false,
): Promise<void> {
  if (added.blocks.length === 0) return;
  try {
    if (target.kind === "new") await addToNewMind(added);
    else if (!(await addToReadMind(added, target.mindId))) {
      await addToOtherMind(added, target.mindId, openIt);
    }
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}
