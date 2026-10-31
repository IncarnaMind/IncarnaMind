import { describe, expect, test } from "vitest";
import { contextWords, echoes, hotwordsOf } from "../../src/core/transcription/context";

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
});
