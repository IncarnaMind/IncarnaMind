/**
 * A file an outside agent hands over to be checked (#3412) is never a source (#3492): no agent's
 * search, read, list, citation or analysis reaches it, no Answer searches it and no check finds or
 * names it, until the User cites it again, which makes it one of their own Documents. The User's
 * own search still finds it. Through the shim the app ships, as Claude Code calls it.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent, resultText } from "../helpers/agents";
import { askAndFinish, citingModel } from "../helpers/citations";
import { WorkbookBuilder } from "../helpers/financeWorkbooks";
import { type Handed, handOver, NORTH, refusal, started, structured } from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { plainDeck } from "../helpers/pptx";

/** Said only in the deck the agent made: no Document of the User's says it. */
const EAST = "The east quay holds 31 boats.";
const NOT_FOUND = translate("en", "agents.problem.not-found");

/**
 * The Coast Library with "Harbour review", a deck Claude Code made and handed over; `unchecked`:
 * handed over while no model is set up, which is set up again after.
 */
async function handedOver(options: Parameters<typeof started>[1] = {}, unchecked = false) {
  const set = await started([], options);
  if (unchecked) {
    for (const provider of await set.core.listChatProviders()) {
      await set.core.deleteChatProvider(provider.id);
    }
  }
  const agent = await connectLegacyAgent(set.writer.launch);
  const path = join(set.files, "Harbour review.pptx");
  await writeFile(path, plainDeck([{ title: "Harbour review" }, { lines: [EAST, NORTH] }]));
  const handed = structured<Handed>(await handOver(agent, { path, folderId: set.coast.id }));
  const document = (await set.core.listDocuments()).find((each) => each.name === "Harbour review");
  if (!document) throw new Error("The deck has no Document.");
  expect(document.notCited).toBe(true);
  if (unchecked) await set.core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { ...set, agent, handed, document };
}

describe("a file an outside agent handed over", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a handed-over file is reached by no agent Tool, by the agent that made it or another, until the User cites it again; the User's own search finds it all along (#3492); fails_when=an agent's search, read_passages, cite or list_minds shows its words, its Passages or its name
  it("is never searched, read, listed or cited by an agent, until the User cites it again", async () => {
    const { core, coast, agent, reader, document } = await handedOver();
    const codex = await connectLegacyAgent(reader.launch);
    const own = (await core.searchPassages("east quay boats")).find(
      (passage) => passage.documentId === document.id,
    );
    if (!own) throw new Error("The User's own search didn't find the deck.");

    const coastRow = async (each: typeof agent) =>
      structured<{
        folders: { id: string; documents: number; documentList: { id: string }[] }[];
      }>(await each.callTool({ name: "list_minds", arguments: {} })).folders.find(
        (folder) => folder.id === coast.id,
      );
    const search = async (each: typeof agent) =>
      JSON.stringify(
        structured(
          await each.callTool({ name: "search", arguments: { query: "east quay boats" } }),
        ),
      );

    for (const each of [agent, codex]) {
      const found = await search(each);
      expect(found).toContain("Harbour survey");
      expect(found).not.toContain(document.id);
      expect(found).not.toContain("east quay");
      for (const args of [{ documentId: document.id }, { passageId: own.passageId }]) {
        expect(refusal(await each.callTool({ name: "read_passages", arguments: args }))).toBe(
          NOT_FOUND,
        );
      }
      expect(
        refusal(
          await each.callTool({
            name: "cite",
            arguments: { citations: [{ passageId: own.passageId, quote: EAST }] },
          }),
        ),
      ).toBe(translate("en", "agents.problem.citeNotFound", { passageId: own.passageId }));
      const row = await coastRow(each);
      expect(row?.documents).toBe(2);
      expect(row?.documentList.map((listed) => listed.id)).not.toContain(document.id);
    }

    // "Cite this Document again": the User makes it one of their Documents, a source like any.
    await core.setNotCited(document.id, false);
    expect(await search(codex)).toContain(document.id);
    expect((await coastRow(codex))?.documents).toBe(3);
  });

  // protects=an agent's run_analysis reads no rows of a handed-over workbook until the User cites it (#3492); fails_when=a figure is worked out from what an AI made, cited to it
  it("is never worked out from by an agent's analysis, until the User cites it again", async () => {
    const runtime = createFakeAnalysisRuntime();
    const { core, coast, writer, files } = await started([], { analysisRuntime: runtime });
    const agent = await connectLegacyAgent(writer.launch);
    const book = new WorkbookBuilder();
    book
      .sheet("Inputs")
      .text("A1", "Item")
      .text("B1", "2026")
      .text("A2", "Rent")
      .number("B2", 14000);
    const path = join(files, "Harbour budget.xlsx");
    await writeFile(path, book.xlsx());
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const document = (await core.listDocuments()).find((each) => each.name === "Harbour budget");
    if (!document) throw new Error("The workbook has no Document.");

    const run = () =>
      agent.callTool({
        name: "run_analysis",
        arguments: {
          title: "Rent",
          inputs: [{ name: "rows", documentId: document.id }],
          code: 'result("n", 1)',
        },
      });
    expect(resultText(await run())).toMatch(/give a documentId or a passageId of a sheet or CSV/);
    expect(runtime.jobs).toHaveLength(0);

    await core.setNotCited(document.id, false);
    structured<{ id: string | null }>(await run());
    expect(runtime.jobs).toHaveLength(1);
  });

  // protects=a check finds no evidence in a handed-over file and names none: a claim only it states is plainly Unsupported, never "only your own working file says this" (#3492); fails_when=a check's search shows its Passages, or a result names it as left out
  it("is never evidence for a check, nor named as left out of one", async () => {
    const { core, document } = await handedOver();

    const evidence = await core.searchEvidence("east quay boats");
    expect(evidence.passages.map((passage) => passage.documentId)).not.toContain(document.id);
    expect(evidence.excluded).toEqual([]);
    expect(await core.checkClaim({ claim: EAST })).toMatchObject({
      verdict: "unsupported",
      excluded: [],
    });

    await core.setNotCited(document.id, false);
    expect(
      (await core.searchEvidence("east quay boats")).passages.map((passage) => passage.documentId),
    ).toContain(document.id);
  });

  // protects=a handed-over file in a Folder an agent reaches is no source its checks need: the agent still checks its own Note there, and checks the handed file itself while no model is set up (#3492, #3412); fails_when=a check of a Note in that Folder is refused as reading Documents outside the agent's Folders
  it("never stops an agent's own check of a Note in its Folder", async () => {
    const { core, coast, agent, handed } = await handedOver({}, true);
    for (const provider of await core.listChatProviders()) {
      await core.deleteChatProvider(provider.id);
    }
    const task = structured<{ sentences: { text: string }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: handed.mindId } }),
    );
    expect(task.sentences.map((each) => each.text)).toContain(EAST);

    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const { mindId } = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: { title: "Quays", markdown: NORTH, folderId: coast.id },
      }),
    );
    expect(
      structured<{ status: string }>(
        await agent.callTool({ name: "check_mind", arguments: { mindId } }),
      ),
    ).toMatchObject({ status: "checked" });
  });

  // protects=an Answer, the User's or one an agent asks for, never searches a handed-over file or lists it among the Documents it may search (#3492); fails_when=its Passages or its name are given to the model
  it("is never searched by an Answer", async () => {
    const model = citingModel({
      query: "east quay boats",
      records: (passages) =>
        passages
          .filter((passage) => passage.document === "Harbour survey")
          .map((passage, index) => ({
            marker: index + 1,
            passage: passage.id,
            quote: "The north quay holds 42 boats",
          })),
      answer: "The north quay holds 42 boats.[^1]",
    });
    const { core } = await handedOver({ model }, true);
    const mind = await core.createMind({ title: "Boats" });
    const client = await connectToMind(core, mind.id);
    await askAndFinish(core, client, mind.id, "How many boats does each quay hold?");

    const given = model.doStreamCalls.map((call) => JSON.stringify(call.prompt)).join("\n");
    expect(given).toContain('document=\\"Harbour survey\\"');
    expect(given).not.toContain('document=\\"Harbour review\\"');
    expect(given).not.toContain("east quay holds 31");
  });
});
