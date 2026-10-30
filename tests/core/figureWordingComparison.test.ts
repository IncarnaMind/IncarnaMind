import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { CALCULATED_FIGURE_NODE } from "../../src/core/api";
import { readWorkbook } from "../../src/core/documents/formats/xlsx";
import { readCalculatedFigureAttributes } from "../../src/shared/calculatedFigures";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { cellAsked, compare, comparisonRowsIn } from "../helpers/comparisons";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    scale: "million",
    question: "What were the net debt and operating cash, in GBP millions?",
    search: "net debt",
    sources: [
      {
        title: "Cedar final",
        quote:
          "The final report confirms that net debt was £310,000 thousand and operating cash was £95,000 thousand.",
        text: "Net debt: £310 million; operating cash: £95 million.",
        amounts: [
          { name: "debt", chars: "£310,000 thousand", value: 310_000_000, shown: "£310 million" },
          { name: "cash", chars: "£95,000 thousand", value: 95_000_000, shown: "£95 million" },
        ],
      },
      {
        title: "Cedar superseded draft",
        quote:
          "This draft was superseded by the final report and it states that net debt was £340,000 thousand and operating cash was £80,000 thousand.",
        text: "Net debt: £340 million; operating cash: £80 million.",
        amounts: [
          { name: "debt", chars: "£340,000 thousand", value: 340_000_000, shown: "£340 million" },
          { name: "cash", chars: "£80,000 thousand", value: 80_000_000, shown: "£80 million" },
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    scale: "亿",
    question: "净负债和经营现金各是多少，均以亿英镑表示？",
    search: "净负债",
    sources: [
      {
        title: "雪松终稿",
        quote: "最终报告确认，净负债为3.1亿英镑，经营现金为0.95亿英镑。",
        text: "净负债为3.1亿英镑，经营现金为0.95亿英镑。",
        amounts: [
          { name: "debt", chars: "3.1亿英镑", value: 310_000_000, shown: "3.1亿英镑" },
          { name: "cash", chars: "0.95亿英镑", value: 95_000_000, shown: "0.95亿英镑" },
        ],
      },
      {
        title: "雪松已被取代的草稿",
        quote: "已被终稿取代的草稿显示，净负债为3.4亿英镑，经营现金为0.8亿英镑。",
        text: "净负债为3.4亿英镑，经营现金为0.8亿英镑。",
        amounts: [
          { name: "debt", chars: "3.4亿英镑", value: 340_000_000, shown: "3.4亿英镑" },
          { name: "cash", chars: "0.8亿英镑", value: 80_000_000, shown: "0.8亿英镑" },
        ],
      },
    ],
  },
] as const;

describe("Calculated wording through a comparison Note and its workbook (#1861)", () => {
  test.each(CASES)(
    "$language keeps final and draft amounts separate without duplicate wording",
    async (case_) => {
      const calls: ModelCall[] = [];
      const model = scriptedModel((call) => {
        calls.push(call);
        const source = case_.sources.find((each) => each.title === cellAsked(call).document);
        if (!source) throw new Error("The comparison requested an unknown Source row.");
        if (!call.tools.includes("calculate"))
          throw new Error("The comparison offered no calculate Tool.");
        const search = call.results.filter((result) => result.tool === "search_documents").at(-1);
        if (!search)
          return { calls: [{ tool: "search_documents", input: { query: case_.search } }] };
        expect(new Set(shownPassages(search.text).map((each) => each.document))).toEqual(
          new Set([source.title]),
        );
        const passage = shownPassages(search.text).find(
          (each) => each.document === source.title && each.text.includes(source.quote),
        );
        if (!passage) throw new Error("The comparison did not offer its exact Source quote.");
        if (!call.results.some((result) => result.tool === "cite")) {
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: passage.id, quote: source.quote }] },
              },
            ],
          };
        }
        if (!call.results.some((result) => result.tool === "calculate")) {
          return {
            calls: [
              {
                tool: "calculate",
                input: {
                  figures: source.amounts.map((amount, at) => ({
                    marker: at + 1,
                    label: amount.name,
                    formula: amount.name,
                    scale: case_.scale,
                    stated: amount.shown,
                    relation: "equals",
                    inputs: [
                      { name: amount.name, label: amount.name, citation: 1, number: amount.chars },
                    ],
                  })),
                },
              },
            ],
          };
        }
        return {
          text:
            case_.language === "en"
              ? "Net debt: GBP [=1] million; operating cash: GBP [=2] millions. [^1]"
              : "净负债为英镑 [=1] 亿，经营现金为英镑 [=2] 亿。 [^1]",
        };
      });
      const { core, client, mind, documents } = await setUpWithDocuments(
        model,
        case_.sources.map((source) => ({
          name: `${source.title}.txt`,
          contents: `${source.title}\n${source.quote}\n`,
        })),
      );
      await core.updateSettings({ user: { language: case_.language } });
      const provider = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-test",
        modelId: "claude-haiku-5-5",
      });
      if (provider.service) await core.allowDataFlow("chat", provider.service.id);
      const tableId = await compare(core, client, {
        mindId: mind.id,
        documentIds: documents.map((document) => document.id),
        questions: [case_.question],
        model: { providerId: provider.id, modelId: "claude-haiku-5-5" },
      });
      const restored = await connectToMind(core, mind.id);
      expect(
        comparisonRowsIn(restored),
        JSON.stringify(calls.map(({ tools, results }) => ({ tools, results }))),
      ).toEqual(
        case_.sources.map((source, at) => ({
          documentId: documents[at]?.id,
          name: source.title,
          cells: [
            { questionId: expect.any(String), status: "done", problem: null, text: source.text },
          ],
        })),
      );

      const receipts: NonNullable<ReturnType<typeof readCalculatedFigureAttributes>>[] = [];
      readMind(restored).descendants((node) => {
        if (node.type.name !== CALCULATED_FIGURE_NODE) return;
        const receipt = readCalculatedFigureAttributes(node.attrs);
        if (!receipt) throw new Error("The stored comparison has an unreadable calculated figure.");
        receipts.push(receipt);
      });
      expect(receipts).toHaveLength(4);
      expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(4);
      for (const [row, source] of case_.sources.entries()) {
        const document = documents[row];
        if (!document?.contentHash)
          throw new Error("The Source Document has no processed version.");
        for (const [at, amount] of source.amounts.entries()) {
          expect(receipts[row * 2 + at]?.figure).toMatchObject({
            value: amount.value,
            shown: amount.shown,
            formula: amount.name,
            show: {
              language: case_.language,
              scale: case_.scale,
              ...(case_.language === "en" && { decimals: 0 }),
            },
            inputs: [
              {
                name: amount.name,
                citation: {
                  documentId: document.id,
                  contentHash: document.contentHash,
                  quote: source.quote,
                  check: "found",
                },
                number: {
                  chars: amount.chars,
                  at: source.quote.indexOf(amount.chars),
                  value: amount.value,
                  scale: case_.language === "en" ? 1000 : 100_000_000,
                  unit: { kind: "currency", code: "GBP" },
                },
              },
            ],
          });
        }
      }

      const saved = await core.saveComparisonExport({ mindId: mind.id, tableId });
      if (saved.status !== "saved")
        throw new Error(`Comparison workbook was not saved: ${saved.status}`);
      expect(saved.unverifiedCitations).toBe(0);
      const bytes = new Uint8Array(await readFile(saved.file.path));
      const { sheets } = await readWorkbook(bytes, undefined, {});
      const [table, sources] = sheets;
      if (!table || !sources)
        throw new Error("The exported workbook has no comparison or Sources sheet.");
      expect(sheets).toHaveLength(2);
      expect(
        [2, 3].map(
          (row) => table.cells.find((cell) => cell.row === row && cell.column === 0)?.value,
        ),
      ).toEqual(case_.sources.map((source) => source.title));
      expect(
        [2, 3].map(
          (row) => table.cells.find((cell) => cell.row === row && cell.column === 1)?.value,
        ),
      ).toEqual(case_.sources.map((source) => source.text));
      const sourceNames = sources.cells
        .filter((cell) => cell.row > 1 && cell.column === 1)
        .map((cell) => cell.value);
      const sourceQuotes = sources.cells
        .filter((cell) => cell.row > 1 && cell.column === 3)
        .map((cell) => cell.value);
      expect(new Set(sourceNames)).toEqual(new Set(case_.sources.map((source) => source.title)));
      expect(new Set(sourceQuotes)).toEqual(new Set(case_.sources.map((source) => source.quote)));
    },
  );
});
