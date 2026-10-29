import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { ConversationAnswer } from "../../src/core";
import { answerBlocks } from "../../src/shared/answerBlocks";
import { answerEnded, citingModel, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const CURRENT_BEADS = "Glass beads 0.075 2 0.150";
const CURRENT_WEIGHTS = "Control weights 0.050 2 0.100";
const OLD_WEIGHTS = "Control weights 0.050 3 0.150";
const worksheet = await readFile(new URL("../fixtures/revision-control/text.pdf", import.meta.url));

async function calculate(
  quote: string,
  location: string,
  number: string,
  recorded = false,
  contents: Uint8Array = worksheet,
) {
  const model = scriptedModel((call) => {
    const search = call.results.find((r) => r.tool === "search_documents");
    if (!search)
      return { calls: [{ tool: "search_documents", input: { query: "revision load worksheet" } }] };
    if (!call.results.some((r) => r.tool === "calculate")) {
      const passage = shownPassages(search.text).find((p) => p.text.includes(quote));
      if (!passage) throw new Error("The worksheet Passage was not shown");
      if (recorded && !call.results.some((r) => r.tool === "cite")) {
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, location, quote }] },
            },
          ],
        };
      }
      return {
        calls: [
          {
            tool: "calculate",
            input: {
              figures: [
                {
                  marker: 1,
                  label: "Worksheet input",
                  formula: "input",
                  inputs: [
                    {
                      name: "input",
                      label: "Worksheet input",
                      ...(recorded ? { citation: 1 } : { passage: passage.id, location, quote }),
                      number,
                    },
                  ],
                },
              ],
            },
          },
        ],
      };
    }
    return { text: "The worksheet input is [=1]." };
  });
  const { core } = await setUpWithDocuments(model, [{ name: "Revision control.pdf", contents }]);
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    modelId: "claude-haiku-5-5",
    apiKey: "sk-test",
  });
  if (provider.service) await core.allowDataFlow("chat", provider.service.id);
  const asked = await core.askInConversation({ text: "Read the worksheet input." });
  if (!asked.asked) throw new Error("The Question was not asked");
  await answerEnded(core, asked.answerId);
  const conversation = await core.getConversation(asked.conversation.id);
  const answer = conversation.messages.find((m) => m.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer");
  return answer;
}

describe("Worksheet input provenance", () => {
  for (const [language, quote] of [
    ["en", "0.075, 2, 0.150"],
    ["en", "0.075; 2; 0.150"],
    ["zh-CN", "0.075，2，0.150"],
    ["zh-CN", "0.075；2；0.150"],
  ] as const) {
    const row = `${language === "en" ? "Glass beads" : "玻璃珠"} ${quote}`;
    const contents = buildPdf([
      language === "en"
        ? { lines: ["Rev B CURRENT 2026-10-23", row] }
        : { chineseLines: ["修订 B 当前有效 2026-10-23", row] },
    ]);
    for (const recorded of [false, true]) {
      test(`keeps the unique punctuation-separated ${recorded ? "recorded" : "direct"} row ${quote}, ${language}`, async () => {
        const answer = await calculate(quote, "p. 1", "0.075", recorded, contents);
        expect(answer.figures).toHaveLength(1);
        expect(answer.figures[0]?.inputs[0]?.citation.pageFrom).toBe(1);
      });
      test(`keeps the labelled punctuation-separated ${recorded ? "recorded" : "direct"} row ${quote}, ${language}`, async () => {
        const answer = await calculate(row, "p. 1", "0.075", recorded, contents);
        expect(answer.figures).toHaveLength(1);
        expect(answer.figures[0]?.inputs[0]?.citation.quote).toBe(row);
      });
    }
  }

  test.each([false, true])(
    "keeps a complete single-value source at its supplied page, recorded=%s",
    async (recorded) => {
      const answer = await calculate(
        "0.150",
        "p. 1",
        "0.150",
        recorded,
        buildPdf([{ lines: ["0.150"] }]),
      );
      expect(answer.figures).toHaveLength(1);
      expect(answer.figures[0]?.inputs[0]?.citation.pageFrom).toBe(1);
    },
  );

  for (const recorded of [false, true]) {
    test.each([
      ["2", "p. 2", "2"],
      ["0.150", "pp. 1-2", "0.150"],
      ["0.250", "pp. 1-2", "0.250"],
    ])(
      `refuses the context-free ${recorded ? "recorded" : "direct"} quote %s at %s`,
      async (quote, location, number) => {
        const answer = await calculate(quote, location, number, recorded);
        expect(answer.figures).toEqual([]);
        expect(JSON.stringify(answerBlocks(answer))).not.toContain("[=1]");
      },
    );
  }

  test("does not move a direct current row from the superseded page", async () => {
    const answer = await calculate(CURRENT_BEADS, "p. 1", "0.075");
    expect(answer.figures).toEqual([]);
  });

  test("places a recorded current row at its unique quote", async () => {
    const answer = await calculate(CURRENT_BEADS, "p. 1", "0.075", true);
    expect(answer.figures).toMatchObject([
      { value: 0.075, inputs: [{ citation: { pageFrom: 2, pageTo: 2, check: "found" } }] },
    ]);
  });

  test.each([
    [CURRENT_BEADS, "p. 2", "0.075", 0.075, 2],
    [CURRENT_WEIGHTS, "p. 2", "0.050", 0.05, 2],
    [OLD_WEIGHTS, "p. 1", "0.150", 0.15, 1],
  ])(
    "keeps the labelled row %s at its given page",
    async (quote, location, number, value, page) => {
      const answer: ConversationAnswer = await calculate(quote, location, number);
      expect(answer.figures).toMatchObject([
        { value, inputs: [{ citation: { quote, pageFrom: page, pageTo: page, check: "found" } }] },
      ]);
    },
  );
});

describe("Numerical Citation place", () => {
  test.each(["2", "0.250"])(
    "asks for a unique place for a repeated numeric Citation of %s without changing quote presence",
    async (quote) => {
      const model = citingModel({
        query: "current worksheet",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, location: "p. 2", quote }],
        answer: "The current worksheet gives this value[^1].",
      });
      const { core, documents } = await setUpWithDocuments(model, [
        { name: "Revision control.pdf", contents: worksheet },
      ]);
      const asked = await core.askInConversation({ text: "Read the current worksheet." });
      if (!asked.asked) throw new Error("The Question was not asked");
      const ended = await answerEnded(core, asked.answerId);
      expect(ended).toMatchObject({
        event: "finished",
        payload: { rejectedRecords: [{ marker: 1, reason: "quote-context" }] },
      });
      const conversation = await core.getConversation(asked.conversation.id);
      const answer = conversation.messages.find((message) => message.id === asked.answerId);
      if (answer?.kind !== "answer") throw new Error("No Answer");
      expect(answer.citations).toEqual([]);
      const document = documents[0];
      if (!document) throw new Error("No Document");
      expect(
        await core.recheckCitation({
          documentId: document.id,
          contentHash: document.contentHash,
          pageFrom: 2,
          pageTo: 2,
          quote,
        }),
      ).toMatchObject({ check: "found" });
    },
  );
});
