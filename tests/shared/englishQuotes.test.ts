import { describe, expect, it } from "vitest";
import { en } from "../../src/shared/i18n/en";

const KEYWORDS = /\.keywords$/;
const shown = Object.entries(en).filter(([key]) => !KEYWORDS.test(key));

/** British forms and the American spelling each one gets. */
const UK_SPELLINGS: Readonly<Record<string, string>> = {
  behaviour: "behavior",
  cancelled: "canceled",
  centre: "center",
  colour: "color",
  favourite: "favorite",
  grey: "gray",
  licence: "license",
  organise: "organize",
  recognise: "recognize",
  summarise: "summarize",
};

describe("the English strings", () => {
  it("quote with curly marks (“like this”), never straight double quotes", () => {
    const straight = Object.entries(en)
      .filter(([, text]) => text.includes('"'))
      .map(([key]) => key);
    expect(straight).toEqual([]);
  });

  it("write apostrophes as ’, never as a straight '", () => {
    const straight = shown.filter(([, text]) => text.includes("'")).map(([key]) => key);
    expect(straight).toEqual([]);
  });

  it("use American spelling", () => {
    const found = shown.flatMap(([key, text]) =>
      Object.keys(UK_SPELLINGS)
        .filter((word) =>
          new RegExp(`\\b${word}(?:s|d)?\\b`, "i").test(text.replace(/\{\w+\}/g, "")),
        )
        .map((word) => `${key}: ${word} (use ${UK_SPELLINGS[word]})`),
    );
    expect(found).toEqual([]);
  });
});
