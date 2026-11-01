import { describe, expect, test } from "vitest";
import {
  contextWords,
  echoes,
  hotwordsOf,
  withToldWords,
} from "../../src/core/transcription/context";

describe("The words the transcriber on this computer is told (#1031)", () => {
  test("each word once whatever its case, on one line, with no comma to split it", () => {
    expect(
      contextWords(["Priya Raman", "priya raman", "Harbor,  Logistics", " 星河科技 ", "", "王总"]),
    ).toEqual(["Priya Raman", "Harbor Logistics", "星河科技", "王总"]);
    expect(hotwordsOf(["Priya Raman", "Harbor Logistics", "星河科技"])).toBe(
      "Priya Raman,Harbor Logistics,星河科技",
    );
  });

  test("as many as fit in the engine's prompt, in the order given, and no more", () => {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const names = [...letters].map((letter) => `Rotterda${letter}`);
    expect(contextWords(names)).toEqual(names.slice(0, 16));
    const han = [..."丽明伟芳强军洋勇艳杰娟涛超霞平刚桂英华"].map((given) => `王${given}总`);
    expect(contextWords(han)).toEqual(han.slice(0, 16));
  });

  test("the list written out instead of the speech is an echo; the words said in a sentence aren't", () => {
    const words = ["陈经理", "星河科技", "王丽", "王总", "李明"];
    expect(echoes("陈经理 星河科技 王丽 王总 李明。", words)).toBe(true);
    expect(
      echoes("陈经理、星河科技、王丽、王总、李明。神经理，你好，我是星河科技的王丽。", words),
    ).toBe(true);
    expect(echoes("陈经理你好，我是星河科技的王丽。", words)).toBe(false);

    const english = ["Marcus", "Priya Raman", "Lumen Foods", "Harbor Logistics"];
    expect(echoes("Marcus, Priya Raman, Lumen Foods, Harbor Logistics.", english)).toBe(true);
    expect(
      echoes(
        "Hi Marcus, this is Priya Raman from Lumen Foods. The Harbor Logistics renewal.",
        english,
      ),
    ).toBe(false);
  });

  test("one word told can't be told from that word being said", () => {
    expect(echoes("Rotterdam.", ["Rotterdam"])).toBe(false);
    expect(echoes("Rotterdam, Daniel.", ["Rotterdam", "Daniel"])).toBe(true);
    expect(echoes("Rotterdam can handle that.", ["Rotterdam", "Daniel"])).toBe(false);
  });

  describe("the told reading gives only its names to the first one", () => {
    const english = ["Marcus", "Priya Raman", "Lumen Foods", "Harbor Logistics", "Sofia Lindqvist"];
    const chinese = ["陈经理", "星河科技", "王丽", "王总", "李明"];

    test("a misheard name takes the told reading's, in English and Chinese, a name's own parts too", () => {
      expect(
        withToldWords(
          "This is Priyaman from Lumin Food. I want to go over the Arbor Logistics renewal.",
          "This is Priya Raman from Lumen Foods. I want to go over the Harbor Logistics renewal.",
          english,
        ),
      ).toBe(
        "This is Priya Raman from Lumen Foods. I want to go over the Harbor Logistics renewal.",
      );
      expect(
        withToldWords(
          "Our operations lead, Sophia Lindvist will send it. Thanks, Creer.",
          "Our operations lead, Sofia Lindqvist. We'll send it. Thanks, Priya.",
          english,
        ),
      ).toBe("Our operations lead, Sofia Lindqvist will send it. Thanks, Priya.");
      expect(
        withToldWords(
          "陈经理，你好，我是新和科技的王力。项目经理云会把施工图发给你。",
          "陈经理，你好，我是星河科技的王丽。项目经理李明会把施工图发给你。",
          chinese,
        ),
      ).toBe("陈经理，你好，我是星河科技的王丽。项目经理李明会把施工图发给你。");
    });

    test("a told name is written as the User writes it, whatever case the model wrote", () => {
      expect(
        withToldWords(
          "I want to go over the harbor logistics renewal.",
          "I want to go over the harbor logistics renewal.",
          english,
        ),
      ).toBe("I want to go over the Harbor Logistics renewal.");
      expect(withToldWords("Thanks, Pria.", "Thanks, Priya.", english)).toBe("Thanks, Priya.");
      // A part of a name only where the model wrote it as a name.
      expect(
        withToldWords("The ships are in the harbour.", "The ships are in the harbor.", english),
      ).toBe("The ships are in the harbour.");
      expect(withToldWords("Thanks, everyone.", "Thanks, everyone.", english)).toBe(
        "Thanks, everyone.",
      );
    });

    test("everything else stays as first read: words the told reading dropped or changed", () => {
      expect(
        withToldWords(
          "但是我发现，她这生活类的段子嘛，假科普的现象很严重。",
          "但是我发现她。假科普的现象很严重。",
          ["段子", "主播"],
        ),
      ).toBe("但是我发现，她这生活类的段子嘛，假科普的现象很严重。");
      expect(
        withToldWords(
          "So the action items are: Sophia sends the plan.",
          "Sophia's items are: Sofia sends the plan.",
          ["Sofia Lindqvist"],
        ),
      ).toBe("So the action items are: Sofia sends the plan.");
    });

    test("a told name goes nowhere the first reading heard nothing, or something far longer or shorter", () => {
      expect(withToldWords("对，我也看过。", "李明对，我也看过。", chinese)).toBe("对，我也看过。");
      expect(withToldWords("Okay, sounds good.", "Okay, sounds good, Marcus.", english)).toBe(
        "Okay, sounds good.",
      );
      expect(
        withToldWords("Thanks, and see you then.", "Thanks, Harbor Logistics then.", english),
      ).toBe("Thanks, and see you then.");
      // An echo of the list is no reading of the speech at all.
      expect(withToldWords("神经理，你好。", "陈经理，星河科技，王丽，王总，李明。", chinese)).toBe(
        "神经理，你好。",
      );
      expect(withToldWords("神经理，你好。", "陈经理，你好。", chinese)).toBe("陈经理，你好。");
    });
  });
});
