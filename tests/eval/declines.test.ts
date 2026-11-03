/**
 * The phrase rule that says whether an Answer to an unanswerable Question
 * declines (eval/lib/declines.ts), and where its result goes: the reviewer
 * sheet and the file of Answers.
 */
import { describe, expect, test } from "vitest";
import type { AnswerRecord, CitationRun } from "../../eval/lib/citations";
import { declines } from "../../eval/lib/declines";
import { answersText, reviewerSheet } from "../../eval/lib/report";

describe("An Answer that declines", () => {
  test.each([
    "The Documents don't say how many people the company employed in 2023. The closest they come is the 2022 figure, 5,000 [^1].",
    "The Documents don’t say what the 2023 headcount was.",
    "That isn't in your Documents.",
    "The headcount for 2023 is not mentioned in the report.",
    "The 2022 report does not state a 2023 figure, only the one for 2022 [^1].",
    "There is no information about a 2023 headcount in the Documents.",
    "None of the Documents cover the 2023 headcount.",
    "I couldn't find a 2023 headcount. The 2022 report says 5,000 [^1].",
    "The 2023 headcount cannot be determined from the passages.",
    "I don't know: it isn't something the sources address.",
    "未在“北域零售 2026年第二季度季报”中找到现金转换周期。",
    "文档中没有提到2023年的员工人数。最接近的是2022年的数据：5,000人[^1]。",
    "文档未说明2023年的员工人数。",
    "没有找到相关内容，报告只给出了2022年的人数[^1]。",
    "文档并未提及2023年的数据。",
    "无法从文档中确定2023年的员工人数。",
    "这不在您的文档中。",
    "The answer isn't in what you were given.",
    "It is not in the passages.",
    "资料里并未披露2023年的金额。",
    "我在文档里找不到2023年的员工人数。",
    "我不知道答案。",
  ])("is found by the rule: %s", (text) => {
    expect(declines(text)).toBe(true);
  });
});

describe("An Answer that cites a nearby fact without declining", () => {
  test.each([
    "The 2022 report gives a headcount of 5,000 employees [^1].",
    "The company employed 5,000 people at the end of 2022, up from 4,200 [^1][^2].",
    "The report doesn't just list headcount: it breaks it down by region [^1].",
    "The company has no debt and employed 5,000 people in 2022 [^1].",
    "The 2023 headcount is 5,000 [^1].",
    "The policy was not in effect until 2023 [^1].",
    "Sales were not in line with forecasts in 2022 [^1].",
    "公司未披露具体金额[^1]。",
    "报告没有显示亏损[^1]。",
    "报告给出了2022年的员工人数：5,000人[^1]。",
    "截至2022年底，公司员工总数为5,000人，同比增长19%[^1]。",
    "公司2022年没有裁员，员工人数保持在5,000人[^1]。",
    "",
  ])("is not found by the rule: %s", (text) => {
    expect(declines(text)).toBe(false);
  });
});

const record = (overrides: Partial<AnswerRecord>): AnswerRecord => ({
  questionId: "un-01",
  language: "en",
  crossLingual: false,
  round: 1,
  question: "How many people did it employ in 2023?",
  status: "done",
  error: null,
  citationSupport: "tools",
  searches: [],
  droppedMarkers: 0,
  droppedRecords: 0,
  rejectedRecords: [],
  text: "",
  sentences: [],
  citations: [],
  seconds: 1,
  ...overrides,
});

describe("The reviewer sheet and the file of Answers", () => {
  const answers = [
    record({ text: "It isn't in your Documents.", declines: true }),
    record({
      questionId: "un-02",
      text: 'It employed 5,000 people, "roughly".',
      declines: false,
    }),
    record({ questionId: "un-03", text: "", status: "failed", declines: false }),
    record({ questionId: "an-01", text: "A plain Answer." }),
  ];
  const run = { model: "anthropic/test", answers } as CitationRun;

  test("the sheet has a row with the text for each Answer the rule didn't take as a decline", () => {
    expect(reviewerSheet(run).slice(1).split("\r\n")).toEqual([
      "question_id,language,round,question,answer_sentence,quote,document,page,supports (y/n),answer (the rule found no decline),decline missed by the rule (y/n),note",
      'un-02,en,1,How many people did it employ in 2023?,,,,,,"It employed 5,000 people, ""roughly"".",,',
      "",
    ]);
  });

  test("the file of Answers holds each Answer's text under its Question", () => {
    const lines = answersText(run).split("\n");
    expect(lines).toContain("## un-01, round 1, en");
    expect(lines).toContain("Question: How many people did it employ in 2023?");
    expect(lines).toContain("Status: done; the rule found a decline");
    expect(lines).toContain("It isn't in your Documents.");
    expect(lines).toContain("Status: done; the rule did not find a decline");
    expect(lines).toContain("(no text)");
    expect(lines).toContain("Status: done");
    expect(lines).toContain("A plain Answer.");
  });
});
