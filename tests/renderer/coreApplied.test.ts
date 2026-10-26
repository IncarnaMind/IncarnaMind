import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import {
  type AskedChangeApplication,
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
} from "../../src/core/api";
import { AppliedEditLine, appliedLineIn } from "../../src/renderer/src/editor/appliedEditLine";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { ProposalReview } from "../../src/renderer/src/editor/proposalReview";
import { recordProposalRequest, resolveProposals } from "../../src/shared/proposals";

function applicationWithChange(later: boolean): {
  doc: Y.Doc;
  application: AskedChangeApplication;
} {
  const before = new Y.Doc();
  const source = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "original" },
          content: [{ type: "text", text: "Original" }],
        },
        {
          type: "paragraph",
          attrs: {
            id: "added",
            [PROPOSAL_ATTRIBUTE]: { id: "change", request: "request", kind: "insert" },
          },
          content: [{ type: "text", text: "AI text" }],
        },
      ] satisfies JSONContent[],
    },
  });
  prosemirrorToYXmlFragment(source.state.doc, before.getXmlFragment(MIND_CONTENT_FIELD));
  source.destroy();
  recordProposalRequest(before, "request", {
    source: "edit-with-ai",
    requested: "edit",
    providerId: "local",
    modelId: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const reviewBefore = Y.encodeStateAsUpdate(before);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, reviewBefore);
  resolveProposals(doc.getXmlFragment(MIND_CONTENT_FIELD), () => true, "accept");
  const afterVector = Y.encodeStateVector(doc);
  if (later) {
    const block = doc.getXmlFragment(MIND_CONTENT_FIELD).get(1);
    if (!(block instanceof Y.XmlElement)) throw new Error("No added paragraph.");
    const text = block.get(0);
    if (!(text instanceof Y.XmlText)) throw new Error("No added text.");
    text.insert(0, "Later ");
  }
  before.destroy();
  return {
    doc,
    application: {
      undoId: "test",
      reviewBefore,
      afterVector,
      requests: ["request"],
      held: false,
    },
  };
}

function editorWith(doc: Y.Doc): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      ProposalReview,
      AppliedEditLine.configure({ translate: (key) => key, undoKeys: () => "" }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => editor.destroy());
  return editor;
}

// Value: protects=Review never restores over later text; fails_when=snapshot anchors are used after state diverges; why_new=only matching Review was covered; seam=none; no_claim=full app timing (real editor, later Yjs edit)
describe("Review of a core-applied change", () => {
  test.each([
    { later: false, review: true },
    { later: true, review: false },
  ])(
    "Review is offered only while the editor matches the accepted state: %s",
    async ({ later, review }) => {
      const document = new DOMParser().parseFromString(
        "<!doctype html><html><head></head><body></body></html>",
        "text/html",
      );
      const window = document.defaultView;
      Object.assign(globalThis, {
        window,
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
      Object.assign(window, {
        incarnamind: {
          on: () => () => undefined,
          releaseAskedChanges: async () => undefined,
          undoAskedChanges: async () => false,
          redoAskedChanges: async () => false,
        },
      });
      const { applyArrived, offersReview } = await import("../../src/renderer/src/appliedEdits");
      const { doc, application } = applicationWithChange(later);
      const editor = editorWith(doc);
      expect(
        applyArrived(
          editor,
          "mind",
          new Set(["request"]),
          {
            created: false,
            changed: 0,
            wrote: 1,
            tables: 0,
          },
          { application },
        ),
      ).toBe("applied");
      expect(offersReview(editor)).toBe(review);
      const line = appliedLineIn(editor.state);
      expect(line?.kind).toBe("applied");
      if (line?.kind !== "applied") throw new Error("No applied line.");
      expect(line.changes.length).toBe(review ? 1 : 0);
      doc.destroy();
    },
  );
});
