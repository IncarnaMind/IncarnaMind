import { describe, expect, test } from "vitest";
import {
  characters,
  editDistance,
  errorRate,
  normalise,
  words,
} from "../../eval/transcription/scoring";

describe("Scoring transcription: the normalisation rules", () => {
  test("case, punctuation and symbols go, in both scripts; full-width letters and digits become ASCII", () => {
    expect(normalise("When you call someone, you're using a SATELLITE!")).toBe(
      "when you call someone youre using a satellite",
    );
    expect(normalise("报告警告称，没有人能保证……“目前”")).toBe("报告警告称 没有人能保证 目前");
    expect(normalise("ＷｉＦｉ　门铃，２１比２０")).toBe("wifi 门铃 21比20");
  });

  test("English is cut into words, Chinese into Han characters and runs of letters or digits", () => {
    expect(words("The U.N. also hopes")).toEqual(["the", "u", "n", "also", "hopes"]);
    expect(characters("他称，他制作了一个 WiFi 门铃。")).toEqual([
      "他",
      "称",
      "他",
      "制",
      "作",
      "了",
      "1",
      "个",
      "wifi",
      "门",
      "铃",
    ]);
    expect(characters("可达6英里")).toEqual(["可", "达", "6", "英", "里"]);
    expect(characters("可达六英里")).toEqual(["可", "达", "6", "英", "里"]);
  });

  test("tags and hesitations are dropped from both sides", () => {
    expect(normalise("[LAUGHTER] Um, so <unk> uh-huh, Mm-hmm, hmm... okay [UNK]")).toBe(
      "so huh okay",
    );
    expect(characters("呃what's the呃，嗯，好")).toEqual(["whats", "the", "好"]);
  });

  test("traditional characters become simplified ones", () => {
    expect(characters("電話會議")).toEqual(characters("电话会议"));
  });

  test("English number words become digits, as digits are", () => {
    const same = (spoken: string, digits: string) =>
      expect(normalise(spoken)).toBe(normalise(digits));
    same("twenty five euros", "25 euros");
    same("one hundred and five", "105");
    same("two thousand and ten", "2,010");
    same("three hundred thousand", "300000");
    same("a hundred", "a 100");
    same("fifteen euros and twenty pence", "15 euros and 20 pence");
    same("one two three", "1 2 3");
    same("ninety nine", "99");
    expect(normalise("five and a half, the second one")).toBe("5 and a half the second 1");
    expect(normalise("zero")).toBe("0");
    expect(normalise("twenty twenty")).toBe("20 20");
  });

  test("Chinese numerals become digits, as digits are", () => {
    const same = (spoken: string, digits: string) =>
      expect(characters(spoken)).toEqual(characters(digits));
    same("二十五", "25");
    same("一百零五", "105");
    same("三万五千", "35000");
    same("二零二六年", "2026年");
    same("十五", "15");
    same("两百", "200");
    same("六英里", "6英里");
    expect(normalise("2万")).toBe("2万");
    expect(normalise("百分之")).toBe("百分之");
  });

  test("error rates count substitutions, deletions and insertions over the reference", () => {
    expect(editDistance(["a", "b", "c"], ["a", "x", "c", "d"])).toBe(2);
    expect(editDistance([], ["a", "b"])).toBe(2);
    expect(editDistance(["a", "b"], [])).toBe(2);
    expect(errorRate(words("the cat sat"), words("the cat sat"))).toEqual({
      errors: 0,
      total: 3,
      rate: 0,
    });
    expect(errorRate(characters("可达6英里"), characters("可达五英里")).rate).toBeCloseTo(0.2);
    expect(errorRate(characters("可达6英里"), characters("可达六英里")).rate).toBe(0);
    expect(errorRate([], ["a"]).rate).toBe(0);
  });
});
