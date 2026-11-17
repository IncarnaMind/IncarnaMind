import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import type { Core, Meeting, MeetingFill } from "../../src/core";
import { mindCitations, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { exactly, readMind } from "../helpers/minds";
import { type ScriptedReply, scriptedModel } from "../helpers/models";
import { transcribingCore } from "../helpers/transcription";

/** A 45-minute call between two sides, dense with decisions, of invented people and companies. */
const CALL = fileURLToPath(new URL("../fixtures/meetings/long-dense-call.txt", import.meta.url));

/** The most Transcript lines the scripted model answers in one reply: past it, its reply is cut while thinking. */
const ROOM_LINES = 160;

const OVERVIEW = "The call went through the rollout";

const SUMMARY = "The whole call settled the rollout";

interface Ask {
  part: number;
  /** The Transcript lines the request showed, as "Me: …" or "Them: …". */
  lines: string[];
  cut: boolean;
  /** Its reply closed one fact and stopped inside the next. */
  stopped?: boolean;
}

/** The one request for the whole call's Summary: the Passages it showed and the overviews it listed. */
interface SummaryAsk {
  passages: number;
  overviews: string[];
}

/** The first line a request shows, as a cite record needs it. */
function firstLine(prompt: string) {
  const shown = shownPassages(prompt);
  const cues = shown.flatMap((passage) =>
    passage.text
      .split("\n")
      .filter((line) => line.startsWith("["))
      .map((line) => ({ passage: passage.id, line })),
  );
  const [first] = cues;
  const location = /^\[([^\]]+)\]/.exec(first?.line ?? "")?.[1];
  const quote = first?.line.replace(/^\[[^\]]+\] /, "").split(/(?<=[.?!]) /)[0];
  if (!first || !location || !quote) throw new Error("The request showed no line.");
  return { shown, cues, passage: first.passage, location, quote };
}

async function settledFill(core: Core, meeting: Meeting): Promise<MeetingFill> {
  return vi.waitFor(
    async () => {
      const fill = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!fill || fill.state === "waiting" || fill.state === "filling") {
        throw new Error(`The fill is not settled: ${JSON.stringify(fill)}`);
      }
      return fill;
    },
    { timeout: 30_000 },
  );
}

/**
 * The call recorded, stopped and its notes filled in by a scripted model with room for
 * `ROOM_LINES` lines a reply, then what was asked and what the note holds. `summaryQuote`: what
 * the model's Summary of the whole call quotes, null for words of the first line it is shown.
 * `stopsInFrame`: the first reply with room for its part stops inside its second fact. `cloud`: the
 * model is a service's, not one on this computer, which reads the call as even parts from the
 * start; with `held`, the first answered part's notes wait until a part is sent after them, with
 * `refused`, the request of the answered part of that number is, with `limited`, the service's
 * rate limit refuses the two parts out beside the first answered one, once, and with `firstCut`,
 * the reply to the call's first part has no room, whatever its size. `first`: only that many
 * lines of the call are said.
 */
async function filledCall(
  summaryQuote: string | null,
  {
    stopsInFrame = false,
    cloud = false,
    held = false,
    refused = 0,
    limited = false,
    firstCut = false,
    first,
  }: {
    stopsInFrame?: boolean;
    cloud?: boolean;
    held?: boolean;
    refused?: number;
    limited?: boolean;
    firstCut?: boolean;
    first?: number;
  } = {},
) {
  const call = (await readFile(CALL, "utf8")).trim().split("\n").slice(0, first);
  const said = call.map((line) => {
    const [, who, text] = /^(Me|Them): (.+)$/.exec(line) ?? [];
    if (!who || !text) throw new Error(`Not a line of the call: ${line}`);
    return { who, text };
  });
  const asks: Ask[] = [];
  const summaries: SummaryAsk[] = [];
  let stopped: number | null = null;
  /** The parts whose records are in and whose notes aren't asked for yet, and the most at once. */
  const open = new Set<number>();
  let most = 0;
  let heldPart: number | null = null;
  let release: (() => void) | null = null;
  let released = false;
  let answeredAsks = 0;
  /** The parts the service's rate limit has refused, by their first line. */
  const limits = new Set<string>();
  const model = scriptedModel((call): ScriptedReply => {
    const cited = call.results.some((result) => result.tool === "cite");
    const [, listed] = call.prompt.split("The parts' overviews:\n");
    if (listed !== undefined) {
      if (cited) {
        return {
          text: [
            "### OVERVIEW",
            "```json",
            '{"citations":[1]}',
            "```",
            `${SUMMARY} [^1].`,
            "### END OVERVIEW",
          ].join("\n"),
        };
      }
      const { shown, passage, location, quote } = firstLine(call.prompt);
      summaries.push({
        passages: shown.length,
        overviews: [...listed.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1] ?? ""),
      });
      return {
        calls: [
          {
            tool: "cite",
            input: {
              citations: [{ marker: 1, passage, quote: summaryQuote ?? quote, location }],
            },
          },
        ],
      };
    }
    const part = Number(/Use new ids P(\d+)_F1/.exec(call.prompt)?.[1]);
    if (!part) throw new Error("Unexpected request outside the Meeting's notes.");
    if (cited) {
      open.delete(part);
      const unfinished = [`### FACT P${part}_F2`, "```json", '{"topic":"unfinished"}', "```"];
      let pause: { after: number; until: Promise<void> } | undefined;
      if (part === heldPart) {
        pause = {
          after: 1,
          until: new Promise<void>((resolve) => {
            release = resolve;
          }),
        };
      }
      return {
        ...(pause && { pause }),
        text: [
          `### FACT P${part}_F1`,
          "```json",
          JSON.stringify({
            topic: `point ${part}`,
            heading: "Rollout",
            citations: [1],
            lines: [],
            sections: ["decisions"],
            claim: false,
            supersedes: [],
          }),
          "```",
          `Point ${part} of the rollout was agreed [^1].`,
          `### END P${part}_F1`,
          "",
          "### OVERVIEW",
          "```json",
          '{"citations":[1]}',
          "```",
          `${OVERVIEW}, point ${part} [^1].`,
          "### END OVERVIEW",
          ...(part === stopped ? ["", ...unfinished] : []),
        ].join("\n"),
      };
    }
    const { cues, passage, location, quote } = firstLine(call.prompt);
    const lines = cues.map(({ line }) => line.replace(/^\[\S+ ([^\]]+)\] /, "$1: "));
    const cut = lines.length > ROOM_LINES || (firstCut && asks.length === 0);
    const stops = stopsInFrame && !cut && stopped === null;
    if (stops) stopped = part;
    asks.push({ part, lines, cut, ...(stops && { stopped: true }) });
    if (cut) return { text: "", cutOff: true };
    answeredAsks += 1;
    if (refused === answeredAsks) {
      asks.pop();
      return { error: { status: 400, message: "The scripted provider refused the request." } };
    }
    const [first = ""] = lines;
    if (limited && answeredAsks > 1 && limits.size < 2 && !limits.has(first)) {
      asks.pop();
      limits.add(first);
      return { error: { status: 429, message: "Too many requests." } };
    }
    if (held && heldPart === null) heldPart = part;
    else if (release) {
      released = true;
      release();
    }
    open.add(part);
    most = Math.max(most, open.size);
    return {
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote, location }] } }],
    };
  });
  const { core, capture, clock } = await transcribingCore(await createTempDataFolder(), {
    model,
    engine: {
      lines: said.filter((each) => each.who === "Me").map((each) => each.text),
      theirLines: said.filter((each) => each.who === "Them").map((each) => each.text),
      maxSpeechMs: 500,
    },
  });
  try {
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
    await core.saveChatProvider(
      cloud
        ? { kind: "openai", apiKey: "sk-test", modelId: "gpt-test" }
        : { kind: "ollama", modelId: "local-model" },
    );
    const meeting = await core.createMeeting();
    const client = await connectToMind(core, meeting.mindId);
    await client.settled();
    const before = exactly(client);
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    for (const [index, { who }] of said.entries()) {
      // One side speaks a line while the other is quiet, as on a call.
      clock.advance(500);
      capture.push("microphone", 500, who !== "Me");
      capture.push("system", 500, who === "Me");
      if (index % 20 !== 19) continue;
      await vi.waitFor(async () => {
        const current = (await core.listMeetings()).find((each) => each.id === meeting.id);
        expect(current?.transcript?.lines ?? 0).toBeGreaterThanOrEqual(index - 1);
      });
    }
    const shown: { at: number; of: number }[] = [];
    const unsubscribe = core.on("meetings.changed", (meetings) => {
      const part = meetings.find((each) => each.id === meeting.id)?.fill?.part;
      if (part && JSON.stringify(shown.at(-1)) !== JSON.stringify(part)) shown.push(part);
    });
    await core.stopMeeting(meeting.id);

    const settled = await settledFill(core, meeting);
    unsubscribe();
    const note = readMind(client).textContent;
    const citations = mindCitations(client);
    await core.undoMeetingFill(meeting.id);
    await vi.waitFor(() => expect(exactly(client)).toEqual(before));
    return {
      call,
      asks,
      summaries,
      shown,
      settled,
      note,
      citations,
      most,
      released,
      limits: limits.size,
    };
  } finally {
    core.close();
  }
}

// protects=a 45-minute call dense with decisions gets its notes when a reply has no room for it whole: the call is asked for in parts, a part whose reply is cut while thinking is asked again as two, every line of the call reaches the model once in order with its speaker among the answered parts, and the note has each answered part's fact once, one Summary of the whole call asked for from the parts' overviews in the call's order with one Passage each of them cites, checked Citations, no problem and exact Undo (#3151); fails_when=a cut reply ends the fill with no notes, a line is skipped or sent twice, a part's fact is missing or repeated, the Summary is a paragraph a part, or a problem is shown; no_claim=what a real model writes or how much it thinks, which the pull request's real-model runs show.
test("a 45-minute call gets its notes in parts, a part cut while thinking asked again as two, and one Summary", async () => {
  const { call, asks, summaries, shown, settled, note, citations } = await filledCall(null);
  expect(settled).toMatchObject({
    state: "filled",
    omitted: 0,
    unfinishedParts: 0,
    problem: null,
  });
  // The line says which part the note is on (#2839): each request is the next part, or the same
  // one asked smaller with more parts to come, and the last is the last of them.
  expect(settled.part).toBeUndefined();
  expect(shown).toHaveLength(asks.length);
  for (const [index, ask] of asks.entries()) {
    const at = asks.slice(0, index).filter((before) => !before.cut).length + 1;
    expect(shown[index]?.at).toBe(at);
    const next = shown[index + 1];
    if (!next) continue;
    if (ask.cut) expect(next.of).toBeGreaterThan(shown[index]?.of ?? 0);
    else expect(next.of).toBe(shown[index]?.of);
  }
  expect(shown.at(-1)?.at).toBe(shown.at(-1)?.of);

  const answered = asks.filter((ask) => !ask.cut);
  expect(answered.flatMap((ask) => ask.lines)).toEqual(call);
  // One cut is enough to ask the rest of the call smaller.
  expect(asks.filter((ask) => ask.cut)).toHaveLength(1);
  for (const [index, ask] of asks.entries()) {
    expect(new Set(ask.lines).size).toBe(ask.lines.length);
    if (!ask.cut) continue;
    const halves = [asks[index + 1], asks[index + 2]];
    expect(halves.flatMap((half) => half?.lines ?? [])).toEqual(ask.lines);
    for (const half of halves) expect(half?.lines.length).toBeGreaterThan(0);
  }
  expect(summaries).toEqual([
    {
      passages: answered.length,
      overviews: answered.map(({ part }) => `${OVERVIEW}, point ${part} .`),
    },
  ]);
  expect(note.split(SUMMARY)).toHaveLength(2);
  expect(note).not.toContain(OVERVIEW);
  for (const { part } of answered) {
    expect(note.split(`Point ${part} of the rollout was agreed`)).toHaveLength(2);
  }
  expect(citations.length).toBeGreaterThan(answered.length);
  for (const citation of citations) {
    expect(citation).toMatchObject({ check: "found", location: { kind: "time" } });
  }
});

// protects=a Summary of the whole call whose Citation quotes words the call never said is not written: the note keeps each answered part's own overview once, in the order the call was read, as before the Summary was asked for, with no problem and every Citation found (#3151); fails_when=the unfound Summary goes into the note, the parts' overviews are lost with it, or the fill fails; no_claim=how often a real model's Summary is kept.
test("a whole-call Summary whose Citation isn't found leaves each part's overview", async () => {
  const { asks, summaries, settled, note, citations } = await filledCall(
    "words nobody said on this call",
  );
  expect(settled).toMatchObject({ state: "filled", unfinishedParts: 0, problem: null });
  const answered = asks.filter((ask) => !ask.cut);
  expect(summaries).toHaveLength(1);
  expect(note).not.toContain(SUMMARY);
  expect([...note.matchAll(/, point (\d+)/g)].map((match) => Number(match[1]))).toEqual(
    answered.map((ask) => ask.part),
  );
  expect(note.split(OVERVIEW)).toHaveLength(answered.length + 1);
  for (const citation of citations) expect(citation).toMatchObject({ check: "found" });
});

// protects=a part's reply that closes some facts and stops inside the next one, with no cut reported, doesn't pass for the whole part: the part is asked again as two, the facts the reply closed are kept once, every line of the call still reaches an answered request once, the stopped reply's overview is not listed for the Summary, and nothing is counted as left out (#3151); fails_when=the stopped reply is taken as the part's notes, so the rest of its lines get none, or the kept fact is written twice; no_claim=how often a real model stops inside a frame.
test("a reply that stops inside a fact is asked again as two, keeping the facts it closed", async () => {
  const { call, asks, summaries, settled, note } = await filledCall(null, { stopsInFrame: true });
  expect(settled).toMatchObject({
    state: "filled",
    omitted: 0,
    unfinishedParts: 0,
    problem: null,
  });
  const index = asks.findIndex((ask) => ask.stopped);
  const stoppedAsk = asks[index];
  if (!stoppedAsk) throw new Error("No reply stopped inside a fact.");
  const halves = [asks[index + 1], asks[index + 2]];
  expect(halves.flatMap((half) => half?.lines ?? [])).toEqual(stoppedAsk.lines);
  for (const half of halves) expect(half?.lines.length).toBeGreaterThan(0);
  const answered = asks.filter((ask) => !ask.cut && !ask.stopped);
  expect(answered.flatMap((ask) => ask.lines)).toEqual(call);
  expect(summaries).toEqual([
    {
      passages: answered.length,
      overviews: answered.map(({ part }) => `${OVERVIEW}, point ${part} .`),
    },
  ]);
  for (const { part } of [stoppedAsk, ...answered]) {
    expect(note.split(`Point ${part} of the rollout was agreed`)).toHaveLength(2);
  }
  expect(note).not.toContain("unfinished");
});

/** The answered asks in the call's order, with where each one's lines start in the call. */
function inCallOrder(call: readonly string[], asks: readonly Ask[]) {
  return asks
    .filter((ask) => !ask.cut && !ask.stopped)
    .map((ask) => ({
      ...ask,
      from: call.findIndex((_, at) => ask.lines.every((line, index) => call[at + index] === line)),
    }))
    .sort((one, other) => one.from - other.from);
}

// protects=on a service's model the parts of a long call are asked side by side, at most three at once, and the notes are those of the parts asked one after another: a part is sent while an earlier one is still being written, every line of the call reaches an answered request once, each answered part's fact is in the note once, the Summary is asked from the parts' overviews in the call's order although the first part's notes came in last, and the line names the first part not yet kept, never going back and ending on the last part (#2839); fails_when=the parts wait for each other, more than three are out at once, a line is skipped or sent twice, the overviews are listed in the order the replies came in, or the line stops short of the last part while the last ones are read; no_claim=how much shorter a real model's wait is, which the pull request's real-model runs show.
test("a service's model is asked for up to three parts at once, and the notes keep the call's order", async () => {
  const { call, asks, summaries, shown, settled, note, most, released } = await filledCall(null, {
    cloud: true,
    held: true,
  });
  expect(settled).toMatchObject({
    state: "filled",
    omitted: 0,
    unfinishedParts: 0,
    problem: null,
  });
  expect(most).toBeGreaterThan(1);
  expect(most).toBeLessThanOrEqual(3);
  expect(released).toBe(true);
  expect(shown.length).toBeGreaterThan(1);
  for (const [index, place] of shown.entries()) {
    expect(place.at).toBeGreaterThanOrEqual(shown[index - 1]?.at ?? 1);
    expect(place.at).toBeLessThanOrEqual(place.of);
  }
  const last = shown.at(-1);
  expect(last?.at).toBe(last?.of);
  const answered = inCallOrder(call, asks);
  expect(answered.flatMap((ask) => ask.lines)).toEqual(call);
  expect(summaries).toEqual([
    {
      passages: answered.length,
      overviews: answered.map(({ part }) => `${OVERVIEW}, point ${part} .`),
    },
  ]);
  for (const { part } of answered) {
    expect(note.split(`Point ${part} of the rollout was agreed`)).toHaveLength(2);
  }
});

// protects=when one of the parts asked side by side is refused, no new part is sent, the parts already out are kept, and the note says how many parts got no notes: the refused one and each never sent (#2839); fails_when=the answered parts' notes are dropped with the refused one, parts go on being sent to a service that refuses, or the count misses a part; no_claim=which of a service's failures come back refused.
test("a part refused beside others leaves the answered parts' notes and counts the rest", async () => {
  const { call, asks, summaries, shown, settled, note } = await filledCall(null, {
    cloud: true,
    refused: 2,
  });
  const answered = inCallOrder(call, asks);
  expect(answered.length).toBeGreaterThan(1);
  const lines = answered.reduce((sum, ask) => sum + ask.lines.length, 0);
  expect(lines).toBeLessThan(call.length);
  expect(settled).toMatchObject({ state: "filled", problem: { kind: "model" } });
  expect(settled.unfinishedParts).toBe((shown.at(-1)?.of ?? 0) - answered.length);
  expect(settled.unfinishedParts).toBeGreaterThan(1);
  expect(summaries).toEqual([]);
  for (const { part } of answered) {
    expect(note.split(`Point ${part} of the rollout was agreed`)).toHaveLength(2);
  }
});

// protects=a key whose rate limit refuses parts asked side by side still gets the whole call's notes: both parts it refuses of the ones out together are asked again, one at a time, with no problem shown and every line answered once (#2839); fails_when=a refusal ends the fill with parts left without notes, only the first refused part of those out together is asked again, or a refused part's lines are never answered; no_claim=which services' limits a fill of three parts at once meets.
test("a rate limit that refuses a part beside others has it asked again, the rest one at a time", async () => {
  const { call, asks, settled, note, limits, most } = await filledCall(null, {
    cloud: true,
    limited: true,
  });
  expect(settled).toMatchObject({
    state: "filled",
    omitted: 0,
    unfinishedParts: 0,
    problem: null,
  });
  expect(limits).toBe(2);
  expect(most).toBe(1);
  const answered = inCallOrder(call, asks);
  expect(answered.flatMap((ask) => ask.lines)).toEqual(call);
  for (const { part } of answered) {
    expect(note.split(`Point ${part} of the rollout was agreed`)).toHaveLength(2);
  }
});

// protects=a part refused while an earlier part waits to be asked again as two doesn't cost that part its notes: the halves before the refused part in the call are still asked and kept, and the refused part and each part never sent are the ones counted without notes (#2839); fails_when=the refusal stops the earlier part's halves from being sent, so the call's start has no notes or the fill fails whole; no_claim=what a service refuses.
test("a part refused out of turn still lets the parts before it be asked", async () => {
  const { call, asks, shown, settled, note } = await filledCall(null, {
    cloud: true,
    firstCut: true,
    refused: 2,
  });
  expect(settled).toMatchObject({ state: "filled", problem: { kind: "model" } });
  expect(asks.filter((ask) => ask.cut)).toHaveLength(1);
  const answered = inCallOrder(call, asks);
  expect(answered).toHaveLength(3);
  expect(settled.unfinishedParts).toBe((shown.at(-1)?.of ?? 0) - answered.length);
  const lines = answered.flatMap((ask) => ask.lines);
  expect(lines).toEqual(call.slice(0, lines.length));
  expect(lines.length).toBeLessThan(call.length);
  for (const { part } of answered) {
    expect(note.split(`Point ${part} of the rollout was agreed`)).toHaveLength(2);
  }
});

// protects=on a service's model a call of some twenty minutes dense with decisions is read as two parts of about the same size from the start, side by side, every line once in order and one Summary, where a call two thirds as long is still one request, and a model on this computer still reads the longer one whole (#3251); fails_when=a short call is split, the longer call waits for a reply to run out of room before it is read in parts, the parts are uneven or sent one after another, or a model on this computer is asked for more parts; no_claim=how many facts a real model writes for a part.
test("a service's model reads a twenty-minute call as two even parts from the start, and a twelve-minute call whole", async () => {
  // 80 lines are some 2,700 Transcript tokens: two parts of that size cost more and wrote no more.
  const short = await filledCall(null, { cloud: true, first: 80 });
  expect(short.settled).toMatchObject({ state: "filled", unfinishedParts: 0, problem: null });
  expect(short.asks.map((ask) => ask.lines)).toEqual([short.call]);
  expect(short.summaries).toEqual([]);

  const long = await filledCall(null, { cloud: true, first: 120 });
  expect(long.settled).toMatchObject({
    state: "filled",
    omitted: 0,
    unfinishedParts: 0,
    problem: null,
  });
  expect(long.asks.map((ask) => ask.cut)).toEqual([false, false]);
  expect(long.most).toBe(2);
  const [one, other] = inCallOrder(long.call, long.asks);
  expect([...(one?.lines ?? []), ...(other?.lines ?? [])]).toEqual(long.call);
  expect(Math.abs((one?.lines.length ?? 0) - (other?.lines.length ?? 0))).toBeLessThan(20);
  expect(long.summaries).toHaveLength(1);

  const local = await filledCall(null, { first: 120 });
  expect(local.settled).toMatchObject({ state: "filled", unfinishedParts: 0, problem: null });
  expect(local.asks.map((ask) => ask.lines)).toEqual([local.call]);
});
