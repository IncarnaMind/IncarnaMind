import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type * as Y from "yjs";
import type { Core } from "../../src/core";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import {
  claimSpans,
  paragraphPlaces,
  shownClaims,
} from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { applyFigure } from "../../src/renderer/src/unsupportedFixes";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

/*
 * Use {figure} writes the figure's number at once, with no request of its own,
 * and then the sentence is checked again like any edit (#2313): the model reads
 * the new sentence, and its verdict is the one shown, never a Supported written
 * by code. A misnamed figure ends Unsupported or Not checked, never Supported.
 * Undo brings back the old number and the check it had. English and Chinese.
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

interface Case {
  language: "en" | "zh-CN";
  /** A sentence that names the figure another name than the one it was worked out from. */
  sentence: string;
  after: string;
  document: { name: string; contents: string };
  calculation: {
    inputs: { name: string; label: string; quote: string; number: string }[];
    formula: string;
    as: string;
    stated: string;
  };
}

const CASES: Case[] = [
  {
    language: "en",
    sentence: "Revenue to EBITDA was 1.1x at the end of 2025.",
    after: "Revenue to EBITDA was 1.31x at the end of 2025.",
    document: {
      name: "Board update.md",
      contents: [
        "# Board update",
        "",
        "Net debt was £1,234m at the end of 2025.",
        "",
        "EBITDA was £942m in 2025.",
      ].join("\n"),
    },
    calculation: {
      inputs: [
        { name: "nd", label: "Net debt 2025", quote: "Net debt was £1,234m", number: "£1,234m" },
        { name: "e", label: "EBITDA 2025", quote: "EBITDA was £942m", number: "£942m" },
      ],
      formula: "nd / e",
      as: "times",
      stated: "1.1x",
    },
  },
  {
    language: "zh-CN",
    sentence: "收入与 EBITDA 之比为 1.1 倍。",
    after: "收入与 EBITDA 之比为 1.31倍。",
    document: {
      name: "董事会报告.md",
      contents: "# 董事会报告\n\n截至2026年9月30日，净负债为12,340万元。全年EBITDA为9,420万元。\n",
    },
    calculation: {
      inputs: [
        { name: "nd", label: "净负债", quote: "净负债为12,340万元", number: "12,340万元" },
        { name: "e", label: "EBITDA", quote: "全年EBITDA为9,420万元", number: "9,420万元" },
      ],
      formula: "nd / e",
      as: "times",
      stated: "1.1 倍",
    },
  },
];

/** A checked Mind in a real core, and the model's requests. */
async function checked(each: Case) {
  const calls: ModelCall[] = [];
  const plans: Record<string, Plan> = {
    [each.sentence]: { verdict: "supported", calculation: each.calculation },
    // The model reads the new sentence, and the figure's name isn't the one the working used.
    [each.after]: { verdict: "unsupported" },
  };
  const setup = await setUpWithDocuments(checkingModel(plans, calls), [each.document]);
  const provider = await setup.core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (provider.service) await setup.core.allowDataFlow("checks", provider.service.id);
  writeMind(setup.client, [
    {
      type: "paragraph",
      attrs: { id: "point" },
      content: [{ type: "text", text: each.sentence }],
    },
  ]);
  await setup.client.settled();
  await setup.core.checkSentences({
    requestId: "check",
    mindId: setup.mind.id,
    action: "check-against-documents",
    from: { blockId: "point", offset: 0 },
    to: { blockId: "point", offset: each.sentence.length },
  });
  await vi.waitFor(() => expect(claimSpans(readMind(setup.client))).toHaveLength(1));
  return { ...setup, calls };
}

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

describe("Use {figure} asks the model for the verdict (#2313)", () => {
  test.each(CASES)(
    "the number changes at once, then the model's verdict shows, never Supported, and Undo restores the old check ($language)",
    async (each) => {
      const { core, client, mind, calls } = await checked(each);
      bridge.core = core;
      const editor = openEditor(client.doc);
      const before = shownClaims(editor.state)[0];
      if (!before) throw new Error("The sentence has no check.");
      expect(before.shown.state).toBe("contradicted");

      bridge.checks.length = 0;
      const asked = calls.length;
      const started = performance.now();
      applyFigure(editor, mind.id, client.doc, before);

      // The number is the figure's at once, and the ordinary edit check is the request that follows.
      expect(textOf(editor)).toBe(each.after);
      expect(bridge.checks).toHaveLength(1);

      await vi.waitFor(
        () => {
          const state = shownClaims(editor.state)[0]?.shown.state;
          expect(state === "unsupported" || state === "not-checked").toBe(true);
        },
        { timeout: 15_000 },
      );
      const took = Math.round(performance.now() - started);
      const after = shownClaims(editor.state)[0];
      if (!after) throw new Error("The sentence lost its check.");
      expect(after.shown.state).not.toBe("supported");
      expect(after.check.id).not.toBe(before.check.id);
      expect(calls.length).toBeGreaterThan(asked);
      console.log(`Use {figure} (${each.language}): press to new mark ${took} ms`);

      editor.commands.undo();
      expect(textOf(editor)).toBe(each.sentence);
      const restored = shownClaims(editor.state)[0];
      if (!restored) throw new Error("Undo left no check.");
      expect(restored.shown.state).toBe("contradicted");
      expect(restored.check.id).toBe(before.check.id);
    },
  );
});
