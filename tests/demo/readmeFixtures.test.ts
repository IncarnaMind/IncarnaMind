/**
 * The README recording's test Documents (e2e/demo/research.ts): the workbook, the interview guide
 * and the background deck the take reads as the app reads a real folder. Every figure and every
 * sentence is invented; each file is readable as its own format, and the workbook's summary is
 * the monthly sheet's own sums, so the take's chart rests on what the file states.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { writeResearchFiles } from "../../e2e/demo/research";
import { extractDocx } from "../../src/core/documents/formats/docx";
import { extractPptx } from "../../src/core/documents/formats/pptx";
import { extractXlsx } from "../../src/core/documents/formats/xlsx";
import { processFile } from "../../src/core/documents/processing";

const WORDS = {
  en: { topics: ["Store traffic", "Supplier terms", "Pricing"], fictional: "Fictional" },
  "zh-CN": { topics: ["门店客流", "供应商条款", "定价"], fictional: "虚构" },
} as const;

const folders: string[] = [];
let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "incarnamind-demo-fixtures-"));
  folders.push(folder);
});
afterAll(async () => {
  for (const each of folders) await rm(each, { recursive: true, maxRetries: 3 });
});

describe("The README recording's test Documents", () => {
  for (const language of ["en", "zh-CN"] as const) {
    test(`${language}: each file reads as its format, and the workbook's summary is its sums`, async () => {
      const files = await writeResearchFiles(folder, language);

      const sheet = await extractXlsx(new Uint8Array(await readFile(files.workbook)));
      expect(sheet.workbook.truncated).toBe(false);
      const sales = sheet.workbook.sheets[0];
      const summary = sheet.workbook.sheets[1];
      expect(sales?.columnCount).toBe(4);
      expect(sales?.rowCount).toBeGreaterThan(200);
      const cells = sales?.cells ?? [];
      const months = new Set(
        cells.filter((cell) => cell.column === 0 && cell.row > 1).map((cell) => String(cell.value)),
      );
      expect(months.has("2025-01")).toBe(true);
      expect(months.has("2026-12")).toBe(true);
      expect(months.size).toBe(24);
      const sales2026 = new Map<string, number>();
      for (const cell of cells) {
        if (cell.column !== 0 || cell.row === 1) continue;
        const month = String(cell.value);
        const region = String(
          cells.find((each) => each.column === 1 && each.row === cell.row)?.value ?? "",
        );
        const amount = cells.find((each) => each.column === 3 && each.row === cell.row);
        if (!month.startsWith("2026") || !amount?.numeric) continue;
        sales2026.set(region, (sales2026.get(region) ?? 0) + Number(amount.value));
      }
      expect(sales2026.size).toBe(4);
      const stated = (summary?.cells ?? []).filter((cell) => cell.column === 1 && cell.row > 1);
      expect(stated).toHaveLength(4);
      for (const cell of stated) {
        const region = String(
          summary?.cells.find((each) => each.column === 0 && each.row === cell.row)?.value ?? "",
        );
        expect(Number(cell.value), region).toBe(sales2026.get(region));
      }

      const guide = await extractDocx(new Uint8Array(await readFile(files.guide)));
      const guidance = guide.units.map((unit) => unit.text).join("\n");
      for (const topic of WORDS[language].topics) expect(guidance).toContain(topic);
      expect(guidance).toContain(WORDS[language].fictional);

      const deck = await extractPptx(new Uint8Array(await readFile(files.background)));
      const background = deck.units.map((unit) => unit.text).join("\n");
      expect(background).toContain("Northwind Retail");
      expect(background).toContain(WORDS[language].fictional);

      for (const [kind, file] of [
        ["xlsx", files.workbook],
        ["docx", files.guide],
        ["pptx", files.background],
      ] as const) {
        const result = await processFile({ task: "process", documentId: file, kind, file });
        if (result.outcome !== "ready") throw new Error(`${file}: ${result.outcome}`);
        expect(result.pages.length, file).toBeGreaterThan(0);
      }
    });
  }
});
