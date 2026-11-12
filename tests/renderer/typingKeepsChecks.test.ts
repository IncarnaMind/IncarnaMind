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
import { readClaimCheck } from "../../src/shared/claimChecks";
import { checkKeyOf, countingCheckOf } from "../../src/shared/markKeys";
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
  /** The core lands a newer result on a sentence, the second unless named: Contradicted. */
  function landContradicted(core: Y.Doc, id: "first" | "second" = "second") {
    const landing = markedSentences(core.getXmlFragment(MIND_CONTENT_FIELD)).find(
      (each) => each.check.id === id,
    );
    if (!landing) throw new Error(`The ${id} sentence has no check`);
    markSentence(landing.element, landing.from, landing.to, {
      ...check(id, id === "first" ? first : second, "contradicted"),
      checkedAt: "2026-11-12T09:01:00.000Z",
    });
  }
  const results = (note: Y.Doc) =>
    markedSentences(note.getXmlFragment(MIND_CONTENT_FIELD)).map((each) => [
      each.check.id,
      each.check.state,
    ]);

  // Yjs orders two writes made at once by the ids of the copies that made them: both orders.
  test.each([
    ["the first", "before", "first", 1],
    ["the first", "after", "first", 3],
    ["the second", "before", "second", 1],
    ["the second", "after", "second", 3],
  ] as const)(
    "bold on %s sentence while a result lands on the other leaves that result, the bold ordered %s it",
    (_, _order, bolded, copyId) => {
      const other = bolded === "first" ? "second" : "first";
      const core = checkedNote();
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
      copy.clientID = copyId;
      core.clientID = 2;
      const editor = boundEditorTo(copy);
      landContradicted(core, other);
      let start = -1;
      editor.state.doc.descendants((node, pos) => {
        if (start < 0 && node.isText) start = pos;
      });
      const from = bolded === "first" ? start : start + first.length + gap.length;
      const bold = editor.schema.marks.bold;
      if (!bold) throw new Error("No bold");
      editor.view.dispatch(
        editor.state.tr.addMark(
          from,
          from + (bolded === "first" ? first : second).length,
          bold.create(),
        ),
      );
      Y.applyUpdate(core, Y.encodeStateAsUpdate(copy));
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
      for (const note of [core, copy]) {
        expect(note.getXmlFragment(MIND_CONTENT_FIELD).toString()).toContain("<bold>");
        expect(results(note)).toEqual([
          ["first", bolded === "first" ? "supported" : "contradicted"],
          ["second", bolded === "second" ? "supported" : "contradicted"],
        ]);
      }
    },
  );

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
  /** Each formatting op of the last write: how far it reaches, and the marks it sets. */
  const lastWrite = () =>
    (written.mock.calls.at(-1)?.[0] ?? []).map(
      (op: { retain?: number; attributes?: Record<string, unknown> }) => [
        op.retain,
        Object.keys(op.attributes ?? {}),
      ],
    );
  expect(lastWrite(), unpatched).toEqual([
    [start + 6, []],
    [second.length, [checkKeyOf("second")]],
  ]);
  expect(markedSentences(blocks).map((each) => [each.check.id, each.check.kept ?? false])).toEqual([
    ["first", false],
    ["second", true],
  ]);

  // Bold on a checked sentence sets bold there, and writes no check.
  const bolding = initProseMirrorDoc(blocks, schema);
  const bold = schema.marks.bold;
  if (!bold) throw new Error("No bold");
  const emboldened = EditorState.create({ schema, doc: bolding.doc }).tr.addMark(
    1,
    1 + first.length + 6,
    bold.create(),
  );
  updateYFragment(doc, blocks, emboldened.doc, bolding.meta);
  expect(lastWrite(), unpatched).toEqual([
    [first.length + 6, ["bold"]],
    [gap.length + second.length, []],
  ]);
  expect(markedSentences(blocks).map((each) => [each.check.id, each.check.state])).toEqual([
    ["first", "supported"],
    ["second", "supported"],
  ]);
});

// #2996: two checked sentences with nothing between them share one boundary. A write at that
// boundary in the editor, while the core lands a result on the other sentence, must leave each
// sentence its own check, in both of Yjs's orders.
describe.each([
  { layout: "two checked sentences side by side", words: english },
  { layout: "两个已核对的句子紧挨着", words: chinese },
])("$layout, written at their boundary while a result lands", ({ words }) => {
  const { first, second, gap } = words;
  const whole = `${first}${gap}${second}`;
  const start = first.length + gap.length;

  /** The core's Note: the first sentence's check runs up to the second's first character. */
  function touchingNote() {
    const core = new Y.Doc();
    const blocks = core.getXmlFragment(MIND_CONTENT_FIELD);
    blocks.push([createElement(paragraphOf(words))]);
    const element = blocks.get(0);
    if (!(element instanceof Y.XmlElement)) throw new Error("No paragraph");
    markSentence(element, 0, start, check("first", first, "supported"));
    markSentence(element, start, whole.length, check("second", second, "supported"));
    return core;
  }
  const textOf = (id: "first" | "second") => (id === "first" ? first : second);
  /** The core lands Contradicted on a sentence's check. */
  function land(core: Y.Doc, id: "first" | "second") {
    const landing = markedSentences(core.getXmlFragment(MIND_CONTENT_FIELD)).find(
      (each) => each.check.id === id,
    );
    if (!landing) throw new Error(`The ${id} sentence has no check`);
    markSentence(landing.element, landing.from, landing.to, {
      ...check(id, textOf(id), "contradicted"),
      checkedAt: "2026-11-12T09:01:00.000Z",
    });
  }
  /** Each check the Note holds, with the words it covers. */
  const checks = (note: Y.Doc) => {
    const text = (note.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
    return (text.toDelta() as { insert: string; attributes?: Record<string, unknown> }[]).flatMap(
      (run) => {
        const value = readClaimCheck(countingCheckOf(run.attributes)?.attrs);
        return value ? [[run.insert.trim(), value.id, value.state, value.kept === true]] : [];
      },
    );
  };
  /** The editor on a copy of the core's Note that hasn't had the landing yet, ordered by `copyId`. */
  function editorBefore(core: Y.Doc, copyId: number) {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
    copy.clientID = copyId;
    core.clientID = 2;
    return { copy, editor: boundEditorTo(copy) };
  }
  function exchange(core: Y.Doc, copy: Y.Doc) {
    Y.applyUpdate(core, Y.encodeStateAsUpdate(copy));
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
  }
  /** The sentence's place in the editor's document. */
  function placeOf(editor: Editor, id: "first" | "second") {
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText) at = pos;
    });
    const from = id === "first" ? at : at + start;
    return { from, to: from + (id === "first" ? start : second.length) };
  }
  /** Keep as my view on a sentence in the editor, as the check's card writes it. */
  function keep(editor: Editor, id: "first" | "second") {
    const type = editor.schema.marks[CLAIM_CHECK_MARK];
    if (!type) throw new Error("No check mark");
    const { from, to } = placeOf(editor, id);
    editor.view.dispatch(
      editor.state.tr.addMark(
        from,
        to,
        type.create({ ...check(id, textOf(id), "supported"), kept: true }),
      ),
    );
  }

  test.each([
    ["the first", "the second", "before", "first", 1],
    ["the first", "the second", "after", "first", 3],
    ["the second", "the first", "before", "second", 1],
    ["the second", "the first", "after", "second", 3],
  ] as const)(
    "a keep on %s while a result lands on %s leaves each its own check, the keep ordered %s it",
    (_, _other, _order, kept, copyId) => {
      const other = kept === "first" ? "second" : "first";
      const core = touchingNote();
      const { copy, editor } = editorBefore(core, copyId);
      land(core, other);
      keep(editor, kept);
      exchange(core, copy);
      const want = [
        [first.trim(), "first", kept === "first" ? "supported" : "contradicted", kept === "first"],
        [
          second.trim(),
          "second",
          kept === "second" ? "supported" : "contradicted",
          kept === "second",
        ],
      ];
      expect(checks(core)).toEqual(want);
      expect(checks(copy)).toEqual(want);
    },
  );

  test.each([
    ["before", 1],
    ["after", 3],
  ])(
    "a character typed between the two while a result lands on the second leaves each its own check, the typing ordered %s it",
    (_, copyId) => {
      const core = touchingNote();
      const { copy, editor } = editorBefore(core, copyId);
      land(core, "second");
      editor.commands.setTextSelection(placeOf(editor, "second").from);
      typeText(editor, "X");
      exchange(core, copy);
      const want = [
        [first.trim(), "first", "supported", false],
        [second.trim(), "second", "contradicted", false],
      ];
      for (const note of [core, copy]) {
        expect(
          (note.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement).toString(),
        ).toContain("X");
        expect(checks(note)).toEqual(want);
      }
    },
  );
});

// #2996: three checked sentences side by side; the User keeps the first and the third while a
// result lands on the middle one.
describe.each([
  {
    layout: "three checked sentences side by side",
    sentences: ["Revenue was 10 in May. ", "Costs were 8 in May. ", "Profit was 2 in May."],
  },
  {
    layout: "三个已核对的句子紧挨着",
    sentences: ["五月收入为10亿元。", "五月成本为8亿元。", "五月利润为2亿元。"],
  },
])("$layout", ({ sentences }) => {
  const ids = ["one", "two", "three"] as const;
  const starts = sentences.map((_, at) => sentences.slice(0, at).join("").length);
  test.each([
    ["before", 1],
    ["after", 3],
  ])(
    "keeps on the first and the third while a result lands on the middle leave each its own check, the keeps ordered %s it",
    (_, copyId) => {
      const core = new Y.Doc();
      const blocks = core.getXmlFragment(MIND_CONTENT_FIELD);
      blocks.push([
        createElement({
          type: "paragraph",
          attrs: { id: "p" },
          content: [{ type: "text", text: sentences.join("") }],
        }),
      ]);
      const element = blocks.get(0);
      if (!(element instanceof Y.XmlElement)) throw new Error("No paragraph");
      sentences.forEach((text, at) => {
        markSentence(
          element,
          starts[at] ?? 0,
          (starts[at] ?? 0) + text.length,
          check(ids[at] ?? "", text, "supported"),
        );
      });
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
      copy.clientID = copyId;
      core.clientID = 2;
      const editor = boundEditorTo(copy);
      const landing = markedSentences(blocks).find((each) => each.check.id === "two");
      if (!landing) throw new Error("The middle sentence has no check");
      markSentence(
        landing.element,
        landing.from,
        landing.to,
        check("two", sentences[1] ?? "", "contradicted"),
      );
      const type = editor.schema.marks[CLAIM_CHECK_MARK];
      if (!type) throw new Error("No check mark");
      let at = -1;
      editor.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isText) at = pos;
      });
      for (const index of [0, 2]) {
        const from = at + (starts[index] ?? 0);
        editor.view.dispatch(
          editor.state.tr.addMark(
            from,
            from + (sentences[index] ?? "").length,
            type.create({
              ...check(ids[index] ?? "", sentences[index] ?? "", "supported"),
              kept: true,
            }),
          ),
        );
      }
      Y.applyUpdate(core, Y.encodeStateAsUpdate(copy));
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
      for (const note of [core, copy])
        expect(
          markedSentences(note.getXmlFragment(MIND_CONTENT_FIELD)).map((each) => [
            each.check.id,
            each.check.state,
            each.check.kept === true,
          ]),
        ).toEqual([
          ["one", "supported", true],
          ["two", "contradicted", false],
          ["three", "supported", true],
        ]);
    },
  );
});
