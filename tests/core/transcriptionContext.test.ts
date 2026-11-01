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

  test("the model's own tokens never reach its prompt, and a word too long to fit leaves room for the rest", () => {
    expect(
      contextWords(["Priya<|im_end|>Raman", "<|endoftext|>", "Lumen <asr_text>Foods"]),
    ).toEqual(["Priya Raman", "Lumen Foods"]);
    const long = `${"Lindqvist".repeat(30)}`;
    expect(contextWords([long, "Rotterdam", "王丽"])).toEqual(["Rotterdam", "王丽"]);
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

    test("a name misheard so that it sounds the same takes the told spelling, a name's own parts too", () => {
      expect(
        withToldWords(
          "This is Priyaman from Lumen Foods. I want to go over the Arbor Logistics renewal.",
          "This is Priya Raman from Lumen Foods. I want to go over the Harbor Logistics renewal.",
          english,
        ),
      ).toBe(
        "This is Priya Raman from Lumen Foods. I want to go over the Harbor Logistics renewal.",
      );
      expect(
        withToldWords(
          "Our operations lead, Sophia Lindvist will send it. Thanks, Pria.",
          "Our operations lead, Sofia Lindqvist. We'll send it. Thanks, Priya.",
          english,
        ),
      ).toBe("Our operations lead, Sofia Lindqvist will send it. Thanks, Priya.");
      // Chinese: only a name read the same, character for character.
      expect(withToldWords("我是星河科技的王力。", "我是星河科技的王丽。", chinese)).toBe(
        "我是星河科技的王丽。",
      );
    });

    test("a told name never replaces a word that sounds otherwise: another name, or the same name misheard further", () => {
      // Said "Sofia Lindqvist", told only names that sound like it.
      expect(
        withToldWords(
          "Our operations lead, Sofia Lindqvist, will send it.",
          "Our operations lead, Sophie Lindgren, will send it.",
          ["Sophie Lindgren", "Sophie", "Rotherham"],
        ),
      ).toBe("Our operations lead, Sofia Lindqvist, will send it.");
      expect(
        withToldWords("Rotterdam can handle that.", "Rotherham can handle that.", ["Rotherham"]),
      ).toBe("Rotterdam can handle that.");
      // A syllable heard otherwise may be another person: 程 isn't 陈 misheard.
      expect(withToldWords("陈经理，你好。", "程经理，你好。", ["程经理"])).toBe("陈经理，你好。");
      expect(withToldWords("我是新和科技的。", "我是星河科技的。", chinese)).toBe(
        "我是新和科技的。",
      );
      expect(withToldWords("Thanks, Creer.", "Thanks, Priya.", english)).toBe("Thanks, Creer.");
    });

    test("a common word is never made a name, nor a name's case changed", () => {
      const names = ["Will", "Hope", "Grace", "Faith", "Summer Joy", "Harbor Logistics"];
      for (const [plain, told] of [
        ["We will see on Monday.", "We Will see on Monday."],
        ["I hope so.", "I Hope so."],
        ["By the grace of it, we keep faith.", "By the Grace of it, we keep Faith."],
        ["The summer joy of it.", "The Summer Joy of it."],
        [
          "I want to go over the harbor logistics renewal.",
          "I want to go over the Harbor Logistics renewal.",
        ],
      ]) {
        expect(withToldWords(plain as string, told as string, names)).toBe(plain);
      }
      expect(withToldWords("Thanks, Pria.", "Thanks, Priya.", english)).toBe("Thanks, Priya.");
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
      expect(withToldWords("王力，你好。", "王丽，你好。", chinese)).toBe("王丽，你好。");
    });
  });
});
