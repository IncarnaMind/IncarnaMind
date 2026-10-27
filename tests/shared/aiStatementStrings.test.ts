import { describe, expect, test } from "vitest";
import { type AiUseFigures, USES } from "../../src/core/aiUseStatement/figures";
import { statementBlocks } from "../../src/core/aiUseStatement/template";
import type { NodeJSON } from "../../src/shared/blockJson";
import { type MessageKey, translate } from "../../src/shared/i18n";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

/*
 * The AI use statement (#739) states counts of what a Mind records. It never
 * promises to lower or to predict an AI-detection score, and no string of the
 * interface says it does: a test keeps the words of that promise out of every
 * string, and of every template.
 */

/** Written together, so "降 AI 率" and "Un detectable" are caught as well. */
const squash = (value: string) => value.toLowerCase().replace(/\s+/g, "");

const PROMISES = ["降ai率", "降重", "降低ai率", "bypass", "undetectable"];

/** What a statement has no business saying: a score, a rate or a percentage, or a word about detection. */
const SCORES = ["%", "％", "score", "detect", "plagiar", "查重", "检测", "ai率", "aigc率", "评分"];

const textOf = (node: NodeJSON): string =>
  node.type === "text" ? (node.text ?? "") : (node.content ?? []).map(textOf).join("\n");

const everything: AiUseFigures = {
  uses: [
    ...USES.map((use) => ({ use, model: "Claude Haiku 5.5 (Anthropic)", times: 12 })),
    { use: "answer" as const, model: null, times: 1 },
  ],
  headings: true,
  sections: [
    { title: null, kept: 1, rewritten: 0, words: 40 },
    { title: "第一章 绪论", kept: 2, rewritten: 3, words: 1_200 },
    { title: "Methods", kept: 0, rewritten: 1, words: 15 },
  ],
  removed: 2,
  citations: { found: 9, notFound: 1, cantCheck: 1, unsupported: 1, contradicted: 1, checking: 1 },
  sentences: {
    supported: 3,
    unsupported: 2,
    notFound: 1,
    contradicted: 1,
    needsRecheck: 1,
    notChecked: 1,
  },
  checked: [
    {
      sentence: "Spring tides come at new and full moon.",
      result: "supported",
      model: "Claude Haiku 5.5 (Anthropic)",
      checkedAt: "2026-10-14T09:00:00.000Z",
    },
    {
      sentence: "潮汐是海水的周期性涨落，由月球引力…",
      result: "changed",
      model: null,
      checkedAt: "2026-10-13T09:00:00.000Z",
    },
  ],
  unread: [
    {
      id: "contract",
      name: "合同.doc",
      reason: "format",
      extension: ".doc",
      documentId: null,
      pages: [],
    },
    {
      id: "scan",
      name: "Scan.pdf",
      reason: "scan",
      extension: null,
      documentId: "scan",
      pages: [],
    },
  ],
  unreadNames: true,
};
const nothing: AiUseFigures = {
  uses: [],
  headings: false,
  sections: [],
  removed: 0,
  citations: { found: 0, notFound: 0, cantCheck: 0, unsupported: 0, contradicted: 0, checking: 0 },
  sentences: {
    supported: 0,
    unsupported: 0,
    notFound: 0,
    contradicted: 0,
    needsRecheck: 0,
    notChecked: 0,
  },
  checked: [],
  unread: [],
  unreadNames: false,
};
/** The same record with the Mind not naming its files: the sentence ends in a full stop, no list. */
const unticked: AiUseFigures = { ...everything, unreadNames: false };
const FIGURES = { everything, unticked, nothing };

const statementKeys = (Object.keys(en) as MessageKey[]).filter((key) =>
  key.startsWith("aiStatement."),
);

describe("the words of the AI use statement", () => {
  test("no string of the interface promises to lower an AI-detection score or to get past one", () => {
    const found = [
      ...Object.entries(en).map(([key, value]) => ["en", key, value]),
      ...Object.entries(zhCN).map(([key, value]) => ["zh-CN", key, value]),
    ].filter(([, , value]) => PROMISES.some((promise) => squash(value ?? "").includes(promise)));
    expect(found).toEqual([]);
  });

  describe.each(["en", "zh-CN"] as const)("the %s template", (language) => {
    test.each(Object.entries(FIGURES))(
      "says no word of scores, rates or detection, and none of a promise to beat one (%s)",
      (_, figures) => {
        const said = squash(
          statementBlocks(figures, language, "2026-10-14T09:00:00.000Z").map(textOf).join("\n"),
        );
        expect(PROMISES.filter((word) => said.includes(word))).toEqual([]);
        expect(SCORES.filter((word) => said.includes(word))).toEqual([]);
      },
    );

    test.each(Object.entries(FIGURES))(
      "ends with one line saying schools have their own forms (%s)",
      (_, figures) => {
        const blocks = statementBlocks(figures, language, "2026-10-14T09:00:00.000Z");
        expect(blocks.at(-1)).toEqual({
          type: "paragraph",
          content: [{ type: "text", text: translate(language, "aiStatement.note") }],
        });
        expect(
          blocks.filter((block) => textOf(block).includes(translate(language, "aiStatement.note"))),
        ).toHaveLength(1);
      },
    );
  });

  test("the empty statement says there is nothing to report, and holds no table", () => {
    for (const language of ["en", "zh-CN"] as const) {
      const blocks = statementBlocks(nothing, language, "2026-10-14T09:00:00.000Z");
      expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
      expect(textOf(blocks[1] as NodeJSON)).toBe(translate(language, "aiStatement.empty"));
    }
  });

  test.each(statementKeys)("%s is in English and in Chinese, and the Chinese is Chinese", (key) => {
    const params = { name: "Essay", date: "14 Oct 2026", count: 3 };
    const english = translate("en", key, params);
    const chinese = translate("zh-CN", key, params);
    expect(english).not.toBe("");
    expect(chinese).toMatch(/\p{Script=Han}/u);
    expect(chinese).not.toBe(english);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((each) => each[1]);
    expect(placeholders(en[key])).toEqual(placeholders(zhCN[key]));
  });

  test("the Chinese never says 您, and keeps a space between Chinese and Latin letters or digits", () => {
    for (const key of statementKeys) {
      const text = zhCN[key];
      expect(text).not.toContain("您");
      expect(text).not.toMatch(/[\p{Script=Han}][A-Za-z0-9]|[A-Za-z0-9][\p{Script=Han}]/u);
    }
  });
});
