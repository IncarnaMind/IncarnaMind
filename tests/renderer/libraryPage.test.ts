import { describe, expect, test } from "vitest";
import type {
  Document,
  DocumentGroupAssignment,
  DocumentTextMatch,
  LibraryGroup,
} from "../../src/core/api";
import {
  addedLabel,
  folderCounts,
  folderFacet,
  foundLine,
  NOT_IN_A_FOLDER,
  nameMatchOf,
  organizeModel,
  organizeState,
  problemOf,
  problemText,
  RECENTLY_DELETED,
  searchMatches,
  sectionShows,
  sectionsOf,
  sourceFacet,
} from "../../src/renderer/src/libraryPage";
import { queryWords } from "../../src/renderer/src/matcher";
import { displayName } from "../../src/shared/documentNames";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

let next = 0;
/** A ready Document whose file is where it was, unless said otherwise. */
const doc = (changes: Partial<Document> = {}): Document =>
  ({
    id: `doc-${++next}`,
    name: `Document ${next}`,
    title: null,
    kind: "pdf",
    status: "ready",
    fileStatus: "available",
    tags: [],
    createdAt: "2026-10-09T10:00:00.000Z",
    ...changes,
  }) as Document;

const folder = (id: string, name = id): LibraryGroup => ({
  id,
  name,
  description: "",
  countsOwnFiles: false,
  keepInside: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

describe("sections", () => {
  const board = folder("board", "Board");
  const finance = folder("finance", "Finance");
  const a = doc();
  const b = doc();
  const c = doc();
  const where = new Map<string, string | null>([
    [a.id, "finance"],
    [b.id, null],
    [c.id, "gone"],
  ]);
  const folderOf = (id: string) => where.get(id) ?? null;

  test("one per Folder in the order given, then Not in a Folder, each with its Documents in order", () => {
    const sections = sectionsOf([board, finance], [a, b, c], folderOf, false);
    expect(sections.map((section) => section.key)).toEqual(["board", "finance", NOT_IN_A_FOLDER]);
    expect(sections[1]?.documents).toEqual([a]);
    // A Document in a Folder that isn't there any more is in none.
    expect(sections[2]?.documents).toEqual([b, c]);
  });

  test("a Folder's count is the Documents the page lists in it, not those filed there and since deleted", () => {
    const assignments = [
      { documentId: a.id, groupId: "finance" },
      { documentId: b.id, groupId: "finance" },
      { documentId: "deleted", groupId: "finance" },
    ];
    expect(folderCounts([board, finance], [a, b, c], assignments)).toEqual(
      new Map([
        ["board", 0],
        ["finance", 2],
      ]),
    );
  });

  test("an empty Folder still shows; Not in a Folder only while it holds something", () => {
    expect(sectionsOf([board, finance], [a], folderOf, false).map((s) => s.key)).toEqual([
      "board",
      "finance",
    ]);
  });

  test("while narrowed, sections with no match are left out", () => {
    expect(sectionsOf([board, finance], [a], folderOf, true).map((s) => s.key)).toEqual([
      "finance",
    ]);
    expect(sectionsOf([board, finance], [], folderOf, true)).toEqual([]);
  });

  test("a section asked for is there only if it would show, so the page never waits to scroll to it", () => {
    const assignments = [
      { documentId: a.id, groupId: "finance" },
      { documentId: c.id, groupId: "gone" },
    ];
    const shows = (key: string, documents: Document[], deleted: number | null = null) =>
      sectionShows(key, documents, [board, finance], assignments, deleted);
    expect(shows("board", [])).toBe(true);
    expect(shows("gone", [a, c])).toBe(false);
    expect(shows(NOT_IN_A_FOLDER, [a])).toBe(false);
    // A Document whose Folder has gone is Not in a Folder.
    expect(shows(NOT_IN_A_FOLDER, [a, c])).toBe(true);
    expect(shows(RECENTLY_DELETED, [], 0)).toBe(false);
    expect(shows(RECENTLY_DELETED, [], 2)).toBe(true);
    // Not read yet: it may be there.
    expect(shows(RECENTLY_DELETED, [], null)).toBe(true);
  });
});

describe("search", () => {
  const tagNames = new Map([["t1", "Contract"]]);
  const lease = doc({
    name: "lease_2026",
    title: "Lease: Rotterdam warehouse",
    tags: [{ tagId: "t1" } as Document["tags"][number]],
  });

  const minutes = doc({ name: "会议纪要 0402" });
  const found = (...names: string[]) => names.join(" ");

  test("every word must be found, in the name, the file name, the title or a Tag, whatever the case and accents", () => {
    expect(nameMatchOf(lease, queryWords("  Rotterdam   CONTRACT "), tagNames)).not.toBeNull();
    expect(nameMatchOf(lease, queryWords("lease_2026"), tagNames)).not.toBeNull();
    expect(nameMatchOf(lease, queryWords("rotterdam invoice"), tagNames)).toBeNull();
    expect(nameMatchOf(doc({ name: "Café menu" }), queryWords("cafe"), tagNames)).not.toBeNull();
  });

  test("the words in the shown name are marked; those found only elsewhere mark nothing", () => {
    const named = doc({ name: "Lease: Rotterdam warehouse", tags: lease.tags });
    const name = displayName(named);
    const ranges = nameMatchOf(named, queryWords("rotter ware contract"), tagNames) ?? [];
    expect(found(...ranges.map((range) => name.slice(range.start, range.end)))).toBe("Rotter ware");
  });

  test("Chinese names are found by their characters, traditional ones as simplified", () => {
    expect(nameMatchOf(minutes, queryWords("纪要"), tagNames)).not.toBeNull();
    expect(nameMatchOf(minutes, queryWords("會議"), tagNames)).not.toBeNull();
    expect(nameMatchOf(minutes, queryWords("财务"), tagNames)).toBeNull();
  });

  test("as in ⌘K, a Chinese name is found by its pinyin and initials, and a long word with one typo", () => {
    const name = displayName(minutes);
    const marked = (query: string) =>
      (nameMatchOf(minutes, queryWords(query), tagNames) ?? []).map((range) =>
        name.slice(range.start, range.end),
      );
    expect(marked("huiyi")).toEqual(["会议"]);
    expect(marked("hyjy")).toEqual(["会议纪要"]);
    expect(nameMatchOf(lease, queryWords("rotterdma"), tagNames)).not.toBeNull();
    expect(nameMatchOf(lease, queryWords("contarct"), tagNames)).not.toBeNull();
  });

  test("the line found starts a little before its first word found, at a word, so a narrow row shows it", () => {
    const mark = (line: { text: string; ranges: { start: number; end: number }[] }) =>
      line.ranges.map((range) => line.text.slice(range.start, range.end));
    const english =
      "…of the Rotterdam lease, the tenant and the landlord agreed the ledger figures.";
    const at = english.indexOf("ledger");
    const line = foundLine({ excerpt: english, highlights: [{ start: at, end: at + 6 }] });
    expect(line.text).toBe("…agreed the ledger figures.");
    expect(mark(line)).toEqual(["ledger"]);
    const chinese = "客户访谈记录 客户访谈记录：本季度的数据已核对，详见附表。";
    const near = chinese.indexOf("核对");
    expect(
      foundLine({ excerpt: chinese, highlights: [{ start: near, end: near + 2 }] }, 6).text,
    ).toBe("…季度的数据已核对，详见附表。");
    // Near the start already: as it is.
    expect(foundLine({ excerpt: "The ledger", highlights: [{ start: 4, end: 10 }] }).text).toBe(
      "The ledger",
    );
  });

  test("a search finds Documents by their names and Tags, and those the words were found inside, with the Passage", () => {
    const passage: DocumentTextMatch = {
      documentId: minutes.id,
      passageId: "p1",
      pageFrom: 2,
      pageTo: 2,
      excerpt: "…the Rotterdam lease was signed…",
      highlights: [{ start: 5, end: 14 }],
    };
    const other = doc({ name: "Invoice 4471" });
    const named = doc({ name: "Rotterdam lease" });
    const matches = searchMatches(
      [lease, minutes, other, named],
      queryWords("rotterdam"),
      tagNames,
      new Map([
        [minutes.id, passage],
        [named.id, { ...passage, documentId: named.id }],
      ]),
    );
    expect([...(matches?.keys() ?? [])]).toEqual([lease.id, minutes.id, named.id]);
    expect(matches?.get(minutes.id)).toEqual({ ranges: [], text: passage });
    // A name that holds the words says enough: no Passage under it.
    expect(matches?.get(named.id)).toEqual({ ranges: [{ start: 0, end: 9 }], text: null });
    // Until the core answers, names alone.
    expect([
      ...(searchMatches([lease, minutes], queryWords("rotterdam"), tagNames, null)?.keys() ?? []),
    ]).toEqual([lease.id]);
    expect(searchMatches([lease], [], tagNames, null)).toBeNull();
  });
});

describe("the problem line", () => {
  test("none while every Document can be used, or is still being read", () => {
    expect(problemOf([doc(), doc({ status: "embedding" })])).toBeNull();
  });

  test("one kind is named, in the singular and the plural, in English and Chinese", () => {
    const one = problemOf([doc(), doc({ status: "no-text" })]);
    expect(one).toEqual({ kind: "no-text", count: 1, statuses: ["no-text"] });
    if (!one) throw new Error("No problem found.");
    expect(problemText(one, en)).toBe("1 Document has no text");
    expect(problemText(one, zh)).toBe("1 个文档没有文字");
    const two = problemOf([doc({ fileStatus: "missing" }), doc({ fileStatus: "missing" })]);
    if (!two) throw new Error("No problem found.");
    expect(problemText(two, en)).toBe("2 Documents’ files are missing");
    expect(problemText(two, zh)).toBe("2 个文档的文件缺失");
  });

  test("several kinds are counted together, and Show filters to all of them", () => {
    const mixed = problemOf([
      doc({ status: "failed" }),
      doc({ status: "no-text" }),
      doc({ fileStatus: "unavailable" }),
    ]);
    expect(mixed).toEqual({
      kind: "mixed",
      count: 3,
      statuses: ["no-text", "failed", "unavailable"],
    });
    if (!mixed) throw new Error("No problem found.");
    expect(problemText(mixed, en)).toBe("3 Documents need attention");
  });
});

describe("dates", () => {
  const now = new Date("2026-10-13T12:00:00Z");

  test("this year's as a day and a month, earlier ones with the year", () => {
    expect(addedLabel("2026-10-09T10:00:00Z", now, "en")).toBe("9 Oct");
    expect(addedLabel("2025-03-04T10:00:00Z", now, "en")).toBe("4 Mar 2025");
    expect(addedLabel("2026-10-09T10:00:00Z", now, "zh-CN")).toBe("10月9日");
    expect(addedLabel("2025-03-04T10:00:00Z", now, "zh-CN")).toBe("2025年3月4日");
    expect(addedLabel("not a date", now, "en")).toBe("");
  });
});

describe("what Organize did, as Get info says it", () => {
  const assignment = (changes: Partial<DocumentGroupAssignment>): DocumentGroupAssignment => ({
    documentId: "d",
    groupId: "finance",
    source: "automatic",
    suggested: false,
    status: "classified",
    error: null,
    model: null,
    ...changes,
  });

  test("its state in a word", () => {
    const item = doc({ tagging: "tagged" });
    expect(en(organizeState(undefined, undefined))).toBe("Not organized yet");
    expect(en(organizeState(item, assignment({ status: "classifying" })))).toBe("Organizing…");
    expect(en(organizeState(item, assignment({ status: "failed" })))).toBe("Needs attention");
    expect(en(organizeState(item, assignment({ source: "user", status: "failed" })))).toBe(
      "Your choice",
    );
    expect(en(organizeState(item, assignment({ suggested: true })))).toBe("Suggested");
    expect(en(organizeState(item, assignment({})))).toBe("Organized");
    expect(en(organizeState(doc({ tagging: "stopped" }), assignment({})))).toBe("Organized");
  });

  test("the model it used, what it read, and why it took a smaller one", () => {
    expect(organizeModel({ id: "tev1:4b", images: false, reason: "text" }, en)).toBe(
      "tev1:4b · Text",
    );
    expect(organizeModel({ id: "clef-flash", images: true, reason: "visual" }, en)).toBe(
      "clef-flash · Text + PDF pages",
    );
    expect(organizeModel({ id: "tev1:0.8b", images: false, reason: "memory" }, en)).toBe(
      "tev1:0.8b · Text · Smaller model for memory limits",
    );
  });
});

describe("the Folder filter", () => {
  test("each Document under its Folder or Not in a Folder, the Folders in order and none last", () => {
    const where = new Map([["d1", "finance"]]);
    const facet = folderFacet(
      [folder("board", "Board"), folder("finance", "Finance")],
      (id) => where.get(id) ?? null,
    );
    expect(facet.values(doc({ id: "d1" }))).toEqual(["finance"]);
    expect(facet.values(doc({ id: "d2" }))).toEqual([NOT_IN_A_FOLDER]);
    expect([NOT_IN_A_FOLDER, "finance", "board"].sort(facet.compare)).toEqual([
      "board",
      "finance",
      NOT_IN_A_FOLDER,
    ]);
    expect(facet.label(NOT_IN_A_FOLDER, en)).toBe("Not in a Folder");
    expect(facet.label(NOT_IN_A_FOLDER, zh)).toBe("不在文件夹中");
    expect(facet.label("finance", en)).toBe("Finance");
  });

  test("Source locations name Linked folders apart when two have one name (#1507)", () => {
    const facet = sourceFacet([
      { id: "a", path: "/work/2025/Reading" },
      { id: "b", path: "/work/2026/Reading" },
      { id: "c", path: "/work/Other" },
    ]);
    expect(facet.label("a", en)).toBe("2025 / Reading");
    expect(facet.label("b", en)).toBe("2026 / Reading");
    expect(facet.label("c", en)).toBe("Other");
    expect(facet.compare("a", "b")).toBeLessThan(0);
  });
});
