import { getSchema, Mark } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import {
  markedSentences,
  markSentence,
  updateCheck,
} from "../../src/core/answers/checks/sentences";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  COMMENT_MARK,
  MIND_CONTENT_FIELD,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../../src/core/api";
import { keyMarks } from "../../src/core/markKeys";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { checkKeyOf, markKeyOf } from "../../src/shared/markKeys";

/*
 * Each check, comment and assistant's change is kept under a key of its own (#2996). One rule says
 * which check counts when two meet on the same words, and the core's reader and the editor's read by
 * it alike; a Note saved before is moved to the keys once, and two devices doing so apart end the
 * same.
 */

const sentence = "Revenue was 10 in May.";
const check = (id: string, extra: Partial<ClaimCheckAttributes> = {}): ClaimCheckAttributes => ({
  id,
  request: "check-note",
  action: "check-against-documents",
  state: "supported",
  reason: null,
  detail: null,
  providerId: "provider",
  modelId: "model",
  text: sentence,
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
  ...extra,
});

/** A Note whose one sentence holds the checks given, each under its own key, on the same words. */
function noteWith(checks: readonly ClaimCheckAttributes[]): Y.XmlFragment {
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  blocks.push([
    createElement({
      type: "paragraph",
      attrs: { id: "p" },
      content: [{ type: "text", text: sentence }],
    }),
  ]);
  const text = (blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  text.format(
    0,
    sentence.length,
    Object.fromEntries(checks.map((each) => [checkKeyOf(each.id), each])),
  );
  return blocks;
}

const schema = getSchema(noteExtensions());
const editorReads = (blocks: Y.XmlFragment) => {
  const ids: unknown[] = [];
  yXmlFragmentToProseMirrorRootNode(blocks, schema).descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === CLAIM_CHECK_MARK) ids.push(mark.attrs.id);
  });
  return [...new Set(ids)];
};
const coreReads = (blocks: Y.XmlFragment) => markedSentences(blocks).map((each) => each.check.id);

describe("which of two checks on the same words counts, read alike by the core and the editor", () => {
  test.each([
    [
      "a keep against a later result",
      [
        check("kept", { kept: true }),
        check("later", { checkedAt: "2026-11-12T10:00:00.000Z", state: "contradicted" }),
      ],
      "kept",
    ],
    [
      "two keeps",
      [
        check("early", { kept: true }),
        check("late", { kept: true, checkedAt: "2026-11-12T10:00:00.000Z" }),
      ],
      "late",
    ],
    [
      "two results",
      [
        check("early", { state: "contradicted" }),
        check("late", { checkedAt: "2026-11-12T10:00:00.000Z" }),
      ],
      "late",
    ],
    [
      "a tie",
      [check("b-check"), check("a-check")],
      checkKeyOf("a-check") < checkKeyOf("b-check") ? "a-check" : "b-check",
    ],
  ])("%s", (_, checks, counts) => {
    const blocks = noteWith(checks);
    expect(coreReads(blocks)).toEqual([counts]);
    expect(editorReads(blocks)).toEqual([counts]);
  });
});

test("a result landing on the check that lost is dropped, so it isn't counted as checked", () => {
  const kept = check("kept", { kept: true });
  const lost = check("lost", { checkedAt: "2026-11-12T10:00:00.000Z" });
  const blocks = noteWith([kept, lost]);
  const landed = updateCheck(blocks, "lost", (each) => ({
    ...each,
    state: "contradicted",
    checkedAt: "2026-11-12T11:00:00.000Z",
  }));
  expect(landed).toBe(false);
  const text = (blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  expect(text.toDelta()).toEqual([
    { insert: sentence, attributes: { [checkKeyOf("kept")]: kept, [checkKeyOf("lost")]: lost } },
  ]);
  expect(coreReads(blocks)).toEqual(["kept"]);
  expect(editorReads(blocks)).toEqual(["kept"]);
});

test("a keep whose words have changed since counts but isn't in force, and the next check writes one key over both", () => {
  const blocks = noteWith([
    check("kept", { kept: true, text: "Revenue was 9 in May." }),
    check("later", { checkedAt: "2026-11-12T10:00:00.000Z", state: "contradicted" }),
  ]);
  const [counting] = markedSentences(blocks);
  expect(counting?.check.id).toBe("kept");
  expect(editorReads(blocks)).toEqual(["kept"]);
  if (!counting) throw new Error("The sentence has no check.");
  const now = { text: sentence, versions: new Map(), folderId: null, scope: null };
  expect(claimCheckShown(counting.check, now).state).toBe("needs-recheck");
  expect(claimCheckShown({ ...counting.check, text: sentence }, now).state).toBe("kept");

  markSentence(counting.element, counting.from, counting.to, check("next"));
  const text = (blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  expect(
    (text.toDelta() as { attributes?: Record<string, unknown> }[]).map((run) =>
      Object.keys(run.attributes ?? {}),
    ),
  ).toEqual([[checkKeyOf("next")]]);
});

test("an older editor's reader, without the rule, still reads a check's own key as the check mark", () => {
  const ClaimCheck = Mark.create({
    name: CLAIM_CHECK_MARK,
    addAttributes: () => ({ id: { default: null } }),
  });
  const older = getSchema([Document, Paragraph, Text, ClaimCheck]);
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText(sentence);
  paragraph.insert(0, [text]);
  blocks.insert(0, [paragraph]);
  text.format(0, sentence.length, { [checkKeyOf("one")]: { id: "one" } });
  const read = yXmlFragmentToProseMirrorRootNode(blocks, older);
  expect(read.firstChild?.firstChild?.marks.map((mark) => [mark.type.name, mark.attrs.id])).toEqual(
    [[CLAIM_CHECK_MARK, "one"]],
  );
});

describe("a Note saved before", () => {
  /** A Note as one saved before kept its marks: each check, comment and change under its mark's name. */
  function savedBefore() {
    const doc = new Y.Doc();
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    const first = "五月收入为10亿元。";
    const second = "五月成本为8亿元。";
    blocks.push([
      createElement({
        type: "paragraph",
        attrs: { id: "p" },
        content: [{ type: "text", text: first + second }],
      }),
    ]);
    const text = (blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.format(0, first.length, { [CLAIM_CHECK_MARK]: check("first") });
    text.format(first.length, second.length, { [CLAIM_CHECK_MARK]: check("second") });
    text.format(0, 4, { [COMMENT_MARK]: { id: "comment-1" } });
    blocks.push([
      createElement({
        type: "paragraph",
        attrs: { id: "q" },
        content: [{ type: "text", text: "新增文字删去文字" }],
      }),
    ]);
    const changed = (blocks.get(1) as Y.XmlElement).get(0) as Y.XmlText;
    changed.format(0, 4, { [PROPOSAL_INSERT_MARK]: { id: "change-1", request: "request-1" } });
    changed.format(4, 4, { [PROPOSAL_DELETE_MARK]: { id: "change-2", request: "request-1" } });
    return doc;
  }
  /** Each run's format keys and the id each holds, paragraph by paragraph. */
  const keysOf = (doc: Y.Doc): [string, [string, string | undefined][]][] =>
    doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .flatMap((paragraph) =>
        ((paragraph as Y.XmlElement).get(0) as Y.XmlText)
          .toDelta()
          .map((run: { insert: string; attributes?: Record<string, { id?: string }> }) => [
            run.insert,
            Object.entries(run.attributes ?? {}).map(([key, value]) => [key, value.id]),
          ]),
      );

  const MOVED = [
    [
      "五月收入",
      [
        [checkKeyOf("first"), "first"],
        [markKeyOf(COMMENT_MARK, "comment-1"), "comment-1"],
      ],
    ],
    ["为10亿元。", [[checkKeyOf("first"), "first"]]],
    ["五月成本为8亿元。", [[checkKeyOf("second"), "second"]]],
    ["新增文字", [[markKeyOf(PROPOSAL_INSERT_MARK, "change-1"), "change-1"]]],
    ["删去文字", [[markKeyOf(PROPOSAL_DELETE_MARK, "change-2"), "change-2"]]],
  ];

  test("has its checks, comments and changes moved to their own keys once; a second pass writes nothing", () => {
    const doc = savedBefore();
    expect(keyMarks(doc.getXmlFragment(MIND_CONTENT_FIELD))).toBe(true);
    expect(keysOf(doc)).toEqual(MOVED);
    const written: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => written.push(update));
    expect(keyMarks(doc.getXmlFragment(MIND_CONTENT_FIELD))).toBe(false);
    expect(written).toEqual([]);
  });

  test("moved on two devices apart, then merged, ends the same on both: each mark once under its key", () => {
    const saved = Y.encodeStateAsUpdate(savedBefore());
    const one = new Y.Doc();
    const two = new Y.Doc();
    one.clientID = 11;
    two.clientID = 12;
    Y.applyUpdate(one, saved);
    Y.applyUpdate(two, saved);
    keyMarks(one.getXmlFragment(MIND_CONTENT_FIELD));
    keyMarks(two.getXmlFragment(MIND_CONTENT_FIELD));
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    expect(keysOf(one)).toEqual(MOVED);
    expect(keysOf(two)).toEqual(MOVED);
    expect(one.getXmlFragment(MIND_CONTENT_FIELD).toJSON()).toBe(
      two.getXmlFragment(MIND_CONTENT_FIELD).toJSON(),
    );
    expect(
      markedSentences(one.getXmlFragment(MIND_CONTENT_FIELD)).map((each) => each.check.id),
    ).toEqual(["first", "second"]);
  });
});
