import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type * as Y from "yjs";
import type { Core } from "../../src/core";
import {
  type Citation,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import { applyCorrection } from "../../src/renderer/src/correctionFixes";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import { paragraphPlaces, shownClaims } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { checkedWith } from "../../src/shared/claimChecks";
import { checkingModel } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { manualClock } from "../helpers/core";
import { writeMind } from "../helpers/minds";

/*
 * A one-click correction, Change to…, replaces the words at once, with no model call for the edit
 * (#2563). The sentence is then checked again like any edit: the model's verdict is the one
 * shown, and code never writes Supported. The card's foot names the new check's model and time,
 * and Undo brings back the old words and verdict.
 */

const bridge = vi.hoisted(() => ({
  core: null as Core | null,
  checks: [] as unknown[],
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy(
    {},
    {
      get: (_target, key) => {
        const core = bridge.core as unknown as Record<string | symbol, unknown> | null;
        const value = core?.[key];
        if (typeof value !== "function") return value;
        return key === "checkSentences"
          ? (input: unknown) => {
              bridge.checks.push(input);
              return value.apply(core, [input]);
            }
          : value.bind(core);
      },
    },
  ),
}));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
  requestEdit: vi.fn(),
  useEdits: { getState: () => ({ pending: {} }) },
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/i18n", () => ({
  languageNow: () => "en",
  translateNow: (key: string) => key,
}));

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
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

const { ClaimChecks } = await import("../../src/renderer/src/editor/claimChecks");

const CHECKED_AT = "2026-10-12T09:00:00.000Z";
/** A minute later, so the new check's line can be told from the first one's. */
const AGAIN_AT = "2026-10-12T09:01:00.000Z";

function openEditor(doc: Y.Doc) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      ClaimChecks,
      CitationNumbers,
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => editor.destroy());
  return editor;
}

const textOf = (editor: Editor) => {
  const blocks: string[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    blocks.push(paragraphPlaces(node, pos).text);
    return false;
  });
  return blocks.join("\n");
};

const shown = (editor: Editor) => shownClaims(editor.state)[0];

describe("Change to… asks the model for the verdict (#2563)", () => {
  const CORRECTIONS = [
    {
      language: "en" as const,
      sentence: "Revenue grew 25% in 2025.",
      from: "25%",
      wording: "30%",
      document: { name: "Results.md", contents: "# Results\n\nRevenue grew 30% in 2025.\n" },
    },
    {
      language: "zh-CN" as const,
      sentence: "收入在2025年增长了25%。",
      from: "25%",
      wording: "30%",
      document: { name: "业绩.md", contents: "# 业绩\n\n收入在2025年增长了30%。\n" },
    },
  ];

  test.each(CORRECTIONS)(
    "a decoy correction ends Unsupported, never Supported written by code, and the line names the new run ($language)",
    async (each) => {
      const clock = manualClock(CHECKED_AT);
      const { core, client, mind, documents, provider } = await (async () => {
        const setup = await setUpWithDocuments(checkingModel({}), [each.document], {
          now: clock.now,
        });
        const saved = await setup.core.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-test",
          modelId: "claude-haiku-5-5",
        });
        if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);
        return { ...setup, provider: saved };
      })();
      bridge.core = core;
      const document = documents[0];
      if (!document) throw new Error("The Document isn't there.");
      const evidence: Citation = {
        passageId: "passage-1",
        documentId: document.id,
        documentName: document.name,
        contentHash: document.contentHash,
        pageFrom: 1,
        pageTo: 1,
        location: null,
        quote: each.document.contents.split("\n").filter(Boolean).at(-1) ?? "",
        check: "found",
        checkReason: null,
      };
      const check: ClaimCheckAttributes = {
        id: "check-1",
        request: "check-1",
        action: "check-against-documents",
        state: "contradicted",
        reason: null,
        detail: null,
        providerId: provider.id,
        modelId: "claude-haiku-5-5",
        text: each.sentence,
        evidence,
        says: null,
        unsupported: null,
        calculation: null,
        correction: { from: each.from, choices: [{ wording: each.wording, evidence }] },
        citedCaseUnchecked: false,
        citedCaseFound: false,
        scope: { folderId: null, widened: false },
        versions: [],
        excluded: [],
        checkedAt: CHECKED_AT,
      };
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: "point" },
          content: [
            {
              type: "text",
              text: each.sentence,
              marks: [{ type: CLAIM_CHECK_MARK, attrs: check }],
            },
          ],
        },
      ]);
      await client.settled();
      const editor = openEditor(client.doc);
      const before = shown(editor);
      if (!before) throw new Error("The sentence has no check.");
      expect(before.shown.state).toBe("contradicted");

      clock.advance(60_000);
      bridge.checks.length = 0;
      const applied = applyCorrection(editor, mind.id, client.doc, before);
      expect(applied).toBe(true);

      expect(textOf(editor)).toContain(each.wording);
      await vi.waitFor(() => expect(bridge.checks).toHaveLength(1));
      await vi.waitFor(
        () => {
          const state = shown(editor)?.shown.state;
          expect(state === "supported" || state === "unsupported" || state === "not-checked").toBe(
            true,
          );
        },
        { timeout: 15_000 },
      );
      const after = shown(editor);
      if (!after) throw new Error("The sentence lost its check.");
      expect(after.shown.state).toBe("unsupported");
      expect(after.shown.state).not.toBe("supported");
      expect(after.check.id).not.toBe(before.check.id);
      expect(checkedWith(after.check)).toEqual({
        models: [{ providerId: provider.id, modelId: "claude-haiku-5-5" }],
        checkedAt: AGAIN_AT,
      });

      editor.commands.undo();
      const restored = shown(editor);
      if (!restored) throw new Error("Undo left no check.");
      expect(textOf(editor)).toBe(each.sentence);
      expect(restored.shown.state).toBe("contradicted");
      expect(restored.check.id).toBe(before.check.id);
    },
  );
});
