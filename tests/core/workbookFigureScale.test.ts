/**
 * A workbook's figure is shown as its cell shows it (#2577): a total from `#,##0` cells keeps all
 * its digits instead of being rounded into a scale word, so 27,000 is never "3万" and 27,345 never
 * "27 thousand", in either language.
 */
import { describe, expect, test } from "vitest";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { sheetWithRows } from "../helpers/sheetRows";

const LANGUAGES = {
  en: {
    file: "Project budget.xlsx",
    sheet: "Budget",
    head: ["Item", "Amount"],
    items: ["Equipment", "Services", "Total"],
    question: "What is the current budget total, and what would it be if equipment cost 18,000?",
    answer: "The current total is [=1]; with equipment at 18,000 it would be [=2].",
  },
  "zh-CN": {
    file: "项目预算.xlsx",
    sheet: "预算",
    head: ["项目", "金额"],
    items: ["设备", "服务", "合计"],
    question: "当前的预算合计是多少？如果设备费用改为 18,000，合计会是多少？",
    answer: "当前合计为 [=1]；设备改为 18,000 后为 [=2]。",
  },
} as const;
type Language = keyof typeof LANGUAGES;

const amount = (value: number) => ({ value, format: "#,##0" as const });

function budget(language: Language, equipment: number, services: number): Buffer {
  const { sheet, head, items } = LANGUAGES[language];
  const [first, second, total] = items;
  return sheetWithRows(sheet, [
    { cells: [...head] },
    { cells: [first, amount(equipment)] },
    { cells: [second, amount(services)] },
    {
      cells: [
        total,
        { formula: "SUM(B2:B3)", value: equipment + services, format: "#,##0" as const },
      ],
    },
  ]);
}

/** The figures as the Answer shows them: the total the cells give, then the what-if's. */
async function shownFigures(language: Language, equipment: number, services: number) {
  const { file, sheet, items, question, answer } = LANGUAGES[language];
  const model = scriptedModel((call) => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search)
      return { calls: [{ tool: "search_documents", input: { query: items.join(" ") } }] };
    const passage = shownPassages(search.text)[0]?.id ?? "P1";
    const done = call.results.filter(
      (result) => result.tool === "trace_formulas" || result.tool === "what_if",
    ).length;
    const next = [
      { tool: "trace_formulas", input: { passage, cell: `${sheet}!B4`, label: items[2] } },
      {
        tool: "what_if",
        input: {
          passage,
          cell: `${sheet}!B4`,
          label: items[2],
          changes: [{ input: `${sheet}!B2`, value: "18,000" }],
        },
      },
    ][done];
    return next ? { calls: [next] } : { text: answer };
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const path = await writeSourceFile(
    await createTempDataFolder(),
    file,
    budget(language, equipment, services),
  );
  await addAndProcess(core, [path]);
  const asked = await core.askInConversation({ text: question });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const { messages } = await core.getConversation(asked.conversation.id);
  core.close();
  const found = messages.find((message) => message.id === asked.answerId);
  if (found?.kind !== "answer") throw new Error("No Answer.");
  return found.figures.map((figure) => figure.shown);
}

describe("a workbook figure keeps the digits its cells show", () => {
  test.each([
    ["zh-CN", 15000, 12000, ["27,000", "2.7万"], "3万"],
    ["zh-CN", 15345, 12000, ["27,345", "2.7345万"], "3万"],
    ["en", 15345, 12000, ["27,345", "27.345 thousand"], "27 thousand"],
  ] as const)(
    "%s: cells of %i and %i add to a total shown with every digit, not as %s",
    async (language, equipment, services, exact, rounded) => {
      const [total] = await shownFigures(language, equipment, services);
      expect(total).not.toBe(rounded);
      expect(exact).toContain(total);
    },
  );

  test("zh-CN: a what-if result of 30,345 isn't shown as 3万 either", async () => {
    const [, changed] = await shownFigures("zh-CN", 15000, 12345);
    expect(changed).not.toBe("3万");
    expect(["30,345", "3.0345万"]).toContain(changed);
  });
});
