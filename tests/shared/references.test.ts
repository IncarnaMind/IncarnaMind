/**
 * Reference records' shared parts (#286): names as written and typed, dates,
 * DOIs, arXiv ids, and what a record needs before it can be cited.
 */
import { describe, expect, test } from "vitest";
import type { ReferenceFields } from "../../src/core/api";
import {
  arxivIdOf,
  emptyReferenceFields,
  formatName,
  formatNames,
  isPaperOrBook,
  lookupIdentifier,
  missingDetails,
  normalizeDoi,
  parseIssued,
  parseName,
  parseTypedNames,
  parseWrittenNames,
} from "../../src/shared/references";

const record = (fields: Partial<ReferenceFields>) => ({
  fields: { ...emptyReferenceFields(), ...fields },
});

describe("Names", () => {
  test("a Western name splits into family and given names, particles with the family name", () => {
    expect(parseName("Diana E. Bowler")).toEqual({ family: "Bowler", given: "Diana E." });
    expect(parseName("Bowler, Diana E.")).toEqual({ family: "Bowler", given: "Diana E." });
    expect(parseName("Stéfan J. van der Walt")).toEqual({
      family: "van der Walt",
      given: "Stéfan J.",
    });
  });

  test("Chinese, Japanese and Korean names stay whole, as written, never split as Western names", () => {
    expect(parseName("张三")).toEqual({ literal: "张三" });
    expect(parseName("欧阳 明")).toEqual({ literal: "欧阳明" });
    expect(parseName("山田太郎")).toEqual({ literal: "山田太郎" });
    expect(parseName("김민준")).toEqual({ literal: "김민준" });
  });

  test("organisations and single words stay whole", () => {
    expect(parseName("World Health Organization")).toEqual({
      literal: "World Health Organization",
    });
    expect(parseName("UNESCO")).toEqual({ literal: "UNESCO" });
  });

  test("a file's author property is read however its writer listed the names, keeping their order", () => {
    const four = [
      { family: "Bowler", given: "Diana" },
      { family: "Knight", given: "Teri" },
      { family: "Pullin", given: "Andrew" },
    ];
    expect(parseWrittenNames("Diana Bowler; Teri Knight; Andrew Pullin")).toEqual(four);
    expect(parseWrittenNames("Diana Bowler, Teri Knight, and Andrew Pullin")).toEqual(four);
    expect(parseWrittenNames("Diana Bowler, Teri Knight & Andrew Pullin")).toEqual(four);
    expect(parseWrittenNames("Diana Bowler, Teri Knight, Andrew Pullin")).toEqual(four);
    expect(parseWrittenNames("Bowler, Diana")).toEqual([{ family: "Bowler", given: "Diana" }]);
    const chinese = [{ literal: "张三" }, { literal: "李四" }, { literal: "欧阳明" }];
    expect(parseWrittenNames("张三；李四；欧阳明")).toEqual(chinese);
    expect(parseWrittenNames("张三，李四，欧阳明")).toEqual(chinese);
    expect(parseWrittenNames("张三、李四、欧阳明")).toEqual(chinese);
    expect(parseWrittenNames("张三 李四 欧阳明")).toEqual(chinese);
    expect(parseWrittenNames("  ")).toEqual([]);
  });

  test("names are shown as they are typed back: Family, Given; Chinese names family name first", () => {
    const names = [
      { family: "Bowler", given: "Diana E." },
      { literal: "张三" },
      { family: "张", given: "三" },
      { family: "Plato", given: "" },
    ];
    expect(names.map(formatName)).toEqual(["Bowler, Diana E.", "张三", "张三", "Plato"]);
    expect(formatNames(names.slice(0, 2), "en")).toBe("Bowler, Diana E.; 张三");
    expect(formatNames(names.slice(0, 2), "zh-CN")).toBe("Bowler, Diana E.；张三");
    expect(parseTypedNames("Bowler, Diana E.; 张三")).toEqual(names.slice(0, 2));
    expect(parseTypedNames("张三；李四、王五\nPullin, Andrew")).toEqual([
      { literal: "张三" },
      { literal: "李四" },
      { literal: "王五" },
      { family: "Pullin", given: "Andrew" },
    ]);
  });
});

describe("Dates", () => {
  test("a year, a month or a day, however it is written", () => {
    expect(parseIssued("2010")).toBe("2010");
    expect(parseIssued("2010-8")).toBe("2010-08");
    expect(parseIssued("2010-08-04")).toBe("2010-08-04");
    expect(parseIssued("2010/8/4")).toBe("2010-08-04");
    expect(parseIssued("2010.08")).toBe("2010-08");
    expect(parseIssued("2010年8月4日")).toBe("2010-08-04");
    expect(parseIssued("2010年8月")).toBe("2010-08");
    expect(parseIssued("2010年")).toBe("2010");
    expect(parseIssued("2017-06-12T17:57:34Z")).toBe("2017-06-12");
  });

  test("anything else is no date", () => {
    expect(parseIssued("next spring")).toBeNull();
    expect(parseIssued("2010-13")).toBeNull();
    expect(parseIssued("2010-02-30")).toBeNull();
    expect(parseIssued("")).toBeNull();
  });
});

describe("DOIs and arXiv ids", () => {
  test("a DOI loses its address, its label and a sentence's punctuation", () => {
    expect(normalizeDoi("https://doi.org/10.1186/1471-2458-10-456")).toBe(
      "10.1186/1471-2458-10-456",
    );
    expect(normalizeDoi("doi:10.1038/s41586-020-2649-2.")).toBe("10.1038/s41586-020-2649-2");
    expect(normalizeDoi("DOI：10.11821/dlxb202001005。")).toBe("10.11821/dlxb202001005");
    expect(normalizeDoi("(see 10.1016/S0140-6736(20)30183-5)")).toBeNull();
    expect(normalizeDoi("10.1016/S0140-6736(20)30183-5)")).toBe("10.1016/S0140-6736(20)30183-5");
    expect(normalizeDoi("not a doi")).toBeNull();
  });

  test("an arXiv address gives its id, without its version", () => {
    expect(arxivIdOf("https://arxiv.org/abs/1706.03762v7")).toBe("1706.03762");
    expect(arxivIdOf("http://arxiv.org/pdf/hep-th/9901001")).toBe("hep-th/9901001");
    expect(arxivIdOf("https://example.org/abs/1706.03762")).toBeNull();
  });

  test("Look up goes by the DOI, or by the arXiv id, arXiv's own DOI included", () => {
    expect(lookupIdentifier({ doi: "10.1038/x", url: "https://arxiv.org/abs/1706.03762" })).toEqual(
      { kind: "doi", id: "10.1038/x" },
    );
    expect(lookupIdentifier({ doi: "", url: "https://arxiv.org/abs/1706.03762" })).toEqual({
      kind: "arxiv",
      id: "1706.03762",
    });
    expect(lookupIdentifier({ doi: "10.48550/arXiv.1706.03762", url: "" })).toEqual({
      kind: "arxiv",
      id: "1706.03762",
    });
    expect(lookupIdentifier({ doi: "", url: "https://example.org" })).toBeNull();
  });
});

describe("What a record needs before it can be cited", () => {
  test("a work needs its title, authors and date", () => {
    expect(missingDetails(record({ type: "article-journal" }))).toEqual([
      "title",
      "authors",
      "issued",
    ]);
    expect(
      missingDetails(
        record({ type: "book", title: "T", authors: [{ literal: "张三" }], issued: "2010" }),
      ),
    ).toEqual([]);
  });

  test("a web page needs only its title, and Other needs nothing", () => {
    expect(missingDetails(record({ type: "webpage" }))).toEqual(["title"]);
    expect(missingDetails(record({ type: "document" }))).toEqual([]);
  });
});

describe("What makes a Mind offer a citation style, and take GB/T 7714 (#289, #1910)", () => {
  const authors = [{ literal: "钱学森" }];

  test("a paper or a book with its authors or its year", () => {
    for (const type of [
      "article-journal",
      "paper-conference",
      "article",
      "chapter",
      "book",
      "thesis",
    ] as const) {
      expect(isPaperOrBook(record({ type, authors })), type).toBe(true);
      expect(isPaperOrBook(record({ type, issued: "1958" })), type).toBe(true);
    }
  });

  test("never a report, a web page or Other, whatever its authors and date say", () => {
    for (const type of ["report", "webpage", "document"] as const) {
      expect(isPaperOrBook(record({ type, authors, issued: "2024" })), type).toBe(false);
    }
  });

  test("not a paper with neither authors nor a date, and nothing at all", () => {
    expect(isPaperOrBook(record({ type: "article-journal", title: "Q3 review" }))).toBe(false);
    expect(isPaperOrBook(null)).toBe(false);
  });
});
