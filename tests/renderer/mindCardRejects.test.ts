import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { nodeOf, topLevelBlocks } from "../../src/core/answers/blocks";
import {
  type ConversationAnswer,
  MIND_CONTENT_FIELD,
  MIND_FIGURE_RUNS_FIELD,
  PROPOSAL_ATTRIBUTE,
} from "../../src/core/api";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { calculatedFiguresIn, figureRunsFor, installFigureRuns } from "../../src/shared/figureRuns";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { pendingProposals, recordProposalRequest } from "../../src/shared/proposals";
import { askAssistant, changesIn } from "../helpers/assistant";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { exactly, heading, note, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/*
 * Reject all on an Answer's card (`resolveAllChanges`) is one step of Undo:
 * Reject all again after taking it back brings back exactly what the revision
 * replaced (#1903). The real core sits behind the window's bridge, and the
 * Mind is read with a client as a window's own copy reads it.
 */

const bridge = vi.hoisted(() => ({ core: null as Core | null }));

const coreOf = () => {
  if (!bridge.core) throw new Error("No core.");
  return bridge.core;
};

vi.mock("../../src/renderer/src/core", () => ({
  core: new Proxy(
    {},
    {
      get: (_target, key) => {
        const core = coreOf() as unknown as Record<string | symbol, unknown>;
        const value = core[key];
        return typeof value === "function" ? value.bind(core) : value;
      },
    },
  ),
}));

const MIND = "Q3 review";
const USER_TEXT = "The quarter was very good, and sales were really strong.";
const RISKS = "## Risks\n\nLegal review may take longer.";
const LONGER = "## Risks\n\nLegal review may take longer than planned.";

/** The last user message of a request: the Question it answers. */
const asked = ({ options }: ModelCall): string => {
  const last = options.prompt.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => ("text" in part ? part.text : "")).join("");
};

/** The episode the issue names: an Answer adds waiting text, and the next Answer revises it. */
async function started() {
  let regenerating = false;
  const model = scriptedModel((call): ScriptedReply => {
    if (regenerating) return { text: "It is all there." };
    if (asked(call).endsWith("Add the risks to the Q3 review")) {
      return call.results.some((result) => result.tool === "add_to_mind")
        ? { text: "Added them." }
        : { calls: [{ tool: "add_to_mind", input: { mind: MIND, content: RISKS } }] };
    }
    return call.results.some((result) => result.tool === "edit_mind")
      ? { text: "Said more." }
      : { calls: [{ tool: "edit_mind", input: { mind: MIND, part: "Risks", content: LONGER } }] };
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: MIND });
  const page = await connectToMind(core, mind.id);
  writeMind(page, [heading(2, "Summary"), note(USER_TEXT)]);
  await page.settled();
  const first = await askAssistant(core, {
    text: "Add the risks to the Q3 review",
    mindId: mind.id,
  });
  await page.settled();
  const second = await askAssistant(core, {
    text: "Say more",
    mindId: mind.id,
    conversationId: first.conversationId,
  });
  await page.settled();
  expect(pendingProposals(page.blocks).length).toBeGreaterThan(0);
  return {
    core,
    mind,
    page,
    first,
    second,
    firstRequest: changesIn(first)[0]?.request ?? "",
    regenerate: async () => {
      regenerating = true;
      const result = await core.regenerateConversationAnswer({
        conversationId: second.conversationId,
        answerId: second.id,
      });
      if (!result.asked) throw new Error("Not asked again.");
      expect((await answerEnded(core, result.answerId)).event).toBe("finished");
      await page.settled();
    },
  };
}

describe("Reject all on an Answer's card, Undo, and Reject all again", { timeout: 30_000 }, () => {
  // protects=Reject all on the card, its Undo, and Reject all again after the Undo each leave the Mind as they should, and the second brings back exactly what the revision replaced (#1903); fails_when=the card's Undo leaves the changes or the record, or the second Reject all can't bring the earlier text back; no_claim=none beyond protects.
  test("the earlier text comes back both times, and writing the Answer again leaves it gone", async () => {
    const { core, mind, page, first, second, firstRequest, regenerate } = await started();
    bridge.core = core;
    const { resolveAllChanges } = await import("../../src/renderer/src/mindChanges");
    const { useAppStore } = await import("../../src/renderer/src/store");
    const { useUndo } = await import("../../src/renderer/src/undo");
    const errors: unknown[] = [];
    useAppStore.setState({
      minds: [
        {
          id: mind.id,
          title: MIND,
          autoTitle: "",
          kind: "mind",
          createdAt: "",
          updatedAt: "",
          folderId: null,
        },
      ],
      reportError: (error: unknown) => errors.push(error),
    });
    useUndo.setState({ done: [], undone: [], line: null });
    const revision = changesIn(second)[0];
    const before = exactly(page);

    await resolveAllChanges(second.id, changedMinds(second), "reject");
    await vi.waitFor(() =>
      expect(pendingProposals(page.blocks).some((ref) => ref.request === firstRequest)).toBe(true),
    );
    expect(shownWithChanges(page)).toContain("+ Risks");
    const restored = exactly(page);

    await useUndo.getState().undo();
    await vi.waitFor(() => expect(exactly(page)).toEqual(before));

    await resolveAllChanges(second.id, changedMinds(second), "reject");
    await vi.waitFor(() => expect(exactly(page)).toEqual(restored));

    await resolveAllChanges(first.id, changedMinds(first), "reject");
    await vi.waitFor(() => expect(pendingProposals(page.blocks)).toEqual([]));
    expect(shownWithChanges(page)).not.toContain("+ Risks");
    const gone = exactly(page);

    await regenerate();
    expect(pendingProposals(page.blocks)).toEqual([]);
    expect(exactly(page)).toEqual(gone);
    expect(revision).toMatchObject({ mindId: mind.id, revised: true });
    expect(errors).toEqual([]);
  });
});

/** A paragraph holding an Analysis figure of the run the Note keeps. */
function figureParagraph(id: string, words: string, figure: string): JSONContent {
  return {
    type: "paragraph",
    attrs: { id },
    content: [
      { type: "text", text: words },
      calculatedFigureNode(
        {
          label: "Total",
          formula: "",
          inputs: [],
          value: 300,
          unit: { kind: "plain" as const },
          approximate: false,
          shown: "300",
          show: { language: "en", as: null, decimals: 0, scale: null },
          literals: [],
          engine: FORMULA_VERSION,
          written: null,
          analysis: { analysis: 1, result: "total" },
        },
        figure,
        "run",
      ),
    ],
  };
}

describe("Accept on an Answer's card, then an editor edit of another figure (#2378)", () => {
  test("the record the accepted change's Undo needs stays though the editor deletes a figure", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: MIND });
    const page = await connectToMind(core, mind.id);
    const request = "accepted-change";
    const proposed = figureParagraph("p1", "Total ", "first");
    proposed.attrs = {
      ...proposed.attrs,
      [PROPOSAL_ATTRIBUTE]: { id: "change", request, kind: "delete" },
    };
    writeMind(page, [
      heading(2, "Totals"),
      proposed,
      heading(2, "Notes"),
      figureParagraph("p2", "Again ", "second"),
    ]);
    recordProposalRequest(page.doc, request, {
      source: "outside-agent",
      agent: "Codex",
      pairingId: "pairing",
      createdAt: "2026-11-01T09:00:00.000Z",
    });
    page.doc.transact(() =>
      installFigureRuns(page.doc, [
        {
          id: "run",
          title: "Totals",
          language: "python",
          code: "result('total', 300)",
          inputs: [],
          versions: null,
          codeSha256: "a".repeat(64),
          ranAt: "2026-11-01T00:00:00.000Z",
          values: [{ kind: "figure", name: "total", label: "Total", value: 300, unit: null }],
        },
      ]),
    );
    await page.settled();
    expect(calculatedFiguresIn(topLevelBlocks(page.blocks).map(nodeOf))).toHaveLength(2);
    expect(pendingProposals(page.blocks).map((each) => each.request)).toEqual([request]);

    bridge.core = core;
    const { resolveAllChanges } = await import("../../src/renderer/src/mindChanges");
    const { useAppStore } = await import("../../src/renderer/src/store");
    const { useUndo } = await import("../../src/renderer/src/undo");
    const errors: unknown[] = [];
    useAppStore.setState({
      minds: [
        {
          id: mind.id,
          title: MIND,
          autoTitle: "",
          kind: "mind",
          createdAt: "",
          updatedAt: "",
          folderId: null,
        },
      ],
      reportError: (error: unknown) => errors.push(error),
    });
    useUndo.setState({ done: [], undone: [], line: null });
    const answer = {
      id: "answer",
      toolCalls: [
        {
          id: "call",
          tool: "edit_mind",
          source: "minds",
          status: "done",
          mindChange: { mindId: mind.id, created: false, request, proposals: 1, changed: 1 },
        },
      ],
    } as unknown as ConversationAnswer;
    await resolveAllChanges(answer.id, changedMinds(answer), "accept");
    await vi.waitFor(() => expect(pendingProposals(page.blocks)).toEqual([]));
    expect(calculatedFiguresIn(topLevelBlocks(page.blocks).map(nodeOf))).toHaveLength(1);

    // The editor deletes the figure that is left; no edit removes a record.
    const dom = new DOMParser().parseFromString(
      "<html><head></head><body></body></html>",
      "text/html",
    );
    Object.defineProperty(dom, "styleSheets", { value: [] });
    vi.stubGlobal("document", dom);
    vi.stubGlobal("window", dom.defaultView);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("getComputedStyle", () => ({
      fontStyle: "",
      fontWeight: "",
      fontSize: "",
      fontFamily: "",
    }));
    const [{ noteExtensions }, { FigureEvidence }] = await Promise.all([
      import("../../src/renderer/src/editor/noteSchema"),
      import("../../src/renderer/src/editor/figureEvidence"),
    ]);
    const editor = new Editor({
      element: document.createElement("div"),
      editorProps: { handleScrollToSelection: () => true },
      extensions: [
        ...noteExtensions(),
        Collaboration.configure({ document: page.doc, field: MIND_CONTENT_FIELD }),
        FigureEvidence.configure({ doc: page.doc }),
      ],
    });
    onTestFinished(() => editor.destroy());
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "calculatedFigure") at = pos;
      return true;
    });
    if (at < 0) throw new Error("Missing figure");
    const runs = page.doc.getMap(MIND_FIGURE_RUNS_FIELD);
    editor.view.dispatch(editor.state.tr.delete(at, at + 1));
    await vi.waitFor(() =>
      expect(calculatedFiguresIn(topLevelBlocks(page.blocks).map(nodeOf))).toHaveLength(0),
    );
    expect(runs.size).toBe(2);

    // Undo on the Answer's line brings the accepted change back, its figure's record with it.
    await useUndo.getState().undo();
    await vi.waitFor(() =>
      expect(calculatedFiguresIn(topLevelBlocks(page.blocks).map(nodeOf))).toHaveLength(1),
    );
    const restored = topLevelBlocks(page.blocks)
      .map(nodeOf)
      .filter((node) => calculatedFiguresIn([node]).length > 0);
    expect(figureRunsFor(page.doc, restored)[0]?.values.map((value) => value.name)).toEqual([
      "total",
    ]);
    expect(errors).toEqual([]);
    core.close();
  });
});
