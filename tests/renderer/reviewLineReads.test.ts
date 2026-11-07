/**
 * The review line says what is left of an edit once a part of it is restored (#2356): a paragraph
 * removed and one added beside it read as one changed, and either restored leaves the other said
 * as added or removed, though the count stays one.
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
import { afterEach, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core";
import {
  type AppliedChange,
  AppliedEditLine,
  appliedChanges,
  type ChangePlace,
  setAppliedLine,
} from "../../src/renderer/src/editor/appliedEditLine";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { BRIDGE_KEY } from "../../src/shared/bridge";
import { translate } from "../../src/shared/i18n";

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

const CONTENT: JSONContent[] = [
  { type: "paragraph", attrs: { id: "intro" }, content: [{ type: "text", text: "Intro." }] },
  { type: "paragraph", attrs: { id: "added" }, content: [{ type: "text", text: "Added line." }] },
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
      AppliedEditLine.configure({ translate: (key, params) => translate("en", key, params) }),
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

/** "Old line." taken out after "Intro.", and "Added line." added in its place. */
function removedAndAdded(editor: Editor): AppliedChange[] {
  const old = editor.schema.nodes.paragraph?.create({ id: "old" }, editor.schema.text("Old line."));
  if (!old) throw new Error("No paragraph in the schema.");
  const end = editor.state.doc.content.size;
  const places: ChangePlace[] = [
    {
      from: relativeAt(editor.state, 8),
      to: relativeAt(editor.state, 8),
      removed: Fragment.from(old),
      block: "removed",
    },
    {
      from: relativeAt(editor.state, 8),
      to: relativeAt(editor.state, end - 1),
      removed: Fragment.empty,
      block: "added",
    },
  ];
  return appliedChanges(editor.state, places);
}

/** The line over the Note's first paragraph, where its count is said. */
const label = (editor: Editor) =>
  editor.view.dom.querySelector('[data-testid="applied-line"] [data-testid="applied-count"]')
    ?.textContent ?? null;

// protects=the review line is drawn again when what is left of the edit reads otherwise, though its count stays one: with only the addition left it says the paragraph was added, with only the removal left that it was removed, as when the other half is restored; fails_when=the line keeps "1 paragraph changed by Edit with AI"; no_claim=how a restore marks the changes it put back.
test.each([
  { left: "added", says: "Added 1 paragraph" },
  { left: "removed", says: "Removed the paragraph “Old line.” (1 sentence)" },
] as const)("with only the $left paragraph left, the line says so", async ({ left, says }) => {
  const editor = await mindWith(CONTENT);
  const changes = removedAndAdded(editor);
  setAppliedLine(editor, { kind: "review", blockId: "intro", changes });
  expect(label(editor)).toBe("1 paragraph changed by Edit with AI");

  setAppliedLine(editor, {
    kind: "review",
    blockId: "intro",
    changes,
    shows: (change) => change.block === left,
  });

  expect(label(editor)).toBe(says);
});
