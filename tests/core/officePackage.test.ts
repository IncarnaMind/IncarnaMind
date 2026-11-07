import { describe, expect, test } from "vitest";
import { ExtractionError } from "../../src/core/documents/formats/errors";
import {
  mainRootOf,
  OfficePackage,
  partOfType,
  relationshipsOf,
} from "../../src/core/documents/formats/officePackage";
import { readStyleTable } from "../../src/core/documents/formats/wordStyleTable";
import { parseXml } from "../../src/core/documents/formats/xml";
import { openPackage } from "../../src/core/documents/formats/zip";
import { buildZip } from "../helpers/zip";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const relationships = (...rels: string[]) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;

const packageOf = (entries: Record<string, string>) =>
  openPackage(buildZip(Object.entries(entries).map(([name, data]) => ({ name, data }))));

describe("A part's relationships (#2620)", () => {
  test("internal targets are part names, external ones stay as written, and one with no id or target is left out", async () => {
    const zip = packageOf({
      "word/_rels/document2.xml.rels": relationships(
        `<Relationship Id="rId1" Type="${REL}/styles" Target="styles2.xml"/>`,
        `<Relationship Id="rId2" Type="${REL}/hyperlink" Target="https://example.org/a" TargetMode="External"/>`,
        `<Relationship Type="${REL}/comments" Target="comments.xml"/>`,
        `<Relationship Id="rId4" Type="${REL}/footnotes"/>`,
      ),
    });

    const rels = await relationshipsOf(zip, "word/document2.xml");

    expect([...rels]).toEqual([
      ["rId1", { target: "word/styles2.xml", type: `${REL}/styles`, external: false }],
      ["rId2", { target: "https://example.org/a", type: `${REL}/hyperlink`, external: true }],
    ]);
    expect(partOfType(rels, "/styles", "word/styles.xml")).toBe("word/styles2.xml");
    expect(partOfType(rels, "/hyperlink", "none")).toBe("none");
    expect(partOfType(rels, "/comments", "word/comments.xml")).toBe("word/comments.xml");
  });

  test("a part with no relationships part has none; one that can't be read throws, or is kept aside to log", async () => {
    const zip = packageOf({
      "_rels/.rels": relationships(
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document2.xml"/>`,
      ),
      "word/_rels/document2.xml.rels": "<Relationships><Relationship",
      "ppt/slides/_rels/slide1.xml.rels": relationships(
        `<Relationship Id="rId1" Type="${REL}/image" Target="../media/a.png"/>`,
        `<Relationship Id="rId2" Type="${REL}/image" Target="https://example.org/b.png" TargetMode="External"/>`,
      ),
    });

    expect((await relationshipsOf(zip, "word/styles.xml")).size).toBe(0);
    await expect(relationshipsOf(zip, "word/document2.xml")).rejects.toThrow();

    const pkg = new OfficePackage(zip);
    expect(await pkg.mainPart("word/document.xml")).toBe("word/document2.xml");
    expect((await pkg.relationships("word/document2.xml")).size).toBe(0);
    expect([...(await pkg.internalRelationships("ppt/slides/slide1.xml")).values()]).toEqual([
      { target: "ppt/media/a.png", type: `${REL}/image`, external: false },
    ]);
    expect(pkg.unreadable).toEqual(["word/_rels/document2.xml.rels"]);
  });

  test("with no main-document relationship, the main part is its usual name", async () => {
    const pkg = new OfficePackage(packageOf({ "xl/workbook.xml": "<workbook/>" }));

    expect(await pkg.mainPart("xl/workbook.xml")).toBe("xl/workbook.xml");
    expect(pkg.unreadable).toEqual([]);
  });

  test("the main part's root says what the file is, not its name", () => {
    expect(mainRootOf("<p:presentation/>", "ppt/p.xml", "presentation", "Not a deck").name).toBe(
      "p:presentation",
    );
    for (const [xml, message] of [
      ["<workbook/>", "Not a deck: xl/workbook.xml is a workbook."],
      [undefined, "Not a deck: it has no xl/workbook.xml."],
    ] as const) {
      let failure: unknown;
      try {
        mainRootOf(xml, "xl/workbook.xml", "presentation", "Not a deck");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ExtractionError);
      expect(failure).toMatchObject({ reason: "unreadable", message });
    }
  });
});

const style = (type: string | null, id: string, inner = "", attributes = "") =>
  `<w:style${type ? ` w:type="${type}"` : ""} w:styleId="${id}"${attributes}>${inner}</w:style>`;
const basedOn = (id: string) => `<w:basedOn w:val="${id}"/>`;
const tableOf = (...styles: string[]) =>
  readStyleTable(
    parseXml(
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:pPrDefault><w:pPr><w:jc w:val="center"/></w:pPr></w:pPrDefault></w:docDefaults>${styles.join("")}</w:styles>`,
    ),
  );

describe("A Word file's style table (#2620)", () => {
  test("a chain starts at the style, follows what it is based on within its type, and stops at a loop", () => {
    const table = tableOf(
      style("paragraph", "Normal"),
      style("paragraph", "标题1", basedOn("Normal")),
      style("character", "标题1", basedOn("Emphasis")),
      style("character", "Emphasis"),
      style("paragraph", "A", basedOn("B")),
      style("paragraph", "B", basedOn("A")),
      style(null, "Untyped", basedOn("Normal")),
    );

    expect(table.chain("paragraph", "标题1").map((each) => each.id)).toEqual(["标题1", "Normal"]);
    expect(table.chain("character", "标题1").map((each) => each.id)).toEqual(["标题1", "Emphasis"]);
    expect(table.chain("paragraph", "A").map((each) => each.id)).toEqual(["A", "B"]);
    expect(table.chain("paragraph", "Missing")).toEqual([]);
    expect(table.chain("paragraph", null)).toEqual([]);
    expect(table.chain(null, "Untyped").map((each) => each.id)).toEqual(["Untyped"]);
    expect(table.styles.map((each) => each.id)).toEqual([
      "Normal",
      "标题1",
      "标题1",
      "Emphasis",
      "A",
      "B",
      "Untyped",
    ]);
  });

  test("a chain is followed 20 styles deep at most", () => {
    const styles = Array.from({ length: 30 }, (_, at) =>
      style("paragraph", `S${at}`, at < 29 ? basedOn(`S${at + 1}`) : ""),
    );

    expect(tableOf(...styles).chain("paragraph", "S0")).toHaveLength(20);
  });

  test("the default of a type is the last one marked, and the document defaults are kept", () => {
    const table = tableOf(
      style("paragraph", "First", "", ' w:default="1"'),
      style("paragraph", "Second", "", ' w:default="true"'),
      style("table", "Grid", "", ' w:default="1"'),
      `<w:style w:type="paragraph"><w:name w:val="no id"/></w:style>`,
    );

    expect(table.defaultOf("paragraph")).toBe("Second");
    expect(table.defaultOf("table")).toBe("Grid");
    expect(table.defaultOf("character")).toBeNull();
    expect(table.docDefaults?.name).toBe("w:docDefaults");
    expect(table.styles).toHaveLength(3);
    expect(readStyleTable(undefined).chain("paragraph", "Normal")).toEqual([]);
  });
});
