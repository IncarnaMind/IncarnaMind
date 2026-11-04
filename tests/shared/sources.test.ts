import { describe, expect, test } from "vitest";
import { sourceEntry, sourcesOf, sourceText } from "../../src/shared/sources";

const WEB = {
  address: "https://encyclopedia.example/tea",
  origin: "user" as const,
  siteName: "The Open Encyclopedia",
  author: null,
  published: null,
  fetchedAt: "2026-10-08T09:00:00.000Z",
  versions: [
    { contentHash: "old", fetchedAt: "2026-10-06T09:00:00.000Z" },
    { contentHash: "new", fetchedAt: "2026-10-08T09:00:00.000Z" },
  ],
  picturesLeftOut: 0,
  look: null,
};

const documents = [
  { id: "tides", contentHash: "h1" },
  { id: "tea", contentHash: "new", web: WEB },
];

const en = { language: "en" as const, documents };
const zh = { language: "zh-CN" as const, documents };

const tides = (pageFrom: number, pageTo = pageFrom) => ({
  documentId: "tides",
  documentName: "Tides",
  contentHash: "h1",
  pageFrom,
  pageTo,
});

const tea = (contentHash: string, paragraph = 3) => ({
  documentId: "tea",
  documentName: "Tea - The Open Encyclopedia",
  contentHash,
  location: {
    kind: "section" as const,
    heading: "History",
    paragraphs: { from: paragraph, to: paragraph },
  },
});

describe("a Citation's source", () => {
  test("names the Document and the Location", () => {
    expect(sourceText(tides(14), en).text).toBe("Tides, p. 14");
    expect(sourceText({ ...tides(14), pageFrom: undefined }, en).text).toBe("Tides");
  });

  test("a web page also names its site, address and the day the quoted version was fetched", () => {
    const { text, link } = sourceText(tea("old"), en);
    expect(text.replace(" ", " ")).toBe(
      "Tea, The Open Encyclopedia, § History, ¶ 3, https://encyclopedia.example/tea, accessed 6 October 2026",
    );
    expect(link).toBe(WEB.address);
  });

  test("a web page's version is read by its content hash: two versions, two days", () => {
    expect(sourceText(tea("new"), en).text).toContain("accessed 8 October 2026");
    expect(sourceText(tea("old"), en).text).toContain("accessed 6 October 2026");
  });

  test("a version that isn't kept gives no accessed day", () => {
    expect(sourceText(tea("gone"), en).text).not.toContain("accessed");
  });

  test("a deleted web page is named as it was cited", () => {
    const { text, link } = sourceText(tea("old"), { language: "en", documents: [] });
    expect(text).toBe("Tea - The Open Encyclopedia, § History, ¶ 3");
    expect(link).toBeNull();
  });

  test("a snapshot of a Mind is named Your note, with its title and date", () => {
    const note = {
      documentId: "note",
      documentName: "Field visit",
      contentHash: "n1",
      pageFrom: 1,
      pageTo: 1,
      yourNoteAt: `${new Date().getFullYear()}-10-12T09:00:00.000Z`,
    };
    expect(sourceText(note, { language: "en", documents: [] }).text).toMatch(
      /^Your note: Field visit, 12 Oct, p\. 1$/,
    );
    const zhText = sourceText(note, { language: "zh-CN", documents: [] }).text;
    expect(zhText.startsWith("你的笔记：Field visit，10月12日")).toBe(true);
  });

  test("is in the interface language", () => {
    expect(sourceText(tides(14), zh).text).toBe("Tides，第 14 页");
    expect(sourceText(tea("old"), zh).text).toContain("，访问于 2026年10月6日");
  });
});

describe("the sources of a Mind's Citations", () => {
  test("each Document is listed once, with the Locations cited", () => {
    const sources = sourcesOf([tides(14), tea("new"), tides(22), tides(14)], en);
    expect(sources.map((source) => [source.name, source.locations])).toEqual([
      ["Tea - The Open Encyclopedia", ["§ History, ¶ 3"]],
      ["Tides", ["p. 14", "p. 22"]],
    ]);
  });

  test("a web page cited in two versions is one entry with both days", () => {
    const [source] = sourcesOf([tea("old"), tea("new", 5)], en);
    expect(source?.locations).toHaveLength(2);
    expect(source?.web?.accessed).toEqual(["6 October 2026", "8 October 2026"]);
    expect(sourceEntry(source as NonNullable<typeof source>, en.language)).toContain(
      "accessed 6 October 2026; 8 October 2026",
    );
  });

  test("an entry names the Document, then where it is cited", () => {
    const [source] = sourcesOf([tides(14), tides(22)], en);
    expect(sourceEntry(source as NonNullable<typeof source>, "en")).toBe(
      "Tides. Cited: p. 14; p. 22",
    );
    const [chinese] = sourcesOf([tides(14), tides(22)], zh);
    expect(sourceEntry(chinese as NonNullable<typeof chinese>, "zh-CN")).toBe(
      "Tides。引用位置：第 14 页；第 22 页",
    );
  });

  test("a Document deleted since is listed by the name it was cited with", () => {
    const sources = sourcesOf(
      [
        tides(14),
        { ...tides(3), documentId: "gone", documentName: "Old notes", contentHash: "lost" },
      ],
      en,
    );
    expect(sources.map((source) => [source.name, source.documentId])).toEqual([
      ["Old notes", null],
      ["Tides", "tides"],
    ]);
  });
});

describe("the name a Citation's source shows", () => {
  const renamed = { ...en, documents: [{ id: "tides", contentHash: "h1", name: "Tide tables" }] };

  test("is the Document's current name while it is there, in a footnote and in the sources", () => {
    expect(sourceText(tides(14), renamed).text).toBe("Tide tables, p. 14");
    expect(sourceText(tides(14), { ...zh, documents: renamed.documents }).text).toBe(
      "Tide tables，第 14 页",
    );
    const sources = sourcesOf([tides(14), tides(22)], renamed);
    expect(sources.map((source) => [source.name, source.documentId])).toEqual([
      ["Tide tables", "tides"],
    ]);
    expect(sourceEntry(sources[0] as NonNullable<(typeof sources)[number]>, "en")).toBe(
      "Tide tables. Cited: p. 14; p. 22",
    );
  });

  test("is the stored one when the Document can't be found, or its names aren't known yet", () => {
    expect(sourceText(tides(14), { language: "en", documents: [] }).text).toBe("Tides, p. 14");
    expect(sourceText(tides(14), { language: "en", documents: null }).text).toBe("Tides, p. 14");
    expect(sourceText(tides(14), en).text).toBe("Tides, p. 14");
  });

  test("a machine-made name gives way to the Document's title, as everywhere", () => {
    const scanned = { id: "tides", contentHash: "h1", name: "IMG_0042", title: "Tide tables" };
    expect(sourceText(tides(14), { language: "en", documents: [scanned] }).text).toBe(
      "Tide tables, p. 14",
    );
  });
});
