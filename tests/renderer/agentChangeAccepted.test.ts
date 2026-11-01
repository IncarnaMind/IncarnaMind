/**
 * Accepting an outside agent's change in the editor marks its words third-party (#352), in the
 * same step of the editor's Undo: ⌘Z takes back the accept and the mark together.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment, yUndoPluginKey } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, PROPOSAL_ATTRIBUTE } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  ProposalReview,
  pendingIn,
  resolveInEditor,
} from "../../src/renderer/src/editor/proposalReview";
import { recordProposalRequest } from "../../src/shared/proposals";
import { textOriginOf } from "../../src/shared/textOrigins";

beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  Object.assign(globalThis, {
    window: document.defaultView,
    document,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
  });
});

const change = { id: "agent-change", request: "agent-request" };

/** A Note holding the User's paragraph and one an agent proposes whole, bound to an editor. */
function noteWithAgentParagraph(): { doc: Y.Doc; editor: Editor } {
  const doc = new Y.Doc();
  const content: JSONContent[] = [
    { type: "paragraph", attrs: { id: "mine" }, content: [{ type: "text", text: "Mine." }] },
    {
      type: "paragraph",
      attrs: { id: "theirs", [PROPOSAL_ATTRIBUTE]: { ...change, kind: "insert" } },
      content: [{ type: "text", text: "Book a boat on Friday." }],
    },
  ];
  const schema = new Editor({ element: null, extensions: noteExtensions() });
  onTestFinished(() => schema.destroy());
  prosemirrorToYXmlFragment(
    schema.schema.nodeFromJSON({ type: "doc", content }),
    doc.getXmlFragment(MIND_CONTENT_FIELD),
  );
  recordProposalRequest(doc, change.request, {
    source: "outside-agent",
    agent: "Codex",
    pairingId: "pairing",
    createdAt: "2026-11-01T09:00:00.000Z",
  });
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      ProposalReview,
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => editor.destroy());
  return { doc, editor };
}

test("accepting an agent's change marks its words third-party, and ⌘Z takes the mark back with it", () => {
  const { doc, editor } = noteWithAgentParagraph();
  expect(pendingIn(editor.state).map((each) => each.id)).toEqual([change.id]);
  expect(textOriginOf(doc, "theirs")).toBeNull();

  resolveInEditor(editor, new Set([change.id]), "accept");
  expect(pendingIn(editor.state)).toEqual([]);
  expect(textOriginOf(doc, "theirs")).toBe("outside-agent");
  expect(textOriginOf(doc, "mine")).toBeNull();

  yUndoPluginKey.getState(editor.state)?.undoManager.undo();
  expect(pendingIn(editor.state).map((each) => each.id)).toEqual([change.id]);
  expect(textOriginOf(doc, "theirs")).toBeNull();
});

test("rejecting it marks nothing", () => {
  const { doc, editor } = noteWithAgentParagraph();
  resolveInEditor(editor, new Set([change.id]), "reject");
  expect(pendingIn(editor.state)).toEqual([]);
  expect(textOriginOf(doc, "theirs")).toBeNull();
  expect(textOriginOf(doc, "mine")).toBeNull();
});
