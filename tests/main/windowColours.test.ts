import { describe, expect, test } from "vitest";
import { WINDOW_COLOURS } from "../../src/main/windowColours";
import { type Theme, token } from "../helpers/contrast";

/*
 * What a window shows before its page paints (#1262) is the page's own colour in each theme, so
 * the first frame and the page agree: a launch in Dark shows no light frame first.
 */
const TOKENS = [
  ["frame", "frame"],
  ["sheet", "sheet"],
  ["tabStrip", "tab-strip"],
  ["inkSecondary", "ink-secondary"],
] as const;

describe("the window's colours", () => {
  test.each(["light", "dark"] satisfies Theme[])(
    "are styles.css's tokens in the %s theme",
    (theme) => {
      for (const [name, tokenName] of TOKENS) {
        expect(WINDOW_COLOURS[name][theme].toLowerCase(), name).toBe(
          token(tokenName, theme).toLowerCase(),
        );
      }
    },
  );
});
