/**
 * An outside agent's changes in the editor (#352): accepting one marks its words third-party in
 * the same step of the editor's Undo, so ⌘Z takes back the accept and the mark together; ⌘K
 * offers no Regenerate for one out of date, as nothing can make it again; and a copy of its
 * words has its brackets as they read, without the word joiner the Note keeps in them.
 */
import { Editor, type Extension, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment, yUndoPluginKey } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { beforeAll, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, PROPOSAL_ATTRIBUTE, type ProposalRequest } from "../../src/core/api";
import { noteHandle } from "../../src/renderer/src/commands/handles";
import {
  type Command,
  type CommandContext,
  offered,
} from "../../src/renderer/src/commands/registry";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  ProposalReview,
  pendingIn,
  resolveInEditor,
} from "../../src/renderer/src/editor/proposalReview";
import { BRIDGE_KEY, FILES_BRIDGE_KEY } from "../../src/shared/bridge";
import { recordProposalRequest, targetHash } from "../../src/shared/proposals";
import { textOriginOf } from "../../src/shared/textOrigins";

/** A page for the editor, with what ProseMirror's copy makes its HTML in. */
function domDocument() {
  const page = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(page, "styleSheets", { value: [] });
  Object.defineProperty(page, "implementation", { value: { createHTMLDocument: domDocument } });
  return page;
}
const page = domDocument();
// The note's copy and commands reach the store, which reads the bridge the preload exposes.
const bridge = new Proxy({}, { get: () => () => () => undefined });
Object.assign(page.defaultView, { [BRIDGE_KEY]: bridge, [FILES_BRIDGE_KEY]: bridge });
Object.assign(globalThis, {
  window: page.defaultView,
  document: page,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

let windowExtensions: Extension[] = [];
let regenerate: Command | undefined;
beforeAll(async () => {
  const [{ CopyCitations }, { NoteKeymap }, { proposalCommands }] = await Promise.all([
    import("../../src/renderer/src/editor/copyCitations"),
    import("../../src/renderer/src/editor/noteKeymap"),
    import("../../src/renderer/src/commands/proposals"),
  ]);
  windowExtensions = [NoteKeymap, CopyCitations];
  regenerate = proposalCommands.find((each) => each.id === "proposal.regenerate");
});

const change = { id: "agent-change", request: "agent-request" };

const byAgent: ProposalRequest = {
  source: "outside-agent",
  agent: "Codex",
  pairingId: "pairing",
  createdAt: "2026-11-01T09:00:00.000Z",
};

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks && { marks }),
});

/** A Note holding these Blocks and the requests that made its changes, bound to an editor. */
function noteWith(
  content: JSONContent[],
  requests: Record<string, ProposalRequest>,
): { doc: Y.Doc; editor: Editor } {
  const doc = new Y.Doc();
  const schema = new Editor({ element: null, extensions: noteExtensions() });
  onTestFinished(() => schema.destroy());
  prosemirrorToYXmlFragment(
    schema.schema.nodeFromJSON({ type: "doc", content }),
    doc.getXmlFragment(MIND_CONTENT_FIELD),
  );
  for (const [request, made] of Object.entries(requests)) {
    recordProposalRequest(doc, request, made);
  }
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      ProposalReview,
      ...windowExtensions,
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => editor.destroy());
  return { doc, editor };
}

/** The User's paragraph and one an agent proposes whole. */
const noteWithAgentParagraph = () =>
  noteWith(
    [
      { type: "paragraph", attrs: { id: "mine" }, content: [text("Mine.")] },
      {
        type: "paragraph",
        attrs: { id: "theirs", [PROPOSAL_ATTRIBUTE]: { ...change, kind: "insert" } },
        content: [text("Book a boat on Friday.")],
      },
    ],
    { [change.request]: byAgent },
  );

/** The position just after the first `words` in the editor's text. */
function after(editor: Editor, words: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const at = node.text?.indexOf(words) ?? -1;
    if (at >= 0) found = pos + at + words.length;
    return false;
  });
  if (found < 0) throw new Error(`"${words}" isn't in the note.`);
  return found;
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

test("⌘K offers Regenerate for the assistant's change out of date, and none for an agent's", async () => {
  const marks = (id: string, request: string, removes: string) => {
    const ref = { id, request, target: targetHash(removes) };
    return {
      removed: [{ type: "proposalDelete", attrs: ref }],
      added: [{ type: "proposalInsert", attrs: ref }],
    };
  };
  const agent = marks(change.id, change.request, "twice");
  const assistant = marks("assistant-change", "assistant-request", "small");
  const { doc, editor } = noteWith(
    [
      {
        type: "paragraph",
        attrs: { id: "agent" },
        content: [
          text("Tides rise "),
          text("twice", agent.removed),
          text("two times", agent.added),
          text(" a day."),
        ],
      },
      {
        type: "paragraph",
        attrs: { id: "assistant" },
        content: [
          text("Neap tides are "),
          text("small", assistant.removed),
          text("weak", assistant.added),
          text("."),
        ],
      },
    ],
    {
      [change.request]: byAgent,
      "assistant-request": {
        source: "edit-with-ai",
        providerId: "anthropic",
        modelId: "claude-haiku-5-5",
        createdAt: "2026-11-01T09:00:00.000Z",
        action: "improve",
        instruction: "",
      },
    },
  );
  // Commands find the note by the Block the cursor is in once the editor is made.
  await new Promise<void>((resolve) => editor.on("create", () => resolve()));
  noteHandle.current = { editor, mindId: "mind", doc, place: "mind" };
  onTestFinished(() => {
    noteHandle.current = null;
  });
  // The User types among the words each change takes out: both are out of date.
  editor.view.dispatch(editor.state.tr.insertText("e", after(editor, "twic")));
  editor.view.dispatch(editor.state.tr.insertText("l", after(editor, "smal")));
  expect(pendingIn(editor.state).map((each) => [each.id, each.outOfDate])).toEqual([
    [change.id, true],
    ["assistant-change", true],
  ]);

  if (!regenerate) throw new Error("No Regenerate command.");
  const inChange = (blockId: string, words: string): CommandContext => {
    editor.commands.setTextSelection(after(editor, words));
    return { selection: [], focus: { kind: "block", id: blockId }, surface: "palette" };
  };
  expect(offered(regenerate, inChange("assistant", "sma"))).toBe(true);
  expect(offered(regenerate, inChange("agent", "twi"))).toBe(false);
});

test("a copy of an agent's words has its brackets as they read, in text and in HTML", () => {
  const { editor } = noteWith(
    [
      {
        type: "paragraph",
        attrs: { id: "theirs" },
        content: [text("See [\u20601] and [\u2060sic] here.")],
      },
    ],
    {},
  );
  const clipboard = new Map<string, string>();
  const copy = document.createEvent("Event");
  copy.initEvent("copy");
  Object.defineProperty(copy, "clipboardData", {
    value: {
      getData: (type: string) => clipboard.get(type) ?? "",
      setData: (type: string, value: string) => clipboard.set(type, value),
      clearData: () => clipboard.clear(),
    },
  });
  editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
  editor.view.dom.dispatchEvent(copy);

  expect(clipboard.get("text/plain")).toBe("See [1] and [sic] here.");
  expect(clipboard.get("text/html")).toContain("See [1] and [sic] here.");
  expect([...clipboard.values()].join("")).not.toContain("\u2060");
  // The Note keeps the word joiner: it is only the copy that goes without.
  expect(editor.state.doc.textContent).toBe("See [\u20601] and [\u2060sic] here.");
});
