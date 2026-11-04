import { describe, expect, test } from "vitest";
import { readCases } from "../../eval/meetings/cache";
import { readWords, scoreTerms } from "../../eval/meetings/terms";
import type { Hypothesis, Reference } from "../../eval/meetings/types";

const reference = (lines: [number, string][]): Reference => ({
  format: 1,
  segments: lines.map(([start, text]) => ({
    start,
    end: start + 2,
    speaker: "a",
    text,
    track: "mic",
  })),
});
const hypothesis = (lines: [number, string][]): Hypothesis => ({
  case: "x",
  transcriber: "test",
  segments: lines.map(([start, text]) => ({ start, end: start + 2, text })),
});

describe("The words a transcriber was told, scored (#1031)", () => {
  test("a name written otherwise is wrong, one written right is right, and the other words count apart", () => {
    const score = scoreTerms(
      "en",
      reference([
        [1, "Hi Marcus, this is Priya Raman from Lumen Foods."],
        [130, "Thanks Priya, talk soon."],
      ]),
      hypothesis([
        [1, "Hi Marcus, this is Prey Raymond from Lumin Food."],
        [130.5, "Thanks Priya talk soon Rotterdam"],
      ]),
      { said: ["Marcus", "Priya Raman", "Lumen Foods", "Priya"], notSaid: ["Rotterdam"] },
    );
    expect(score).toEqual({
      occurrences: 4,
      wrong: 2,
      others: { errors: 1, total: 7 },
      unsaid: 1,
    });
  });

  test("Chinese, character by character: a name with one character wrong or missing is wrong", () => {
    const score = scoreTerms(
      "zh",
      reference([[1, "王总你好，我们的项目经理李明会把施工图发给你。"]]),
      hypothesis([[1, "华总你好，我们的项目经理云会把施工图发给你。"]]),
      { said: ["王总", "李明"], notSaid: [] },
    );
    expect(score).toEqual({
      occurrences: 2,
      wrong: 2,
      others: { errors: 0, total: 17 },
      unsaid: 0,
    });

    const right = scoreTerms(
      "zh",
      reference([[1, "王总你好，我们的项目经理李明会把施工图发给你。"]]),
      hypothesis([[1, "王总，你好。我们的项目经理李明会把施工图发给你"]]),
      { said: ["王总", "李明"], notSaid: ["Rotterdam"] },
    );
    expect(right).toEqual({
      occurrences: 2,
      wrong: 0,
      others: { errors: 0, total: 17 },
      unsaid: 0,
    });
  });

  test("words.json gives every case its words, said and not, and none it is told twice", async () => {
    const words = await readWords();
    const cases = await readCases();
    expect(Object.keys(words).sort()).toEqual(cases.map((each) => each.id).sort());
    for (const [id, { said, notSaid, told }] of Object.entries(words)) {
      expect(told.slice().sort(), id).toEqual([...said, ...notSaid].sort());
      expect(new Set(told).size, id).toBe(told.length);
    }
    expect(words["zh-online-R8007_M8011"]?.said).toContain("抖音");
    expect(words["en-room-TS3003b"]?.said).toContain("Teletext");
  });
});
