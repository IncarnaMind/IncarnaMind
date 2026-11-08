/**
 * After Stop, a Meeting's notes filled in from its Transcript (#142), through the core's public
 * interface as the meeting bar uses it: under each of the User's lines, or in sections when there
 * are none, every retained addition AI text citing the Transcript, one Undo, and nothing written
 * when no safe item survives, a quit cuts it short, or Local mode keeps it off the cloud.
 */
import { getEventListeners } from "node:events";
import { wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import type {
  ChatModelFactory,
  Core,
  Meeting,
  MeetingFill,
  SpeakerSeparator,
} from "../../src/core";
import { CITE_RETRY_INSTRUCTIONS, QUOTE_RETRY_INSTRUCTIONS } from "../../src/core/answers/prompt";
import type { WindowedPassage } from "../../src/core/documents/search";
import type { FakeCaptureOptions } from "../../src/core/meetings/fakeCapture";
import { FILL_PART_TOKENS, orStopped, transcriptParts } from "../../src/core/meetings/fill";
import type { FillSection } from "../../src/core/meetings/fillPrompt";
import { createFakeChatModel } from "../../src/main/fakeChat";
import { citationAttributesOf } from "../../src/shared/citations";
import { clockTime } from "../../src/shared/clock";
import { translate } from "../../src/shared/i18n";
import { setMindModel } from "../../src/shared/mindModel";
import { pendingProposals } from "../../src/shared/proposals";
import { checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { mindCitations, shownPassages, transcriptCitations } from "../helpers/citations";
import { createMemoryKeychain, createTempDataFolder, saveProviderUnasked } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import {
  editMind,
  exactly,
  heading,
  note,
  readMind,
  shownWithAiText,
  writeMind,
} from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { fakeSeparator, savedCues, transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const MY_LINES = [
  "We agreed the enterprise price is 45 dollars a seat",
  "Dana will send the contract by Friday",
  "The rollout starts in the second quarter",
];
const THEIR_LINES = ["The budget is approved for this year", "We still need the security review"];
/** A call held in Chinese: what the microphone and the computer's sound say in turn. */
const CHINESE_LINES = {
  mine: ["我们同意企业版每个席位 45 美元", "周五之前我把合同寄过去", "第二季度开始上线"],
  theirs: ["今年的预算已经批了", "安全审查还没做"],
} as const;

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null;

const isFill = (call: ModelCall) =>
  call.prompt.includes("Fill them in from the transcript") || call.prompt.includes("took no notes");

/** A fill's first request, before its records: one per time the notes are made. */
const fillRun = (call: ModelCall) =>
  isFill(call) && !call.results.some((result) => result.tool === "cite");

function fact(
  id: string,
  topic: string,
  body: string,
  {
    heading,
    lines = [],
    sections = [],
    claim = false,
    citations = [...body.matchAll(/\[\^(\d+)\]/g)].map((match) => Number(match[1])),
  }: {
    heading?: string;
    lines?: string[];
    sections?: FillSection[];
    claim?: boolean;
    citations?: number[];
  } = {},
): string {
  return [
    `### FACT ${id}`,
    "```json",
    JSON.stringify({
      topic,
      ...(heading !== undefined && { heading }),
      citations: [...new Set(citations)],
      lines,
      sections,
      claim,
      supersedes: [],
    }),
    "```",
    body,
    `### END ${id}`,
  ].join("\n");
}

function overview(body: string, citations?: number[]): string {
  return [
    "### OVERVIEW",
    "```json",
    JSON.stringify({
      citations: citations ?? [...body.matchAll(/\[\^(\d+)\]/g)].map((match) => Number(match[1])),
    }),
    "```",
    body,
    "### END OVERVIEW",
  ].join("\n");
}

const lineFact = (line: string, topic: string, body: string) =>
  fact(`P1_${line}`, topic, body, { lines: [line] });

function expectNoCitationRepair(model: ReturnType<typeof scriptedModel>): void {
  const calls = [...model.doStreamCalls, ...model.doGenerateCalls];
  for (const instructions of [CITE_RETRY_INSTRUCTIONS, QUOTE_RETRY_INSTRUCTIONS]) {
    expect(
      calls.filter((call) => JSON.stringify(call.prompt).includes(instructions.slice(0, 80))),
    ).toEqual([]);
  }
}

/**
 * A model that fills notes in as `reply` says, citing the transcript lines `quotes` names by
 * marker, and checks claims as `plans` say.
 */
function fillingModel(
  reply: string | ((prompt: string) => string),
  quotes: Record<number, string>,
  plans: Record<string, Plan> = {},
  {
    failing = () => false,
    error = { status: 500, message: "The model is overloaded." },
    held,
    seen,
  }: {
    failing?: () => boolean;
    /** What a failing fill request gets back. */
    error?: { status: number; message: string };
    held?: Promise<void>;
    seen?: (call: ModelCall) => void;
  } = {},
) {
  return scriptedModel((call) => {
    seen?.(call);
    if (isCheckRun(call)) return checkReply(call, plans);
    if (!isFill(call)) return { text: "OK" };
    if (failing()) return { error };
    const shown = shownPassages(block(call.prompt, "live-transcript") ?? "");
    const citations = transcriptCitations(call, shown, quotes);
    if (citations) return citations;
    const text = typeof reply === "string" ? reply : reply(call.prompt);
    return { text, ...(held && { pause: { after: 0, until: held } }) };
  });
}

/**
 * A Meeting with notes `notes` (none: an empty Mind), recorded for 12 seconds and stopped; the
 * microphone says `lines.mine` in turn and the computer's sound `lines.theirs`.
 */
async function recorded(
  model: ReturnType<typeof scriptedModel>,
  notes: Parameters<typeof writeMind>[1] | null,
  before?: (core: Core) => Promise<void>,
  inMind?: (client: MindClient) => void,
  {
    speakerSeparator,
    lines = { mine: MY_LINES, theirs: THEIR_LINES },
    createChatModel,
    stop = (core, meetingId) => core.stopMeeting(meetingId),
    capture,
    cloud = false,
    keychain,
    notesBeforeSpeakers,
  }: {
    speakerSeparator?: SpeakerSeparator;
    /** How Stop is pressed. */
    stop?: (core: Core, meetingId: string) => Promise<unknown>;
    /** Claude Haiku 5.5 on its service, allowed, as the Answers model: a model off this computer. */
    cloud?: boolean;
    /** The keychain its key is kept with, for a start after this one that reads it. */
    keychain?: ReturnType<typeof createMemoryKeychain>;
    /** What the fake capture does: the computer's sound silent, for a recording of a room. */
    capture?: FakeCaptureOptions;
    /** Whether a call's notes start before its speakers are told apart: unset, the default. */
    notesBeforeSpeakers?: () => boolean;
    lines?: { mine: readonly string[]; theirs: readonly string[] };
    /** Models made from each spec, around `model`. */
    createChatModel?: ChatModelFactory;
  } = {},
) {
  const dataDir = await createTempDataFolder();
  const { core, record } = await transcribingCore(dataDir, {
    model,
    engine: { lines: lines.mine, theirLines: lines.theirs },
    ...(speakerSeparator && { speakerSeparator }),
    ...(createChatModel && { createChatModel }),
    ...(capture && { capture }),
    ...(keychain && { keychain }),
    ...(notesBeforeSpeakers && { notesBeforeSpeakers }),
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  if (cloud) {
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    for (const flow of ["chat", "checks"] as const) {
      if (saved.service) await core.allowDataFlow(flow, saved.service.id);
    }
    await core.updateSettings({
      user: { chatModel: { providerId: saved.id, modelId: "claude-haiku-5-5" } },
    });
  }
  await before?.(core);
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  if (notes) writeMind(client, notes);
  inMind?.(client);
  await client.settled();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(12 * SECOND);
  await vi.waitFor(async () => {
    const live = (await core.listMeetings()).find((each) => each.id === meeting.id);
    expect(live?.transcript?.lines ?? 0).toBeGreaterThanOrEqual(5);
  });
  await stop(core, meeting.id);
  return { core, meeting, client, dataDir };
}

async function fillOf(core: Core, meetingId: string): Promise<MeetingFill | null> {
  return (await core.listMeetings()).find((each) => each.id === meetingId)?.fill ?? null;
}

async function settledFill(core: Core, meeting: Meeting): Promise<MeetingFill> {
  return vi.waitFor(
    async () => {
      const fill = await fillOf(core, meeting.id);
      if (!fill || fill.state === "waiting" || fill.state === "filling") {
        throw new Error(`Not yet: ${JSON.stringify(fill)}`);
      }
      return fill;
    },
    { timeout: 20_000 },
  );
}

/** The Mind's lines as shown, AI text in «», a Citation as \uFFFC. */
/** The Note's top-level Blocks as read: a heading with ##, a bullet with -, AI text in «». */
const outline = (client: MindClient) => {
  const lines: string[] = [];
  readMind(client).forEach((block) => {
    if (block.type.name === "heading") lines.push(`## ${shownWithAiText(block)}`);
    else if (block.type.name === "bulletList") {
      block.forEach((item) => {
        lines.push(`- ${item.firstChild ? shownWithAiText(item.firstChild) : ""}`);
      });
    } else lines.push(shownWithAiText(block));
  });
  return lines;
};

const shown = (client: MindClient) => {
  const lines: string[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      lines.push(shownWithAiText(node));
      return false;
    }
    return true;
  });
  return lines;
};

const citationsShownAs = (client: MindClient, text: string) => {
  const found: ReturnType<typeof citationAttributesOf>[][] = [];
  readMind(client).descendants((node) => {
    if (node.type.name !== "paragraph") return true;
    if (shownWithAiText(node) === text) {
      const citations: ReturnType<typeof citationAttributesOf>[] = [];
      node.descendants((child) => {
        if (child.type.name === "citation") citations.push(citationAttributesOf(child.attrs));
      });
      found.push(citations);
    }
    return false;
  });
  return found;
};

/** A reply that fills the first of `NOTES`' lines in, with its overview. */
const PRICING_REPLY = [
  lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
  overview("The call covered pricing [^1]."),
].join("\n\n");

const NOTES = [
  heading(2, "Pricing"),
  note("price → Q2?"),
  note("contract"),
  heading(2, "Rollout"),
  note("start date"),
];

describe("After Stop, the notes are filled in from the Transcript (#142)", {
  timeout: 60_000,
}, () => {
  // protects=in a call, the notes start from the saved Transcript while its speakers are told apart (#2773), but nothing is written until the pass ends, and when it renames no one the notes are made once; fails_when=the fill waits for the pass before its request, writes before the pass ends, or is made twice; no_claim=the pass's labels, which tests/core/speakerPass.test.ts covers.
  test("a call's notes start while its speakers are told apart and are written once the pass renames no one", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let passing = true;
    const asked: boolean[] = [];
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { seen: (call) => fillRun(call) && asked.push(passing) },
    );
    const { separator, requests } = fakeSeparator({ holds, voiceOf: () => 0 });
    const writtenWhile: boolean[] = [];
    const { core, meeting, client } = await recorded(
      model,
      NOTES,
      async (core) => {
        core.on("meetings.changed", (meetings) => {
          const fill = meetings.find((each) => each.kind === "meeting")?.fill;
          if (fill?.state === "filled" && writtenWhile.length === 0) writtenWhile.push(passing);
        });
      },
      undefined,
      { speakerSeparator: separator, cloud: true },
    );
    const before = shown(client);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.waitFor(() => expect(asked).toEqual([true]));
    await vi.waitFor(() =>
      expect(model.doStreamCalls.length + model.doGenerateCalls.length).toBeGreaterThanOrEqual(2),
    );
    await client.settled();
    expect(await fillOf(core, meeting.id)).toMatchObject({ state: "waiting" });
    expect(shown(client)).toEqual(before);
    passing = false;
    release();
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 0 });
    expect(writtenWhile).toEqual([false]);
    expect(shown(client)).toContain("«The enterprise price is 45 dollars a seat »\uFFFC«.»");
    expect(asked).toEqual([true]);
    core.close();
  });

  // protects=with the notes held until the speakers are told apart, as before #2773 and as the evaluation's baseline arm runs, a call's fill sends nothing while the pass runs; fails_when=the switch is ignored and the request goes out during the pass; no_claim=which way the app ships, which the default covers.
  test("with the notes held for the speakers, a call's fill waits for the pass", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let passing = true;
    const asked: boolean[] = [];
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { seen: (call) => fillRun(call) && asked.push(passing) },
    );
    const { separator, requests } = fakeSeparator({ holds, voiceOf: () => 0 });
    const { core, meeting } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
      cloud: true,
      notesBeforeSpeakers: () => false,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "saved" && transcript.separating,
    );
    expect((await fillOf(core, meeting.id))?.state).toBe("waiting");
    passing = false;
    release();
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 0 });
    expect(asked).toEqual([false]);
    core.close();
  });

  // protects=a model on this computer, which the pass would share it with, waits for the speakers to be told apart before its request, as before (#2773); fails_when=its request goes out while the pass runs; no_claim=the pass's labels.
  test("on a model on this computer, a call's notes wait for its speakers to be told apart", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let passing = true;
    const asked: boolean[] = [];
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { seen: (call) => fillRun(call) && asked.push(passing) },
    );
    const { separator, requests } = fakeSeparator({ holds, voiceOf: () => 0 });
    const { core, meeting } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "saved" && transcript.separating,
    );
    expect((await fillOf(core, meeting.id))?.state).toBe("waiting");
    passing = false;
    release();
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 0 });
    expect(asked).toEqual([false]);
    core.close();
  });

  // protects=when the speaker pass renames who spoke a line, notes made before it ended are dropped and made again from the renamed Transcript, so the Citations written name the final speakers (#2773, #138); fails_when=the notes made before the rename are written, or their Citations keep the old label; no_claim=the pass's labels.
  test("a call whose pass renames a line is filled again from the renamed Transcript, its Citations naming the new speakers", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let passing = true;
    const asked: boolean[] = [];
    const said = THEIR_LINES[0] as string;
    const marks: string[] = [];
    const model = scriptedModel((call) => {
      if (isCheckRun(call)) return checkReply(call, {});
      if (!isFill(call)) return { text: "OK" };
      if (fillRun(call)) {
        asked.push(passing);
        const passage = shownPassages(block(call.prompt, "live-transcript") ?? "").find((each) =>
          each.text.includes(said),
        );
        const mark = passage?.text
          .match(/\[(\d{1,2}:\d{2}) ([^\]]+)\] /g)
          ?.find((each) => passage.text.includes(`${each}${said}`));
        const location = mark?.slice(1, -2) ?? "";
        marks.push(location);
        const citations = [{ marker: 1, passage: passage?.id, location, quote: said }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return {
        text: [
          overview("The call covered the budget [^1]."),
          fact("P1_budget", "budget", "The budget is approved for this year [^1].", {
            sections: ["decisions"],
          }),
        ].join("\n\n"),
      };
    });
    const { separator, requests } = fakeSeparator({ holds });
    const { core, meeting, client } = await recorded(model, null, undefined, undefined, {
      speakerSeparator: separator,
      cloud: true,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.waitFor(() => expect(asked).toEqual([true]));
    passing = false;
    release();
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 0 });
    expect(asked).toEqual([true, false]);
    expect(marks).toEqual(["0:00 Them", "0:00 Speaker 1"]);
    const final = (await savedCues(core, meeting.id)).find((cue) => cue.text === said);
    expect(final?.speaker).toBe("Speaker 1");
    const cited = mindCitations(client).filter((each) => each.quote === said);
    expect(cited.length).toBeGreaterThan(0);
    for (const citation of cited) {
      expect(citation.location).toMatchObject({ kind: "time", speaker: "Speaker 1" });
    }
    core.close();
  });

  // protects=when the speaker pass renames a line while the notes made before it are checking their claims, those checks are stopped and the notes are made again at once, without waiting for them (#2773); fails_when=the second fill request waits for the first fill's claim checks to end; no_claim=what the checks would have said.
  test("a pass that renames a line while the first notes check their claims makes them again at once", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answer = () => {};
    const checksHeld = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let checks = 0;
    let passing = true;
    const asked: boolean[] = [];
    const said = THEIR_LINES[0] as string;
    const model = scriptedModel((call) => {
      if (isCheckRun(call)) {
        checks++;
        return { text: "unsupported", pause: { after: 0, until: checksHeld } };
      }
      if (!isFill(call)) return { text: "OK" };
      if (fillRun(call)) {
        asked.push(passing);
        const passage = shownPassages(block(call.prompt, "live-transcript") ?? "").find((each) =>
          each.text.includes(said),
        );
        const mark = passage?.text
          .match(/\[(\d{1,2}:\d{2}) ([^\]]+)\] /g)
          ?.find((each) => passage.text.includes(`${each}${said}`));
        const citations = [
          { marker: 1, passage: passage?.id, location: mark?.slice(1, -2) ?? "", quote: said },
        ];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return {
        text: [
          overview("The call covered the budget [^1]."),
          fact("P1_budget", "budget", "The budget is approved for this year [^1].", {
            claim: true,
          }),
        ].join("\n\n"),
      };
    });
    const { separator } = fakeSeparator({ holds });
    const { core, meeting } = await recorded(
      model,
      null,
      async (core) => {
        const sources = await createSourceFolder();
        await addAndProcess(core, [
          await writeSourceFile(
            sources,
            "Budget.md",
            "Next year's budget is still under review.\n",
          ),
        ]);
      },
      undefined,
      { speakerSeparator: separator, cloud: true },
    );
    await vi.waitFor(() => expect(checks).toBeGreaterThan(0));
    passing = false;
    release();
    await vi.waitFor(() => expect(asked).toEqual([true, false]));
    answer();
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    expect(asked).toEqual([true, false]);
    core.close();
  });

  // protects=a recording of a room, whose pass always names its voices, sends nothing for its notes until its speakers are told apart, then fills them in (#138, #2773); fails_when=a fill request goes out while the pass runs, or none after it; no_claim=the pass's labels.
  test("a room's notes wait for its speakers to be told apart, then are filled in", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let passing = true;
    const asked: boolean[] = [];
    const model = fillingModel(
      lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
      { 1: MY_LINES[0] as string },
      {},
      { seen: (call) => fillRun(call) && asked.push(passing) },
    );
    const { separator, requests } = fakeSeparator({ holds });
    const { core, meeting } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
      capture: { system: "silent" },
    });
    await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "saved" && transcript.separating,
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect((await fillOf(core, meeting.id))?.state).toBe("waiting");
    passing = false;
    release();
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    expect(asked).toEqual([false]);
    core.close();
  });

  // protects=a quit while a call's notes are made before its speakers are told apart writes nothing, and at the next start the notes wait for the pass to run again, then are filled in once (#2773); fails_when=the next start says the fill stopped, writes before the pass, or writes twice; no_claim=the pass's labels.
  test("a quit while the notes are made before the speakers are told apart fills them in once the pass has run at the next start", async () => {
    let made = 0;
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { held: new Promise<void>(() => {}), seen: (call) => fillRun(call) && made++ },
    );
    const { separator } = fakeSeparator({ holds: new Promise<void>(() => {}), voiceOf: () => 0 });
    const keychain = createMemoryKeychain();
    const { core, meeting, client, dataDir } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
      cloud: true,
      keychain,
    });
    const before = shown(client);
    await vi.waitFor(() => expect(made).toBe(1));
    expect(await fillOf(core, meeting.id)).toMatchObject({ state: "waiting" });
    core.close();

    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let passing = true;
    const asked: boolean[] = [];
    const { separator: again } = fakeSeparator({ holds, voiceOf: () => 0 });
    const { core: reopened } = await transcribingCore(dataDir, {
      model: fillingModel(
        PRICING_REPLY,
        { 1: MY_LINES[0] as string },
        {},
        { seen: (call) => fillRun(call) && asked.push(passing) },
      ),
      speakerSeparator: again,
      keychain,
    });
    const writtenWhile: boolean[] = [];
    reopened.on("meetings.changed", (meetings) => {
      const fill = meetings.find((each) => each.id === meeting.id)?.fill;
      if (fill?.state === "filled" && writtenWhile.length === 0) writtenWhile.push(passing);
    });
    const shownAgain = await connectToMind(reopened, meeting.mindId);
    expect(shown(shownAgain)).toEqual(before);
    expect((await fillOf(reopened, meeting.id))?.state).not.toBe("failed");
    passing = false;
    release();
    expect(await settledFill(reopened, meeting)).toMatchObject({ state: "filled", omitted: 0 });
    expect(writtenWhile).toEqual([false]);
    expect(asked).toHaveLength(1);
    expect(
      shown(shownAgain).filter(
        (line) => line === "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
      ),
    ).toHaveLength(1);
    reopened.close();
  });

  // protects=a speaker pass that fails releases the notes: they are filled in with the labels the Transcript has, and the Transcript says its speakers couldn't be told apart; fails_when=the fill waits for the rest of the session, or the failure says nothing; no_claim=why the pass failed, which only the log says.
  test("a speaker pass that fails doesn't hold up the notes", async () => {
    const model = fillingModel(
      lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
      {
        1: MY_LINES[0] as string,
      },
    );
    const { separator } = fakeSeparator({ fails: "The speaker process stopped." });
    const { core, meeting } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
    });
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    const transcript = await until(core, meeting.id, (each) => !each.separating);
    expect(transcript.problem?.kind).toBe("speakers");
    core.close();
  });

  // protects=a fill after the User named a Speaker reads the name in its marks, brackets made spaces, and the Citations it writes back with that name, a digit first, brackets or Chinese punctuation, are kept and store the line's own label; fails_when=the fill drops the cited item or stores a name; no_claim=a real model's wording, which tests/live/speakerNames.live.test.ts covers.
  test("names the User gave reach the fill's Citations, a digit, brackets or Chinese punctuation in them", async () => {
    const said = THEIR_LINES[0] as string;
    let speaker = "";
    const model = scriptedModel((call) => {
      if (isCheckRun(call)) return checkReply(call, {});
      if (!isFill(call)) return { text: "OK" };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(block(call.prompt, "live-transcript") ?? "").find((each) =>
          each.text.includes(said),
        );
        const mark = passage?.text
          .match(/\[(\d{1,2}:\d{2}) ([^\]]+)\] /g)
          ?.find((each) => passage.text.includes(`${each}${said}`));
        speaker = mark?.slice(1, -2) ?? "";
        const citations = [{ marker: 1, passage: passage?.id, location: speaker, quote: said }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return {
        text: fact("P1_budget", "budget", "The budget is approved [^1].", {
          sections: ["summary"],
        }),
      };
    });
    const { core, meeting, client } = await recorded(model, null);
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    const documentId = (await core.listMeetings()).find((each) => each.id === meeting.id)
      ?.transcript?.documentId as string;
    const line = (await savedCues(core, meeting.id)).find((cue) => cue.text === said);
    const label = line?.speaker as string;
    for (const name of ["3M rep", "(Client) Dana", "Dana [CFO]", "王总（客户）"]) {
      await core.setTranscriptSpeakers({
        documentId,
        speakers: { labels: { [label]: name }, lines: {} },
      });
      await core.undoMeetingFill(meeting.id);
      await core.fillMeetingNotes(meeting.id);
      await vi.waitFor(async () => expect((await fillOf(core, meeting.id))?.state).toBe("filled"));
      expect(speaker).toBe(
        `${clockTime(line?.startMs ?? 0)} ${name.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim()}`,
      );
      const cited = mindCitations(client).filter((each) => each.quote === said);
      expect(cited).toHaveLength(1);
      expect(cited[0]?.location).toMatchObject({ kind: "time", speaker: label });
    }
    core.close();
  });

  // protects=each of the User's lines gets what the call said about it right under it, as AI text citing the Transcript, in their order and under their headings, the User's own text unchanged, with no Proposal and a Checkpoint before; Undo leaves the notes as the User left them; fails_when=a line moves or changes, an addition isn't AI text or uncited, a Proposal is made, or Undo leaves anything; no_claim=a real model's wording.
  test("under each of the User's lines, in place, cited, with one Undo", async () => {
    const model = fillingModel(
      [
        "HEADINGS: H1=NONE H2=NONE",
        lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
        lineFact("L2", "contract delivery", "Dana sends the contract by Friday [^2]."),
        lineFact("L3", "rollout", "The rollout starts in the second quarter [^3]."),
      ].join("\n\n"),
      { 1: MY_LINES[0] as string, 2: MY_LINES[1] as string, 3: MY_LINES[2] as string },
    );
    const { core, meeting, client } = await recorded(model, NOTES);
    const before = shown(client);

    const fill = await settledFill(core, meeting);
    expect(fill).toMatchObject({ state: "filled", mode: "notes", local: true, problem: null });
    await vi.waitFor(() => expect(shown(client)).toHaveLength(before.length + 3));
    expect(shown(client)).toEqual([
      "Pricing",
      "price → Q2?",
      "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
      "contract",
      "«Dana sends the contract by Friday »\uFFFC«.»",
      "Rollout",
      "start date",
      "«The rollout starts in the second quarter »\uFFFC«.»",
    ]);
    // The User's own lines, byte for byte, in their order.
    expect(shown(client).filter((line) => !line.includes("«"))).toEqual(before);
    expect(pendingProposals(client.blocks)).toEqual([]);
    const { checkpoints } = await core.listCheckpoints(meeting.mindId);
    expect(checkpoints.some((each) => each.reason === "enhance")).toBe(true);

    await core.undoMeetingFill(meeting.id);
    await vi.waitFor(() => expect(shown(client)).toEqual(before));
    expect(await fillOf(core, meeting.id)).toMatchObject({ state: "undone" });
    core.close();
  });

  // protects=the fill reaches the window as one update named for its meeting, so the editor showing the Note takes it as one step of its own Undo and ⌘Z there takes back the fill, not the User's earlier typing (#2527); fails_when=the fill's update has no cause, another update carries it, or it comes in more than one; no_claim=the editor's own history, which the window test covers.
  test("the fill comes to the window as one update with its meeting's cause", async () => {
    const model = fillingModel(
      [
        "HEADINGS: H1=NONE H2=NONE",
        lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
      ].join("\n\n"),
      { 1: MY_LINES[0] as string },
    );
    const updates: { mindId: string; cause: string | null }[] = [];
    const { core, meeting } = await recorded(model, NOTES, async (listening) => {
      listening.on("mind.update", (event) => {
        updates.push({ mindId: event.mindId, cause: event.cause?.requestId ?? null });
      });
    });
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    const causes = updates.filter((each) => each.mindId === meeting.mindId && each.cause !== null);
    expect(causes.map((each) => each.cause)).toEqual([`meeting-fill:${meeting.id}`]);
    core.close();
  });

  // protects=a fill the editor took back with its own Undo is recorded as undone, so Try again fills anew and a reopened Note offers it; its Redo makes it filled again with the same Blocks, and the Note itself is never touched by either (#2527); fails_when=the state stays filled after the editor's Undo, Redo loses the Blocks, or following changes the Note; no_claim=the editor's history, which the window test covers.
  test("an Undo or Redo of the fill in the editor is followed by its state, and nothing in the Note changes", async () => {
    const model = fillingModel(
      [
        "HEADINGS: H1=NONE H2=NONE",
        lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
      ].join("\n\n"),
      { 1: MY_LINES[0] as string },
    );
    const { core, meeting, client } = await recorded(model, NOTES);
    const filled = await settledFill(core, meeting);
    expect(filled).toMatchObject({ state: "filled" });
    await vi.waitFor(() => expect(shown(client).some((line) => line.includes("«"))).toBe(true));
    const withFill = shown(client);

    const undone = await core.followMeetingFillUndo({ meetingId: meeting.id, undone: true });
    expect(undone.fill).toMatchObject({ state: "undone", addedBlockIds: filled.addedBlockIds });
    expect(shown(client)).toEqual(withFill);
    // Taken back in the editor, the core's own Undo has nothing left to do.
    expect((await core.undoMeetingFill(meeting.id)).fill?.state).toBe("undone");

    const redone = await core.followMeetingFillUndo({ meetingId: meeting.id, undone: false });
    expect(redone.fill).toMatchObject({ state: "filled", addedBlockIds: filled.addedBlockIds });
    expect(shown(client)).toEqual(withFill);

    // Only true or false is followed: a string "false" would have marked it taken back.
    const asked = (input: unknown) =>
      core.followMeetingFillUndo(input as Parameters<typeof core.followMeetingFillUndo>[0]);
    await expect(asked({ meetingId: meeting.id, undone: "false" })).rejects.toThrow(
      "The fill-in can only be taken back or put back.",
    );
    await expect(asked(meeting.id)).rejects.toThrow(
      "The fill-in can only be taken back or put back.",
    );
    expect((await core.listMeetings()).find((each) => each.id === meeting.id)?.fill?.state).toBe(
      "filled",
    );
    core.close();
  });

  // protects=with no notes, the sections are filled in, each citing the Transcript, and "Said in the call, not in your Documents" keeps only the statements the User's Documents don't support, moved there whole, never a decision, task or open question, which is the call's own and isn't checked (#2306); fails_when=a section is missing, uncited, a decision is checked or listed, or a claim is written twice; no_claim=the template's sections (#688).
  test("with no notes, the sections, and only the claims the Documents don't support, written there once", async () => {
    const decided = "The enterprise price is 45 dollars a seat";
    const checks: string[] = [];
    const model = fillingModel(
      [
        overview("The call covered pricing and the contract [^1]."),
        fact("P1_price", "pricing", `${decided} [^1].`, {
          sections: ["decisions"],
          claim: true,
        }),
        fact("P1_delivery", "contract delivery", "Dana sends the contract by Friday — Me [^2].", {
          sections: ["actions"],
        }),
        fact("P1_security", "security review", "The security review is still open [^3].", {
          sections: ["questions"],
        }),
        fact("P1_budget", "budget approval", "The budget is approved for this year [^4].", {
          sections: ["summary"],
          claim: true,
        }),
      ].join("\n"),
      {
        1: MY_LINES[0] as string,
        2: MY_LINES[1] as string,
        3: THEIR_LINES[1] as string,
        4: THEIR_LINES[0] as string,
      },
      {},
      {
        seen: (call) => {
          if (isCheckRun(call)) checks.push(call.prompt);
        },
      },
    );
    const { core, meeting, client } = await recorded(model, null, async (core) => {
      const sources = await createSourceFolder();
      await addAndProcess(core, [
        await writeSourceFile(sources, "Price list.md", "Team plan: 30 dollars a seat.\n"),
      ]);
    });

    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "sections" });
    await vi.waitFor(() => expect(shown(client).length).toBeGreaterThan(5));
    expect(shown(client)).toEqual([
      "«Summary»",
      "«The call covered pricing and the contract »\uFFFC«.»",
      "«Decisions»",
      "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
      "«Action items»",
      "«Dana sends the contract by Friday — Me »\uFFFC«.»",
      "«Open questions»",
      "«The security review is still open »\uFFFC«.»",
      "«Said in the call, not in your Documents»",
      "«The budget is approved for this year »\uFFFC«.»",
    ]);
    expect(checks.some((prompt) => prompt.includes("The budget is approved"))).toBe(true);
    expect(checks.some((prompt) => prompt.includes(decided))).toBe(false);
    core.close();
  });

  // protects=with no notes, the Summary leads with the overview alone, then a heading for each of the call's topics, in its order, with its facts as cited bullets, then only the sections the call had, each as bullets; a claim is checked only when a Document other than the Transcript is in scope, and only one the Documents don't back is listed, moved there whole; one Undo restores the Note (#2306); fails_when=facts are paragraphs under Summary, a topic repeats, an empty section or claims list shows, a check is sent with nothing to check against, or a claim is written twice; no_claim=a real model's topics, which tests/live/meetingFillSections.live.test.ts measures.
  test.each([
    ["en", "no Documents"],
    ["en", "a Document"],
    ["zh-CN", "no Documents"],
    ["zh-CN", "a Document"],
  ] as const)(
    "with no notes in %s and %s, Summary leads, each topic is a heading with cited bullets, and only unbacked claims are listed",
    async (language, documents) => {
      const chinese = language === "zh-CN";
      const said = chinese ? CHINESE_LINES : { mine: MY_LINES, theirs: THEIR_LINES };
      const [price = "", , rollout = ""] = said.mine;
      const [budget = "", security = ""] = said.theirs;
      const stop = chinese ? "。" : ".";
      const topics = chinese ? ["价格与预算", "上线"] : ["Price and budget", "Rollout"];
      const checks: string[] = [];
      const model = fillingModel(
        [
          overview(
            `${chinese ? "通话谈了价格和上线" : "The call went through price and rollout"} [^1]${stop}`,
          ),
          fact("P1_price", "price", `${price} [^1]${stop}`, { heading: topics[0], claim: true }),
          fact("P1_budget", "budget", `${budget} [^2]${stop}`, {
            heading: ` ${topics[0]?.toUpperCase()} `,
            claim: true,
          }),
          fact("P1_rollout", "rollout", `${rollout} [^3]${stop}`, { heading: topics[1] }),
          fact("P1_security", "security", `${security} [^4]${stop}`, {
            heading: topics[1],
            sections: ["questions"],
          }),
        ].join("\n"),
        { 1: price, 2: budget, 3: rollout, 4: security },
        { [`${price}${stop}`]: { verdict: "supported", quote: price } },
        {
          seen: (call) => {
            if (isCheckRun(call)) checks.push(call.prompt);
          },
        },
      );
      const { core, meeting, client } = await recorded(
        model,
        null,
        async (core) => {
          if (documents === "no Documents") return;
          const sources = await createSourceFolder();
          await addAndProcess(core, [
            await writeSourceFile(sources, "Price list.md", `${price}\n`),
          ]);
        },
        undefined,
        { lines: said },
      );
      const before = exactly(client);

      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "sections" });
      const ai = (text: string) => `- «${text} »\uFFFC«${stop}»`;
      const title = (key: "summary" | "questions" | "claims") =>
        `## «${translate(language, `meetings.fill.section.${key}`)}»`;
      await vi.waitFor(() =>
        expect(outline(client)).toEqual([
          title("summary"),
          `«${chinese ? "通话谈了价格和上线" : "The call went through price and rollout"} »\uFFFC«${stop}»`,
          `## «${topics[0]}»`,
          ai(price),
          ...(documents === "a Document" ? [] : [ai(budget)]),
          `## «${topics[1]}»`,
          ai(rollout),
          title("questions"),
          ai(security),
          ...(documents === "a Document" ? [title("claims"), ai(budget)] : []),
        ]),
      );
      expect(checks.length > 0).toBe(documents === "a Document");
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      core.close();
    },
  );

  // protects=a reply whose facts after the first leave their json fence open, or one that puts a blank line before each closing fence, still fills every fact in, each cited, as real models' replies did (#2306); fails_when=the facts after the first are read as code, or a closed fence gets a second one that swallows the next fact; no_claim=how often a model does either.
  test.each(["left open", "closed after a blank line"] as const)(
    "facts whose metadata fence the model %s are all filled in",
    async (shape) => {
      const closedFence = /(\{"topic"[^\n]*\})\n```\n/g;
      const facts = [
        fact("P1_price", "price", "We agreed the enterprise price is 45 dollars a seat [^1].", {
          heading: "Pricing",
        }),
        fact("P1_contract", "contract", "Dana will send the contract by Friday [^2].", {
          heading: "Contract",
        }),
        fact("P1_rollout", "rollout", "The rollout starts in the second quarter [^3].", {
          heading: "Rollout",
        }),
      ];
      const [first = "", ...rest] = facts;
      const written =
        shape === "left open"
          ? [first, ...rest.map((each) => each.replace(closedFence, "$1\n"))]
          : facts.map((each) => each.replace(closedFence, "$1\n\n```\n"));
      const model = fillingModel(
        [overview("The call covered price, contract and rollout [^1]."), ...written].join("\n\n"),
        { 1: MY_LINES[0] as string, 2: MY_LINES[1] as string, 3: MY_LINES[2] as string },
      );
      const { core, meeting, client } = await recorded(model, null);

      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 0 });
      await vi.waitFor(() =>
        expect(outline(client)).toEqual([
          "## «Summary»",
          "«The call covered price, contract and rollout »\uFFFC«.»",
          "## «Pricing»",
          "- «We agreed the enterprise price is 45 dollars a seat »\uFFFC«.»",
          "## «Contract»",
          "- «Dana will send the contract by Friday »\uFFFC«.»",
          "## «Rollout»",
          "- «The rollout starts in the second quarter »\uFFFC«.»",
        ]),
      );
      core.close();
    },
  );

  // protects=a fill reply cut off at its output limit is asked once more with twice the room and fills the note in, while every first request sets aside only the usual room, so a fill still runs under a small monthly cap (#2306); fails_when=a cut-off fill fails without a second try, or a first request sets aside the larger room and passes the cap; no_claim=how often a real model's thinking reaches the limit.
  test("a fill cut off at its output limit is asked once more with more room, and fills in", async () => {
    const limits: (number | undefined)[] = [];
    let cut = true;
    const model = scriptedModel((call) => {
      if (isCheckRun(call)) return checkReply(call, {});
      if (!isFill(call)) return { text: "OK" };
      limits.push(call.options.maxOutputTokens);
      const shown = shownPassages(block(call.prompt, "live-transcript") ?? "");
      const citations = transcriptCitations(call, shown, { 1: MY_LINES[0] as string });
      if (citations) return citations;
      const text = [
        overview("The call settled the price [^1]."),
        fact("P1_price", "price", "We agreed the enterprise price is 45 dollars a seat [^1].", {
          heading: "Pricing",
        }),
      ].join("\n\n");
      if (!cut) return { text };
      cut = false;
      return { text: "", cutOff: true };
    });
    const { core, meeting, client } = await recorded(model, null);

    expect(await settledFill(core, meeting)).toMatchObject({
      state: "filled",
      problem: null,
      omitted: 0,
    });
    expect([...new Set(limits)]).toEqual([16_000, 32_000]);
    await vi.waitFor(() =>
      expect(outline(client)).toContain(
        "- «We agreed the enterprise price is 45 dollars a seat »\uFFFC«.»",
      ),
    );
    core.close();
  });

  test("a fill runs under a small monthly cap, each request setting aside only the usual room", async () => {
    const model = fillingModel(
      [
        overview("The call settled the price [^1]."),
        fact("P1_price", "price", "We agreed the enterprise price is 45 dollars a seat [^1].", {
          heading: "Pricing",
        }),
      ].join("\n\n"),
      { 1: MY_LINES[0] as string },
    );
    // Claude Haiku 5.5 sets aside about $0.008 for 16,000 tokens out and $0.016 for 32,000.
    const { core, meeting, client } = await recorded(
      model,
      null,
      async (core) => {
        await core.updateSettings({ user: { monthlyCap: { amount: 0.012, currency: "USD" } } });
      },
      undefined,
      { cloud: true },
    );

    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", problem: null });
    await vi.waitFor(() => expect(outline(client)).toContain("## «Pricing»"));
    core.close();
  });

  // protects=in Simplified Chinese, with no notes taken, the sections start the Note where its blank lines were, with none above them, and the model is told the Transcript's own Chinese words for who spoke, so it writes 我 and 对方 rather than Me, Them or 用户 (#2305); fails_when=a blank line is left above the first section, or the model is shown only the English marks; no_claim=a real model's wording, which tests/live/meetingNotes.live.test.ts measures.
  test("in Simplified Chinese, the sections start the Note with no blank line above, and the model is told the Transcript's words for who spoke", async () => {
    const prompts: string[] = [];
    const model = fillingModel(
      [
        overview("通话谈了价格和合同 [^1]。"),
        fact("P1_delivery", "合同交付", "周五之前寄出合同 — 我 [^2]。", { sections: ["actions"] }),
      ].join("\n"),
      { 1: CHINESE_LINES.mine[0], 2: CHINESE_LINES.mine[1] },
      {},
      {
        seen: (call) => {
          if (isFill(call)) prompts.push(call.prompt);
        },
      },
    );
    const { core, meeting, client } = await recorded(
      model,
      [note(""), note("")],
      async (core) => {
        await core.updateSettings({ user: { language: "zh-CN" } });
      },
      undefined,
      { lines: CHINESE_LINES },
    );
    const before = exactly(client);
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "sections" });
    await vi.waitFor(() => expect(shown(client).length).toBeGreaterThan(2));
    expect(shown(client)).toEqual([
      "«摘要»",
      "«通话谈了价格和合同 »\uFFFC«。»",
      "«待办事项»",
      "«周五之前寄出合同 — 我 »\uFFFC«。»",
      "",
      "",
    ]);
    expect(prompts.at(-1)).toContain("in Simplified Chinese Me is 我, Them is 对方");
    expect(prompts.at(-1)).toContain('Never call the User "the User" or 用户');
    await core.undoMeetingFill(meeting.id);
    await vi.waitFor(() => expect(exactly(client)).toEqual(before));
    core.close();
  });

  // protects=a call's notes, their section titles and the pointers between them are in the language the call was held in, whatever the interface's, and the model is asked in it and told it (#2770); fails_when=the titles or pointers follow the interface, or the request asks in the interface's language; no_claim=a real model's wording, which the PR's real-model runs cover.
  test.each([
    {
      call: "Chinese",
      interfaceLanguage: "en",
      lines: CHINESE_LINES,
      reply: [
        overview("通话谈了价格和合同 [^1]。"),
        fact("P1_price", "价格", "企业版每个席位 45 美元 [^1]。", {
          sections: ["decisions", "questions"],
        }),
      ].join("\n"),
      asked: "写出这次通话的笔记。",
      notes: [
        "«摘要»",
        "«通话谈了价格和合同 »\uFFFC«。»",
        "«决定»",
        "«企业版每个席位 45 美元 »\uFFFC«。»",
        "«待定问题»",
        "«价格，详见上文 »\uFFFC",
      ],
    },
    {
      call: "English",
      interfaceLanguage: "zh-CN",
      lines: { mine: MY_LINES, theirs: THEIR_LINES },
      reply: [
        overview("The call covered pricing and the contract [^1]."),
        fact("P1_price", "pricing", "The enterprise price is 45 dollars a seat [^1].", {
          sections: ["decisions", "questions"],
        }),
      ].join("\n"),
      asked: "Write the notes of this call.",
      notes: [
        "«Summary»",
        "«The call covered pricing and the contract »\uFFFC«.»",
        "«Decisions»",
        "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
        "«Open questions»",
        "«pricing — see above »\uFFFC",
      ],
    },
  ] as const)(
    "the notes of a call held in $call are in $call, section titles too, with the interface in $interfaceLanguage",
    async ({ call, interfaceLanguage, lines, reply, asked, notes }) => {
      const prompts: string[] = [];
      const model = fillingModel(
        reply,
        { 1: lines.mine[0] },
        {},
        {
          seen: (each) => {
            if (isFill(each)) prompts.push(each.prompt);
          },
        },
      );
      const { core, meeting, client } = await recorded(
        model,
        null,
        async (core) => {
          await core.updateSettings({ user: { language: interfaceLanguage } });
        },
        undefined,
        { lines },
      );
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "sections" });
      await vi.waitFor(() => expect(shown(client)).toEqual(notes));
      expect(prompts.at(-1)).toContain(`- Write in ${call}, the language of the call.`);
      expect(prompts.at(-1)).toContain(asked);
      core.close();
    },
  );

  test("uncited facts are omitted once while cited siblings remain undoable", async () => {
    const model = fillingModel(
      [
        lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
        lineFact("L2", "contract delivery", "Dana sends the contract by Friday."),
        lineFact("L3", "rollout", "The rollout starts in the second quarter [^1]."),
        fact("P1_uncited", "agreement", "Everyone agreed.", { sections: ["decisions"] }),
        overview("The call covered commercial planning [^1]."),
      ].join("\n\n"),
      { 1: MY_LINES[0] as string },
    );
    const { core, meeting, client } = await recorded(model, NOTES);
    const before = exactly(client);
    const fill = await settledFill(core, meeting);
    expect(fill).toMatchObject({ state: "filled", omitted: 2 });
    expect(shown(client)).toContain("«The enterprise price is 45 dollars a seat »\uFFFC«.»");
    expect(shown(client).join("\n")).not.toMatch(/Dana sends|Everyone agreed/);
    expectNoCitationRepair(model);
    await core.undoMeetingFill(meeting.id);
    await vi.waitFor(() => expect(exactly(client)).toEqual(before));
    core.close();
  });

  test.each([
    { language: "en", attribute: "citations='{records}'" },
    { language: "zh-CN", attribute: 'records="{records}"' },
  ] as const)(
    "Citations written inside a cite tag's attribute are recorded as its call's would be ($language)",
    async ({ language, attribute }) => {
      const body = [
        lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
        overview("The call covered commercial planning [^1]."),
      ].join("\n\n");
      const model = scriptedModel((call) => {
        if (isCheckRun(call)) return checkReply(call, {});
        if (!isFill(call)) return { text: "OK" };
        const passage = shownPassages(block(call.prompt, "live-transcript") ?? "").find((each) =>
          each.text.includes(MY_LINES[0] as string),
        );
        const line = passage?.text.split("\n").find((each) => each.includes(MY_LINES[0] as string));
        const location = /^\[([\d:]+)/.exec(line ?? "")?.[1];
        const records = JSON.stringify([
          { marker: 1, passage: passage?.id, location, quote: MY_LINES[0] },
        ]);
        return { text: `${body}\n\n<cite ${attribute.replace("{records}", records)}></cite>` };
      });
      const { core, meeting, client } = await recorded(
        model,
        [note("price"), note("rollout")],
        async (core) => {
          await core.updateSettings({ user: { language } });
        },
      );
      const before = exactly(client);
      const fill = await settledFill(core, meeting);
      expect(fill).toMatchObject({ state: "filled", omitted: 0 });
      expect(shown(client)).toContain("«The enterprise price is 45 dollars a seat »￼«.»");
      expect(shown(client).join("\n")).not.toMatch(/cite|records/);
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      core.close();
    },
  );

  test.each([
    { language: "en", reason: "the model found nothing to add." },
    { language: "zh-CN", reason: "模型没有找到可补充的内容。" },
  ] as const)(
    "a fill whose model wrote no items at all still says it found nothing to add ($language)",
    async ({ language, reason }) => {
      const model = scriptedModel((call) => {
        if (isCheckRun(call)) return checkReply(call, {});
        if (!isFill(call)) return { text: "OK" };
        return { text: "Nothing came up worth noting." };
      });
      const { core, meeting } = await recorded(
        model,
        [note("price"), note("rollout")],
        async (core) => {
          await core.updateSettings({ user: { language } });
        },
      );
      const fill = await settledFill(core, meeting);
      expect(fill).toMatchObject({ state: "failed", problem: { kind: "model", message: reason } });
      core.close();
    },
  );

  test.each([
    {
      language: "en",
      reason: "none of what the model wrote could be checked against the transcript.",
    },
    { language: "zh-CN", reason: "模型写的内容都没能在转写稿中核对上。" },
  ] as const)(
    "a fill whose every item is left out says it couldn't check them, not that there was nothing to add ($language)",
    async ({ language, reason }) => {
      const model = scriptedModel((call) => {
        if (isCheckRun(call)) return checkReply(call, {});
        if (!isFill(call)) return { text: "OK" };
        return {
          text: [
            lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
            overview("The call covered commercial planning [^1]."),
          ].join("\n\n"),
        };
      });
      const { core, meeting, client } = await recorded(
        model,
        [note("price"), note("rollout")],
        async (core) => {
          await core.updateSettings({ user: { language } });
        },
      );
      const before = exactly(client);
      const fill = await settledFill(core, meeting);
      expect(fill).toMatchObject({ state: "failed", problem: { kind: "model", message: reason } });
      expect(exactly(client)).toEqual(before);
      core.close();
    },
  );

  test.each(
    (["en", "zh-CN"] as const).flatMap((language) =>
      [false, true].flatMap((withValid) =>
        ["L1", "L99"].map((target) => ({ language, withValid, target })),
      ),
    ),
  )(
    "a failed Transcript Citation omits only its fact ($language, $target, valid sibling: $withValid)",
    async ({ language, withValid, target }) => {
      const feedback: string[] = [];
      let selectedTime = 0;
      const model = scriptedModel((call) => {
        if (!isFill(call)) return { text: "OK" };
        const cited = call.results.filter((result) => result.tool === "cite").at(-1);
        if (cited) {
          feedback.push(cited.text);
          return {
            text: [
              lineFact(target, "pricing", "The enterprise price is 45 dollars a seat [^1]."),
              ...(withValid
                ? [lineFact("L2", "rollout", "The rollout starts in the second quarter [^2].")]
                : []),
            ].join("\n\n"),
          };
        }
        const passage = shownPassages(block(call.prompt, "live-transcript") ?? "").find((each) =>
          each.text.includes(MY_LINES[0] as string),
        );
        if (!passage) throw new Error("The Transcript's pricing line was not shown.");
        const rollout = passage.text
          .split("\n")
          .find((line) => line.includes(MY_LINES[2] as string));
        const location = /^\[([\d:]+)/.exec(rollout ?? "")?.[1];
        if (!location) throw new Error("The Transcript's rollout line was not shown.");
        selectedTime =
          location.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0) * SECOND;
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: [
                  {
                    marker: 1,
                    passage: passage.id,
                    location,
                    quote: MY_LINES[0],
                  },
                  ...(withValid
                    ? [{ marker: 2, passage: passage.id, location, quote: MY_LINES[2] }]
                    : []),
                ],
              },
            },
          ],
        };
      });
      const { core, meeting, client } = await recorded(
        model,
        [note("price"), note("rollout")],
        async (core) => {
          await core.updateSettings({ user: { language } });
        },
      );
      const before = exactly(client);
      const fill = await settledFill(core, meeting);
      expect(feedback).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Recorded [^1]"),
          expect.stringContaining("Fix these"),
        ]),
      );
      expect(fill).toMatchObject({ state: withValid ? "filled" : "failed", omitted: 2 });
      expect(shown(client).join("\n")).not.toContain("enterprise price");
      expectNoCitationRepair(model);
      if (withValid) {
        expect(shown(client)).toContain("«The rollout starts in the second quarter »\uFFFC«.»");
        const citations: ReturnType<typeof citationAttributesOf>[] = [];
        readMind(client).descendants((node) => {
          if (node.type.name === "citation") citations.push(citationAttributesOf(node.attrs));
        });
        expect(citations).toEqual([
          expect.objectContaining({
            check: "found",
            quote: MY_LINES[2],
            contentHash: expect.any(String),
            location: expect.objectContaining({ kind: "time", speaker: "Me" }),
          }),
        ]);
        for (const citation of citations) {
          if (citation.location?.kind !== "time") throw new Error("Missing Transcript time");
          expect(citation.location.from).toBeGreaterThanOrEqual(selectedTime);
          expect(citation.location.from).toBeLessThan(selectedTime + SECOND);
        }
        await core.undoMeetingFill(meeting.id);
      }
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      const { checkpoints } = await core.listCheckpoints(meeting.mindId);
      expect(checkpoints.filter((each) => each.reason === "enhance")).toHaveLength(
        withValid ? 1 : 0,
      );
      core.close();
    },
  );

  // protects=a model that fails leaves the Mind as it was and says why, and Try again fills it in; fails_when=anything is written on a failure, or Try again does nothing; no_claim=which provider error it was.
  test("a failing model writes nothing and says why; Try again fills the notes in", async () => {
    let failing = true;
    const model = fillingModel(
      lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
      { 1: MY_LINES[0] as string },
      {},
      { failing: () => failing },
    );
    const { core, meeting, client } = await recorded(model, NOTES);
    const before = shown(client);

    const failed = await settledFill(core, meeting);
    expect(failed).toMatchObject({ state: "failed", problem: { kind: "model" } });
    expect(failed.problem?.message).not.toBe("");
    expect(shown(client)).toEqual(before);

    failing = false;
    await core.fillMeetingNotes(meeting.id);
    await vi.waitFor(async () =>
      expect(await fillOf(core, meeting.id)).toMatchObject({ state: "filled" }),
    );
    await vi.waitFor(() => expect(shown(client)).toHaveLength(before.length + 1));
    core.close();
  });

  // protects=a key refused while the notes are made writes nothing and says why in the fill's line, and Try again once it works fills them in once (#2773); fails_when=a refused key leaves the fill waiting, writes part of the notes, or Try again writes them twice; no_claim=the provider's own wording of the refusal.
  test("a key refused while the notes are made writes nothing and says so; Try again fills them in once", async () => {
    let refused = true;
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { failing: () => refused, error: { status: 401, message: "invalid x-api-key" } },
    );
    const { core, meeting, client } = await recorded(model, NOTES);
    const before = shown(client);
    const failed = await settledFill(core, meeting);
    expect(failed).toMatchObject({
      state: "failed",
      problem: { kind: "model" },
      addedBlockIds: [],
    });
    expect(failed.problem?.message).not.toBe("");
    expect(shown(client)).toEqual(before);

    refused = false;
    await core.fillMeetingNotes(meeting.id);
    await vi.waitFor(async () =>
      expect(await fillOf(core, meeting.id)).toMatchObject({ state: "filled", omitted: 0 }),
    );
    expect(
      shown(client).filter(
        (line) => line === "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
      ),
    ).toHaveLength(1);
    core.close();
  });

  // protects=Stop pressed again on a stopped call is refused and leaves one set of notes (#2773); fails_when=the second Stop starts a second fill or writes the notes twice; no_claim=the bar's own button, which goes at Stop.
  test("Stop pressed twice leaves one set of notes", async () => {
    let fills = 0;
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { seen: (call) => fillRun(call) && fills++ },
    );
    let stops: PromiseSettledResult<unknown>[] = [];
    const { core, meeting, client } = await recorded(model, NOTES, undefined, undefined, {
      stop: async (core, meetingId) => {
        stops = await Promise.allSettled([
          core.stopMeeting(meetingId),
          core.stopMeeting(meetingId),
        ]);
      },
    });
    expect(stops.map((each) => each.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(
      stops.flatMap((each) => (each.status === "rejected" ? [String(each.reason)] : [])),
    ).toEqual([expect.stringContaining("That Meeting isn’t being recorded.")]);
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    expect(fills).toBe(1);
    expect(
      shown(client).filter(
        (line) => line === "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
      ),
    ).toHaveLength(1);
    core.close();
  });

  // protects=a call in which nothing was said gets no notes and no request, and says why (#2773); fails_when=a fill request goes out, or the line waits for ever; no_claim=the Transcript's own line, which the transcript tests cover.
  test("a call in which nothing was said sends nothing and says there is nothing to fill in from", async () => {
    let fills = 0;
    const model = fillingModel(PRICING_REPLY, {}, {}, { seen: (call) => isFill(call) && fills++ });
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, {
      model,
      engine: { lines: [], theirLines: [] },
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    record(12 * SECOND);
    await core.stopMeeting(meeting.id);
    expect(await settledFill(core, meeting)).toMatchObject({
      state: "off",
      problem: { kind: "no-transcript" },
    });
    expect(fills).toBe(0);
    core.close();
  });

  test("a deleted target's fact goes under the User's heading for its topic instead of a stale line", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = fillingModel(
      [
        lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
        lineFact("L2", "contract delivery", "Dana sends the contract by Friday [^2]."),
      ].join("\n\n"),
      { 1: MY_LINES[0] as string, 2: MY_LINES[1] as string },
      {},
      { held },
    );
    const { core, meeting, client } = await recorded(model, NOTES);
    await vi.waitFor(async () =>
      expect(await fillOf(core, meeting.id)).toMatchObject({ state: "filling" }),
    );
    // The User deletes "price → Q2?" and types a new line at the end meanwhile.
    writeMind(client, [NOTES[0], NOTES[2], NOTES[3], NOTES[4], note("Who signs?")] as Parameters<
      typeof writeMind
    >[1]);
    await client.settled();
    const typed = shown(client);
    const before = exactly(client);
    release();

    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    await vi.waitFor(() => expect(shown(client)).toHaveLength(typed.length + 2));
    expect(shown(client)).toEqual([
      "Pricing",
      "contract",
      "«Dana sends the contract by Friday »\uFFFC«.»",
      "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
      "Rollout",
      "start date",
      "Who signs?",
    ]);
    await core.undoMeetingFill(meeting.id);
    await vi.waitFor(() => expect(exactly(client)).toEqual(before));
    core.close();
  });

  test.each(["edit target", "move target"] as const)(
    "concurrent User text survives a fill and exact Undo (%s)",
    async (change) => {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const model = fillingModel(
        [
          lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
          overview("The call covered commercial planning. [^1]"),
        ].join("\n\n"),
        { 1: MY_LINES[0] as string },
        {},
        { held },
      );
      const { core, meeting, client } = await recorded(model, [note("price"), note("contract")]);
      await vi.waitFor(async () =>
        expect(await fillOf(core, meeting.id)).toMatchObject({ state: "filling" }),
      );
      editMind(client, (blocks) => {
        const first = blocks[0];
        if (!first) throw new Error("Missing User line");
        const added = note("Typed during the fill");
        return change === "edit target"
          ? [
              { ...first, content: [{ type: "text", text: "revised pricing question" }] },
              ...blocks.slice(1),
              added,
            ]
          : [...blocks.slice(1), first, added];
      });
      await client.settled();
      const before = exactly(client);
      release();
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
      const full = "«The enterprise price is 45 dollars a seat »\uFFFC«.»";
      await vi.waitFor(() => expect(shown(client)).toContain(full));
      expect(shown(client)).toContain("Typed during the fill");
      if (change === "move target") {
        expect(shown(client).indexOf(full)).toBe(shown(client).indexOf("price") + 1);
      } else {
        expect(shown(client).indexOf(full)).toBeGreaterThan(shown(client).indexOf("«Summary»"));
        expect(shown(client)).toContain("revised pricing question");
      }
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      core.close();
    },
  );

  // protects=deleting the note while its notes are filled in stops the fill: nothing is written, and once Undo brings the Meeting back its line says it stopped, with Try again (#1253); fails_when=the fill writes into the deleted note, or the Meeting comes back still filling; no_claim=none beyond protects.
  test("a note deleted while it fills in gets nothing written, and Undo brings it back saying the fill stopped", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = fillingModel(
      lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
      { 1: MY_LINES[0] as string },
      {},
      { held },
    );
    const { core, meeting, client } = await recorded(model, NOTES);
    const before = shown(client);
    await vi.waitFor(async () =>
      expect(await fillOf(core, meeting.id)).toMatchObject({ state: "filling" }),
    );

    await core.deleteMind(meeting.mindId);
    release();
    await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });

    expect(await settledFill(core, meeting)).toMatchObject({
      state: "failed",
      problem: { kind: "stopped" },
    });
    expect(shown(await connectToMind(core, meeting.mindId))).toEqual(before);
    core.close();
  });

  // protects=a call's note deleted while its notes are made before its speakers are told apart, and brought back after the pass ends, gets its notes, as one deleted while it waited for the pass does (#2773); fails_when=the restored note says the fill stopped, or nothing is filled in; no_claim=a note deleted after the pass, which the tests around it cover.
  test("a call's note deleted while its notes are made before the pass ends gets them once it is back", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reply = () => {};
    const held = new Promise<void>((resolve) => {
      reply = resolve;
    });
    let runs = 0;
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { held, seen: (call) => fillRun(call) && runs++ },
    );
    const { separator: told } = fakeSeparator({ holds, voiceOf: () => 0 });
    let answered = false;
    const separator: SpeakerSeparator = {
      async separate(request) {
        const turns = await told.separate(request);
        answered = true;
        return turns;
      },
    };
    const { core, meeting } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
      cloud: true,
    });
    await vi.waitFor(() => expect(runs).toBe(1));
    await core.deleteMind(meeting.mindId);
    reply();
    release();
    await vi.waitFor(() => expect(answered).toBe(true));
    // The pass ends in the promise turns after its answer: the next task sees it ended.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 0 });
    expect(
      shown(await connectToMind(core, meeting.mindId)).filter(
        (line) => line === "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
      ),
    ).toHaveLength(1);
    core.close();
  });

  // protects=a call's note deleted and brought back while its speakers are still told apart, with its notes made before the pass, gets one set of notes once the pass ends, and a second delete and Undo leaves them as they are (#2773); fails_when=the restored note says the fill stopped, nothing is filled in, or the notes are written twice; no_claim=the pass's labels.
  test("a call's note deleted and brought back before its pass ends gets its notes once, after the pass", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { seen: (call) => fillRun(call) && runs++ },
    );
    const { separator } = fakeSeparator({ holds, voiceOf: () => 0 });
    const { core, meeting } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
      cloud: true,
    });
    await vi.waitFor(() => expect(runs).toBe(1));
    await core.deleteMind(meeting.mindId);
    await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });
    expect(await fillOf(core, meeting.id)).toMatchObject({ state: "waiting" });
    release();
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 0 });
    const line = "«The enterprise price is 45 dollars a seat »\uFFFC«.»";
    expect(
      shown(await connectToMind(core, meeting.mindId)).filter((each) => each === line),
    ).toHaveLength(1);

    await core.deleteMind(meeting.mindId);
    await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });
    expect(await fillOf(core, meeting.id)).toMatchObject({ state: "filled" });
    expect(
      shown(await connectToMind(core, meeting.mindId)).filter((each) => each === line),
    ).toHaveLength(1);
    expect(runs).toBe(2);
    core.close();
  });

  // protects=notes made before a call's speakers are told apart and still being made once the pass ends say they are filling in, so deleting the note then stops them as any fill under way: Undo brings it back saying the fill stopped (#2773, #1253); fails_when=the notes still say they wait after the pass, or the restored note fills itself in; no_claim=none beyond protects.
  test("notes made before the speakers are told apart and deleted after the pass come back saying the fill stopped", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reply = () => {};
    const held = new Promise<void>((resolve) => {
      reply = resolve;
    });
    let made = 0;
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { held, seen: (call) => fillRun(call) && made++ },
    );
    const { separator } = fakeSeparator({ holds, voiceOf: () => 0 });
    const { core, meeting, client } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
      cloud: true,
    });
    const before = shown(client);
    await vi.waitFor(() => expect(made).toBe(1));
    expect(await fillOf(core, meeting.id)).toMatchObject({ state: "waiting" });
    release();
    await vi.waitFor(async () =>
      expect(await fillOf(core, meeting.id)).toMatchObject({ state: "filling" }),
    );

    await core.deleteMind(meeting.mindId);
    reply();
    await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });
    expect(await settledFill(core, meeting)).toMatchObject({
      state: "failed",
      problem: { kind: "stopped" },
    });
    expect(shown(await connectToMind(core, meeting.mindId))).toEqual(before);
    expect(made).toBe(1);
    core.close();
  });

  // protects=Try again pressed while a call's speakers are still told apart, after notes made early failed, says at once that the notes are under way again, and they are written once, after the pass (#2773); fails_when=the line keeps the old problem until the notes land, or they are written before the pass ends or twice; no_claim=which provider error it was.
  test("Try again during the speaker pass, after notes made early failed, waits for the pass and fills them in once", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failing = true;
    let passing = true;
    const model = fillingModel(
      PRICING_REPLY,
      { 1: MY_LINES[0] as string },
      {},
      { failing: () => failing },
    );
    const { separator } = fakeSeparator({ holds, voiceOf: () => 0 });
    const writtenWhile: boolean[] = [];
    const { core, meeting, client } = await recorded(
      model,
      NOTES,
      async (core) => {
        core.on("meetings.changed", (meetings) => {
          const fill = meetings.find((each) => each.kind === "meeting")?.fill;
          if (fill?.state === "filled" && writtenWhile.length === 0) writtenWhile.push(passing);
        });
      },
      undefined,
      { speakerSeparator: separator, cloud: true },
    );
    expect(await settledFill(core, meeting)).toMatchObject({
      state: "failed",
      problem: { kind: "model" },
    });
    failing = false;
    expect((await core.fillMeetingNotes(meeting.id)).fill).toMatchObject({
      state: "waiting",
      problem: null,
    });
    passing = false;
    release();
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 0 });
    expect(writtenWhile).toEqual([false]);
    expect(
      shown(client).filter(
        (line) => line === "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
      ),
    ).toHaveLength(1);
    core.close();
  });

  // protects=quitting while the notes are filled in leaves the Mind as it was, and the next start says so with Try again; fails_when=anything half-written stays, or the Meeting says it is still filling; no_claim=none beyond protects.
  test("a quit while it fills in leaves nothing written, and the next start says so", async () => {
    const held = new Promise<void>(() => {});
    const model = fillingModel(
      lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."),
      { 1: MY_LINES[0] as string },
      {},
      { held },
    );
    const { core, meeting, client, dataDir } = await recorded(model, NOTES);
    const before = shown(client);
    await vi.waitFor(async () =>
      expect(await fillOf(core, meeting.id)).toMatchObject({ state: "filling" }),
    );
    core.close();

    const { core: again } = await transcribingCore(dataDir, {
      model: fillingModel("", {}),
    });
    const reopened = await connectToMind(again, meeting.mindId);
    expect(await fillOf(again, meeting.id)).toMatchObject({
      state: "failed",
      problem: { kind: "stopped" },
    });
    expect(shown(reopened)).toEqual(before);
    again.close();
  });

  // protects=the notes are filled in with the model the meeting's Mind uses (its own pick, #1379), not the Answers default; a service not allowed yet is said as that, with its name, not as no model; fails_when=the default model writes them, or the line says to choose a model; no_claim=the device's last pick, which #1379's tests cover.
  test("the Mind's own model fills them in, and a service not allowed yet says so", async () => {
    let cloudId = "";
    const { core, meeting } = await recorded(
      fillingModel(lineFact("L1", "pricing", "The enterprise price is 45 dollars a seat [^1]."), {
        1: MY_LINES[0] as string,
      }),
      NOTES,
      async (core) => {
        const answers = (await core.getSettings()).user.chatModel;
        cloudId = (
          await saveProviderUnasked(core, {
            kind: "openai",
            apiKey: "sk-test",
            modelId: "gpt-test",
          })
        ).id;
        await core.updateSettings({ user: { chatModel: answers } });
      },
      (client) => setMindModel(client.doc, { providerId: cloudId, modelId: "gpt-test" }),
    );
    expect(await settledFill(core, meeting)).toMatchObject({
      state: "off",
      problem: { kind: "not-allowed", service: "OpenAI" },
    });
    expect((await core.getSettings()).user.chatModel?.providerId).not.toBe(cloudId);
    core.close();
  });

  // protects=with "Keep everything on this computer" on and a cloud Answers model, nothing is filled in or sent, and the Meeting says why; fails_when=it runs on the cloud model, or says nothing; no_claim=a model on this computer, which the other tests use.
  test("in Local mode with a cloud Answers model, it doesn't run, and says why", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call) => {
      calls.push(call);
      return { text: "OK" };
    });
    const { core, meeting, client } = await recorded(model, NOTES, async (core) => {
      const cloud = await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test",
        modelId: "gpt-test",
      });
      await core.updateSettings({
        user: { chatModel: { providerId: cloud.id, modelId: "gpt-test" } },
      });
      await core.setLocalOnly(true);
    });
    const before = shown(client);
    expect(await settledFill(core, meeting)).toMatchObject({
      state: "off",
      problem: { kind: "local-mode" },
    });
    expect(calls.filter(isFill)).toEqual([]);
    expect(shown(client)).toEqual(before);
    core.close();
  });
});

/** A call in each language: what each side says, the User's two lines, and what the model writes. */
const CALLS = [
  {
    language: "en",
    mine: MY_LINES,
    theirs: THEIR_LINES,
    typed: ["price", "contract"],
    launchLine: "launch date",
    actionsHeading: "Action items",
    titles: ["Summary", "Decisions", "Action items", "Open questions"],
    stop: ".",
    written: {
      L1: "The enterprise price is 45 dollars a seat ",
      L2: "Dana will send the contract by Friday ",
      SUMMARY: "The call covered pricing, delivery and launch planning ",
      DECISIONS: "The rollout starts in the second quarter ",
      ACTIONS: "Finish the security review — Them ",
      QUESTIONS: "Whether the security review is done in time ",
    },
    budget: "The budget for this year is approved ",
    topics: {
      price: "pricing",
      contract: "contract delivery",
      rollout: "rollout",
      security: "security review",
      question: "review timing",
      term: "price duration",
      budget: "budget approval",
    },
    // What a model may write again in a section, and what it may say beside it from the same line.
    again: {
      L1: "The enterprise price is 45 dollars a seat ",
      L2: "Send the contract by Friday — Dana ",
      beside: "The price holds for two years ",
      kept: false,
    },
    probe: {
      line: "The hall is booked and Felix travel is covered for the meetup ",
      bullet: "12 November meetup hall booked Felix travel covered ",
      other: "The hall costs 2,100 euros without catering ",
      fact: "12 November",
    },
    sameAction: "Send the venue contract by Monday — Nadia ",
    ownHeading: "Who owns the follow-through?",
    otherHeadings: ["What did we discuss?", "Where we landed", "Still to resolve"],
    claimsHeading: "What needs checking against our files?",
    repeatedActions:
      "Dana will send the contract by Friday, Nadia will send the venue contract by Monday, and the other side will finish the security review",
  },
  {
    language: "zh-CN",
    mine: ["我们同意企业版每个席位 45 美元", "Dana 周五前把合同发过来", "第二季度开始上线"],
    theirs: ["今年的预算已经批了", "安全审查还没做"],
    typed: ["价格", "合同"],
    launchLine: "上线日期",
    actionsHeading: "待办",
    titles: ["摘要", "决定", "待办事项", "待定问题"],
    stop: "。",
    written: {
      L1: "企业版每个席位 45 美元",
      L2: "Dana 周五前把合同发过来",
      SUMMARY: "通话讨论了价格、交付和上线安排",
      DECISIONS: "第二季度开始上线",
      ACTIONS: "完成安全审查 — 对方",
      QUESTIONS: "安全审查能否按时完成",
    },
    budget: "今年的预算已经批了",
    topics: {
      price: "价格",
      contract: "合同交付",
      rollout: "上线",
      security: "安全审查",
      question: "审查时间",
      term: "价格有效期",
      budget: "预算审批",
    },
    again: {
      L1: "企业版每个席位 45 美元，已定",
      L2: "把合同发过来 — Dana，周五前",
      beside: "价格两年不变",
      kept: true,
    },
    probe: {
      line: "场地已经订好 Felix 差旅报销 ",
      bullet: "11 月 12 日场地已经订好 Felix 差旅报销 ",
      other: "场地两千一百欧元，不含餐饮 ",
      fact: "11 月 12 日",
    },
    sameAction: "周一前发出场地合同 — Nadia ",
    ownHeading: "这通电话之后要做什么？",
    otherHeadings: ["这次谈了什么？", "最后定了哪些事？", "哪些还没解决？"],
    claimsHeading: "哪些说法还要核对？",
    repeatedActions: "Dana 周五前发合同，Nadia 周一前发场地合同，对方完成安全审查",
  },
] as const;

for (const call of CALLS) {
  const { written, stop, titles } = call;
  const ai = (text: string) => `«${text}»￼«${stop}»`;
  const reference = (topic: string, direction: "above" | "below" = "above") =>
    `«${call.language === "en" ? `${topic} — see ${direction}` : `${topic}，详见${direction === "above" ? "上" : "下"}文`} »￼`;
  const purpose = () => overview(`${written.SUMMARY}[^4]${stop}`);
  const item = (
    id: string,
    topic: string,
    text: string,
    marker: number,
    options: Parameters<typeof fact>[3],
  ) => fact(id, topic, `${text}[^${marker}]${stop}`, options);
  const asked: string[] = [];
  const limits: (number | undefined)[] = [];
  const quotes = {
    1: call.mine[0] as string,
    2: call.mine[1] as string,
    3: call.mine[2] as string,
    4: call.theirs[0] as string,
    5: call.theirs[1] as string,
  };
  const model = ({
    repeats = false,
    reply,
    citations = quotes,
    plans = {},
  }: {
    repeats?: boolean;
    reply?: (prompt: string) => string;
    citations?: Record<number, string>;
    plans?: Record<string, Plan>;
  } = {}) =>
    fillingModel(
      (prompt) => {
        const atHeading = [...prompt.matchAll(/^(H\d+) \(heading\): (.+)$/gm)].find(
          (match) => match[2] === call.actionsHeading,
        )?.[1];
        const lines = new Set([...prompt.matchAll(/^(L\d+): /gm)].map((match) => match[1]));
        const price = item("P1_price", call.topics.price, written.L1, 1, {
          lines: ["L1"],
          sections: repeats ? ["decisions"] : [],
        });
        const contract = item("P1_contract", call.topics.contract, written.L2, 2, {
          lines: ["L2"],
          sections: repeats ? ["actions"] : [],
        });
        const text =
          reply?.(prompt) ??
          [
            lines.has("L1") && price,
            lines.has("L2") && contract,
            item("P1_rollout", call.topics.rollout, written.DECISIONS, 3, {
              sections: ["decisions"],
            }),
            item("P1_security", call.topics.security, written.ACTIONS, 5, {
              sections: ["actions"],
            }),
            item("P1_question", call.topics.question, written.QUESTIONS, 5, {
              sections: ["questions"],
            }),
            ...(repeats
              ? [
                  price,
                  contract,
                  item("P1_term", call.topics.term, call.again.beside, 1, {
                    sections: ["decisions"],
                  }),
                ]
              : []),
            purpose(),
          ]
            .filter((part) => part !== false)
            .join("\n\n");
        if (reply) return text;
        const routes = [...prompt.matchAll(/^(H\d+) \(heading\): /gm)].map(
          (match) => `${match[1]}=${match[1] === atHeading ? "ACTIONS" : "NONE"}`,
        );
        return routes.length > 0 ? `HEADINGS: ${routes.join(" ")}\n\n${text}` : text;
      },
      citations,
      plans,
      {
        seen: (each) => {
          if (!isFill(each)) return;
          asked.push(each.prompt);
          limits.push(each.options.maxOutputTokens);
        },
      },
    );
  const recordedWith = (
    notes: Parameters<typeof writeMind>[1],
    before?: (core: Core) => Promise<void>,
    options: Parameters<typeof model>[0] = {},
  ) => {
    asked.length = 0;
    limits.length = 0;
    return recorded(
      model(options),
      notes,
      async (core) => {
        await core.updateSettings({ user: { language: call.language } });
        await before?.(core);
      },
      undefined,
      { lines: { mine: call.mine, theirs: call.theirs } },
    );
  };
  const typedLines = () => [note(call.typed[0]), note(call.typed[1])];
  const sectionsBelow = [
    `«${titles[0]}»`,
    ai(written.SUMMARY),
    `«${titles[1]}»`,
    ai(written.DECISIONS),
    `«${titles[2]}»`,
    ai(written.ACTIONS),
    `«${titles[3]}»`,
    ai(written.QUESTIONS),
  ];

  describe(`With notes typed in the call, the sections they don't cover follow them (#2306, ${call.language})`, {
    timeout: 60_000,
  }, () => {
    // protects=after a call with two typed lines, each line is filled out in place and then the template's sections follow, as AI text citing the Transcript, the User's lines unchanged, in a reply given room for both; fails_when=only the typed lines are filled out, a section is missing or uncited, a typed line changes, or the reply has only an Answer's room; no_claim=a real model's wording, which the PR's real-model run covers.
    test("two typed lines are filled out in place, then the sections follow, each cited", async () => {
      const { core, meeting, client } = await recordedWith(typedLines());
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() => expect(shown(client)).toHaveLength(4 + sectionsBelow.length));
      expect(shown(client)).toEqual([
        call.typed[0],
        ai(written.L1),
        call.typed[1],
        ai(written.L2),
        ...sectionsBelow,
      ]);
      expect(asked.at(-1)).toContain("### FACT P1_F1");
      expect(asked.at(-1)).toContain("Always include one separately cited overview");
      const prompt = asked.at(-1) ?? "";
      expect(prompt).toContain(`L1: ${call.typed[0]}`);
      expect(prompt).toContain("final choices and work assignments");
      expect(prompt).toContain("topic-only references");
      expect(prompt).toContain("do not write a second CLAIMS inventory");
      expect(prompt.indexOf("### OVERVIEW")).toBeGreaterThan(prompt.indexOf("### END P1_F1"));
      // The lines and the sections, with the thinking before them, get twice an Answer's room.
      expect(limits.length).toBeGreaterThan(0);
      expect(new Set(limits)).toEqual(new Set([16_000]));
      core.close();
    });

    test.each(["L1", "L99"] as const)(
      "a %s address attaches to its line or keeps the fact in its category fallback",
      async (marker) => {
        const { core, meeting, client } = await recordedWith(
          [note(call.launchLine), note(call.typed[0])],
          undefined,
          {
            reply: () =>
              [
                purpose(),
                item("P1_launch", call.topics.rollout, written.DECISIONS, 3, {
                  lines: [marker],
                  sections: marker === "L1" ? [] : ["decisions"],
                }),
              ].join("\n\n"),
            citations: { 3: quotes[3], 4: quotes[4] },
          },
        );
        const before = exactly(client);
        expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
        await vi.waitFor(() =>
          expect(shown(client)).toEqual([
            call.launchLine,
            ...(marker === "L1" ? [ai(written.DECISIONS)] : []),
            call.typed[0],
            `«${titles[0]}»`,
            ai(written.SUMMARY),
            ...(marker === "L99" ? [`«${titles[1]}»`, ai(written.DECISIONS)] : []),
          ]),
        );
        expect(asked.at(-1)).toContain(`L1: ${call.launchLine}`);
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
        expect(await fillOf(core, meeting.id)).toMatchObject({ state: "undone" });
        core.close();
      },
    );

    // protects=a heading the User typed for a section ("Action items", "待办") is that section's place: its items go under it, after the User's own lines there, and the section isn't written again below; fails_when=the action items are missing under the heading, or a second Action items heading follows; no_claim=a real model's choice of heading.
    test(`a typed "${call.actionsHeading}" heading is filled in place, not repeated below`, async () => {
      const { core, meeting, client } = await recordedWith([
        note(call.typed[0]),
        heading(2, call.actionsHeading),
        note(call.typed[1]),
      ]);
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() => expect(shown(client)).toHaveLength(12));
      expect(shown(client)).toEqual([
        call.typed[0],
        ai(written.L1),
        call.actionsHeading,
        call.typed[1],
        ai(written.L2),
        ai(written.ACTIONS),
        `«${titles[0]}»`,
        ai(written.SUMMARY),
        `«${titles[1]}»`,
        ai(written.DECISIONS),
        `«${titles[3]}»`,
        ai(written.QUESTIONS),
      ]);
      core.close();
    });

    test(`an action answering a typed line is written whole under a typed "${call.actionsHeading}" heading, and the line points to it`, async () => {
      const { core, meeting, client } = await recordedWith(
        [note(call.typed[1]), heading(2, call.actionsHeading)],
        undefined,
        {
          reply: () =>
            [
              "HEADINGS: H1=ACTIONS",
              item("P1_contract", call.topics.contract, written.L2, 2, {
                lines: ["L1"],
                sections: ["actions"],
              }),
            ].join("\n\n"),
          citations: { 2: quotes[2] },
        },
      );
      const before = exactly(client);
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() =>
        expect(shown(client)).toEqual([
          call.typed[1],
          reference(call.topics.contract, "below"),
          call.actionsHeading,
          ai(written.L2),
        ]),
      );
      const [pointer] = citationsShownAs(client, reference(call.topics.contract, "below"));
      expect(pointer).toEqual([
        expect.objectContaining({ check: "found", quote: expect.stringContaining(call.mine[1]) }),
      ]);
      expect(pointer).toEqual(citationsShownAs(client, ai(written.L2))[0]);
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      core.close();
    });

    test("same-reply heading routes place a section whose marker omits the destination", async () => {
      const { core, meeting, client } = await recorded(
        fillingModel(
          `HEADINGS: H1=ACTIONS\n\n${item("P1_security", call.topics.security, written.ACTIONS, 5, { sections: ["actions"] })}`,
          {
            5: quotes[5],
          },
        ),
        [heading(2, call.actionsHeading), note(call.typed[0])],
        async (core) => {
          await core.updateSettings({ user: { language: call.language } });
        },
        undefined,
        { lines: { mine: call.mine, theirs: call.theirs } },
      );
      const before = exactly(client);
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
      await vi.waitFor(() =>
        expect(shown(client)).toEqual([call.actionsHeading, call.typed[0], ai(written.ACTIONS)]),
      );
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      core.close();
    });

    test.each(["missing", "shared", "conflicting"] as const)(
      "an invalid %s heading route uses generated sections without dropping good facts",
      async (kind) => {
        const control =
          kind === "missing"
            ? ""
            : kind === "shared"
              ? "HEADINGS: H1=SUMMARY H1=ACTIONS"
              : "HEADINGS: H1=ACTIONS H2=ACTIONS";
        const reply = [
          control,
          purpose(),
          item("P1_security", call.topics.security, written.ACTIONS, 5, { sections: ["actions"] }),
          ...(kind === "conflicting"
            ? [item("P1_contract", call.topics.contract, written.L2, 2, { sections: ["actions"] })]
            : []),
        ].join("\n\n");
        const { core, meeting, client } = await recorded(
          fillingModel(reply, { 2: quotes[2], 4: quotes[4], 5: quotes[5] }),
          [
            heading(2, call.actionsHeading),
            ...(kind === "conflicting" ? [heading(2, call.ownHeading)] : []),
            note(call.typed[0]),
          ],
          async (core) => {
            await core.updateSettings({ user: { language: call.language } });
          },
          undefined,
          { lines: { mine: call.mine, theirs: call.theirs } },
        );
        const before = exactly(client);
        const fill = await settledFill(core, meeting);
        expect(fill).toMatchObject({ state: "filled" });
        await vi.waitFor(() => expect(shown(client)).toContain(ai(written.ACTIONS)));
        expect(shown(client).filter((line) => line === ai(written.ACTIONS))).toHaveLength(1);
        expect(shown(client)).toContain(`«${titles[2]}»`);
        if (kind === "conflicting") expect(shown(client)).toContain(ai(written.L2));
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
        core.close();
      },
    );

    test(`a paragraph named "${call.actionsHeading}" does not cover the section`, async () => {
      const { core, meeting, client } = await recordedWith([
        note(call.typed[0]),
        note(call.actionsHeading),
        note(call.typed[1]),
      ]);
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() => expect(shown(client)).toHaveLength(13));
      expect(shown(client)).toEqual([
        call.typed[0],
        ai(written.L1),
        call.actionsHeading,
        ai(written.L2),
        call.typed[1],
        `«${titles[0]}»`,
        ai(written.SUMMARY),
        `«${titles[1]}»`,
        ai(written.DECISIONS),
        `«${titles[2]}»`,
        ai(written.ACTIONS),
        `«${titles[3]}»`,
        ai(written.QUESTIONS),
      ]);
      expect(asked.at(-1)).toContain(`L2: ${call.actionsHeading}`);
      core.close();
    });

    test("the model can place a section under a heading outside a fixed list", async () => {
      const { core, meeting, client } = await recordedWith(
        [note(call.typed[0]), heading(2, call.ownHeading), note(call.typed[1])],
        undefined,
        {
          reply: () =>
            `HEADINGS: H1=ACTIONS\n\n${item("P1_security", call.topics.security, written.ACTIONS, 5, { sections: ["actions"] })}`,
          citations: { 5: quotes[5] },
        },
      );
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() =>
        expect(shown(client)).toEqual([
          call.typed[0],
          call.ownHeading,
          call.typed[1],
          ai(written.ACTIONS),
        ]),
      );
      expect(asked.at(-1)).toContain(`H1 (heading): ${call.ownHeading}`);
      expect(asked.at(-1)).toContain(`L2: ${call.typed[1]}`);
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() =>
        expect(shown(client)).toEqual([call.typed[0], call.ownHeading, call.typed[1]]),
      );
      core.close();
    });

    test.each(["forward routes", "reverse routes"])(
      "a note containing only arbitrary headings receives every routed section in place (%s)",
      async (order) => {
        const headings = [
          call.otherHeadings[0],
          call.otherHeadings[1],
          call.ownHeading,
          call.otherHeadings[2],
        ];
        const routes = ["H1=SUMMARY", "H2=DECISIONS", "H3=ACTIONS", "H4=QUESTIONS"];
        if (order === "reverse routes") routes.reverse();
        const { core, meeting, client } = await recordedWith(
          headings.map((text) => heading(2, text)),
          undefined,
          {
            reply: () =>
              [
                `HEADINGS: ${routes.join(" ")}`,
                purpose(),
                item("P1_rollout", call.topics.rollout, written.DECISIONS, 3, {
                  sections: ["decisions"],
                }),
                item("P1_security", call.topics.security, written.ACTIONS, 5, {
                  sections: ["actions"],
                }),
                item("P1_question", call.topics.question, written.QUESTIONS, 5, {
                  sections: ["questions"],
                }),
              ].join("\n\n"),
            citations: { 3: quotes[3], 4: quotes[4], 5: quotes[5] },
          },
        );
        expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
        await vi.waitFor(() =>
          expect(shown(client)).toEqual([
            headings[0],
            ai(written.SUMMARY),
            headings[1],
            ai(written.DECISIONS),
            headings[2],
            ai(written.ACTIONS),
            headings[3],
            ai(written.QUESTIONS),
          ]),
        );
        for (const [index, text] of headings.entries()) {
          expect(asked.at(-1)).toContain(`H${index + 1} (heading): ${text}`);
        }
        expect(asked.at(-1)).not.toMatch(/^L\d+:/m);
        core.close();
      },
    );

    test.each(["claims first", "claims last"])(
      "claims routed with %s list only the unsupported fact, whole and once, under that heading",
      async (order) => {
        const supported = `${written.L1.trim()}${stop}`;
        const { core, meeting, client } = await recordedWith(
          [heading(2, call.claimsHeading)],
          async (core) => {
            const sources = await createSourceFolder();
            await addAndProcess(core, [
              await writeSourceFile(sources, "Price list.md", `${supported}\n`),
            ]);
          },
          {
            reply: () => {
              const facts = [
                item("P1_price", call.topics.price, written.L1, 1, {
                  sections: ["summary"],
                  claim: true,
                }),
                item("P1_budget", call.topics.budget, call.budget, 4, {
                  sections: ["summary"],
                  claim: true,
                }),
              ];
              if (order === "claims last") facts.reverse();
              return ["HEADINGS: H1=CLAIMS", ...facts].join("\n\n");
            },
            citations: { 1: quotes[1], 4: quotes[4] },
            plans: { [supported]: { verdict: "supported", quote: supported } },
          },
        );
        expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
        await vi.waitFor(() => expect(shown(client)).toContain(ai(call.budget)));
        const lines = shown(client);
        expect(lines.indexOf(ai(call.budget))).toBe(lines.indexOf(call.claimsHeading) + 1);
        for (const topic of [call.topics.budget, call.topics.price]) {
          for (const direction of ["above", "below"] as const) {
            expect(lines).not.toContain(reference(topic, direction));
          }
        }
        expect(lines.filter((line) => line === ai(written.L1))).toHaveLength(1);
        expect(lines.filter((line) => line === ai(call.budget))).toHaveLength(1);
        core.close();
      },
    );

    test("an unrecognized heading address cannot leak its content into the previous line", async () => {
      const { core, meeting, client } = await recordedWith(
        [heading(2, call.ownHeading), note(call.typed[0])],
        undefined,
        {
          reply: () =>
            [
              "HEADINGS: H1=ACTIONS",
              item("P1_price", call.topics.price, written.L1, 1, { lines: ["L1"] }),
              item("P1_bad", "unrecognized", written.SUMMARY, 4, { sections: ["summary"] }).replace(
                "### END P1_bad",
                "### H1 UNRECOGNIZED\nDiscard this body.",
              ),
              item("P1_security", call.topics.security, written.ACTIONS, 5, {
                sections: ["actions"],
              }),
            ].join("\n\n"),
          citations: { 1: quotes[1], 4: quotes[4], 5: quotes[5] },
        },
      );
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() =>
        expect(shown(client)).toEqual([
          call.ownHeading,
          call.typed[0],
          ai(written.L1),
          ai(written.ACTIONS),
        ]),
      );
      core.close();
    });

    test.each(["H1", "H99"])(
      "a section targeting %s without a structural heading falls back without losing its facts",
      async (target) => {
        const { core, meeting, client } = await recordedWith(
          [note(call.actionsHeading)],
          undefined,
          {
            reply: () =>
              `HEADINGS: ${target}=ACTIONS\n\n${item("P1_security", call.topics.security, written.ACTIONS, 5, { sections: ["actions"] })}`,
            citations: { 5: quotes[5] },
          },
        );
        expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
        await vi.waitFor(() =>
          expect(shown(client)).toEqual([
            call.actionsHeading,
            `«${titles[2]}»`,
            ai(written.ACTIONS),
          ]),
        );
        expect(asked.at(-1)).toContain(`L1: ${call.actionsHeading}`);
        expect(asked.at(-1)).not.toContain("H1 (heading):");
        core.close();
      },
    );

    test.each(["H1", "L99"])(
      "a bare %s target cannot suppress a section's facts or add a second copy",
      async (target) => {
        const { core, meeting, client } = await recordedWith(
          [heading(2, call.ownHeading), note(call.typed[0])],
          undefined,
          {
            reply: () =>
              [
                "HEADINGS: H1=NONE",
                item("P1_rollout", call.topics.rollout, written.DECISIONS, 3, {
                  sections: ["decisions"],
                }),
                ...(target === "H1"
                  ? [item("P1_bad", call.topics.price, written.L1, 1, { lines: [target] })]
                  : []),
                item("P1_price", call.topics.price, written.L1, 1, {
                  lines: target === "L99" ? [target] : [],
                  sections: ["decisions"],
                }),
              ].join("\n\n"),
            citations: { 1: quotes[1], 3: quotes[3] },
          },
        );
        expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
        await vi.waitFor(() =>
          expect(shown(client)).toEqual([
            call.ownHeading,
            call.typed[0],
            `«${titles[1]}»`,
            ai(written.DECISIONS),
            ai(written.L1),
          ]),
        );
        core.close();
      },
    );

    test.each(["H1", "L99"])(
      "a reply with only %s omits an invalid address or falls back to the fact's own topic",
      async (target) => {
        const { core, meeting, client } = await recordedWith(
          [heading(2, call.ownHeading), note(call.typed[0])],
          undefined,
          {
            reply: () =>
              [
                "HEADINGS: H1=NONE",
                item("P1_price", call.topics.price, written.L1, 1, { lines: [target] }),
              ].join("\n\n"),
            citations: { 1: quotes[1] },
          },
        );
        const before = exactly(client);
        const fill = await settledFill(core, meeting);
        expect(fill).toMatchObject({
          state: target === "H1" ? "failed" : "filled",
          mode: "notes",
        });
        if (target === "H1") expect(fill.problem?.kind).toBe("model");
        else {
          const lines = shown(client);
          expect(lines.indexOf(ai(written.L1))).toBe(lines.indexOf(`«${call.topics.price}»`) + 1);
          expect(lines).not.toContain(`«${titles[0]}»`);
          await core.undoMeetingFill(meeting.id);
        }
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
        core.close();
      },
    );

    test("a repeated decision answering a line under its routed heading is written whole once, in place", async () => {
      const { core, meeting, client } = await recordedWith(
        [heading(2, call.otherHeadings[1]), note(call.typed[0])],
        undefined,
        {
          reply: () =>
            [
              "HEADINGS: H1=DECISIONS",
              item("P1_price", call.topics.price, written.L1, 1, {
                lines: ["L1"],
                sections: ["decisions"],
              }),
              item("P1_rollout", call.topics.rollout, written.DECISIONS, 3, {
                sections: ["decisions"],
              }),
              item("P1_price", call.topics.price, written.L1, 1, {
                lines: ["L1"],
                sections: ["decisions"],
              }),
            ].join("\n\n"),
          citations: { 1: quotes[1], 3: quotes[3] },
        },
      );
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() =>
        expect(shown(client)).toEqual([
          call.otherHeadings[1],
          call.typed[0],
          ai(written.L1),
          ai(written.DECISIONS),
        ]),
      );
      core.close();
    });

    test("repeated Transcript lines keep distinct actions sharing the same Citation", async () => {
      const { core, meeting, client } = await recorded(
        fillingModel(
          [
            "HEADINGS: H1=ACTIONS",
            item("P1_contract", call.topics.contract, written.L2, 1, { sections: ["actions"] }),
            item(
              "P1_venue",
              call.language === "en" ? "venue contract" : "场地合同",
              call.sameAction,
              1,
              { sections: ["actions"] },
            ),
            item("P1_security", call.topics.security, written.ACTIONS, 1, {
              sections: ["actions"],
            }),
          ].join("\n"),
          { 1: call.repeatedActions },
        ),
        [heading(2, call.ownHeading)],
        async (core) => {
          await core.updateSettings({ user: { language: call.language } });
        },
        undefined,
        {
          lines: {
            mine: [call.repeatedActions, call.repeatedActions, call.repeatedActions],
            theirs: call.theirs,
          },
        },
      );
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() =>
        expect(shown(client)).toEqual([
          call.ownHeading,
          ai(written.L2),
          ai(call.sameAction),
          ai(written.ACTIONS),
        ]),
      );
      core.close();
    });

    test.each(["opposite owners", "case-sensitive paths"])(
      "a shared Citation cannot erase distinct actions with %s",
      async (kind) => {
        const first =
          kind === "case-sensitive paths"
            ? call.language === "en"
              ? "Send Plan.md on Friday"
              : "周五发送 Plan.md"
            : call.language === "en"
              ? "Alex briefs Bo on Friday"
              : "Alex 周五向 Bo 说明情况";
        const second =
          kind === "case-sensitive paths"
            ? call.language === "en"
              ? "Send plan.md on Friday"
              : "周五发送 plan.md"
            : call.language === "en"
              ? "Bo briefs Alex on Friday"
              : "Bo 周五向 Alex 说明情况";
        const speech = `${first}${stop} ${second}${stop}`;
        const { core, meeting, client } = await recorded(
          fillingModel(
            [
              "HEADINGS: H1=ACTIONS",
              item("P1_first", "first assignment", first, 1, { lines: ["L1"] }),
              item("P1_second", "second assignment", second, 1, { sections: ["actions"] }),
              item("P1_contract", call.topics.contract, written.L2, 2, { sections: ["actions"] }),
            ].join("\n\n"),
            { 1: speech, 2: quotes[2] },
          ),
          [note(call.typed[0]), heading(2, call.actionsHeading)],
          async (core) => {
            await core.updateSettings({ user: { language: call.language } });
          },
          undefined,
          { lines: { mine: [speech, call.mine[1], call.mine[2]], theirs: call.theirs } },
        );
        const before = exactly(client);
        expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
        await vi.waitFor(() =>
          expect(shown(client)).toEqual([
            call.typed[0],
            ai(first),
            call.actionsHeading,
            ai(second),
            ai(written.L2),
          ]),
        );
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
        core.close();
      },
    );

    test.each([false, true])(
      "an uncited overview is counted while good additions survive (existing Summary heading: %s)",
      async (withHeading) => {
        const uncited =
          call.language === "en"
            ? "An overview of the conversation and its follow-through"
            : "这次交流的概况和后续安排";
        const { core, meeting, client } = await recordedWith(
          [...(withHeading ? [heading(2, titles[0])] : []), note(call.typed[0])],
          undefined,
          {
            reply: () =>
              [
                ...(withHeading ? ["HEADINGS: H1=SUMMARY"] : []),
                overview(`${uncited}${stop}`, [4]),
                item("P1_price", call.topics.price, written.L1, 1, { lines: ["L1"] }),
                item("P1_security", call.topics.security, written.ACTIONS, 5, {
                  sections: ["actions"],
                }),
              ].join("\n\n"),
            citations: { 1: quotes[1], 5: quotes[5] },
          },
        );
        const before = exactly(client);
        const fill = await settledFill(core, meeting);
        expect(fill).toMatchObject({ state: "filled", omitted: 1 });
        await vi.waitFor(() => expect(shown(client)).toContain(ai(written.ACTIONS)));
        expect(shown(client).join("\n")).not.toContain(uncited);
        expect(shown(client)).toContain(ai(written.L1));
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
        core.close();
      },
    );

    // protects=a Decisions bullet with a date the filled-out lines don't say stays, so the date is in the note and not only in a bullet that says it; fails_when=the bullet goes because most of its words are above; no_claim=a bullet that says only what is above, which the test below covers.
    test("a Decisions bullet with a date the filled-out lines don't say stays", async () => {
      const { core, meeting, client } = await recordedWith([note(call.typed[0])], undefined, {
        reply: () =>
          [
            item("P1_background", "venue arrangements", call.probe.line, 1, { lines: ["L1"] }),
            item("P1_date", "meeting date", call.probe.bullet, 1, { sections: ["decisions"] }),
            item("P1_cost", "venue cost", call.probe.other, 1, { sections: ["decisions"] }),
          ].join("\n\n"),
      });
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() => expect(shown(client)).toContain(`«${titles[1]}»`));
      expect(shown(client).filter((line) => line.includes(call.probe.fact))).toEqual([
        ai(call.probe.bullet),
      ]);
      core.close();
    });

    test.each([false, true])(
      "a redundant identity is silent and does not resurrect a full Actions item (combined paragraph: %s)",
      async (combined) => {
        const { core, meeting, client } = await recordedWith(
          [note(call.typed[0]), heading(2, call.actionsHeading), note(call.typed[1])],
          undefined,
          {
            reply: () => {
              const commitment = combined
                ? fact(
                    "P1_combined",
                    call.topics.contract,
                    `${written.L1}[^1]${stop} ${written.L2}[^2]${stop}`,
                    { lines: ["L1"], sections: ["actions"] },
                  )
                : item("P1_contract", call.topics.contract, written.L2, 2, {
                    lines: ["L2"],
                    sections: ["actions"],
                  });
              return [
                "HEADINGS: H1=ACTIONS",
                ...(combined
                  ? []
                  : [item("P1_price", call.topics.price, written.L1, 1, { lines: ["L1"] })]),
                commitment,
                commitment,
                purpose(),
              ].join("\n\n");
            },
          },
        );
        const before = exactly(client);
        const fill = await settledFill(core, meeting);
        expect(fill).toMatchObject({ state: "filled", mode: "notes", omitted: 0 });
        const lines = shown(client);
        const full = lines.filter((line) => line.includes(written.L2.trim()));
        expect(full).toHaveLength(1);
        expect(lines.indexOf(full[0] ?? "")).toBeGreaterThan(lines.indexOf(call.actionsHeading));
        if (combined) {
          const pointer = `${reference(call.topics.contract, "below")}\uFFFC`;
          expect(lines.filter((line) => line === pointer)).toHaveLength(1);
          expect(lines[lines.indexOf(call.typed[0]) + 1]).toBe(pointer);
        } else {
          // Its line is already under Action items, so it is filled out there, with no pointer.
          expect(lines[lines.indexOf(call.typed[1]) + 1]).toBe(full[0]);
          expect(
            lines.filter((line) => line.includes(reference(call.topics.contract, "below"))),
          ).toEqual([]);
        }
        expect(lines).not.toContain(`«${titles[2]}»`);
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
        core.close();
      },
    );

    test("an action answering a typed line is written whole in Action items, and the line points to it with the same Citation", async () => {
      const { core, meeting, client } = await recordedWith(typedLines(), undefined, {
        reply: () =>
          [
            item("P1_price", call.topics.price, written.L1, 1, { lines: ["L1"] }),
            item("P1_contract", call.topics.contract, written.L2, 2, {
              lines: ["L2"],
              sections: ["actions"],
            }),
            item("P1_rollout", call.topics.rollout, written.DECISIONS, 3, {
              sections: ["decisions"],
            }),
            purpose(),
          ].join("\n\n"),
        citations: { 1: quotes[1], 2: quotes[2], 3: quotes[3], 4: quotes[4] },
      });
      const before = exactly(client);
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
      await vi.waitFor(() =>
        expect(shown(client)).toEqual([
          call.typed[0],
          ai(written.L1),
          call.typed[1],
          reference(call.topics.contract, "below"),
          `«${titles[0]}»`,
          ai(written.SUMMARY),
          `«${titles[1]}»`,
          ai(written.DECISIONS),
          `«${titles[2]}»`,
          ai(written.L2),
        ]),
      );
      const [pointer] = citationsShownAs(client, reference(call.topics.contract, "below"));
      expect(pointer).toEqual([
        expect.objectContaining({ check: "found", quote: expect.stringContaining(call.mine[1]) }),
      ]);
      expect(pointer).toEqual(citationsShownAs(client, ai(written.L2))[0]);
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      core.close();
    });

    test("the built smoke model follows the same section and heading contract", async () => {
      const { core, meeting, client } = await recorded(
        scriptedModel(() => ({ text: "unused" })),
        [...typedLines(), heading(2, call.actionsHeading)],
        async (core) => {
          await core.updateSettings({ user: { language: call.language } });
        },
        undefined,
        {
          lines: { mine: call.mine, theirs: call.theirs },
          createChatModel: createFakeChatModel,
        },
      );
      const before = exactly(client);
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
      await vi.waitFor(() => expect(shown(client)).toContain(`«${titles[0]}»`));
      expect(shown(client)).toContain(`«${titles[1]}»`);
      expect(shown(client).filter((line) => line === call.actionsHeading)).toHaveLength(1);
      expect(shown(client)).not.toContain(`«${titles[2]}»`);
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      core.close();
    });

    test("identical identity declarations disappear silently while a distinct term sharing its cue stays", async () => {
      const { core, meeting, client } = await recordedWith(typedLines(), undefined, {
        repeats: true,
      });
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() => expect(shown(client)).toHaveLength(15));
      expect(shown(client)).toEqual([
        call.typed[0],
        reference(call.topics.price, "below"),
        call.typed[1],
        reference(call.topics.contract, "below"),
        `«${titles[0]}»`,
        ai(written.SUMMARY),
        `«${titles[1]}»`,
        ai(written.L1),
        ai(written.DECISIONS),
        ai(call.again.beside),
        `«${titles[2]}»`,
        ai(written.L2),
        ai(written.ACTIONS),
        `«${titles[3]}»`,
        ai(written.QUESTIONS),
      ]);
      core.close();
    });

    test("one decision/action fact has one complete occurrence and a topic-only reference", async () => {
      const { core, meeting, client } = await recordedWith(typedLines(), undefined, {
        reply: () => {
          const commitment = item("P1_contract", call.topics.contract, written.L2, 2, {
            sections: ["decisions", "actions"],
          });
          return [commitment, commitment, purpose()].join("\n\n");
        },
      });
      const before = exactly(client);
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 0 });
      await vi.waitFor(() =>
        expect(shown(client)).toContain(reference(call.topics.contract, "below")),
      );
      expect(shown(client).filter((line) => line === ai(written.L2))).toHaveLength(1);
      expect(
        shown(client).filter((line) => line === reference(call.topics.contract, "below")),
      ).toHaveLength(1);
      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      core.close();
    });

    // protects=one Undo takes back the filled-out lines and the sections below them together, leaving the notes exactly as typed; fails_when=a section or an addition stays after Undo, or a typed line changes; no_claim=⌘Z in the editor, which the smoke test covers.
    test("one Undo restores the notes exactly as typed", async () => {
      const { core, meeting, client } = await recordedWith([
        heading(1, call.otherHeadings[0]),
        note(call.typed[0]),
        heading(3, call.actionsHeading),
        note(call.typed[1]),
        note(""),
      ]);
      const before = exactly(client);
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
      await vi.waitFor(() => expect(shown(client)).toContain(`«${titles[0]}»`));
      expect(shown(client)).toContain(ai(written.ACTIONS));

      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      expect(await fillOf(core, meeting.id)).toMatchObject({ state: "undone" });
      core.close();
    });
  });
}

describe("A fill's wait on a claim check or the speaker pass (#2773)", () => {
  // protects=a fill waits on each of its claims' checks with an abort listener on its one signal, and lets go of each once that check settles, so a fill checking dozens of claims holds no more listeners than checks in flight; fails_when=every listener stays on the signal until the fill is dropped; no_claim=Node's own warning, which it no longer prints for an AbortSignal.
  test("a dozen waits on one signal leave no abort listener once each settles", async () => {
    const fill = new AbortController();
    const settled = await Promise.all(
      Array.from({ length: 12 }, (_, at) => orStopped(Promise.resolve(at), fill.signal, -1)),
    );
    expect(settled).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(getEventListeners(fill.signal, "abort")).toHaveLength(0);
  });

  // protects=a wait stopped before its promise settles gives the stopped value at once, and a promise that rejects passes its rejection on, each letting go of its listener; fails_when=a stop waits for the promise, a rejection is swallowed, or a listener stays; no_claim=none beyond protects.
  test("stopped first it gives the stopped value at once; a rejection passes through", async () => {
    const fill = new AbortController();
    const waiting = orStopped(new Promise<number>(() => {}), fill.signal, -1);
    fill.abort();
    await expect(waiting).resolves.toBe(-1);
    const other = new AbortController();
    await expect(orStopped(Promise.reject(new Error("refused")), other.signal, -1)).rejects.toThrow(
      "refused",
    );
    expect(getEventListeners(other.signal, "abort")).toHaveLength(0);
  });
});

describe("How a fill asks its model (#2306)", { timeout: 60_000 }, () => {
  test("the notes think as an Answer does without a post-final Citation repair request", async () => {
    const asked: {
      fill: boolean;
      cites: boolean;
      thinking: string | undefined;
      limit: number | undefined;
    }[] = [];
    const sentence = "The enterprise price is 45 dollars a seat";
    const scripted = fillingModel(
      [
        lineFact("L1", "pricing", `${sentence} [^1].`),
        fact("P1_missing", "unrecorded detail", "The amber lantern arrives tomorrow. [^99]", {
          sections: ["summary"],
        }),
        overview("The call covered commercial planning. [^1]"),
      ].join("\n\n"),
      { 1: MY_LINES[0] as string },
    );
    const createChatModel: ChatModelFactory = (spec) =>
      wrapLanguageModel({
        model: scripted,
        middleware: {
          specificationVersion: "v4",
          transformParams: async ({ params }) => {
            const said = JSON.stringify(params.prompt);
            asked.push({
              fill: said.includes("Fill them in from the transcript"),
              cites: said.includes(CITE_RETRY_INSTRUCTIONS.slice(0, 40)),
              thinking: spec.thinking,
              limit: params.maxOutputTokens,
            });
            return params;
          },
        },
      });
    const { core, meeting, client } = await recorded(
      scripted,
      [note("price")],
      // A model that thinks, as Claude does: one that can't is never asked to.
      async (core) => {
        const claude = await core.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-test",
          modelId: "claude-haiku-5-5",
        });
        await core.updateSettings({
          user: { chatModel: { providerId: claude.id, modelId: "claude-haiku-5-5" } },
        });
      },
      undefined,
      { createChatModel },
    );
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", omitted: 1 });
    await vi.waitFor(() => expect(shown(client)).toContain(`«${sentence} »\uFFFC«.»`));
    expect(shown(client).join("\n")).not.toContain("amber lantern");
    expect(asked.filter((each) => each.fill).length).toBeGreaterThan(0);
    expect(new Set(asked.filter((each) => each.fill).map((each) => each.thinking))).toEqual(
      new Set(["answer"]),
    );
    expect(asked.filter((each) => each.cites)).toEqual([]);
    expectNoCitationRepair(scripted);
    core.close();
  });
});

describe("A long reply's recorded Citations (#2306)", { timeout: 60_000 }, () => {
  test("every marker of a long framed reply keeps its actual checked Citation without repair", async () => {
    const points = Array.from(
      { length: 14 },
      (_, index) => `Point ${index + 1} of the call is noted here`,
    );
    const sentence = "The enterprise price is 45 dollars a seat";
    const model = fillingModel(
      [
        lineFact("L1", "pricing", `${sentence} [^1].`),
        ...points.map((point, index) =>
          fact(`P1_point${index + 1}`, `call detail ${index + 1}`, `${point} [^${index + 2}].`, {
            sections: ["decisions"],
          }),
        ),
        overview("The call covered commercial planning. [^1]"),
      ].join("\n\n"),
      Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [index + 1, MY_LINES[0] as string]),
      ),
    );
    const { core, meeting, client } = await recorded(model, [note("price")]);
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    await vi.waitFor(() => expect(shown(client)).toHaveLength(19));
    const cited = shown(client).filter((line) => line.includes("\uFFFC"));
    expect(cited).toHaveLength(16);
    expect(cited.at(-1)).toBe("«Point 14 of the call is noted here »\uFFFC«.»");
    expectNoCitationRepair(model);
    core.close();
  });
});

describe("A long Transcript is read in parts", () => {
  const passage = (index: number, words: number): WindowedPassage =>
    ({ text: "word ".repeat(words), seq: index }) as unknown as WindowedPassage;

  // protects=a two-hour Transcript fits one part on a model with a large window, and a longer one or a small window is split, every Passage kept once in order; fails_when=a Passage is dropped or repeated, or a short Transcript is split; no_claim=the token estimate's accuracy.
  test("parts fit the budget and keep every Passage once, in order", () => {
    const twoHours = Array.from({ length: 120 }, (_, index) => passage(index, 120));
    expect(transcriptParts(twoHours, FILL_PART_TOKENS)).toHaveLength(1);
    const parts = transcriptParts(twoHours, 4_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat().map((each) => each.seq)).toEqual(twoHours.map((each) => each.seq));
  });
});
