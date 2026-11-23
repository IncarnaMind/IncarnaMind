import { generateText } from "ai";
import { expect, test } from "vitest";
import type { MeetingSummaryItem } from "../../src/core/api";
import { readMeetingSummaryUpdate } from "../../src/core/meetings/summaryItems";
import {
  type MeetingSummaryInput,
  meetingSummaryPrompt,
} from "../../src/core/meetings/summaryModel";
import { createFakeChatModel } from "../../src/main/fakeChatModel";
import { meetingWords } from "../fixtures/meetingSummaryWords";

async function summarize(lines: string[], prior?: Pick<MeetingSummaryInput, "previous" | "items">) {
  const input = {
    previous: null,
    ...prior,
    closing: !!prior,
    utterances: lines.map((text) => ({ text })),
  };
  const model = createFakeChatModel({
    kind: "ollama",
    modelId: "test-local",
    baseUrl: null,
    apiKey: null,
  });
  const { instructions: system, prompt } = meetingSummaryPrompt(input);
  const { text } = await generateText({ model, system, prompt });
  return readMeetingSummaryUpdate(text, input);
}

for (const language of ["en", "zh-CN"] as const) {
  const words = meetingWords[language];
  const [briefing] = words.opening;
  const [date, owner, cancelled, done] = words.correction;
  const opening = words.opening.join(" ");
  const corrections = [briefing, ...words.correction].join(" ");
  const items: MeetingSummaryItem[] = [
    { id: 1, kind: "decision", status: "active", text: briefing },
    { id: 2, kind: "decision", status: "active", text: date },
    { id: 3, kind: "action", status: "active", text: owner },
    { id: 4, kind: "action", status: "cancelled", text: cancelled },
    { id: 5, kind: "action", status: "done", text: done },
  ];
  for (const batch of ["together", "separately"] as const) {
    test(`the ${language} scripted summary preserves corrections and their spoken evidence when they arrive ${batch} with the opening`, async () => {
      const together = batch === "together";
      const warm = await summarize(together ? [opening, corrections] : [opening]);
      expect(warm.items.map((item) => item.text)).toEqual(
        together ? items.map((item) => item.text) : words.opening,
      );
      const final = await summarize(together ? [words.closing] : [corrections, words.closing], {
        previous: warm.text,
        items: warm.items,
      });
      expect(final.text).toBe(words.overview);
      expect(final.items).toEqual(items);
      expect((together ? warm : final).evidence).toMatchObject({
        2: date,
        3: owner,
        4: cancelled,
        5: done,
      });
      if (together) expect(final.evidence).toEqual({});
    });
  }

  test(`replaying the ${language} scripted transcript preserves the corrected overview and IDs without adding evidence`, async () => {
    expect(
      await summarize([opening, corrections, words.closing], { previous: null, items }),
    ).toEqual({
      text: words.overview,
      items,
      evidence: {},
    });
  });
}
