import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import {
  headingAt,
  outlineEntries,
  sameHeadings,
  shownHeadings,
} from "../../src/renderer/src/editor/outline";
import { headlessEditor } from "../helpers/editor";

/*
 * A Note's outline (#3414): what its panel lists, which entry it marks as the Note scrolls, and
 * that it is remembered per Note on this computer.
 */

const heading = (level: number, text: string): JSONContent => ({
  type: "heading",
  attrs: { level },
  ...(text && { content: [{ type: "text", text }] }),
});
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

function noteOf(blocks: JSONContent[]) {
  const editor = headlessEditor();
  editor.commands.setContent({ type: "doc", content: blocks });
  return editor;
}

describe("a Note's outline", () => {
  test("lists its headings in order, indented by the levels the Note uses, the highest flush", () => {
    const editor = noteOf([
      heading(1, "Harbourline Ferries: operations report"),
      paragraph("Sailings ran on time on most days."),
      heading(2, "Routes and sailings"),
      heading(4, "Night crossings"),
      heading(2, ""),
      heading(2, "Fleet"),
    ]);
    expect(outlineEntries(shownHeadings(editor.state))).toEqual([
      { key: 0, title: "Harbourline Ferries: operations report", depth: 0 },
      { key: 1, title: "Routes and sailings", depth: 1 },
      // A level the Note skips takes no indent of its own; an empty heading has nowhere to go.
      { key: 2, title: "Night crossings", depth: 2 },
      { key: 3, title: "Fleet", depth: 1 },
    ]);

    const noTitle = noteOf([heading(2, "摘要"), heading(3, "海岛航线"), heading(2, "展望")]);
    expect(outlineEntries(shownHeadings(noTitle.state)).map((entry) => entry.depth)).toEqual([
      0, 1, 0,
    ]);
  });

  test("changes when a heading is added, renamed or removed, not when the text around it moves", () => {
    const editor = noteOf([
      paragraph("Sailings"),
      heading(2, "Fleet"),
      paragraph("Two ferries were refitted."),
      heading(2, "Safety"),
    ]);
    const before = shownHeadings(editor.state);

    editor.view.dispatch(editor.state.tr.insertText("Most ", 1));
    const typed = shownHeadings(editor.state);
    expect(typed[0]?.pos).not.toBe(before[0]?.pos);
    expect(sameHeadings(before, typed)).toBe(true);

    const fleet = typed[0]?.pos ?? 0;
    editor.view.dispatch(editor.state.tr.insertText("The ", fleet + 1));
    expect(sameHeadings(typed, shownHeadings(editor.state))).toBe(false);
    expect(shownHeadings(editor.state).map((each) => each.text)).toEqual(["The Fleet", "Safety"]);

    editor.commands.insertContentAt(editor.state.doc.content.size, heading(3, "Outlook"));
    expect(shownHeadings(editor.state).map((each) => each.text)).toEqual([
      "The Fleet",
      "Safety",
      "Outlook",
    ]);
  });

  test("marks the last heading at or above the reading line, and none above the first", () => {
    const line = 96;
    expect(headingAt([140, 900, 1700], line)).toBeNull();
    expect(headingAt([60, 900, 1700], line)).toBe(0);
    expect(headingAt([-800, 96, 900], line)).toBe(1);
    expect(headingAt([-1600, -800, -20], line)).toBe(2);
    expect(headingAt([], line)).toBeNull();
  });

  test("open or closed is remembered per Note on this computer, closed by default", async () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => kept.set(key, value),
    });
    try {
      vi.resetModules();
      const first = await import("../../src/renderer/src/noteOutline");
      expect(first.useNoteOutlines.getState().open.has("ferries")).toBe(false);
      first.useNoteOutlines.getState().setOpen("ferries", true);
      first.useNoteOutlines.getState().setOpen("tides", true);
      first.useNoteOutlines.getState().setOpen("tides", false);

      vi.resetModules();
      const again = await import("../../src/renderer/src/noteOutline");
      expect([...again.useNoteOutlines.getState().open]).toEqual(["ferries"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
