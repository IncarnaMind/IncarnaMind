import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dotAfter } from "../../src/renderer/src/components/metaDot";

describe("The dot between a meta line's parts", () => {
  // protects=after Chinese full-width punctuation, a closing bracket included (#1149), the dot sets with no space before it, and after anything else with one each side; fails_when=a line reads "）· " with a space, or English loses its spaces; no_claim=the line's look.
  test.each([
    ["来自 2 个文档（此笔记的范围，共 7 个）", "· "],
    ["我选了“Report 1”作为主要文档。", "· "],
    ["失败了！", "· "],
    ["From 2 of your 7 Documents (this note’s scope)", " · "],
    ["请先不要关闭 IncarnaMind", " · "],
  ])("after “%s”: “%s”", (part, dot) => {
    expect(dotAfter(part)).toBe(dot);
  });
});

/** An action as the line takes it. */
interface LineActionProps {
  label: string;
  testId: string;
  onClick(): void;
}

describe("A problem line's actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function shown(also: boolean) {
    const document = new DOMParser().parseFromString(
      "<html><head></head><body></body></html>",
      "text/html",
    );
    for (const [name, value] of Object.entries({
      document,
      window: document.defaultView,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      vi.stubGlobal(name, value);
    }
    // A .tsx module, read as the other renderer tests read theirs.
    const path = "../../src/renderer/src/components/ProblemLine.tsx";
    const { ProblemLine } = (await import(path)) as {
      ProblemLine: ComponentType<{
        children?: ReactNode;
        action?: LineActionProps;
        also?: LineActionProps;
        details?: readonly string[];
      }>;
    };
    const container = document.createElement("div", {});
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(
          ProblemLine,
          {
            action: { label: "Check the key", testId: "fix", onClick: () => undefined },
            ...(also && {
              also: { label: "Try again", testId: "again", onClick: () => undefined },
            }),
            details: ["1 Transcript part couldn’t be finished"],
          },
          "The note wasn’t filled in. The key for test-model was refused",
        ),
      ),
    );
    const line = container.querySelector(".meta-line");
    if (!line) throw new Error("No line.");
    const partOf = (testId: string) =>
      [...line.children].find((part) => part.querySelector(`[data-testid="${testId}"]`));
    return { line, partOf, unmount: () => act(async () => root.unmount()) };
  }

  // protects=a line's two actions are one part of it, so a row breaks before them and never between them, while the pair fits a row; inside, the pair is a line of its own that may wrap only at its dot when it alone is wider (#3099); fails_when=the two actions are parts of the line apart, or one action alone is wrapped; no_claim=pixels, which the window sweeps measure.
  test("two actions share one part of the line; one action is a part as before", async () => {
    const two = await shown(true);
    const pair = two.partOf("fix");
    expect(pair).toBeDefined();
    expect(two.partOf("again")).toBe(pair);
    expect(pair?.querySelector(":scope > .meta-line")?.children).toHaveLength(2);
    expect([...two.line.children]).toHaveLength(3);
    await two.unmount();
    const one = await shown(false);
    expect(one.partOf("fix")?.querySelector(".meta-line")).toBeNull();
    expect([...one.line.children]).toHaveLength(3);
    await one.unmount();
  });
});
