import { describe, expect, test } from "vitest";
import { handleInUse } from "../../src/renderer/src/commands/handles";

const layout = (focusedGroupId: string, groups: { id: string; activeTabId: string | null }[]) =>
  ({ focusedGroupId, groups }) as never;

describe("the viewer actions a command acts on", () => {
  const actions = new Map([
    ["first", "the first viewer"],
    ["second", "the second viewer"],
  ]);

  test("takes the focused group's viewer, though another mounted later", () => {
    expect(
      handleInUse(
        actions,
        layout("one", [
          { id: "two", activeTabId: "second" },
          { id: "one", activeTabId: "first" },
        ]),
      ),
    ).toBe("the first viewer");
  });

  test("takes a group's shown viewer when the focused group shows none", () => {
    expect(
      handleInUse(
        actions,
        layout("note", [
          { id: "note", activeTabId: null },
          { id: "documents", activeTabId: "second" },
        ]),
      ),
    ).toBe("the second viewer");
  });

  test("takes the last without a layout, as a window still opening does", () => {
    expect(handleInUse(actions, null)).toBe("the second viewer");
  });
});
