/**
 * A menu action asked while a change runs in the same Note (#2123): it sends nothing, and says
 * one change at a time where its line lands, as the menu's own field already does.
 */
import { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";

const { editWithAi } = vi.hoisted(() => ({ editWithAi: vi.fn() }));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => {},
    editWithAi,
    cancelEdit: vi.fn(),
    saveCheckpoint: vi.fn(),
    recordAiUse: vi.fn(),
  },
}));

const { requestEdit, useEdits } = await import("../../src/renderer/src/editWithAi");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");

const TEXT = "Spring tides happen at new moon.";
const MIND = "mind-1";

function installDom() {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  Object.defineProperty(document, "implementation", {
    value: { createHTMLDocument: () => document },
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", document.defaultView);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("getComputedStyle", () => ({ fontStyle: "", fontWeight: "" }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return document;
}

/** A Note with one paragraph, selected from its first word to its last. */
function editing(): Editor {
  const document = installDom();
  const editor = new Editor({
    element: document.createElement("div", {}),
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: TEXT }] },
      ],
    },
  });
  onTestFinished(() => editor.destroy());
  editor.commands.setTextSelection({ from: 1, to: TEXT.length + 1 });
  return editor;
}

beforeEach(() => {
  editWithAi.mockReset();
  useEdits.setState({ pending: {}, problems: {} });
});

describe("a menu action asked while another change runs (#2123)", () => {
  // protects=the second action sends no request and says one change at a time at the running line's spot, in the page; fails_when=it asks the model again, or says nothing; no_claim=what the running change does afterwards.
  test("sends nothing and says one change at a time where its line lands", async () => {
    const editor = editing();
    useEdits.setState({
      pending: {
        [MIND]: {
          requestId: "running",
          action: "improve",
          language: null,
          model: null,
          menu: { blockId: "p1", at: 1 },
        },
      },
    });

    const asked = await requestEdit(
      editor,
      MIND,
      new Y.Doc(),
      "shorten",
      undefined,
      undefined,
      "menu",
    );

    expect(asked).toBe(false);
    expect(editWithAi).not.toHaveBeenCalled();
    expect(useEdits.getState().problems[MIND]).toMatchObject({
      kind: "busy",
      menu: { blockId: "p1" },
    });
    // The menu closes over the words where it stood, as it does when an action is taken.
    expect(editor.state.selection.empty).toBe(true);
  });
});
