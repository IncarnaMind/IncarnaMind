import { describe, expect, test } from "vitest";
import type { AnswerToolCall, MindChange } from "../../src/core";
import {
  claimsIn,
  holdBack,
  shownUpTo,
  unbackedClaims,
} from "../../src/core/answers/claimedChanges";

/**
 * The narrow net under the change log: a reply's plainest reports of a change
 * to a Mind, in English and Chinese, against what its Tool calls did, Mind
 * by Mind. It misses a vague sentence rather than flag an honest one.
 */

const MINDS = [
  { id: "q3", name: "Q3 review" },
  { id: "weekly", name: "周报" },
  { id: "tides", name: "Tide notes" },
  { id: "papers", name: "Paper summaries" },
];
const NAMES = MINDS.map((mind) => mind.name);
const kinds = (reply: string) => claimsIn(reply, NAMES).map((claim) => claim.kind);

const mindCall = (tool: string, change: Partial<MindChange> | null): AnswerToolCall => ({
  id: `${tool}-1`,
  tool,
  source: "minds",
  input: {},
  status: change ? "done" : "failed",
  resultCount: null,
  ...(change && {
    mindChange: { mindId: "q3", created: false, request: "r1", proposals: 2, ...change },
  }),
});

describe("What a reply claims it changed", () => {
  // protects=the plainest reports of a change to a Mind read as claims; fails_when=one reads as none; no_claim=every wording a model may use.
  test.each([
    ["I made a new Mind, “Tide notes”, with a summary of both papers.", ["made"]],
    ["I created “Tide notes”.", ["made"]],
    ["Summary page created in “Tide notes”.", ["made"]],
    ["I added a longer summary section to “Q3 review”.", ["added"]],
    ["Added a risks section below the introduction in “Q3 review”.", ["added"]],
    ["Shortened the summary in “Q3 review” from 320 to 150 words.", ["changed"]],
    ["I made the summary longer.", ["changed"]],
    ["The summary is now twice as long.", ["changed"]],
    ["The summary is longer now.", ["changed"]],
    ["The new page replaces the earlier version.", ["removed"]],
    ["I replaced the page's old summary with the cited one.", ["removed"]],
    ["I added the summary to “Q3 review” earlier.", ["added"]],
    ["Your notes are ready.", ["added"]],
    ["The summary in “Paper summaries” has been updated with Citations.", ["changed"]],
    ["Sure, I've written the handout into your notes.", ["added"]],
    ["我已在“周报”中添加了风险部分。", ["added"]],
    ["好的，已添加到“周报”。", ["added"]],
    ["总结已扩写到原来的两倍。", ["changed"]],
    ["页面已创建。", ["made"]],
    ["我把“周报”里的风险部分删掉了。", ["removed"]],
    ["我在笔记里新增了一个风险部分。", ["added"]],
    ["我已生成一份新的笔记。", ["made"]],
    ["我把总结加长了。", ["changed"]],
    ["我把四份文档的摘要都写长了一些", ["changed"]],
    ["我完善了“周报”的结论。", ["changed"]],
    // Kimi K2.6's, in the 2026-10-21 runs.
    ["已经把教程的主要观点整理后加进了你的笔记。", ["added"]],
    ["我已经把风险部分放进了“周报”。", ["added"]],
    ["总结现在更长了。", ["changed"]],
  ])("%s", (reply, expected) => {
    expect(kinds(reply)).toEqual(expected);
  });

  // protects=honest replies are never read as claims: answers about the Documents (their own changes, versions and drafts), refusals, changes still waiting, earlier claims reported, Citations and words about the reply; fails_when=any one is flagged, which holds the stream back and costs a retry; no_claim=every honest sentence.
  test.each([
    "No, the summary I wrote in “Paper summaries” has no Citations yet.",
    "The changes I proposed in “Q3 review” are still waiting for you.",
    "The draft was revised twice before publication.",
    "Revised estimates appear on page 12.",
    "This version replaces the 2017 standard.",
    "The quarter was good, and sales were strong.",
    "The authors added a new layer and proposed a method in “Attention Is All You Need”.",
    "Proposed in 2017, the Transformer replaced recurrence.",
    "I couldn't change “Q3 review”: 12 changes are waiting there.",
    "Nothing was changed in “Q3 review”: 12 changes are waiting in it.",
    "I made a mistake: my first proposal went into the wrong note.",
    "I've written a summary below.",
    "I made no changes.",
    "I've added 11 citations to the page.",
    "As I wrote before, the paper is a tutorial.",
    'The earlier reply was wrong to say I added a risks section to "Q3 review".',
    'The earlier claim that I added a risks section to "Q3 review" was wrong.',
    "Expanded two-paper summary (longer draft)\n1) Overview",
    "Any proposed changes are waiting for you to accept or reject.",
    "The paper updated its results in the second version.",
    "The tutorial was updated in 2016 and again in 2019.",
    "Section 3 was rewritten to cover neap tides.",
    "The model was trained on 40 datasets and later fine-tuned.",
    "GraphST replaces the encoder with a graph network.",
    "The second edition added a chapter on tides.",
    "Table 4 has been updated with the corrected figures.",
    "The authors removed two outliers before fitting.",
    "The page count of the report grew from 40 to 52.",
    "Their summary is now twice as long as the original abstract.",
    "The notes were written by the authors.",
    "The page you mentioned was added in the 2019 edition.",
    "A new page was added to the report in 2020.",
    "The handout was made for the 2019 workshop.",
    "I think the authors changed their method.",
    "I'd add a risks section if you want.",
    "I can add this to your notes.",
    "Should I make the summary shorter?",
    "I made the comparison in my reply below.",
    "I wrote nothing into your notes.",
    "I haven't written anything to “Q3 review” yet.",
    "I updated my understanding: the paper uses 12 datasets.",
    "I revised my estimate after reading Table 3.",
    "I changed nothing.",
    "The Mind “Q3 review” holds the summary you accepted.",
    "You accepted the changes in “Q3 review” earlier.",
    "Your page already has a risks section.",
    "The summary page lists three risks.",
    "Replaced by the 2023 rules, the old standard no longer applies.",
    "Updated figures are in Table 2.",
    "Added value grew 3% in the quarter.",
    "Fixed costs rose to £2bn.",
    "Moved to Chapter 4, the proof is shorter.",
    "The authors have been revising the model since 2019.",
    "The dataset has been updated twice.",
    "作者已经修改了模型。",
    "我没有修改任何内容。",
    "下面是我写好的总结。",
    "之前说我已在“周报”中添加了风险部分，这是错的。",
    "修订都在等你确认。",
    "我建议在笔记中添加风险部分。",
    "这篇论文在2019年更新过。",
    "论文已经修改了三次。",
    "摘要已更新为第二版。",
    "我可以把它加到你的笔记里。",
    "第二段的修改还在等你确认。",
    "我已经读了这两篇论文。",
    "已核对 12 处引用。",
    "作者删除了两个异常值。",
    "表 4 已经更新。",
    "我已经更新了我对这篇论文的理解。",
  ])("%s", (reply) => {
    expect(kinds(reply)).toEqual([]);
  });
});

describe("Claims against what the calls did", () => {
  // protects=a claimed change needs a call that made it; fails_when=a made-up change passes, or a real one is flagged; no_claim=whether the change was good.
  test("a claimed change needs a call that made it", () => {
    const reply = "I added a risks section to “Q3 review”.";
    expect(unbackedClaims(reply, [], MINDS)).toEqual(["added"]);
    expect(unbackedClaims(reply, [mindCall("add_to_mind", {})], MINDS)).toEqual([]);
    expect(unbackedClaims(reply, [mindCall("add_to_mind", null)], MINDS)).toEqual(["added"]);
  });

  // protects=a claim that names a Mind holds only by a change in that Mind; fails_when=a change elsewhere backs it; no_claim=none beyond protects.
  test("a claim naming a Mind needs a change in that Mind", () => {
    const elsewhere = [mindCall("add_to_mind", { mindId: "tides" })];
    expect(unbackedClaims("I added a risks section to “Q3 review”.", elsewhere, MINDS)).toEqual([
      "added",
    ]);
    expect(unbackedClaims("I added a risks section to “Tide notes”.", elsewhere, MINDS)).toEqual(
      [],
    );
  });

  // protects=a claim about the User's own notes, named by no name ("your notes", "这篇笔记"), holds only by a change in the Mind they are in, as after a piece was sent to a new Mind (#1109); fails_when=a new Mind's text backs "added it to your notes"; no_claim=none beyond protects.
  test("a claim about the User's notes needs a change in the Mind they are in", () => {
    const madeElsewhere = [mindCall("create_mind", { mindId: "tides", created: true })];
    const inTheirs = [mindCall("add_to_mind", { mindId: "q3" })];
    for (const reply of ["I added it to your notes.", "我已把摘要写进你的笔记里。"]) {
      expect(unbackedClaims(reply, madeElsewhere, MINDS, "q3"), reply).not.toEqual([]);
      expect(unbackedClaims(reply, inTheirs, MINDS, "q3"), reply).toEqual([]);
    }
  });

  // protects=a made Mind needs a call that made one; "replaced" needs text changed, not only added; a claim about an earlier Answer gets no pass; fails_when=any of these passes; no_claim=none beyond protects.
  test("made, replaced and earlier", () => {
    const added = [mindCall("add_to_mind", {})];
    expect(unbackedClaims("I made a new note, “Plan”.", added)).toEqual(["made"]);
    expect(
      unbackedClaims("I made a new note, “Plan”.", [mindCall("create_mind", { created: true })]),
    ).toEqual([]);
    expect(unbackedClaims("I replaced the page's old summary.", added)).toEqual(["removed"]);
    expect(
      unbackedClaims("I replaced the page's old summary.", [
        mindCall("edit_mind", { revised: true }),
      ]),
    ).toEqual([]);
    expect(unbackedClaims("I added the summary to “Q3 review” earlier.", [], MINDS)).toEqual([
      "added",
    ]);
  });
});

describe("A reply as it streams", () => {
  const shown = (text: string) => text.slice(0, shownUpTo(text, ["Q3 review"]));

  // protects=a reply streams as it comes but for the sentence that may claim a change, held until it is checked, and its last word, which may become one; fails_when=a claim shows before it is checked, or text that can't be one waits; no_claim=none beyond protects.
  test("shows all but what may claim a change", () => {
    expect(shown("A Mind is ")).toBe("A Mind is ");
    expect(shown("A Mind is a note")).toBe("A Mind is a ");
    expect(shown("The tides are late. I've added a risks section to “Q3 review”. More")).toBe(
      "The tides are late. ",
    );
    expect(shown("The tides are late. I've ad")).toBe("The tides are late. ");
    expect(shown("The tides are late. Short")).toBe("The tides are late. ");
    expect(shown("The summary is now twice")).toBe("");
    expect(shown("总结说潮汐很晚。总结已扩")).toBe("总结说潮汐很晚。");
    expect(shown("潮汐很晚")).toBe("潮汐很晚");
  });

  // protects=read as it grows, the reply shows what it would read whole at each step, and a reply taken back is read afresh; fails_when=a step shows more or less than a whole read, or a held claim keeps an honest retry back; no_claim=how long a reply takes to read.
  test("as it grows, as if read whole, and afresh once taken back", () => {
    const hold = holdBack(() => ["Q3 review"]);
    const reply = "The tides are late. I've added a risks section to “Q3 review”. More";
    for (let end = 1; end <= reply.length; end++) {
      expect(hold(reply.slice(0, end))).toBe(shownUpTo(reply.slice(0, end), ["Q3 review"]));
    }
    expect(hold("")).toBe(0);
    expect(hold("No section was added. ")).toBe("No section was added. ".length);
  });
});
