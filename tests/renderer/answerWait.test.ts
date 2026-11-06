import { afterEach, describe, expect, test } from "vitest";
import { setSilentWaitMs, waitText, waitTextShort } from "../../src/renderer/src/answerWaitWords";
import { translate } from "../../src/shared/i18n";

/*
 * The wait that joins an Answer's step line once it has been silent for 15
 * seconds (#899, #2530): how long its model usually takes, in rough measures,
 * or nothing at all.
 */

type Key = Parameters<typeof translate>[1];
type Params = Parameters<typeof translate>[2];
const en = (key: Key, params?: Params) => translate("en", key, params);
const zh = (key: Key, params?: Params) => translate("zh-CN", key, params);
const SONNET = "Claude Sonnet 5.5";

afterEach(() => setSilentWaitMs(15_000));

describe("The wait part of an Answer's step line", () => {
  // protects=a usual wait is said in seconds to the nearest ten under a minute, as a minute from 60 to 89 seconds, and in whole minutes from 90, in both languages; fails_when=59 seconds reads "60 seconds", 89 reads "2 minutes", 90 reads "a minute", or Chinese keeps English word order; no_claim=the rounding is for reading, not exact.
  test.each([
    [
      25,
      "usually about 30 seconds with Claude Sonnet 5.5",
      "用 Claude Sonnet 5.5 通常要 30 秒左右",
    ],
    [
      43,
      "usually about 40 seconds with Claude Sonnet 5.5",
      "用 Claude Sonnet 5.5 通常要 40 秒左右",
    ],
    [59, "usually about a minute with Claude Sonnet 5.5", "用 Claude Sonnet 5.5 通常要 1 分钟左右"],
    [60, "usually about a minute with Claude Sonnet 5.5", "用 Claude Sonnet 5.5 通常要 1 分钟左右"],
    [89, "usually about a minute with Claude Sonnet 5.5", "用 Claude Sonnet 5.5 通常要 1 分钟左右"],
    [
      90,
      "usually about 2 minutes with Claude Sonnet 5.5",
      "用 Claude Sonnet 5.5 通常要 2 分钟左右",
    ],
    [
      150,
      "usually about 3 minutes with Claude Sonnet 5.5",
      "用 Claude Sonnet 5.5 通常要 3 分钟左右",
    ],
  ])("%s seconds", (seconds, english, chinese) => {
    expect(waitText(en, seconds, SONNET)).toBe(english);
    expect(waitText(zh, seconds, SONNET)).toBe(chinese);
  });

  // protects=with no history, a usual wait shorter than the wait so far, or no model, nothing joins the line, never "Still working"; fails_when=it claims "usually about 10 seconds" after 15 seconds of silence; no_claim=none beyond protects.
  test("says nothing with no usual wait, one shorter than the wait so far, or no model", () => {
    expect(waitText(en, null, SONNET)).toBeNull();
    expect(waitText(zh, null, SONNET)).toBeNull();
    expect(waitText(en, 10, SONNET)).toBeNull();
    expect(waitText(en, 15, SONNET)).toBeNull();
    expect(waitText(en, 60, null)).toBeNull();
  });

  test("counts the wait so far as the test build sets it", () => {
    setSilentWaitMs(1_000);
    expect(waitText(en, 10, SONNET)).toBe("usually about 10 seconds with Claude Sonnet 5.5");
  });

  // protects=the short wait part says the same measure without the model, for a line too narrow for the whole (#2531); fails_when=the short part keeps the model, the whole part loses it, or the rounding differs; no_claim=none beyond protects.
  test("says the same measure without the model", () => {
    expect(waitTextShort(en, 25)).toBe("usually about 30 seconds");
    expect(waitTextShort(zh, 25)).toBe("通常要 30 秒左右");
    expect(waitTextShort(en, 60)).toBe("usually about a minute");
    expect(waitTextShort(zh, 89)).toBe("通常要 1 分钟左右");
    expect(waitTextShort(en, 90)).toBe("usually about 2 minutes");
    expect(waitTextShort(zh, 150)).toBe("通常要 3 分钟左右");
    expect(waitTextShort(en, null)).toBeNull();
    expect(waitTextShort(en, 10)).toBeNull();
    setSilentWaitMs(1_000);
    expect(waitTextShort(en, 10)).toBe("usually about 10 seconds");
    expect(waitText(en, 60, SONNET)).toBe("usually about a minute with Claude Sonnet 5.5");
  });
});
