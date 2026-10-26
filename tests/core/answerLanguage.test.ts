// #892: the Answer follows the Question's language, and quoted words are never a translation.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  documentInstructions,
  mindInstructions,
  skillSetsLanguage,
} from "../../src/core/answers/prompt";
import {
  askAndFinish,
  citeFeedback,
  citingModel,
  onlyCitation,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { answerText } from "../helpers/minds";
import { promptOf, scriptedModel } from "../helpers/models";

const TIDES = {
  name: "Tides.md",
  contents:
    "# Tides\n\nSpring tides happen at new moon and at full moon, when the Sun and the Moon pull together.\n",
};
const CHAOXI = {
  name: "潮汐.md",
  contents: "# 潮汐\n\n大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。\n",
};

async function languageLineOf(
  question: string,
  documents: readonly { name: string; contents: string }[],
  interfaceLanguage: "en" | "zh-CN" = "en",
): Promise<string> {
  const model = scriptedModel(() => ({ text: "OK" }));
  const { core, client, mind } = await setUpWithDocuments(model, documents);
  await core.updateSettings({ user: { language: interfaceLanguage } });
  await askAndFinish(core, client, mind.id, question);
  return (promptOf(model)[0]?.text ?? "").split("\n").at(-1) ?? "";
}

describe("The language the model is told to answer in", () => {
  test("a Chinese Question over an English Document: Chinese", async () => {
    expect(await languageLineOf("大潮什么时候出现？", [TIDES])).toBe(
      "- The Question is written in Chinese, so answer in Chinese.",
    );
  });

  test("an English Question over a Chinese Document: English, however Chinese the Documents are", async () => {
    expect(await languageLineOf("Which of my documents mention tides?", [CHAOXI])).toBe(
      "- The Question is written in English, so answer in English.",
    );
    expect(await languageLineOf("When do spring tides happen?", [CHAOXI, TIDES], "zh-CN")).toBe(
      "- Write the Answer in the language of the Question itself, not the Documents'.",
    );
  });

  test("a Japanese or Korean Question is answered in its own language", async () => {
    expect(await languageLineOf("大潮はいつ起きますか？", [TIDES])).toBe(
      "- The Question is written in Japanese, so answer in Japanese.",
    );
    expect(await languageLineOf("대조는 언제 일어나나요?", [TIDES])).toBe(
      "- The Question is written in Korean, so answer in Korean.",
    );
  });

  test("an English sentence that names a Chinese Document is English, and a Chinese one that names an English term is Chinese", async () => {
    expect(await languageLineOf("What does 潮汐 say about the moon, please?", [CHAOXI])).toBe(
      "- The Question is written in English, so answer in English.",
    );
    expect(await languageLineOf("请总结 Tides 里关于 spring tides 的说法", [TIDES])).toBe(
      "- The Question is written in Chinese, so answer in Chinese.",
    );
  });

  test.each([
    ["a Document's name", "Tides", "en", "English"],
    ["a Document's name with its extension", "tides.md", "zh-CN", "Simplified Chinese"],
    ["a Chinese Document's name", "潮汐", "en", "English"],
    ["a figure", "28.4", "zh-CN", "Simplified Chinese"],
    ["a figure with its unit", "¥1,250", "en", "English"],
  ] as const)(
    "%s alone has no language: the interface's",
    async (_kind, question, language, name) => {
      const line = await languageLineOf(question, [TIDES, CHAOXI], language);
      expect(line).toMatch(
        new RegExp(`^- The Question is only a name or a figure.*answer in ${name}`),
      );
    },
  );
});

async function askQuoting(
  file: { name: string; contents: string },
  question: string,
  quote: string,
  answer: string,
  query = "spring tides",
) {
  const model = citingModel({
    query,
    records: (passages: ShownPassage[]) => [{ marker: 1, passage: passages[0]?.id, quote }],
    answer,
  });
  const { core, client, mind } = await setUpWithDocuments(model, [file]);
  const { answerId, finished } = await askAndFinish(core, client, mind.id, question);
  return { client, answerId, finished, model };
}

describe("The instructions on quotation marks and on what goes into a Mind", () => {
  test("words in quotation marks stay in the Document's language, a translation after them, and a Mind gets the same rules", () => {
    const system = documentInstructions("tools", { total: 1, names: ["Tides"] });

    expect(system).toContain("in its own language");
    expect(system).toContain("A translation goes after the closing mark");
    expect(mindInstructions(true)).toContain(
      "the same rules as your replies: the language of the Question, and quotation marks only around a Document's own words",
    );
  });
});

describe("A translation inside quotation marks", () => {
  test("a Chinese translation of an English sentence is taken out of its quotation marks, and its Citation stays found", async () => {
    const { client, answerId, finished } = await askQuoting(
      TIDES,
      "大潮什么时候出现？",
      "Spring tides happen at new moon and at full moon",
      "论文写道：“大潮在新月和满月时出现，那时太阳和月亮的引力叠加在一起”[^1]。",
    );

    const text = answerText(client, answerId);
    expect(text).toContain("大潮在新月和满月时出现，那时太阳和月亮的引力叠加在一起");
    expect(text).not.toMatch(/[“”"]/);
    expect(onlyCitation(client, answerId)).toMatchObject({ check: "found", checkReason: null });
    expect(finished.citations[0]).toMatchObject({ check: "found" });
    expect(finished.citations[0]?.quotedWords).toBeUndefined();
  });

  test("an English translation of a Chinese sentence is taken out of its quotation marks too", async () => {
    const { client, answerId } = await askQuoting(
      CHAOXI,
      "When do spring tides happen?",
      "大潮出现在新月和满月前后",
      'The text says "spring tides come around the new moon and the full moon" [^1].',
      "大潮",
    );

    const text = answerText(client, answerId);
    expect(text).toContain("spring tides come around the new moon and the full moon");
    expect(text).not.toMatch(/["“”]/);
    expect(onlyCitation(client, answerId)).toMatchObject({ check: "found", checkReason: null });
  });

  test("the Document's own words in quotation marks, with the translation after them, stay as they are", async () => {
    const { client, answerId } = await askQuoting(
      TIDES,
      "大潮什么时候出现？",
      "Spring tides happen at new moon and at full moon",
      "原文：“Spring tides happen at new moon and at full moon”（译：大潮出现在新月和满月）[^1]。",
    );

    const text = answerText(client, answerId);
    expect(text).toContain("“Spring tides happen at new moon and at full moon”");
    expect(text).toContain("（译：大潮出现在新月和满月）");
    expect(onlyCitation(client, answerId)).toMatchObject({ check: "found", checkReason: null });
  });

  test("words in the Document's language that the Document doesn't have are still not found", async () => {
    const { client, answerId } = await askQuoting(
      TIDES,
      "When do spring tides happen?",
      "Spring tides happen at new moon and at full moon",
      "It says “spring tides happen at the new moon alone, never at full moon” [^1].",
    );

    expect(answerText(client, answerId)).toContain("“spring tides happen at the new moon alone");
    expect(onlyCitation(client, answerId)).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
    });
  });

  test("a record whose quote is a translation is told to copy it from the Passage in its own language", async () => {
    const { model } = await askQuoting(
      TIDES,
      "大潮什么时候出现？",
      "大潮在新月和满月时出现",
      "大潮出现在新月和满月[^1]。",
    );

    expect(citeFeedback(model)).toMatch(
      /the quote is a translation: copy it from P1 in the Passage's own language/,
    );
  });
});

describe("A Skill that names a language (#1273)", () => {
  test.each([
    "Write the summary in French.",
    "Answer in the language of the contract.",
    "Reply in English whatever the Question says.",
    "用中文写摘要。",
    "Respond in Japanese.",
  ])("is read as one: %s", (instructions) => {
    expect(skillSetsLanguage(instructions)).toBe(true);
  });

  test.each([
    "Summarize the tides in three bullet points.",
    "Cite every figure with its page.",
    "Write in the language the Question is written in, even when the Documents are in another language.",
    "Write it in the language of the Question, and translate the headings too.",
    "Answer in the Question's language.",
    "",
  ])("and one that names none is not: %s", (instructions) => {
    expect(skillSetsLanguage(instructions)).toBe(false);
  });
});

describe("The built-in Skills (#1273)", () => {
  const names = readdirSync("resources/skills");

  test.each(names)("%s names no language but the Question's, so it gets the note", (name) => {
    const instructions = readFileSync(`resources/skills/${name}/SKILL.md`, "utf8");
    expect(skillSetsLanguage(instructions)).toBe(false);
  });
});
