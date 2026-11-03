import { describe, expect, test } from "vitest";
import { elements, parseXml, type XmlElement } from "../../src/core/documents/formats/xml";
import { bookmarkParagraph } from "../../src/core/exports/wordPatch/document";

const BOOKMARK = { id: 42, name: "_Toc90000007" };

/** The paragraph element of a bookmarked paragraph, parsed as Word would read it. */
function paragraphOf(xml: string): XmlElement {
  const root = parseXml(`<root>${bookmarkParagraph(xml, BOOKMARK)}</root>`);
  const paragraph = root.children.find((child): child is XmlElement => typeof child !== "string");
  if (!paragraph) throw new Error("No paragraph.");
  return paragraph;
}

const childNames = (paragraph: XmlElement) => elements(paragraph).map((each) => each.name);
const bookmarkStart = (paragraph: XmlElement) =>
  elements(paragraph).find((each) => each.name === "w:bookmarkStart");

describe("a table of contents' bookmark in a paragraph", () => {
  test("follows the paragraph's properties when a tracked change nests another pPr in them", () => {
    const paragraph = paragraphOf(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:pPrChange w:id="9" w:author="Ana"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>Scope</w:t></w:r></w:p>',
    );

    // The schema order is properties first, then the bookmark and the paragraph's content.
    expect(childNames(paragraph)).toEqual(["w:pPr", "w:bookmarkStart", "w:r", "w:bookmarkEnd"]);
    expect(bookmarkStart(paragraph)?.attrs["w:name"]).toBe(BOOKMARK.name);
    expect(bookmarkStart(paragraph)?.attrs["w:id"]).toBe(String(BOOKMARK.id));
    const properties = elements(paragraph).find((each) => each.name === "w:pPr");
    expect(properties && elements(properties).map((each) => each.name)).toContain("w:pPrChange");
  });

  test("is the paragraph's first content when it has no properties", () => {
    const paragraph = paragraphOf("<w:p><w:r><w:t>Bare</w:t></w:r></w:p>");
    expect(childNames(paragraph)).toEqual(["w:bookmarkStart", "w:r", "w:bookmarkEnd"]);
  });

  test("follows properties that close themselves, at the paragraph and inside a tracked change", () => {
    const bare = paragraphOf("<w:p><w:pPr/><w:r><w:t>Bare</w:t></w:r></w:p>");
    expect(childNames(bare)).toEqual(["w:pPr", "w:bookmarkStart", "w:r", "w:bookmarkEnd"]);

    const tracked = paragraphOf(
      '<w:p><w:pPr><w:rPr><w:b/></w:rPr><w:pPrChange w:id="9"><w:pPr/></w:pPrChange></w:pPr><w:r><w:t>Scope</w:t></w:r></w:p>',
    );
    expect(childNames(tracked)).toEqual(["w:pPr", "w:bookmarkStart", "w:r", "w:bookmarkEnd"]);
    const properties = elements(tracked).find((each) => each.name === "w:pPr");
    expect(properties && elements(properties).map((each) => each.name)).toEqual([
      "w:rPr",
      "w:pPrChange",
    ]);
  });

  test("follows properties that hold run marks, which stay inside them", () => {
    const paragraph = paragraphOf(
      '<w:p><w:pPr w:rsidR="00AB12"><w:rPr><w:b/><w:i/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Terms</w:t></w:r></w:p>',
    );
    expect(childNames(paragraph)).toEqual(["w:pPr", "w:bookmarkStart", "w:r", "w:bookmarkEnd"]);
    const properties = elements(paragraph).find((each) => each.name === "w:pPr");
    const marks = properties && elements(properties).find((each) => each.name === "w:rPr");
    expect(marks && elements(marks).map((each) => each.name)).toEqual(["w:b", "w:i"]);
  });
});
