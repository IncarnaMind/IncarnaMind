import { describe, expect, test } from "vitest";
import type { LibraryGroup, SearchScope, Tag } from "../../src/core/api";
import { type ScopeLibrary, scopeChoices } from "../../src/renderer/src/scope";

const group = (id: string, name: string): LibraryGroup => ({
  id,
  name,
  description: "",
  countsOwnFiles: false,
  createdAt: "",
  updatedAt: "",
});
const tag = (id: string, name: string): Tag => ({
  id,
  name,
  description: "",
  preset: false,
  colour: "gray",
  createdAt: "",
  updatedAt: "",
});

const library: ScopeLibrary = {
  folders: [],
  groups: [
    group("g-finance", "Finance"),
    group("g-refinance", "Refinance"),
    group("g-caiwu", "财务"),
    group("g-rename", "重命名"),
  ],
  tags: [tag("t-report", "报告")],
  documents: [],
};
const noScope: SearchScope = { folderIds: [], tagIds: [], documentIds: [] };
const names = (query: string) => scopeChoices(library, noScope, query).map((choice) => choice.name);

describe('the "@" picker\'s choices', () => {
  test("a Chinese Folder or Tag is found by its pinyin, its initials and another of a character's readings", () => {
    expect(names("caiwu")).toEqual(["财务"]);
    expect(names("cw")).toEqual(["财务"]);
    expect(names("baogao")).toEqual(["报告"]);
    expect(names("chongming")).toEqual(["重命名"]);
    expect(names("cmm")).toEqual(["重命名"]);
    expect(names("zhongming")).toEqual(["重命名"]);
  });

  test("a name that starts with the word comes before one that only holds it", () => {
    expect(names("fin")).toEqual(["Finance", "Refinance"]);
    expect(names("")).toEqual(["Finance", "Refinance", "财务", "重命名", "报告"]);
  });

  test("a typo doesn't offer one: typing over a name still adds the name itself", () => {
    expect(names("finanse")).toEqual([]);
  });
});
