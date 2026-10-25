import { describe, expect, test } from "vitest";
import { unmadeFixes } from "../../src/core/answers/claimedFixes";

/**
 * What a reply says its edits fixed, against what they did (#1559): a word
 * it says it fixed that is still there as often as before, and a count
 * larger than the edits made, in English and Chinese. The texts are given as
 * the Mind reads before and after the Answer's own changes.
 */

const TRIP = {
  before:
    "Trip notes\nWe visted the harbour on tuesday and saw the tide go out compleatly.\nThe guide said spring tides come twice a month, wich surprised everyone.",
  after:
    "Trip notes\nWe visited the harbour on Tuesday and saw the tide go out completely.\nThe guide said spring tides come twice a month, wich surprised everyone.",
};
const MADE = { places: 3, paragraphs: 1 };

describe("Words a reply says it fixed", () => {
  // protects=the 2026-10-21 run's reply, which named four fixes when three were made, is caught on the one left; fails_when=the left word passes, or a fixed one is flagged; no_claim=how the model is asked again.
  test("a word still there as often as before is caught", () => {
    const reply =
      'I\'ve proposed fixes for "visted" (visited), "tuesday" (Tuesday), "compleatly" (completely) and "wich" (which).';
    expect(unmadeFixes(reply, [TRIP], MADE)).toEqual({ words: ["wich"], count: null });
  });

  // protects=Chinese reports of a fix are read too; fails_when=a left 错别字 passes; no_claim=none beyond protects.
  test("in Chinese", () => {
    const edited = {
      before: "场面十分壮管。这让所有人都很惊呀。",
      after: "场面十分壮观。这让所有人都很惊呀。",
    };
    const reply = "已把“壮管”改成“壮观”，“惊呀”改成“惊讶”。";
    expect(unmadeFixes(reply, [edited], { places: 1, paragraphs: 1 })?.words).toEqual(["惊呀"]);
  });

  // protects=an honest report passes: every word it names was changed, the corrected form it quotes was never there, and the Mind it names is where, not what; fails_when=any of them is flagged; no_claim=none beyond protects.
  test("an honest report, the corrected form and the Mind's name pass", () => {
    const all = { ...TRIP, after: TRIP.after.replace("wich", "which") };
    expect(
      unmadeFixes(
        "Fixed “visted”, “compleatly” and “wich” in “Trip notes”, and the spelling of “Tuesday”.",
        [all],
        { places: 4, paragraphs: 2 },
        ["Trip notes"],
      ),
    ).toBeNull();
  });

  // protects=a sentence that says a word was left, or not fixed, is no claim of a fix; fails_when=it is flagged; no_claim=none beyond protects.
  test("a word said to be left is no claim", () => {
    expect(unmadeFixes("I couldn't fix “wich”.", [TRIP], MADE)).toBeNull();
    expect(unmadeFixes("“wich” 没有改。", [TRIP], MADE)).toBeNull();
  });

  // protects=with no edit made, the claim check's own net is what holds the reply; fails_when=this check reads a reply with no edit; no_claim=none beyond protects.
  test("nothing to hold it to without an edit", () => {
    expect(unmadeFixes("Fixed “wich”.", [], MADE)).toBeNull();
  });
});

describe("Counts a reply gives", () => {
  // protects=a count of fixes, or of paragraphs, larger than the edits made is caught, in words and digits, in both languages; fails_when=it passes; no_claim=none beyond protects.
  test.each([
    ["Fixed four typos in “Trip notes”.", { claimed: 4, made: 3, of: "places" }],
    ["Fixed 4 spelling mistakes.", { claimed: 4, made: 3, of: "places" }],
    ["已修正 4 处错别字。", { claimed: 4, made: 3, of: "places" }],
    ["Changed 2 paragraphs in “Trip notes”.", { claimed: 2, made: 1, of: "paragraphs" }],
    ["已修改“港口笔记”中的 2 段。", { claimed: 2, made: 1, of: "paragraphs" }],
  ])("“%s”", (reply, count) => {
    expect(unmadeFixes(reply, [TRIP], MADE, ["Trip notes", "港口笔记"])).toEqual({
      words: [],
      count,
    });
  });

  // protects=a count no larger than what was made passes; fails_when=it is flagged; no_claim=none beyond protects.
  test("a count the edits made passes", () => {
    expect(unmadeFixes("Fixed 3 typos.", [TRIP], MADE)).toBeNull();
    expect(unmadeFixes("修改了 3 处。", [TRIP], MADE)).toBeNull();
    expect(unmadeFixes("Changed 1 paragraph.", [TRIP], MADE)).toBeNull();
  });

  // protects=Haiku's and Kimi's replies to "rewrite the second paragraph" (#1559's review), which name the paragraph they changed by its place, aren't read as a count of paragraphs or places; fails_when=an ordinal is taken for a count, and the model is asked again; no_claim=wordings no model gave.
  test.each([
    "已将第二段改写得更清楚。",
    "我已修改了第三段。",
    "已修改第 2 段的措辞。",
    "已修改第12段。",
    "已修正第二处错别字。",
    "Changed the second paragraph.",
    "Changed the 2nd paragraph to read more clearly.",
    "Fixed the third typo in paragraph 3.",
  ])("an ordinal is no count: “%s”", (reply) => {
    expect(unmadeFixes(reply, [TRIP], MADE)).toBeNull();
  });

  // protects="the last paragraph" and "this paragraph" name one paragraph, also when the edit revised the assistant's own text and counted none; fails_when=they are read as one paragraph claimed; no_claim=none beyond protects.
  test.each(["已修改最后一段。", "已将这一段改得更正式。"])(
    "one named paragraph: “%s”",
    (reply) => {
      expect(unmadeFixes(reply, [TRIP], { places: 1, paragraphs: 0 })).toBeNull();
    },
  );

  // protects=a count after the ordinal rule still counts, "前两段" and "these two paragraphs" among them; fails_when=the ordinal rule hides a real count; no_claim=none beyond protects.
  test.each([
    ["已修改前两段。", 2],
    ["Changed these two paragraphs.", 2],
    ["修改了 12 段。", 12],
  ])("a count stays one: “%s”", (reply, claimed) => {
    expect(unmadeFixes(reply, [TRIP], MADE)?.count).toEqual({
      claimed,
      made: 1,
      of: "paragraphs",
    });
  });
});
