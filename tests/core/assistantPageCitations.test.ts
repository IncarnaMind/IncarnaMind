import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { answerRequests, askAssistant, changesIn } from "../helpers/assistant";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { shownWithChanges } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * Text the assistant writes into a Mind keeps its Citations, however its
 * calls come: `cite` may run after `create_mind` or `add_to_mind`
 * began writing, in the same step. Its reply only reports what it did: the
 * markers it gave for the Mind are never placed in the reply, and nothing is
 * asked for to cite the report.
 */

const SPRING = "Spring tides happen just after a new moon or a full moon.";
const CONTENT =
  "## Tides\n\nSpring tides come at new and full moon [^1].\n\nNeap tides come between.";
const REPORT = "Made “Tide notes” with a short summary of spring tides happening after a new moon.";

/** A Folder with one PDF, and a Mind in focus, on a scripted model. */
async function setUp(model: MockLanguageModelV4) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const folder = await core.createLibraryGroup({ name: "Coast", description: "" });
  const sources = await createSourceFolder();
  const pdf = buildPdf([{ lines: ["Spring and neap tides", SPRING] }]);
  const added = await core.addDocuments([await writeSourceFile(sources, "Tides.pdf", pdf)], {
    groupId: folder.id,
  });
  await waitForProcessing(
    core,
    added.documents.map((document) => document.id),
  );
  const mind = await core.createMind({ title: "Coast notes", folderId: folder.id });
  return { core, mind, scope: { folderIds: [folder.id], tagIds: [], documentIds: [] } };
}

/** A model that searches, then calls `create_mind` and `cite` in one step, in the order `order` gives. */
function oneStep(order: "cite-first" | "write-first") {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (isCheckRun(call)) return checkReply(call, {});
    const { results } = call;
    const search = results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
    if (results.some((result) => result.tool === "create_mind")) return { text: REPORT };
    const [passage] = shownPassages(search.text);
    const record = { marker: 1, passage: passage?.id, pageFrom: 1, pageTo: 1, quote: SPRING };
    const cite = { tool: "cite", input: { citations: [record] } };
    const write = {
      tool: "create_mind",
      input: { title: "Tide notes", content: CONTENT },
      streamInput: true,
    };
    return { calls: order === "cite-first" ? [cite, write] : [write, cite] };
  });
}

describe("Text written into a Mind keeps its Citations", { timeout: 30_000 }, () => {
  // protects=a page written in the same step as its cite keeps its Citation, whichever call comes first, and the reply is the report as written, with no marker placed in it; fails_when=the page loses its marker, or the reply gets it; no_claim=how a real provider orders the calls.
  test.each(["cite-first", "write-first"] as const)("%s", async (order) => {
    const model = oneStep(order);
    const { core, mind, scope } = await setUp(model);

    const answer = await askAssistant(core, {
      text: "Summarise these Documents into a new note",
      mindId: mind.id,
      scope,
    });

    const [made] = changesIn(answer);
    expect(made).toMatchObject({ created: true, proposals: 3, cited: 1 });
    expect(made?.unrecorded).toBeUndefined();
    const page = await connectToMind(core, made?.mindId ?? "");
    expect(shownWithChanges(page)).toEqual([
      "+ Tides",
      "+ Spring tides come at new and full moon ⟨found⟩.",
      "+ Neap tides come between.",
    ]);
    expect(answer.text).toBe(REPORT);
    expect(answer.citations).toEqual([]);
    const told = model.doStreamCalls
      .flatMap((call) => call.prompt)
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .map((part) => (part.type === "tool-result" ? JSON.stringify(part.output) : ""))
      .join("\n");
    expect(told).not.toContain("left out.");
    // Search, the step with both calls, the report: nothing more was asked to cite it.
    expect(answerRequests(model)).toHaveLength(3);
  });

  // protects=a revision with new text, written in the same step as its cite, keeps its Citation whichever comes first; fails_when=the revised page loses its marker; no_claim=how a real provider orders the calls.
  test.each(["cite-first", "write-first"] as const)("a revision, %s", async (order) => {
    const LONGER =
      "## Tides\n\nSpring tides come at new and full moon [^1].\n\nNeap tides come between, at half moon.";
    let turn = 0;
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      if (isCheckRun(call)) return checkReply(call, {});
      const { results, prompt } = call;
      const second = prompt.includes("make it longer");
      const search = results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      if (results.some((result) => result.tool === (second ? "edit_mind" : "create_mind"))) {
        return { text: second ? "It says more now." : REPORT };
      }
      turn++;
      const [passage] = shownPassages(search.text);
      const record = { marker: 1, passage: passage?.id, pageFrom: 1, pageTo: 1, quote: SPRING };
      const cite = { tool: "cite", input: { citations: [record] } };
      const write = second
        ? {
            tool: "edit_mind",
            input: { mind: "Tide notes", part: "Tides", content: LONGER },
          }
        : { tool: "create_mind", input: { title: "Tide notes", content: CONTENT } };
      return { calls: order === "cite-first" ? [cite, write] : [write, cite] };
    });
    const { core, mind, scope } = await setUp(model);
    const first = await askAssistant(core, {
      text: "Summarise these Documents into a new note",
      mindId: mind.id,
      scope,
    });

    const second = await askAssistant(core, {
      text: "make it longer",
      mindId: mind.id,
      scope,
      conversationId: first.conversationId,
    });

    expect(turn).toBe(2);
    const [revised] = changesIn(second);
    expect(revised).toMatchObject({ revised: true, cited: 1 });
    expect(revised?.unrecorded).toBeUndefined();
    const page = await connectToMind(core, revised?.mindId ?? "");
    expect(shownWithChanges(page)).toEqual([
      "+ Tides",
      "+ Spring tides come at new and full moon ⟨found⟩.",
      "+ Neap tides come between, at half moon.",
    ]);
  });
});
