import { expect, test } from "vitest";
import { transcriptUnits } from "../../src/core/documents/formats/vtt";
import {
  storeNumberedSummaryQuote,
  storeSummaryQuote,
  summaryEvidenceCue,
} from "../../src/core/meetings/summaryEvidence";
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

test("an ambiguous new quote stays unlocated while old uniquely matched quotes still work", () => {
  const text = "Open the side door on Friday.";
  const first = { startMs: 1_000, endMs: 2_000, text, speaker: "Dana" };
  const repeat = { ...first, startMs: 3_000, endMs: 4_000 };
  const quote = storeSummaryQuote(text, [first, repeat].map(summaryEvidenceCue));
  const units = transcriptUnits({ cues: [repeat], gaps: [] });
  expect(meetingSummarySources(units, [quote])).toEqual([]);
  expect(meetingSummarySources(units, [text])).toEqual([{ startMs: 3_000, endMs: 4_000, text }]);
});

test.each([
  {
    name: "English",
    lines: [
      "Each team can report its counts.",
      "We will count them.",
      "That helps with the budget.",
      "We will count them.",
    ],
  },
  {
    name: "Chinese",
    lines: [
      "各组报一下需要的箱子数量。",
      "我们回去数一下。",
      "这样方便核预算。",
      "我们回去数一下。",
    ],
  },
])(
  "numbered excerpts resolve repeated $name lines to their exact utterance while unnumbered repeats stay unlinked",
  ({ lines }) => {
    const cues = lines.map((text, index) => ({
      startMs: (index + 1) * 1_000,
      endMs: (index + 2) * 1_000,
      speaker: `Speaker ${index + 1}`,
      text,
    }));
    const speech = cues.map(summaryEvidenceCue);
    const units = transcriptUnits({ cues, gaps: [] });
    const [first, confirm, middle, repeat] = lines;
    if (!first || !confirm || !middle || !repeat) throw new Error("Expected four lines");

    const earlierPair = [
      storeNumberedSummaryQuote({ source: 1, quote: first }, speech),
      storeNumberedSummaryQuote({ source: 2, quote: confirm }, speech),
    ];
    expect(meetingSummarySources(units, earlierPair)).toEqual([
      { startMs: 1_000, endMs: 2_000, text: first },
      { startMs: 2_000, endMs: 3_000, text: confirm },
    ]);

    const laterPair = [
      storeNumberedSummaryQuote({ source: 3, quote: middle }, speech),
      storeNumberedSummaryQuote({ source: 4, quote: repeat }, speech),
    ];
    expect(meetingSummarySources(units, laterPair)).toEqual([
      { startMs: 3_000, endMs: 4_000, text: middle },
      { startMs: 4_000, endMs: 5_000, text: repeat },
    ]);

    expect(
      meetingSummarySources(units, [
        storeNumberedSummaryQuote({ source: 4, quote: repeat }, speech),
      ]),
    ).toEqual([{ startMs: 4_000, endMs: 5_000, text: repeat }]);

    expect(meetingSummarySources(units, [storeSummaryQuote(confirm, speech)])).toEqual([]);

    for (const invalid of [
      storeNumberedSummaryQuote({ source: 1, quote: confirm }, speech),
      storeNumberedSummaryQuote({ source: 9, quote: confirm }, speech),
      storeNumberedSummaryQuote({ source: 0, quote: first }, speech),
      storeNumberedSummaryQuote({ source: null, quote: first }, speech),
    ]) {
      expect(meetingSummarySources(units, [invalid])).toEqual([]);
    }
  },
);
