import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { calculatedFigureNode, readCalculatedFigure } from "../../src/shared/calculatedFigures";
import { answerEnded, type ShownPassage, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { libreOfficeFixture, unsupportedWorkbook } from "../helpers/financeWorkbooks";
import { scriptedModel, scriptedModels } from "../helpers/models";

type Call = { tool: string; input: unknown };

function modelling(plan: {
  query: string;
  calls: ((passage: string) => Call)[];
  answer: string;
}): MockLanguageModelV4 {
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0)
      return { calls: [{ tool: "search_documents", input: { query: plan.query } }] };
    const passages: ShownPassage[] = searches.flatMap((each) => shownPassages(each.text));
    const passage = passages[0]?.id ?? "P1";
    const done = call.results.filter(
      (result) => result.tool === "trace_formulas" || result.tool === "what_if",
    ).length;
    const next = plan.calls[done];
    if (next) return { calls: [next(passage)] };
    return { text: plan.answer };
  });
}

function told(model: MockLanguageModelV4, tool: string): string {
  const last = model.doStreamCalls.at(-1);
  const texts: string[] = [];
  for (const message of last?.prompt ?? []) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === tool && part.output.type === "text")
        texts.push(part.output.value);
    }
  }
  return texts.join("\n");
}

async function setUp(
  model: MockLanguageModelV4,
  name: string,
  contents: Uint8Array,
  ownWorkings = false,
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const file = await writeSourceFile(await createTempDataFolder(), name, contents);
  const [document] = await addAndProcess(core, [file]);
  if (ownWorkings && document) await core.setNotCited(document.id, true);
  return { core, file, document };
}

async function ask(core: Core, text: string) {
  const asked = await core.askInConversation({ text });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const traceEbitda = (passage: string): Call => ({
  tool: "trace_formulas",
  input: { passage, cell: "DCF!E5", label: "EBITDA 2027" },
});
const growthAt3 = (passage: string): Call => ({
  tool: "what_if",
  input: {
    passage,
    cell: "DCF!E5",
    label: "EBITDA 2027 at 3% growth",
    input: "Growth",
    value: "3%",
  },
});

describe("a workbook's formulas in an Answer", () => {
  test.each([
    ["en", "What drives 2027 EBITDA, and what if growth is 3%?"],
    ["zh-CN", "2027 年的 EBITDA 由什么驱动？如果增长率是 3% 会怎样？"],
  ])(
    "%s: the figure's chain is cited to its cells, and the what-if names its input and leaves the file as it was",
    async (language, question) => {
      const model = modelling({
        query: "EBITDA revenue growth",
        calls: [traceEbitda, growthAt3],
        answer: "2027 EBITDA is [=1]; at 3% growth it would be [=2].",
      });
      const { core, file } = await setUp(model, "dcf.xlsx", libreOfficeFixture("dcf"));
      const before = await sha256(file);
      const answer = await ask(core, question);

      const [traced, changed] = answer.figures;
      expect(traced).toMatchObject({
        value: 254.6775,
        shown: "254.7",
        formula: "",
        show: { language },
        workbook: {
          cell: { sheet: "DCF", ref: "E5", formula: "E4*Margin", label: "EBITDA 2027" },
          change: null,
          kept: [],
        },
      });
      expect(traced?.workbook?.saved).toBeCloseTo(254.6775, 9);
      expect(
        traced?.workbook?.steps.map((step) => `${step.sheet}!${step.ref} = ${step.formula}`),
      ).toEqual([
        "DCF!E4 = D4*(1+Growth)",
        "DCF!D4 = C4*(1+Growth)",
        "DCF!C4 = B4*(1+Growth)",
        "DCF!B4 = Assumptions!B3",
      ]);
      const growth = traced?.inputs.find((input) => input.cell?.ref === "B4");
      expect(growth).toMatchObject({
        label: "Revenue growth (Growth)",
        number: { chars: "5.0%", value: 0.05, unit: { kind: "percent" } },
        cell: { sheet: "Assumptions", ref: "B4", stored: 0.05 },
        citation: {
          check: "found",
          location: { kind: "rows", sheet: "Assumptions", from: 4, to: 4 },
        },
      });
      expect(growth?.citation.quote.slice(growth.number.at)).toMatch(/^5\.0%/);

      expect(changed?.value).toBeCloseTo(240.39994, 9);
      expect(changed).toMatchObject({
        shown: "240.4",
        workbook: {
          change: { input: growth?.name, value: 0.03, shown: "3.0%" },
          kept: [],
        },
      });
      expect(changed?.workbook?.saved).toBeCloseTo(254.6775, 9);
      expect(changed?.workbook?.savedShown).toBe("254.7");
      expect(changed?.label).toContain("3.0%");
      // Each figure is cited to its cell, so the Answer is never called uncited.
      expect(answer.steps?.notCitedAfterAsking).toBeUndefined();
      expect(answer.citations.map((citation) => citation.quote)).toContain(
        traced?.workbook?.cell.input.citation.quote,
      );
      expect(traced?.workbook?.cell.input).toMatchObject({
        number: { chars: "254.7" },
        cell: { sheet: "DCF", ref: "E5" },
        citation: { check: "found", location: { kind: "rows", sheet: "DCF", from: 5, to: 5 } },
      });
      expect(told(model, "what_if")).toContain("the User's file is unchanged");
      expect(await sha256(file)).toBe(before);

      const node = calculatedFigureNode(changed as NonNullable<typeof changed>, "figure-1");
      expect(readCalculatedFigure(JSON.parse(JSON.stringify(node.attrs?.figure)))).toEqual(
        expect.objectContaining({ workbook: changed?.workbook }),
      );
    },
  );

  test("the viewer gets a workbook's text without the formulas and saved values only the core reads", async () => {
    const model = modelling({ query: "EBITDA", calls: [], answer: "Answered." });
    const { core, document } = await setUp(model, "dcf.xlsx", libreOfficeFixture("dcf"));
    if (!document) throw new Error("The workbook wasn't added.");
    const labels = (await core.readDocumentText(document.id)).pages.map((page) => page.label);
    expect(labels.map((label) => label?.sheet)).toContain("DCF");
    expect(labels.filter((label) => label?.formulas || label?.saved || label?.workbook)).toEqual(
      [],
    );
  });

  test("a what-if over a volatile formula is refused, named; the figure traced keeps its saved value, marked", async () => {
    const model = modelling({
      query: "Volatile Today Offset",
      calls: [
        (passage) => ({
          tool: "what_if",
          input: { passage, cell: "Cases!D2", label: "Figure", input: "Cases!B2", value: "20" },
        }),
        (passage) => ({
          tool: "trace_formulas",
          input: { passage, cell: "Cases!D2", label: "Figure" },
        }),
      ],
      answer: "The figure is [=1].",
    });
    const { core } = await setUp(model, "cases.xlsx", new Uint8Array(unsupportedWorkbook().xlsx()));
    const answer = await ask(core, "What is the figure, and what if the input were 20?");
    expect(told(model, "what_if")).toContain(
      "Nothing was recorded: Volatile Figure (Cases!D2) depends on cells that keep the values the workbook saved",
    );
    expect(told(model, "what_if")).toContain("uses RAND, which gives a new value each time");
    expect(answer.figures).toEqual([
      expect.objectContaining({
        value: 5.2,
        workbook: expect.objectContaining({
          change: null,
          kept: [{ sheet: "Cases", ref: "C2", reason: "volatile", name: "RAND" }],
        }),
      }),
    ]);
  });

  test("a percent given for a cell that shows none is refused, listing the figure's inputs; the input meant works", async () => {
    const model = modelling({
      query: "EBITDA revenue growth",
      calls: [
        (passage) => ({
          tool: "what_if",
          input: {
            passage,
            quote: "EBITDA\t231.0\t242.6\t254.7\t267.4\t280.8",
            number: "254.7",
            label: "EBITDA 2027 at 3% growth",
            input: "Assumptions!B3",
            value: "3%",
          },
        }),
        (passage) => ({
          tool: "what_if",
          input: {
            passage,
            quote: "EBITDA\t231.0\t242.6\t254.7\t267.4\t280.8",
            number: "254.7",
            label: "EBITDA 2027 at 3% growth",
            input: "Assumptions!B4",
            value: "3%",
          },
        }),
      ],
      answer: "At 3% growth, 2027 EBITDA would be [=1].",
    });
    const { core } = await setUp(model, "dcf.xlsx", libreOfficeFixture("dcf"));
    const answer = await ask(core, "What would 2027 EBITDA be at 3% growth?");
    const results = told(model, "what_if");
    expect(results).toContain(
      "Nothing was recorded: Assumptions!B3 (Revenue 2024) shows 1,000.0, not a percent",
    );
    expect(results).toContain("Assumptions!B4 Revenue growth 5.0%");
    expect(answer.figures).toHaveLength(1);
    expect(answer.figures[0]?.value).toBeCloseTo(240.39994, 9);
    expect(answer.figures[0]?.workbook?.change).toMatchObject({ value: 0.03, shown: "3.0%" });
  });

  test.each([
    [
      "a CSV file alone",
      "sales.csv",
      new TextEncoder().encode("Region,Revenue\nNorth,120\n"),
      false,
    ],
    ["a workbook", "dcf.xlsx", libreOfficeFixture("dcf"), true],
  ])(
    "%s: the workbook's Tools and their steer are offered only with a workbook",
    async (_name, file, contents, offered) => {
      const model = scriptedModel(() => ({ text: "Done." }));
      const { core } = await setUp(model, file, contents);
      await ask(core, "What is in the sheet?");
      const call = model.doStreamCalls[0];
      const names = (call?.tools ?? []).map((tool) => tool.name);
      expect(names).toContain("search_documents");
      expect(names.includes("trace_formulas")).toBe(offered);
      expect(names.includes("what_if")).toBe(offered);
      const system = JSON.stringify(call?.prompt[0] ?? "");
      expect(system.includes("call trace_formulas")).toBe(offered);
    },
  );

  test.each([
    ["kept as the User's own workings", true, 0],
    ["cited as usual", false, 1],
  ])(
    "a workbook %s: figures are recorded from it only when it may be cited",
    async (_name, ownWorkings, recorded) => {
      const model = modelling({
        query: "EBITDA revenue growth",
        calls: [traceEbitda],
        answer: "2027 EBITDA is [=1].",
      });
      const { core } = await setUp(model, "dcf.xlsx", libreOfficeFixture("dcf"), ownWorkings);
      const answer = await ask(core, "What drives 2027 EBITDA?");
      expect(answer.figures).toHaveLength(recorded);
      // An own working's Passages are read but never offered to name, so the trace can't record one.
      expect(told(model, "trace_formulas").startsWith("Nothing was recorded")).toBe(ownWorkings);
    },
  );

  test("a new value with a decimal comma is refused, not read ten times larger; a decimal point works", async () => {
    const whatIfAt =
      (value: string) =>
      (passage: string): Call => ({
        tool: "what_if",
        input: { passage, cell: "DCF!E5", label: "EBITDA 2027", input: "Assumptions!B3", value },
      });
    const model = modelling({
      query: "EBITDA revenue growth",
      calls: [whatIfAt("1,5"), whatIfAt("1.5")],
      answer: "It would be [=1].",
    });
    const { core } = await setUp(model, "dcf.xlsx", libreOfficeFixture("dcf"));
    const answer = await ask(core, "What would 2027 EBITDA be if 2024 revenue were 1.5?");
    expect(told(model, "what_if")).toContain('"1,5" can be read more than one way');
    expect(answer.figures).toHaveLength(1);
    expect(answer.figures[0]?.workbook?.change).toMatchObject({ value: 1.5 });
  });
});
