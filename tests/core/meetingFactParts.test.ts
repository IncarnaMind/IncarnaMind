import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { Core, Meeting, MeetingFill, SystemNotifications } from "../../src/core";
import { withoutOverlap } from "../../src/core/answers/documentText";
import { readVtt } from "../../src/core/documents/formats/vtt";
import { buildPassages } from "../../src/core/documents/passages";
import type { WindowedPassage } from "../../src/core/documents/search";
import type { Language } from "../../src/core/language";
import { FILL_PART_TOKENS, transcriptParts } from "../../src/core/meetings/fill";
import { clockTime, parseClockTime } from "../../src/shared/clock";
import { translate } from "../../src/shared/i18n";
import { mindName } from "../../src/shared/naming";
import { mindCitations, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { exactly, heading, note, readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";
import { transcribingCore } from "../helpers/transcription";

const EARLIER = "The review is on Tuesday";
const FINAL = "The review is on Thursday";
const PURPOSE = "The workshop settles the review schedule";
const UNFINISHED = "Dana will distribute the review checklist";
const OVERVIEW = "The workshop covered the review schedule";
/** A fact's frame as a model leaves it when it ends its turn after the record: no sentence, no end line. */
const STOPPED =
  '### FACT P1_F9\n```json\n{"topic":"lunch","citations":[1],"lines":["L1"],"sections":[],"claim":false,"supersedes":[]}\n```';
const LONG_CUES = 60;

function fact(
  id: string,
  text: string,
  {
    citation = 1,
    supersedes = [],
    topic = "review schedule",
  }: { citation?: number; supersedes?: unknown; topic?: string } = {},
): string {
  return [
    `### FACT ${id}`,
    "```json",
    JSON.stringify({
      topic,
      citations: [citation],
      lines: ["L1"],
      sections: ["decisions"],
      claim: false,
      supersedes,
    }),
    "```",
    `${text} [^${citation}].`,
    `### END ${id}`,
  ].join("\n");
}

function overview(part?: number): string {
  return [
    "### OVERVIEW",
    "```json",
    '{"citations":[2]}',
    "```",
    `${OVERVIEW}${part ? ` in part ${part}` : ""} [^2].`,
    "### END OVERVIEW",
  ].join("\n");
}

interface PartReply {
  text: string;
  /** The reply doesn't say its part of the call held little to note. */
  unsaid?: boolean;
  cutOff?: boolean;
  streamError?: boolean;
  /** The provider refuses the request: with its HTTP status, 503 when only true. */
  error?: boolean | number;
  held?: Promise<void>;
}

function modelFor(
  reply: (part: number) => PartReply,
  schedule = { earlier: EARLIER, final: FINAL },
) {
  const calls: { part: number; call: ModelCall }[] = [];
  const quotes = new Map<number, string>();
  const feedback: string[] = [];
  const streamErrors = new Set<number>();
  const summaries: ModelCall[] = [];
  const model = scriptedModel((call): ScriptedReply => {
    // These tests are about facts across parts, so the Summary of the whole call (#3151) gets a
    // reply with no overview and each part's own stays: meetingLongCall.test.ts covers the Summary.
    if (call.prompt.includes("The parts' overviews:\n")) {
      summaries.push(call);
      return { text: "The call was about the review." };
    }
    const part = Number(/Use new ids P(\d+)_F1/.exec(call.prompt)?.[1]);
    if (!part) throw new Error("Unexpected request outside the Meeting fact Run.");
    calls.push({ part, call });
    const next = reply(part);
    if (next.error) {
      const status = next.error === true ? 503 : next.error;
      return { error: { status, message: "The scripted provider stopped." } };
    }
    if (!call.results.some((result) => result.tool === "cite")) {
      const shown = shownPassages(call.prompt);
      const selected = shown
        .flatMap((passage) => passage.text.split("\n"))
        .find(
          (line) =>
            line.startsWith("[") && line.includes(part === 1 ? schedule.earlier : schedule.final),
        );
      const quote = selected?.replace(/^\[[^\]]+\]\s*/, "").split(". ")[0];
      if (!quote) throw new Error(`Part ${part} has no review cue.`);
      const citations = Object.entries({ 1: quote, 2: `${quote}. ${PURPOSE}` }).map(
        ([marker, quote]) => {
          const passage = shown.find((each) => each.text.includes(quote));
          const cue = passage?.text.split("\n").find((line) => line.includes(quote));
          const location = /^\[([^\]]+)\]/.exec(cue ?? "")?.[1];
          if (!passage || !location) throw new Error(`Part ${part} did not show the selected cue.`);
          if (marker === "1") quotes.set(part, quote);
          return { marker: Number(marker), passage: passage.id, quote, location };
        },
      );
      return {
        calls: [{ tool: "cite", input: { citations } }],
        ...(next.held && { pause: { after: 0, until: next.held } }),
      };
    }
    feedback.push(...call.results.map((result) => `${result.tool}: ${result.text}`));
    if (next.streamError) streamErrors.add(call.index);
    // These replies hold a fact or two for a part of any length, and say their part held little
    // to note: each is kept as it is (#3287).
    const controls = ["HEADINGS: H1=NONE", ...(next.unsaid ? [] : ["QUIET: YES"])];
    return {
      text: `${controls.join("\n")}\n\n${next.text}`,
      ...(next.cutOff && { cutOff: true }),
    };
  });
  const doStream = model.doStream.bind(model);
  model.doStream = async (options) => {
    const index = model.doStreamCalls.length;
    const result = await doStream(options);
    if (!streamErrors.has(index)) return result;
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === "finish") controller.error(new Error("The scripted stream broke."));
            else controller.enqueue(part);
          },
        }),
      ),
    };
  };
  return { model, calls, summaries, quotes, feedback, schedule };
}

async function capture(
  model: ReturnType<typeof modelFor>,
  long = false,
  name: string | null = null,
  {
    language,
    notifications,
    short,
    asides,
    linesRepeated,
  }: {
    language?: Language;
    notifications?: SystemNotifications;
    /** This many lines of ordinary length, a sentence or two each, instead of one. */
    short?: number;
    /** After each line a short one: "Yeah.", or a line that starts with it. */
    asides?: boolean;
    /** The evaluation's arm for the notes as they were asked for before #3151. */
    linesRepeated?: boolean;
  } = {},
) {
  const { schedule } = model;
  const padding =
    "Workshop participants compared the supporting material before moving on. ".repeat(20);
  const lines = long
    ? Array.from(
        { length: LONG_CUES },
        (_, index) =>
          `Workshop item ${index + 1}: ${index < 1 ? schedule.earlier : schedule.final}. ${PURPOSE}. ${UNFINISHED}. ${padding}`,
      )
    : Array.from(
        { length: short ?? 1 },
        (_, index) =>
          `Workshop item ${index + 1}: ${index < 2 ? schedule.earlier : schedule.final}. ${PURPOSE}. ${UNFINISHED}.`,
      );
  const said = asides
    ? lines.flatMap((line, index) => [
        line,
        index % 2 ? "Yeah." : "Yeah. But the checklist comes first, doesn't it?",
      ])
    : lines;
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    model: model.model,
    engine: { lines: [...said, "The workshop is closed"], maxSpeechMs: 500 },
    ...(notifications && { notifications }),
    ...(linesRepeated && { notesLinesRepeated: () => true }),
  });
  await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  if (name) await core.updateSettings({ user: { authorName: name } });
  if (language) await core.updateSettings({ user: { language } });
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  writeMind(client, [heading(1, "Review workshop"), note("review schedule")]);
  await client.settled();
  const before = exactly(client);
  await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
  let recorded = 0;
  while (recorded < said.length + 1) {
    const count = Math.min(20, said.length + 1 - recorded);
    record(count * 500, ["microphone"]);
    recorded += count;
    await vi.waitFor(async () => {
      const current = (await core.listMeetings()).find((each) => each.id === meeting.id);
      expect(current?.transcript?.lines ?? 0).toBeGreaterThanOrEqual(recorded - 1);
    });
  }
  await core.stopMeeting(meeting.id);
  const text = await vi.waitFor(async () => {
    const transcript = (await core.listMeetings()).find(
      (each) => each.id === meeting.id,
    )?.transcript;
    if (transcript?.state !== "saved" || !transcript.documentId) {
      throw new Error("The Transcript is not saved yet.");
    }
    const read = await core.readDocumentText(transcript.documentId);
    expect(read.pages.length).toBeGreaterThan(0);
    expect(read.pages.map((page) => page.text).join("\n")).toContain(
      `Workshop item ${lines.length}:`,
    );
    return read;
  });
  const passages: WindowedPassage[] = buildPassages(text.pages).map((passage, index) => ({
    ...passage,
    seq: index + 1,
    passageId: `read-passage-${index + 1}`,
    documentId: text.documentId,
    documentName: "Review workshop Transcript",
    documentKind: "transcript",
    contentHash: text.contentHash,
  }));
  const parts = transcriptParts(withoutOverlap(passages), FILL_PART_TOKENS);
  expect(parts).toHaveLength(long ? 3 : 1);
  return { core, meeting, client, before, parts, text };
}

/** The workshop items a part's request showed the model, in the order shown. */
function itemsShown(model: ReturnType<typeof modelFor>, part: number): number[] {
  const asked = model.calls.find((each) => each.part === part);
  if (!asked) throw new Error(`Part ${part} was never asked.`);
  return shownPassages(asked.call.prompt).flatMap((passage) =>
    [...passage.text.matchAll(/Workshop item (\d+):/g)].map((match) => Number(match[1])),
  );
}

/** A part's request as the model read the Transcript: each line's time, and what was said. */
function linesShown(model: ReturnType<typeof modelFor>, part: number): string[] {
  const asked = model.calls.find((each) => each.part === part);
  if (!asked) throw new Error(`Part ${part} was never asked.`);
  return shownPassages(asked.call.prompt)
    .flatMap((passage) => passage.text.split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line) => line.replace(/^\[(\d+:\d\d)[^\]]*\] /, "$1 "));
}

async function fillOf(core: Core, meeting: Meeting): Promise<MeetingFill | null> {
  return (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill ?? null;
}

async function settledFill(core: Core, meeting: Meeting): Promise<MeetingFill> {
  return vi.waitFor(async () => {
    const fill = await fillOf(core, meeting);
    if (!fill || fill.state === "waiting" || fill.state === "filling") {
      throw new Error(`The fill is not settled: ${JSON.stringify(fill)}`);
    }
    return fill;
  });
}

/** `summary`: the fill read every part of several, so it asked once for the whole call's Summary. */
function expectRequests(
  model: ReturnType<typeof modelFor>,
  counts: number[],
  summary = false,
): void {
  expect(
    model.calls.map(({ part }) => part),
    model.feedback.join("\n"),
  ).toEqual(counts.flatMap((count, index) => Array.from({ length: count }, () => index + 1)));
  expect(model.summaries).toHaveLength(summary ? 1 : 0);
  expect(model.model.doStreamCalls).toHaveLength(
    counts.reduce((sum, count) => sum + count, summary ? 1 : 0),
  );
  expect(model.model.doGenerateCalls).toHaveLength(0);
}

function expectRetained(
  client: MindClient,
  full: string,
  absent: string[] = [],
  overviews = 1,
): void {
  const doc = readMind(client);
  expect(doc.textContent.split(full)).toHaveLength(2);
  expect(doc.textContent.split(OVERVIEW)).toHaveLength(overviews + 1);
  for (const text of absent) expect(doc.textContent).not.toContain(text);
  expect(doc.textContent).not.toMatch(/FACT P\d_|END P\d_|"supersedes"|"citations"/);
  expect(mindCitations(client).length).toBeGreaterThan(0);
  for (const citation of mindCitations(client)) {
    expect(citation).toMatchObject({
      check: "found",
      quote: expect.any(String),
      contentHash: expect.any(String),
      location: { kind: "time" },
    });
  }
}

async function undo(captured: Awaited<ReturnType<typeof capture>>): Promise<void> {
  const { core, meeting, client, before } = captured;
  const { checkpoints } = await core.listCheckpoints(meeting.mindId);
  expect(checkpoints.filter((checkpoint) => checkpoint.reason === "enhance")).toHaveLength(1);
  await core.undoMeetingFill(meeting.id);
  await vi.waitFor(() => expect(exactly(client)).toEqual(before));
  expect(await fillOf(core, meeting)).toMatchObject({
    state: "undone",
    omitted: 0,
    unfinishedParts: 0,
  });
  expect(mindCitations(client)).toEqual([]);
}

describe("Meeting fact frames across provider failures and Transcript parts", () => {
  // A stream that breaks may be that request's alone: its part is asked once more by itself, and
  // the fill ends when that fails too (#3287). A reply out of room on a part too small to ask as
  // two is not asked again.
  test.each([
    { failure: "provider failure", requests: [2, 2] },
    { failure: "output truncation", requests: [2] },
  ] as const)(
    "closed checked frames survive $failure without the unfinished sibling",
    async ({ failure, requests }) => {
      const model = modelFor(
        () => ({
          text: [
            fact("P1_review", EARLIER),
            overview(),
            fact("P1_checklist", UNFINISHED).replace("### END P1_checklist", ""),
          ].join("\n\n"),
          ...(failure === "provider failure" ? { streamError: true } : { cutOff: true }),
        }),
        { earlier: EARLIER, final: EARLIER },
      );
      const captured = await capture(model);
      const { core, meeting, client } = captured;
      try {
        const fill = await settledFill(core, meeting);
        expect(
          fill.state,
          JSON.stringify({ fill, calls: model.calls.length, feedback: model.feedback }),
        ).toBe("filled");
        await vi.waitFor(() => expectRetained(client, EARLIER, [UNFINISHED]));
        expectRequests(model, [...requests]);
        await undo(captured);
        expect(fill).toMatchObject({
          state: "filled",
          omitted: 1,
          unfinishedParts: 1,
          problem: { kind: "model" },
        });
      } finally {
        core.close();
      }
    },
  );

  // protects=a later part that fails keeps what earlier parts checked, counts the parts it never finished, and its notification says the note is partly filled in, in English and Chinese (#3099); fails_when=the earlier facts go, the count is wrong, or the notification is the plain one; no_claim=the line's words, which tests/renderer/meetingFillLine.test.ts covers.
  test.each(["en", "zh-CN"] as const)(
    "a later part that throws retains prior checked facts, counts the current and remaining parts, and notifies a partly filled note (%s)",
    async (language) => {
      const model = modelFor((part) =>
        part === 1
          ? { text: `${fact("P1_review", EARLIER)}\n\n${overview()}` }
          : { text: "", error: true },
      );
      const show = vi.fn<SystemNotifications["show"]>();
      const captured = await capture(model, true, null, { language, notifications: { show } });
      const { core, meeting, client, parts } = captured;
      try {
        const fill = await settledFill(core, meeting);
        expectRetained(client, EARLIER, [FINAL]);
        // The failed part is asked once more by itself before the fill ends on it (#3287).
        expectRequests(model, [2, 1, 1]);
        const mind = (await core.listMinds()).find((each) => each.id === meeting.mindId);
        if (!mind) throw new Error("The Meeting's Note is missing.");
        expect(show.mock.calls.map(([notification]) => notification)).toEqual([
          {
            title: translate(language, "meetings.fill.notify.partial", { meeting: mindName(mind) }),
            body: "",
          },
        ]);
        await undo(captured);
        expect(fill).toMatchObject({
          state: "filled",
          omitted: 0,
          unfinishedParts: parts.length - 1,
          problem: { kind: "model" },
        });
      } finally {
        core.close();
      }
    },
  );

  // protects=a reply with a stray fence line after a fact's end line, and the facts after it written with their json fences left open, has every fact and the overview in the Note, each once, none counted as left out (the shape of a reply in which Claude Haiku 5.5 lost ten facts that were neither kept nor counted, #3145); fails_when=a fact or the overview after the stray line is missing, or the fill counts one left out; no_claim=how often a model writes this.
  test("facts after a stray fence line are read, their open fences closed", async () => {
    const open = (frame: string) =>
      frame
        .split("\n")
        .filter((_, line) => line !== 3)
        .join("\n");
    const model = modelFor(() => ({
      text: [
        `${fact("P1_F1", EARLIER)}\n\`\`\``,
        open(fact("P1_F2", UNFINISHED, { topic: "review checklist" })),
        open(fact("P1_F3", PURPOSE, { topic: "workshop purpose" })),
        open(overview()),
      ].join("\n\n"),
    }));
    const captured = await capture(model);
    const { core, meeting, client } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "filled",
        omitted: 0,
        unfinishedParts: 0,
        problem: null,
      });
      const shown = readMind(client).textContent;
      for (const text of [EARLIER, UNFINISHED, PURPOSE, OVERVIEW]) {
        expect(shown.split(text)).toHaveLength(2);
      }
      expect(shown).not.toMatch(/FACT P\d_|END P\d_|"citations"|```/);
      await undo(captured);
    } finally {
      core.close();
    }
  });

  // protects=a fact the fill can't read because a stray fence line sits before its end line is counted as left out, once, and the fact and the overview after it are in the Note (#3145); fails_when=the fact after it or the overview is missing, the unreadable fact is written, or the count isn't one; no_claim=that the unreadable fact could be repaired.
  test("a fact with a stray fence line before its end line is counted, and the facts after it are read", async () => {
    const model = modelFor(() => ({
      text: [
        fact("P1_F1", EARLIER).replace("### END P1_F1", "```\n### END P1_F1"),
        fact("P1_F2", UNFINISHED, { topic: "review checklist" }),
        overview(),
      ].join("\n\n"),
    }));
    const captured = await capture(model);
    const { core, meeting, client } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "filled",
        omitted: 1,
        unfinishedParts: 0,
      });
      const shown = readMind(client).textContent;
      for (const text of [UNFINISHED, OVERVIEW]) expect(shown.split(text)).toHaveLength(2);
      expect(shown).not.toContain(EARLIER);
      await undo(captured);
    } finally {
      core.close();
    }
  });

  // protects=a short call's reply that stops inside a frame with room left (the model ended its turn two facts in) is asked once more, whole, and the note holds the second reply's notes: every fact and the overview once, nothing of the first reply, nothing counted as left out, with exact Undo (#3145)
  test("a short call's reply that stops inside a frame is asked once more, and the second reply is the notes", async () => {
    const model = modelFor(
      (part) => ({
        text:
          part === 1
            ? [fact("P1_F1", EARLIER), STOPPED].join("\n\n")
            : [
                fact("P2_F1", FINAL),
                fact("P2_F2", UNFINISHED, { topic: "review checklist" }),
                overview(),
              ].join("\n\n"),
      }),
      { earlier: EARLIER, final: EARLIER },
    );
    const captured = await capture(model);
    const { core, meeting, client } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "filled",
        omitted: 0,
        unfinishedParts: 0,
        problem: null,
      });
      expectRequests(model, [2, 2]);
      const shown = readMind(client).textContent;
      for (const text of [FINAL, UNFINISHED, OVERVIEW]) expect(shown.split(text)).toHaveLength(2);
      expect(shown).not.toContain(EARLIER);
      await undo(captured);
    } finally {
      core.close();
    }
  });

  // protects=a part asked once more is never asked a third time, and one reply's notes are kept: the first when the second stops inside a frame with fewer facts closed, or fails; its open fact is counted as left out, as before (#3145)
  test.each([
    ["stops inside a frame with fewer facts", { text: STOPPED }],
    ["fails", { text: "", error: true }],
  ] as const)(
    "a reply that stopped inside a frame is kept when the second %s",
    async (_, second) => {
      const model = modelFor(
        (part) =>
          part === 1
            ? {
                text: [
                  overview(),
                  fact("P1_F1", EARLIER),
                  fact("P1_F2", UNFINISHED, { topic: "review checklist" }),
                  STOPPED,
                ].join("\n\n"),
              }
            : second,
        { earlier: EARLIER, final: EARLIER },
      );
      const captured = await capture(model);
      const { core, meeting, client } = captured;
      try {
        expect(await settledFill(core, meeting)).toMatchObject({
          state: "filled",
          omitted: 1,
          unfinishedParts: 0,
          problem: null,
        });
        expect(new Set(model.calls.map(({ part }) => part))).toEqual(new Set([1, 2]));
        const shown = readMind(client).textContent;
        for (const text of [EARLIER, UNFINISHED, OVERVIEW]) {
          expect(shown.split(text)).toHaveLength(2);
        }
        await undo(captured);
      } finally {
        core.close();
      }
    },
  );

  // protects=a later part that numbers its facts the way an earlier part did has them kept (on a 45-minute call Claude Haiku 5.5 reused 18 ids, and each fact was taken for a change to the kept one and left out): a fact with another topic that cites another line is another fact, each is written once, none is counted as left out, and the next request lists them under ids of their own (#3145); fails_when=a later part's fact is missing or written twice, the fill counts one left out, or two listed facts share an id; no_claim=which ids a real model writes.
  test("a later part that reuses an earlier part's id for another fact has both facts kept", async () => {
    const said = [EARLIER, UNFINISHED, PURPOSE];
    const topics = ["review schedule", "review checklist", "workshop purpose"];
    const model = modelFor((part) => ({
      text: `${fact("P1_F1", said[part - 1] ?? "", { topic: topics[part - 1] ?? "" })}\n\n${overview()}`,
    }));
    const captured = await capture(model, true);
    const { core, meeting, client, parts } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "filled",
        omitted: 0,
        unfinishedParts: 0,
        problem: null,
      });
      const shown = readMind(client).textContent;
      for (const text of said) expect(shown.split(text)).toHaveLength(2);
      const listed = [
        ...(model.calls.find(({ part }) => part === 3)?.call.prompt ?? "").matchAll(
          /"id":"([^"]+)"/g,
        ),
      ].map((match) => match[1]);
      expect(listed).toHaveLength(2);
      expect(listed[0]).toBe("P1_F1");
      expect(listed[1]).not.toBe("P1_F1");
      expectRequests(
        model,
        parts.map(() => 2),
        true,
      );
      await undo(captured);
    } finally {
      core.close();
    }
  });

  test("a later checked correction replaces the prior fact once, with its new Citation and each part's overview and Undo", async () => {
    const model = modelFor((part) => ({
      text: [
        ...(part === 1
          ? [fact("P1_review", EARLIER)]
          : part === 2
            ? [fact("P2_review", FINAL, { supersedes: ["P1_review"] })]
            : []),
        overview(),
      ].join("\n\n"),
    }));
    const captured = await capture(model, true);
    const { core, meeting, client, parts, text } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "filled",
        omitted: 0,
        unfinishedParts: 0,
        problem: null,
      });
      expectRetained(client, FINAL, [EARLIER], parts.length);
      const quote = model.quotes.get(2);
      if (!quote) throw new Error("The later part did not record its review cue.");
      const citations = mindCitations(client).filter((citation) => citation.quote === quote);
      expect(citations).toHaveLength(2);
      const cue = text.pages.find((page) => page.text.includes(quote));
      if (cue?.label?.from === undefined || cue.label.to === undefined) {
        throw new Error("The cited review cue has no time range.");
      }
      for (const citation of citations) {
        expect(citation).toMatchObject({
          check: "found",
          quote,
          documentId: text.documentId,
          contentHash: text.contentHash,
          location: {
            kind: "time",
            from: cue.label.from,
            to: cue.label.to,
            speaker: cue.label.speakers?.[0],
          },
        });
      }
      expect(model.calls.find(({ part }) => part === 2)?.call.prompt).toContain('"id":"P1_review"');
      expect(model.calls.find(({ part }) => part === 3)?.call.prompt).toContain('"id":"P2_review"');
      expect(model.calls.find(({ part }) => part === 3)?.call.prompt).not.toContain(
        '"id":"P1_review"',
      );
      expectRequests(
        model,
        parts.map(() => 2),
        true,
      );
      await undo(captured);
    } finally {
      core.close();
    }
  });

  test.each([
    { kind: "invalid supersedes metadata", id: "P2_review", supersedes: "P1_review", citation: 1 },
    {
      kind: "dangling prior id",
      id: "P2_review",
      supersedes: ["P1_review", "Missing"],
      citation: 1,
    },
    {
      kind: "duplicate prior ids",
      id: "P2_review",
      supersedes: ["P1_review", "P1_review"],
      citation: 1,
    },
    { kind: "conflicting existing id", id: "P1_review", supersedes: [], citation: 1 },
    { kind: "unchecked replacement", id: "P2_review", supersedes: ["P1_review"], citation: 99 },
  ])(
    "$kind cannot delete a good fact from an earlier part",
    async ({ id, supersedes, citation }) => {
      const model = modelFor((part) => ({
        text: [
          ...(part === 1
            ? [fact("P1_review", EARLIER)]
            : part === 2
              ? [fact(id, FINAL, { supersedes, citation })]
              : []),
          overview(),
        ].join("\n\n"),
      }));
      const captured = await capture(model, true);
      const { core, meeting, client, parts } = captured;
      try {
        expect(await settledFill(core, meeting)).toMatchObject({
          state: "filled",
          omitted: 1,
          unfinishedParts: 0,
          problem: null,
        });
        expectRetained(client, EARLIER, [FINAL], parts.length);
        // The later parts' overviews quote that line with its purpose; the fact left out quoted
        // it alone.
        const rejected = model.quotes.get(2);
        if (!rejected) throw new Error("The later part did not record its review cue.");
        expect(mindCitations(client).filter((citation) => citation.quote === rejected)).toEqual([]);
        expectRequests(
          model,
          parts.map(() => 2),
          true,
        );
        await undo(captured);
      } finally {
        core.close();
      }
    },
  );

  // protects=with the User's name set, a later part is sent the facts already kept with the token the model wrote, never the name, and the note has the name in its place once, with exact Undo (#2306); fails_when=the name reaches any part's request, or a token is left in the note; no_claim=a real model's wording.
  test("with the User's name set, a later part's history carries the token, never the name", async () => {
    const name = "Avery Lin";
    const kept = "{{me}} noted that the review is on Tuesday";
    const model = modelFor((part) => ({
      text: [...(part === 1 ? [fact("P1_review", kept)] : []), overview()].join("\n\n"),
    }));
    const captured = await capture(model, true, name);
    const { core, meeting, client, parts } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "filled",
        omitted: 0,
        unfinishedParts: 0,
        problem: null,
      });
      expectRetained(
        client,
        `${name} noted that the review is on Tuesday`,
        ["{{me}}"],
        parts.length,
      );
      for (const part of [2, 3]) {
        const prompt = model.calls.find((each) => each.part === part)?.call.prompt;
        expect(prompt).toContain(`"text":"${kept}`);
        expect(prompt).toContain("Write the User, who reads these notes, as {{me}}");
      }
      for (const call of [...model.model.doStreamCalls, ...model.model.doGenerateCalls]) {
        expect(JSON.stringify(call.prompt)).not.toContain(name);
      }
      expectRequests(
        model,
        parts.map(() => 2),
        true,
      );
      await undo(captured);
    } finally {
      core.close();
    }
  });

  test("cancelling at the next part's boundary writes none of the already checked facts", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = modelFor((part) => ({
      text: `${fact(`P${part}_review`, part === 1 ? EARLIER : FINAL)}\n\n${overview()}`,
      ...(part === 2 && { held }),
    }));
    const captured = await capture(model, true);
    const { core, meeting, client, before } = captured;
    try {
      await vi.waitFor(() => expect(model.calls.some(({ part }) => part === 2)).toBe(true));
      expect(exactly(client)).toEqual(before);
      expect(
        (await core.listCheckpoints(meeting.mindId)).checkpoints.filter(
          (checkpoint) => checkpoint.reason === "enhance",
        ),
      ).toHaveLength(0);
      await core.deleteMind(meeting.mindId);
      release();
      await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "failed",
        problem: { kind: "stopped" },
      });
      const reopened = await connectToMind(core, meeting.mindId);
      expect(exactly(reopened)).toEqual(before);
      expect(mindCitations(reopened)).toEqual([]);
      expect(
        (await core.listCheckpoints(meeting.mindId)).checkpoints.filter(
          (checkpoint) => checkpoint.reason === "enhance",
        ),
      ).toHaveLength(0);
      expectRequests(model, [2, 1]);
    } finally {
      release();
      core.close();
    }
  });
});

describe("A long call's Transcript, each line once, in parts a reply has room for (#3151)", () => {
  // protects=a call's notes are asked for with each Transcript line once, where the Passages' overlap sent two lines in five twice (#3151); fails_when=a line reaches the model twice in one request or across the parts, or a line is never sent; no_claim=what a real model writes from them.
  test("every line of the call is sent to the model once", async () => {
    const model = modelFor(() => ({ text: `${fact("P1_review", EARLIER)}\n\n${overview()}` }));
    const items = 50;
    const { core, meeting } = await capture(model, false, null, { short: items });
    try {
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", problem: null });
      expect(itemsShown(model, 1)).toEqual(Array.from({ length: items }, (_, index) => index + 1));
    } finally {
      core.close();
    }
  });

  // protects=every line of a call's notes request carries its own time, when short replies ("Yeah.") come between the lines and other lines start with the same word (#3151); fails_when=a line reaches the model with no time, or with an earlier line's; no_claim=who the model says spoke.
  test("each line is sent with its own time when short replies repeat", async () => {
    const model = modelFor(() => ({ text: `${fact("P1_review", EARLIER)}\n\n${overview()}` }));
    const { core, meeting, text } = await capture(model, false, null, { short: 40, asides: true });
    try {
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", problem: null });
      const file = (await core.listDocuments()).find((each) => each.id === text.documentId);
      const heard = readVtt(readFileSync(file?.path ?? "", "utf8")).cues.map(
        (cue) => `${clockTime(cue.startMs)} ${cue.text}`,
      );
      expect(heard).toHaveLength(81);
      expect(linesShown(model, 1)).toEqual(heard);
    } finally {
      core.close();
    }
  });

  // protects=the evaluation's arm for the notes as before #3151 really sends the Passages as they overlap, so a paired run compares what it says it does; fails_when=the arm sends each line once, like today's path, or drops a line; no_claim=what the overlap costs a real model.
  test("the evaluation's as-before arm sends the lines the Passages share twice", async () => {
    const model = modelFor(() => ({ text: `${fact("P1_review", EARLIER)}\n\n${overview()}` }));
    const items = 50;
    const { core, meeting } = await capture(model, false, null, {
      short: items,
      linesRepeated: true,
    });
    try {
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", problem: null });
      const shown = itemsShown(model, 1);
      expect(shown.length).toBeGreaterThan(items);
      expect([...new Set(shown)]).toEqual(Array.from({ length: items }, (_, index) => index + 1));
    } finally {
      core.close();
    }
  });

  // protects=a part whose reply is cut off is asked again as two, in reading order and each line once, and the rest of the call is then asked at half the size; the facts the cut reply closed are kept and shown to both halves, the item it never closed isn't counted as left out since its lines are read again, the Summary holds the overview of each answered part once in the order the call was read, the cut reply's giving way to its halves', and the note ends with no problem and exact Undo (#3151); fails_when=the fill stops at the cut reply, a later part is asked at the size that was cut, a kept fact is lost or written twice, the unfinished item is counted, a line of the part is skipped or repeated, or the Summary holds only the first overview, the cut reply's beside its halves', or the overviews out of order; no_claim=how often a real model's reply is cut.
  test("a part whose reply is cut off is asked again as two, and what it wrote is kept", async () => {
    const model = modelFor((part) =>
      part === 1
        ? {
            text: [
              fact("P1_review", EARLIER),
              overview(part),
              fact("P1_checklist", UNFINISHED).replace("### END P1_checklist", ""),
            ].join("\n\n"),
            cutOff: true,
          }
        : { text: overview(part) },
    );
    const captured = await capture(model, true);
    const { core, meeting, client, parts } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "filled",
        omitted: 0,
        unfinishedParts: 0,
        problem: null,
      });
      const halves = [itemsShown(model, 2), itemsShown(model, 3)];
      for (const half of halves) expect(half.length).toBeGreaterThan(0);
      expect(halves.flat()).toEqual(itemsShown(model, 1));
      for (const part of [2, 3]) {
        expect(model.calls.find((each) => each.part === part)?.call.prompt).toContain(
          '"id":"P1_review"',
        );
      }
      // After the cut, the rest of the call is asked at half the size too.
      const rest = transcriptParts(parts.slice(1).flat(), FILL_PART_TOKENS / 2);
      expect(rest.length).toBeGreaterThan(parts.length - 1);
      expectRequests(
        model,
        Array.from({ length: 3 + rest.length }, () => 2),
        true,
      );
      expect(itemsShown(model, 4)).toEqual(
        rest[0]?.flatMap((passage) =>
          [...passage.text.matchAll(/Workshop item (\d+):/g)].map((match) => Number(match[1])),
        ),
      );
      const asked = Array.from({ length: 2 + rest.length }, (_, index) => index + 2);
      expect(asked.flatMap((part) => itemsShown(model, part))).toEqual(
        Array.from({ length: LONG_CUES }, (_, index) => index + 1),
      );
      expectRetained(client, EARLIER, [UNFINISHED], asked.length);
      expect(
        [...readMind(client).textContent.matchAll(/in part (\d+)/g)].map((match) =>
          Number(match[1]),
        ),
      ).toEqual(asked);
      await undo(captured);
    } finally {
      core.close();
    }
  });

  // protects=a part cut off every time is asked again smaller only down to the floor: the fill then ends on the model's own problem and writes nothing (#3151); fails_when=the same part is asked again whole, the asks never end, the problem is of another kind, or the Note changes; no_claim=the floor's size in minutes.
  test("a part cut off every time is asked smaller down to the floor, then the fill ends on the model's problem", async () => {
    const model = modelFor(() => ({ text: "", cutOff: true }));
    const captured = await capture(model, true);
    const { core, meeting, client, before } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "failed",
        problem: { kind: "model", error: "cut-short" },
      });
      const asked = [...new Set(model.calls.map((each) => each.part))];
      expect(asked.length).toBeGreaterThan(1);
      const sizes = asked.map((part) => itemsShown(model, part).length);
      for (const [index, size] of sizes.entries()) {
        if (index > 0) expect(size).toBeLessThan(sizes[index - 1] as number);
      }
      expect(itemsShown(model, asked.at(-1) as number)[0]).toBe(1);
      expect(exactly(client)).toEqual(before);
      expect(mindCitations(client)).toEqual([]);
    } finally {
      core.close();
    }
  });
});

describe("No stretch of a call is missing from its notes without the User being told (#3287)", () => {
  /** A part's reply with one fact and its overview: `part` is the request's number, in the order asked. */
  const notesOf = (part: number) =>
    `${fact(`P${part}_F1`, part === 1 ? EARLIER : FINAL)}\n\n${overview(part)}`;
  /** When the first line a request showed was said, in ms, to the second its mark shows. */
  const startOf = (model: ReturnType<typeof modelFor>, part: number) =>
    parseClockTime(linesShown(model, part)[0]?.split(" ")[0] ?? "") ?? Number.NaN;
  /** When the last line a request showed began, in ms, to the second its mark shows. */
  const lastOf = (model: ReturnType<typeof modelFor>, part: number) =>
    parseClockTime(linesShown(model, part).at(-1)?.split(" ")[0] ?? "") ?? Number.NaN;
  /** The fill's stretches, each start to the second a line's mark shows. */
  const stretchesOf = (fill: MeetingFill) =>
    (fill.stretches ?? []).map((each) => ({ ...each, from: Math.floor(each.from / 1000) * 1000 }));

  // protects=a part's first request stays as it was, and only its second, sent when the first gave no notes or few, offers no search of the Documents and says its lines are in the request, whole: offered the search, a model searched the lines it already had and answered in prose, and taking it off every request cost a model facts for every part (#3287); fails_when=a second request offers the search or tells the model to search, or a first request loses it; no_claim=an Answer's or a check's request, which keeps the search.
  test("only a part's second request offers no search and says its lines are given whole", async () => {
    const model = modelFor((part) => ({ text: notesOf(part), unsaid: part === 2 }));
    const captured = await capture(model, true);
    try {
      await settledFill(captured.core, captured.meeting);
      expectRequests(model, [2, 2, 2, 2], true);
      for (const { part, call } of model.calls) {
        expect(call.tools).toContain("cite");
        expect(call.tools.includes("search_documents")).toBe(part !== 3);
        expect(call.system.includes("search_documents")).toBe(part !== 3);
        expect(call.system.includes("there is nothing to search")).toBe(part === 3);
      }
    } finally {
      captured.core.close();
    }
  });

  // protects=a long call's part whose reply is short for its length and says its part held little to note is kept as it is: one request a part, nothing told (#3287); fails_when=a reply that says so is asked again, or its stretch is told as incomplete; no_claim=when a real model says so, which the pull request's real-model runs show.
  test("a short reply that says its part held little is kept as it is, with nothing told", async () => {
    const model = modelFor((part) => ({ text: notesOf(part) }));
    const captured = await capture(model, true);
    try {
      const fill = await settledFill(captured.core, captured.meeting);
      expect(fill).toMatchObject({ state: "filled", unfinishedParts: 0, problem: null });
      expect(fill.stretches).toBeUndefined();
      expectRequests(model, [2, 2, 2], true);
    } finally {
      captured.core.close();
    }
  });

  // protects=a part whose reply is short for its length and doesn't say its part held little is asked once more, by itself, with the same lines, and one reply's notes are kept; with a second reply that says so, nothing is told (#3287); fails_when=the short reply is kept unasked, the second request shows other lines, or both replies' facts are written; no_claim=how often a real model's second reply is fuller.
  test("a short reply that doesn't say so is asked once more by itself, and one reply is the notes", async () => {
    const model = modelFor((part) => ({ text: notesOf(part), unsaid: part === 2 }));
    const captured = await capture(model, true);
    try {
      const fill = await settledFill(captured.core, captured.meeting);
      expect(fill).toMatchObject({ state: "filled", unfinishedParts: 0, problem: null });
      expect(fill.stretches).toBeUndefined();
      expectRequests(model, [2, 2, 2, 2], true);
      expect(linesShown(model, 3)).toEqual(linesShown(model, 2));
      expect(itemsShown(model, 4)[0]).toBe((itemsShown(model, 2).at(-1) ?? 0) + 1);
      // Only the second request asks whether the part held little: asked of every part, the
      // question made a model write fewer facts for all of them.
      const asksWhetherQuiet = (part: number) =>
        model.calls.some((each) => each.part === part && each.call.prompt.includes("QUIET: YES"));
      expect([1, 2, 3, 4].map(asksWhetherQuiet)).toEqual([false, false, true, false]);
      const shown = readMind(captured.client).textContent;
      expect(shown.split(`${OVERVIEW} in part 2`)).toHaveLength(2);
      expect(shown).not.toContain(`${OVERVIEW} in part 3`);
    } finally {
      captured.core.close();
    }
  });

  // protects=a part whose reply is short for its length twice and never says its part held little keeps the better reply's notes, and its stretch of the call is told with its times as possibly incomplete; the parts after it are still read (#3287); fails_when=nothing is told, the stretch has the wrong times, or the later part isn't sent; no_claim=that the notes are in fact incomplete.
  test("a part short twice, never called quiet, is told with its times as possibly incomplete", async () => {
    const model = modelFor((part) => ({ text: notesOf(part), unsaid: part === 2 || part === 3 }));
    const captured = await capture(model, true);
    try {
      const fill = await settledFill(captured.core, captured.meeting);
      expect(fill).toMatchObject({ state: "filled", unfinishedParts: 0, problem: null });
      expectRequests(model, [2, 2, 2, 2], true);
      expect(stretchesOf(fill)).toEqual([
        { from: startOf(model, 2), to: expect.any(Number), notes: "thin" },
      ]);
      expect(fill.stretches?.[0]?.to).toBeGreaterThanOrEqual(lastOf(model, 2));
      expect(fill.stretches?.[0]?.to).toBeLessThan(lastOf(model, 4));
    } finally {
      captured.core.close();
    }
  });

  // protects=a part asked again for its few notes whose second request then meets a failure that may pass by itself (the service failing, a rate limit), once, keeps its first reply's notes, is told with its times as possibly incomplete, and the parts after it are still read: the failure wasn't met twice running (#3287); fails_when=the one failure ends the sending and the later part gets no notes, or the first reply's notes are dropped; no_claim=the same failure met by both requests of a part, which stops the sending.
  test.each([
    { status: 500, failure: "the service failing" },
    { status: 429, failure: "a rate limit" },
  ])(
    "a short reply whose second request meets $failure keeps its notes, and the part after it is still read",
    async ({ status }) => {
      const model = modelFor((part) =>
        part === 3 ? { text: "", error: status } : { text: notesOf(part), unsaid: part === 2 },
      );
      const captured = await capture(model, true);
      try {
        const fill = await settledFill(captured.core, captured.meeting);
        expect(fill).toMatchObject({ state: "filled", unfinishedParts: 0, problem: null });
        expectRequests(model, [2, 2, 1, 2], true);
        expect(stretchesOf(fill)).toEqual([
          { from: startOf(model, 2), to: expect.any(Number), notes: "thin" },
        ]);
        const shown = readMind(captured.client).textContent;
        expect(shown.split(`${OVERVIEW} in part 2`)).toHaveLength(2);
        expect(shown.split(`${OVERVIEW} in part 4`)).toHaveLength(2);
      } finally {
        captured.core.close();
      }
    },
  );

  // protects=a part whose reply can't be read as notes (prose, no fact and no overview) is asked once more; unreadable twice, its stretch is told with its times as having no notes, the part after it is still read and its notes kept (#3287); fails_when=the prose reply is kept as an empty one with nothing told, or the fill stops there; no_claim=why a real model answers in prose.
  test("a part unreadable as notes twice is told with its times, and the part after it is still read", async () => {
    const model = modelFor((part) =>
      part === 2 || part === 3
        ? { text: "The workshop went over the review schedule again.", unsaid: true }
        : { text: notesOf(part) },
    );
    const captured = await capture(model, true);
    try {
      const fill = await settledFill(captured.core, captured.meeting);
      expect(fill).toMatchObject({ state: "filled", unfinishedParts: 1 });
      expectRequests(model, [2, 2, 2, 2]);
      expect(stretchesOf(fill)).toEqual([
        { from: startOf(model, 2), to: expect.any(Number), notes: "none" },
      ]);
      expect(fill.stretches?.[0]?.to).toBeGreaterThanOrEqual(lastOf(model, 2));
      expect(fill.stretches?.[0]?.to).toBeLessThan(lastOf(model, 4));
      const shown = readMind(captured.client).textContent;
      expect(shown.split(`${OVERVIEW} in part 4`)).toHaveLength(2);
    } finally {
      captured.core.close();
    }
  });

  // protects=a part the provider refuses is asked once more by itself and its notes are kept: nothing is told and the parts after it are read (#3287); fails_when=one refusal ends the fill, or the stretch is told although its notes were made.
  test("a refused part is asked once more by itself, and the call's notes are whole", async () => {
    const model = modelFor((part) =>
      part === 2 ? { text: "", error: 400 } : { text: notesOf(part) },
    );
    const captured = await capture(model, true);
    try {
      const fill = await settledFill(captured.core, captured.meeting);
      expect(fill).toMatchObject({ state: "filled", unfinishedParts: 0, problem: null });
      expect(fill.stretches).toBeUndefined();
      expectRequests(model, [2, 1, 2, 2], true);
      expect(linesShown(model, 3)).toEqual(linesShown(model, 2));
    } finally {
      captured.core.close();
    }
  });

  // protects=a part the provider refuses twice is told with its times as having no notes, and the part after it is still sent and its notes kept (#3287); fails_when=the refusal stops the later part, or the stretch isn't named.
  test("a part refused twice is told with its times, and the part after it is still sent", async () => {
    const model = modelFor((part) =>
      part === 2 || part === 3 ? { text: "", error: 400 } : { text: notesOf(part) },
    );
    const captured = await capture(model, true);
    try {
      const fill = await settledFill(captured.core, captured.meeting);
      expect(fill).toMatchObject({
        state: "filled",
        unfinishedParts: 1,
        problem: { kind: "model", error: "refused" },
      });
      expectRequests(model, [2, 1, 1, 2]);
      expect(stretchesOf(fill)).toEqual([
        { from: startOf(model, 2), to: expect.any(Number), notes: "none" },
      ]);
      const shown = readMind(captured.client).textContent;
      expect(shown.split(`${OVERVIEW} in part 4`)).toHaveLength(2);
    } finally {
      captured.core.close();
    }
  });

  // protects=a failure that may pass by itself (the service failing, a rate limit) is asked once more before anything is given up: the part's notes are kept, nothing is told and the parts after it are read (#3287); fails_when=one such failure ends the fill or names a stretch; no_claim=a failure of the key or the account, which the test below covers.
  test.each([
    { status: 500, failure: "the service failing" },
    { status: 429, failure: "a rate limit" },
  ])(
    "a part that meets $failure once is asked once more, and the call's notes are whole",
    async ({ status }) => {
      const model = modelFor((part) =>
        part === 2 ? { text: "", error: status } : { text: notesOf(part) },
      );
      const captured = await capture(model, true);
      try {
        const fill = await settledFill(captured.core, captured.meeting);
        expect(fill).toMatchObject({ state: "filled", unfinishedParts: 0, problem: null });
        expect(fill.stretches).toBeUndefined();
        expectRequests(model, [2, 1, 2, 2], true);
      } finally {
        captured.core.close();
      }
    },
  );

  // protects=the same failure met again by the part asked by itself is every request's: nothing more is sent, and the whole stretch not sent is told as one (#3287); fails_when=the later part is still sent into a failing service, or the stretch isn't told to the call's end; no_claim=how long the app waits between the two requests.
  test.each([
    { status: 500, error: "provider" },
    { status: 429, error: "rate-limit" },
  ])(
    "a part that fails twice with $error stops the sending, and the stretch not sent is told as one",
    async ({ status, error }) => {
      const model = modelFor((part) =>
        part === 1 ? { text: notesOf(part) } : { text: "", error: status },
      );
      const captured = await capture(model, true);
      try {
        const fill = await settledFill(captured.core, captured.meeting);
        expect(fill).toMatchObject({
          state: "filled",
          unfinishedParts: 2,
          problem: { kind: "model", error },
        });
        expectRequests(model, [2, 1, 1]);
        expect(stretchesOf(fill)).toEqual([
          { from: startOf(model, 2), to: expect.any(Number), notes: "none" },
        ]);
        const asked = itemsShown(model, 2).length;
        expect(fill.stretches?.[0]?.to).toBeGreaterThan(startOf(model, 2) + asked * 500);
      } finally {
        captured.core.close();
      }
    },
  );

  // protects=a failure every request of the fill shares (a refused key) stops the sending at once, with no second request, and the whole stretch not sent is told as one, from the failed part's start to the call's end (#3287); fails_when=the part is asked again, a later part is sent, or the stretches not sent aren't named.
  test("a refused key stops the sending at once, and the stretch not sent is told as one", async () => {
    const model = modelFor((part) =>
      part === 1 ? { text: notesOf(part) } : { text: "", error: 401 },
    );
    const captured = await capture(model, true);
    try {
      const fill = await settledFill(captured.core, captured.meeting);
      expect(fill).toMatchObject({
        state: "filled",
        unfinishedParts: 2,
        problem: { kind: "model", error: "auth" },
      });
      expectRequests(model, [2, 1]);
      expect(stretchesOf(fill)).toEqual([
        { from: startOf(model, 2), to: expect.any(Number), notes: "none" },
      ]);
      // The stretch runs past the failed part, over the part never sent.
      const asked = itemsShown(model, 2).length;
      expect(fill.stretches?.[0]?.to).toBeGreaterThan(startOf(model, 2) + asked * 500);
    } finally {
      captured.core.close();
    }
  });
});

describe("Post-fix public regressions for cross-part fact identities", () => {
  test("an exact replay of a superseded identity cannot resurrect its earlier fact", async () => {
    const monday = "The review is on Monday";
    const friday = "The review is on Friday";
    const original = fact("P1_F1", monday);
    const correction = fact("P2_F1", friday, { supersedes: ["P1_F1"] });
    const model = modelFor(
      (part) => ({ text: `${part === 2 ? correction : original}\n\n${overview()}` }),
      { earlier: monday, final: friday },
    );
    const captured = await capture(model, true);
    const { core, meeting, client, parts, text } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "filled",
        omitted: 0,
        unfinishedParts: 0,
        problem: null,
      });
      expectRetained(client, friday, [monday], parts.length);
      const correctedQuote = model.quotes.get(2);
      const replayQuote = model.quotes.get(3);
      if (!correctedQuote || !replayQuote) {
        throw new Error("The correction and replay did not record their current Transcript cues.");
      }
      expect(replayQuote).not.toBe(model.quotes.get(1));
      expect(replayQuote).not.toBe(correctedQuote);
      const citations = mindCitations(client);
      expect(citations.filter((citation) => citation.quote === correctedQuote)).toHaveLength(2);
      expect(citations.filter((citation) => citation.quote === replayQuote)).toEqual([]);
      const cue = text.pages.find((page) => page.text.includes(correctedQuote));
      if (cue?.label?.from === undefined || cue.label.to === undefined) {
        throw new Error("The corrected fact's Transcript cue has no time range.");
      }
      for (const citation of citations.filter((citation) => citation.quote === correctedQuote)) {
        expect(citation).toMatchObject({
          check: "found",
          documentId: text.documentId,
          contentHash: text.contentHash,
          location: {
            kind: "time",
            from: cue.label.from,
            to: cue.label.to,
            speaker: cue.label.speakers?.[0],
          },
        });
      }
      expect(model.calls.find(({ part }) => part === 3)?.call.prompt).toContain('"id":"P2_F1"');
      expect(model.calls.find(({ part }) => part === 3)?.call.prompt).not.toContain('"id":"P1_F1"');
      expectRequests(
        model,
        parts.map(() => 2),
        true,
      );
      await undo(captured);
    } finally {
      core.close();
    }
  });

  test.each([
    { result: "a repeated unchecked identity counts once", recovered: false, omitted: 1 },
    { result: "a later verified identity clears its omission", recovered: true, omitted: 0 },
  ])("$result while retaining checked content", async ({ recovered, omitted }) => {
    const bad = fact("Bad", recovered ? FINAL : UNFINISHED, { citation: 99 });
    const model = modelFor((part) => ({
      text: part < 3 ? bad : `${fact(recovered ? "Bad" : "P3_F1", FINAL)}\n\n${overview()}`,
    }));
    const captured = await capture(model, true);
    const { core, meeting, client, parts } = captured;
    try {
      expect(await settledFill(core, meeting)).toMatchObject({
        state: "filled",
        omitted,
        unfinishedParts: 0,
        problem: null,
      });
      expectRetained(client, FINAL, [EARLIER, UNFINISHED]);
      const quote = model.quotes.get(3);
      if (!quote) throw new Error("The final part did not record its checked Transcript cue.");
      expect(mindCitations(client).filter((citation) => citation.quote === quote)).toHaveLength(2);
      // Only the last part wrote an overview, so there is nothing to make one Summary of.
      expectRequests(
        model,
        parts.map(() => 2),
      );
      await undo(captured);
    } finally {
      core.close();
    }
  });
});
