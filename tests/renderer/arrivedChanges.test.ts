/**
 * The assistant's changes the User asked for, applied once they have all
 * arrived (#880): set aside, then written again as the editor's own
 * change, so one Undo takes them back and Redo does them again, whenever
 * they arrived. Changes the User didn't ask for keep waiting.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, PROPOSAL_ATTRIBUTE } from "../../src/core";
import { createElement } from "../../src/core/answers/blocks";
import { replaceOwn, waitingIn } from "../../src/core/proposals/ownWaiting";
import { writeAccepted } from "../../src/renderer/src/editor/arrivedChanges";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { pendingProposals } from "../../src/shared/proposals";

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks && { marks }),
});
const ref = (id: string, request: string) => ({ id, request });

/** A Mind's document in Yjs, as the core writes it. */
function mindWith(content: JSONContent[]): { doc: Y.Doc; blocks: Y.XmlFragment; schema: Schema } {
  const editor = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  onTestFinished(() => editor.destroy());
  const doc = new Y.Doc();
  const blocks = prosemirrorToYXmlFragment(
    editor.state.doc,
    doc.getXmlFragment(MIND_CONTENT_FIELD),
  );
  return { doc, blocks, schema: editor.schema };
}

const textOf = (blocks: Y.XmlFragment) =>
  blocks
    .toArray()
    .map((block) => (block instanceof Y.XmlElement ? block.toArray().join("") : ""))
    .map((xml) => xml.replace(/<[^>]+>/g, ""));

class Asked {}
class Aside {}

describe("Changes the User asked the assistant for", () => {
  test("keep an earlier review anchored inside a table when a later request edits its cell, including Undo and Redo", () => {
    const { doc, blocks, schema } = mindWith([
      {
        type: "table",
        attrs: { id: "table", [PROPOSAL_ATTRIBUTE]: { kind: "insert", id: "a", request: "first" } },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [
                  { type: "paragraph", attrs: { id: "cell" }, content: [text("Sales grew.")] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const undo = new Y.UndoManager(blocks, { trackedOrigins: new Set([Asked]) });
    writeAccepted(doc, new Set(["first"]), new Aside(), new Asked(), schema);
    let node: Y.XmlElement | Y.XmlText | Y.XmlHook | undefined = blocks.get(0);
    for (let depth = 0; depth < 4; depth++) {
      if (!(node instanceof Y.XmlElement)) throw new Error("The table cell is missing.");
      node = node.get(0);
    }
    if (!(node instanceof Y.XmlText)) throw new Error("The table cell has no text.");
    const words = node;
    const earlier = Y.createRelativePositionFromTypeIndex(words, 6);
    doc.transact(() => words.insert(words.length, " Again.", { proposalInsert: ref("b", "next") }));
    undo.stopCapturing();
    writeAccepted(doc, new Set(["next"]), new Aside(), new Asked(), schema);

    expect(textOf(blocks)).toEqual(["Sales grew. Again."]);
    const at = Y.createAbsolutePositionFromRelativePosition(earlier, doc);
    expect(at?.type).toBe(words);
    expect(at?.index).toBe(6);
    undo.undo();
    expect(textOf(blocks)).toEqual(["Sales grew."]);
    undo.redo();
    expect(textOf(blocks)).toEqual(["Sales grew. Again."]);
    expect(Y.createAbsolutePositionFromRelativePosition(earlier, doc)?.type).toBe(words);
  });

  // protects=one Undo takes back exactly what was asked for and Redo does it again, the rest waiting; fails_when=Undo leaves them waiting, takes back too little, or touches the change not asked for; no_claim=how the editor shows them.
  test("are applied as one tracked change: Undo restores the text, Redo applies them again, and a change not asked for still waits", () => {
    const { doc, blocks, schema } = mindWith([
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          text("The tides are "),
          text("very ", [{ type: "proposalDelete", attrs: ref("a", "asked") }]),
          text("strong.", []),
          text(" Truly.", [{ type: "proposalInsert", attrs: ref("b", "asked") }]),
        ],
      },
      {
        type: "paragraph",
        attrs: { id: "p2", [PROPOSAL_ATTRIBUTE]: { kind: "insert", id: "c", request: "asked" } },
        content: [text("A new paragraph.")],
      },
      {
        type: "paragraph",
        attrs: { id: "p3" },
        content: [
          text("Harbours "),
          text("open", [{ type: "proposalDelete", attrs: ref("d", "other") }]),
          text("close", [{ type: "proposalInsert", attrs: ref("d", "other") }]),
          text(" at nine."),
        ],
      },
    ]);
    const undo = new Y.UndoManager(blocks, { trackedOrigins: new Set([Asked]) });

    const resolved = writeAccepted(doc, new Set(["asked"]), new Aside(), new Asked(), schema);

    expect(resolved.map((each) => each.id).sort()).toEqual(["a", "b", "c"]);
    expect(textOf(blocks)).toEqual([
      "The tides are strong. Truly.",
      "A new paragraph.",
      "Harbours openclose at nine.",
    ]);
    expect(pendingProposals(blocks).map((each) => each.request)).toEqual(["other"]);

    undo.undo();
    expect(textOf(blocks)).toEqual(["The tides are very strong.", "Harbours openclose at nine."]);
    expect(pendingProposals(blocks).map((each) => each.request)).toEqual(["other"]);

    undo.redo();
    expect(textOf(blocks)).toEqual([
      "The tides are strong. Truly.",
      "A new paragraph.",
      "Harbours openclose at nine.",
    ]);
  });
  test("a revision inside the same turn joins the first edit in one Undo", () => {
    const { doc, blocks, schema } = mindWith([
      {
        type: "paragraph",
        attrs: { id: "Summary" },
        content: [
          text("The quarter was "),
          text("very ", [{ type: "proposalDelete", attrs: ref("a", "first") }]),
          text("quite ", [{ type: "proposalInsert", attrs: ref("b", "first") }]),
          text("good."),
        ],
      },
    ]);
    const own = waitingIn(
      blocks,
      { blockId: "Summary", offset: 0 },
      { blockId: "Summary", offset: 1 },
      new Set(["first"]),
    );
    if (own.kind !== "own") throw new Error("The first edit wasn't found.");
    replaceOwn(
      blocks,
      own,
      [createElement({ type: "paragraph", attrs: { id: "Summary" }, content: [text("The quarter was good.")] })],
      "second",
    );
    const undo = new Y.UndoManager(blocks, { trackedOrigins: new Set([Asked]) });

    writeAccepted(doc, new Set(["first", "second"]), new Aside(), new Asked(), schema);

    expect(textOf(blocks)).toEqual(["The quarter was good."]);
    undo.undo();
    expect(textOf(blocks)).toEqual(["The quarter was very good."]);
  });
});
