import { describe, expect, test } from "vitest";
import type { DocumentTag, Tag } from "../../src/core/api";
import {
  actionFor,
  chipsOf,
  pickerOptions,
  tagIndex,
  tagsOnDocuments,
} from "../../src/renderer/src/tagEditing";

const tag = (name: string, description = ""): Tag => ({
  id: name.toLowerCase(),
  name,
  description,
  preset: false,
  colour: "gray",
  createdAt: "",
  updatedAt: "",
});
const link = (tagId: string, extra: Partial<DocumentTag> = {}): DocumentTag => ({
  tagId,
  source: "user",
  confidence: null,
  needsReview: false,
  ...extra,
});
const tags = ["Contract", "Invoice", "Notes", "Report", "Slides"].map((name) => tag(name));

describe("a Tag on the Documents being edited", () => {
  test("on one Document: on or off, automatic, and needing review", () => {
    const states = tagsOnDocuments(tags, [
      {
        tags: [
          link("invoice", { source: "automatic", confidence: 0.62, needsReview: true }),
          link("report", { source: "automatic", confidence: 0.91 }),
          link("contract"),
        ],
      },
    ]);
    const by = (id: string) => states.find((state) => state.tag.id === id);
    expect(by("contract")).toMatchObject({ coverage: "all", automatic: false, needsReview: false });
    expect(by("invoice")).toMatchObject({ coverage: "all", automatic: true, needsReview: true });
    expect(by("report")).toMatchObject({ coverage: "all", automatic: true, confidence: 0.91 });
    expect(by("notes")).toMatchObject({ coverage: "none", count: 0, total: 1 });
    // Enter confirms a Tag awaiting review, removes one that is on, and adds one that isn't.
    expect(actionFor(by("invoice") ?? ({} as never))).toBe("confirm");
    expect(actionFor(by("contract") ?? ({} as never))).toBe("remove");
    expect(actionFor(by("notes") ?? ({} as never))).toBe("add");
  });

  test("on several Documents: all, some or none; some is added to all", () => {
    const states = tagsOnDocuments(tags, [
      { tags: [link("report"), link("slides")] },
      { tags: [link("report", { source: "automatic", needsReview: true })] },
      { tags: [link("report")] },
    ]);
    const report = states.find((state) => state.tag.id === "report");
    const slides = states.find((state) => state.tag.id === "slides");
    expect(report).toMatchObject({ coverage: "all", count: 3, total: 3, automatic: false });
    expect(slides).toMatchObject({ coverage: "some", count: 1, total: 3 });
    if (!report || !slides) throw new Error("missing");
    // With several Documents, a Tag on all of them comes off; review is confirmed one at a time.
    expect(actionFor(report)).toBe("remove");
    expect(actionFor(slides)).toBe("add");
  });
});

describe("typing in the picker", () => {
  const states = tagsOnDocuments(
    [tag("Invoice"), tag("Notes"), tag("Report"), tag("Reporting lines"), tag("Annual report")],
    [{ tags: [] }],
  );
  const names = (query: string) => pickerOptions(states, query).matches.map((s) => s.tag.name);

  test("shows every Tag with nothing typed, and no new one to create", () => {
    expect(names("")).toEqual(["Invoice", "Notes", "Report", "Reporting lines", "Annual report"]);
    expect(pickerOptions(states, "  ").create).toBeNull();
  });

  test("filters by name, ignoring case: an exact name first, then names starting with it", () => {
    expect(names("rep")).toEqual(["Report", "Reporting lines", "Annual report"]);
    expect(names("REPORT")).toEqual(["Report", "Reporting lines", "Annual report"]);
    // An exact name (ignoring case) is never offered as a new Tag.
    expect(pickerOptions(states, "report ").create).toBeNull();
    expect(pickerOptions(states, "Receipt").create).toBe("Receipt");
    expect(names("Receipt")).toEqual([]);
  });

  test("finds a Chinese Tag by its pinyin, its initials and another of a character's readings", () => {
    const chinese = tagsOnDocuments([tag("财务"), tag("重命名"), tag("Invoice")], [{ tags: [] }]);
    const found = (query: string) =>
      pickerOptions(chinese, query).matches.map((state) => state.tag.name);
    expect(found("caiwu")).toEqual(["财务"]);
    expect(found("cw")).toEqual(["财务"]);
    expect(found("chongming")).toEqual(["重命名"]);
    expect(found("cmm")).toEqual(["重命名"]);
    expect(found("zhongming")).toEqual(["重命名"]);
    expect(found("zmm")).toEqual(["重命名"]);
  });
});

describe("a Document's chips", () => {
  test("put Tags awaiting review first, then the rest in name order, skipping deleted Tags", () => {
    const chips = chipsOf(
      [link("contract"), link("gone"), link("report", { needsReview: true }), link("slides")],
      tags,
    );
    expect(chips.map((chip) => [chip.tag.name, chip.link.needsReview])).toEqual([
      ["Report", true],
      ["Contract", false],
      ["Slides", false],
    ]);
  });

  test("are the same from the Tags indexed by id, as a long list looks them up", () => {
    const links = [link("contract"), link("gone"), link("report", { needsReview: true })];
    expect(chipsOf(links, tagIndex(tags))).toEqual(chipsOf(links, tags));
  });
});
