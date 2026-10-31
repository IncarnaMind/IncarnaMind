import { describe, expect, test } from "vitest";
import { holdBack, shownUpTo } from "../../src/core/answers/claimStream";

describe("A reply as it streams", () => {
  const shown = (text: string) => text.slice(0, shownUpTo(text, ["Q3 review"]));

  test("shows all but what may claim a change", () => {
    expect(shown("A Mind is ")).toBe("A Mind is ");
    expect(shown("A Mind is a note")).toBe("A Mind is a ");
    expect(shown("The tides are late. I've added a risks section to “Q3 review”. More")).toBe(
      "The tides are late. ",
    );
    expect(shown("The tides are late. I've ad")).toBe("The tides are late. ");
    expect(shown("The tides are late. Short")).toBe("The tides are late. ");
    expect(shown("The summary is now twice")).toBe("");
    expect(shown("The tides are late. The new note was created. More")).toBe(
      "The tides are late. ",
    );
    expect(shown("The note says the tides are late. ")).toBe("The note says the tides are late. ");
    expect(shown("总结说潮汐很晚。总结已扩")).toBe("总结说潮汐很晚。");
    expect(shown("潮汐很晚")).toBe("潮汐很晚");
  });

  test("as it grows, as if read whole, and afresh once taken back", () => {
    const hold = holdBack(() => ["Q3 review"]);
    const reply = "The tides are late. I've added a risks section to “Q3 review”. More";
    for (let end = 1; end <= reply.length; end++) {
      expect(hold(reply.slice(0, end))).toBe(shownUpTo(reply.slice(0, end), ["Q3 review"]));
    }
    expect(hold("")).toBe(0);
    expect(hold("No section was added. ")).toBe("No section was added. ".length);
  });
});
