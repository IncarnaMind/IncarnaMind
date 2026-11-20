import { expect, test } from "vitest";
import { transcriptUnits } from "../../src/core/documents/formats/vtt";
import { meetingSummarySources } from "../../src/core/meetings/summarySources";

test("locates distinct original turns and leaves an ambiguous quote unlinked", () => {
  const words = ["确定，周五。", "收到。", "议程取消。", "收到。"];
  const cues = words.map((text, startMs) => ({ text, startMs, endMs: startMs + 1, speaker: null }));
  const units = transcriptUnits({ cues, gaps: [] });
  expect(
    meetingSummarySources(units, ["议程取消。", "确定,周五。", "取消。", "收到。", "缺失"]),
  ).toEqual([
    { startMs: 0, endMs: 1, text: words[0] },
    { startMs: 2, endMs: 3, text: words[2] },
  ]);
});

test("opens the cited words with their original spelling inside a longer turn", () => {
  const cues = [
    {
      startMs: 900,
      endMs: 2900,
      speaker: "Speaker 1",
      text: "Thanks, everyone. The Harbor review moves to Friday. See you then.",
    },
  ];
  const units = transcriptUnits({ cues, gaps: [] });
  expect(meetingSummarySources(units, ["the harbor review moves to friday."])).toEqual([
    { startMs: 900, endMs: 2900, text: "The Harbor review moves to Friday." },
  ]);
});
