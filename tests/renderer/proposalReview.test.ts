import { Editor, type JSONContent } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { prosemirrorToYXmlFragment, ySyncPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, PROPOSAL_ATTRIBUTE } from "../../src/core";
import { selectionForEdit } from "../../src/renderer/src/editor/editSelection";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  acceptedSlice,
  editTarget,
  ProposalReview,
  pendingAtSelection,
  pendingIn,
  placeOnAccept,
  positionOf,
  proposalReviewKey,
  proposalsAt,
  sourcesRemoved,
} from "../../src/renderer/src/editor/proposalReview";
import { outOfDateProposals, targetHash } from "../../src/shared/proposals";

const inserted = (id: string) => ({ type: "proposalInsert", attrs: { id, request: "r1" } });
const removed = (id: string) => ({ type: "proposalDelete", attrs: { id, request: "r1" } });

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks && { marks }),
});

const citation = (quote: string, proposal: unknown = null): JSONContent => ({
  type: "citation",
  attrs: {
    documentId: "d1",
    documentName: "Tides",
    quote,
    check: "found",
    [PROPOSAL_ATTRIBUTE]: proposal,
  },
});

/**
 * The note's state with the review's plugin, as the editor has it once it is
 * shown (a headless editor adds no plugins): changes go through `apply`.
 */
function noteWith(
  content: JSONContent[],
  asked?: (state: EditorState, request: string) => boolean,
) {
  const editor = new Editor({
    element: null,
    extensions: [...noteExtensions(), asked ? ProposalReview.configure({ asked }) : ProposalReview],
    content: { type: "doc", content },
  });
  onTestFinished(() => editor.destroy());
  let state = EditorState.create({
    doc: editor.state.doc,
    plugins: editor.extensionManager.plugins,
  });
  return {
    get state() {
      return state;
    },
    apply(change: (tr: EditorState["tr"]) => void) {
      const tr = state.tr;
      change(tr);
      state = state.applyTransaction(tr).state;
    },
    /** The position just after the first `words` in the text. */
    after(words: string): number {
      let found = -1;
      state.doc.descendants((node, pos) => {
        if (found >= 0 || !node.isText) return found < 0;
        const at = node.text?.indexOf(words) ?? -1;
        if (at >= 0) found = pos + at + words.length;
        return false;
      });
      if (found < 0) throw new Error(`"${words}" isn't in the document.`);
      return found;
    },
  };
}

/** The class a decoration gives, for what the review draws. */
const classOf = (decoration: unknown) =>
  (decoration as { type: { attrs?: { class?: string } } }).type.attrs?.class;

/** Marks of a change that records the text it removes, as the core writes them. */
const change = (id: string, removes: string) => {
  const ref = { id, request: "r1", target: targetHash(removes) };
  return {
    removed: { type: "proposalDelete", attrs: ref },
    inserted: { type: "proposalInsert", attrs: ref },
  };
};

/** The changes out of date as the core reads them, from the editor's document written to Yjs. */
function outOfDateInCore(note: { state: EditorState }): string[] {
  const doc = new Y.Doc();
  const blocks = prosemirrorToYXmlFragment(note.state.doc, doc.getXmlFragment(MIND_CONTENT_FIELD));
  return [...outOfDateProposals(blocks)].sort();
}

describe("Proposals in the editor", () => {
  test("are found from their marks and attributes, in order, with what they remove and add", () => {
    const note = noteWith([
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          text("The tides are "),
          text("very ", [removed("a")]),
          text("strong and "),
          text("really", [removed("b")]),
          text("truly", [inserted("b")]),
          text(" regular "),
          citation("Spring tides", { id: "c", request: "r1", kind: "delete" }),
          text("."),
        ],
      },
      {
        type: "paragraph",
        attrs: { id: "p2", [PROPOSAL_ATTRIBUTE]: { id: "d", request: "r1", kind: "insert" } },
        content: [text("A new paragraph.")],
      },
    ]);

    const proposals = pendingIn(note.state);
    expect(proposals.map((each) => [each.id, each.removed, each.added, each.block])).toEqual([
      ["a", "very ", "", null],
      ["b", "really", "truly", null],
      ["c", "￼", "", null],
      ["d", "", "A new paragraph.", "insert"],
    ]);
    expect(proposals.map((each) => each.droppedCitations)).toEqual([0, 0, 1, 0]);
    expect(proposals[1]?.ranges).toHaveLength(1);
    // The Citation and the new paragraph are drawn as changes: node views draw no marks.
    const drawn = proposalReviewKey.getState(note.state)?.decorations.find().map(classOf).sort();
    expect(drawn).toEqual([
      "proposal-node proposal-node--delete",
      "proposal-node proposal-node--insert",
    ]);
  });

  test("the cursor is on the change it is in or beside, and a selection on every change it touches", () => {
    const note = noteWith([
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          text("one "),
          text("two ", [removed("a")]),
          text("three "),
          text("four", [inserted("b")]),
          text(" five"),
        ],
      },
    ]);
    const proposals = pendingIn(note.state);
    const at = (from: number, to = from) =>
      proposalsAt(proposals, { from, to, empty: from === to }).map((each) => each.id);

    expect(at(note.after("one "))).toEqual(["a"]);
    expect(at(note.after("tw"))).toEqual(["a"]);
    expect(at(note.after("thr"))).toEqual([]);
    // A section: from the first change to the second.
    expect(at(note.after("o"), note.after("fou"))).toEqual(["a", "b"]);

    note.apply((tr) => tr.setSelection(TextSelection.create(tr.doc, note.after("fo"))));
    expect(pendingAtSelection(note.state).map((each) => each.id)).toEqual(["b"]);
    // The change the cursor is in is washed.
    const washed = proposalReviewKey.getState(note.state)?.decorations.find();
    expect(washed?.map((each) => note.state.doc.textBetween(each.from, each.to))).toEqual(["four"]);
  });

  test("what the User types into a change is their own", () => {
    const note = noteWith([
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          text("Keep "),
          text("added words", [inserted("a")]),
          text(" and "),
          text("old", [removed("b")]),
        ],
      },
    ]);
    note.apply((tr) => tr.insertText(" mine", note.after("added")));
    note.apply((tr) => tr.insertText("X", note.after("ol")));

    const marked: string[] = [];
    note.state.doc.descendants((node) => {
      if (node.isText) {
        marked.push(`${node.text}:${node.marks.map((mark) => mark.type.name).join("+")}`);
      }
    });
    expect(marked).toEqual([
      "Keep :",
      "added:proposalInsert",
      " mine:",
      " words:proposalInsert",
      " and :",
      "ol:proposalDelete",
      "X:",
      "d:proposalDelete",
    ]);
    expect(pendingIn(note.state).map((each) => each.id)).toEqual(["a", "b"]);
  });

  test("someone's change from a Word file is theirs, drawn apart from the assistant's", () => {
    const theirs = { id: "word:w:ins#4", request: "word:w:ins#4" };
    const note = noteWith([
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          text("Notice is "),
          text("three months", [{ type: "proposalInsert", attrs: theirs }]),
          text(" in "),
          text("writing", [removed("a")]),
          text("."),
        ],
      },
      {
        type: "paragraph",
        attrs: {
          id: "p2",
          [PROPOSAL_ATTRIBUTE]: { id: "word:w:ins#9", request: "word:w:ins#9", kind: "insert" },
        },
        content: [text("Pets are allowed.")],
      },
    ]);

    expect(pendingIn(note.state).map((each) => [each.id, each.theirs])).toEqual([
      ["word:w:ins#4", true],
      ["a", false],
      ["word:w:ins#9", true],
    ]);
    const drawn = proposalReviewKey.getState(note.state)?.decorations.find().map(classOf);
    expect(drawn).toEqual(["proposal-node proposal-node--insert proposal-theirs"]);
  });

  test("text the AI is working on stays marked as the User writes before it", () => {
    const note = noteWith([
      { type: "paragraph", attrs: { id: "p1" }, content: [text("Spring tides are high.")] },
    ]);
    note.apply((tr) =>
      tr.setMeta(proposalReviewKey, {
        target: { from: note.after("Spring "), to: note.after("high") },
      }),
    );
    note.apply((tr) => tr.insertText("Big ", 1));

    const target = editTarget(note.state);
    expect(note.state.doc.textBetween(target?.from ?? 0, target?.to ?? 0)).toBe("tides are high");
    const [wash] = proposalReviewKey.getState(note.state)?.decorations.find() ?? [];
    expect(wash).toMatchObject({ from: target?.from, to: target?.to });
    expect(classOf(wash)).toBe("proposal-target");
  });
});

describe("Changes the User's own Question asked for", () => {
  /** A paragraph of `request` coming in from the core's copy of the Mind, as one update does. */
  const arrives = (note: ReturnType<typeof noteWith>, id: string, request: string) =>
    note.apply((tr) => {
      const { paragraph } = note.state.schema.nodes;
      tr.insert(
        tr.doc.content.size,
        paragraph?.create(
          { id, [PROPOSAL_ATTRIBUTE]: { id, request, kind: "insert" } },
          note.state.schema.text(`Words of ${id}.`),
        ) ?? [],
      ).setMeta(ySyncPluginKey, { isChangeOrigin: true });
    });

  test("apply from the frame the first of them arrives, and wait only if the window then holds them back", () => {
    const note = noteWith(
      [{ type: "paragraph", attrs: { id: "p1" }, content: [text("The tide turns.")] }],
      (_state, request) => request === "r1",
    );
    const ids = (list: readonly { id: string }[]) => list.map((each) => each.id);

    arrives(note, "a", "r1");
    const review = () => proposalReviewKey.getState(note.state);
    expect(ids(pendingIn(note.state))).toEqual([]);
    expect(ids(review()?.applied ?? [])).toEqual(["a"]);

    arrives(note, "b", "r2");
    expect(ids(pendingIn(note.state))).toEqual(["b"]);

    note.apply((tr) => tr.setMeta(proposalReviewKey, { applying: new Set<string>() }));
    arrives(note, "c", "r1");
    expect(ids(pendingIn(note.state))).toEqual(["a", "b", "c"]);
  });

  test("wait as before where this window didn't ask, and in a Mind opened with them already there", () => {
    const apart = noteWith(
      [{ type: "paragraph", attrs: { id: "p1" }, content: [text("The tide turns.")] }],
      () => false,
    );
    arrives(apart, "a", "r1");
    expect(pendingIn(apart.state).map((each) => each.id)).toEqual(["a"]);

    const opened = noteWith(
      [
        {
          type: "paragraph",
          attrs: { id: "p2", [PROPOSAL_ATTRIBUTE]: { id: "d", request: "r1", kind: "insert" } },
          content: [text("Already there.")],
        },
      ],
      () => true,
    );
    expect(pendingIn(opened.state).map((each) => each.id)).toEqual(["d"]);
  });
});

describe("A place once changes are accepted", () => {
  test("counts only the text that stays, is gone with a Block a change removes, and holds through the accept", () => {
    const tides = (content: JSONContent[]) => ({
      type: "paragraph",
      attrs: { id: "tides" },
      content,
    });
    const note = noteWith([
      {
        type: "paragraph",
        attrs: { id: "pier", [PROPOSAL_ATTRIBUTE]: { id: "c1", request: "r1", kind: "delete" } },
        content: [text("The pier is closed.")],
      },
      tides([
        text("Tides are "),
        text("very ", [removed("c2")]),
        citation("Spring tides"),
        text(" strong", [inserted("c3")]),
        text(" today."),
      ]),
    ]);
    const { doc } = note.state;
    const end = "Tides are very ￼ strong today.".length;
    expect(placeOnAccept(doc, { blockId: "tides", offset: end })).toEqual({
      blockId: "tides",
      offset: "Tides are ￼ strong today.".length,
    });
    expect(placeOnAccept(doc, { blockId: "tides", offset: "Tides are very".length })).toEqual({
      blockId: "tides",
      offset: "Tides are ".length,
    });
    expect(placeOnAccept(doc, { blockId: "pier", offset: 0 })).toBeNull();

    const accepted = noteWith([
      tides([text("Tides are "), citation("Spring tides"), text(" strong today.")]),
    ]).state.doc;
    const from = positionOf(accepted, { blockId: "tides", offset: 0 });
    const to = positionOf(accepted, {
      blockId: "tides",
      offset: "Tides are ￼ strong today.".length,
    });
    expect(from !== null && to !== null && accepted.textBetween(from, to, "", "￼")).toBe(
      "Tides are ￼ strong today.",
    );
    expect(positionOf(accepted, { blockId: "gone", offset: 0 })).toBeNull();
  });
});

describe("Changes out of date", () => {
  /** "The tides are [-very -]strong and [-really-]{+truly+} regular.", each change recording what it removes. */
  function tides() {
    const a = change("a", "very ");
    const b = change("b", "really");
    return noteWith([
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          text("The tides are "),
          text("very ", [a.removed]),
          text("strong and "),
          text("really", [b.removed]),
          text("truly", [b.inserted]),
          text(" regular."),
        ],
      },
    ]);
  }

  test("a change is out of date once the User edits the words it removes, in the editor as in the core", () => {
    const note = tides();
    expect(pendingIn(note.state).map((each) => each.outOfDate)).toEqual([false, false]);
    expect(outOfDateInCore(note)).toEqual([]);

    // Writing in what a change adds, or elsewhere, leaves it as it is.
    note.apply((tr) => tr.insertText("u", note.after("tru")));
    note.apply((tr) => tr.insertText(" Indeed.", note.after("regular.")));
    expect(pendingIn(note.state).map((each) => each.outOfDate)).toEqual([false, false]);
    expect(outOfDateInCore(note)).toEqual([]);

    // A word typed among the words a change removes is the User's: the change is out of date.
    note.apply((tr) => tr.insertText("l", note.after("rea")));
    expect(pendingIn(note.state).map((each) => each.outOfDate)).toEqual([false, true]);
    expect(outOfDateInCore(note)).toEqual(["b"]);

    // It is drawn so, with "Out of date · Regenerate" after its paragraph.
    const drawn = proposalReviewKey.getState(note.state)?.decorations.find() ?? [];
    const stale = drawn.filter((each) => classOf(each)?.includes("proposal-stale"));
    // Its words, not those the User typed among them.
    expect(stale.map((each) => note.state.doc.textBetween(each.from, each.to)).join("")).toBe(
      "reallytruly",
    );
    const line = drawn.find((each) => (each.spec as { key?: string }).key?.startsWith("stale-b"));
    expect(line?.from).toBe(note.state.doc.child(0).nodeSize);
  });

  test("deleting part of the words a change removes, or a paragraph it removes, puts it out of date", () => {
    const note = tides();
    const very = note.after("The tides are ");
    note.apply((tr) => tr.delete(very, very + "ve".length));
    expect(pendingIn(note.state).map((each) => each.outOfDate)).toEqual([true, false]);
    expect(outOfDateInCore(note)).toEqual(["a"]);

    const removedParagraph = noteWith([
      {
        type: "paragraph",
        attrs: {
          id: "p1",
          [PROPOSAL_ATTRIBUTE]: {
            id: "c",
            request: "r1",
            target: targetHash("A paragraph to go."),
            kind: "delete",
          },
        },
        content: [text("A paragraph to go.")],
      },
    ]);
    expect(pendingIn(removedParagraph.state)[0]?.outOfDate).toBe(false);
    removedParagraph.apply((tr) => tr.insertText(" Still mine.", removedParagraph.after("go.")));
    expect(pendingIn(removedParagraph.state)[0]?.outOfDate).toBe(true);
    expect(outOfDateInCore(removedParagraph)).toEqual(["c"]);
  });

  test("a change made before changes recorded their text is never out of date", () => {
    const note = noteWith([
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [text("The "), text("old", [removed("a")]), text(" tides.")],
      },
    ]);
    note.apply((tr) => tr.insertText("X", note.after("ol")));
    expect(pendingIn(note.state)[0]?.outOfDate).toBe(false);
    expect(outOfDateInCore(note)).toEqual([]);
  });

  test("copying a change still waiting copies the text it would replace", () => {
    const note = tides();
    const { doc } = note.state;
    const copied = acceptedSlice(doc.slice(0, doc.content.size));
    expect(copied.content.textBetween(0, copied.content.size)).toBe(
      "The tides are very strong and really regular.",
    );
    // Nothing in the copy is a change any more.
    const marks: string[] = [];
    copied.content.descendants((node) => {
      marks.push(...node.marks.map((mark) => mark.type.name));
    });
    expect(marks).toEqual([]);
  });

  describe("copying a selection", () => {
    const paragraph = (id: string, content: JSONContent[], proposal?: unknown): JSONContent => ({
      type: "paragraph",
      attrs: { id, ...(proposal ? { [PROPOSAL_ATTRIBUTE]: proposal } : {}) },
      content,
    });

    /** What a copy puts on the clipboard, as the view asks the plugins for it. */
    function copied(note: ReturnType<typeof noteWith>) {
      const { state } = note;
      const view = { state } as never;
      let slice = state.doc.slice(0, state.doc.content.size);
      for (const plugin of state.plugins) {
        const transform = plugin.props.transformCopied;
        if (transform) slice = transform.call(plugin, slice, view);
      }
      let plain = "";
      for (const plugin of state.plugins) {
        plain = plugin.props.clipboardTextSerializer?.call(plugin, slice, view) || "";
        if (plain) break;
      }
      return { plain, rich: slice.content.textBetween(0, slice.content.size, "\n\n") };
    }

    test("leaves out the words and Blocks a pending change adds", () => {
      const replacement = change("a", "very strong");
      const note = noteWith([
        paragraph("p1", [
          text("The tides are "),
          text("very strong", [replacement.removed]),
          text("strong", [replacement.inserted]),
          text(" and regular"),
          text(" indeed", [inserted("b")]),
          text("."),
        ]),
        paragraph("p2", [text("A new Block.", [inserted("c")])], {
          id: "c",
          request: "r1",
          kind: "insert",
        }),
        paragraph("p3", [text("The end.")]),
      ]);
      const accepted = "The tides are very strong and regular.\n\nThe end.";
      expect(copied(note)).toEqual({ plain: accepted, rich: accepted });
    });

    test("leaves a selection without a pending change to the editor", () => {
      const note = noteWith([paragraph("p1", [text("One.")]), paragraph("p2", [text("Two.")])]);
      expect(copied(note)).toEqual({ plain: "", rich: "One.\n\nTwo." });
    });
  });

  test("a change citing a Document deleted since says its source is removed", () => {
    const note = noteWith([
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          text("Spring tides are high"),
          citation("Spring tides", { id: "c", request: "r1", kind: "insert" }),
          text("."),
        ],
      },
    ]);
    const [adds] = pendingIn(note.state);
    if (!adds) throw new Error("No change.");
    expect(adds.citations).toMatchObject([{ documentId: "d1" }]);
    expect(sourcesRemoved(adds, [{ id: "d1", contentHash: "h1" }])).toBe(0);
    // Deleted: the change says so, and it stays.
    expect(sourcesRemoved(adds, [])).toBe(1);
    expect(pendingIn(note.state)).toHaveLength(1);
    // While the Documents load, nothing is said.
    expect(sourcesRemoved(adds, null)).toBe(0);
  });
});

describe("The text Edit with AI changes", () => {
  test("is the selection in paragraphs and headings, with a Citation as one character", () => {
    const note = noteWith([
      { type: "heading", attrs: { id: "h1", level: 2 }, content: [text("Tides")] },
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [text("Spring tides "), citation("Spring tides"), text(" are high.")],
      },
    ]);

    expect(
      selectionForEdit(note.state, { from: note.after("Ti"), to: note.after(" are") }),
    ).toMatchObject({
      from: { blockId: "h1", offset: 2 },
      to: { blockId: "p1", offset: "Spring tides ￼ are".length },
      text: "des\nSpring tides ￼ are",
    });
  });

  test("counts a footnote as one character, without the text it holds", () => {
    const note = noteWith([
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          text("Neap tides"),
          { type: "footnote", attrs: { id: "f1" }, content: [text("At the quarter moons.")] },
          text(" are weak; spring tides"),
          { type: "footnote", attrs: { id: "f2" }, content: [text("Twice a month.")] },
          text(" are strong."),
        ],
      },
    ]);

    expect(
      selectionForEdit(note.state, { from: note.after("weak; "), to: note.after(" are strong") }),
    ).toMatchObject({
      from: { blockId: "p1", offset: "Neap tides￼ are weak; ".length },
      to: { blockId: "p1", offset: "Neap tides￼ are weak; spring tides￼ are strong".length },
      text: "spring tides￼ are strong",
    });
  });

  test("isn't a Question, code, nothing but spaces, or an Answer being written", () => {
    const note = noteWith([
      { type: "question", attrs: { id: "q1" }, content: [text("When are tides high?")] },
      { type: "codeBlock", attrs: { id: "c1" }, content: [text("tides()")] },
      { type: "paragraph", attrs: { id: "p1" }, content: [text("Spring   waters")] },
      {
        type: "answer",
        attrs: { id: "a1", questionId: "q1", status: "streaming" },
        content: [{ type: "paragraph", attrs: { id: "p2" }, content: [text("Being written")] }],
      },
    ]);
    const select = (from: string, to: string) =>
      selectionForEdit(note.state, { from: note.after(from) - from.length, to: note.after(to) });

    expect(select("When", "high")).toBeNull();
    expect(select("tides(", ")")).toBeNull();
    expect(
      selectionForEdit(note.state, { from: note.after("Spring"), to: note.after("Spring  ") }),
    ).toBeNull();
    expect(select("Being", "written")).toBeNull();
    expect(select("Spring", "waters")).toMatchObject({ text: "Spring   waters" });
  });
});
