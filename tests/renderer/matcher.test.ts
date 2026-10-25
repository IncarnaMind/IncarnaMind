import { describe, expect, test } from "vitest";
import { matchName, queryWords } from "../../src/renderer/src/matcher";

const marked = (query: string, name: string) =>
  matchName(queryWords(query), name)?.ranges.map((range) => name.slice(range.start, range.end));

const ranked = (query: string, names: string[]) =>
  names
    .map((name) => ({ name, match: matchName(queryWords(query), name) }))
    .filter((each) => each.match !== null)
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    .map((each) => each.name);

describe("matching names", () => {
  test("every word typed must be in the name, in any order, whatever its case and accents", () => {
    expect(queryWords("  Notice   PERIOD ")).toEqual(["notice", "period"]);
    expect(marked("2026 contract", "Contracts register 2026")).toEqual(["Contract", "2026"]);
    expect(marked("alesund", "Tides at Ålesund")).toEqual(["Ålesund"]);
    expect(matchName(queryWords("contract giraffe"), "Contracts register 2026")).toBeNull();
    expect(matchName([], "Anything")).toBeNull();
  });

  test("Chinese is found inside a name, and traditional and simplified characters match", () => {
    expect(marked("合同", "供应商合同审查")).toEqual(["合同"]);
    expect(marked("財務", "2026 财务报表")).toEqual(["财务"]);
    expect(marked("财务", "財務報表")).toEqual(["財務"]);
    expect(marked("报表 2026", "2026 财务报表")).toEqual(["2026", "报表"]);
  });

  test("the name that is the words comes first, then one that starts with them, then one with them at a word's start", () => {
    expect(
      ranked("contract", ["Subcontractors", "Master contract", "Contracts register", "Contract"]),
    ).toEqual(["Contract", "Contracts register", "Master contract", "Subcontractors"]);
  });

  test("what is marked points at the name as written, past emoji and accents", () => {
    expect(marked("notes", "📄 Notes")).toEqual(["Notes"]);
    expect(marked("cafe", "Café notes")).toEqual(["Café"]);
  });
});

describe("Chinese names by pinyin, and typos", () => {
  test("full pinyin and its initials find a Chinese name, marking the characters they spell", () => {
    expect(marked("caiwu", "财务")).toEqual(["财务"]);
    expect(marked("cw", "财务")).toEqual(["财务"]);
    expect(marked("hetong", "供应商合同")).toEqual(["合同"]);
    expect(marked("caiw", "2026 财务报表")).toEqual(["财务"]);
    expect(marked("2026 cwbb", "2026 财务报表")).toEqual(["2026", "财务报表"]);
    expect(marked("hetong", "合同 (traditional 合約)")).toEqual(["合同"]);
  });

  test("pinyin counts only from a syllable's start, and Latin names aren't read as pinyin", () => {
    expect(matchName(queryWords("aiwu"), "财务")).toBeNull();
    expect(matchName(queryWords("cw"), "Crown works")).toBeNull();
  });

  test("a word of four letters or more may have one typo, and ranks below every exact match", () => {
    expect(marked("contarct", "Contracts register 2026")).toEqual(["Contract"]);
    expect(marked("contrat", "Master contract")).toEqual(["contract"]);
    expect(marked("recieve", "Received payments")).toEqual(["Receive"]);
    expect(marked("cnotract", "Contract")).toEqual(["Contract"]);
    expect(matchName(queryWords("cnotarct"), "Contract")).toBeNull();
    expect(matchName(queryWords("xontract"), "Contract")).toBeNull();
    expect(matchName(queryWords("tdi"), "Tide tables")).toBeNull();
    expect(ranked("contarct", ["Contract typo test", "Contarct notes"])).toEqual([
      "Contarct notes",
      "Contract typo test",
    ]);
  });

  test("a typo stays inside one word, never letters across words (#1372)", () => {
    expect(matchName(queryWords("theme"), "Remove the examples")).toBeNull();
    expect(marked("theme", "Theme")).toEqual(["Theme"]);
    // One word may still have its typo, even beside another.
    expect(marked("contarct", "Remove the contract")).toEqual(["contract"]);
  });

  test("a character read two ways is found by either reading, in full pinyin or initials (#1416)", () => {
    expect(marked("chongming", "重命名")).toEqual(["重命"]);
    expect(marked("cmm", "重命名")).toEqual(["重命名"]);
    // The reading the collation gives still finds it.
    expect(marked("zhongming", "重命名")).toEqual(["重命"]);
    expect(marked("chongxin", "重新读取")).toEqual(["重新"]);
    expect(marked("xingzhang", "行长")).toEqual(["行长"]);
    expect(marked("hangzhang", "行长")).toEqual(["行长"]);
    expect(marked("changdu", "长度")).toEqual(["长度"]);
    expect(marked("chuchai", "出差")).toEqual(["出差"]);
    // A name mixing Chinese and English keeps both.
    expect(marked("cmm r", "重命名 Rename")).toEqual(["重命名", "R"]);
    expect(marked("hang zhang", "行长 (bank)")).toEqual(["行长"]);
  });
});
