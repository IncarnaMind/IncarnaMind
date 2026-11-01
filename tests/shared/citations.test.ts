import { describe, expect, test } from "vitest";
import type { CitationAttributes, CitationRecheck } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import {
  badgeMessage,
  changedOnMessage,
  changedSourceNote,
  citationAttributesOf,
  citationCheckRan,
  citationReference,
  citationSource,
  citationState,
  citationSubject,
  citedLocation,
  citedTextKept,
  closestWordsMessage,
  fetchedAgainOn,
  footnoteSubjectKey,
  parseQuotedWords,
  quotedWordsFoundIn,
  quoteStanding,
  shownDocumentName,
  versionMoment,
  withShownName,
} from "../../src/shared/citations";
import { formatDate } from "../../src/shared/dates";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { englishPrintedLocation, parseLocation } from "../../src/shared/locations";
import { findQuoteInPages } from "../../src/shared/quoteMatch";

/** A Citation from before Locations: its pages say where it points. */
const found: CitationAttributes = {
  passageId: "passage",
  documentId: "tides",
  documentName: "Tides",
  contentHash: "abc",
  pageFrom: 12,
  pageTo: 13,
  location: null,
  quote: "Spring tides happen at new moon.",
  check: "found",
  checkReason: null,
};

/** Words in a language, as the renderer's `t` does. */
const in_ = (language: Language) => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

const words = (
  attributes: Partial<CitationAttributes>,
  documents = [{ id: "tides", contentHash: "abc" }],
) => {
  const state = citationState(attributes, documents);
  const en = badgeMessage(state, attributes, in_("en"));
  const zh = badgeMessage(state, attributes, in_("zh-CN"));
  return {
    en: translate("en", en.key, en.params),
    zh: translate("zh-CN", zh.key, zh.params),
  };
};

describe("Where a Citation points", () => {
  const sheetCitation = (documentName: string, sheet: string) => ({
    ...found,
    documentName,
    location: { kind: "rows" as const, sheet, from: 3, to: 3 },
  });

  test("names the sheet unless it shares the Document's name", () => {
    expect(citationSource(sheetCitation("利润表", "利润表"), in_("zh-CN")).text).toBe(
      "利润表，第 3 行",
    );
    expect(citationSource(sheetCitation("Budget.xlsx", "Budget"), in_("en")).text).toBe(
      "Budget.xlsx, row 3",
    );
    expect(citationSource(sheetCitation("年报.xlsx", "利润表"), in_("zh-CN")).text).toBe(
      "年报.xlsx，利润表，第 3 行",
    );
  });
});

describe("The name a Citation shows for its Document", () => {
  const renamed = [{ id: "tides", contentHash: "abc", name: "Tide tables" }];

  test("is the Document's current name while it is there, and the stored one when it can't be found", () => {
    expect(shownDocumentName(found, renamed)).toBe("Tide tables");
    expect(shownDocumentName(found, [])).toBe("Tides");
    expect(shownDocumentName(found, null)).toBe("Tides");
    expect(shownDocumentName({ ...found, documentName: null }, [])).toBeNull();
    // A Document with the same content, added again after the first was deleted, is the one it opens.
    const again = [{ id: "tides-again", contentHash: "abc", name: "Tides (again)" }];
    expect(shownDocumentName(found, again)).toBe("Tides (again)");
    // Documents that don't say their names leave the stored one.
    expect(shownDocumentName(found, [{ id: "tides", contentHash: "abc" }])).toBe("Tides");
  });

  test("is in the badge, the label and the card's line, and the stored attribute is left alone", () => {
    const shown = withShownName(found, renamed);
    expect(shown.documentName).toBe("Tide tables");
    expect(found.documentName).toBe("Tides");
    expect(citationSource(shown, in_("en")).text).toBe("Tide tables, p. 12–13");
    expect(withShownName(found, [])).toBe(found);
    const undated = { ...found, location: null, pageFrom: null, pageTo: null };
    const state = citationState(undated, renamed);
    expect(badgeMessage(state, withShownName(undated, renamed), in_("en")).params).toEqual({
      document: "Tide tables",
    });
  });
});

describe("A Citation's badge", () => {
  test("says where the quote was found or not found, in words, and never that the sentence is verified", () => {
    expect(words(found)).toEqual({ en: "Quote found on p. 12–13", zh: "已在第 12–13 页找到引文" });
    expect(
      words({ ...found, pageTo: 12, check: "not-found", checkReason: "quote-not-on-pages" }),
    ).toEqual({
      en: "Quote not found on p. 12",
      zh: "未在第 12 页找到引文",
    });
    // Documents without pages (TXT, Markdown) are named instead.
    expect(words({ ...found, pageFrom: null, pageTo: null })).toEqual({
      en: "Quote found in Tides",
      zh: "已在“Tides”中找到引文",
    });
    const rows = (sheet: string) => ({
      ...found,
      documentName: "年报.xlsx",
      pageFrom: null,
      pageTo: null,
      location: { kind: "rows" as const, sheet, from: 3, to: 3 },
    });
    expect(words(rows("利润表"))).toEqual({
      en: "Quote found in 利润表, row 3",
      zh: "已在“利润表，第 3 行”中找到引文",
    });
    expect(
      words({
        ...found,
        pageFrom: null,
        pageTo: null,
        location: { kind: "section", heading: "2025年经营情况" },
      }),
    ).toEqual({
      en: "Quote found in § 2025年经营情况",
      zh: "已在“§ 2025年经营情况”中找到引文",
    });
    expect(
      words({
        ...found,
        check: "not-found",
        pageFrom: null,
        pageTo: null,
        location: { kind: "section", heading: "Tides" },
      }).zh,
    ).toBe("未在“§ Tides”中找到引文");
    expect(words({ ...found, check: "checking" }).en).toBe("Checking…");
    expect(words({ ...found, check: "checking" }).zh).toBe("正在核对…");
    expect(words({ ...found, check: "not-checked" }).en).toBe("Not checked");
    expect(words({ ...found, check: "not-checked" }).zh).toBe("未核对");
    expect(words({ ...found, check: "cant-check", checkReason: "no-text" }).en).toBe("Can’t check");
    for (const check of ["found", "not-found", "cant-check", "checking", "not-checked"] as const) {
      expect(words({ ...found, check }).en).not.toMatch(/verif/i);
    }
  });

  test("a check ran only where it gave a result, never while checking or when it couldn't", () => {
    for (const check of ["found", "not-found", "unsupported", "contradicted"] as const) {
      expect(citationCheckRan(check), check).toBe(true);
    }
    for (const check of ["checking", "cant-check", "not-checked"] as const) {
      expect(citationCheckRan(check), check).toBe(false);
    }
  });

  test("turns to 'can't check' once the Document is deleted, unless the same file was added again", () => {
    expect(citationState(found, [])).toEqual({
      check: "cant-check",
      reason: "document-removed",
      documentId: null,
      changedAfterCited: false,
    });
    // Added again, the same content is a new Document: the Citation opens it.
    expect(citationState(found, [{ id: "tides-again", contentHash: "abc" }])).toEqual({
      check: "found",
      reason: null,
      documentId: "tides-again",
      changedAfterCited: false,
    });
    // While the Documents are loading, the stored result stands.
    expect(citationState(found, null)).toMatchObject({ check: "found", documentId: "tides" });
  });

  test("keeps its check once its Document is unlinked with its folder, while every Unit it cites is kept", () => {
    const text = { documentId: "tides", contentHash: "abc", units: [12, 13] };
    const kept = [text];
    expect(citationState(found, [], kept)).toEqual({
      check: "found",
      reason: null,
      documentId: null,
      changedAfterCited: false,
    });
    const notFound = {
      ...found,
      check: "not-found" as const,
      checkReason: "quote-not-on-pages" as const,
    };
    expect(citationState(notFound, [], kept)).toMatchObject({
      check: "not-found",
      reason: "quote-not-on-pages",
    });
    // Linked again, the same content is a live Document again: the Citation opens it.
    expect(citationState(found, [{ id: "tides-again", contentHash: "abc" }], kept)).toMatchObject({
      check: "found",
      documentId: "tides-again",
    });
    // Not when one of its Units, its version or its Document isn't the one kept.
    const removed = { check: "cant-check", reason: "document-removed" };
    expect(citationState(found, [], [{ ...text, units: [12] }])).toMatchObject(removed);
    expect(citationState(found, [], [{ ...text, contentHash: "def" }])).toMatchObject(removed);
    expect(citationState(found, [], [{ ...text, documentId: "rivers" }])).toMatchObject(removed);
    // A Citation that doesn't say which version it quotes takes any; one of a whole file, its text.
    expect(citationState({ ...found, contentHash: null }, [], kept).check).toBe("found");
    const whole = { ...found, pageFrom: null, pageTo: null };
    expect(citationState(whole, [], [{ ...text, units: [1] }]).check).toBe("found");
  });

  test("the viewer tells an unlinked Document whose quoted text was kept from a deleted one", () => {
    const kept = [{ documentId: "tides", contentHash: "abc", units: [12, 13] }];
    // As the viewer opens a Citation: its Document, version and Units.
    const opened = { documentId: "tides", contentHash: "abc", pageFrom: 12, pageTo: 13 };
    expect(citedTextKept(opened, kept)).toBe(true);
    expect(citedTextKept({ ...opened, contentHash: null }, kept)).toBe(true);
    // Deleted by the User, nothing is kept; nor of another version, or Unit.
    expect(citedTextKept(opened, [])).toBe(false);
    expect(citedTextKept({ ...opened, contentHash: "def" }, kept)).toBe(false);
    expect(citedTextKept({ ...opened, pageFrom: 14, pageTo: 14 }, kept)).toBe(false);
  });

  test("says when the Document changed after it was cited: the check stands for the version quoted", () => {
    expect(citationState(found, [{ id: "tides", contentHash: "abc" }])).toMatchObject({
      check: "found",
      changedAfterCited: false,
    });
    expect(citationState(found, [{ id: "tides", contentHash: "def" }])).toEqual({
      check: "found",
      reason: null,
      documentId: "tides",
      changedAfterCited: true,
    });
    // Not while it is being written, nor for a Citation that doesn't say which version it quotes.
    expect(
      citationState({ ...found, check: "checking" }, [{ id: "tides", contentHash: "def" }]),
    ).toMatchObject({ changedAfterCited: false });
    expect(
      citationState({ ...found, contentHash: null }, [{ id: "tides", contentHash: "def" }]),
    ).toMatchObject({ changedAfterCited: false });
  });

  test("keeps an old Citation's result and Document outside a wall, without re-checking it", () => {
    const state = citationState(
      { ...found, contentHash: "old" },
      [{ id: "tides", contentHash: "new" }],
      [],
      "Client A",
    );
    expect(state).toMatchObject({
      check: "found",
      reason: null,
      documentId: "tides",
      changedAfterCited: false,
      keptInside: "Client A",
    });
    // The heading stays the result it was made with; "Kept inside" is said once, under the name.
    expect(badgeMessage(state, found, in_("en")).key).toBe(
      badgeMessage(citationState(found, [{ id: "tides", contentHash: "abc" }]), found, in_("en"))
        .key,
    );
  });

  test("finds its Document by ID first, else the first in the list with the same content", () => {
    const documents = [
      { id: "rivers", contentHash: "xyz" },
      { id: "tides-copy", contentHash: "abc" },
      { id: "tides-again", contentHash: "abc" },
      { id: "tides", contentHash: "abc" },
    ];
    expect(citationState(found, documents).documentId).toBe("tides");
    expect(citationState({ ...found, documentId: "gone" }, documents).documentId).toBe(
      "tides-copy",
    );
    expect(citationState({ ...found, documentId: null }, documents).documentId).toBe("tides-copy");
    // A Document with no content yet is no match for a Citation that doesn't say its content.
    expect(
      citationState({ ...found, documentId: "gone", contentHash: "" }, [
        { id: "new", contentHash: "" },
      ]),
    ).toMatchObject({ check: "cant-check", documentId: null });
  });

  test("reads each new list of Documents afresh, and a long one once for all its Citations", () => {
    const before = [{ id: "tides", contentHash: "abc" }];
    expect(citationState(found, before).documentId).toBe("tides");
    // The store replaces the list when a Document goes or comes.
    expect(citationState(found, []).check).toBe("cant-check");
    expect(citationState(found, before).check).toBe("found");

    // 300 Citations against 2,000 Documents, as a long Mind is drawn: one pass over the list.
    const documents = Array.from({ length: 2000 }, (_, i) => ({
      id: `document-${i}`,
      contentHash: `content-${i}`,
    }));
    const citations = Array.from({ length: 300 }, (_, i) => ({
      ...found,
      documentId: `document-${i * 6}`,
      contentHash: `content-${i * 6}`,
    }));
    let visits = 0;
    const counted = new Proxy(documents, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) visits++;
        return Reflect.get(target, key, receiver);
      },
    });
    for (const citation of citations) {
      expect(citationState(citation, counted).documentId).toBe(citation.documentId);
    }
    expect(visits).toBeLessThanOrEqual(documents.length);
  });

  test("names its source in plain text, for copying and for Question context", () => {
    expect(citedLocation(found, in_("en"))).toBe("p. 12–13");
    expect(citationReference(found)).toBe("[Tides, p. 12–13]");
    expect(citationReference({ ...found, pageFrom: null, pageTo: null })).toBe("[Tides]");
  });
});

describe("The words an Answer put in quotation marks that a Citation's page lacks (#483)", () => {
  const notFound: CitationAttributes = {
    ...found,
    pageFrom: 3,
    pageTo: 3,
    check: "not-found",
    checkReason: "quoted-words-not-on-pages",
  };
  const closest = (attributes: Partial<CitationAttributes>) => {
    const en = closestWordsMessage(attributes, in_("en"));
    const zh = closestWordsMessage(attributes, in_("zh-CN"));
    return {
      en: translate("en", en.key, en.params),
      zh: translate("zh-CN", zh.key, zh.params),
    };
  };

  test("the label over the page's nearest words names the place the badge does", () => {
    expect(closest(notFound)).toEqual({
      en: "Closest words on p. 3",
      zh: "第 3 页最接近的文字",
    });
    expect(closest({ ...notFound, pageFrom: null, pageTo: null })).toEqual({
      en: "Closest words in Tides",
      zh: "“Tides”中最接近的文字",
    });
    expect(
      closest({
        ...notFound,
        pageFrom: null,
        pageTo: null,
        location: { kind: "time", from: 866_000, to: 870_000 },
      }),
    ).toEqual({
      en: "Closest words in the transcript at 14:26",
      zh: "转写稿 14:26 处最接近的文字",
    });
  });

  test("the badge is the existing not-found one, and the reason is worded for both languages", () => {
    expect(words(notFound)).toEqual({
      en: "Quote not found on p. 3",
      zh: "未在第 3 页找到引文",
    });
    expect(translate("en", "citation.reason.quoted-words-not-on-pages")).toContain(
      "The quoted words",
    );
    expect(translate("zh-CN", "citation.reason.quoted-words-not-on-pages")).toContain("引号");
  });

  test("quoted words are found only as the sentence wrote them, not piece by piece anywhere", () => {
    const passage =
      "The Employee may work from home two days a week, agreed in advance with the manager; the director approves leave.";
    // The sentence quoted "two days a week, director": the word "director" is on
    // the page, but not where the sentence put it.
    expect(
      quotedWordsFoundIn(passage, {
        answer: [
          { text: "two days a week, ", found: true },
          { text: "director", found: false },
        ],
        closest: null,
      }),
    ).toBe(false);
    expect(
      quotedWordsFoundIn(passage, {
        answer: [
          { text: "two days a week, ", found: true },
          { text: "agreed", found: true },
        ],
        closest: null,
      }),
    ).toBe(true);
    expect(quotedWordsFoundIn(passage, null)).toBe(true);
  });

  test("stored words are read back whole, or not at all", () => {
    const stored = {
      answer: [
        { text: "training ", found: false },
        { text: "coverage reached 98%", found: true },
      ],
      closest: [{ text: "Safety training: coverage reached 98%", found: false }],
    };
    expect(parseQuotedWords(stored)).toEqual(stored);
    expect(parseQuotedWords(JSON.stringify(stored))).toEqual(stored);
    expect(parseQuotedWords({ ...stored, closest: [] })).toEqual({ ...stored, closest: null });
    expect(parseQuotedWords({ answer: [] })).toBeNull();
    expect(parseQuotedWords({ answer: [{ text: 1, found: true }] })).toBeNull();
    expect(parseQuotedWords("not json")).toBeNull();
    expect(parseQuotedWords(undefined)).toBeNull();
  });
});

describe("A Citation's Location label (ADR-0011)", () => {
  const at = (location: CitationAttributes["location"], name = "Deck") => ({
    ...found,
    documentName: name,
    location,
  });

  test("shows a slide, a range of rows, a section and lines, in English and Chinese", () => {
    const cases: [CitationAttributes["location"], string, string][] = [
      [{ kind: "page", from: 4, to: 4 }, "p. 4", "第 4 页"],
      [{ kind: "slide", from: 4, to: 4 }, "slide 4", "第 4 张幻灯片"],
      [{ kind: "slide", from: 3, to: 4 }, "slides 3–4", "第 3–4 张幻灯片"],
      [
        { kind: "rows", sheet: "Revenue", from: 12, to: 14 },
        "Revenue, rows 12–14",
        "Revenue，第 12–14 行",
      ],
      [{ kind: "rows", sheet: "Revenue", from: 7, to: 7 }, "Revenue, row 7", "Revenue，第 7 行"],
      [{ kind: "rows", sheet: null, from: 2, to: 3 }, "rows 2–3", "第 2–3 行"],
      [{ kind: "section", heading: "2.1 Sensitivity" }, "§ 2.1 Sensitivity", "§ 2.1 Sensitivity"],
      [{ kind: "section", heading: null, start: true }, "§ Start", "§ 开头"],
      [{ kind: "section", heading: null, notes: true }, "§ Notes", "§ 注释"],
      [
        { kind: "section", heading: "2 Costs", comment: { author: "Reviewer" } },
        "§ 2 Costs, comment by Reviewer",
        "§ 2 Costs，Reviewer 的批注",
      ],
      [
        { kind: "section", heading: "二、运营数据", comment: { author: "王丽华" } },
        "§ 二、运营数据, comment by 王丽华",
        "§ 二、运营数据，王丽华 的批注",
      ],
      [
        { kind: "section", heading: null, start: true, comment: { author: null } },
        "§ Start, comment",
        "§ 开头，批注",
      ],
      [
        { kind: "section", heading: "History", paragraphs: { from: 3, to: 3 } },
        "§ History, ¶\u00a03",
        "§ History，第 3 段",
      ],
      [
        { kind: "section", heading: "唐代的茶", paragraphs: { from: 1, to: 2 } },
        "§ 唐代的茶, ¶\u00a01–2",
        "§ 唐代的茶，第 1–2 段",
      ],
      [
        { kind: "section", heading: null, start: true, paragraphs: { from: 2, to: 2 } },
        "§ Start, ¶\u00a02",
        "§ 开头，第 2 段",
      ],
      [{ kind: "lines", from: 120, to: 134 }, "lines 120–134", "第 120–134 行"],
    ];
    for (const [location, en, zh] of cases) {
      expect(citedLocation(at(location), in_("en"))).toBe(en);
      expect(citedLocation(at(location), in_("zh-CN"))).toBe(zh);
    }
  });

  describe("of a Document with no headings (#1601)", () => {
    const RESUME = "示例简历-设计师 2";
    const none = at({ kind: "section", heading: null }, RESUME);
    const paragraph = (from: number, to = from) =>
      at({ kind: "section", heading: null, paragraphs: { from, to } }, RESUME);

    test("is cited by its name alone, never as '§ Start', and not by the page a Unit number would make", () => {
      expect(citedLocation(none, in_("en"))).toBeNull();
      expect(citedLocation(none, in_("zh-CN"))).toBeNull();
      expect(citationSource(none, in_("zh-CN"))).toEqual({
        name: RESUME,
        where: null,
        text: RESUME,
      });
      expect(citationReference(none)).toBe(`[${RESUME}]`);
      expect(words(none)).toEqual({
        en: `Quote found in ${RESUME}`,
        zh: `已在“${RESUME}”中找到引文`,
      });
    });

    test("is cited by its paragraph when the Passage has one, in English and Chinese", () => {
      expect(citedLocation(paragraph(12), in_("en"))).toBe("¶\u00a012");
      expect(citedLocation(paragraph(12), in_("zh-CN"))).toBe("第 12 段");
      expect(citedLocation(paragraph(3, 4), in_("en"))).toBe("¶\u00a03–4");
      expect(citationSource(paragraph(12), in_("en")).text).toBe(`${RESUME}, ¶\u00a012`);
      expect(citationSource(paragraph(12), in_("zh-CN")).text).toBe(`${RESUME}，第 12 段`);
      expect(citationReference(paragraph(7))).toBe(`[${RESUME}, ¶\u00a07]`);
    });

    test("leaves out the section of a comment or a picture too", () => {
      const cases: [CitationAttributes["location"], string, string][] = [
        [
          { kind: "section", heading: null, comment: { author: "Reviewer" } },
          "comment by Reviewer",
          "Reviewer 的批注",
        ],
        [{ kind: "section", heading: null, comment: { author: null } }, "comment", "批注"],
        [{ kind: "section", heading: null, figure: 2 }, "figure\u00a02", "图 2"],
      ];
      for (const [location, en, zh] of cases) {
        expect(citedLocation(at(location), in_("en"))).toBe(en);
        expect(citedLocation(at(location), in_("zh-CN"))).toBe(zh);
      }
    });

    test("still says '§ Start' where the Document has headings and the text comes before the first", () => {
      expect(citedLocation(at({ kind: "section", heading: null, start: true }), in_("en"))).toBe(
        "§ Start",
      );
      expect(parseLocation({ kind: "section", heading: null, start: true })).toEqual({
        kind: "section",
        heading: null,
        start: true,
      });
      expect(parseLocation({ kind: "section", heading: null, start: "yes" })).toEqual({
        kind: "section",
        heading: null,
      });
    });
  });

  test("words the badge with the label: on a page, slide or lines; in rows or a section", () => {
    expect(words(at({ kind: "slide", from: 4, to: 4 }))).toEqual({
      en: "Quote found on slide 4",
      zh: "已在第 4 张幻灯片找到引文",
    });
    expect(words(at({ kind: "rows", sheet: "Revenue", from: 12, to: 14 })).en).toBe(
      "Quote found in Revenue, rows 12–14",
    );
    expect(
      words({
        ...at({ kind: "section", heading: "2.1 Sensitivity" }),
        check: "not-found",
        checkReason: "quote-not-on-pages",
      }),
    ).toEqual({
      en: "Quote not found in § 2.1 Sensitivity",
      zh: "未在“§ 2.1 Sensitivity”中找到引文",
    });
    expect(words(at({ kind: "lines", from: 120, to: 134 })).en).toBe(
      "Quote found on lines 120–134",
    );
    expect(
      words(at({ kind: "section", heading: "2 Costs", comment: { author: "Reviewer" } })),
    ).toEqual({
      en: "Quote found in § 2 Costs, comment by Reviewer",
      zh: "已在“§ 2 Costs，Reviewer 的批注”中找到引文",
    });
  });

  test("a comment's stored Location keeps its author, or none, and copies as text with it (#76)", () => {
    expect(
      citationReference(
        at({ kind: "section", heading: "2 Costs", comment: { author: "Reviewer" } }, "Library"),
      ),
    ).toBe("[Library, § 2 Costs, comment by Reviewer]");
    expect(
      parseLocation(
        JSON.stringify({ kind: "section", heading: "2 Costs", comment: { author: "Reviewer" } }),
      ),
    ).toEqual({ kind: "section", heading: "2 Costs", comment: { author: "Reviewer" } });
    expect(parseLocation({ kind: "section", heading: null, comment: { author: 3 } })).toEqual({
      kind: "section",
      heading: null,
      comment: { author: null },
    });
    expect(parseLocation({ kind: "section", heading: null, comment: true })).toEqual({
      kind: "section",
      heading: null,
    });
  });

  test("a web page's stored Location keeps its paragraphs, and copies as text with them (#261)", () => {
    const location = { kind: "section", heading: "History", paragraphs: { from: 2, to: 3 } };
    expect(parseLocation(JSON.stringify(location))).toEqual(location);
    expect(citationReference(at(location as CitationAttributes["location"], "Tea"))).toBe(
      "[Tea, § History, ¶\u00a02–3]",
    );
    expect(
      parseLocation({ kind: "section", heading: "History", paragraphs: { from: 3, to: 2 } }),
    ).toEqual({ kind: "section", heading: "History" });
  });

  test("copies as text with its label, and a stored Location that isn't one falls back to the pages", () => {
    expect(citationReference(at({ kind: "slide", from: 4, to: 4 }))).toBe("[Deck, slide 4]");
    expect(
      citationReference(at({ kind: "rows", sheet: "Revenue", from: 12, to: 14 }, "Model")),
    ).toBe("[Model, Revenue, rows 12–14]");
    const broken = {
      ...found,
      location: { kind: "slide", from: "x" },
    } as unknown as CitationAttributes;
    expect(citationReference(broken)).toBe("[Tides, p. 12–13]");
  });
});

describe("Finding a quote across pages in the viewer", () => {
  const line = (text: string) => ({ text, breakAfter: true });

  test("a quote across a page break is found though a footer, page number and header come between", () => {
    const pages = [
      [
        line("Annual Report"),
        line("Neap tides occur when the Sun"),
        line("and the Moon"),
        line("2"),
      ],
      [line("Annual Report"), line("pull at right angles."), line("3")],
    ];

    const found = findQuoteInPages(
      pages,
      "Neap tides occur when the Sun and the Moon pull at right angles.",
    );

    expect(found).toEqual([
      { page: 0, piece: 1, start: 0, end: 29 },
      { page: 0, piece: 2, start: 0, end: 12 },
      { page: 1, piece: 1, start: 0, end: 21 },
    ]);
  });

  test("a quote that isn't on the pages isn't found", () => {
    const pages = [[line("Spring tides happen at new moon.")], [line("Neap tides are small.")]];

    expect(findQuoteInPages(pages, "Spring tides are small.")).toBeNull();
    expect(findQuoteInPages(pages, "Neap tides are small.")).toEqual([
      { page: 1, piece: 0, start: 0, end: 21 },
    ]);
  });
});

describe("A Citation whose Document changed after it was cited", () => {
  const rechecked = (patch: Partial<CitationRecheck>): CitationRecheck => ({
    check: "found",
    checkReason: null,
    contentHash: "def",
    passageId: "passage-2",
    pageFrom: 12,
    pageTo: 13,
    location: { kind: "page", from: 12, to: 13 },
    ...patch,
  });

  test("finds the quote at its Location, at another one, or no longer there", () => {
    expect(quoteStanding(found, rechecked({}))).toBe("found");
    // A quote that now spans another Unit moved too.
    expect(quoteStanding(found, rechecked({ pageFrom: 14, pageTo: 15 }))).toBe("moved");
    expect(quoteStanding(found, rechecked({ pageTo: 14 }))).toBe("moved");
    expect(
      quoteStanding(found, rechecked({ check: "not-found", checkReason: "quote-not-on-pages" })),
    ).toBe("gone");
    // A whole file cited before Locations stays found as one text.
    expect(
      quoteStanding({ pageFrom: null, pageTo: null }, rechecked({ pageFrom: null, pageTo: null })),
    ).toBe("found");
    // Not while it isn't checked, or when the version can't be checked.
    expect(quoteStanding(found, null)).toBeNull();
    expect(
      quoteStanding(found, rechecked({ check: "cant-check", checkReason: "no-text" })),
    ).toBeNull();
  });

  test("tells a quote that moved to another rows or paragraph range of the same Unit", () => {
    const rows = {
      ...found,
      pageFrom: 2,
      pageTo: 2,
      location: { kind: "rows" as const, sheet: "Revenue", from: 12, to: 14 },
    };
    expect(
      quoteStanding(
        rows,
        rechecked({
          pageFrom: 2,
          pageTo: 2,
          location: { kind: "rows", sheet: "Revenue", from: 12, to: 14 },
        }),
      ),
    ).toBe("found");
    expect(
      quoteStanding(
        rows,
        rechecked({
          pageFrom: 2,
          pageTo: 2,
          location: { kind: "rows", sheet: "Revenue", from: 20, to: 21 },
        }),
      ),
    ).toBe("moved");
    // A Citation that doesn't say where in the Unit it points is compared by Unit.
    expect(quoteStanding({ ...rows, location: null }, rechecked({ pageFrom: 2, pageTo: 2 }))).toBe(
      "found",
    );
    const section = {
      ...found,
      pageFrom: 1,
      pageTo: 1,
      location: {
        kind: "section" as const,
        heading: "Budget",
        paragraphs: { from: 3, to: 3 },
      },
    };
    expect(
      quoteStanding(
        section,
        rechecked({
          pageFrom: 1,
          pageTo: 1,
          location: { kind: "section", heading: "Budget", paragraphs: { from: 4, to: 4 } },
        }),
      ),
    ).toBe("moved");
  });

  test("says the Document changed and how the quote stands, in English and Chinese", () => {
    const note = (patch: Partial<CitationRecheck>, language: Language) =>
      changedSourceNote(true, found, rechecked(patch), in_(language));
    // The quote still at the Location it cites: said, and quiet about a move.
    expect(note({}, "en")).toEqual({
      notice: "The Document changed after this was cited.",
      quote: "The quote is still here.",
    });
    expect(note({}, "zh-CN")).toEqual({
      notice: "此文档在被引用后有改动。",
      quote: "引文仍在原处。",
    });
    expect(
      note({ pageFrom: 14, pageTo: 14, location: { kind: "section", heading: "Budget" } }, "en"),
    ).toEqual({
      notice: "The Document changed after this was cited.",
      quote: "Its quote is now at § Budget.",
    });
    expect(
      note({ pageFrom: 14, pageTo: 14, location: { kind: "section", heading: "Budget" } }, "zh-CN"),
    ).toEqual({
      notice: "此文档在被引用后有改动。",
      quote: "引文已移到§ Budget。",
    });
    expect(note({ check: "not-found", checkReason: "quote-not-on-pages" }, "en")).toEqual({
      notice: "The Document changed after this was cited.",
      quote: "Its quote is no longer in the new version.",
    });
    expect(note({ check: "not-found", checkReason: "quote-not-on-pages" }, "zh-CN")).toEqual({
      notice: "此文档在被引用后有改动。",
      quote: "新版本中已找不到这条引文。",
    });
    // Changed, but the new version can't be checked: the notice alone.
    expect(note({ check: "cant-check", checkReason: "no-text" }, "en")).toEqual({
      notice: "The Document changed after this was cited.",
      quote: null,
    });
    // Changed, but the re-check couldn't run: the notice alone too.
    expect(changedSourceNote(true, found, "failed", in_("en"))).toEqual({
      notice: "The Document changed after this was cited.",
      quote: null,
    });
  });

  test("a saved web page says on what day it was fetched again, and that the copy cited is kept", () => {
    expect(changedSourceNote(true, found, "failed", in_("en"), "21 October 2026")).toEqual({
      notice:
        "This page was fetched again on 21 October 2026, after you cited it. What’s shown is the new copy; the one you cited is kept.",
      quote: null,
    });
    expect(changedSourceNote(true, found, "failed", in_("zh-CN"), "2026年10月21日")).toEqual({
      notice:
        "此网页在你引用后于 2026年10月21日 重新抓取。这里显示的是新版本，你引用的版本仍保留。",
      quote: null,
    });
    // The words about how the quote stands in the new version are the same as for a file.
    expect(changedSourceNote(true, found, rechecked({}), in_("en"), "21 October 2026")?.quote).toBe(
      "The quote is still here.",
    );
  });

  test("only a saved web page has a day it was fetched again, and it is the day of the version it now holds", () => {
    const file = {
      contentHash: "b",
      modifiedAt: "2026-10-21T12:00:00Z",
      updatedAt: "2026-10-24T09:00:00Z",
      web: null,
    };
    expect(fetchedAgainOn(file, "en")).toBeNull();
    expect(fetchedAgainOn(undefined, "en")).toBeNull();
    const page = {
      ...file,
      web: {
        fetchedAt: "2026-10-25T08:00:00Z",
        versions: [{ contentHash: "b", fetchedAt: "2026-10-23T08:00:00Z" }],
      },
    };
    expect(fetchedAgainOn(page, "en")).toBe(formatDate("2026-10-23T08:00:00Z", "en"));
    expect(fetchedAgainOn(page, "zh-CN")).toBe(formatDate("2026-10-23T08:00:00Z", "zh-CN"));
  });

  test("names the day the version it now opens was made", () => {
    const document = {
      contentHash: "b",
      modifiedAt: "2026-10-21T12:00:00Z",
      updatedAt: "2026-10-24T09:00:00Z",
      web: null,
    };
    expect(versionMoment(document)).toBe("2026-10-21T12:00:00Z");
    // A web page changed when the version it now holds was fetched, not at a later fetch.
    expect(
      versionMoment({
        ...document,
        web: {
          fetchedAt: "2026-10-25T08:00:00Z",
          versions: [
            { contentHash: "a", fetchedAt: "2026-10-20T08:00:00Z" },
            { contentHash: "b", fetchedAt: "2026-10-23T08:00:00Z" },
          ],
        },
      }),
    ).toBe("2026-10-23T08:00:00Z");
    // A Document with no file of its own has when it was indexed.
    expect(versionMoment({ ...document, modifiedAt: null })).toBe("2026-10-24T09:00:00Z");
    const moment = "2026-10-21T12:00:00Z";
    expect(changedOnMessage(true, moment, "en", in_("en"))).toBe(
      `This Document changed on ${formatDate(moment, "en")}.`,
    );
    expect(changedOnMessage(true, moment, "zh-CN", in_("zh-CN"))).toBe(
      `此文档已于 ${formatDate(moment, "zh-CN")} 更新。`,
    );
    expect(changedOnMessage(false, moment, "en", in_("en"))).toBeNull();
    expect(changedOnMessage(true, null, "en", in_("en"))).toBeNull();
  });

  test("says the Document changed at once, and says nothing while it is unchanged", () => {
    expect(changedSourceNote(false, found, rechecked({}), in_("en"))).toBeNull();
    // The new version isn't looked for yet: the Document changed, so say it now.
    expect(changedSourceNote(true, found, null, in_("en"))).toEqual({
      notice: "The Document changed after this was cited.",
      quote: null,
    });
  });
});

describe("a Citation's attributes as a node holds them", () => {
  test("are read as the Citation they hold, with its Location from the pages", () => {
    expect(citationAttributesOf({ ...found })).toEqual({
      ...found,
      checkReason: undefined,
      location: { kind: "page", from: 12, to: 13 },
    });
  });

  test("leave out what is missing or isn't the right type", () => {
    expect(
      citationAttributesOf({ documentId: 7, check: "maybe", pageFrom: "3", quote: ["x"] }),
    ).toEqual({
      passageId: null,
      documentId: null,
      documentName: null,
      contentHash: null,
      pageFrom: null,
      pageTo: null,
      location: null,
      quote: null,
    });
  });
});

describe("What makes two Citations one footnote (#2292)", () => {
  const citation = (over: Partial<CitationAttributes> = {}): Partial<CitationAttributes> => ({
    documentId: "doc-1",
    contentHash: "v1",
    pageFrom: 2,
    pageTo: 2,
    check: "found",
    ...over,
  });

  const keyOf = (over: Partial<CitationAttributes> = {}) =>
    footnoteSubjectKey(citationSubject(citation(over), { documents: null }));

  test("the Document and version, the place and the check make the key", () => {
    expect(keyOf()).toBe(keyOf());
    expect(keyOf()).toBe(
      footnoteSubjectKey({
        documentId: "doc-1",
        contentHash: "v1",
        location: { kind: "page", from: 2, to: 2 },
        unverified: false,
      }),
    );
    for (const other of [
      { documentId: "doc-2" },
      { contentHash: "v2" },
      { pageFrom: 3, pageTo: 3 },
      { check: "not-found" as const },
    ]) {
      expect(keyOf(other)).not.toBe(keyOf());
    }
  });

  test("a Document removed since makes a found and a not-found Citation one unverified footnote", () => {
    const documents = [{ id: "doc-1", contentHash: "v1" }];
    const found = citation({ check: "found" });
    const missing = citation({ check: "not-found" });
    expect(footnoteSubjectKey(citationSubject(found, { documents }))).not.toBe(
      footnoteSubjectKey(citationSubject(missing, { documents })),
    );
    expect(footnoteSubjectKey(citationSubject(found, { documents: [] }))).toBe(
      footnoteSubjectKey(citationSubject(missing, { documents: [] })),
    );
  });

  test("two places that read alike are still two places", () => {
    const printed = { from: "12", to: "12" };
    const firstLocation = { kind: "page" as const, from: 3, to: 3, printed };
    const secondLocation = { kind: "page" as const, from: 4, to: 4, printed };
    expect(englishPrintedLocation(firstLocation)).toBe(englishPrintedLocation(secondLocation));
    const first = { ...citation(), location: firstLocation };
    const second = { ...citation(), location: secondLocation };
    expect(keyOf(first)).not.toBe(keyOf(second));
  });
});
