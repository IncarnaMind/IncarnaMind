import { describe, expect, test } from "vitest";
import { holdWordLook, useWordLooks } from "../../src/renderer/src/wordLooks";

const pane = (name: string, chosen: string[]) => ({
  shown: "word" as const,
  openOriginal: null,
  fonts: [],
  choose: () => {
    chosen.push(name);
  },
});

describe("the Look menu's Minds", () => {
  test("a Mind open in two panes stays in the menu until both close, and reaches whichever is left", () => {
    for (const closing of ["latest", "earliest"] as const) {
      const chosen: string[] = [];
      const left = holdWordLook("mind-1", pane("left", chosen));
      const right = holdWordLook("mind-1", pane("right", chosen));
      if (closing === "latest") right();
      else left();
      useWordLooks.getState()["mind-1"]?.choose("plain");
      expect(chosen).toEqual([closing === "latest" ? "left" : "right"]);
      if (closing === "latest") left();
      else right();
      expect(useWordLooks.getState()["mind-1"]).toBeUndefined();
    }
  });
});
