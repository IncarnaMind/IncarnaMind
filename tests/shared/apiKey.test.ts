import { describe, expect, test } from "vitest";
import {
  checkApiKey,
  cleanApiKey,
  nameCharacter,
  strayKeyCharacter,
} from "../../src/shared/apiKey";

const KEY = "sk-test-1234567890-not-a-real-key";

describe("A pasted key is cleaned at its ends", () => {
  test.each([
    ["spaces", `  ${KEY}  `],
    ["a line break and a tab", `\n\t${KEY}\r\n`],
    ["a zero-width space", `\u200B${KEY}\u200B`],
    ["a byte order mark", `\uFEFF${KEY}`],
    ["a no-break space", `\u00A0${KEY}\u00A0`],
    ["an ideographic space", `\u3000${KEY}\u3000`],
    ["a zero-width joiner and a word joiner", `\u200D\u2060${KEY}\u2060`],
    ["a variation selector", `${KEY}\uFE0F`],
    ["a Braille blank", `\u2800${KEY}\u2800`],
    ["a Hangul filler", `${KEY}\u3164\uFFA0\u115F`],
    ["a soft hyphen and a combining grapheme joiner", `\u00AD${KEY}\u034F`],
    ["a mix of them", ` \u200B\uFEFF\n${KEY}\u00A0\u200B \n\u2800`],
  ])("without %s", (_name, pasted) => {
    expect(cleanApiKey(pasted)).toBe(KEY);
    expect(checkApiKey(pasted)).toEqual({ key: KEY, stray: null });
  });

  test("a key that is only spaces and invisible characters is blank", () => {
    expect(cleanApiKey(" \u200B\uFEFF\n\u00A0\u2800\u3164")).toBe("");
  });

  test("a key that has nothing around it is left as it is", () => {
    expect(cleanApiKey(KEY)).toBe(KEY);
    expect(strayKeyCharacter(KEY)).toBeNull();
    for (const key of ["AIzaSyA-1234_abcDEF", "sk-ant-api03-Ab_Cd-0123456789==", "a.b~c/d+e:f"]) {
      expect(checkApiKey(key)).toEqual({ key, stray: null });
    }
  });
});

describe("A character keys don't use", () => {
  test("a Chinese word is found, with its first character", () => {
    expect(strayKeyCharacter("sk-test-1234作品-not-a-real-key")).toBe("作");
  });

  test("a typographic quote is found", () => {
    expect(strayKeyCharacter("sk-test-\u2019abc")).toBe("\u2019");
    expect(strayKeyCharacter("sk-\u201Cabc\u201D")).toBe("\u201C");
  });

  test("an invisible character inside the key is found, though one at its end is cleaned", () => {
    for (const invisible of ["\u200B", "\uFEFF", "\u00A0", "\uFE0F", "\u2800", "\u3164"]) {
      expect(strayKeyCharacter(`sk-12${invisible}34`)).toBe(invisible);
      expect(checkApiKey(`sk-12${invisible}34${invisible}`).stray).toBe(invisible);
    }
  });

  test("a letter with an accent, a full-width letter and an emoji are found whole", () => {
    expect(strayKeyCharacter("sk-é")).toBe("é");
    expect(strayKeyCharacter("ｓk-1")).toBe("ｓ");
    expect(strayKeyCharacter("sk-😀1")).toBe("😀");
  });
});

describe("A stray character is named", () => {
  test("by itself when it can be seen", () => {
    for (const shown of ["作", "\u2019", "é", "😀", "ｓ", "€", "—"]) {
      expect(nameCharacter(shown)).toBe(shown);
    }
  });

  test.each([
    ["a zero-width space", "\u200B", "U+200B"],
    ["a no-break space", "\u00A0", "U+00A0"],
    ["a byte order mark", "\uFEFF", "U+FEFF"],
    ["a variation selector", "\uFE0F", "U+FE0F"],
    ["a Braille blank", "\u2800", "U+2800"],
    ["a Hangul filler", "\u3164", "U+3164"],
    ["a half-width Hangul filler", "\uFFA0", "U+FFA0"],
    ["a Hangul choseong filler", "\u115F", "U+115F"],
    ["a combining grapheme joiner", "\u034F", "U+034F"],
    ["a soft hyphen", "\u00AD", "U+00AD"],
    ["a Mongolian vowel separator", "\u180E", "U+180E"],
    ["a combining accent", "\u0301", "U+0301"],
    ["a private-use character", "\uE000", "U+E000"],
    ["an unassigned character", "\u0378", "U+0378"],
    ["a space", " ", "U+0020"],
    ["a tag character", "\u{E0041}", "U+E0041"],
  ])("by its code when it is %s", (_name, character, code) => {
    expect(nameCharacter(character)).toBe(code);
  });
});
