import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant, changesIn } from "../helpers/assistant";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, note, shownWithChanges, writeMind } from "../helpers/minds";
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

/** A Mind's top-level Blocks as stored, attributes and all: to tell it is exactly as it was. */
const exactly = (client: MindClient) =>
  client.blocks
    .toArray()
    .map((block) =>
      block instanceof Y.XmlElement
        ? { name: block.nodeName, attributes: block.getAttributes(), text: block.toString() }
        : null,
    );

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
