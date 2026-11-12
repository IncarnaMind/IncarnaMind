import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import {
  COMMENT_MARK,
  MIND_CONTENT_FIELD,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  TEXT_COLOR_MARK,
  TEXT_FONT_MARK,
  TEXT_SIZE_MARK,
  WORD_RUN_MARK,
} from "../../src/core/api";
import { KEYED_MARKS, type KeyedMark, keyedMarkOf, markKeyOf } from "../../src/shared/markKeys";
import { boundEditorTo, typeText } from "../helpers/editor";

/*
 * The marks other than a check that hold a value per stretch of text, tried for #2996's crossing:
 * two sentences side by side, the first under the mark. In the editor the User types at their
 * boundary, or takes the first's mark off, while another copy takes the second's off or puts one on
 * it; in both of Yjs's orders each sentence must end as the copy that wrote it left it. A comment
 * and an assistant's change crossed as checks did: one put on the second was lost. So each is kept
 * under a key of its own, as checks are. A link and the Word look's values never crossed (their
 * marks take in what is typed at their end) and stay under their names.
 */

const sentences = [
  { language: "en", first: "Revenue was 10 in May. ", second: "Costs were 8 in May." },
  { language: "zh-CN", first: "五月收入为10亿元。", second: "五月成本为8亿元。" },
] as const;

interface Case {
  mark: string;
  /** The value on the first sentence, and the one the other copy writes on the second. */
  values: readonly [Record<string, unknown>, Record<string, unknown>];
  /** The attribute that tells two values apart. */
  field: string;
}

const change = (id: string, request: string) => ({ id, request, target: "t" });
const KEYED: readonly Case[] = [
  { mark: COMMENT_MARK, values: [{ id: "comment-1" }, { id: "comment-2" }], field: "id" },
  {
    mark: PROPOSAL_INSERT_MARK,
    values: [change("change-1", "request-1"), change("change-2", "request-2")],
    field: "id",
  },
  {
    mark: PROPOSAL_DELETE_MARK,
    values: [change("change-1", "request-1"), change("change-2", "request-2")],
    field: "id",
  },
];
/** A link as the editor writes it, with its defaults, so the editor doesn't write it again. */
const link = (href: string) => ({
  href,
  target: "_blank",
  rel: "noopener noreferrer nofollow",
  class: null,
  title: null,
});
const NAMED: readonly Case[] = [
  { mark: TEXT_COLOR_MARK, values: [{ color: "C00000" }, { color: "0070C0" }], field: "color" },
  { mark: TEXT_FONT_MARK, values: [{ family: "Arial" }, { family: "Calibri" }], field: "family" },
  { mark: TEXT_SIZE_MARK, values: [{ size: 12 }, { size: 14 }], field: "size" },
  { mark: WORD_RUN_MARK, values: [{ k: "run-1" }, { k: "run-2" }], field: "k" },
  { mark: "link", values: [link("https://a.example"), link("https://b.example")], field: "href" },
];

const isKeyed = (mark: string): mark is KeyedMark =>
  (KEYED_MARKS as readonly string[]).includes(mark);
const keyOf = (mark: string, value: Record<string, unknown>) =>
  isKeyed(mark) ? markKeyOf(mark, value.id) : mark;

type EditorWrite = "types at their boundary" | "takes the first's off";
type OtherWrite = "takes the second's off" | "puts one on the second";

/** What each sentence holds of the mark once both copies have each other's writes, on each copy. */
function cross(
  { mark, values: [a, b], field }: Case,
  { first, second }: { first: string; second: string },
  editorWrite: EditorWrite,
  otherWrite: OtherWrite,
  copyId: number,
) {
  const core = new Y.Doc();
  const blocks = core.getXmlFragment(MIND_CONTENT_FIELD);
  blocks.push([
    createElement({
      type: "paragraph",
      attrs: { id: "p" },
      content: [
        { type: "text", text: first, marks: [{ type: mark, attrs: a }] },
        otherWrite === "takes the second's off"
          ? { type: "text", text: second, marks: [{ type: mark, attrs: b }] }
          : { type: "text", text: second },
      ],
    }),
  ]);
  const text = (blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
  copy.clientID = copyId;
  core.clientID = 2;
  const editor = boundEditorTo(copy);
  text.format(first.length, second.length, {
    [keyOf(mark, b)]: otherWrite === "takes the second's off" ? null : b,
  });
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText) at = pos;
  });
  if (editorWrite === "types at their boundary") {
    editor.commands.setTextSelection(at + first.length);
    typeText(editor, "X");
  } else {
    const type = editor.schema.marks[mark];
    if (!type) throw new Error(`No ${mark}`);
    editor.view.dispatch(editor.state.tr.removeMark(at, at + first.length, type));
  }
  Y.applyUpdate(core, Y.encodeStateAsUpdate(copy));
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(core));
  return [core, copy].map((note) => {
    const runs = (
      (note.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText
    ).toDelta() as { insert: string; attributes?: Record<string, unknown> }[];
    const held = (words: string) =>
      Object.entries(runs.find((run) => run.insert.includes(words))?.attributes ?? {})
        .filter(([key]) => key === mark || keyedMarkOf(key) === mark)
        .map(([, value]) => (value as Record<string, unknown>)[field]);
    return [held(first.slice(0, 4)), held(second.slice(0, 4))];
  });
}

const writes = (["types at their boundary", "takes the first's off"] as const).flatMap(
  (editorWrite) =>
    (["takes the second's off", "puts one on the second"] as const).flatMap((otherWrite) =>
      [1, 3].map((copyId) => [editorWrite, otherWrite, copyId] as const),
    ),
);

/** Each sentence as the copy that wrote it left it, on both copies. */
const expected = (
  { values: [a, b], field }: Case,
  editorWrite: EditorWrite,
  otherWrite: OtherWrite,
) => {
  const ends = [
    editorWrite === "types at their boundary" ? [a[field]] : [],
    otherWrite === "puts one on the second" ? [b[field]] : [],
  ];
  return [ends, ends];
};

describe.each(sentences)("$language", (words) => {
  describe.each([...KEYED, ...NAMED])("$mark beside another", (each) => {
    test.each(writes)(
      "the User %s while the other copy %s ends as each left it (copy %i)",
      (editorWrite, otherWrite, copyId) => {
        expect(cross(each, words, editorWrite, otherWrite, copyId)).toEqual(
          expected(each, editorWrite, otherWrite),
        );
      },
    );
  });
});
