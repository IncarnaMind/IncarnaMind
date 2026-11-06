import { describe, expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";

/**
 * The first open's words (#2270): a step names the control as the card draws it, so a click it
 * tells the User to make is there.
 */

describe("the third step of the first open", () => {
  test.each(["en", "zh-CN"] as const)(
    "quotes the Citation card's own open button, in %s",
    (language) => {
      const body = translate(language, "firstOpen.step.citation.body");
      const button = translate(language, "citation.open.page");
      expect(body).toContain(`“${button}”`);
    },
  );
});
