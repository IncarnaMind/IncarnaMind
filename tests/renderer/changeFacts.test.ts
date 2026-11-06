import { describe, expect, test } from "vitest";
import {
  appliedFact,
  type ChangeCounts,
  changeFact,
  inNoteText,
  keptText,
  leftText,
  stillWaiting,
} from "../../src/renderer/src/changeFacts";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const t =
  (language: "en" | "zh-CN") =>
  (key: MessageKey, params?: MessageParams): string =>
    translate(language, key, params);

const row = (counts: Partial<ChangeCounts>): ChangeCounts => ({
  created: false,
  changed: 0,
  wrote: 0,
  tables: 0,
  ...counts,
});

describe("The panel's line after the assistant applied a change (#1559)", () => {
  // protects=the three lines the issue settles, in English and Chinese, and the count's line for any other change; fails_when=a line reads otherwise; no_claim=its Open and Undo.
  test.each([
    [{ ...row({ created: true, wrote: 3 }), filled: false }, "Wrote “Q3”", "已写入“Q3”"],
    [{ ...row({ wrote: 3 }), filled: true }, "Wrote it into “Q3”", "已写入空白的“Q3”"],
    [
      { ...row({ changed: 2 }), filled: false },
      "Changed 2 paragraphs in “Q3”",
      "已修改“Q3”中的 2 段",
    ],
    [
      { ...row({ changed: 1 }), filled: false },
      "Changed 1 paragraph in “Q3”",
      "已修改“Q3”中的 1 段",
    ],
    [
      { ...row({ wrote: 2 }), filled: false },
      "Added 2 paragraphs to “Q3”",
      "在“Q3”中添加了 2 个段落",
    ],
  ])("%o", (counts, english, chinese) => {
    expect(appliedFact(t("en"), counts, "Q3")).toBe(english);
    expect(appliedFact(t("zh-CN"), counts, "Q3")).toBe(chinese);
  });
});

describe("What an Answer did in a Mind, in words (#880), counted by paragraph (#1028)", () => {
  test.each([
    [
      row({ changed: 12 }),
      "Changed 12 paragraphs in “Q3”",
      "Changed 12 paragraphs",
      "修改了 12 个段落",
    ],
    [row({ changed: 1 }), "Changed 1 paragraph in “Q3”", "Changed 1 paragraph", "修改了 1 个段落"],
    [row({ wrote: 1 }), "Added 1 paragraph to “Q3”", "Added 1 paragraph", "添加了 1 个段落"],
    [
      row({ wrote: 3, filled: true }),
      "Wrote 3 paragraphs in “Q3”",
      "Wrote 3 paragraphs",
      "写入了 3 个段落",
    ],
    [
      row({ wrote: 3, tables: 1 }),
      "Added 3 paragraphs and a table to “Q3”",
      "Added 3 paragraphs and a table",
      "添加了 3 个段落和 1 个表格",
    ],
    [
      row({ created: true, wrote: 3 }),
      "Created “Q3” and wrote 3 paragraphs",
      "Wrote 3 paragraphs",
      "写入了 3 个段落",
    ],
    [
      row({ changed: 4, tables: 1 }),
      "Changed 4 paragraphs and added a table in “Q3”",
      "Changed 4 paragraphs and added a table",
      "修改了 4 个段落，添加了 1 个表格",
    ],
    [row({ tables: 2 }), "Added 2 tables to “Q3”", "Added 2 tables", "添加了 2 个表格"],
    [
      row({ tables: 1, charts: 1 }),
      "Added a table and a chart to “Q3”",
      "Added a table and a chart",
      "添加了 1 个表格和 1 个图表",
    ],
    [row({ charts: 1 }), "Added a chart to “Q3”", "Added a chart", "添加了 1 个图表"],
  ] as const)(
    "on the card and on the Mind's line, the same counts: %o",
    (counts, card, line, zhLine) => {
      expect(changeFact(t("en"), counts, "Q3")).toBe(card);
      expect(changeFact(t("en"), counts, null)).toBe(line);
      expect(changeFact(t("zh-CN"), counts, null)).toBe(zhLine);
    },
  );
});

describe("What still waits is said in changes, the number the Mind's bar shows (#1358)", () => {
  test.each([
    [row({ wrote: 3 }), 2, "· 2 changes waiting", "· 2 处修订待确认"],
    [row({ wrote: 3 }), 1, "· 1 change waiting", "· 1 处修订待确认"],
    [row({ changed: 12 }), 0, "· none waiting", "· 没有待确认的修订"],
    [row({ charts: 1 }), 1, "· 1 change waiting", "· 1 处修订待确认"],
    [row({ tables: 1, charts: 1 }), 2, "· 2 changes waiting", "· 2 处修订待确认"],
  ] as const)("after %o, with %i waiting", (counts, waiting, line, zhLine) => {
    expect(leftText(t("en"), counts, waiting)).toBe(line);
    expect(leftText(t("zh-CN"), counts, waiting)).toBe(zhLine);
  });

  test("nothing is said before the count is known, for a Mind that is gone, or when nothing was done", () => {
    expect(leftText(t("en"), row({ wrote: 3 }), null)).toBeNull();
    expect(leftText(t("en"), row({ wrote: 3 }), "gone")).toBeNull();
    expect(leftText(t("en"), row({}), 2)).toBeNull();
  });

  test("while the Answer runs, what applies at once is not waiting; what it holds back is", () => {
    const made = row({ created: true, wrote: 35 });
    // A Note the assistant made: all 22 of its changes in the Note's record apply at once.
    expect(stillWaiting({ count: 22, applying: 22 })).toBeNull();
    expect(leftText(t("en"), made, stillWaiting({ count: 22, applying: 22 }))).toBeNull();
    expect(leftText(t("zh-CN"), made, stillWaiting({ count: 22, applying: 22 }))).toBeNull();
    // One held back beside them waits, and is the only one said.
    expect(stillWaiting({ count: 23, applying: 22 })).toBe(1);
    expect(leftText(t("en"), made, stillWaiting({ count: 23, applying: 22 }))).toBe(
      "· 1 change waiting",
    );
    expect(leftText(t("zh-CN"), made, stillWaiting({ count: 23, applying: 22 }))).toBe(
      "· 1 处修订待确认",
    );
    // Nothing applying at once: every change waits, and none left reads as none.
    expect(stillWaiting({ count: 2, applying: 0 })).toBe(2);
    expect(stillWaiting({ count: 0, applying: 0 })).toBe(0);
    expect(stillWaiting({ count: null, applying: 0 })).toBeNull();
    expect(stillWaiting({ count: "gone", applying: 0 })).toBe("gone");
    expect(stillWaiting(undefined)).toBeNull();
  });
});

describe("Why a chart asked for wasn't drawn (#1091)", () => {
  test.each([
    ["uncited", "· No chart: some figures have no Citation", "· 没有生成图表：有些数字没有引用"],
    [
      "needsTwo",
      "· No chart: a scatter chart needs two columns of numbers",
      "· 没有生成图表：散点图需要两列数字",
    ],
  ] as const)("%s is said after the count", (problem, english, chinese) => {
    const kept = {
      mindId: "a",
      created: false,
      filled: false,
      requests: ["r"],
      wrote: 0,
      changed: 0,
      tables: 1,
      charts: 0,
      chartNotDrawn: problem,
      unlinkedSources: 0,
      droppedSources: 0,
      extraCells: 0,
    };
    expect(keptText(t("en"), kept)).toBe(english);
    expect(keptText(t("zh-CN"), kept)).toBe(chinese);
  });
});

describe("The card's second fact: what waits in the Note (#1897)", () => {
  // protects=the card adds the Note's own count only when other changes wait there too, counting this request's own, in English and Chinese; fails_when=it shows when only this request's changes wait, or when nothing waits, or leaves out the request's own; no_claim=where it is drawn.
  test.each([
    {
      total: 10,
      own: 0,
      english: "· 10 changes waiting in this note",
      chinese: "· 本笔记有 10 处修订待处理",
    },
    {
      total: 11,
      own: 1,
      english: "· 11 changes waiting in this note",
      chinese: "· 本笔记有 11 处修订待处理",
    },
    {
      total: 1,
      own: 0,
      english: "· 1 change waiting in this note",
      chinese: "· 本笔记有 1 处修订待处理",
    },
  ])("$total waiting, $own of them this request's", ({ total, own, english, chinese }) => {
    expect(inNoteText(t("en"), total, own)).toBe(english);
    expect(inNoteText(t("zh-CN"), total, own)).toBe(chinese);
  });

  test("nothing more is said when only this request's changes wait, when none wait, or while the count is unknown", () => {
    expect(inNoteText(t("en"), 3, 3)).toBeNull();
    expect(inNoteText(t("en"), 0, 0)).toBeNull();
    expect(inNoteText(t("en"), null, 0)).toBeNull();
    expect(inNoteText(t("en"), "gone", 0)).toBeNull();
    expect(inNoteText(t("zh-CN"), 2, 2)).toBeNull();
  });
});

describe("Whole paragraphs removed, said as removed on the card and the line (#2356)", () => {
  // protects=a change that only removes whole paragraphs says on the Answer's card and the line over the Note what went, by the paragraph's label or first words and its sentences, in English and Chinese, one paragraph or several, one sentence or more; a removal beside another change still says it changed; fails_when=a removal reads as "Changed", or the counts or the name are wrong; no_claim=the Note's own text.
  test.each([
    [
      row({ changed: 1, removed: { paragraphs: 1, sentences: 3, start: "Parking" } }),
      "Removed the paragraph “Parking” (3 sentences) from “Q3”",
      "Removed the paragraph “Parking” (3 sentences)",
      "从“Q3”中删除了“Parking”一段（3 句）",
      "删除了“Parking”一段（3 句）",
    ],
    [
      row({ changed: 1, removed: { paragraphs: 1, sentences: 1, start: "停车位" } }),
      "Removed the paragraph “停车位” (1 sentence) from “Q3”",
      "Removed the paragraph “停车位” (1 sentence)",
      "从“Q3”中删除了“停车位”一段（1 句）",
      "删除了“停车位”一段（1 句）",
    ],
    [
      row({ changed: 1, removed: { paragraphs: 1, sentences: 2, start: "The boat leaves at…" } }),
      "Removed the paragraph “The boat leaves at…” (2 sentences) from “Q3”",
      "Removed the paragraph “The boat leaves at…” (2 sentences)",
      "从“Q3”中删除了“The boat leaves at…”一段（2 句）",
      "删除了“The boat leaves at…”一段（2 句）",
    ],
    [
      row({ changed: 2, removed: { paragraphs: 2, sentences: 5, start: "Parking" } }),
      "Removed 2 paragraphs (5 sentences) from “Q3”",
      "Removed 2 paragraphs (5 sentences)",
      "从“Q3”中删除了 2 个段落（5 句）",
      "删除了 2 个段落（5 句）",
    ],
    [
      row({ changed: 2, removed: { paragraphs: 1, sentences: 3, start: "Parking" } }),
      "Changed 2 paragraphs in “Q3”",
      "Changed 2 paragraphs",
      "已修改“Q3”中的 2 段",
      "修改了 2 个段落",
    ],
  ])("%o", (counts, card, line, zhCard, zhLine) => {
    expect(appliedFact(t("en"), { ...counts, filled: false }, "Q3")).toBe(card);
    expect(changeFact(t("en"), counts, null)).toBe(line);
    expect(appliedFact(t("zh-CN"), { ...counts, filled: false }, "Q3")).toBe(zhCard);
    expect(changeFact(t("zh-CN"), counts, null)).toBe(zhLine);
  });
});
