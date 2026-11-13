import { describe, expect, test } from "vitest";
import { ANSWER_SENTENCES, cutSentences, REPLAYED, replay } from "../../eval/speed/roomReplay";
import { equalShare } from "../../src/core/answers/checks/answerCheck";

describe("equal parts of what the limits leave (#2962)", () => {
  test("each batch the same, none past what it wants, what one can't use to the others", () => {
    expect(equalShare(1_720, [5_000, 5_000])).toBe(860);
    expect(equalShare(4_860, [1_696, 3_796])).toBe(3_164);
    expect(equalShare(10_000, [1_000, 2_000])).toBe(Number.POSITIVE_INFINITY);
    expect(equalShare(-50, [5_000])).toBe(0);
  });
});

describe("the shared room replayed on the replies measured with 8,000 tokens (#2962)", () => {
  const fable = REPLAYED.find((model) => model.modelId === "claude-fable-5");
  if (!fable) throw new Error("No Claude Fable 5 in the replay.");

  test("Claude Fable 5, nine sentences: equal parts hold every measured batch, fewest first cuts one of six eights", () => {
    expect(replay(fable, 9, "equal")).toEqual([
      { sentences: 8, room: 3_167, cut: { of: 6, cut: 0 } },
      { sentences: 1, room: 1_067, cut: { of: 12, cut: 0 } },
    ]);
    expect(replay(fable, 9, "fewest")).toEqual([
      { sentences: 8, room: 2_400, cut: { of: 6, cut: 1 } },
      { sentences: 1, room: 1_834, cut: { of: 12, cut: 0 } },
    ]);
  });

  test("Claude Fable 5, twenty sentences: the $0.25 sends two batches of eight and leaves the four", () => {
    expect(replay(fable, 20, "equal").map((batch) => batch.room)).toEqual([2_400, 2_400, null]);
  });

  test("on every model and Answer, equal parts cut no more measured sentences than fewest first, and leave none more unsent", () => {
    for (const model of REPLAYED) {
      for (const sentences of ANSWER_SENTENCES) {
        const equal = cutSentences(replay(model, sentences, "equal"));
        const fewest = cutSentences(replay(model, sentences, "fewest"));
        expect(equal.cut, `${model.name}, ${sentences} sentences`).toBeLessThanOrEqual(fewest.cut);
        expect(equal.unsent, `${model.name}, ${sentences} sentences`).toBeLessThanOrEqual(
          fewest.unsent,
        );
      }
    }
  });
});
