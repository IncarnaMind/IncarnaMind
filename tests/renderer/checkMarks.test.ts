import { describe, expect, test } from "vitest";
import { contrast, type Theme, token } from "../helpers/contrast";

/*
 * The margin marks of a Citation's check (DESIGN.md, Citation check): the
 * amber "!" of a quote not found or a claim unsupported, and the outlined red
 * "≠" of a contradicted one. Each is a small glyph, so each passes 4.5:1 on
 * what it sits on, and its outline passes 3:1 against the sheet. Both themes (#1262).
 */
describe.each(["light", "dark"] satisfies Theme[])(
  "Citation check marks in the %s theme",
  (theme) => {
    const tone = (name: string) => token(name, theme);

    test('the amber "!" reads on its wash, and in the text marker on the sheet', () => {
      expect(contrast(tone("warning"), tone("warning-wash"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tone("warning"), tone("sheet"))).toBeGreaterThanOrEqual(4.5);
    });

    test('the red "≠" reads on the sheet, and its outline stands out', () => {
      expect(contrast(tone("danger"), tone("sheet"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tone("danger"), tone("danger-wash"))).toBeGreaterThanOrEqual(4.5);
    });

    test("the quiet tick and its number read on the sheet", () => {
      expect(contrast(tone("success"), tone("sheet"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tone("ink-meta"), tone("sheet"))).toBeGreaterThanOrEqual(4.5);
    });
  },
);
