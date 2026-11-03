import { describe, expect, test } from "vitest";
import { assertCaptionsAtScenes, type CaptionTime } from "../../e2e/demo/captionGuard";

const scenes = [
  { name: "hook", film: true },
  { name: "ask", film: false },
  { name: "organize", film: true },
  { name: "end card", film: true },
];
const marks = { hook: 0, organize: 3, "end card": 10 };
const expected = [
  { scene: "hook", at: 0, text: "The memo says 36.8%." },
  { scene: "organize", at: 3, text: "Monday. Files everywhere." },
];

describe("a caption's time range against its scene's marks", () => {
  test("passes when every caption stays inside its own scene", () => {
    const captions: CaptionTime[] = [
      { at: 0, text: "The memo says 36.8%." },
      { at: 3, text: "Monday. Files everywhere." },
      { at: 4.5, text: "A second line in the same scene." },
      { at: 10, text: null },
    ];
    expect(() => assertCaptionsAtScenes(captions, marks, scenes, expected, 12)).not.toThrow();
  });

  test("fails when a caption runs past its scene's end", () => {
    const captions: CaptionTime[] = [
      { at: 0, text: "The memo says 36.8%." },
      { at: 10, text: null },
    ];
    expect(() => assertCaptionsAtScenes(captions, marks, scenes, expected, 12)).toThrow(
      "past hook's end",
    );
  });

  test("fails when a scene's caption is not at its mark, or is missing", () => {
    const late: CaptionTime[] = [
      { at: 0, text: "The memo says 36.8%." },
      { at: 3.4, text: "Monday. Files everywhere." },
      { at: 10, text: null },
    ];
    expect(() => assertCaptionsAtScenes(late, marks, scenes, expected, 12)).toThrow(
      "past hook's end",
    );
    const wrong: CaptionTime[] = [
      { at: 0, text: "The memo says 36.8%." },
      { at: 3, text: "Another line entirely." },
      { at: 10, text: null },
    ];
    expect(() => assertCaptionsAtScenes(wrong, marks, scenes, expected, 12)).toThrow(
      "has no caption",
    );
  });

  test("fails when a caption starts before the first filmed scene", () => {
    const captions: CaptionTime[] = [{ at: -0.5, text: "A caption." }];
    expect(() => assertCaptionsAtScenes(captions, marks, scenes, [], 12)).toThrow(
      "before the first filmed scene",
    );
  });
});
