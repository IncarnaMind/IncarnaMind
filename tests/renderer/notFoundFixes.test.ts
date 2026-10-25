import { type Editor, getSchema, type JSONContent } from "@tiptap/core";
import { EditorState, Plugin, type Transaction } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CITATION_NODE, CLAIM_CHECK_MARK, FOOTNOTE_NODE, GENERATED_MARK } from "../../src/core/api";
import { citationNumbersPlugin } from "../../src/renderer/src/editor/citationNumbers";
import { claimSpans, type ShownClaim } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { claimCheckShown, readClaimCheck } from "../../src/shared/claimChecks";
import { sentenceSpans } from "../../src/shared/sentences";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
  requestEdit: vi.fn(),
  useEdits: { getState: () => ({ pending: {} }) },
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/i18n", () => ({ translateNow: (key: string) => key }));

const { cutSentence, keepAsView, offersKeepAsView, offersNotFound, searchedLess } = await import(
  "../../src/renderer/src/unsupportedFixes"
);
const { useNotices } = await import("../../src/renderer/src/notices");
const { useUndo } = await import("../../src/renderer/src/undo");

const schema = getSchema(noteExtensions());

const paragraph = (text: string, ...inline: JSONContent[]): JSONContent => ({
  type: "paragraph",
  content: [...(text === "" ? [] : [{ type: "text", text }]), ...inline],
});

const citation: JSONContent = {
  type: CITATION_NODE,
  attrs: {
    passageId: null,
    documentId: "lease",
    documentName: "Lease",
    contentHash: "v1",
    pageFrom: 1,
    pageTo: 1,
    location: null,
    quote: "a quote",
    check: "found",
    checkReason: null,
  },
};

function editorHolding(content: JSONContent[], isEditable = true) {
  const undoStack: { step: unknown; before: EditorState }[] = [];
  const manager = {
    undoStack,
    redoStack: [],
    lastChange: 0,
    stopCapturing() {},
    addTrackedOrigin() {},
    on() {},
    off() {},
  };
  let state = EditorState.create({
    doc: schema.nodeFromJSON({ type: "doc", content }),
    plugins: [
      citationNumbersPlugin(),
      new Plugin({
        key: yUndoPluginKey,
        state: { init: () => ({ undoManager: manager }), apply: (_tr, value) => value },
      }),
    ],
  });
  const dispatched: Transaction[] = [];
  const editor = {
    get state() {
      return state;
    },
    get isDestroyed() {
      return false;
    },
    isEditable,
    view: {
      dispatch(tr: Transaction) {
        const before = state;
        state = state.apply(tr);
        undoStack.push({ step: {}, before });
        dispatched.push(tr);
      },
    },
    commands: {
      undo() {
        const undone = undoStack.pop();
        if (undone) state = undone.before;
        return true;
      },
    },
    on() {},
    off() {},
  } as unknown as Editor;
  return { editor, dispatched, undoStack };
}

/** The `index`th sentence of the `block`th top-level block, as a check of it would hold it. */
function claimOn(
  editor: Editor,
  block: number,
  index: number,
  over: { state?: string; citedCaseUnchecked?: boolean } = {},
): ShownClaim {
  let start = 0;
  for (let i = 0; i < block; i++) start += editor.state.doc.child(i).nodeSize;
  const node = editor.state.doc.child(block);
  const text = node.textBetween(0, node.content.size, "\n", "￼");
  const span = sentenceSpans(text)[index];
  if (!span) throw new Error("No such sentence.");
  const from = start + 1 + span.from;
  const to = start + 1 + span.to;
  return {
    check: { citedCaseUnchecked: false, scope: { folderId: null, widened: false }, ...over },
    from,
    to,
    sentence: { from, to, text: text.slice(span.from, span.to) },
    shown: { state: over.state ?? "unsupported" },
  } as unknown as ShownClaim;
}

const textsOf = (editor: Editor) => editor.state.doc.children.map((each) => each.textContent);

describe("Cut it", () => {
  test.each([
    ["the first sentence", 0, ["Two dogs. Three birds."]],
    ["a sentence in the middle", 1, ["One cat. Three birds."]],
    ["the last sentence", 2, ["One cat. Two dogs."]],
  ])("takes out %s with the space that kept it from its neighbour", (_name, index, expected) => {
    const { editor, dispatched } = editorHolding([paragraph("One cat. Two dogs. Three birds.")]);
    cutSentence(editor, claimOn(editor, 0, index));
    expect(textsOf(editor)).toEqual(expected);
    expect(dispatched).toHaveLength(1);
  });

  test("takes out a sentence of Chinese, which has no spaces", () => {
    const { editor } = editorHolding([paragraph("猫在睡觉。狗在跑步。鸟在唱歌。")]);
    cutSentence(editor, claimOn(editor, 0, 1));
    expect(textsOf(editor)).toEqual(["猫在睡觉。鸟在唱歌。"]);
  });

  test("takes out the spaces around the last sentence of a paragraph that ends in one", () => {
    const { editor } = editorHolding([paragraph("One cat. Two dogs. ")]);
    cutSentence(editor, claimOn(editor, 0, 1));
    expect(textsOf(editor)).toEqual(["One cat."]);
  });

  test("takes out the paragraph when the sentence is all it says", () => {
    const { editor } = editorHolding([paragraph("One cat."), paragraph("Two dogs.")]);
    cutSentence(editor, claimOn(editor, 0, 0));
    expect(textsOf(editor)).toEqual(["Two dogs."]);
  });

  test("leaves one empty paragraph when it was the only one", () => {
    const { editor } = editorHolding([paragraph("One cat.")]);
    cutSentence(editor, claimOn(editor, 0, 0));
    expect(textsOf(editor)).toEqual([""]);
  });

  test("takes out the list item when the sentence is all it says", () => {
    const item = (text: string): JSONContent => ({
      type: "listItem",
      content: [paragraph(text)],
    });
    const { editor } = editorHolding([
      { type: "bulletList", content: [item("One cat."), item("Two dogs.")] },
    ]);
    const list = editor.state.doc.child(0);
    const first = list.child(0);
    const from = 3;
    const to = from + first.textContent.length;
    cutSentence(editor, {
      check: {},
      from,
      to,
      sentence: { from, to, text: first.textContent },
      shown: { state: "unsupported" },
    } as unknown as ShownClaim);
    expect(editor.state.doc.child(0).childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("Two dogs.");
  });
});

describe("a sentence that cites nothing and nothing backs", () => {
  test("is offered Cut it and Keep as my view", () => {
    const { editor } = editorHolding([paragraph("One cat.")]);
    expect(offersNotFound(editor, claimOn(editor, 0, 0))).toBe(true);
  });

  test("is not offered them when the sentence has a Citation, or a verdict other than unsupported", () => {
    const { editor } = editorHolding([paragraph("One cat.", citation), paragraph("Two dogs.")]);
    expect(offersNotFound(editor, claimOn(editor, 0, 0))).toBe(false);
    expect(offersNotFound(editor, claimOn(editor, 1, 0, { state: "supported" }))).toBe(false);
    expect(offersNotFound(editor, claimOn(editor, 1, 0, { state: "contradicted" }))).toBe(false);
  });

  test("is not offered them for a court decision no Document holds, which has a card of its own", () => {
    const { editor } = editorHolding([paragraph("One cat.")]);
    expect(offersNotFound(editor, claimOn(editor, 0, 0, { citedCaseUnchecked: true }))).toBe(false);
  });

  test("is not offered them in a Mind that can't be edited", () => {
    const { editor } = editorHolding([paragraph("One cat.")], false);
    expect(offersNotFound(editor, claimOn(editor, 0, 0))).toBe(false);
  });
});

describe("Keep as my view on a contradicted sentence", () => {
  beforeEach(() => {
    useUndo.setState({ done: [], undone: [], line: null, running: null });
  });

  /** The check of the first paragraph's marked words, as a contradicted card holds it. */
  const contradictedIn = (editor: Editor): ShownClaim => ({
    ...(claimsIn(editor).c as ShownClaim),
    shown: { state: "contradicted" },
  });

  const contradictedText = (text: string): JSONContent => ({
    type: "text",
    text,
    marks: [checkMark("c", text, "contradicted")],
  });

  const checkAttrsOf = (editor: Editor) => {
    const found: Record<string, unknown>[] = [];
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (mark.type.name === CLAIM_CHECK_MARK) found.push(mark.attrs);
      }
    });
    return found;
  };

  const markTypesOf = (editor: Editor) => {
    const found: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText) for (const mark of node.marks) found.push(mark.type.name);
    });
    return found;
  };

  test("is offered for a contradicted sentence alone, in a Mind that can be edited", () => {
    const { editor } = editorHolding([
      { type: "paragraph", content: [contradictedText("Two dogs.")] },
    ]);
    expect(offersKeepAsView(editor, contradictedIn(editor))).toBe(true);
    for (const state of ["supported", "unsupported", "not-checked", "needs-recheck"] as const) {
      const claim = { ...contradictedIn(editor), shown: { state } } as ShownClaim;
      expect(offersKeepAsView(editor, claim)).toBe(false);
    }
    const { editor: fixed } = editorHolding(
      [{ type: "paragraph", content: [contradictedText("Two dogs.")] }],
      false,
    );
    expect(offersKeepAsView(fixed, contradictedIn(fixed))).toBe(false);
  });

  test("keeps the words as the User's own view, and one Undo brings the contradicted mark back", async () => {
    const { editor, dispatched } = editorHolding([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Two dogs.",
            marks: [checkMark("c", "Two dogs.", "contradicted"), { type: GENERATED_MARK }],
          },
        ],
      },
    ]);
    const claim = contradictedIn(editor);
    keepAsView(editor, claim);

    expect(dispatched).toHaveLength(1);
    expect(editor.state.doc.textContent).toBe("Two dogs.");
    expect(markTypesOf(editor)).toEqual([CLAIM_CHECK_MARK]);
    const attrs = checkAttrsOf(editor)[0] as Record<string, unknown>;
    expect(attrs.id).toBe("c");
    expect(attrs.kept).toBe(true);
    const check = readClaimCheck(attrs);
    expect(
      check &&
        claimCheckShown(check, { text: "Two dogs.", versions: null, folderId: null, scope: null }),
    ).toEqual({ state: "kept" });

    const [change] = useUndo.getState().done;
    expect(
      change?.said(
        (key) => key,
        (name) => name,
      ),
    ).toBe("claim.keptAsView");
    await useUndo.getState().undo();
    expect(editor.state.doc.textContent).toBe("Two dogs.");
    expect(checkAttrsOf(editor)[0]?.kept).toBeNull();
    expect(markTypesOf(editor).sort()).toEqual([CLAIM_CHECK_MARK, GENERATED_MARK].sort());
    const restored = readClaimCheck(checkAttrsOf(editor)[0]);
    expect(
      restored &&
        claimCheckShown(restored, {
          text: "Two dogs.",
          versions: null,
          folderId: null,
          scope: null,
        }),
    ).toEqual({ state: "contradicted" });
  });
});

describe("Search all Documents is offered while the check looked in less than every Document", () => {
  const scoped = (scope: Record<string, unknown>) =>
    ({ check: { scope } }) as unknown as ShownClaim;
  const chosen = { folderIds: [], tagIds: [], documentIds: ["lease"] };

  test("in the Mind's Folder, or in the scope the User chose", () => {
    expect(searchedLess(scoped({ folderId: "f1", widened: false }))).toBe(true);
    expect(searchedLess(scoped({ folderId: null, widened: false, chosen }))).toBe(true);
    expect(searchedLess(scoped({ folderId: "f1", widened: false, chosen }))).toBe(true);
  });

  test("not once it looked in every Document, or when it had no Folder", () => {
    expect(searchedLess(scoped({ folderId: "f1", widened: true }))).toBe(false);
    expect(searchedLess(scoped({ folderId: null, widened: false }))).toBe(false);
  });
});

/** A paragraph's pieces as the editor holds them: its text nodes, and a footnote as "[its text]". */
const shapeOf = (editor: Editor, block = 0) => {
  const pieces: string[] = [];
  editor.state.doc.child(block).forEach((child) => {
    pieces.push(child.isText ? (child.text ?? "") : `[${child.textContent}]`);
  });
  return pieces;
};

const checkMark = (id: string, text: string, state = "unsupported") => ({
  type: CLAIM_CHECK_MARK,
  attrs: {
    id,
    request: "request-1",
    action: "check-against-documents",
    state,
    text,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-23T09:00:00.000Z",
  },
});

/** Text with a check's mark on it, or a footnote holding words. */
const marked = (id: string, text: string): JSONContent => ({
  type: "text",
  text,
  marks: [checkMark(id, text)],
});
const note = (text: string): JSONContent => ({
  type: FOOTNOTE_NODE,
  content: [{ type: "text", text }],
});
const plain = (text: string): JSONContent => ({ type: "text", text });

/** The checks of the document as the editor finds them, ready to cut by. */
function claimsIn(editor: Editor): Record<string, ShownClaim> {
  return Object.fromEntries(
    claimSpans(editor.state.doc).map((span) => [
      span.check.id,
      { ...span, shown: { state: "unsupported" } } as unknown as ShownClaim,
    ]),
  );
}

describe("Cut it in a paragraph with footnotes", () => {
  const cases: [string, JSONContent[], string, string[]][] = [
    [
      "a footnote before the sentence",
      [
        plain("Whales sing in the bay."),
        note("See p. 4."),
        plain(" "),
        marked("c", "Seals rest on the sandbanks."),
      ],
      "c",
      ["Whales sing in the bay.", "[See p. 4.]"],
    ],
    [
      "a footnote after the sentence, which goes with it",
      [
        marked("c", "Whales sing in the bay."),
        note("See p. 4."),
        plain(" Seals rest on the sandbanks."),
      ],
      "c",
      ["Seals rest on the sandbanks."],
    ],
    [
      "a footnote one sentence further back",
      [
        plain("Whales sing."),
        note("See p. 4."),
        plain(" Seals rest on the sandbanks. "),
        marked("c", "Gulls follow the boats."),
      ],
      "c",
      ["Whales sing.", "[See p. 4.]", " Seals rest on the sandbanks."],
    ],
    [
      "two footnotes before the sentence",
      [
        plain("One cat."),
        note("First."),
        plain(" Two dogs."),
        note("Second."),
        plain(" "),
        marked("c", "Three birds."),
      ],
      "c",
      ["One cat.", "[First.]", " Two dogs.", "[Second.]"],
    ],
    [
      "a sentence between two footnotes",
      [
        plain("One cat."),
        note("First."),
        plain(" "),
        marked("c", "Two dogs."),
        note("Second."),
        plain(" Three birds."),
      ],
      "c",
      ["One cat.", "[First.]", " Three birds."],
    ],
    [
      "a footnote at the end of the paragraph",
      [marked("c", "One cat."), plain(" Two dogs."), note("See p. 4.")],
      "c",
      ["Two dogs.", "[See p. 4.]"],
    ],
    [
      "the sentence before a footnote at the end of the paragraph",
      [plain("One cat. "), marked("c", "Two dogs."), note("See p. 4.")],
      "c",
      ["One cat."],
    ],
  ];

  test.each(cases)("takes out exactly the sentence with %s", (_name, content, id, expected) => {
    const { editor, dispatched } = editorHolding([{ type: "paragraph", content }]);
    const claim = claimsIn(editor)[id] as ShownClaim;
    expect(editor.state.doc.textBetween(claim.from, claim.to, "", "")).toBe(
      content.flatMap((each) => (each.marks ? [each.text ?? ""] : [])).join(""),
    );
    cutSentence(editor, claim);
    expect(shapeOf(editor)).toEqual(expected);
    expect(dispatched).toHaveLength(1);
  });

  test("puts every check on its own words, however many footnotes come before it", () => {
    const { editor } = editorHolding([
      {
        type: "paragraph",
        content: [
          marked("a", "One cat."),
          note("First."),
          plain(" "),
          marked("b", "Two dogs."),
          note("Second."),
          plain(" "),
          marked("c", "Three birds."),
        ],
      },
    ]);
    const claims = claimsIn(editor);
    for (const [id, words] of [
      ["a", "One cat."],
      ["b", "Two dogs."],
      ["c", "Three birds."],
    ] as const) {
      const claim = claims[id] as ShownClaim;
      expect(editor.state.doc.textBetween(claim.from, claim.to)).toBe(words);
      expect(claim.sentence.text.startsWith(words)).toBe(true);
      expect(
        editor.state.doc.textBetween(claim.sentence.from, claim.sentence.from + words.length),
      ).toBe(words);
    }
  });

  test("cuts nothing, and says so, when the words at the sentence's place aren't the sentence", () => {
    const { editor, dispatched } = editorHolding([
      { type: "paragraph", content: [plain("One cat. "), marked("c", "Two dogs.")] },
    ]);
    const claim = claimsIn(editor).c as ShownClaim;
    const drifted = {
      ...claim,
      sentence: { ...claim.sentence, from: claim.sentence.from - 3, to: claim.sentence.to - 3 },
    } as ShownClaim;
    const before = useNotices.getState().errors.length;
    cutSentence(editor, drifted);
    expect(dispatched).toHaveLength(0);
    expect(shapeOf(editor)).toEqual(["One cat. ", "Two dogs."]);
    expect(useNotices.getState().errors).toHaveLength(before + 1);
    expect(useNotices.getState().errors.at(-1)?.message).toBe("claim.cutSentence.moved");
  });
});
