import { describe, expect, test } from "vitest";
import { asksToRemove, mapsOnto, waitsForUser } from "../../src/core/edits/applies";

describe("An edit the User asked for (#880)", () => {
  // protects=only a part of the text named by its kind deletes what the model left out; fails_when=a word, a phrase or a determiner ("these", 所有) deletes paragraphs at once, or "but keep the rest" undoes an asked-for delete; no_claim=what the model writes.
  test.each([
    ["Delete the last paragraph", true],
    ["delete this paragraph", true],
    ["remove the second bullet", true],
    ["Cut this sentence", true],
    ["Remove the Methods section", true],
    ["delete the heading", true],
    ["remove the table", true],
    ["remove the first and second paragraphs", true],
    ["delete paragraphs 2 and 3", true],
    ["take out everything after the first section", true],
    ["delete the second paragraph but keep the rest", true],
    ["delete the second paragraph and leave the rest", true],
    ["Keep the first paragraph, delete the second paragraph", true],
    ["Join them and delete the second paragraph", true],
    ["删除最后一段", true],
    ["把第二段删掉", true],
    ["删掉这句", true],
    ["删掉第二段的最后一句", true],
    ["删除第二段，其余保留", true],
    ["remove these filler words", false],
    ["cut this jargon", false],
    ["remove all the adverbs", false],
    ["Remove them", false],
    ["delete everything", false],
    ["remove the jargon from this paragraph", false],
    ["remove the jargon in the second paragraph", false],
    ["remove the jargon and tighten the paragraph", false],
    ["remove the adjectives across all paragraphs", false],
    ["remove repetition throughout the paragraphs", false],
    ["删掉每段里的重复", false],
    ["Get rid of the repetition", false],
    ["Cut it down to two sentences", false],
    ["cut this paragraph down to two sentences", false],
    ["Cut the second paragraph back by half", false],
    ["Make the second paragraph more formal", false],
    ["Removal costs are in clause 4: make it clearer", false],
    ["don't remove anything, just fix the typos", false],
    ["Don't delete the second paragraph", false],
    ["Rewrite it without deleting a paragraph", false],
    ["Keep every paragraph and remove the filler words", false],
    ["去掉这些口语化表达", false],
    ["删掉所有形容词", false],
    ["去掉第二段里的口语化表达", false],
    ["删掉这个阶段的描述", false],
    ["把重复的去掉", false],
    ["不要删除任何段落", false],
    ["别删第二段", false],
    ["保留所有段落，删掉多余的词", false],
    ["Remove the whole part about hours (full time, Monday to Friday), and leave the rest", true],
    ["Remove the bullet about hours (full time, Monday to Friday) and leave the rest as is", true],
    ["Delete the list item about hours", true],
    ["删去整个“工作安排”部分（全职、周一至周五、核心工作时间），其他部分保持不变。", true],
    ["删去这一条关于工时的列表项（全职工作，周一至周五，核心工作时间，在家办公）。", true],
    ["Remove the filler words in this part", false],
    ["删掉这部分里的口语化表达", false],
    ["Make this into a table", true],
    ["Make it a table", true],
    ["Turn the list into a table", true],
    ["Convert these bullets to a table", true],
    ["Rewrite the summary as a table", true],
    ["改成表格", true],
    ["把这些要点做成表格", true],
    ["以表格形式列出", true],
    ["Add a table of the key terms", false],
    ["Put the figures from the table into a sentence", false],
    ["Don't turn it into a table", false],
    ["不要改成表格", false],
    ["在后面加一个表格", false],
  ] as const)("“%s” asks to remove a part of the text: %s", (asked, removes) => {
    expect(asksToRemove("instruction", asked)).toBe(removes);
  });

  test("only an instruction asks to remove: Shorten and Improve never do", () => {
    expect(asksToRemove("shorten", "delete the last paragraph")).toBe(false);
    expect(asksToRemove("improve", "")).toBe(false);
  });

  test("new text maps onto the selection when at least half of it is found there", () => {
    expect(mapsOnto(50, 100)).toBe(true);
    expect(mapsOnto(49, 100)).toBe(false);
    expect(mapsOnto(0, 0)).toBe(true);
  });

  test("waits for the User only when its text doesn't map onto the selection, it wasn't asked to remove, and more than half of it would go", () => {
    const edit = { action: "instruction" as const, removing: false, mapped: false, selected: 100 };
    expect(waitsForUser({ ...edit, removed: 50, added: 0 })).toBe(false);
    expect(waitsForUser({ ...edit, removed: 51, added: 0 })).toBe(true);
    expect(waitsForUser({ ...edit, removed: 90, added: 40 })).toBe(false);
    expect(waitsForUser({ ...edit, removed: 100, added: 20 })).toBe(true);
    expect(waitsForUser({ ...edit, removing: true, removed: 100, added: 0 })).toBe(false);
    expect(waitsForUser({ ...edit, mapped: true, removed: 100, added: 0 })).toBe(false);
    expect(waitsForUser({ ...edit, action: "translate", removed: 100, added: 0 })).toBe(false);
    expect(waitsForUser({ ...edit, selected: 0, removed: 0, added: 0 })).toBe(false);
  });
});
