import { expect, test } from "vitest";
import { writeVtt } from "../../src/core/documents/formats/vtt";
import {
  askAndFinish,
  citationsIn,
  citeFeedback,
  citingModel,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { isAnswer, messagesOf, QWEN35, setUpLocalModel } from "../helpers/localModels";
import { scriptedModel } from "../helpers/models";
import { startOllamaServer } from "../helpers/ollama";

for (const language of ["en", "zh-CN"] as const) {
  const repeated = language === "en" ? "We agreed to review the plan." : "我们同意重新审阅计划。";
  const boat = language === "en" ? "The boat arrives on Monday." : "船将在星期一到达。";
  const estimate = language === "en" ? "The estimate is forty hours." : "预计需要四十个小时。";
  const absent = language === "en" ? "The quote was never spoken." : "转写稿中没有这句话。";
  const first = language === "en" ? "Alex" : "王芳";
  const second = language === "en" ? "Dana" : "李明";
  const file = {
    name: "Review.vtt",
    contents: writeVtt({
      cues: [
        { startMs: 0, endMs: 2000, text: repeated, speaker: first },
        { startMs: 4000, endMs: 6000, text: boat, speaker: first },
        { startMs: 7000, endMs: 10_000, text: repeated, speaker: second },
        { startMs: 11_750, endMs: 13_000, text: estimate, speaker: second },
      ],
      gaps: [],
    }),
  };
  const answer = language === "en" ? "The plan was reviewed[^1]." : "计划已经审阅[^1]。";
  const ask = async (model: Parameters<typeof setUpWithDocuments>[0]) => {
    const setup = await setUpWithDocuments(model, [file]);
    await setup.core.updateSettings({ user: { language } });
    const { answerId, finished } = await askAndFinish(
      setup.core,
      setup.client,
      setup.mind.id,
      language === "en" ? "What was said in the review?" : "审阅时说了什么？",
    );
    return { citations: citationsIn(setup.client, answerId), finished };
  };

  test(`unique Transcript quotes keep their cue time and stored speaker, ${language}`, async () => {
    const { citations } = await ask(
      citingModel({
        query: "Review",
        records: (passages) => [
          { marker: 1, passage: passages[0]?.id, quote: boat },
          { marker: 2, passage: passages[0]?.id, location: "0:11", quote: estimate },
        ],
        answer: `${answer} ${language === "en" ? "The estimate was given" : "已给出预计时间"}[^2].`,
      }),
    );
    expect(citations).toMatchObject([
      {
        quote: boat,
        check: "found",
        pageFrom: 1,
        pageTo: 1,
        location: { kind: "time", from: 4000, to: 6000, speaker: first },
      },
      {
        quote: estimate,
        check: "found",
        pageFrom: 1,
        pageTo: 1,
        location: { kind: "time", from: 11_750, to: 13_000, speaker: second },
      },
    ]);
  });

  test.each([undefined, "0:00–0:10"])(
    `repeated Transcript quotes never silently choose the first cue with %s, ${language}`,
    async (location) => {
      const model = citingModel({
        query: "Review",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, location, quote: repeated }],
        answer,
      });
      const { citations, finished } = await ask(model);
      expect(citations).toEqual([]);
      expect(finished.rejectedRecords).toMatchObject([{ marker: 1, reason: "quote-context" }]);
      expect(citeFeedback(model)).toContain("quote enough surrounding words to identify one place");
    },
  );

  test.each(["0:07", "0:08", "0:07–0:10"])(
    `an explicit Transcript time %s selects the second cue within one Unit, ${language}`,
    async (location) => {
      const model = citingModel({
        query: "Review",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, location, quote: repeated }],
        answer,
      });
      const { citations } = await ask(model);
      expect(citations).toMatchObject([
        {
          quote: repeated,
          check: "found",
          pageFrom: 1,
          pageTo: 1,
          location: { kind: "time", from: 7000, to: 10_000, speaker: second },
        },
      ]);
      expect(citations).toHaveLength(1);
      expect(citeFeedback(model)).not.toContain("Fix these");
    },
  );

  test.each(["0:07", "0:03", "9:59", "0:99", "later", "p. 1"])(
    `a Transcript quote cannot be found elsewhere when its selected time is %s, ${language}`,
    async (location) => {
      const { citations } = await ask(
        citingModel({
          query: "Review",
          records: (passages) => [{ marker: 1, passage: passages[0]?.id, location, quote: boat }],
          answer,
        }),
      );
      expect(citations).toHaveLength(1);
      expect(citations[0]?.check).toBe("not-found");
      expect(citations[0]?.location).not.toMatchObject({ from: 4000, speaker: first });
    },
  );

  test(`a Transcript time range can quote consecutive cues without losing their anchors, ${language}`, async () => {
    const { citations } = await ask(
      citingModel({
        query: "Review",
        records: (passages) => [
          {
            marker: 1,
            passage: passages[0]?.id,
            location: "0:07–0:13",
            quote: `${repeated}\n${estimate}`,
          },
        ],
        answer,
      }),
    );
    expect(citations).toMatchObject([
      {
        check: "found",
        location: { kind: "time", from: 7000, to: 13_000, speaker: second },
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test(`words quoted in an Answer must occur in its selected Transcript cues, ${language}`, async () => {
    const { citations } = await ask(
      citingModel({
        query: "Review",
        records: (passages) => [
          { marker: 1, passage: passages[0]?.id, location: "0:07", quote: repeated },
        ],
        answer: `“${boat.replace(/[.。]$/u, "")}”[^1]${language === "en" ? "." : "。"}`,
      }),
    );
    expect(citations).toMatchObject([
      {
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
        location: { kind: "time", from: 7000, to: 10_000, speaker: second },
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test(`an ambiguity repair can select the second Transcript cue, ${language}`, async () => {
    let repairs = 0;
    const model = scriptedModel(
      (call) => {
        const search = call.results.find((result) => result.tool === "search_documents");
        if (!search) return { calls: [{ tool: "search_documents", input: { query: "Review" } }] };
        const cited = call.results.filter((result) => result.tool === "cite");
        const passage = shownPassages(search.text)[0]?.id;
        if (cited.length === 0)
          return {
            calls: [
              { tool: "cite", input: { citations: [{ marker: 1, passage, quote: repeated }] } },
            ],
          };
        if (cited.length === 1 && cited[0]?.text.includes("quote enough surrounding words")) {
          repairs++;
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage, location: "0:07", quote: repeated }] },
              },
            ],
          };
        }
        return { text: answer };
      },
      { judgesItsAnswers: true },
    );
    const { citations } = await ask(model);
    expect(repairs).toBe(1);
    expect(citations).toMatchObject([
      { check: "found", location: { kind: "time", from: 7000, to: 10_000, speaker: second } },
    ]);
    expect(citations).toHaveLength(1);
  });

  test(`a failed Transcript quote replacement cannot succeed in a different cue, ${language}`, async () => {
    const ollama = await startOllamaServer({
      models: [QWEN35],
      reply: (body) => {
        if (isAnswer(body)) {
          return {
            content: JSON.stringify({
              answer,
              citations: [{ marker: 1, passage: "P1", location: "0:07", quote: absent }],
            }),
          };
        }
        const retry = messagesOf(body).some(
          (message) =>
            message.role === "system" && message.content.startsWith("You fix the quotes"),
        );
        return {
          content: JSON.stringify(retry ? { quotes: [{ marker: 1, quote: boat }] } : { tags: [] }),
        };
      },
    });
    const { core, client, mind } = await setUpLocalModel(ollama, QWEN35.name, {
      documents: [file],
    });
    await core.updateSettings({ user: { language } });
    const { answerId, finished } = await askAndFinish(core, client, mind.id, "Review");
    expect(finished.quoteRetry).toMatchObject({ records: 1, recovered: 0 });
    expect(citationsIn(client, answerId)).toMatchObject([{ quote: absent, check: "not-found" }]);
  });
}
