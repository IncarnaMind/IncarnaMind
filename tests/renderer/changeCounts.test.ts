import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, MIND_PROPOSAL_REQUESTS_FIELD } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { proposalsIn } from "../../src/renderer/src/editor/proposalReview";
import {
  appliedWaiting,
  changedParagraphs,
  decideProposals,
  pendingProposals,
  waitingChanges,
} from "../../src/shared/proposals";

/*
 * How many changes wait and how many paragraphs changed, counted once for every surface
 * (#1335, #1358): the Mind's bar, the assistant's lines and its change card.
 */

const schema = getSchema(noteExtensions());
const REQUEST = "r1";
let next = 0;
const id = () => `c${++next}`;

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks && { marks }),
});

const whole = (kind: "insert" | "delete", request = REQUEST) => ({
  id: id(),
  request,
  kind,
});

/** A paragraph the Mind had and nothing touches. */
const plain = (words: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: id() },
  content: [text(words)],
});

/** A paragraph whose words change where they stand: the old ones struck, the new ones added. */
const reworded = (old: string, now: string, request = REQUEST): JSONContent => {
  const ref = { id: id(), request };
  return {
    type: "paragraph",
    attrs: { id: id() },
    content: [
      text(old, [{ type: "proposalDelete", attrs: ref }]),
      text(now, [{ type: "proposalInsert", attrs: ref }]),
    ],
  };
};

const added = (words: string, request = REQUEST): JSONContent => ({
  type: "paragraph",
  attrs: { id: id(), proposal: whole("insert", request) },
  content: [text(words)],
});

const removed = (words: string, request = REQUEST): JSONContent => ({
  type: "paragraph",
  attrs: { id: id(), proposal: whole("delete", request) },
  content: [text(words)],
});

const title = (words: string, proposal?: JSONContent["attrs"]): JSONContent => ({
  type: "heading",
  attrs: { id: id(), level: 2, ...(proposal && { proposal }) },
  content: [text(words)],
});

const bullets = (items: readonly string[], request = REQUEST): JSONContent => ({
  type: "bulletList",
  attrs: { proposal: whole("insert", request) },
  content: items.map((item) => ({
    type: "listItem",
    content: [{ type: "paragraph", attrs: { id: id() }, content: [text(item)] }],
  })),
});

const cell = (content: JSONContent): JSONContent => ({ type: "tableCell", content: [content] });

const table = (cells: JSONContent[], proposal?: JSONContent["attrs"]): JSONContent => ({
  type: "table",
  ...(proposal && { attrs: { proposal } }),
  content: [{ type: "tableRow", content: cells.map(cell) }],
});

function mind(content: JSONContent[]) {
  const doc = new Y.Doc();
  const blocks = prosemirrorToYXmlFragment(
    schema.nodeFromJSON({ type: "doc", content }),
    doc.getXmlFragment(MIND_CONTENT_FIELD),
  );
  return { doc, blocks };
}

const ours = (ref: { request: string }) => ref.request === REQUEST;
const paragraphsIn = (content: JSONContent[]) => changedParagraphs(mind(content).blocks, ours);

/** The Mind's bar counts in the editor's document what the assistant's lines count in the core's. */
function parity(content: JSONContent[]): number {
  const waiting = waitingChanges(mind(content).blocks);
  expect(proposalsIn(schema.nodeFromJSON({ type: "doc", content })).length).toBe(waiting);
  return waiting;
}

const numbered = <T>(count: number, make: (n: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index + 1));

describe("Paragraphs changed, each counted once (#1335)", () => {
  // protects=rewriting every one of 10 paragraphs is 10 changed paragraphs and 10 changes waiting, in English and Chinese, and the Mind's bar counts the changes as the assistant's lines do; fails_when=a surface counts more or fewer; no_claim=the wording of the lines.
  test.each([
    ["English", (n: number) => `Paragraph ${n} says the quarter was solid.`],
    ["Chinese", (n: number) => `第 ${n} 段说这个季度的业绩不错，团队按期完成了任务。`],
  ])("rewriting every one of 10 paragraphs, in %s, is 10 changed and 10 waiting", (_, say) => {
    const page = numbered(10, say).map((old, index) => reworded(old, `${old} ${index + 1}.`));

    expect(paragraphsIn(page)).toBe(10);
    expect(parity(page)).toBe(10);
  });

  // protects=a paragraph written anew in place of the old one, the old Block removed and the new one added, is one changed paragraph, side by side or in two rows, while every one of them is a change to accept; fails_when=the count adds the removed to the added (20 for 10); no_claim=how the model wrote it.
  test("a paragraph written anew in place of the old one is one, not two", () => {
    const beside = numbered(10, (n) => [removed(`Old ${n}.`), added(`New ${n}.`)]).flat();
    const apart = [
      ...numbered(10, (n) => removed(`Old ${n}.`)),
      ...numbered(10, (n) => added(`New ${n}.`)),
    ];

    expect(paragraphsIn(beside)).toBe(10);
    expect(paragraphsIn(apart)).toBe(10);
    expect(parity(beside)).toBe(20);
  });

  test("one paragraph written anew as 10 is 10: the one it replaced and 9 added", () => {
    const page = [removed("The summary."), ...numbered(10, (n) => added(`Summary ${n}.`))];

    expect(paragraphsIn(page)).toBe(10);
  });

  test("3 new paragraphs are 3, and 2 deleted are 2", () => {
    expect(paragraphsIn([plain("Kept."), added("One."), added("Two."), added("Three.")])).toBe(3);
    expect(paragraphsIn([removed("One."), plain("Kept."), removed("Two.")])).toBe(2);
  });

  // protects=adding 2 paragraphs and changing 3 is 5, as the issue says; fails_when=it reads 4 or 8; no_claim=none beyond protects.
  test("adding 2 paragraphs and changing 3 is 5, whether the 3 are reworded or written anew", () => {
    const reworded3 = [
      reworded("A.", "A, longer."),
      reworded("B.", "B, longer."),
      reworded("C.", "C, longer."),
      plain("Kept."),
      added("New one."),
      added("New two."),
    ];
    const anew3 = [
      removed("A."),
      added("A again."),
      removed("B."),
      added("B again."),
      removed("C."),
      added("C again."),
      added("New one."),
      added("New two."),
    ];

    expect(paragraphsIn(reworded3)).toBe(5);
    expect(paragraphsIn(anew3)).toBe(5);
  });

  test("a paragraph removed in one place and one added in another are two", () => {
    expect(paragraphsIn([removed("Moved."), plain("Between."), added("Moved.")])).toBe(2);
  });

  test("paragraphs of another request, and the Mind's own, are not counted", () => {
    const page = [plain("Mine."), reworded("A.", "B.", "other"), added("Theirs.", "other")];

    expect(paragraphsIn(page)).toBe(0);
    expect(changedParagraphs(mind(page).blocks, (ref) => ref.request === "other")).toBe(2);
    expect(waitingChanges(mind(page).blocks, (ref) => ref.request === "other")).toBe(2);
    expect(waitingChanges(mind(page).blocks, (ref) => ref.request === REQUEST)).toBe(0);
  });

  test("an empty Mind has no change", () => {
    expect(paragraphsIn([])).toBe(0);
    expect(waitingChanges(mind([]).blocks)).toBe(0);
  });

  test("a page of 500 paragraphs is counted whole: 500 reworded, or 250 written anew", () => {
    const reworded500 = numbered(500, (n) => `Paragraph ${n}.`).map((old) =>
      reworded(old, `${old} More.`),
    );
    const anew250 = numbered(250, (n) => `Paragraph ${n}.`).flatMap((old) => [
      removed(old),
      added(`${old} More.`),
      plain("Kept between them."),
    ]);

    expect(paragraphsIn(reworded500)).toBe(500);
    expect(paragraphsIn(anew250)).toBe(250);
  });
});

describe("A heading is a section's title, not a paragraph written", () => {
  test("a section added with its heading is its paragraphs, as 'Wrote 3 paragraphs' counts it", () => {
    const section = [
      title("Risks", whole("insert")),
      added("One."),
      added("Two."),
      added("Three."),
    ];

    expect(paragraphsIn(section)).toBe(3);
  });

  test("a heading and a list added are 2 changes to accept and 3 paragraphs", () => {
    const memo = [title("Processor obligations", whole("insert")), bullets(["A.", "B.", "C."])];

    expect(parity(memo)).toBe(2);
    expect(paragraphsIn(memo)).toBe(3);
  });

  test("a heading added or removed on its own, or written anew, is one", () => {
    expect(paragraphsIn([title("Risks", whole("insert"))])).toBe(1);
    expect(paragraphsIn([title("Risks", whole("delete"))])).toBe(1);
    expect(paragraphsIn([title("Risks", whole("delete")), title("Hazards", whole("insert"))])).toBe(
      1,
    );
  });

  test("a heading whose words change is one", () => {
    const ref = { id: id(), request: REQUEST };
    const heading: JSONContent = {
      type: "heading",
      attrs: { id: id(), level: 2 },
      content: [
        text("Risks", [{ type: "proposalDelete", attrs: ref }]),
        text("Hazards", [{ type: "proposalInsert", attrs: ref }]),
      ],
    };

    expect(paragraphsIn([heading, plain("Kept.")])).toBe(1);
  });
});

describe("Tables count as tables, and a cell's words as a paragraph", () => {
  test("a table added whole is no paragraph, and a table around it doesn't break a run", () => {
    const page = [added("Before."), table([plain("Cell.")], whole("insert")), added("After.")];

    expect(paragraphsIn([table([plain("A"), plain("B")], whole("insert"))])).toBe(0);
    expect(paragraphsIn(page)).toBe(2);
  });

  test("words changed in a cell are one paragraph", () => {
    const page = [table([plain("Kept."), reworded("Old.", "New.")]), plain("Kept.")];

    expect(paragraphsIn(page)).toBe(1);
    expect(parity(page)).toBe(1);
  });
});

// protects=accepting one, rejecting one and Undo move the changes waiting and the paragraphs changed together; fails_when=a count stays or jumps; no_claim=the lines that show them.
describe("Accepting, rejecting and undoing one change moves every count together", () => {
  function reviewed() {
    const page = [
      reworded("First.", "First, longer."),
      reworded("Second.", "Second, longer."),
      plain("Kept."),
      removed("Old third."),
      added("New third."),
    ];
    return mind(page);
  }
  const first = (blocks: Y.XmlFragment) => {
    const [ref] = pendingProposals(blocks);
    if (!ref) throw new Error("No change waits.");
    return ref.id;
  };

  test.each(["accept", "reject"] as const)(
    "%s one lowers the changes waiting by one",
    (outcome) => {
      const { doc, blocks } = reviewed();
      expect(waitingChanges(blocks)).toBe(4);
      expect(changedParagraphs(blocks, ours)).toBe(3);
      const one = first(blocks);

      doc.transact(() => decideProposals(blocks, (ref) => ref.id === one, outcome));

      expect(waitingChanges(blocks)).toBe(3);
      expect(changedParagraphs(blocks, ours)).toBe(2);
    },
  );

  test("Undo brings back the change, and both counts with it", () => {
    const { doc, blocks } = reviewed();
    const steps = new Y.UndoManager([blocks, doc.getMap(MIND_PROPOSAL_REQUESTS_FIELD)], {
      trackedOrigins: new Set(["user"]),
    });
    const one = first(blocks);

    doc.transact(() => decideProposals(blocks, (ref) => ref.id === one, "accept"), "user");
    expect(waitingChanges(blocks)).toBe(3);
    steps.undo();

    expect(waitingChanges(blocks)).toBe(4);
    expect(changedParagraphs(blocks, ours)).toBe(3);
  });

  test("accepting only the removal of a pair leaves the new paragraph as the one change", () => {
    const { doc, blocks } = mind([removed("Old."), added("New.")]);
    const removal = first(blocks);

    doc.transact(() => decideProposals(blocks, (ref) => ref.id === removal, "accept"));

    expect(waitingChanges(blocks)).toBe(1);
    expect(changedParagraphs(blocks, ours)).toBe(1);
  });
});

describe("The count an applied row draws (#1358)", () => {
  test("counts what the apply left waiting, and settles once the Mind's copy has it", () => {
    // The Mind's copy still lists the 2 the apply took with the 1 it left: 1 waits, but not yet settled.
    expect(appliedWaiting(["taken-1", "taken-2", "left"], ["taken-1", "taken-2"])).toEqual({
      count: 1,
      settled: false,
    });
    // The copy has the apply: the same 1 waits, now drawn.
    expect(appliedWaiting(["left"], ["taken-1", "taken-2"])).toEqual({ count: 1, settled: true });
    // Nothing is left: no count.
    expect(appliedWaiting(["taken-1", "taken-2"], ["taken-1", "taken-2"])).toEqual({
      count: 0,
      settled: false,
    });
    expect(appliedWaiting([], ["taken-1", "taken-2"])).toEqual({ count: 0, settled: true });
    // No apply recorded: every waiting change counts, as the held line says.
    expect(appliedWaiting(["waiting"], undefined)).toEqual({ count: 1, settled: true });
  });
});
