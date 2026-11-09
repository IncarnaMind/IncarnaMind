import { describe, expect, test } from "vitest";
import type { Document } from "../../src/core/api";
import {
  documentFacets,
  documentsByTag,
  documentYear,
  type FilterSelection,
  filterLibrary,
  formatFacet,
  isFiltering,
  type LibraryFacet,
  libraryStatus,
  matchesTags,
  NO_DATE,
  statusFacet,
  tagFacet,
  toggleFilterValue,
  yearFacet,
} from "../../src/renderer/src/libraryFilters";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

type Shape = Pick<Document, "id" | "kind" | "creationDate" | "status" | "fileStatus">;

let next = 0;
/** A ready PDF from 2023 whose file is where it was, unless said otherwise. */
const doc = (changes: Partial<Shape> = {}): Shape => ({
  id: `doc-${++next}`,
  kind: "pdf",
  creationDate: "2023-05-01",
  status: "ready",
  fileStatus: "available",
  ...changes,
});

const options = <T>(
  items: readonly T[],
  facet: LibraryFacet<T>,
  selection: FilterSelection = {},
  facets: readonly LibraryFacet<T>[] = documentFacets as readonly LibraryFacet<T>[],
) =>
  filterLibrary(items, facets, selection)
    .options.get(facet.id)
    ?.map(({ value, count, selected }) => [value, count, selected]);

describe("a Document's year", () => {
  test("is the first four characters of its creation date, at any precision", () => {
    expect(documentYear({ creationDate: "2019-03-04T10:30:00+01:00" })).toBe("2019");
    expect(documentYear({ creationDate: "2019-03-04" })).toBe("2019");
    expect(documentYear({ creationDate: "2019" })).toBe("2019");
  });

  test("is the year on this computer's clock for one written in UTC, as its info panel shows it", () => {
    const late = { creationDate: "2026-12-31T20:00:00Z" };
    expect(documentYear(late, { timeZone: "Asia/Shanghai" })).toBe("2027");
    expect(documentYear(late, { timeZone: "America/New_York" })).toBe("2026");
    expect(
      documentYear({ creationDate: "2026-12-31T20:00:00-08:00" }, { timeZone: "Asia/Shanghai" }),
    ).toBe("2026");
  });

  test("without a creation date (or with one that isn't a date) it has none", () => {
    expect(documentYear({ creationDate: null })).toBe(NO_DATE);
    expect(documentYear({ creationDate: "" })).toBe(NO_DATE);
    expect(documentYear({ creationDate: "soon" })).toBe(NO_DATE);
  });
});

describe("a Document's status in the Library", () => {
  test("its file comes first: missing or unavailable, whatever its processing", () => {
    expect(libraryStatus(doc({ fileStatus: "missing", status: "failed" }))).toBe("missing");
    expect(libraryStatus(doc({ fileStatus: "unavailable", status: "embedding" }))).toBe(
      "unavailable",
    );
  });

  test("then its processing: ready is available, any step before it is not indexed yet", () => {
    expect(libraryStatus(doc())).toBe("available");
    for (const status of ["queued", "extracting", "waiting-for-model", "embedding"] as const) {
      expect(libraryStatus(doc({ status }))).toBe("not-indexed");
    }
    expect(libraryStatus(doc({ status: "failed" }))).toBe("failed");
    expect(libraryStatus(doc({ status: "no-text" }))).toBe("no-text");
  });
});

describe("filtering the Library", () => {
  const library = [
    doc({ kind: "pdf", creationDate: "2023-01-02" }),
    doc({ kind: "pdf", creationDate: "2021", status: "failed" }),
    doc({ kind: "docx", creationDate: "2023-11-30T08:00:00Z" }),
    doc({ kind: "docx", creationDate: null, fileStatus: "missing" }),
    doc({ kind: "text", creationDate: null, status: "queued" }),
  ];

  test("with nothing chosen, every Document shows and each option counts its Documents", () => {
    const { shown } = filterLibrary(library, documentFacets, {});
    expect(shown).toEqual(library);
    // Newest year first, Documents without a date last.
    expect(options(library, yearFacet)).toEqual([
      ["2023", 2, false],
      ["2021", 1, false],
      [NO_DATE, 2, false],
    ]);
    expect(options(library, formatFacet)).toEqual([
      ["pdf", 2, false],
      ["docx", 2, false],
      ["text", 1, false],
    ]);
    expect(options(library, statusFacet)).toEqual([
      ["available", 2, false],
      ["not-indexed", 1, false],
      ["failed", 1, false],
      ["missing", 1, false],
    ]);
  });

  test("options of one filter are either-or; different filters must all match", () => {
    const years = { year: ["2023", "2021"] };
    expect(filterLibrary(library, documentFacets, years).shown).toEqual(library.slice(0, 3));
    const pdfs = { ...years, format: ["pdf"] };
    expect(filterLibrary(library, documentFacets, pdfs).shown).toEqual(library.slice(0, 2));
    const failed = { ...pdfs, status: ["failed"] };
    expect(filterLibrary(library, documentFacets, failed).shown).toEqual([library[1]]);
    expect(filterLibrary(library, documentFacets, { ...failed, format: ["docx"] }).shown).toEqual(
      [],
    );
  });

  test("each option counts what choosing it would show, given the other filters", () => {
    const selection = { format: ["docx"] };
    // The years among Word files; the formats among every year (none chosen), the chosen one checked.
    expect(options(library, yearFacet, selection)).toEqual([
      ["2023", 1, false],
      ["2021", 0, false],
      [NO_DATE, 1, false],
    ]);
    expect(options(library, formatFacet, selection)).toEqual([
      ["pdf", 2, false],
      ["docx", 2, true],
      ["text", 1, false],
    ]);
    expect(options(library, statusFacet, selection)).toEqual([
      ["available", 1, false],
      ["not-indexed", 0, false],
      ["failed", 0, false],
      ["missing", 1, false],
    ]);
  });

  test("an option chosen keeps its place even when nothing in view has it", () => {
    const selection = { year: ["1999"] };
    expect(filterLibrary(library, documentFacets, selection).shown).toEqual([]);
    expect(options(library, yearFacet, selection)?.[2]).toEqual(["1999", 0, true]);
  });

  test("another kind of filter, e.g. one with several values per Document, fits in", () => {
    type Tagged = Shape & { tags: string[] };
    const tagFacet: LibraryFacet<Tagged> = {
      id: "tag",
      title: "tags.title",
      values: (item) => item.tags,
      label: (value) => value,
      compare: (a, b) => a.localeCompare(b),
    };
    const tagged: Tagged[] = [
      { ...doc(), tags: ["Report", "Finance"] },
      { ...doc({ kind: "docx" }), tags: ["Report"] },
      { ...doc(), tags: [] },
    ];
    const facets = [...(documentFacets as readonly LibraryFacet<Tagged>[]), tagFacet];
    expect(options(tagged, tagFacet, {}, facets)).toEqual([
      ["Finance", 1, false],
      ["Report", 2, false],
    ]);
    const { shown } = filterLibrary(tagged, facets, { tag: ["Report"], format: ["pdf"] });
    expect(shown).toEqual([tagged[0]]);
  });
});

describe("choosing filters", () => {
  test("toggling adds an option, then takes it away; a filter left empty is dropped", () => {
    let selection: FilterSelection = {};
    expect(isFiltering(selection)).toBe(false);
    selection = toggleFilterValue(selection, "year", "2023");
    selection = toggleFilterValue(selection, "year", "2021");
    selection = toggleFilterValue(selection, "format", "pdf");
    expect(selection).toEqual({ year: ["2023", "2021"], format: ["pdf"] });
    expect(isFiltering(selection)).toBe(true);
    selection = toggleFilterValue(selection, "format", "pdf");
    expect(selection).toEqual({ year: ["2023", "2021"] });
    selection = toggleFilterValue(toggleFilterValue(selection, "year", "2023"), "year", "2021");
    expect(selection).toEqual({});
    expect(isFiltering(selection)).toBe(false);
  });
});

describe("the filters' words", () => {
  test("say each option in English and Chinese", () => {
    expect(yearFacet.label("2023", en)).toBe("2023");
    expect(yearFacet.label(NO_DATE, en)).toBe("No date");
    expect(yearFacet.label(NO_DATE, zh)).toBe("无日期");
    expect(formatFacet.label("docx", en)).toBe("Word");
    expect(formatFacet.label("text", zh)).toBe("纯文本");
    expect(statusFacet.label("not-indexed", en)).toBe("Not read yet");
    expect(statusFacet.label("unavailable", zh)).toBe("无法访问");
    expect(en(yearFacet.title)).toBe("Year");
    expect(zh(statusFacet.title)).toBe("状态");
  });
});

/**
 * Documents that count how often their fields are read. Work, not time, so the
 * test holds on a slow or busy machine: a pass that grows faster than the
 * Library reads more fields per Document as the Library grows.
 */
function counted<T extends object>(items: readonly T[]): { items: T[]; reads: () => number } {
  let reads = 0;
  const wrapped = items.map((item) => {
    const copy = {} as T;
    for (const key of Object.keys(item) as (keyof T)[]) {
      Object.defineProperty(copy, key, {
        enumerable: true,
        get() {
          reads += 1;
          return item[key];
        },
      });
    }
    return copy;
  });
  return { items: wrapped, reads: () => reads };
}

/** Reads per Document at a size; the same at every size when the work is linear. */
const readsPerDocument = (size: number, run: (size: number) => { reads: () => number }) =>
  run(size).reads() / size;

describe("a large Library", () => {
  const library = (size: number) =>
    counted(
      Array.from({ length: size }, (_, index) =>
        doc({
          kind: (["pdf", "docx", "text"] as const)[index % 3],
          creationDate: index % 5 === 0 ? null : String(2000 + (index % 20)),
        }),
      ),
    );

  test("filters and counts 20,000 Documents in one pass", () => {
    const many = library(20_000);
    const { shown, options: all } = filterLibrary(many.items, documentFacets, { format: ["pdf"] });
    expect(shown).toHaveLength(6667);
    expect(all.get("year")?.reduce((sum, option) => sum + option.count, 0)).toBe(6667);
  });

  test("reads each Document as often in a big Library as in a small one", () => {
    const perDocument = (size: number) =>
      readsPerDocument(size, (n) => {
        const many = library(n);
        filterLibrary(many.items, documentFacets, { format: ["pdf"] });
        return many;
      });
    // Linear work reads the same per Document at any size; quadratic work
    // would read four times as much at four times the size.
    expect(perDocument(4_000)).toBeLessThanOrEqual(perDocument(1_000) * 1.25);
  });
});

describe("the Tags filter", () => {
  const tags = [
    { id: "t-report", name: "Report" },
    { id: "t-invoice", name: "invoice" },
  ];
  const link = (tagId: string) => ({
    tagId,
    source: "automatic" as const,
    confidence: null,
    needsReview: false,
  });
  type Tagged = Shape & Pick<Document, "tags">;
  const tagged: Tagged[] = [
    { ...doc(), tags: [link("t-report"), link("t-invoice")] },
    { ...doc({ kind: "docx" }), tags: [link("t-report")] },
    { ...doc(), tags: [] },
  ];
  const facet = tagFacet(tags);
  const facets = [...(documentFacets as readonly LibraryFacet<Tagged>[]), facet];

  test("offers each Tag by name, with counts", () => {
    expect(options(tagged, facet, {}, facets)).toEqual([
      ["t-invoice", 1, false],
      ["t-report", 2, false],
    ]);
    expect(facet.label("t-invoice", en)).toBe("invoice");
    expect(facet.label("t-report", zh)).toBe("Report");
  });

  test("keeps Documents with any Tag chosen, combined with the other filters", () => {
    expect(filterLibrary(tagged, facets, { tag: ["t-invoice", "t-report"] }).shown).toEqual([
      tagged[0],
      tagged[1],
    ]);
    expect(filterLibrary(tagged, facets, { tag: ["t-invoice"] }).shown).toEqual([tagged[0]]);
    expect(filterLibrary(tagged, facets, { tag: ["t-report"], format: ["docx"] }).shown).toEqual([
      tagged[1],
    ]);
    expect(matchesTags({ tags: [] }, [])).toBe(true);
    expect(matchesTags({ tags: [] }, ["t-report"])).toBe(false);
  });

  test("lists each Tag's Documents in one pass, in their order", () => {
    const byTag = documentsByTag(tagged);
    expect([...byTag.keys()].sort()).toEqual(["t-invoice", "t-report"]);
    expect(byTag.get("t-report")).toEqual([tagged[0], tagged[1]]);
    expect(byTag.get("t-invoice")).toEqual([tagged[0]]);
    // A Tag no Document has isn't there; the sidebar shows it with 0.
    expect(byTag.has("t-unused")).toBe(false);
  });

  test("lists 2,000 Documents' Tags in one pass", () => {
    const many = Array.from({ length: 2_000 }, (_, index) => ({
      tags: [link(`t-${index % 7}`), link(`t-${(index + 3) % 7}`)],
    }));
    const byTag = documentsByTag(many);
    expect(byTag.get("t-0")).toHaveLength(572);
  });

  test("reads each Document's Tags as often in a big Library as in a small one", () => {
    const perDocument = (size: number) =>
      readsPerDocument(size, (n) => {
        const many = counted(
          Array.from({ length: n }, (_, index) => ({
            tags: [link(`t-${index % 7}`), link(`t-${(index + 3) % 7}`)],
          })),
        );
        documentsByTag(many.items);
        return many;
      });
    expect(perDocument(2_000)).toBeLessThanOrEqual(perDocument(500) * 1.25);
  });
});
