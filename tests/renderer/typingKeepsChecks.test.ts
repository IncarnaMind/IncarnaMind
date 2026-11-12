import { type Editor, getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { markedSentences, markSentence } from "../../src/core/answers/checks/sentences";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import type { NodeJSON } from "../../src/shared/blockJson";
import { boundEditorTo, typeText } from "../helpers/editor";
import { copyInStep } from "../helpers/mindClient";

/*
 * What the User types never writes a check's result it didn't change (#2988). Two checked sentences
 * share a paragraph; the User types in the first while Check this note runs and a newer result
 * lands on the second: the second keeps the newer result, whether the typing and the result cross
 * on the way or ⌘Z takes the typing back after.
 * The note is the window's copy, kept in step with the core's by encoded updates, in the editor
 * with the app's schema and its Yjs sync.
 */

function check(id: string, text: string, state: ClaimCheckAttributes["state"]) {
  return {
    id,
    request: "check-note",
    action: "check-against-documents",
    state,
    reason: null,
    detail: null,
    providerId: "provider",
    modelId: "model",
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-12T09:00:00.000Z",
  } satisfies ClaimCheckAttributes;
}

const english = { first: "Revenue was 10 in May.", second: "Costs were 8 in May.", gap: " " };
const chinese = { first: "五月收入为10亿元。", second: "五月成本为8亿元。", gap: "" };
type Words = typeof english;

const paragraphOf = ({ first, second, gap }: Words): NodeJSON => ({
  type: "paragraph",
  attrs: { id: "p" },
  content: [{ type: "text", text: `${first}${gap}${second}` }],
});
const listItemOf = (words: Words): NodeJSON => ({
  type: "bulletList",
  attrs: { id: "list" },
  content: [{ type: "listItem", content: [paragraphOf(words)] }],
});

describe.each([
  { layout: "two checked sentences side by side in a paragraph", words: english, apart: false },
  { layout: "an unchecked space between the two sentences", words: english, apart: true },
  { layout: "two checked sentences in a list item", words: english, apart: false, list: true },
  { layout: "两个已核对的句子在同一段", words: chinese, apart: false },
])("$layout", ({ words, apart, list }) => {
  const { first, second, gap } = words;
  const whole = `${first}${gap}${second}`;
  const typed = words === chinese ? "约" : "about ";

  /** The core's Note with both sentences checked Supported. */
  function checkedNote() {
    const core = new Y.Doc();
    const blocks = core.getXmlFragment(MIND_CONTENT_FIELD);
    blocks.push([createElement(list ? listItemOf(words) : paragraphOf(words))]);
    let element = blocks.get(0);
    while (element instanceof Y.XmlElement && element.nodeName !== "paragraph")
      element = element.get(0);
    if (!(element instanceof Y.XmlElement)) throw new Error("No paragraph");
    const start = first.length + gap.length;
    markSentence(element, 0, apart ? first.length : start, check("first", first, "supported"));
    markSentence(element, start, whole.length, check("second", second, "supported"));
    return core;
  }
  /** Types in the first sentence, before its figure, as the User does in the editor. */
  function typeInFirst(editor: Editor) {
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText) at = pos + (node.text ?? "").indexOf("10");
    });
    editor.commands.setTextSelection(at);
    typeText(editor, typed);
    expect(editor.state.doc.textContent).toContain(`${typed}10`);
  }
  /** The core lands a newer result on the second sentence: Contradicted. */
  function landContradicted(core: Y.Doc) {
    const landing = markedSentences(core.getXmlFragment(MIND_CONTENT_FIELD)).find(
      (each) => each.check.id === "second",
    );
    if (!landing) throw new Error("The second sentence has no check");
    markSentence(landing.element, landing.from, landing.to, {
      ...check("second", second, "contradicted"),
      checkedAt: "2026-11-12T09:01:00.000Z",
    });
  }
  const results = (note: Y.Doc) =>
    markedSentences(note.getXmlFragment(MIND_CONTENT_FIELD)).map((each) => [
      each.check.id,
      each.check.state,
    ]);

  test("opening the Note writes nothing", () => {
    const core = checkedNote();
    const copy = copyInStep(core);
    const sent: Uint8Array[] = [];
    copy.on("update", (update: Uint8Array) => sent.push(update));
    const editor = boundEditorTo(copy);
    expect(editor.state.doc.textContent).toBe(whole);
    expect(sent).toEqual([]);
  });

  test("⌘Z after typing in the first leaves a result that landed on the second since", () => {
    const core = checkedNote();
    const copy = copyInStep(core);
    const editor = boundEditorTo(copy);
    typeInFirst(editor);
    landContradicted(core);
    expect(results(copy)).toEqual([
      ["first", "supported"],
      ["second", "contradicted"],
    ]);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe(whole);
    for (const note of [core, copy])
      expect(results(note)).toEqual([
        ["first", "supported"],
        ["second", "contradicted"],
      ]);
  });

  // Yjs orders two writes made at once by the ids of the copies that made them: both orders.
  test.each([
    ["before", 1],
    ["after", 3],
  ])(
    "typing in the first while a result lands on the second leaves that result, the typing ordered %s it",
    (_, copyId) => {
      const core = checkedNote();
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
      copy.clientID = copyId;
      core.clientID = 2;
      const editor = boundEditorTo(copy);
      landContradicted(core);
      typeInFirst(editor);
      Y.applyUpdate(core, Y.encodeStateAsUpdate(copy));
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
      for (const note of [core, copy]) {
        expect(note.getXmlFragment(MIND_CONTENT_FIELD).toString()).toContain(`${typed}10`);
        expect(results(note)).toEqual([
          ["first", "supported"],
          ["second", "contradicted"],
        ]);
      }
    },
  );
});

// The editor's sync is y-tiptap's, patched at install by patches/y-tiptap.mjs: an upgrade or a lost
// patch that sets every run's marks again fails here.
const unpatched =
  "y-tiptap isn't patched for #2988: run npm ci, which runs patches/y-tiptap.mjs at install.";
test("the editor's sync formats only the runs whose marks changed", () => {
  const { first, second, gap } = english;
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  blocks.push([createElement(paragraphOf(english))]);
  const element = blocks.get(0);
  if (!(element instanceof Y.XmlElement)) throw new Error("No paragraph");
  const start = first.length + gap.length;
  markSentence(element, 0, first.length, check("first", first, "supported"));
  markSentence(element, start, start + second.length, check("second", second, "supported"));
  const text = element.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("No text");
  const schema = getSchema(noteExtensions());
  const written = vi.spyOn(text, "applyDelta");

  const typing = initProseMirrorDoc(blocks, schema);
  const typed = EditorState.create({ schema, doc: typing.doc }).tr.insertText("about ", 13);
  updateYFragment(doc, blocks, typed.doc, typing.meta);
  expect(written.mock.calls.at(-1)?.[0], unpatched).toEqual([
    { retain: start + second.length + 6 },
  ]);

  const keeping = initProseMirrorDoc(blocks, schema);
  const type = schema.marks[CLAIM_CHECK_MARK];
  if (!type) throw new Error("No check mark");
  const from = 1 + start + 6;
  const kept = EditorState.create({ schema, doc: keeping.doc }).tr.addMark(
    from,
    from + second.length,
    type.create({ ...check("second", second, "supported"), kept: true }),
  );
  updateYFragment(doc, blocks, kept.doc, keeping.meta);
  const delta = written.mock.calls.at(-1)?.[0];
  expect(
    delta?.map((op: { retain?: number; attributes?: unknown }) => [
      op.retain,
      op.attributes !== undefined,
    ]),
    unpatched,
  ).toEqual([
    [start + 6, false],
    [second.length, true],
  ]);
  expect(markedSentences(blocks).map((each) => [each.check.id, each.check.kept ?? false])).toEqual([
    ["first", false],
    ["second", true],
  ]);
});
