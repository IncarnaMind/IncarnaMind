import { type Editor, getSchema, type JSONContent } from "@tiptap/core";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CITATION_NODE,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
} from "../../src/core/api";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { checkOpinion, opinionChecks } from "../../src/renderer/src/editor/opinionChecks";
import {
  opinionLocations,
  opinionSentenceRanges,
  opinionsIn,
} from "../../src/renderer/src/editor/opinionLocations";
import { writeOpinionSentences } from "../../src/shared/opinions";

const actions = vi.hoisted(() => ({
  checkSentences: vi.fn(async () => undefined),
  setCheckCardOpen: vi.fn(),
  setClaimFocus: vi.fn(),
  setOpenClaim: vi.fn(),
  useChecks: { getState: () => ({ running: {} }) },
}));
vi.mock("../../src/renderer/src/checks", () => actions);
beforeEach(() => vi.clearAllMocks());

const schema = getSchema(noteExtensions());
const part = (
  start: number,
  end: number,
  kind: ClaimCheckPart["kind"] = "opinion",
): ClaimCheckPart => ({
  span: { start, end },
  kind,
  verdict: kind === "opinion" ? null : "supported",
  evidence:
    kind === "opinion"
      ? []
      : [
          {
            passageId: "passage",
            documentId: "results",
            documentName: "Results",
            contentHash: "v1",
            quote: "Revenue rose 8%.",
            pageFrom: 1,
            pageTo: 1,
            location: null,
            check: "found",
            checkReason: null,
          },
        ],
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});
const paragraph = (id: string, text: string, check?: ClaimCheckAttributes): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [
    { type: "text", text, ...(check && { marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] }) },
  ],
});
const note = (...content: JSONContent[]) => schema.nodeFromJSON({ type: "doc", content });
const inventory = (text: string, blockId = "p", occurrence = 0, id = "opinion") => {
  const doc = new Y.Doc();
  writeOpinionSentences(doc, [{ id, text, blockId, occurrence, parts: [part(0, text.length)] }]);
  return doc;
};

function editorWith(content: ReturnType<typeof note>): Editor {
  let state = EditorState.create({ doc: content });
  return {
    isDestroyed: false,
    get state() {
      return state;
    },
    view: {
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
      },
    },
  } as unknown as Editor;
}

describe("Check anyway after its menu opened", () => {
  test.each(["We think this is good.", "我们认为这很好。"])(
    "keeps the same target when another Citation's quoted text is edited: %s",
    (text) => {
      const stored = inventory(text);
      const quote = { passageId: "citation", documentId: "source", quote: "Context." };
      const introduction: JSONContent = {
        type: "paragraph",
        attrs: { id: "intro" },
        content: [
          { type: "text", text: "Context." },
          { type: CITATION_NODE, attrs: quote },
        ],
      };
      const editor = editorWith(note(introduction, paragraph("p", text)));
      const captured = opinionChecks(editor, stored)[0];
      if (!captured) throw new Error("No omitted opinion.");
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(1 + "Context.".length, undefined, {
          ...quote,
          quote: "Updated context.",
        }),
      );
      checkOpinion(editor, "mind", stored, captured, "place");
      expect(
        editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to),
      ).toBe(text);
      expect(actions.checkSentences).toHaveBeenCalledOnce();
      expect(editor.state.doc.firstChild?.child(1).attrs.quote).toBe("Updated context.");
    },
  );

  test.each(["We think this is good.", "我们认为这很好。"])(
    "finds the current opinion after text or an inline Citation moves it: %s",
    (text) => {
      for (const change of ["text", "citation"] as const) {
        actions.checkSentences.mockClear();
        const stored = inventory(text);
        const editor = editorWith(note(paragraph("intro", "A statement."), paragraph("p", text)));
        const captured = opinionChecks(editor, stored)[0];
        if (!captured) throw new Error("No omitted opinion.");
        if (change === "text") {
          editor.view.dispatch(editor.state.tr.insertText("Another sentence. ", 1));
        } else {
          editor.view.dispatch(
            editor.state.tr.insert(
              2,
              schema.nodeFromJSON({
                type: CITATION_NODE,
                attrs: { passageId: "citation", documentId: "source", quote: "A statement." },
              }),
            ),
          );
        }
        const current = opinionChecks(editor, stored)[0];
        expect(current?.range.from).toBeGreaterThan(captured.range.from);
        checkOpinion(editor, "mind", stored, captured, "place");
        expect(
          editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to),
        ).toBe(text);
        expect(actions.checkSentences).toHaveBeenLastCalledWith(
          editor,
          "mind",
          stored,
          "check-against-documents",
          { ranges: [current?.range], part: { id: captured.id, span: captured.span } },
        );
      }
    },
  );

  test.each(["We think this is good.", "我们认为这很好。"])(
    "aborts when the chosen opinion was edited or removed: %s",
    (text) => {
      for (const change of ["edited", "removed"] as const) {
        const stored = inventory(text);
        const editor = editorWith(note(paragraph("p", text)));
        const captured = opinionChecks(editor, stored)[0];
        if (!captured) throw new Error("No omitted opinion.");
        editor.view.dispatch(
          change === "edited"
            ? editor.state.tr.insertText("New.", captured.range.from, captured.range.to)
            : editor.state.tr.replaceWith(
                0,
                editor.state.doc.content.size,
                schema.nodeFromJSON(paragraph("other", "Gone.")),
              ),
        );
        const before = editor.state.selection;
        expect(() => checkOpinion(editor, "mind", stored, captured, "place")).not.toThrow();
        expect(editor.state.selection).toBe(before);
        expect(actions.checkSentences).not.toHaveBeenCalled();
        expect(actions.setOpenClaim).not.toHaveBeenCalled();
      }
    },
  );

  test.each([
    ["We think this is good.", "We think this is poor."],
    ["我们认为这很好。", "我们认为这很差。"],
  ])(
    "does not reuse an old action for different words with the same id and span: %s",
    (text, changed) => {
      const stored = inventory(text);
      const editor = editorWith(note(paragraph("p", text)));
      const captured = opinionChecks(editor, stored)[0];
      if (!captured) throw new Error("No omitted opinion.");
      editor.view.dispatch(
        editor.state.tr.insertText(changed, captured.range.from, captured.range.to),
      );
      writeOpinionSentences(stored, [
        {
          id: captured.id,
          blockId: "p",
          text: changed,
          occurrence: 0,
          parts: [part(0, changed.length)],
        },
      ]);
      const before = editor.state.selection;
      checkOpinion(editor, "mind", stored, captured, "place");
      expect(editor.state.selection).toBe(before);
      expect(actions.checkSentences).not.toHaveBeenCalled();
    },
  );
});

describe("left-out opinions in the Note", () => {
  test.each([
    "We think the deal is risky.",
    "我们认为这笔交易风险很大。",
    "We think 🌱 is promising.",
  ])("selects the exact words after another sentence is inserted: %s", (text) => {
    const stored = inventory(text);
    const current = note(paragraph("p", `A separate statement. ${text}`));
    const [opinion] = opinionsIn(current, stored);
    expect(opinion).toBeDefined();
    expect(current.textBetween(opinion?.range.from ?? 0, opinion?.range.to ?? 0)).toBe(text);
    expect(opinion?.id).toBe("opinion");
  });

  test("uses block, exact words and occurrence rather than matching an identical sentence elsewhere", () => {
    const text = "We think the deal is risky.";
    const stored = inventory(text, "p", 1);
    const current = note(paragraph("other", text), paragraph("p", `${text} ${text}`));
    const opinions = opinionsIn(current, stored);
    expect(opinions).toHaveLength(1);
    const expected = opinionLocations(current).find(
      (each) => each.blockId === "p" && each.occurrence === 1,
    );
    expect(opinions[0]?.range).toEqual({ from: expected?.from, to: expected?.to });
    expect(opinionsIn(note(paragraph("p", text)), stored)).toEqual([]);
  });

  test("changed opinion words invalidate the old count and stop hiding a claim from health", () => {
    const text = "We think the deal is risky.";
    const stored = inventory(text);
    const before = note(paragraph("p", text));
    const health = (current: ReturnType<typeof note>) =>
      noteHealth(current, {
        claims: [],
        omitted: opinionSentenceRanges(current, stored),
        citationCheck: (citation) => citation.check,
      });
    expect(health(before).toCheck).toHaveLength(0);
    const after = note(paragraph("p", "We think the deal is safe."));
    expect(opinionsIn(after, stored)).toEqual([]);
    expect(health(after).toCheck).toHaveLength(1);
  });

  test("one mixed opinion counts once and remains separate from the sentence verdict", () => {
    const text = "Revenue rose 8%; we think the deal is risky.";
    const start = text.indexOf("we think");
    const parts = [part(0, start, "fact"), part(start, text.length)];
    const check: ClaimCheckAttributes = {
      id: "mixed",
      request: "r",
      action: "check-against-documents",
      state: "supported",
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
      text,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-10-28T20:00:00.000Z",
      parts,
    };
    const current = note(paragraph("p", text, check));
    const stored = new Y.Doc();
    const opinions = opinionsIn(current, stored);
    expect(opinions).toHaveLength(1);
    expect(current.textBetween(opinions[0]?.range.from ?? 0, opinions[0]?.range.to ?? 0)).toBe(
      "we think the deal is risky.",
    );
    expect(opinionSentenceRanges(current, stored)).toEqual([]);
    const claims = claimsOf(current, { versions: null, folderId: null, scope: null });
    const health = noteHealth(current, {
      claims: claims.claims,
      citationCheck: (citation) => citation.check,
    });
    expect(health.supported).toBe(1);
    expect(health.toCheck).toHaveLength(0);
  });
});

describe("reading a Note's opinions as it is typed in", () => {
  // protects=each edit reads the page's opinions once for every card, line and badge that asks, and the Blocks it didn't touch are read again from where they were, so typing in a long Note stays light (#2002); fails_when=every asker walks the whole Note again on each keystroke, or a moved opinion keeps its old place; no_claim=the time a real machine takes.
  test.each(["We think this is good.", "我们认为这很好。"])(
    "an unchanged page is read once, and an edit before an opinion moves it: %s",
    (text) => {
      const stored = inventory(text);
      const page = note(paragraph("intro", "A statement."), paragraph("p", text));
      const first = opinionsIn(page, stored);
      expect(opinionsIn(page, stored)).toBe(first);
      const editor = editorWith(page);
      editor.view.dispatch(editor.state.tr.insertText("Another sentence. ", 1));
      const moved = opinionsIn(editor.state.doc, stored);
      expect(moved).not.toBe(first);
      expect(moved.map((each) => each.range.from - (first[0]?.range.from ?? 0))).toEqual([
        "Another sentence. ".length,
      ]);
      expect(
        moved.map((each) => editor.state.doc.textBetween(each.range.from, each.range.to)),
      ).toEqual([text]);
    },
  );
});
