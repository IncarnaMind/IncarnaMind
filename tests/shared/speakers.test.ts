import { describe, expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";
import {
  isTheirs,
  numberedVoice,
  SPEAKER_ME,
  SPEAKER_THEM,
  SPEAKER_UNKNOWN,
  speakerKey,
  speakerName,
} from "../../src/shared/speakers";

describe("The words for who said a live line (#941)", () => {
  test.each([
    [SPEAKER_ME, "Me", "我"],
    [SPEAKER_THEM, "Them", "对方"],
    [SPEAKER_UNKNOWN, "Speaker ?", "发言人 ?"],
  ])("%s is worded in English and Chinese", (speaker, english, chinese) => {
    const key = speakerKey(speaker);
    expect(key).not.toBeNull();
    if (!key) return;
    expect(translate("en", key)).toBe(english);
    expect(translate("zh-CN", key)).toBe(chinese);
  });

  test("a person's name is shown as it is", () => {
    expect(speakerKey("Dana")).toBeNull();
    expect(speakerKey("Speaker 1")).toBeNull();
  });

  test('voices told apart are "Speaker n" in the interface\'s language, and so are those a Transcript saved before #138 numbered "Them n"', () => {
    const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("en", key, params);
    const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("zh-CN", key, params);
    expect(speakerName(numberedVoice(2), en)).toBe("Speaker 2");
    expect(speakerName(numberedVoice(2), zh)).toBe("发言人 2");
    expect(speakerName("Them 2", en)).toBe("Speaker 2");
    expect(speakerName("Them 2", zh)).toBe("发言人 2");
  });

  test("every line but the User's microphone and an unknown speaker's is another person's", () => {
    expect([numberedVoice(2), SPEAKER_THEM, "Them 2", "Dana"].every(isTheirs)).toBe(true);
    expect([SPEAKER_ME, SPEAKER_UNKNOWN, null].some(isTheirs)).toBe(false);
  });
});
