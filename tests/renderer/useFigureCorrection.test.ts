import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { MockLanguageModelV4 } from "ai/test";
import { DOMParser } from "linkedom";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import {
  type Citation,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import { applyCorrection } from "../../src/renderer/src/correctionFixes";
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
import { manualClock, startCore } from "../helpers/core";
import { readMind, writeMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

/*
 * A one-click correction — Use {figure} and Change to… — replaces the words at
 * once, with no model call for the edit (#2313, #2563). The sentence is then
 * checked again like any edit: it shows Checking…, the model's verdict is the
 * one shown, and code never writes Supported. The card's foot names the new
 * check's model and time, and Undo brings back the old words and verdict.
 */

const bridge = vi.hoisted(() => ({
  core: null as Core | null,
  checks: [] as unknown[],
  /** The app quits before the check reaches the core. */
  offline: false,
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
              return bridge.offline
                ? Promise.reject(new Error("The app quit."))
                : value.apply(core, [input]);
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

interface Case {
  language: "en" | "zh-CN";
  /** A sentence that names its figure as another one than the working read. */
  sentence: string;
  after: string;
  document: { name: string; contents: string };
  calculation: {
    inputs: { name: string; label: string; quote: string; number: string }[];
    formula: string;
    as: string;
    stated: string;
  };
  /** What the model reads the corrected sentence as. */
  verdict: "supported" | "unsupported";
}

const USE: Case[] = [
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
    verdict: "unsupported",
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
    verdict: "unsupported",
  },
  {
    language: "en",
    sentence: "Net debt to EBITDA was 1.1x at the end of 2025.",
    after: "Net debt to EBITDA was 1.31x at the end of 2025.",
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
    verdict: "supported",
  },
];

/** A model whose next calls wait until the test lets them go. */
function held(model: MockLanguageModelV4) {
  let gate: Promise<void> | null = null;
  let open = () => {};
  return {
    model: new MockLanguageModelV4({
      doGenerate: async (options) => {
        if (gate) await gate;
        return model.doGenerate(options);
      },
      doStream: (options) => model.doStream(options),
    }),
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
  };
}

/** A checked Mind in a real core, and the model's requests. */
async function checked(each: Case) {
  const calls: ModelCall[] = [];
  const plans: Record<string, Plan> = {
    [each.sentence]: { verdict: "supported", calculation: each.calculation },
    [each.after]:
      each.verdict === "supported"
        ? { verdict: "supported", calculation: { ...each.calculation, stated: "1.31x" } }
        : { verdict: "unsupported" },
  };
  const model = held(checkingModel(plans, calls));
  const clock = manualClock(CHECKED_AT);
  const setup = await setUpWithDocuments(model.model, [each.document], { now: clock.now });
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
  bridge.core = setup.core;
  return { ...setup, calls, clock, model, provider };
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

const shown = (editor: Editor) => shownClaims(editor.state)[0];

describe("Use {figure} asks the model for the verdict (#2313)", () => {
  test.each(USE)(
    "the number changes at once, the mark shows Checking then the model's $verdict, and Undo restores the old check ($language)",
    async (each) => {
      const { client, mind, provider, calls, clock, model } = await checked(each);
      const editor = openEditor(client.doc);
      const before = shown(editor);
      if (!before) throw new Error("The sentence has no check.");
      expect(before.shown.state).toBe("contradicted");
      const asked = calls.length;
      expect(checkedWith(before.check)).toEqual({
        models: [{ providerId: provider.id, modelId: "claude-haiku-5-5" }],
        checkedAt: CHECKED_AT,
      });

      clock.advance(60_000);
      bridge.checks.length = 0;
      model.hold();
      applyFigure(editor, mind.id, client.doc, before);

      // The number is the figure's at once, and the one request is the sentence's ordinary check.
      expect(textOf(editor)).toBe(each.after);
      await vi.waitFor(() => expect(bridge.checks).toHaveLength(1));
      expect(bridge.checks[0]).toMatchObject({
        from: { blockId: "point", offset: 0 },
        to: { blockId: "point", offset: each.after.length },
        action: "check-against-documents",
      });
      await vi.waitFor(() => expect(shown(editor)?.shown.state).toBe("checking"), {
        timeout: 15_000,
      });
      model.release();

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
      expect(after.shown.state).toBe(each.verdict);
      expect(calls.length).toBeGreaterThan(asked);
      // The card's foot names the run that judged these words, not the first check's.
      expect(checkedWith(after.check)).toEqual({
        models: [{ providerId: provider.id, modelId: "claude-haiku-5-5" }],
        checkedAt: AGAIN_AT,
      });
      expect(after.check.id).not.toBe(before.check.id);

      editor.commands.undo();
      expect(textOf(editor)).toBe(each.sentence);
      const restored = shown(editor);
      if (!restored) throw new Error("Undo left no check.");
      expect(restored.shown.state).toBe("contradicted");
      expect(restored.check.id).toBe(before.check.id);
      expect(checkedWith(restored.check)).toEqual({
        models: [{ providerId: provider.id, modelId: "claude-haiku-5-5" }],
        checkedAt: CHECKED_AT,
      });
    },
  );

  test.each(USE.slice(0, 2))(
    "quitting after Use, before the result, reopens Needs re-check, never Checking and never Supported ($language)",
    async (each) => {
      const { core, client, mind, provider, dataDir } = await checked(each);
      const editor = openEditor(client.doc);
      const before = shown(editor);
      if (!before) throw new Error("The sentence has no check.");

      bridge.offline = true;
      applyFigure(editor, mind.id, client.doc, before);
      expect(textOf(editor)).toBe(each.after);
      await client.settled();
      await core.close();
      bridge.core = null;

      const reopened = startCore(dataDir, {});
      const stored = new Y.Doc();
      Y.applyUpdate(stored, (await reopened.openMind(mind.id)).state);
      const [span] = claimSpans(readMind({ blocks: stored.getXmlFragment(MIND_CONTENT_FIELD) }));
      if (!span) throw new Error("The reopened Note has no checked sentence.");
      const state = claimCheckShown(span.check, {
        text: span.sentence.text,
        versions: null,
        folderId: null,
        scope: null,
      }).state;
      expect(state).toBe("needs-recheck");
      expect(state).not.toBe("checking");
      expect(state).not.toBe("supported");
      expect(span.sentence.text).toBe(each.after);
      expect(checkedWith(span.check)).toEqual({
        models: [{ providerId: provider.id, modelId: "claude-haiku-5-5" }],
        checkedAt: CHECKED_AT,
      });
      stored.destroy();
      bridge.offline = false;
    },
  );
});

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
      const applied = applyCorrection(editor, mind.id, client.doc, before, null, () => undefined);
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
