/**
 * What a checked Note stores (#2220): a Note of 2,000 checked sentences, each checked in two
 * parts with two receipts and 400-character quotes, stays within the size its bound states, in
 * English and Simplified Chinese. The mark each sentence keeps is the one a check stores
 * (`checkWithParts`, the writer every check writes its result with), written the way the editor
 * writes a mark: through the core.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { CHECK_QUOTE_CHARS_AT_MOST } from "../../src/shared/claimParts";
import { quotesOf, sentenceMark } from "../helpers/checkBounds";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const SENTENCES = 2_000;

/** 8.5 MB: the measured Note is 8.08 MB with the bound; before it, 10.04 MB. */
const ENGLISH_STATED_AT_MOST = 8.5 * 1024 * 1024;
/** 13 MB: a Chinese character takes three bytes, and the measured Note is about 12 MB; before the bound, 15.31 MB. */
const CHINESE_STATED_AT_MOST = 13 * 1024 * 1024;

const ENGLISH_QUOTE =
  `${"Costs rose 12 percent in the third quarter while headcount stayed flat. ".repeat(8)}`.slice(
    0,
    400,
  );
const CHINESE_QUOTE =
  `${"第三季度成本上升了百分之十二，而员工人数保持不变，收入持续增长。".repeat(10)}`.slice(0, 400);

const languages = [
  {
    language: "en",
    sentence: (index: number) =>
      `Statement ${index} says revenue grew in the third quarter while headcount stayed flat across every region.`,
    quote: ENGLISH_QUOTE,
    stated: ENGLISH_STATED_AT_MOST,
  },
  {
    language: "zh-CN",
    sentence: (index: number) =>
      `第${index}句说第三季度收入增长，各地员工人数保持不变，成本上升了百分之十二。`,
    quote: CHINESE_QUOTE,
    stated: CHINESE_STATED_AT_MOST,
  },
] as const;

/** A Note of the measured shape, written through the core, and the state it stores. */
async function measuredNote(
  core: Core,
  sentence: (index: number) => string,
  quote: string,
): Promise<number> {
  const documentId = randomUUID();
  const mind = await core.createMind({ title: "A long checked Note" });
  const client = await connectToMind(core, mind.id);
  const blocks: JSONContent[] = [];
  for (let index = 0; index < SENTENCES; index++) {
    const text = sentence(index);
    const mark = sentenceMark({ text, documentId, parts: 2, receipts: 2, quote });
    blocks.push({
      type: "paragraph",
      attrs: { id: randomUUID() },
      content: [{ type: "text", text, marks: [{ type: "claimCheck", attrs: mark }] }],
    });
  }
  writeMind(client, blocks);
  await client.settled();
  const marks = claimSpans(readMind(client)).map((span) => span.check);
  expect(marks).toHaveLength(SENTENCES);
  for (const mark of marks) {
    expect(quotesOf(mark).every((each) => each.length <= CHECK_QUOTE_CHARS_AT_MOST)).toBe(true);
  }
  return (await core.openMind(mind.id)).state.byteLength;
}

for (const example of languages)
  describe(example.language, () => {
    test("2,000 sentences of two parts by two receipts stay within the stated size", async () => {
      const core = startCore(await createTempDataFolder());
      const bytes = await measuredNote(core, example.sentence, example.quote);
      expect(bytes).toBeLessThanOrEqual(example.stated);
    }, 120_000);
  });
