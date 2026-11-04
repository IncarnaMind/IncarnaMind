/**
 * An Edit with AI refused after the User pressed Stop still says why (#2424): the core takes
 * back every part it merged, so a silent composer would leave a paragraph the User watched
 * being rewritten gone with nothing said. A plain Stop stays silent, as before.
 */
import { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";

const { editWithAi, cancelEdit } = vi.hoisted(() => ({
  editWithAi: vi.fn(),
  cancelEdit: vi.fn(),
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => {},
    editWithAi,
    cancelEdit,
    saveCheckpoint: vi.fn(),
    recordAiUse: vi.fn(),
  },
}));

const { requestEdit, stopEdit, useEdits } = await import("../../src/renderer/src/editWithAi");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");

const TEXT = "Spring tides happen at new moon.";
const RANGE = { from: 1, to: TEXT.length + 1 };

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
  return editor;
}

/** Asks Edit with AI, then presses Stop, then gives the core's answer. */
async function stopped(result: unknown): Promise<string | undefined> {
  useEdits.setState({ pending: {}, problems: {} });
  let answer: (result: unknown) => void = () => undefined;
  editWithAi.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  cancelEdit.mockResolvedValue(undefined);
  const mindId = "mind-1";
  const asked = requestEdit(editing(), mindId, new Y.Doc(), "improve", undefined, RANGE);
  await vi.waitFor(() => expect(useEdits.getState().pending[mindId]).toBeDefined());
  stopEdit(mindId);
  answer(result);
  await asked;
  return useEdits.getState().problems[mindId]?.kind;
}

describe("An Edit with AI the User stopped", () => {
  test("says why when the part in hand was refused: the change it took back isn't silent", async () => {
    expect(await stopped({ kind: "not-placed" })).toBe("not-placed");
  });

  test("says nothing when the Stop simply stopped it", async () => {
    expect(await stopped({ kind: "cancelled" })).toBeUndefined();
  });
});
