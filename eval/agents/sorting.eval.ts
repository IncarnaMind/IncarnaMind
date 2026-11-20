import { expect, test } from "vitest";
import { agentsAdapter } from "../../tests/helpers/agents";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../../tests/helpers/documents";
import { agentSession, agentUsd } from "../lib/agentSession";

const libraries = [
  [
    ["Ceramics", "Beekeeping", "Lanterns"],
    [
      "The bowls developed pinholes after their second glaze firing. Lower the peak kiln temperature on the next batch.",
      "The upper brood frames hold capped honey. Add a shallow super before the next nectar flow.",
    ],
  ],
  [
    ["Stage lighting", "Orchard care", "Kayak repairs"],
    [
      "Fade the amber wash as the curtain rises. Aim the follow spot at the downstage mark for the entrance.",
      "Prune the crossing apple limbs during dormancy and remove the fallen fruit before spring.",
    ],
  ],
  [
    ["Trail upkeep", "Bookbinding", "Wetland birds"],
    [
      "The switchback above the ridge has loose gravel. Rebuild the timber steps and clear the drainage ditch.",
      "Fold each signature, sew the gatherings onto linen tapes, then glue the spine before casing in.",
    ],
  ],
  [
    ["Textile dyes", "Cloud watching", "Choir rehearsals"],
    [
      "Soak the wool skeins in alum before the madder bath. Rinse until the water runs clear.",
      "High thin cirrus gave way to low gray stratus. Record the cover in eighths and note the cloud base.",
    ],
  ],
  [
    ["Cycle workshop", "Bread trials", "Pond plants"],
    [
      "True the rear wheel, replace the worn brake pads, then check cable tension before the test ride.",
      "The rye dough fermented overnight. Reduce hydration slightly and score the loaf before baking.",
    ],
  ],
  [
    ["Map restoration", "Stargazing", "Seed saving"],
    [
      "Flatten the creased survey sheet under weights. Mend the paper tears with reversible paste and tissue.",
      "At dusk align the telescope mount with the celestial pole. Record the nebula through the wide eyepiece.",
    ],
  ],
] as const;

test.skipIf(!process.env.INCARNAMIND_SORTING_EVAL_KEY)(
  "organise my documents",
  async () => {
    const setup = {
      chat: {
        kind: "anthropic" as const,
        modelId: "claude-haiku-5-5",
        apiKey: process.env.INCARNAMIND_SORTING_EVAL_KEY ?? "",
      },
    };
    const usd = agentUsd(setup);
    let passed = 0;
    let spend = 0;
    for (const [names, texts] of libraries) {
      const data = await createTempDataFolder();
      const core = startCore(data, { agents: await agentsAdapter(data) });
      const root = await core.createLibraryGroup({ name: "Incoming", description: "" });
      const folders = await Promise.all(
        names.map((name) => core.createLibraryGroup({ name, description: "", parentId: root.id })),
      );
      const source = await createSourceFolder();
      const docs = await addAndProcess(
        core,
        await Promise.all(
          texts.map((text, i) => writeSourceFile(source, `Page ${i + 1}.md`, text)),
        ),
      );
      for (const doc of docs) await core.assignDocumentGroup(doc.id, root.id);
      await core.setAgentsEnabled(true);
      const session = await agentSession(core, setup, usd, "Library helper", root.id, null);
      try {
        const { cost, done } = await session.converse([
          { role: "user", content: "organise my documents" },
        ]);
        spend += cost;
        const { items } = await core.getOrganizeReview();
        const voidRun =
          done.finishReason === "error" ||
          done.finishReason === "content-filter" ||
          session.refusals().length > 0 ||
          session.requests.some((r) => r.status !== 200);
        const fits = docs.every((doc, i) =>
          items.some(
            (item) =>
              item.documentId === doc.id &&
              item.agent === "Library helper" &&
              item.placement.kind === "folder" &&
              item.placement.folderId === folders[i]?.id,
          ),
        );
        console.log(
          JSON.stringify({
            folders: names,
            tools: session.calls.map((c) => c.name),
            fits,
            voidRun,
            cost,
            spend,
            proposals: items.length,
          }),
        );
        expect(voidRun).toBe(false);
        if (fits) passed++;
      } catch (error) {
        const status =
          error && typeof error === "object" && "statusCode" in error
            ? error.statusCode
            : undefined;
        console.log(
          JSON.stringify({
            voidRun: true,
            folder: names[0],
            status,
            spend,
            calls: session.calls.map((c) => c.name),
          }),
        );
        throw new Error("Void sorting run");
      } finally {
        await session.close();
        core.close();
      }
    }
    expect(passed).toBeGreaterThanOrEqual(5);
  },
  20 * 60_000,
);
