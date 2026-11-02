/**
 * Restore original leaves the User's own words where they are (#1358): one
 * transaction for each change, so y-prosemirror syncs only the words each one
 * replaces. One transaction for the paragraph would delete and re-insert every
 * item between its first change and its last, and the words typed between them
 * would lose their Yjs place though they read the same.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { Fragment } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  prosemirrorToYXmlFragment,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { afterEach, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core";
import {
  AppliedEditLine,
  appliedChanges,
  type ChangePlace,
  changeGroupsOf,
  setAppliedLine,
} from "../../src/renderer/src/editor/appliedEditLine";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { BRIDGE_KEY } from "../../src/shared/bridge";

const dom = new DOMParser().parseFromString(
  "<!doctype html><html><head></head><body></body></html>",
  "text/html",
);
// The store reads the bridge the preload exposes; nothing here reaches the core.
const bridge = new Proxy({}, { get: () => () => () => undefined });
Object.assign(dom.defaultView ?? {}, { [BRIDGE_KEY]: bridge });
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

// "ALPHA OMEGA" written at 7 and " MINE" typed at 12: "ALPHA" runs from 7 to 12, "MINE" from 13 to 17 and "OMEGA" from 18 to 23.
const PARAGRAPH: JSONContent[] = [
  {
    type: "paragraph",
    attrs: { id: "para" },
    content: [{ type: "text", text: "Intro " }],
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
      AppliedEditLine,
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editors.push(editor);
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

function relativeAt(state: EditorState, pos: number): unknown {
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (!binding) throw new Error("The editor is not bound to a Mind.");
  return absolutePositionToRelativePosition(pos, binding.type, binding.mapping);
}

/** Two changes in one paragraph, "ALPHA" and "OMEGA", with a word the User typed between them. */
function twoChanges(editor: Editor): ChangePlace[] {
  const place = (from: number, to: number, removed: string): ChangePlace => ({
    from: relativeAt(editor.state, from),
    to: relativeAt(editor.state, to),
    removed: Fragment.from(editor.schema.text(removed)),
    block: null,
    writtenSize: to - from,
  });
  return [place(7, 12, "old-alpha"), place(18, 23, "old-omega")];
}

test("restoring a paragraph leaves the User's word where it was in Yjs", async () => {
  // The renderer's core reads `window` as it loads, so this waits for the test's page.
  const { restoreChange } = await import("../../src/renderer/src/appliedEdits");
  const editor = await mindWith(PARAGRAPH);
  editor.view.dispatch(editor.state.tr.insertText("ALPHA OMEGA", 7));
  editor.view.dispatch(editor.state.tr.insertText(" MINE", 12));
  const changes = appliedChanges(editor.state, twoChanges(editor));
  expect(changes.map(({ written }) => written.textBetween(0, written.size, "", ""))).toEqual([
    "ALPHA",
    "OMEGA",
  ]);
  setAppliedLine(editor, { kind: "review", blockId: null, changes });
  expect(changeGroupsOf(editor.state, changes)).toHaveLength(1);

  const binding = ySyncPluginKey.getState(editor.state)?.binding;
  if (!binding) throw new Error("The editor is not bound to a Mind.");
  const mine = absolutePositionToRelativePosition(13, binding.type, binding.mapping);
  const resolved = () =>
    relativePositionToAbsolutePosition(binding.doc, binding.type, mine, binding.mapping);
  const before = resolved();
  expect(before).not.toBeNull();
  expect(editor.state.doc.textBetween(before ?? 0, (before ?? 0) + 4)).toBe("MINE");

  restoreChange(editor, 0);

  expect(editor.state.doc.textBetween(0, editor.state.doc.content.size)).toBe(
    "Intro old-alpha MINE old-omega",
  );
  const after = resolved();
  expect(after).not.toBeNull();
  expect(editor.state.doc.textBetween(after ?? 0, (after ?? 0) + 4)).toBe("MINE");
});
