import { expect, test } from "vitest";
import {
  createCitationSession,
  locateQuote,
  recheckCitation,
  recheckKept,
} from "../../src/core/answers/citations";
import type { CitationSource } from "../../src/core/documents";
import { type Cue, transcriptUnits, writeVtt } from "../../src/core/documents/formats/vtt";
import type { WindowedPassage } from "../../src/core/documents/search";
import { checkReply, isCheckRun } from "../helpers/checks";
import {
  answerEnded,
  askAndFinish,
  checkedResult,
  citationsIn,
  citeFeedback,
  citingModel,
  mindCitations,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { editingModel, wholeParagraph } from "../helpers/editing";
import { resolveChanges, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { docxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { para, pptxOf, sp } from "../helpers/pptx";

function cueSession(cues: Cue[]) {
  const units = transcriptUnits({ cues, gaps: [] });
  const versions = new Map([["same-version", units]]);
  let current = "same-version";
  const text = units.map((unit) => unit.text).join("\n");
  const source: CitationSource = {
    passageId: "review-passage",
    documentId: "review-document",
    documentName: "Review Transcript",
    documentKind: "transcript",
    contentHash: "same-version",
    text,
    pageFrom: 1,
    pageTo: units.length,
    documentDeleted: false,
    notCited: false,
    yourNoteAt: null,
  };
  const passage: WindowedPassage = {
    ...source,
    seq: 1,
    position: 0,
    windowFrom: 0,
    windowTo: 0,
  };
  const documents = {
    currentVersion: () => current,
    searchableCount: () => 1,
    search: async () => [passage],
    citationSource: () => source,
    documentDate: () => null,
    documentName: () => source.documentName,
    pageTexts: (_documentId: string, version: string, from: number | null, to: number | null) =>
      (versions.get(version) ?? []).filter(
        (unit) => from === null || to === null || (unit.page >= from && unit.page <= to),
      ),
    passagesCovering: () => [
      {
        ...passage,
        id: current === source.contentHash ? passage.passageId : "updated-passage",
        contentHash: current,
        text: (versions.get(current) ?? []).map((unit) => unit.text).join("\n"),
      },
    ],
  };
  const session = createCitationSession(documents, { onRecord: () => undefined });
  session.show([passage]);
  return {
    session,
    documents,
    source,
    update(next: Cue[]) {
      current = "updated-version";
      versions.set(current, transcriptUnits({ cues: next, gaps: [] }));
    },
  };
}

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
  const speaker = language === "en" ? "Alex" : "王芳";
  const ellipsisFirst =
    language === "en" ? "The review is ready" : "项目审阅工作已经准备就绪并且可以继续进行";
  const ellipsisLast =
    language === "en" ? "final draft is approved." : "最终草稿的全部内容已经审核通过可以正式发布。";
  const ellipsisQuote = `${ellipsisFirst} … ${ellipsisLast}`;
  test(`an inserted cue preserves the one exact stored ellipsis path in a new version, ${language}`, async () => {
    const selected = language === "en" ? "Dana" : "李明";
    const original = [
      { startMs: 0, endMs: 5000, text: ellipsisFirst, speaker: selected },
      { startMs: 10_000, endMs: 15_000, text: ellipsisLast, speaker },
    ];
    const { session, documents, update } = cueSession(original);
    await session.tools.cite([
      { marker: 1, passage: "P1", location: "0:00–0:15", quote: ellipsisQuote },
    ]);
    session.check();
    const citation = session.finalCitation(1);
    if (!citation?.documentId) throw new Error("The original cross-speaker quote was not cited.");
    const location = { kind: "time" as const, from: 0, to: 15_000, speaker: selected };
    expect(citation).toMatchObject({ check: "found", location, contentHash: "same-version" });
    update(
      [
        ...original,
        {
          startMs: 6000,
          endMs: 7000,
          text: `${ellipsisFirst} ${language === "en" ? "and the" : "，同时"} ${ellipsisLast}`,
          speaker: language === "en" ? "Charlie" : "陈伟",
        },
      ].sort((first, second) => first.startMs - second.startMs),
    );
    for (const whole of [false, true]) {
      expect(
        recheckCitation(documents, {
          ...citation,
          documentId: citation.documentId,
          quote: ellipsisQuote,
          pageFrom: whole ? null : citation.pageFrom,
          pageTo: whole ? null : citation.pageTo,
        }),
      ).toMatchObject({
        check: "found",
        contentHash: "updated-version",
        location,
        inQuotedVersion: { check: "found" },
        changed: null,
      });
    }
    expect(recheckKept(documents, { ...citation, quote: ellipsisQuote }, null)).toMatchObject({
      check: "found",
      contentHash: "updated-version",
      location,
    });
  });
  test.each(["one cue", "two cues", "shared first part"] as const)(
    `same-Location ellipsis alternatives remain ambiguous with %s, ${language}`,
    async (where) => {
      const line = `${ellipsisFirst} ${language === "en" ? "and the" : "，同时"} ${ellipsisLast}`;
      const cue = { startMs: 0, endMs: 10_000, text: line, speaker };
      const cues =
        where === "two cues"
          ? [cue, { ...cue }]
          : [{ ...cue, text: `${line} ${where === "one cue" ? line : ellipsisLast}` }];
      const { session, documents, source } = cueSession(cues);
      const feedback = await session.tools.cite([
        { marker: 1, passage: "P1", location: `0:00 ${speaker}`, quote: ellipsisQuote },
      ]);
      session.check();
      expect(feedback).toContain("quote enough surrounding words to identify one place");
      expect(session.finalCitation(1)).toBeNull();
      const stored = {
        documentId: source.documentId,
        contentHash: source.contentHash,
        pageFrom: 1,
        pageTo: 1,
        quote: ellipsisQuote,
        location: { kind: "time" as const, from: 0, to: 10_000, speaker },
      };
      expect(recheckCitation(documents, stored)).toMatchObject({
        check: "not-found",
        checkReason: "quote-not-on-pages",
        location: stored.location,
      });
      expect(recheckKept(documents, { ...stored, check: "not-found" }, null)).toBeNull();
    },
  );
  test(`nested ellipsis paths with the same derived Location stay ambiguous, ${language}`, async () => {
    const selected = language === "en" ? "Dana" : "李明";
    const line = `${ellipsisFirst} ${language === "en" ? "and the" : "，同时"} ${ellipsisLast}`;
    const { session, documents } = cueSession([
      { startMs: 0, endMs: 10_000, text: line, speaker: selected },
      { startMs: 2000, endMs: 3000, text: line, speaker },
    ]);
    await session.tools.cite([
      { marker: 1, passage: "P1", location: `0:00 ${selected}`, quote: ellipsisQuote },
    ]);
    session.check();
    const citation = session.finalCitation(1);
    if (!citation?.documentId) throw new Error("The initial speaker-selected quote was not cited.");
    expect(citation.check).toBe("found");
    expect(
      recheckCitation(documents, {
        ...citation,
        documentId: citation.documentId,
        quote: ellipsisQuote,
      }),
    ).toMatchObject({
      check: "not-found",
      checkReason: "quote-not-on-pages",
      location: citation.location,
    });
    expect(recheckKept(documents, { ...citation, check: "not-found" }, null)).toBeNull();
  });
  test.each(["different speaker", "same speaker", "same bounds", "same bounds first"] as const)(
    `an unchanged speaker-selected Citation survives a duplicate cue with %s, ${language}`,
    async (nested) => {
      const quote = language === "en" ? "The review is ready." : "审阅准备好了。";
      const selected = language === "en" ? "Dana" : "李明";
      const sameBounds = nested.startsWith("same bounds");
      const cues = [
        { startMs: 0, endMs: 10_000, text: quote, speaker: selected },
        {
          startMs: sameBounds ? 0 : 2000,
          endMs: sameBounds ? 10_000 : 3000,
          text: quote,
          speaker: nested === "same speaker" ? selected : speaker,
        },
      ];
      const { session, documents } = cueSession(
        nested === "same bounds first" ? cues.reverse() : cues,
      );
      await session.tools.cite([{ marker: 1, passage: "P1", location: `0:00 ${selected}`, quote }]);
      session.check();
      const citation = session.finalCitation(1);
      if (!citation?.documentId) throw new Error("The selected cue has no Citation.");
      const location = { kind: "time" as const, from: 0, to: 10_000, speaker: selected };
      expect(citation).toMatchObject({ check: "found", quote, location });
      for (const whole of [false, true]) {
        expect(
          recheckCitation(documents, {
            ...citation,
            documentId: citation.documentId,
            quote,
            pageFrom: whole ? null : citation.pageFrom,
            pageTo: whole ? null : citation.pageTo,
          }),
        ).toMatchObject({ check: "found", contentHash: citation.contentHash, location });
      }
      expect(recheckKept(documents, { ...citation, check: "not-found" }, null)).toMatchObject({
        check: "found",
        contentHash: citation.contentHash,
        location,
      });
    },
  );
  test.each(["one cue", "two cues"] as const)(
    `two occurrences with the same stored Location remain ambiguous in %s, ${language}`,
    async (where) => {
      const quote = language === "en" ? "The review is ready." : "审阅准备好了。";
      const cue = { startMs: 0, endMs: 10_000, text: quote, speaker };
      const { session, documents, source } = cueSession(
        where === "one cue" ? [{ ...cue, text: `${quote} ${quote}` }] : [cue, { ...cue }],
      );
      const feedback = await session.tools.cite([
        { marker: 1, passage: "P1", location: `0:00 ${speaker}`, quote },
      ]);
      session.check();
      expect(feedback).toContain("quote enough surrounding words to identify one place");
      expect(session.finalCitation(1)).toBeNull();
      const stored = {
        documentId: source.documentId,
        contentHash: source.contentHash,
        pageFrom: 1,
        pageTo: 1,
        quote,
        location: { kind: "time" as const, from: 0, to: 10_000, speaker },
      };
      expect(recheckCitation(documents, stored)).toMatchObject({
        check: "not-found",
        checkReason: "quote-not-on-pages",
        location: stored.location,
      });
      expect(recheckKept(documents, { ...stored, check: "not-found" }, null)).toBeNull();
    },
  );
  test.each([
    { location: "0:05", from: 5750, to: 8000 },
    { location: `[0:05 ${speaker}]`, from: 5750, to: 8000 },
    { location: "0:09", from: 7750, to: 10_000 },
  ])(
    `a stored Transcript occurrence excludes partially overlapping cues at $location, ${language}`,
    async ({ location, from, to }) => {
      const quote = language === "en" ? "Sounds good" : "听起来不错";
      const model = citingModel({
        query: "Overlap",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, location, quote }],
        answer: language === "en" ? "They agreed[^1]." : "他们同意了[^1]。",
      });
      const { core } = await setUpWithDocuments(model, [
        {
          name: "Overlap.vtt",
          contents: writeVtt({
            cues: [
              { startMs: 5750, endMs: 8000, text: `${quote}.`, speaker },
              {
                startMs: 7750,
                endMs: 10_000,
                text: language === "en" ? "Sounds good, let's go." : "听起来不错，我们走吧。",
                speaker,
              },
            ],
            gaps: [],
          }),
        },
      ]);
      await core.updateSettings({ user: { language } });
      const asked = await core.askInConversation({ text: "Overlap" });
      if (!asked.asked) throw new Error("Question not asked");
      await answerEnded(core, asked.answerId);
      const answer = (await core.getConversation(asked.conversation.id)).messages.find(
        (message) => message.id === asked.answerId,
      );
      if (answer?.kind !== "answer") throw new Error("No Answer");
      expect(answer.citations).toHaveLength(1);
      const citation = answer.citations[0];
      if (!citation?.documentId) throw new Error("No Citation Document");
      const stored = { kind: "time", from, to, speaker };
      expect(citation).toMatchObject({ check: "found", quote, location: stored });
      for (const whole of [false, true]) {
        const checked = checkedResult(
          await core.recheckCitation({
            ...citation,
            documentId: citation.documentId,
            mindId: null,
            pageFrom: whole ? null : citation.pageFrom,
            pageTo: whole ? null : citation.pageTo,
          }),
        );
        expect(checked).toMatchObject({
          check: "found",
          contentHash: citation.contentHash,
          pageFrom: whole ? null : citation.pageFrom,
          pageTo: whole ? null : citation.pageTo,
          location: stored,
        });
      }
    },
  );
  test.each([undefined, "0:01–0:05"])(
    `a stored Transcript interval keeps its cross-speaker quote with %s, ${language}`,
    async (location) => {
      const firstSpeaker = language === "en" ? "Dana" : "李明";
      const first = language === "en" ? "The draft is ready." : "草稿准备好了。";
      const second = language === "en" ? "I will send it." : "我会发出去。";
      const quote = `${first}\n${second}`;
      const model = citingModel({
        query: "Handoff",
        records: (passages) => [{ marker: 1, passage: passages[0]?.id, location, quote }],
        answer: language === "en" ? "They discussed the draft[^1]." : "他们讨论了草稿[^1]。",
      });
      const { core, client, mind } = await setUpWithDocuments(model, [
        {
          name: "Handoff.vtt",
          contents: writeVtt({
            cues: [
              { startMs: 1000, endMs: 3000, text: first, speaker: firstSpeaker },
              { startMs: 3000, endMs: 5000, text: second, speaker },
              {
                startMs: 7000,
                endMs: 9000,
                text: language === "en" ? "This is a different cue." : "这是另一段话。",
                speaker,
              },
            ],
            gaps: [],
          }),
        },
      ]);
      await core.updateSettings({ user: { language } });
      const { answerId } = await askAndFinish(core, client, mind.id, "Handoff");
      const citations = citationsIn(client, answerId);
      expect(citations).toHaveLength(1);
      const citation = citations[0];
      if (!citation?.documentId) throw new Error("No Citation Document");
      const stored = { kind: "time" as const, from: 1000, to: 5000, speaker: firstSpeaker };
      expect(citation).toMatchObject({ check: "found", quote, location: stored });
      for (const whole of [false, true]) {
        expect(
          checkedResult(
            await core.recheckCitation({
              ...citation,
              documentId: citation.documentId,
              quote,
              mindId: null,
              pageFrom: whole ? null : citation.pageFrom,
              pageTo: whole ? null : citation.pageTo,
            }),
          ),
        ).toMatchObject({ check: "found", contentHash: citation.contentHash, location: stored });
      }
      for (const wrong of [
        { ...stored, speaker },
        { ...stored, from: 1500 },
        { ...stored, to: 4500 },
        { ...stored, to: 9000 },
      ]) {
        expect(
          checkedResult(
            await core.recheckCitation({
              ...citation,
              documentId: citation.documentId,
              quote,
              mindId: null,
              location: wrong,
            }),
          ),
        ).toMatchObject({
          check: "not-found",
          checkReason: "quote-not-on-pages",
          location: wrong,
        });
      }
    },
  );
  test(`an edit rechecks quoted words across a stored Transcript interval, ${language}`, async () => {
    const first = language === "en" ? "The draft is ready." : "草稿准备好了。";
    const second = language === "en" ? "I will send it." : "我会发出去。";
    const quote = `${first}\n${second}`;
    const { core, client, mind, documents } = await setUpWithDocuments(
      editingModel(() => (language === "en" ? "The draft was ready [1]." : "草稿已经准备好[1]。")),
      [
        {
          name: "Draft.vtt",
          contents: writeVtt({
            cues: [
              {
                startMs: 1000,
                endMs: 3000,
                text: first,
                speaker: language === "en" ? "Dana" : "李明",
              },
              { startMs: 3000, endMs: 5000, text: second, speaker },
            ],
            gaps: [],
          }),
        },
      ],
    );
    await core.updateSettings({ user: { language } });
    const document = documents[0];
    if (!document) throw new Error("No Document");
    const citation = checkedResult(
      await core.citeSelection({ documentId: document.id, parts: [{ unit: 1, text: quote }] }),
    );
    expect(citation.check).toBe("found");
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "draft" },
        content: [
          {
            type: "text",
            text: language === "en" ? "The draft is ready to send " : "草稿准备发送",
          },
          {
            type: "citation",
            attrs: {
              ...citation,
              documentId: document.id,
              documentName: document.name,
              quote,
              check: "not-found",
              checkReason: "quoted-words-not-on-pages",
              quotedWords: { answer: [{ text: quote, found: false }], closest: null },
            },
          },
        ],
      },
    ]);
    await client.settled();
    expect(
      await core.editWithAi(wholeParagraph(client, mind.id, "draft", "shorten")),
    ).toMatchObject({
      kind: "proposed",
      droppedCitations: 0,
    });
    await resolveChanges(client, "accept");
    const kept = mindCitations(client);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ check: "found", quote, location: citation.location });
    expect(kept[0]?.quotedWords).toBeUndefined();
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
