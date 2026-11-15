import { describe, expect, test, vi } from "vitest";
import type { Core, Meeting, MeetingFill, SystemNotifications } from "../../src/core";
import { withoutOverlap } from "../../src/core/answers/documentText";
import { buildPassages } from "../../src/core/documents/passages";
import type { WindowedPassage } from "../../src/core/documents/search";
import type { Language } from "../../src/core/language";
import { FILL_PART_TOKENS, transcriptParts } from "../../src/core/meetings/fill";
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
const LONG_CUES = 40;

function fact(
  id: string,
  text: string,
  { citation = 1, supersedes = [] }: { citation?: number; supersedes?: unknown } = {},
): string {
  return [
    `### FACT ${id}`,
    "```json",
    JSON.stringify({
      topic: "review schedule",
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

function overview(): string {
  return [
    "### OVERVIEW",
    "```json",
    '{"citations":[2]}',
    "```",
    `${OVERVIEW} [^2].`,
    "### END OVERVIEW",
  ].join("\n");
}

interface PartReply {
  text: string;
  cutOff?: boolean;
  streamError?: boolean;
  error?: boolean;
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
  const model = scriptedModel((call): ScriptedReply => {
    const part = Number(/Use new ids P(\d+)_F1/.exec(call.prompt)?.[1]);
    if (!part) throw new Error("Unexpected request outside the Meeting fact Run.");
    calls.push({ part, call });
    const next = reply(part);
    if (next.error) return { error: { status: 503, message: "The scripted provider stopped." } };
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
    return { text: `HEADINGS: H1=NONE\n\n${next.text}`, ...(next.cutOff && { cutOff: true }) };
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
  return { model, calls, quotes, feedback, schedule };
}

async function capture(
  model: ReturnType<typeof modelFor>,
  long = false,
  name: string | null = null,
  {
    language,
    notifications,
    short,
    linesRepeated,
  }: {
    language?: Language;
    notifications?: SystemNotifications;
    /** This many lines of ordinary length, a sentence or two each, instead of one. */
    short?: number;
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
          `Workshop item ${index + 1}: ${index < 4 ? schedule.earlier : schedule.final}. ${PURPOSE}. ${UNFINISHED}. ${padding}`,
      )
    : Array.from(
        { length: short ?? 1 },
        (_, index) =>
          `Workshop item ${index + 1}: ${index < 4 ? schedule.earlier : schedule.final}. ${PURPOSE}. ${UNFINISHED}.`,
      );
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    model: model.model,
    engine: { lines: [...lines, "The workshop is closed"], maxSpeechMs: 500 },
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
  while (recorded < lines.length + 1) {
    const count = Math.min(20, lines.length + 1 - recorded);
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

function expectRequests(model: ReturnType<typeof modelFor>, counts: number[]): void {
  expect(
    model.calls.map(({ part }) => part),
    model.feedback.join("\n"),
  ).toEqual(counts.flatMap((count, index) => Array.from({ length: count }, () => index + 1)));
  expect(model.model.doStreamCalls).toHaveLength(counts.reduce((sum, count) => sum + count, 0));
  expect(model.model.doGenerateCalls).toHaveLength(0);
}

function expectRetained(client: MindClient, full: string, absent: string[] = []): void {
  const doc = readMind(client);
  expect(doc.textContent.split(full)).toHaveLength(2);
  expect(doc.textContent.split(OVERVIEW)).toHaveLength(2);
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
  test.each(["provider failure", "output truncation"] as const)(
    "closed checked frames survive %s without the unfinished sibling or a recovery request",
    async (failure) => {
      const model = modelFor(() => ({
        text: [
          fact("P1_review", EARLIER),
          overview(),
          fact("P1_checklist", UNFINISHED).replace("### END P1_checklist", ""),
        ].join("\n\n"),
        ...(failure === "provider failure" ? { streamError: true } : { cutOff: true }),
      }));
      const captured = await capture(model);
      const { core, meeting, client } = captured;
      try {
        const fill = await settledFill(core, meeting);
        expect(
          fill.state,
          JSON.stringify({ fill, calls: model.calls.length, feedback: model.feedback }),
        ).toBe("filled");
        await vi.waitFor(() => expectRetained(client, EARLIER, [UNFINISHED]));
        expectRequests(model, [2]);
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
        expectRequests(model, [2, 1]);
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

  test("a later checked correction replaces the prior fact once, with its new Citation and one overview and Undo", async () => {
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
      expectRetained(client, FINAL, [EARLIER]);
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
        expectRetained(client, EARLIER, [FINAL]);
        expect(mindCitations(client).filter((citation) => citation.quote?.includes(FINAL))).toEqual(
          [],
        );
        expectRequests(
          model,
          parts.map(() => 2),
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
      expectRetained(client, `${name} noted that the review is on Tuesday`, ["{{me}}"]);
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
    const items = 80;
    const { core, meeting } = await capture(model, false, null, { short: items });
    try {
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", problem: null });
      expect(itemsShown(model, 1)).toEqual(Array.from({ length: items }, (_, index) => index + 1));
    } finally {
      core.close();
    }
  });

  // protects=the evaluation's arm for the notes as before #3151 really sends the Passages as they overlap, so a paired run compares what it says it does; fails_when=the arm sends each line once, like today's path, or drops a line; no_claim=what the overlap costs a real model.
  test("the evaluation's as-before arm sends the lines the Passages share twice", async () => {
    const model = modelFor(() => ({ text: `${fact("P1_review", EARLIER)}\n\n${overview()}` }));
    const items = 80;
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

  // protects=a part whose reply is cut off is asked again as two, in reading order and each line once; the facts and overview the cut reply closed are kept and shown to both halves, the item it never closed isn't counted as left out since its lines are read again, and the note ends with no problem and exact Undo (#3151); fails_when=the fill stops at the cut reply, a kept fact is lost or written twice, the unfinished item is counted, or a line of the part is skipped or repeated; no_claim=how often a real model's reply is cut.
  test("a part whose reply is cut off is asked again as two, and what it wrote is kept", async () => {
    const model = modelFor((part) =>
      part === 1
        ? {
            text: [
              fact("P1_review", EARLIER),
              overview(),
              fact("P1_checklist", UNFINISHED).replace("### END P1_checklist", ""),
            ].join("\n\n"),
            cutOff: true,
          }
        : { text: overview() },
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
      expectRetained(client, EARLIER, [UNFINISHED]);
      const halves = [itemsShown(model, 2), itemsShown(model, 3)];
      for (const half of halves) expect(half.length).toBeGreaterThan(0);
      expect(halves.flat()).toEqual(itemsShown(model, 1));
      for (const part of [2, 3]) {
        expect(model.calls.find((each) => each.part === part)?.call.prompt).toContain(
          '"id":"P1_review"',
        );
      }
      expectRequests(
        model,
        Array.from({ length: parts.length + 2 }, () => 2),
      );
      const asked = Array.from({ length: parts.length + 1 }, (_, index) => index + 2);
      expect(asked.flatMap((part) => itemsShown(model, part))).toEqual(
        Array.from({ length: LONG_CUES }, (_, index) => index + 1),
      );
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
      expectRetained(client, friday, [monday]);
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
