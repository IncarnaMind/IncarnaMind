import { describe, expect, test } from "vitest";
import {
  contextWords,
  echoes,
  hotwordsOf,
  mayMend,
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
      // One reading runs on past the other at both ends.
      expect(
        withToldWords(
          "Hi, this is Priyaman from Lumen Foods, by Friday.",
          "This is Priya Raman from Lumen Foods.",
          english,
        ),
      ).toBe("Hi, this is Priya Raman from Lumen Foods, by Friday.");
    });

    test("a word that is already a told name, or part of one, is never another told name", () => {
      expect(withToldWords("Sara will call.", "Sarah will call.", ["Sara", "Sarah"])).toBe(
        "Sara will call.",
      );
      expect(
        withToldWords("Send it to Daniel.", "Send it to Danielle.", [
          "Daniel Weiss",
          "Danielle West",
        ]),
      ).toBe("Send it to Daniel.");
      expect(withToldWords("张伟和张薇都来了。", "张薇和张薇都来了。", ["张伟", "张薇"])).toBe(
        "张伟和张薇都来了。",
      );
      // A part of the very name told still lets the rest of it be mended.
      expect(withToldWords("This is Priya Ramen.", "This is Priya Raman.", english)).toBe(
        "This is Priya Raman.",
      );
    });

    test("a Chinese told name replaces nothing, everyday words that read the same included", () => {
      for (const [plain, told, names] of [
        ["保洁阿姨下午来。", "宝洁阿姨下午来。", ["宝洁"]],
        ["我们往里走。", "我们王丽走。", chinese],
        ["黎明的时候出发。", "李明的时候出发。", chinese],
        ["这事理明白了。", "这事李明白了。", chinese],
        ["我是星河科技的王力。", "我是星河科技的王丽。", chinese],
      ] as const) {
        expect(withToldWords(plain, told, names)).toBe(plain);
      }
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
        withToldWords(
          "Our operations lead, so Felix Twist will send you a capacity plan.",
          "Our operations lead, Sophie Lindgren will send you a capacity plan.",
          ["Sophie Lindgren"],
        ),
      ).toBe("Our operations lead, so Felix Twist will send you a capacity plan.");
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
      expect(withToldWords("I will send it.", "I will send it.", ["Will"])).toBe("I will send it.");
      // A word in lower case is never a name, however like a told one it sounds.
      expect(withToldWords("I hope so.", "I Hoppe so.", ["Hoppe"])).toBe("I hope so.");
      expect(withToldWords("We will see.", "We Wil see.", ["Wil"])).toBe("We will see.");
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
      expect(withToldWords("王力，你好。", "王丽，你好。", chinese)).toBe("王力，你好。");
    });

    test("a stretch is read again only where its first reading holds a told name misheard", () => {
      expect(mayMend("This is Priyaman from Lumen Foods.", english)).toBe(true);
      expect(mayMend("Our operations lead, Sophia Lindvist will send it.", english)).toBe(true);
      expect(mayMend("Thanks, see you on Friday.", english)).toBe(false);
      expect(mayMend("Sofia Lindqvist will send it, Priya.", english)).toBe(false);
      expect(mayMend("I will send it. Hope so.", ["Will", "Hope"])).toBe(false);
      expect(mayMend("Send it to Daniel.", ["Daniel Weiss", "Danielle West"])).toBe(false);
      expect(mayMend("我们的项目经理李名会把施工图发给你。", chinese)).toBe(false);
      expect(mayMend("This is Priyaman.", [])).toBe(false);
    });

    test("every stretch the told names mend is one the first reading said may hold them", () => {
      for (const [plain, told, names] of [
        [
          "This is Priyaman from Lumen Foods. I want to go over the Arbor Logistics renewal.",
          "This is Priya Raman from Lumen Foods. I want to go over the Harbor Logistics renewal.",
          english,
        ],
        [
          "Our operations lead, Sophia Lindvist will send it. Thanks, Pria.",
          "Our operations lead, Sofia Lindqvist. We'll send it. Thanks, Priya.",
          english,
        ],
        [
          "So the action items are: Sophia sends the plan.",
          "Sophia's items are: Sofia sends the plan.",
          ["Sofia Lindqvist"],
        ],
        ["This is Priya Ramen.", "This is Priya Raman.", english],
      ] as const) {
        expect(withToldWords(plain, told, names)).not.toBe(plain);
        expect(mayMend(plain, names)).toBe(true);
      }
    });
  });
});
