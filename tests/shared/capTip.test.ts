/**
 * The monthly cap's tip says what the cap counts (#2835): what the meter records, chat models and
 * Meeting transcription's cloud streams, and what it leaves out, Document search and Best results
 * first, in both languages.
 */
import { expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";

// protects=the cap's tip names every job the meter counts against the cap, Meeting transcription included, and the ones it doesn't; fails_when=the tip says transcription isn't counted, or leaves a counted job out; no_claim=how the meter prices them.
test("the cap's tip names what the cap counts, Meeting transcription included", () => {
  const en = translate("en", "cost.cap.tip");
  for (const job of ["Answers and writing", "quick tasks", "reading images", "Organize and Tags"]) {
    expect(en).toContain(job);
  }
  expect(en).toContain(
    "and Meeting transcription. Document search and Best results first aren’t counted.",
  );
  const zh = translate("zh-CN", "cost.cap.tip");
  expect(zh).toContain("以及会议转写上的花费");
  expect(zh).toContain("文档搜索和“最相关的排在前面”不计入");
});
