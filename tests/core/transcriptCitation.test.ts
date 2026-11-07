import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { recheckKept } from "../../src/core/answers/citations";
import { readVtt, transcriptUnits, writeVtt } from "../../src/core/documents/formats/vtt";
import {
  askAndFinish,
  checkedResult,
  citationsIn,
  citeFeedback,
  citingModel,
  mindCitations,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { sha256, waitForDocuments, waitForProcessing } from "../helpers/documents";
import { isAnswer, messagesOf, QWEN35, setUpLocalModel } from "../helpers/localModels";
import { connectToMind } from "../helpers/mindClient";
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
    return { ...setup, citations: citationsIn(setup.client, answerId), finished };
  };
  const selectSecond = () =>
    ask(
      citingModel({
        query: "Review",
        records: (passages) => [
          { marker: 1, passage: passages[0]?.id, location: "0:07", quote: repeated },
        ],
        answer,
      }),
    );

  test.each([false, true])(
    `an unchanged Transcript recheck preserves the selected second cue with whole=%s, ${language}`,
    async (whole) => {
      const { core, citations } = await selectSecond();
      const citation = citations[0];
      if (!citation?.documentId) throw new Error("No Citation");
      const checked = checkedResult(
        await core.recheckCitation({
          ...citation,
          documentId: citation.documentId,
          quote: repeated,
          mindId: null,
          pageFrom: whole ? null : citation.pageFrom,
          pageTo: whole ? null : citation.pageTo,
        }),
      );
      expect(checked).toMatchObject({
        check: "found",
        location: { kind: "time", from: 7000, to: 10_000, speaker: second },
      });
      expect(checked.contentHash).toBe(citation.contentHash);
    },
  );

  test(`a Transcript recheck without a stored Location preserves legacy behavior, ${language}`, async () => {
    const { core, citations } = await selectSecond();
    const citation = citations[0];
    if (!citation?.documentId) throw new Error("No Citation");
    const { location: _location, ...legacy } = citation;
    expect(
      checkedResult(
        await core.recheckCitation({
          ...legacy,
          documentId: citation.documentId,
          quote: repeated,
          mindId: null,
        }),
      ),
    ).toMatchObject({
      check: "found",
      location: { kind: "time", from: 0, to: 2000, speaker: first },
    });
  });

  test(`copying a Transcript Citation into other Notes preserves its occurrence, ${language}`, async () => {
    const { core, citations } = await selectSecond();
    let citation = citations[0];
    if (!citation) throw new Error("No Citation");
    for (let copy = 0; copy < 2; copy++) {
      const note = await core.createMind({ title: "Review copy" });
      await core.addToNote({
        mindId: note.id,
        origin: null,
        model: null,
        blocks: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: answer.replace("[^1]", "") },
              { type: "citation", attrs: citation },
            ],
          },
        ],
      });
      const copied = mindCitations(await connectToMind(core, note.id));
      expect(copied).toHaveLength(1);
      expect(copied[0]).toMatchObject({
        quote: repeated,
        check: "found",
        contentHash: citation.contentHash,
        location: { kind: "time", from: 7000, to: 10_000, speaker: second },
      });
      citation = copied[0];
      if (!citation) throw new Error("No copied Citation");
    }
  });

  test.each(["wrong cue", "wrong speaker", "wrong bounds"])(
    `a Transcript recheck with the %s never chooses another occurrence, ${language}`,
    async (wrong) => {
      const { core, citations } = await selectSecond();
      const citation = citations[0];
      if (!citation?.documentId) throw new Error("No Citation");
      const location = {
        kind: "time" as const,
        from: wrong === "wrong cue" ? 4000 : 7000,
        to: wrong === "wrong cue" ? 6000 : wrong === "wrong bounds" ? 13_000 : 10_000,
        speaker: wrong === "wrong bounds" ? second : first,
      };
      expect(
        checkedResult(
          await core.recheckCitation({
            ...citation,
            documentId: citation.documentId,
            quote: repeated,
            mindId: null,
            location,
          }),
        ),
      ).toMatchObject({
        check: "not-found",
        checkReason: "quote-not-on-pages",
        location,
      });
    },
  );

  test(`a Citation kept by an edit is rechecked at its stored Transcript occurrence, ${language}`, async () => {
    const { citations } = await selectSecond();
    const citation = citations[0];
    if (!citation) throw new Error("No Citation");
    const units = transcriptUnits(readVtt(file.contents));
    const documents = {
      currentVersion: () => citation.contentHash,
      documentName: () => citation.documentName,
      pageTexts: () => units,
      passagesCovering: () => [
        { id: citation.passageId ?? "review", text: units.map((unit) => unit.text).join("\n") },
      ],
    };
    expect(recheckKept(documents, { ...citation, check: "not-found" }, null)).toMatchObject({
      check: "found",
      location: { kind: "time", from: 7000, to: 10_000, speaker: second },
    });
  });

  test.each(["edited", "removed", "ambiguous"])(
    `a selected Transcript cue that is %s cannot recheck at the first duplicate, ${language}`,
    async (change) => {
      const { core, citations, documents } = await selectSecond();
      const citation = citations[0];
      const document = documents[0];
      if (!citation || !document?.path) throw new Error("No Citation Document");
      const edited = language === "en" ? "We agreed to reject the plan." : "我们同意重新修改计划。";
      const transcript = readVtt(file.contents);
      const contents = writeVtt({
        ...transcript,
        cues: transcript.cues.flatMap((cue) =>
          cue.startMs !== 7000
            ? [cue]
            : change === "removed"
              ? []
              : [{ ...cue, text: change === "ambiguous" ? `${repeated} ${repeated}` : edited }],
        ),
      });
      await writeFile(document.path, contents);
      await core.reconcileDocuments();
      await waitForDocuments(core, (listed) =>
        expect(listed.find((each) => each.id === document.id)?.contentHash).toBe(sha256(contents)),
      );
      await waitForProcessing(core, [document.id]);
      const checked = checkedResult(
        await core.recheckCitation({
          ...citation,
          documentId: document.id,
          quote: repeated,
          mindId: null,
        }),
      );
      expect(checked).toMatchObject({
        check: "not-found",
        location: { kind: "time", from: 7000, to: 10_000, speaker: second },
        inQuotedVersion: { check: "found" },
      });
      if (change === "edited") {
        expect(checked.changed?.now).toMatchObject({
          quote: edited,
          check: "found",
          location: { kind: "time", from: 7000, to: 10_000, speaker: second },
        });
      } else expect(checked.changed).toBeNull();
    },
  );

  test(`a cited cue whose speaker the speaker pass named since is still found, under its new name, ${language}`, async () => {
    const { core, citations, documents } = await selectSecond();
    const citation = citations[0];
    const document = documents[0];
    if (!citation || !document?.path) throw new Error("No Citation Document");
    const named = language === "en" ? "Priya" : "陈静";
    const transcript = readVtt(file.contents);
    const contents = writeVtt({
      ...transcript,
      cues: transcript.cues.map((cue) =>
        cue.speaker === second ? { ...cue, speaker: named } : cue,
      ),
    });
    await writeFile(document.path, contents);
    await core.reconcileDocuments();
    await waitForDocuments(core, (listed) =>
      expect(listed.find((each) => each.id === document.id)?.contentHash).toBe(sha256(contents)),
    );
    await waitForProcessing(core, [document.id]);
    const checked = checkedResult(
      await core.recheckCitation({
        ...citation,
        documentId: document.id,
        quote: repeated,
        mindId: null,
      }),
    );
    expect(checked).toMatchObject({
      check: "found",
      contentHash: sha256(contents),
      location: { kind: "time", from: 7000, to: 10_000, speaker: named },
      inQuotedVersion: { check: "found" },
    });
  });

  test(`in the version it quoted, a cited cue under a speaker the Transcript never had is not found, ${language}`, async () => {
    const { core, citations } = await selectSecond();
    const citation = citations[0];
    if (!citation?.documentId) throw new Error("No Citation");
    const checked = checkedResult(
      await core.recheckCitation({
        ...citation,
        documentId: citation.documentId,
        quote: repeated,
        mindId: null,
        location: { kind: "time", from: 7000, to: 10_000, speaker: "Nobody" },
      }),
    );
    expect(checked.check).toBe("not-found");
  });

  test(`a time range takes in the cue that starts within its last second, ${language}`, async () => {
    const { citations } = await ask(
      citingModel({
        query: "Review",
        records: (passages) => [
          { marker: 1, passage: passages[0]?.id, location: "0:04–0:11", quote: estimate },
        ],
        answer,
      }),
    );
    expect(citations).toMatchObject([
      { check: "found", location: { kind: "time", from: 11_750, to: 13_000, speaker: second } },
    ]);
  });

  test(`unique Transcript quotes keep their cue time and stored speaker, ${language}`, async () => {
    const { core, citations } = await ask(
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
    for (const citation of citations) {
      if (!citation.documentId) throw new Error("No Citation Document");
      expect(
        checkedResult(
          await core.recheckCitation({
            ...citation,
            documentId: citation.documentId,
            quote: citation.quote ?? "",
            mindId: null,
          }),
        ),
      ).toMatchObject({ check: "found", location: citation.location });
    }
  });

  test.each([false, true])(
    `a Transcript cue label with speaker selects its stored time with brackets=%s, ${language}`,
    async (brackets) => {
      const label = `0:11 ${second}`;
      const model = citingModel({
        query: "Review",
        records: (passages) => {
          expect(passages[0]?.text).toContain(`[${label}] ${estimate}`);
          return [
            {
              marker: 1,
              passage: passages[0]?.id,
              location: brackets ? `[${label}]` : label,
              quote: estimate,
            },
            {
              marker: 2,
              passage: passages[0]?.id,
              location: brackets ? `[0:07 ${second}]` : `0:07 ${second}`,
              quote: repeated,
            },
          ];
        },
        answer: `${answer} ${answer.replace("[^1]", "[^2]")}`,
      });
      const { citations } = await ask(model);
      expect(citations).toHaveLength(2);
      expect(citations).toMatchObject([
        {
          quote: estimate,
          check: "found",
          pageFrom: 1,
          pageTo: 1,
          location: { kind: "time", from: 11_750, to: 13_000, speaker: second },
        },
        {
          quote: repeated,
          check: "found",
          pageFrom: 1,
          pageTo: 1,
          location: { kind: "time", from: 7000, to: 10_000, speaker: second },
        },
      ]);
      expect(citeFeedback(model)).not.toContain("Fix these");
    },
  );

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

  test.each([
    "0:07",
    "0:03",
    "9:59",
    "0:99",
    "later",
    "p. 1",
    `[0:07 ${first}]`,
    `0:03 ${first}`,
    `[9:59 ${first}]`,
    `0:99 ${first}`,
    `0:04 ${second}`,
    first,
  ])(
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

  test.each(["0:07", `0:07 ${first}`, `0:04 ${second}`])(
    `Transcript feedback explains the requested time/speaker for %s, ${language}`,
    async (location) => {
      const model = citingModel({
        query: "Review",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, location, quote: boat }],
        answer,
      });
      const { citations } = await ask(model);
      expect(citations).toHaveLength(1);
      expect(citations[0]?.check).toBe("not-found");
      const feedback = citeFeedback(model);
      expect(feedback).toContain(`not found at the requested time/speaker "${location}"`);
      expect(feedback).toContain("copy the exact cue timestamp");
      expect(feedback).toContain('"0:11" or "0:11 Dana"');
      expect(feedback).toContain("do not omit or broaden the requested time/speaker");
      expect(feedback).not.toContain("isn't word for word");
    },
  );

  test.each(["later", second])(
    `Transcript feedback explains timestamp format for %s, ${language}`,
    async (location) => {
      const model = citingModel({
        query: "Review",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, location, quote: boat }],
        answer,
      });
      const { citations } = await ask(model);
      expect(citations).toHaveLength(1);
      expect(citations[0]?.check).toBe("not-found");
      const feedback = citeFeedback(model);
      expect(feedback).toContain("a speaker name alone is not a timestamp");
      expect(feedback).toContain("copy the exact cue timestamp");
      expect(feedback).toContain('"0:11" or "0:11 Dana"');
      expect(feedback).not.toContain("0:00");
      expect(feedback).not.toContain("isn't word for word");
    },
  );

  test(`non-time Transcript quote feedback keeps its existing wording, ${language}`, async () => {
    const model = citingModel({
      query: "Review",
      records: (passages) => [{ marker: 1, passage: passages[0]?.id, quote: absent }],
      answer,
    });
    const { citations } = await ask(model);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.check).toBe("not-found");
    expect(citeFeedback(model)).toBe(
      "Recorded [^1]. Fix these with another cite call:\n- [^1]: the quote isn't word for word at 0:00 in P1; copy it exactly, and check where it is.",
    );
  });

  test.each([
    {
      location: undefined,
      expected:
        "Recorded [^1]. Fix these with another cite call:\n- [^1]: the quote isn't word for word at § Review in P1; copy it exactly, and check where it is.",
    },
    {
      location: "§ Missing",
      expected:
        "Recorded [^1]. Fix these with another cite call:\n- [^1]: give a location inside P1 (§ Review), naming one place, or two in a row.",
    },
  ])(
    `non-Transcript feedback keeps its existing wording with $location, ${language}`,
    async ({ location, expected }) => {
      const model = citingModel({
        query: "Review",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, location, quote: absent }],
        answer,
      });
      const { core, client, mind } = await setUpWithDocuments(model, [
        { name: "Review.md", contents: `# Review\n\n${boat}\n` },
      ]);
      await core.updateSettings({ user: { language } });
      await askAndFinish(core, client, mind.id, "Review");
      expect(citeFeedback(model)).toBe(expected);
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
