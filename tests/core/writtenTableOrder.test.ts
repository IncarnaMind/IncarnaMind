import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { footingNotes } from "../../src/shared/figureSchedule";
import { INLINE_NODE } from "../../src/shared/sentences";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ScriptedReply, scriptedModel, scriptedModels } from "../helpers/models";
import { xlsxOf } from "../helpers/office";

const NORTH = "North\t10";
const SOUTH = "South\t20";
const TOTAL = "Total\t35";

const supported = (quote: string, number: string): Plan => ({
  verdict: "supported",
  quote,
  number,
  says: "It says so.",
});

const PLANS: Record<string, Plan> = {
  "10": supported(NORTH, "10"),
  "20": supported(SOUTH, "20"),
  "35": supported(TOTAL, "35"),
};

// The assistant left East out of the table but kept the sheet's total.
const TABLE = [
  "| Region | Tonnes |",
  "| --- | --- |",
  "| North | 10[^1] |",
  "| South | 20[^2] |",
  "| Total | 35[^3] |",
].join("\n");

/** Searches, cites each row of the sheet, writes the table, and checks as `PLANS` says; North's check waits for `northWaits`. */
function harbourlineModel(northWaits: () => Promise<void>) {
  return scriptedModel(
    (call): ScriptedReply => {
      if (isCheckRun(call)) {
        const reply = checkReply(call, PLANS);
        if (sentenceOf(call) !== "10" || call.results.length > 0) return reply;
        return { ...reply, pause: { after: 0, until: northWaits() } };
      }
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "North South Total" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const citations = [NORTH, SOUTH, TOTAL].map((quote, index) => ({
          marker: index + 1,
          passage: passage?.id,
          quote,
        }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      if (!call.results.some((result) => result.tool === "add_to_mind"))
        return { calls: [{ tool: "add_to_mind", input: { content: TABLE } }] };
      return { text: "Added the table." };
    },
    { generate: checkGenerate(PLANS) },
  );
}

describe("A table the assistant writes is footed in its order", { timeout: 30_000 }, () => {
  // protects=a written table's marks land in the table's order whatever order their checks end in (#2532), so a total whose check ends before a cell's is footed against the cells' marks, and the Figures tab names the sheet's row the table leaves out ("East 5"); fails_when=the waiting landings land in the order their checks ended, so the total lands before North's mark and its source footing is empty; no_claim=how a real model checks a cell.
  test("a total whose check ends before a cell's is footed against the cells above it", async () => {
    let started: { core: Core; mindId: string } | null = null;
    let northWaited = false;
    // A table's marks wait for every check, so the Note shows none yet; the AI-use record gets
    // one entry as each check ends.
    const southAndTotalHeard = () =>
      vi
        .waitFor(
          async () => {
            const uses = started ? await started.core.listAiUse(started.mindId) : [];
            expect(uses.filter((use) => use.kind === "sentence-checked")).toHaveLength(2);
          },
          { timeout: 20_000, interval: 5 },
        )
        .then(
          () => {
            northWaited = true;
          },
          () => undefined,
        );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(harbourlineModel(southAndTotalHeard)).createChatModel,
    });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
    });
    for (const flow of ["chat", "checks"] as const) {
      if (saved.service) await core.allowDataFlow(flow, saved.service.id);
    }
    const sources = await createTempDataFolder();
    const documents = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Harbourline cargo.xlsx",
        xlsxOf([
          {
            name: "Cargo",
            rows: [
              ["Region", "Tonnes"],
              ["North", 10],
              ["South", 20],
              ["East", 5],
              ["Total", 35],
            ],
          },
        ]),
      ),
    ]);
    const folder = await core.createLibraryGroup({ name: "Harbourline", description: "" });
    await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
    const mind = await core.createMind({ title: "Harbourline cargo", folderId: folder.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [{ type: "paragraph", content: [{ type: "text", text: "Cargo." }] }]);
    await client.settled();
    started = { core, mindId: mind.id };

    await askAssistant(core, {
      text: "Add a table of the cargo by region",
      mindId: mind.id,
      scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
    });
    await client.settled();

    expect(northWaited).toBe(true);
    const marks = claimSpans(readMind(client));
    expect(
      marks.map((span) => [
        span.sentence.text.replaceAll(INLINE_NODE, "").trim(),
        span.check.state,
      ]),
    ).toEqual([
      ["10", "supported"],
      ["20", "supported"],
      ["35", "unsupported"],
    ]);
    const total = marks.find((span) => span.sentence.text.startsWith("35"))?.check.figures?.[0];
    expect(total?.footing).toMatchObject([{ axis: "row", sum: 30, agrees: false }]);
    expect(total?.sourceFooting).toMatchObject([
      {
        axis: "row",
        sum: 35,
        agrees: true,
        inputs: [{ label: "East", number: { value: 5 }, cell: { ref: "B4" } }],
      },
    ]);
    const row = (await core.getFigureSchedule(mind.id)).rows.find(
      (each) => each.reading.chars === "35",
    );
    expect(row && footingNotes(row)).toMatchObject([
      { axis: "row", sum: "30", omitted: ["East 5"] },
    ]);
  });
});
