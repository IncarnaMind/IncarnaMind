import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { createFakeChatModel } from "../../src/main/fakeChat";
import { promptText, systemOf } from "../../src/main/fakeChat/prompt";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { mindCheckOf } from "../../src/shared/mindCheck";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, waitForDocuments, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const claims = [
  "Harbours publish the times of high water every 6 months.",
  "Spring tides come at new moon and at full moon.",
  "Neap tides come at the first and last quarter moons.",
  "The harbour office opens at nine in the morning.",
  "Penguins nest on the cliffs above the harbour.",
  "The ferry to the island leaves twice a day.",
  "Fishing boats land their catch before dawn.",
  "The lighthouse was built in 1867.",
  "The pier is closed to cars in summer.",
  "Two cranes unload the cargo ships.",
  "The harbour master keeps a log of every arrival.",
  "Storm warnings are posted at the harbour office.",
  "The sea wall was raised after the 1953 flood.",
  "Pilots guide large ships into the channel.",
  "The marina has berths for sixty yachts.",
];
const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [{ type: "text", text: value }],
});

describe("Check after the scoped Document changes", () => {
  test("rechecks current physical sentences and then plans nothing changed", async () => {
    const calls: { system: string; text: string }[] = [];
    const core = startCore(await createTempDataFolder(), {
      createChatModel: (spec) =>
        wrapLanguageModel({
          model: createFakeChatModel(spec),
          middleware: {
            specificationVersion: "v4",
            transformParams: async ({ params }) => {
              calls.push({ system: systemOf(params.prompt), text: promptText(params.prompt) });
              return params;
            },
          },
        }),
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    const tidesPath = await writeSourceFile(
      sources,
      "Tides.pdf",
      buildPdf([
        {
          lines: [
            "Harbour times",
            "Harbours publish the times of high water every 12 months.",
            "Spring tides come at new moon and at full moon.",
            "Neap tides come at the first and last quarter moons.",
            "The harbour office opens at nine in the morning.",
          ],
        },
      ]),
    );
    const [tides, garden] = await addAndProcess(core, [
      tidesPath,
      await writeSourceFile(
        sources,
        "Garden.pdf",
        buildPdf([
          {
            lines: ["Garden notes", "Roses like a sunny wall and rich soil."],
          },
        ]),
      ),
    ]);
    if (!tides || !garden) throw new Error("Both Documents must be ready.");
    const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
    const mind = await core.createMind({ title: "Harbour notes", folderId: folder.id });
    await core.moveToFolder({ documentIds: [tides.id, garden.id], folderId: folder.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "The harbour" }] },
      paragraph(
        `${claims.slice(0, 5).join(" ")} Does high water come at noon on Sundays? We think the harbour is at its best in spring.`,
      ),
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Ships and boats" }],
      },
      paragraph(`${claims.slice(5, 10).join(" ")} Who looks after the lighthouse now?`),
      paragraph(
        `${claims.slice(10).join(" ")} Can visitors walk on the sea wall? I believe the new marina was worth building.`,
      ),
    ]);
    await client.settled();
    expect(await core.planMindCheck(mind.id, "changed")).toMatchObject({
      kind: "ready",
      sentences: 20,
    });
    const check = async (requestId: string) => {
      const result = await core.checkMind({ requestId, mindId: mind.id, mode: "changed" });
      const watch = await core.planContradictionCheck(mind.id);
      if (watch.kind === "ready")
        await core.checkContradictions({ requestId: `${requestId}-watch`, mindId: mind.id });
      await client.settled();
      return result;
    };
    expect(await check("initial")).toMatchObject({ kind: "checked", checked: 15, stop: null });
    const before = claimSpans(readMind(client));
    expect(before).toHaveLength(15);
    expect(before.map((span) => span.sentence.text.trim())).toEqual(claims);
    expect(await core.planMindCheck(mind.id, "changed")).toMatchObject({ kind: "unchanged" });
    expect(mindCheckOf(client.doc)?.unexamined).toEqual([]);
    const sent = calls.length;
    await writeSourceFile(
      sources,
      "Tides.pdf",
      buildPdf([
        { lines: ["Harbour times", "Harbours publish the times of high water every 6 months."] },
      ]),
    );
    await core.reconcileDocuments();
    await waitForDocuments(core, (documents) => {
      const changed = documents.find((document) => document.id === tides.id);
      expect(changed?.status).toBe("ready");
      expect(changed?.contentHash).not.toBe(tides.contentHash);
    });
    expect(await core.planMindCheck(mind.id, "changed")).toMatchObject({ kind: "ready" });
    expect(await check("document-edited")).toMatchObject({ kind: "checked", stop: null });
    const after = claimSpans(readMind(client));
    const current = (await core.listDocuments()).find((document) => document.id === tides.id);
    expect(current?.contentHash).not.toBe(tides.contentHash);
    expect(after.map((span) => span.sentence)).toEqual(before.map((span) => span.sentence));
    expect(after.find((span) => span.sentence.text.trim() === claims[1])?.check).toMatchObject({
      request: "document-edited",
      state: "unsupported",
    });
    expect(after.some((span) => span.check.request === "document-edited")).toBe(true);
    expect(
      after
        .filter((span) => span.check.request === "document-edited")
        .every(
          (span) =>
            !span.check.versions.some(
              (version) =>
                version.documentId === tides.id && version.contentHash === tides.contentHash,
            ),
        ),
    ).toBe(true);
    expect(calls.slice(sent).some((call) => call.text.includes("every 6 months"))).toBe(true);
    expect(mindCheckOf(client.doc)?.unexamined).toEqual([]);
    expect(await core.planMindCheck(mind.id, "changed")).toMatchObject({ kind: "unchanged" });
    expect(await core.planMindCheck(mind.id, "added")).toEqual({ kind: "nothing" });
  });
});
