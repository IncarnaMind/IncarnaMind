import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_SIGN_OFFS_FIELD } from "../../src/core/api";
import { INLINE_NODE } from "../../src/shared/sentences";
import {
  addSignOff,
  citationSignOffBasis,
  figureSignOffBasis,
  figureSignOffs,
  isMine,
  readSignOff,
  removeSignOff,
  type SignOffRecord,
  signOffShown,
  signOffsOf,
} from "../../src/shared/signOffs";

const record = (overrides: Partial<SignOffRecord> = {}): SignOffRecord => ({
  id: crypto.randomUUID(),
  target: { kind: "citation", id: "c1" },
  at: "2026-10-28T09:00:00.000Z",
  contentHash: "basis",
  deletedAt: null,
  name: "Ada Lovelace",
  personId: "p1",
  ...overrides,
});

const textFigure = (block: string, sentence: string, from: number, chars: string) =>
  JSON.stringify(["text", block, sentence, from, from + chars.length, chars]);

describe("The User's own check marks", () => {
  // protects=taking a mark off keeps it with the time it was taken off, so the record is never lost (D280, #1933); fails_when=the record is deleted or still stands; no_claim=how the card shows it.
  test("a mark taken off is kept with when, and no longer stands", () => {
    const doc = new Y.Doc();
    const mark = record();
    addSignOff(doc, mark);
    expect(signOffsOf(doc)).toEqual([mark]);

    removeSignOff(doc, mark.target, "2026-10-28T10:00:00.000Z", "p1");

    expect(signOffsOf(doc)).toEqual([]);
    expect(doc.getMap(MIND_SIGN_OFFS_FIELD).get(mark.id)).toMatchObject({
      deletedAt: "2026-10-28T10:00:00.000Z",
    });
  });

  // protects=each person takes off only their own mark, so the User's Undo or toggle never removes a colleague's once Notes are shared (D280); fails_when=another person's mark is taken off with the User's; no_claim=sharing itself.
  test("taking a mark off leaves another person's on the same item", () => {
    const doc = new Y.Doc();
    const mine = record({ personId: "p1" });
    const theirs = record({ personId: "p2", name: "Grace Hopper" });
    addSignOff(doc, mine);
    addSignOff(doc, theirs);

    removeSignOff(doc, mine.target, "2026-10-28T10:00:00.000Z", "p1");

    expect(signOffsOf(doc)).toEqual([theirs]);
  });

  // protects=a record another version or a broken sync wrote is skipped rather than shown as a mark; fails_when=a malformed record reads as one; no_claim=none beyond protects.
  test.each([
    ["no id", { id: "" }],
    ["an unknown kind", { target: { kind: "sentence", id: "s" } }],
    ["no basis", { contentHash: 3 }],
    ["a bad removal time", { deletedAt: 5 }],
  ])("a record with %s isn't read", (_, broken) => {
    expect(readSignOff({ ...record(), ...broken })).toBeNull();
  });

  // protects=a Citation's mark shows as changed once its sentence's words, its quote or its Document's version change, and stays checked through spacing and its own marker (D280); fails_when=an edit leaves it checked, or a re-render of the same words shows it changed; no_claim=the card's words.
  test("a Citation's mark is checked until its words, quote or version change", () => {
    const cited = { documentId: "d1", contentHash: "v1", quote: "Revenue rose 5%." };
    const sentence = `Revenue rose 5% in 2025.${INLINE_NODE}`;
    const mark = record({ contentHash: citationSignOffBasis(sentence, cited) });
    const versions = new Map([["d1", "v1"]]);
    const shown = (words: string, citation = cited, now = versions) =>
      signOffShown(mark, citationSignOffBasis(words, citation), [citation], now).state;

    expect(shown("Revenue  rose 5% in 2025. ")).toBe("checked");
    expect(shown("Revenue rose 6% in 2025.")).toBe("changed");
    expect(shown(sentence, { ...cited, quote: "Revenue rose." })).toBe("changed");
    expect(shown(sentence, cited, new Map([["d1", "v2"]]))).toBe("changed");
  });

  // protects=a figure's mark follows it when an edit of its sentence gives it a new id, and shows changed there; a mark goes to one figure only, never to a figure the User didn't check (D280); fails_when=the mark vanishes after an edit, or lands on a second figure with the same words; no_claim=chart rows moving.
  test("a figure's mark stays on it after its sentence changes, and on no other figure", () => {
    const checked = textFigure("b1", "old", 13, "5%");
    const mark = record({
      target: { kind: "figure", id: checked },
      contentHash: figureSignOffBasis({ id: checked, reading: { chars: "5%" }, calculated: null }),
    });

    const edited = textFigure("b1", "new", 20, "5%");
    const other = textFigure("b2", "new", 13, "5%");
    const found = figureSignOffs([mark], [edited, other], "p1");
    expect(found.get(edited)).toBe(mark);
    expect(found.has(other)).toBe(false);
    const basisNow = figureSignOffBasis({ id: edited, reading: { chars: "5%" }, calculated: null });
    expect(signOffShown(mark, basisNow, [], null).state).toBe("changed");

    const twin = textFigure("b1", "old", 30, "5%");
    const both = figureSignOffs([mark], [checked, twin], "p1");
    expect(both.get(checked)).toBe(mark);
    expect(both.has(twin)).toBe(false);
  });

  // protects=a figure whose own value is edited in place keeps its mark as changed; a chart value keeps its row and series' mark (D280); fails_when=the mark is lost on a value edit; no_claim=a figure moved to another Block.
  test("a figure edited in place, or a chart value changed, keeps its mark as changed", () => {
    const before = textFigure("b1", "old", 13, "5%");
    const after = textFigure("b1", "new", 13, "6%");
    const mark = record({ target: { kind: "figure", id: before } });
    expect(figureSignOffs([mark], [after], "p1").get(after)).toBe(mark);

    const chart = JSON.stringify(["chart", "c1", 2, 0, "40"]);
    const changedValue = JSON.stringify(["chart", "c1", 2, 0, "41"]);
    const chartMark = record({ target: { kind: "figure", id: chart } });
    expect(figureSignOffs([chartMark], [changedValue], "p1").get(changedValue)).toBe(chartMark);
    expect(
      figureSignOffs([chartMark], [JSON.stringify(["chart", "c1", 3, 0, "40"])], "p1").size,
    ).toBe(0);
  });

  // protects=a mark made before the User had a person id, or with theirs, is theirs; another person's isn't (D280: another person's mark shows their name); fails_when=a shared Note shows someone else's mark as the User's; no_claim=sharing itself.
  test("a mark is the User's own by their person id", () => {
    expect(isMine(record({ personId: "p1" }), "p1")).toBe(true);
    expect(isMine(record({ personId: undefined }), "p1")).toBe(true);
    expect(isMine(record({ personId: "p2" }), "p1")).toBe(false);
  });
});
