import { getSchema } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { PICTURE_NODE } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { pictureFileName, picturesAt } from "../../src/renderer/src/pictureGroups";

/*
 * The pictures the viewer steps through (#2377): an Answer's own pictures, or
 * the Note's, never both. A picture in an Answer in a Note belongs to that
 * Answer; the Note's own pictures are the Blocks at its top level.
 */

const schema = getSchema(noteExtensions());

const picture = (alt: string) =>
  schema.node(PICTURE_NODE, {
    id: `picture-${alt}`,
    src: `data:image/png;base64,${alt}`,
    alt,
    width: 200,
    height: 100,
  });

const positions = (doc: ReturnType<typeof schema.node>) => {
  const found: Record<string, number> = {};
  doc.descendants((node, pos) => {
    if (node.type.name === PICTURE_NODE) found[String(node.attrs.alt)] = pos;
  });
  return found;
};

/** A Note with two pictures of its own, around an Answer that holds two. */
const doc = schema.node("doc", null, [
  picture("Note one"),
  schema.node("answer", { id: "answer-1", questionId: "question-1", status: "done" }, [
    picture("Plot one"),
    picture("Plot two"),
  ]),
  picture("Note three"),
]);
const at = positions(doc);

describe("the pictures a picture at a position belongs to", () => {
  test("a Note's own pictures step through the Note's, never an Answer's", () => {
    expect(picturesAt(doc, at["Note one"] as number)).toMatchObject({
      kind: "note",
      index: 0,
      pictures: [{ description: "Note one" }, { description: "Note three" }],
    });
    expect(picturesAt(doc, at["Note three"] as number)).toMatchObject({ kind: "note", index: 1 });
  });

  test("a picture inside an Answer steps through that Answer's, in order", () => {
    expect(picturesAt(doc, at["Plot one"] as number)).toMatchObject({
      kind: "answer",
      index: 0,
      pictures: [{ description: "Plot one" }, { description: "Plot two" }],
    });
    expect(picturesAt(doc, at["Plot two"] as number)).toMatchObject({
      kind: "answer",
      index: 1,
    });
  });

  test("an Answer's editor holds that Answer's Blocks alone, so all its pictures are the Answer's", () => {
    const answerDoc = schema.node("doc", null, [picture("Plot one"), picture("Plot two")]);
    const inAnswer = positions(answerDoc);
    expect(picturesAt(answerDoc, inAnswer["Plot one"] as number, "answer")).toMatchObject({
      kind: "answer",
      index: 0,
      pictures: [{ description: "Plot one" }, { description: "Plot two" }],
    });
    expect(picturesAt(answerDoc, inAnswer["Plot two"] as number, "answer")).toMatchObject({
      kind: "answer",
      index: 1,
    });
  });

  test("a position that is no picture at all gives none", () => {
    const elsewhere = schema.node("doc", null, [schema.node("paragraph"), picture("Later")]);
    expect(picturesAt(elsewhere, 0)).toBeNull();
  });
});

describe("the PNG Save picture… names", () => {
  const pictureOf = {
    src: "data:image/png;base64,x",
    description: "Revenue by quarter",
    place: "figure 2",
  };
  const target = (
    group: Parameters<typeof pictureFileName>[0]["group"],
    index = 0,
    pictures = [pictureOf],
  ) => ({
    group,
    index,
    pictures,
    source: null,
  });

  test("an Answer's plot is named by its place in the Answer", () => {
    expect(pictureFileName(target({ kind: "answer" }, 1, [pictureOf, pictureOf]))).toBe(
      "Plot 2.png",
    );
  });

  test("a Note's picture is named by its description, or by its place in the Note", () => {
    expect(pictureFileName(target({ kind: "note" }))).toBe("Revenue by quarter.png");
    expect(
      pictureFileName({
        ...target({ kind: "note" }),
        pictures: [{ src: "data:image/png;base64,x", description: "", place: null }],
      }),
    ).toBe("Picture 1.png");
  });

  test("a Document's picture names its Document and place, with what a file name can't hold left out", () => {
    expect(pictureFileName(target({ kind: "document", name: "Harbour trade in 2026" }))).toBe(
      "Harbour trade in 2026 · figure 2.png",
    );
    expect(pictureFileName(target({ kind: "document", name: "Budget: Q3/Q4" }))).toBe(
      "Budget Q3 Q4 · figure 2.png",
    );
  });
});

describe("whether a picture sits in an Answer", () => {
  test("an Answer's pictures do, a Note's own don't", async () => {
    const { inAnswerAt } = await import("../../src/renderer/src/pictureGroups");
    expect(inAnswerAt(doc, at["Plot one"] as number)).toBe(true);
    expect(inAnswerAt(doc, at["Note one"] as number)).toBe(false);
  });
});
