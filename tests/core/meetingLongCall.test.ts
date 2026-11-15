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
const ROOM_LINES = 120;

const OVERVIEW = "The call went through the rollout";

interface Ask {
  part: number;
  /** The Transcript lines the request showed, as "Me: …" or "Them: …". */
  lines: string[];
  cut: boolean;
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

// protects=a 45-minute call dense with decisions gets its notes when a reply has no room for it whole: the call is asked for in parts, a part whose reply is cut while thinking is asked again as two, every line of the call reaches the model once in order with its speaker among the answered parts, and the note has one overview, each part's fact once, checked Citations, no problem and exact Undo (#3151); fails_when=a cut reply ends the fill with no notes, a line is skipped or sent twice, the overview or a fact is repeated, or a problem is shown; no_claim=what a real model writes or how much it thinks, which the pull request's real-model runs show.
test("a 45-minute call gets its notes in parts, a part cut while thinking asked again as two", async () => {
  const call = (await readFile(CALL, "utf8")).trim().split("\n");
  const said = call.map((line) => {
    const [, who, text] = /^(Me|Them): (.+)$/.exec(line) ?? [];
    if (!who || !text) throw new Error(`Not a line of the call: ${line}`);
    return { who, text };
  });
  const asks: Ask[] = [];
  const model = scriptedModel((call): ScriptedReply => {
    const part = Number(/Use new ids P(\d+)_F1/.exec(call.prompt)?.[1]);
    if (!part) throw new Error("Unexpected request outside the Meeting's notes.");
    if (call.results.some((result) => result.tool === "cite")) {
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
          `${OVERVIEW} [^1].`,
          "### END OVERVIEW",
        ].join("\n"),
      };
    }
    const shown = shownPassages(call.prompt);
    const cues = shown.flatMap((passage) =>
      passage.text
        .split("\n")
        .filter((line) => line.startsWith("["))
        .map((line) => ({ passage: passage.id, line })),
    );
    const lines = cues.map(({ line }) => line.replace(/^\[\S+ ([^\]]+)\] /, "$1: "));
    const cut = lines.length > ROOM_LINES;
    asks.push({ part, lines, cut });
    if (cut) return { text: "", cutOff: true };
    const [first] = cues;
    const location = /^\[([^\]]+)\]/.exec(first?.line ?? "")?.[1];
    const quote = first?.line.replace(/^\[[^\]]+\] /, "").split(/(?<=[.?!]) /)[0];
    if (!first || !location || !quote) throw new Error(`Part ${part} showed no line.`);
    return {
      calls: [
        {
          tool: "cite",
          input: { citations: [{ marker: 1, passage: first.passage, quote, location }] },
        },
      ],
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
    await core.stopMeeting(meeting.id);

    expect(await settledFill(core, meeting)).toMatchObject({
      state: "filled",
      omitted: 0,
      unfinishedParts: 0,
      problem: null,
    });

    const answered = asks.filter((ask) => !ask.cut);
    expect(answered.flatMap((ask) => ask.lines)).toEqual(call);
    expect(asks.some((ask) => ask.cut)).toBe(true);
    for (const [index, ask] of asks.entries()) {
      expect(new Set(ask.lines).size).toBe(ask.lines.length);
      if (!ask.cut) continue;
      const halves = [asks[index + 1], asks[index + 2]];
      expect(halves.flatMap((half) => half?.lines ?? [])).toEqual(ask.lines);
      for (const half of halves) expect(half?.lines.length).toBeGreaterThan(0);
    }
    const note = readMind(client).textContent;
    expect(note.split(OVERVIEW)).toHaveLength(2);
    for (const { part } of answered) {
      expect(note.split(`Point ${part} of the rollout was agreed`)).toHaveLength(2);
    }
    expect(mindCitations(client).length).toBeGreaterThan(answered.length);
    for (const citation of mindCitations(client)) {
      expect(citation).toMatchObject({ check: "found", location: { kind: "time" } });
    }

    await core.undoMeetingFill(meeting.id);
    await vi.waitFor(() => expect(exactly(client)).toEqual(before));
  } finally {
    core.close();
  }
});
