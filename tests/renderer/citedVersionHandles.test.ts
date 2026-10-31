/**
 * The one cited version "Open the current version" acts on (#2159): with more
 * than one open, the one the User is in, else one a group shows, else the last
 * opened — never whichever mounted last behind the others.
 */
import { afterEach, describe, expect, test } from "vitest";
import type { WindowLayout } from "../../src/core/api";
import {
  type CitedVersionAction,
  citedVersionHandles,
  citedVersionInUse,
} from "../../src/renderer/src/commands/handles";

type Layout = Pick<WindowLayout, "groups" | "focusedGroupId">;

const layoutOf = (groups: [string, string | null][], focusedGroupId: string): Layout => ({
  groups: groups.map(([id, activeTabId], index) => ({
    id,
    tabs: [],
    activeTabId,
    width: index === 0 ? 0.5 : 0.5,
  })),
  focusedGroupId,
});

const action = (name: string): CitedVersionAction => ({
  openCurrent: () => {
    opened.push(name);
  },
});
const opened: string[] = [];

afterEach(() => {
  citedVersionHandles.clear();
  opened.length = 0;
});

describe("The cited version the current-version command acts on", () => {
  test("the one in the group the User is in, though another was opened later", () => {
    citedVersionHandles.set("tab-left", action("left"));
    citedVersionHandles.set("tab-right", action("right"));
    const layout = layoutOf(
      [
        ["left", "tab-left"],
        ["right", "tab-right"],
      ],
      "left",
    );
    citedVersionInUse(layout)?.openCurrent();
    expect(opened).toEqual(["left"]);
  });

  test("the one in the group the User is in, though an earlier group shows another", () => {
    citedVersionHandles.set("tab-left", action("left"));
    citedVersionHandles.set("tab-right", action("right"));
    const layout = layoutOf(
      [
        ["left", "tab-left"],
        ["right", "tab-right"],
      ],
      "right",
    );
    citedVersionInUse(layout)?.openCurrent();
    expect(opened).toEqual(["right"]);
  });

  test("one a group shows when the focused group shows something else", () => {
    citedVersionHandles.set("tab-right", action("right"));
    const layout = layoutOf(
      [
        ["left", "mind-tab"],
        ["right", "tab-right"],
      ],
      "left",
    );
    citedVersionInUse(layout)?.openCurrent();
    expect(opened).toEqual(["right"]);
  });

  test("the one opened last where no Document tab is active, as in a window of one group", () => {
    citedVersionHandles.set("tab-one", action("one"));
    citedVersionHandles.set("tab-two", action("two"));
    citedVersionInUse(layoutOf([["only", "mind-tab"]], "only"))?.openCurrent();
    expect(opened).toEqual(["two"]);
  });

  test("nothing, when no cited version is open", () => {
    expect(citedVersionInUse(layoutOf([["only", "mind-tab"]], "only"))).toBeNull();
    expect(citedVersionInUse(null)).toBeNull();
  });
});
