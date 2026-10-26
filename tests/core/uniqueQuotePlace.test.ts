import { expect, test } from "vitest";
import { locateQuote } from "../../src/core/answers/citations";
import { answerEnded, citingModel, setUpWithDocuments } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";
import { docxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

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
      documentId: doc.id,
      contentHash: doc.contentHash,
      quote: row,
      pageFrom: 2,
      pageTo: 2,
    });
    expect(result).toMatchObject({ check: "not-found", pageFrom: 2, pageTo: 2 });
    const whole = await core.recheckCitation({
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
