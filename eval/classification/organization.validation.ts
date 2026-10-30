/** Live local protocol check: folder + tags together, no embeddings or app database. */
import { mkdir, writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { expect, test } from "vitest";
import { decisionGroupClassifier } from "../../src/core/library/classifier";
import type { LibraryGroup } from "../../src/core/library/types";

const baseUrl = "http://127.0.0.1:11434";
const groups: LibraryGroup[] = [
  { id: "research", name: "Research papers", description: "Scientific studies and experiments" },
  { id: "finance", name: "Finance", description: "Invoices, budgets and financial statements" },
  { id: "meetings", name: "Meeting notes", description: "Meeting minutes and action items" },
].map((g) => ({ ...g, countsOwnFiles: false, keepInside: false, createdAt: "", updatedAt: "" }));
const tags = [
  {
    id: "membrane",
    name: "Membranes",
    description: "Membrane materials, filtration or separation research",
  },
  {
    id: "invoice",
    name: "Invoice",
    description: "A request for payment listing purchased goods or services and the amount due",
  },
  {
    id: "actions",
    name: "Action items",
    description: "Assigned tasks with owners and deadlines from a meeting",
  },
];

test("installed Tev1 4B, Tev1 0.8B and Clef return a folder and multiple tag decisions", async () => {
  const results: unknown[] = [];
  try {
    for (const model of ["tev1:4b", "tev1:0.8b"]) {
      for (const sample of [
        {
          name: "Membrane experiment",
          text: "A scientific study measures salt rejection and water flux in polyamide reverse osmosis membranes. Experimental membranes rejected 99% of sodium chloride.",
          group: "research",
          tag: "membrane",
        },
        {
          name: "发票",
          text: "发票编号 INV-2401。购买实验室设备，总金额人民币 12,800 元，请在 10 月 30 日前支付。供应商：科学仪器公司。",
          group: "finance",
          tag: "invoice",
        },
        {
          name: "Meeting minutes",
          text: "Project meeting: agreed tasks. Alice will send the revised plan by Friday. Bob will book the room by Thursday. Next meeting on Monday.",
          group: "meetings",
          tag: "actions",
        },
      ]) {
        const start = performance.now();
        const result = await decisionGroupClassifier({
          baseUrl,
          apiKey: "ollama",
          model,
          local: true,
        }).organize(
          groups,
          tags,
          { name: sample.name, kind: "text", pageCount: null, text: sample.text },
          AbortSignal.timeout(90_000),
        );
        results.push({
          model,
          sample: sample.name,
          ms: Math.round(performance.now() - start),
          result,
        });
        expect(result.groupId).toBe(sample.group);
        expect(result.tags.map((t) => t.tagId)).toContain(sample.tag);
        console.log(
          `${model} / ${sample.name}: ${result.groupId}; ${result.tags.map((t) => t.tagId).join(", ")}`,
        );
      }
      await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
    }
    const canvas = createCanvas(1000, 700);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 1000, 700);
    context.fillStyle = "black";
    context.font = "bold 65px Arial";
    context.fillText("INVOICE #2026-41", 70, 140);
    context.font = "34px Arial";
    context.fillText("Laboratory equipment", 70, 240);
    context.fillText("Total due: GBP 1,280.00", 70, 340);
    context.fillText("Please pay by 30 October 2026", 70, 430);
    const result = await decisionGroupClassifier({
      baseUrl,
      apiKey: "ollama",
      model: "clef-flash",
      local: true,
      usePageImages: true,
    }).organize(
      groups,
      tags,
      { name: "scan.pdf", kind: "pdf", pageCount: 1, text: "" },
      AbortSignal.timeout(120_000),
      [{ page: 1, data: canvas.toBuffer("image/jpeg").toString("base64") }],
    );
    results.push({ model: "clef-flash", sample: "image-only invoice", result });
    expect(result.groupId).toBe("finance");
    expect(result.tags.map((t) => t.tagId)).toContain("invoice");
    console.log(
      `clef-flash / image-only invoice: ${result.groupId}; ${result.tags.map((t) => t.tagId).join(", ")}`,
    );
  } finally {
    await mkdir("eval/results/organization", { recursive: true });
    await writeFile("eval/results/organization/live.json", JSON.stringify(results, null, 2));
    for (const model of ["tev1:4b", "tev1:0.8b", "clef-flash"])
      await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
      }).catch(() => undefined);
  }
});
