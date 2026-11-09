import { describe, expect, test } from "vitest";
import {
  cleanSpeech,
  onlyPromptWord,
  textOfResult,
  wordsOnly,
} from "../../src/core/transcription/speechText";

/** A result as sherpa-onnx writes it: its text goes in as it is, apart from quotes and backslashes. */
const resultOf = (text: string, tokens: string[] = []) =>
  `{"lang": "", "emotion": "", "event": "", "text": "${text}", "timestamps": [], "tokens": ${JSON.stringify(
    tokens,
  ).replace(/\\u([0-9a-f]{4})/g, (_, code: string) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  )}, "words": []}`;

describe("A result's text, as sherpa-onnx writes it (#981)", () => {
  test("is read when it holds a newline, a tab or another control character", () => {
    expect(textOfResult(resultOf("two\nlines"))).toBe("two\nlines");
    expect(textOfResult(resultOf("a\ttab"))).toBe("a\ttab");
    expect(textOfResult(resultOf("\u0001\u0007bell and DEL\u007f"))).toBe(
      "\u0001\u0007bell and DEL\u007f",
    );
    expect(() => JSON.parse(resultOf("two\nlines"))).toThrow(/control character/);
  });

  test("is read when it is in Chinese, or has quotes and backslashes, or its tokens hold control characters", () => {
    expect(textOfResult(resultOf("发布日期\n推迟了。"))).toBe("发布日期\n推迟了。");
    expect(textOfResult(resultOf('He said \\"hi\\" and a\\\\b\n'))).toBe('He said "hi" and a\\b\n');
    expect(textOfResult(resultOf("fine", ["fi", "ne\n", "\t"]))).toBe("fine");
  });

  test("is as it was for a result that reads as it is, and empty when it has none", () => {
    expect(textOfResult('{"text": "plain"}')).toBe("plain");
    expect(textOfResult('{"lang": ""}')).toBe("");
    expect(textOfResult('{"text": 3}')).toBe("");
    expect(() => textOfResult("not json")).toThrow(SyntaxError);
  });
});

describe("Speech kept as one line of words (#981)", () => {
  test("a break is a space, another control character is left out, and the line is trimmed", () => {
    expect(cleanSpeech("The launch\nmoves\tto the\u0007 eighteenth.\r\n\r\nDone")).toBe(
      "The launch moves to the eighteenth. Done",
    );
    expect(cleanSpeech("\n\n  发布日期\u0000推迟。\n")).toBe("发布日期推迟。");
    expect(cleanSpeech("\u0001\u0002\n")).toBe("");
  });

  test("a break beside another control character still keeps the words apart", () => {
    expect(cleanSpeech("launch\n\u0007moves")).toBe("launch moves");
    expect(cleanSpeech("launch\u0007\nmoves")).toBe("launch moves");
    expect(cleanSpeech("launch\u0000\t\u0001moves\r\u007f\nto")).toBe("launch moves to");
    expect(cleanSpeech("发布\n\u0000日期")).toBe("发布 日期");
  });

  test("a control character between two letters with no break is left out", () => {
    expect(cleanSpeech("launch\u0007moves")).toBe("launchmoves");
  });

  test("text with no control characters is left as it is", () => {
    expect(cleanSpeech("  Plain words, 你好。 ")).toBe("Plain words, 你好。");
  });
});

describe("The words after the model's header (#981)", () => {
  test("the header at the start is taken off, with a stray token the model began with", () => {
    expect(wordsOnly("language English<asr_text>Local authorities are warning.")).toBe(
      "Local authorities are warning.",
    );
    expect(wordsOnly("提uggestion\nlanguage English<asr_text>Local authorities are warning.")).toBe(
      "Local authorities are warning.",
    );
    expect(wordsOnly("language Chinese<asr_text>发布日期推迟了。")).toBe("发布日期推迟了。");
    expect(wordsOnly("language English<asr_text>")).toBe("");
  });

  test("a header further in leaves the words around it, which can't be told from it", () => {
    const said =
      "Local authorities are warning residents language English<asr_text>to stay indoors.";
    expect(wordsOnly(said)).toBe(said);
    const twice = "language English<asr_text>First words. language English<asr_text>More words.";
    expect(wordsOnly(twice)).toBe("First words. language English<asr_text>More words.");
    expect(wordsOnly("Hello there\nlanguage English<asr_text>and more.")).toBe(
      "Hello there\nlanguage English<asr_text>and more.",
    );
  });

  test("words with no header are as they are", () => {
    expect(wordsOnly("Local authorities are warning.")).toBe("Local authorities are warning.");
    expect(wordsOnly("")).toBe("");
  });

  // protects=a header with no words after it, cut short or whole, is nothing said, while "system" alone stays words here, as only the engine knows whether the call is English and someone may have said it (#1031); fails_when="language Chinese" reaches the Transcript, or a one-word "System." is dropped from every call; no_claim=when the engine leaves "system" out, which tests/core/shortSpeech.test.ts covers.
  test('a header alone is no words; the word "system" alone is, and is told apart', () => {
    for (const header of ["language Chinese", "language None", "language English ", "<asr_text>"]) {
      expect(wordsOnly(header)).toBe("");
    }
    expect(wordsOnly("System.")).toBe("System.");
    expect(wordsOnly("<asr_text>system")).toBe("system");

    for (const alone of ["system", "System.", " system。 "]) {
      expect(onlyPromptWord(alone)).toBe(true);
    }
    for (const said of ["The system is down.", "Systems.", "System one.", "", "。"]) {
      expect(onlyPromptWord(said)).toBe(false);
    }
  });
});
