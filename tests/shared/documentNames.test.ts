import { describe, expect, test } from "vitest";
import { documentTitle } from "../../src/core/documents/title";
import {
  displayName,
  fileNameOf,
  looksMachineMade,
  sourceOf,
  titleWithoutSite,
  whereShown,
} from "../../src/shared/documentNames";

describe("a web page's title in a citation", () => {
  test.each([
    ["Tea - The Open Encyclopedia", "Tea"],
    ["Tea | The Open Encyclopedia", "Tea"],
    ["Tea – The Open Encyclopedia", "Tea"],
    ["Tea · The Open Encyclopedia", "Tea"],
    ["Tea - the open encyclopedia", "Tea"],
    ["Green tea - history - The Open Encyclopedia", "Green tea - history"],
  ])("“%s” leaves off the site's name, which the citation gives on its own", (title, cited) => {
    expect(titleWithoutSite(title, "The Open Encyclopedia")).toBe(cited);
  });

  test.each([
    ["The Open Encyclopedia", "The Open Encyclopedia"],
    ["Tea in The Open Encyclopedia", "The Open Encyclopedia"],
    ["Tea: The Open Encyclopedia", "The Open Encyclopedia"],
    [" - The Open Encyclopedia", "The Open Encyclopedia"],
    ["Tea - The Open Encyclopedia", ""],
  ])("“%s” stays as it is, the site being “%s”", (title, site) => {
    expect(titleWithoutSite(title, site)).toBe(title);
  });
});

describe("machine-made Document names", () => {
  test.each([
    "49ed72de-a284-4da6-b515-1ddbb7c0a8f1",
    "49ED72DEA2844DA6B5151DDBB7C0A8F1",
    "3f9a1c0b7d2e4a68",
    "20261010142701",
    "2026-10-10 14.27.01",
    "Untitled",
    "untitled 2",
    "document",
    "Document (3)",
    "IMG_0042",
    "Scan 12",
    "a8f3k2m9q1x7z4c6v5b0n8l2",
    "  ",
  ])("%j is machine-made", (name) => {
    expect(looksMachineMade(name)).toBe(true);
  });

  test.each([
    "Quarterly report",
    "Reading notes",
    "37-38UpperGrosvenorStreet",
    "13Clapeyron-EL",
    "Contract 2025",
    "Tide notes v2",
    "Documentation",
    "关于潮汐的笔记",
  ])("%j is a name a person gave", (name) => {
    expect(looksMachineMade(name)).toBe(false);
  });
});

describe("the name shown for a Document", () => {
  test("a machine-made name gives way to the title; a name given never does", () => {
    expect(displayName({ name: "49ed72de-a284-4da6-b515-1ddbb7c0a8f1", title: "Rent roll" })).toBe(
      "Rent roll",
    );
    expect(displayName({ name: "Untitled", title: "Rent roll" })).toBe("Rent roll");
    expect(displayName({ name: "Quarterly report", title: "Something else" })).toBe(
      "Quarterly report",
    );
  });

  test("without a title, the name stays", () => {
    expect(displayName({ name: "Untitled", title: null })).toBe("Untitled");
    expect(displayName({ name: "Untitled" })).toBe("Untitled");
    expect(displayName({ name: "Untitled", title: "  " })).toBe("Untitled");
  });

  test("the file's name is the last part of its path", () => {
    expect(fileNameOf("/Users/me/Reports/Q3.xlsx")).toBe("Q3.xlsx");
    expect(fileNameOf("C:\\Users\\me\\Q3.xlsx")).toBe("Q3.xlsx");
  });
});

describe("where a Document comes from", () => {
  test("a file named by machine reads as the Document's name and the file's extension", () => {
    expect(
      sourceOf({
        name: "Transcript · Meeting, 19 October",
        path: "/data/Transcripts/2896a7b6-5f1e-4039-820a-55725dfb8a17.vtt",
      }),
    ).toBe("Transcript · Meeting, 19 October.vtt");
  });

  test("a Document's name that already ends in the extension keeps one of it", () => {
    expect(
      sourceOf({
        name: "Meeting.vtt",
        path: "/data/Transcripts/2896a7b6-5f1e-4039-820a-55725dfb8a17.vtt",
      }),
    ).toBe("Meeting.vtt");
    expect(
      sourceOf({
        name: "Meeting.VTT",
        path: "/data/Transcripts/2896a7b6-5f1e-4039-820a-55725dfb8a17.vtt",
      }),
    ).toBe("Meeting.VTT");
  });

  test("a file the User named keeps its own name, and a web page its address", () => {
    expect(sourceOf({ name: "Copperleaf", path: "/Users/me/DPA - Copperleaf.docx" })).toBe(
      "DPA - Copperleaf.docx",
    );
    expect(
      sourceOf({
        name: "Tea",
        path: "/data/Web/49ed72de-a284-4da6-b515-1ddbb7c0a8f1.html",
        web: { address: "https://example.org/tea" },
      }),
    ).toBe("https://example.org/tea");
  });
});

describe("a Document's own title", () => {
  test("the title in its properties comes first", () => {
    expect(documentTitle("  Rent roll  2025 ", "# Heading\nText")).toBe("Rent roll 2025");
  });

  test("a property that says nothing, or is machine-made, gives way to the first heading", () => {
    expect(documentTitle("Untitled", "Intro line\n# Real heading\nText")).toBe("Real heading");
    expect(documentTitle("", "## **Bold heading** ##\nText")).toBe("Bold heading");
  });

  test("without a heading, the first line of words", () => {
    expect(documentTitle(null, "\n\n  Minutes of the tenants' meeting\nSecond line")).toBe(
      "Minutes of the tenants' meeting",
    );
  });

  test("a long first line is cut at a word", () => {
    const title = documentTitle(null, `${"word ".repeat(40)}end`);
    expect(title?.endsWith("…")).toBe(true);
    expect(title?.length).toBeLessThanOrEqual(101);
  });

  test("nothing to take gives null", () => {
    expect(documentTitle(null, null)).toBeNull();
    expect(documentTitle(null, "   \n  ")).toBeNull();
    expect(documentTitle(null, "49ed72de-a284-4da6-b515-1ddbb7c0a8f1")).toBeNull();
  });
});

describe("Two Documents with one name show where each is (#1507)", () => {
  const doc = (
    id: string,
    path: string,
    name = path
      .split("/")
      .pop()
      ?.replace(/\.\w+$/, "") ?? "",
  ) => ({
    id,
    name,
    path,
  });

  // protects=the issue's Linked folder: two Annual-Report and two notes, one pair in 2025, one in 2026, each shown with its own year, and a Document whose name is its own shows nothing; fails_when=the two Annual-Reports read the same, or a lone name gets a place; no_claim=how a row lays it out.
  test("the nearest folder that tells them apart", () => {
    const where = whereShown([
      doc("a", "/Users/me/awkward/same-name/2025/Annual-Report.docx"),
      doc("b", "/Users/me/awkward/same-name/2025/notes.md"),
      doc("c", "/Users/me/awkward/same-name/2026/Annual-Report.docx"),
      doc("d", "/Users/me/awkward/same-name/2026/notes.md"),
      doc("e", "/Users/me/awkward/Budget.xlsx"),
    ]);
    expect(Object.fromEntries(where)).toEqual({ a: "2025", b: "2025", c: "2026", d: "2026" });
  });

  // protects=when the nearest folders match, more of the path is shown until they differ; identical paths are told apart by "(2)"; Chinese names, and names differing only in case, count as one; fails_when=two rows still read the same; no_claim=none beyond protects.
  test.each([
    [
      "more of the path",
      [doc("a", "/x/Q1/2025/Report.pdf"), doc("b", "/x/Q2/2025/Report.pdf")],
      { a: "Q1 / 2025", b: "Q2 / 2025" },
    ],
    [
      "the same path twice",
      [doc("a", "/x/2025/Report.pdf"), doc("b", "/x/2025/Report.pdf")],
      { a: "2025", b: "2025 (2)" },
    ],
    [
      "Chinese names",
      [doc("a", "/x/上海/年度报告.docx"), doc("b", "/x/北京/年度报告.docx")],
      { a: "上海", b: "北京" },
    ],
    [
      "names that differ only in case",
      [doc("a", "/x/old/notes.md"), doc("b", "/x/new/Notes.md", "Notes")],
      { a: "old", b: "new" },
    ],
  ])("%s", (_, documents, expected) => {
    expect(Object.fromEntries(whereShown(documents))).toEqual(expected);
  });
});
