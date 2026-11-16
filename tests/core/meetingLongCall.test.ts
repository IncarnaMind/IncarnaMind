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
 * `stopsInFrame`: the first reply with room for its part stops inside its second fact.
 */
async function filledCall(summaryQuote: string | null, stopsInFrame = false) {
  const call = (await readFile(CALL, "utf8")).trim().split("\n");
  const said = call.map((line) => {
    const [, who, text] = /^(Me|Them): (.+)$/.exec(line) ?? [];
    if (!who || !text) throw new Error(`Not a line of the call: ${line}`);
    return { who, text };
  });
  const asks: Ask[] = [];
  const summaries: SummaryAsk[] = [];
  let stopped: number | null = null;
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
      const unfinished = [`### FACT P${part}_F2`, "```json", '{"topic":"unfinished"}', "```"];
      return {
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
    const cut = lines.length > ROOM_LINES;
    const stops = stopsInFrame && !cut && stopped === null;
    if (stops) stopped = part;
    asks.push({ part, lines, cut, ...(stops && { stopped: true }) });
    if (cut) return { text: "", cutOff: true };
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
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
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
    return { call, asks, summaries, shown, settled, note, citations };
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
  const { call, asks, summaries, settled, note } = await filledCall(null, true);
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
