/**
 * More held-out real edits for #2589, added before any run: the shapes most like a line of the
 * model's own, a short reply or one that restates the paragraph, which must be written and never
 * set aside. Frozen as `ownLineReplies.cases.ts` is, on made-up Notes. `heading`: the Note's first
 * Block is a heading.
 */
import type { HeldOutCase } from "./ownLineReplies.cases";

export interface MoreCase extends HeldOutCase {
  heading?: true;
}

const edit = (
  id: string,
  language: "en" | "zh",
  note: [string, string],
  ask: string,
  heading?: true,
): MoreCase => ({
  id,
  language,
  group: "edit",
  kind: "instruction",
  note,
  ask,
  ...(heading && { heading }),
});

export const MORE_HELD_OUT: readonly MoreCase[] = [
  edit(
    "en-m01",
    "en",
    ["The bus is late. It will come at ten.", "Wait inside."],
    "Make the first paragraph one sentence.",
  ),
  edit(
    "en-m02",
    "en",
    ["Thanks a lot for coming!", "See you soon."],
    "Say the first paragraph more formally.",
  ),
  edit(
    "en-m03",
    "en",
    [
      "The shop opens at nine. It closes at five. Staff park at the back.",
      "Deliveries come on Mondays.",
    ],
    "Remove the second sentence of the first paragraph.",
  ),
  edit(
    "en-m04",
    "en",
    ["Hours", "We open at nine."],
    "Rename the heading to 'Opening times'.",
    true,
  ),
  edit(
    "en-m05",
    "en",
    ["The library is closed today.", "It opens again tomorrow."],
    "Translate the first paragraph into Spanish.",
  ),
  edit(
    "en-m06",
    "en",
    ["Please close the gate.", "The dog may run out."],
    "Translate the first paragraph into German.",
  ),
  edit(
    "en-m07",
    "en",
    [
      "Due to unforeseen circumstances beyond our control, the concert has been postponed.",
      "Refunds are available.",
    ],
    "Make the first paragraph shorter: just the key fact.",
  ),
  edit(
    "en-m08",
    "en",
    ["We walk to the lake and swim.", "The water is cold."],
    "Put the first paragraph in the past tense.",
  ),
  edit(
    "en-m09",
    "en",
    ["The colour of the door is blue.", "The frame is white."],
    "Change 'colour' to 'color' in the first paragraph.",
  ),
  edit(
    "en-m10",
    "en",
    ["Everything you need to know about parking", "Park in bay B."],
    "Make the heading shorter.",
    true,
  ),
  edit(
    "en-m11",
    "en",
    ["the meeting is in room four on friday.", "Bring the slides."],
    "Capitalise the first paragraph properly.",
  ),
  edit(
    "en-m12",
    "en",
    [
      "The council voted to keep the library open, to extend its hours on weekends, and to add a reading room for children.",
      "The vote was close.",
    ],
    "Replace the first paragraph with a one-line summary.",
  ),
  edit(
    "en-m13",
    "en",
    ["The gate code is 4421", "Close it after you."],
    "Add a full stop at the end of the first paragraph.",
  ),
  edit(
    "en-m14",
    "en",
    ["Close the window.", "It gets cold at night."],
    "Make the first paragraph a polite request.",
  ),
  edit("zh-m01", "zh", ["公交车晚点了。十点才到。", "请在室内等候。"], "把第一段合并成一句话。"),
  edit("zh-m02", "zh", ["太谢谢大家来了！", "回头见。"], "把第一段说得正式一点。"),
  edit(
    "zh-m03",
    "zh",
    ["商店九点开门。五点关门。员工在后面停车。", "周一送货。"],
    "删掉第一段的第二句话。",
  ),
  edit("zh-m04", "zh", ["时间", "我们九点开门。"], "把标题改成“营业时间”。", true),
  edit("zh-m05", "zh", ["图书馆今天闭馆。", "明天重新开放。"], "把第一段翻译成日文。"),
  edit("zh-m06", "zh", ["请关好大门。", "狗可能会跑出去。"], "把第一段翻译成繁体中文。"),
  edit(
    "zh-m07",
    "zh",
    ["由于不可抗力等无法控制的原因，音乐会已经延期举行。", "可以办理退款。"],
    "把第一段缩短，只留关键信息。",
  ),
  edit("zh-m08", "zh", ["我们走到湖边去游泳。", "湖水很凉。"], "把第一段改成过去发生的事。"),
  edit("zh-m09", "zh", ["门的颜色是蓝色。", "门框是白色的。"], "把第一段里的“颜色”改成“色彩”。"),
  edit("zh-m10", "zh", ["关于停车你需要知道的一切", "请停在B区。"], "把标题改短一点。", true),
  edit("zh-m11", "zh", ["会议在四号房间周五举行", "请带上幻灯片。"], "给第一段加上标点。"),
  edit(
    "zh-m12",
    "zh",
    ["市议会投票决定保留图书馆，延长周末开放时间，并增设儿童阅览室。", "投票结果很接近。"],
    "用一句话概括第一段并替换它。",
  ),
  edit("zh-m13", "zh", ["大门密码是4421", "用完请关门。"], "在第一段末尾加上句号。"),
  edit("zh-m14", "zh", ["关窗。", "夜里会冷。"], "把第一段改成礼貌的请求。"),
];
