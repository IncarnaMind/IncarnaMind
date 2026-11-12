import { expect, test, vi } from "vitest";
import { createCitationSession } from "../../src/core/answers/citations";
import { type AnswerEngineEvent, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import type { CitationSource } from "../../src/core/documents";
import type { WindowedPassage } from "../../src/core/documents/search";
import { askAndFinish, citationsIn, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";

const SAID = "The review moved to the next agenda item.";
const UNSOURCED = "The amber lantern arrives at the northern gate.";
const FRAMES = [
  "### FACT F1",
  "```json",
  JSON.stringify({
    topic: "review with a long metadata label",
    citations: [1],
    lines: ["L1"],
    sections: ["actions"],
    claim: false,
  }),
  "```",
  `${SAID.slice(0, -1)} [^1].`,
  "### END F1",
  "",
  "### FACT F2",
  "```json",
  JSON.stringify({
    topic: "unrecorded detail",
    citations: [99],
    lines: [],
    sections: ["summary"],
    claim: false,
  }),
  "```",
  `${UNSOURCED.slice(0, -1)} [^99].`,
  "### END F2",
].join("\n");

function transcriptSession() {
  const source: CitationSource = {
    passageId: "transcript-passage",
    documentId: "transcript-document",
    documentName: "Review transcript",
    documentKind: "transcript",
    contentHash: "transcript-version",
    text: SAID,
    pageFrom: 1,
    pageTo: 1,
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
  const session = createCitationSession(
    {
      searchableCount: () => 1,
      search: async () => [passage],
      citationSource: (id) => (id === source.passageId ? source : null),
      documentDate: () => null,
      pageTexts: () => [
        {
          page: 1,
          text: SAID,
          kind: "cues",
          label: { from: 0, to: 1_000, speakers: ["Dana"] },
          anchors: [{ start: 0, end: SAID.length, target: "t0-1000" }],
        },
      ],
    },
    { onRecord: () => undefined },
  );
  return { session, shown: session.show([passage]) };
}

function streamedText(events: readonly AnswerEngineEvent[]): string {
  return events.reduce((text, event) => {
    if (event.type === "text-delta") return text + event.text;
    if (event.type === "text-retracted") return text.slice(0, text.length - event.length);
    return text;
  }, "");
}

test.each([
  { kind: "framed facts", meetingFacts: true as const, requests: 2 },
  { kind: "an untagged memo", meetingFacts: undefined, requests: 3 },
])("$kind preserve their Citation recovery policy", async ({ meetingFacts, requests }) => {
  const { session, shown } = transcriptSession();
  const model = scriptedModel((call) => {
    if (call.index === 0) {
      return {
        calls: [
          {
            tool: "cite",
            input: {
              citations: [1, 2].map((marker) => ({
                marker,
                passage: "P1",
                location: "0:00 Dana",
                quote: SAID,
              })),
            },
          },
        ],
      };
    }
    if (call.index === 1) return { text: FRAMES };
    if (call.index === 2 && !meetingFacts) return { text: '{"citations":[]}' };
    throw new Error("Unexpected post-final Citation recovery request.");
  });
  const quickModel = vi.fn(async () => model);
  const request = {
    instructions: () => `Fill the Meeting facts from this Transcript:\n${shown}`,
    messages: [{ role: "user" as const, content: "Fill the recorded facts." }],
    question: "Fill the recorded facts.",
    model,
    quickModel,
    documents: session.tools,
    tools: [],
    toolSet: "check" as const,
    outputKind: "meeting-fill" as const,
    ...(meetingFacts && { meetingFacts }),
    signal: new AbortController().signal,
  };
  const events: AnswerEngineEvent[] = [];
  for await (const event of createAiSdkAnswerEngine().generate(request)) events.push(event);

  expect(events.at(-1)).toEqual({ type: "finished" });
  expect(model.doStreamCalls).toHaveLength(requests);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(quickModel).toHaveBeenCalledTimes(meetingFacts ? 0 : 1);
  expect(events.filter((event) => event.type === "cited-after-checking")).toEqual(
    meetingFacts ? [] : [{ type: "cited-after-checking", count: 0, asked: true }],
  );
  expect(events.filter((event) => event.type === "markers-placed")).toEqual(
    meetingFacts ? [] : [{ type: "markers-placed", count: 1 }],
  );
  if (meetingFacts) expect(streamedText(events)).toBe(FRAMES);
  session.check();
  expect(session.finalCitation(1)).toMatchObject({
    check: "found",
    quote: SAID,
    documentId: "transcript-document",
    contentHash: "transcript-version",
    location: { kind: "time", from: 0, to: 1_000, speaker: "Dana" },
  });
  expect(session.finalCitation(99)).toBeNull();
});

test.each([
  {
    problem: "framed unrecorded marker",
    marker: 99,
    quote: null,
    meetingFacts: true as const,
    requests: 1,
  },
  {
    problem: "framed quote not found",
    marker: 2,
    quote: UNSOURCED,
    meetingFacts: true as const,
    requests: 1,
  },
  {
    problem: "untagged memo quote not found",
    marker: 2,
    quote: UNSOURCED,
    meetingFacts: undefined,
    requests: 2,
  },
])(
  "an existing local structured route preserves its policy for $problem",
  async ({ marker, quote, meetingFacts, requests }) => {
    const { session, shown } = transcriptSession();
    const frames = FRAMES.replaceAll("[99]", `[${marker}]`).replaceAll("[^99]", `[^${marker}]`);
    const model = scriptedModel((call) => {
      if (call.question === "quote-retry" && !meetingFacts) return { text: '{"quotes":[]}' };
      if (call.index > 0) throw new Error("Unexpected post-final structured recovery request.");
      return {
        text: JSON.stringify({
          answer: frames,
          citations: [
            { marker: 1, passage: "P1", location: "0:00 Dana", quote: SAID },
            ...(quote ? [{ marker, passage: "P1", location: "0:00 Dana", quote }] : []),
          ],
        }),
      };
    });
    const quickModel = vi.fn(async () => model);
    const events: AnswerEngineEvent[] = [];
    for await (const event of createAiSdkAnswerEngine().generate({
      instructions: () => `Fill the Meeting facts from this Transcript:\n${shown}`,
      messages: [{ role: "user", content: "Fill the recorded facts." }],
      question: "Fill the recorded facts.",
      model,
      quickModel,
      documents: session.tools,
      tools: [],
      toolSet: "check",
      outputKind: "meeting-fill",
      ...(meetingFacts && { meetingFacts }),
      support: "structured-output",
      retryQuotes: true,
      window: { tokens: 8_192, outputTokens: 1_024 },
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "finished" });
    expect(model.doStreamCalls).toHaveLength(requests);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(quickModel).not.toHaveBeenCalled();
    expect(
      events.filter(
        (event) => event.type === "quotes-retried" || event.type === "cited-after-checking",
      ),
    ).toEqual(
      meetingFacts
        ? []
        : [
            {
              type: "quotes-retried",
              retry: { records: 1, recovered: 0, durationMs: expect.any(Number) },
            },
          ],
    );
    expect(streamedText(events)).toBe(frames);
    session.check();
    expect(session.finalCitation(1)).toMatchObject({ check: "found", quote: SAID });
    if (quote) expect(session.finalCitation(marker)).toMatchObject({ check: "not-found", quote });
    else expect(session.finalCitation(marker)).toBeNull();
  },
);

test("framed facts still hear ordinary cite feedback and finish only after the record is fixed", async () => {
  const { session, shown } = transcriptSession();
  const frame = FRAMES.split("### FACT F2")[0]?.trim() ?? "";
  const model = scriptedModel((call) => {
    if (call.index > 1) throw new Error("Unexpected request after the Citation was fixed.");
    if (call.index === 1) {
      expect(call.results.at(-1)?.text).toContain("Fix these with another cite call:");
    }
    return {
      ...(call.index === 0 && { text: frame }),
      calls: [
        {
          tool: "cite",
          input: {
            citations: [
              {
                marker: 1,
                passage: "P1",
                location: "0:00 Dana",
                quote: call.index === 0 ? UNSOURCED : SAID,
              },
            ],
          },
        },
      ],
    };
  });
  const events: AnswerEngineEvent[] = [];
  for await (const event of createAiSdkAnswerEngine().generate({
    instructions: () => `Fill the Meeting facts from this Transcript:\n${shown}`,
    messages: [{ role: "user", content: "Fill the recorded facts." }],
    question: "Fill the recorded facts.",
    model,
    documents: session.tools,
    tools: [],
    toolSet: "check",
    outputKind: "meeting-fill",
    meetingFacts: true,
    writeThenCite: true,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }

  expect(events.at(-1)).toEqual({ type: "finished" });
  expect(model.doStreamCalls).toHaveLength(2);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(session.tools.owed?.(frame)).toEqual({ citations: [], figures: [] });
  session.check();
  expect(session.finalCitation(1)).toMatchObject({ check: "found", quote: SAID });
});

test.each(["unrecorded marker", "misquoted words"])(
  "a final Answer keeps checked Transcript Citations and removes no checks for %s",
  async (problem) => {
    const frames =
      problem === "unrecorded marker"
        ? FRAMES
        : FRAMES.replaceAll("[99]", "[2]").replace(
            `${UNSOURCED.slice(0, -1)} [^99].`,
            "Dana said “The budget rose to ten billion dollars” [^2].",
          );
    const model = scriptedModel((call) => {
      if (call.index === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "review" } }] };
      }
      if (call.index === 1) {
        const search = call.results.find((result) => result.tool === "search_documents");
        const [passage] = shownPassages(search?.text ?? "");
        if (!passage) throw new Error("The Transcript wasn't read.");
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: (problem === "unrecorded marker" ? [1] : [1, 2]).map((marker) => ({
                  marker,
                  passage: passage.id,
                  location: "0:00 Dana",
                  quote: SAID,
                })),
              },
            },
          ],
        };
      }
      if (call.index === 2) return { text: frames };
      throw new Error("Unexpected post-final recovery in the Answer pipeline.");
    });
    const engine = createAiSdkAnswerEngine();
    const { core, client, mind, documents } = await setUpWithDocuments(
      model,
      [
        {
          name: "Review.vtt",
          contents: `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Dana>${SAID}\n`,
        },
      ],
      {
        answerEngine: {
          generate: (request) =>
            engine.generate({ ...request, meetingFacts: true, outputKind: "meeting-fill" }),
        },
      },
    );

    const { answerId, finished } = await askAndFinish(core, client, mind.id, "What was reviewed?");

    expect(model.doStreamCalls).toHaveLength(3);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(citationsIn(client, answerId)).toEqual([
      expect.objectContaining({
        check: "found",
        quote: SAID,
        documentId: documents[0]?.id,
        location: { kind: "time", from: 0, to: 1_000, speaker: "Dana" },
      }),
      ...(problem === "misquoted words"
        ? [
            expect.objectContaining({
              check: "not-found",
              checkReason: "quoted-words-not-on-pages",
              quote: SAID,
            }),
          ]
        : []),
    ]);
    expect(finished.droppedMarkers).toBe(problem === "unrecorded marker" ? 1 : 0);
    expect(finished.droppedRecords).toBe(0);
    expect(finished.citedAfterChecking).toEqual({ count: 0, asked: false });
  },
);
