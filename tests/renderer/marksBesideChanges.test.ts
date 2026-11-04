import { getSchema } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const schema = getSchema(noteExtensions());
const CHANGES = ["proposalDelete", "proposalInsert"];
const others = Object.keys(schema.marks).filter((name) => !CHANGES.includes(name));

const paragraphOf = (...marks: string[]) =>
  schema.node("doc", null, [
    schema.node("paragraph", null, [
      schema.text(
        "npm test",
        marks.map((name) => schema.mark(name, { id: "p1", request: "r1" })),
      ),
    ]),
  ]);

describe("Marks beside a change (#2362)", () => {
  // protects=words with any mark the Note has, inline code included, can be struck or added by a Proposal and the Note still reads; fails_when=a mark, old or new, excludes proposalDelete or proposalInsert, so a rewrite of those words breaks the Note; no_claim=how each mark is drawn.
  test.each(others)("%s beside a change", (name) => {
    for (const change of CHANGES) {
      const doc = paragraphOf(name, change);
      expect(() => doc.check()).not.toThrow();
      expect(doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name).sort()).toEqual(
        [name, change].sort(),
      );
    }
  });

  // protects=inline code still holds no other look, AI text or check, and a new mark is decided for it; fails_when=code can be bold, a link or AI text, or a mark is added that code neither excludes nor is listed here; no_claim=none beyond protects.
  test("inline code holds no other mark but a change's", () => {
    const code = schema.marks.code;
    expect(others.filter((name) => !code?.excludes(schema.marks[name] ?? code))).toEqual([]);
    expect(CHANGES.filter((name) => code?.excludes(schema.marks[name] ?? code))).toEqual([]);
  });

  // protects=code is stored in the Mind's Yjs document under its own name, as before, so Notes written before keep their code; fails_when=code is stored as an overlapping mark with a suffix; no_claim=none beyond protects.
  test("code is stored under its own name", () => {
    const fragment = new Y.Doc().getXmlFragment("content");
    prosemirrorToYXmlFragment(paragraphOf("code", "proposalDelete"), fragment);
    expect(fragment.toString()).toMatch(/^<paragraph><code><proposalDelete [^>]*>npm test</);
  });
});
