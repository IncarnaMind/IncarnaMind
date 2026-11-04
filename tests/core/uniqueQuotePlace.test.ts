import { expect, test } from "vitest";
import { locateQuote } from "../../src/core/answers/citations";
import { checkReply, isCheckRun } from "../helpers/checks";
import {
  answerEnded,
  citeFeedback,
  citingModel,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { scriptedModel } from "../helpers/models";
import { docxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { para, pptxOf, sp } from "../helpers/pptx";

for (const language of ["en", "zh-CN"] as const) {
  const row = language === "en" ? "Control weights 0.050 2 0.100" : "控制砝码 0.050 2 0.100";
  const before = language === "en" ? "Revision A SUPERSEDED" : "修订 A 已被替代";
  const current = language === "en" ? "Revision B CURRENT" : "修订 B 当前有效";
  const lines = [before, row, current, row];
  const files = [
    {
      name: "Revisions.pdf",
      contents: buildPdf([language === "en" ? { lines } : { chineseLines: lines }]),
    },
    { name: "Revisions.md", contents: `# Revisions\n\n${lines.join("\n\n")}` },
    { name: "Revisions.txt", contents: lines.join("\n") },
    {
      name: "Revisions.vtt",
      contents: `WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n${lines.join("\n")}\n`,
    },
    {
      name: "Revisions.pptx",
      contents: pptxOf({
        slides: [
          {
            shapes: sp({
              body: `<a:bodyPr/><a:lstStyle/>${lines.map((line) => para(line)).join("")}`,
            }),
          },
        ],
      }),
    },
    {
      name: "Revisions-spread.pdf",
      contents: buildPdf(
        language === "en"
          ? [{ lines: lines.slice(0, 2) }, { lines: lines.slice(2) }]
          : [{ chineseLines: lines.slice(0, 2) }, { chineseLines: lines.slice(2) }],
      ),
    },
    {
      name: "Revisions.docx",
      contents: docxOf([{ text: "Revisions", heading: 1 }, ...lines.map((text) => ({ text }))]),
    },
  ];
  for (const file of files) {
    test(`a repeated labelled row needs a unique quote in ${file.name}, ${language}`, async () => {
      const model = citingModel({
        query: "Revisions",
        records: (p) => [{ marker: 1, passage: p[0]?.id, quote: row }],
        answer: "The current row[^1].",
      });
      const { core } = await setUpWithDocuments(model, [file]);
      const asked = await core.askInConversation({ text: "Quote the current row." });
      if (!asked.asked) throw new Error("Question not asked");
      const ended = await answerEnded(core, asked.answerId);
      expect(ended).toMatchObject({
        event: "finished",
        payload: { rejectedRecords: [{ marker: 1, reason: "quote-context" }] },
      });
      const answer = (await core.getConversation(asked.conversation.id)).messages.find(
        (m) => m.id === asked.answerId,
      );
      if (answer?.kind !== "answer") throw new Error("No Answer");
      expect(answer.citations).toEqual([]);
    });
  }
  test(`one ambiguity request lets the model give a uniquely placed quote, ${language}`, async () => {
    let repairs = 0;
    const model = scriptedModel((call) => {
      if (isCheckRun(call)) return checkReply(call, {});
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "Revisions" } }] };
      const cited = call.results.filter((result) => result.tool === "cite");
      const passage = shownPassages(search.text)[0]?.id;
      if (cited.length === 0)
        return {
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: row }] } }],
        };
      if (
        cited.length === 1 &&
        cited[0]?.text.includes("quote enough surrounding words to identify one place")
      ) {
        repairs++;
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage, quote: `${current}\n${row}` }] },
            },
          ],
        };
      }
      return { text: "The current row[^1]." };
    });
    const { core } = await setUpWithDocuments(model, [
      { name: "Revisions.md", contents: `# Revisions\n\n${lines.join("\n\n")}` },
    ]);
    const asked = await core.askInConversation({ text: "Quote the current row." });
    if (!asked.asked) throw new Error("Question not asked");
    await answerEnded(core, asked.answerId);
    const answer = (await core.getConversation(asked.conversation.id)).messages.find(
      (m) => m.id === asked.answerId,
    );
    if (answer?.kind !== "answer") throw new Error("No Answer");
    expect(repairs).toBe(1);
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]?.quote).toBe(`${current}\n${row}`);
  });
  test(`an explicit Unit keeps its place when the same quote is elsewhere, ${language}`, async () => {
    const model = citingModel({
      query: "Revisions",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id, location: "p. 2", quote: row },
      ],
      answer: "The current row[^1].",
    });
    const file = files.find((file) => file.name === "Revisions-spread.pdf");
    if (!file) throw new Error("No two-page fixture");
    const { core } = await setUpWithDocuments(model, [file]);
    const asked = await core.askInConversation({ text: "Quote the current row." });
    if (!asked.asked) throw new Error("Question not asked");
    await answerEnded(core, asked.answerId);
    const answer = (await core.getConversation(asked.conversation.id)).messages.find(
      (m) => m.id === asked.answerId,
    );
    if (answer?.kind !== "answer") throw new Error("No Answer");
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]).toMatchObject({ quote: row, pageFrom: 2, pageTo: 2 });
  });
  test(`a wrong page places only a unique quote through the public Core, ${language}`, async () => {
    const other = language === "en" ? "Revision C CURRENT" : "修订 C 当前有效";
    const invented =
      language === "en" ? "This sentence is not in the Document." : "这句话不在文档中。";
    const file = {
      name: "Revisions-misplaced.pdf",
      contents: buildPdf([
        language === "en" ? { lines: [before] } : { chineseLines: [before] },
        language === "en"
          ? { lines: [current, row, other, row] }
          : { chineseLines: [current, row, other, row] },
      ]),
    };
    const ask = async (quote: string) => {
      const model = citingModel({
        query: "Revisions",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, location: "p. 1", quote }],
        answer: "The current row[^1].",
      });
      const { core } = await setUpWithDocuments(model, [file]);
      const asked = await core.askInConversation({ text: "Quote the current row." });
      if (!asked.asked) throw new Error("Question not asked");
      const ended = await answerEnded(core, asked.answerId);
      if (ended.event !== "finished") throw new Error("The Answer failed");
      const answer = (await core.getConversation(asked.conversation.id)).messages.find(
        (message) => message.id === asked.answerId,
      );
      if (answer?.kind !== "answer") throw new Error("No Answer");
      return { answer, ended, model };
    };

    const unique = await ask(`${current}\n${row}`);
    expect(unique.ended.payload.citations).toHaveLength(1);
    expect(unique.ended.payload.citations[0]).toMatchObject({
      check: "found",
      pageFrom: 2,
      pageTo: 2,
      quote: `${current}\n${row}`,
    });
    expect(citeFeedback(unique.model)).not.toContain("copy it exactly");

    const ambiguous = await ask(row);
    expect(ambiguous.ended.payload.rejectedRecords).toMatchObject([
      { marker: 1, reason: "quote-context" },
    ]);
    expect(ambiguous.answer.citations).toEqual([]);
    expect(citeFeedback(ambiguous.model)).toContain(
      "quote enough surrounding words to identify one place",
    );

    const absent = await ask(invented);
    expect(absent.ended.payload.citations).toHaveLength(1);
    expect(absent.ended.payload.citations[0]).toMatchObject({ check: "not-found", pageFrom: 1 });
    expect(citeFeedback(absent.model)).toContain("copy it exactly");
  });
  test(`locating a repeated quote never chooses the first Unit, ${language}`, () => {
    expect(
      locateQuote(
        [
          { page: 1, text: row },
          { page: 2, text: row },
        ],
        row,
      ),
    ).toBeNull();
    expect(locateQuote([{ page: 1, text: lines.join("\n") }], row)).toBeNull();
    expect(locateQuote([{ page: 1, text: lines.join("\n") }], `${current}\n${row}`)).toEqual({
      pageFrom: 1,
      pageTo: 1,
    });
  });
  test(`a recheck stays at the stored page when the quote is elsewhere, ${language}`, async () => {
    const file = {
      name: "Stored.pdf",
      contents: buildPdf([
        language === "en" ? { lines: [row] } : { chineseLines: [row] },
        { lines: ["A different page."] },
      ]),
    };
    const { core, documents } = await setUpWithDocuments(
      citingModel({ query: "Revisions", records: () => [], answer: "No citation." }),
      [file],
    );
    const doc = documents[0];
    if (!doc) throw new Error("No Document");
    const result = await core.recheckCitation({
      mindId: null,
      documentId: doc.id,
      contentHash: doc.contentHash,
      quote: row,
      pageFrom: 2,
      pageTo: 2,
    });
    expect(result).toMatchObject({ check: "not-found", pageFrom: 2, pageTo: 2 });
    const whole = await core.recheckCitation({
      mindId: null,
      documentId: doc.id,
      contentHash: doc.contentHash,
      quote: row,
      pageFrom: null,
      pageTo: null,
    });
    expect(whole).toMatchObject({ check: "found", pageFrom: null, pageTo: null, location: null });
  });
}

for (const passage of ["1", "P1 (p. 1)"]) {
  test(`a structured calculation keeps main's Passage naming: ${passage}`, async () => {
    const model = scriptedModel((call) =>
      call.tools.length > 0
        ? { error: { status: 400, message: "This model does not support tools" } }
        : {
            text: JSON.stringify({
              answer: "The amount is [=1].",
              citations: [],
              calculations: [
                {
                  marker: 1,
                  label: "Revenue",
                  formula: "r",
                  inputs: [
                    { name: "r", passage, location: "p. 1", quote: "Revenue 120", number: "120" },
                  ],
                },
              ],
            }),
          },
    );
    const { core } = await setUpWithDocuments(model, [
      { name: "Revenue.pdf", contents: buildPdf([{ lines: ["Revenue 120"] }]) },
    ]);
    await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-test",
    });
    core.on("consent.requested", (r) => void core.respondToConsent(r.requestId, true));
    const asked = await core.askInConversation({ text: "Give the revenue amount." });
    if (!asked.asked) throw new Error("Question not asked");
    await answerEnded(core, asked.answerId);
    const answer = (await core.getConversation(asked.conversation.id)).messages.find(
      (m) => m.id === asked.answerId,
    );
    if (answer?.kind !== "answer") throw new Error("No Answer");
    expect(answer.figures).toHaveLength(1);
    expect(answer.figures[0]?.value).toBe(120);
  });
}
