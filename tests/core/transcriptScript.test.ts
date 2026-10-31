import { describe, expect, test } from "vitest";
import { inScript } from "../../src/core/transcription/script";
import { transcriptScript } from "../../src/shared/meetingWords";

describe("Chinese in a Transcript, in the User's script (#1031)", () => {
  test("a Traditional line is written in Simplified for a User who reads Simplified", () => {
    expect(
      inScript("我們下週一把蓋章的合同寄給你們。頭髮很長，後來發現麵條在裡面。", "simplified"),
    ).toBe("我们下周一把盖章的合同寄给你们。头发很长，后来发现面条在里面。");
    expect(inScript("會議室需要能坐二十四個人。", "simplified")).toBe("会议室需要能坐二十四个人。");
  });

  test("a Simplified line is written in Traditional by its phrases, which one character can't say", () => {
    expect(inScript("头发很长，后来发现面条在里面。", "traditional")).toBe(
      "頭髮很長，後來發現麵條在裡面。",
    );
    expect(inScript("我们下周一把盖章的合同寄给你们。", "traditional")).toBe(
      "我們下週一把蓋章的合同寄給你們。",
    );
    // Its words stay as said: no Taiwanese word for a mainland one.
    expect(inScript("软件", "traditional")).toBe("軟件");
  });

  test("a line already in the script, and one with no Chinese, stay as they are", () => {
    expect(inScript("会议室需要能坐二十四个人。", "simplified")).toBe("会议室需要能坐二十四个人。");
    expect(inScript("會議室需要能坐二十四個人。", "traditional")).toBe(
      "會議室需要能坐二十四個人。",
    );
    expect(inScript("The launch moves to November 18.", "traditional")).toBe(
      "The launch moves to November 18.",
    );
    expect(inScript("Priya 说 48,500 dollars。", "traditional")).toBe("Priya 說 48,500 dollars。");
  });

  test("the script follows the interface unless the User chose one", () => {
    expect(transcriptScript(null, "zh-CN", ["zh-TW"])).toBe("simplified");
    expect(transcriptScript(null, "system", ["zh-TW", "en-US"])).toBe("traditional");
    expect(transcriptScript(null, "system", ["zh_HK"])).toBe("traditional");
    expect(transcriptScript(null, "system", ["zh-CN"])).toBe("simplified");
    expect(transcriptScript(null, "en", ["en-GB", "zh-Hant-TW"])).toBe("traditional");
    expect(transcriptScript(null, "en", ["en-US"])).toBe("simplified");
    expect(transcriptScript("traditional", "zh-CN", ["zh-CN"])).toBe("traditional");
    expect(transcriptScript("simplified", "system", ["zh-TW"])).toBe("simplified");
  });
});
