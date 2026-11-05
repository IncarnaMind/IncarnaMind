import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import {
  claimSpans,
  paragraphPlaces,
  shownClaims,
} from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { applyFigure } from "../../src/renderer/src/unsupportedFixes";
import { checkedWith, claimCheckShown } from "../../src/shared/claimChecks";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { manualClock } from "../helpers/core";
import { readMind, writeMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

/*
 * Use {figure} sets a sentence's number to the figure the check worked out and
 * settles its check as Supported on the Passage the figure came from (#2313).
 * As Change to… does, it asks no model: the scripted model records no request,
 * and the check line keeps the model and time the check already named. English
 * and Chinese.
 */

const bridge = vi.hoisted(() => ({ checksAsked: [] as unknown[] }));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    checkSentences: async (input: unknown) => {
      bridge.checksAsked.push(input);
      return { kind: "checked", sentences: 1, checked: 1, smallModel: false };
    },
  },
}));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
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

interface Case {
  language: "en" | "zh-CN";
  sentence: string;
  document: { name: string; contents: string };
  calculation: {
    inputs: { name: string; label: string; quote: string; number: string }[];
    formula: string;
    as: string;
    stated: string;
  };
  /** The quote of the Passage the figure was worked out from, which the check settles on. */
  evidence: string;
  after: string;
}

const CASES: Case[] = [
  {
    language: "en",
    sentence: "Net debt to EBITDA was 1.1x at the end of 2025.",
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
    evidence: "Net debt was £1,234m",
    after: "Net debt to EBITDA was 1.31x at the end of 2025.",
  },
  {
    language: "zh-CN",
    sentence: "净负债与 EBITDA 之比为 1.1 倍。",
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
    evidence: "净负债为12,340万元",
    after: "净负债与 EBITDA 之比为 1.31倍。",
  },
];

/** A checked Mind in a real core, and the model's requests, which no fix may add to. */
async function checked(each: Case) {
  const calls: ModelCall[] = [];
  const plans: Record<string, Plan> = {
    [each.sentence]: { verdict: "supported", calculation: each.calculation },
  };
  const setup = await setUpWithDocuments(checkingModel(plans, calls), [each.document], {
    now: manualClock(CHECKED_AT).now,
  });
  const provider = await setup.core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (provider.service) await setup.core.allowDataFlow("checks", provider.service.id);
  const block = {
    type: "paragraph",
    attrs: { id: "point" },
    content: [{ type: "text", text: each.sentence }],
  };
  writeMind(setup.client, [block]);
  await setup.client.settled();
  await setup.core.checkSentences({
    requestId: "check",
    mindId: setup.mind.id,
    action: "check-against-documents",
    from: { blockId: "point", offset: 0 },
    to: { blockId: "point", offset: each.sentence.length },
  });
  await vi.waitFor(() => expect(claimSpans(readMind(setup.client))).toHaveLength(1));
  return { ...setup, provider, calls };
}

/** The Mind's words as its editor holds them, with the check's own reader. */
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

describe("Use {figure} asks no model (#2313)", () => {
  test.each(CASES)(
    "the number becomes the figure and the sentence reads Supported, its line's model and time kept ($language)",
    async (each) => {
      const { core, client, mind, provider, calls } = await checked(each);
      const editor = openEditor(client.doc);
      const before = shownClaims(editor.state)[0];
      if (!before) throw new Error("The sentence has no check.");
      expect(before.shown.state).toBe("contradicted");
      const line = {
        models: [{ providerId: provider.id, modelId: "claude-haiku-5-5" }],
        checkedAt: CHECKED_AT,
      };
      expect(checkedWith(before.check)).toEqual(line);
      expect(textOf(editor)).toBe(each.sentence);

      bridge.checksAsked.length = 0;
      const asked = calls.length;
      applyFigure(editor, before);

      expect(bridge.checksAsked).toEqual([]);
      expect(calls).toHaveLength(asked);
      expect(textOf(editor)).toBe(each.after);
      const [after] = shownClaims(editor.state);
      if (!after) throw new Error("The sentence lost its check.");
      expect(after.shown.state).toBe("supported");
      expect(checkedWith(after.check)).toEqual(line);
      expect(after.check.id).toBe(before.check.id);
      expect(after.check.evidence).toMatchObject({
        documentId: before.check.evidence?.documentId,
        quote: each.evidence,
      });
      expect(after.check.calculation).toBeNull();

      await client.settled();
      const stored = new Y.Doc();
      Y.applyUpdate(stored, (await core.openMind(mind.id)).state);
      const [span] = claimSpans(readMind({ blocks: stored.getXmlFragment(MIND_CONTENT_FIELD) }));
      if (!span) throw new Error("The core kept no checked sentence.");
      expect(
        claimCheckShown(span.check, {
          text: span.sentence.text,
          versions: null,
          folderId: null,
          scope: null,
        }).state,
      ).toBe("supported");
      expect(checkedWith(span.check)).toEqual(line);
      stored.destroy();
    },
  );
});
