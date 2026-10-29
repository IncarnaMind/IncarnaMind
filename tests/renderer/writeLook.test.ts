import { getSchema } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { NoteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { firstBlockOf, lookPlaces } from "../../src/renderer/src/editor/writeLook";

/*
 * The count on a write's line (#1635) is the badge's own count of claims that need a look
 * (`noteHealth`'s `lookClaims`), only those in the write's Blocks.
 */

const schema = getSchema(noteExtensions());
const paragraph = (id: string, text: string) => schema.node("paragraph", { id }, schema.text(text));
const doc = schema.node("doc", null, [
  paragraph("mine", "The User's own line."),
  paragraph("w1", "The first line written."),
  paragraph("w2", "The second line written."),
]);
/** Where each paragraph's text starts. */
const at = (index: number) => {
  let pos = 0;
  for (let each = 0; each < index; each++) pos += doc.child(each).nodeSize;
  return pos + 1;
};

const health = (lookClaims: number[]): NoteHealth => ({
  found: [],
  notFound: [],
  lookClaims,
  lookNotFound: [],
  unsupported: [],
  contradicted: [],
  toCheck: [],
  failed: [],
  recheck: [],
  checking: [],
  kept: [],
  tableCells: [],
  noCitation: [],
  checkable: lookClaims.length,
  supported: 0,
  checkedAt: null,
  unexamined: [],
});

describe("What of a write needs a look (#1635)", () => {
  // protects=the line counts the badge's claims that need a look in the write's Blocks only, in page order, and none once they are gone; fails_when=a claim elsewhere in the Note is counted, or one in the write is missed; no_claim=how a claim comes to need a look, which `noteHealth` decides.
  test("only the write's Blocks count, in page order", () => {
    expect(lookPlaces(doc, health([at(2), at(0), at(1)]), ["w1", "w2"])).toEqual([at(1), at(2)]);
    expect(lookPlaces(doc, health([at(0)]), ["w1", "w2"])).toEqual([]);
    expect(lookPlaces(doc, health([at(1)]), ["gone"])).toEqual([]);
  });

  // protects=with none left, the count goes to the write's first Block still there; fails_when=it goes nowhere, or to a Block of the User's; no_claim=none beyond protects.
  test("the write's first Block still there", () => {
    expect(firstBlockOf(doc, ["gone", "w2", "w1"])).toBe(at(1));
    expect(firstBlockOf(doc, ["gone"])).toBeNull();
  });
});
