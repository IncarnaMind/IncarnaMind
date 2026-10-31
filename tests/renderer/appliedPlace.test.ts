/**
 * Where a change an applied edit made is found (#1411): by its own positions
 * while they hold, and, for a change at the Note's first Block, whose start
 * y-tiptap gives no position for, by its end and what it wrote — only while
 * that counted start stays in the same paragraph as its end.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { Fragment } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  prosemirrorToYXmlFragment,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { appliedChanges, type ChangePlace } from "../../src/renderer/src/editor/appliedEditLine";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const dom = new DOMParser().parseFromString(
  "<!doctype html><html><head></head><body></body></html>",
  "text/html",
);
Object.assign(globalThis, {
  window: dom.defaultView,
  document: dom,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const editors: Editor[] = [];
afterEach(() => {
  for (const each of editors.splice(0)) each.destroy();
});

/** Two paragraphs, "alpha beta" and "gamma delta": the second paragraph's text runs from 13 to 24. */
const TWO_PARAGRAPHS: JSONContent[] = [
  {
    type: "paragraph",
    attrs: { id: "first" },
    content: [{ type: "text", text: "alpha beta" }],
  },
  {
    type: "paragraph",
    attrs: { id: "second" },
    content: [{ type: "text", text: "gamma delta" }],
  },
];

async function mindWith(content: JSONContent[]): Promise<Editor> {
  const source = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(source.state.doc, doc.getXmlFragment(MIND_CONTENT_FIELD));
  source.destroy();
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editors.push(editor);
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

/** A position in a Mind that has nothing to do with this one: what a start y-tiptap cannot place comes back as. */
function placeNowhere(): unknown {
  const doc = new Y.Doc();
  const run = new Y.XmlText();
  doc.getXmlFragment("elsewhere").insert(0, [run]);
  run.insert(0, "zzzz");
  const relative = Y.createRelativePositionFromTypeIndex(run, 0, -1);
  doc.destroy();
  return relative;
}

function relativeAt(state: EditorState, pos: number): unknown {
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (!binding) throw new Error("The editor is not bound to a Mind.");
  return absolutePositionToRelativePosition(pos, binding.type, binding.mapping);
}

const countStart = (state: EditorState, writtenSize: number): ChangePlace => ({
  from: placeNowhere(),
  to: relativeAt(state, 14),
  removed: Fragment.empty,
  block: null,
  writtenSize,
});

describe("A change whose start y-tiptap gives no position for", () => {
  test("is found by its end and what it wrote while that start stays in its paragraph", async () => {
    const editor = await mindWith(TWO_PARAGRAPHS);
    const [change] = appliedChanges(editor.state, [countStart(editor.state, 1)]);
    expect(change?.blockId).toBe("second");
    expect(change?.written.eq(Fragment.from(editor.schema.text("g")))).toBe(true);
  });

  test("is nowhere once that start would land in the paragraph before", async () => {
    const editor = await mindWith(TWO_PARAGRAPHS);
    const [change] = appliedChanges(editor.state, [countStart(editor.state, 3)]);
    expect(change?.blockId).toBeNull();
    expect(change?.written.size).toBe(0);
  });
});
