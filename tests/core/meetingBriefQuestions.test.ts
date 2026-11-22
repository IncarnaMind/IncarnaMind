import { expect, test } from "vitest";
import type { Citation } from "../../src/core/api";
import {
  type BriefSource,
  briefQuestionsPrompt,
  completeBriefAnswer,
  readBriefQuestions,
} from "../../src/core/meetings/briefQuestions";

test("questions only show a verified answer from the actual source version and hide unsupported model claims", () => {
  const source: BriefSource = {
    title: "Price sheet",
    text: "Support costs €540 per year.",
    passageId: "passage",
    documentId: "document",
    contentHash: "hash",
  };
  const checked: Citation = {
    ...source,
    documentName: source.title,
    pageFrom: 1,
    pageTo: 1,
    location: null,
    quote: source.text,
    check: "found",
    checkReason: null,
  };
  const raw = JSON.stringify([
    {
      question: "How much does support cost?",
      source: 1,
      quote: source.text,
      answer: "An invented amount.",
    },
    { question: "Is there a discount?", source: 1, quote: "All volume orders get a discount." },
    { question: "What is the notice period?", source: 12, quote: source.text },
  ]);
  expect(
    readBriefQuestions(raw, [source], () => checked).map((q) => q.citation?.quote ?? null),
  ).toEqual([source.text, null, null]);
  expect(
    readBriefQuestions(raw, [source], () => ({ ...checked, contentHash: "changed" })).every(
      (q) => q.citation === null,
    ),
  ).toBe(true);
  expect(() => readBriefQuestions("[]", [source], () => checked)).toThrow();
  const packet = briefQuestionsPrompt("en", "Terms for renewal", [], [source]);
  expect(JSON.parse(packet.prompt).sources).toEqual([
    { source: 1, title: source.title, text: source.text },
  ]);
  expect(packet.instructions).not.toContain("Terms for renewal");
});

test.each([
  ["We did not approve the fee increase.", "approve the fee increase."],
  ["Only if legal signs off, we can ship Friday.", "we can ship Friday."],
  ["只有审批通过，才会在周五交付。", "在周五交付。"],
  ["没有同意全额退款。", "同意全额退款。"],
  ["540", "540"],
  ["一百", "一百"],
  ["$540.00", "$540.00"],
])("withholds misleading fragments and isolated quantities in %s", (source, given) => {
  expect(completeBriefAnswer(source, given)).toBe(false);
});

test("retains independently verifiable whole sentences in both languages", () => {
  expect(completeBriefAnswer("The fee is $540. Payment is due in June.", "The fee is $540.")).toBe(
    true,
  );
  expect(completeBriefAnswer("会议在上海举行。需要提交原件。", "需要提交原件。")).toBe(true);
});
