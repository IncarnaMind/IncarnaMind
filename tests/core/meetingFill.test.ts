/**
 * After Stop, a Meeting's notes filled in from its Transcript (#142), through the core's public
 * interface as the meeting bar uses it: under each of the User's lines, or in sections when there
 * are none, every addition AI text citing the Transcript, one Undo, and nothing written when the
 * model fails, a quit cuts it short, or Local mode keeps it off the cloud.
 */
import { wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import type {
  ChatModelFactory,
  Core,
  Meeting,
  MeetingFill,
  SpeakerSeparator,
} from "../../src/core";
import { CITE_RETRY_INSTRUCTIONS } from "../../src/core/answers/prompt";
import type { WindowedPassage } from "../../src/core/documents/search";
import { FILL_PART_TOKENS, transcriptParts } from "../../src/core/meetings/fill";
import { setMindModel } from "../../src/shared/mindModel";
import { pendingProposals } from "../../src/shared/proposals";
import { checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { shownPassages, transcriptCitations } from "../helpers/citations";
import { createTempDataFolder, saveProviderUnasked } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { heading, note, readMind, shownWithAiText, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { fakeSeparator, transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
const MY_LINES = [
  "We agreed the enterprise price is 45 dollars a seat",
  "Dana will send the contract by Friday",
  "The rollout starts in the second quarter",
];
const THEIR_LINES = ["The budget is approved for this year", "We still need the security review"];

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null;

const isFill = (call: ModelCall) =>
  call.prompt.includes("Fill them in from the transcript") || call.prompt.includes("took no notes");

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
    held,
    seen,
  }: { failing?: () => boolean; held?: Promise<void>; seen?: (call: ModelCall) => void } = {},
) {
  return scriptedModel((call) => {
    seen?.(call);
    if (isCheckRun(call)) return checkReply(call, plans);
    if (!isFill(call)) return { text: "OK" };
    if (failing()) return { error: { status: 500, message: "The model is overloaded." } };
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
  }: {
    speakerSeparator?: SpeakerSeparator;
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
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
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
  await core.stopMeeting(meeting.id);
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
  // protects=with the speaker pass (#138) running after the save, the notes wait for it, so their Citations name the final speakers, and are filled in once it ends; fails_when=the fill starts while the pass runs, or never starts after it; no_claim=the pass's labels, which tests/core/speakerPass.test.ts covers.
  test("the notes wait for the speakers to be told apart, then are filled in", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let passing = true;
    const whilePassing: boolean[] = [];
    const model = fillingModel(
      "### L1\nThe enterprise price is 45 dollars a seat [^1].",
      { 1: MY_LINES[0] as string },
      {},
      {
        seen: (call) => {
          if (isFill(call)) whilePassing.push(passing);
        },
      },
    );
    const { separator, requests } = fakeSeparator({ holds });
    const { core, meeting } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
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
    expect(whilePassing.length).toBeGreaterThan(0);
    expect(whilePassing.filter(Boolean)).toEqual([]);
    core.close();
  });

  // protects=a speaker pass that fails releases the notes: they are filled in with the labels the Transcript has, and the Transcript says its speakers couldn't be told apart; fails_when=the fill waits for the rest of the session, or the failure says nothing; no_claim=why the pass failed, which only the log says.
  test("a speaker pass that fails doesn't hold up the notes", async () => {
    const model = fillingModel("### L1\nThe enterprise price is 45 dollars a seat [^1].", {
      1: MY_LINES[0] as string,
    });
    const { separator } = fakeSeparator({ fails: "The speaker process stopped." });
    const { core, meeting } = await recorded(model, NOTES, undefined, undefined, {
      speakerSeparator: separator,
    });
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    const transcript = await until(core, meeting.id, (each) => !each.separating);
    expect(transcript.problem?.kind).toBe("speakers");
    core.close();
  });

  // protects=each of the User's lines gets what the call said about it right under it, as AI text citing the Transcript, in their order and under their headings, the User's own text unchanged, with no Proposal and a Checkpoint before; Undo leaves the notes as the User left them; fails_when=a line moves or changes, an addition isn't AI text or uncited, a Proposal is made, or Undo leaves anything; no_claim=a real model's wording.
  test("under each of the User's lines, in place, cited, with one Undo", async () => {
    const model = fillingModel(
      "### L1\nThe enterprise price is 45 dollars a seat [^1].\n\n### L2\nDana sends the contract by Friday [^2].\n\n### L3\nThe rollout starts in the second quarter [^3].",
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

  // protects=with no notes, the sections are filled in, each citing the Transcript, and "Said in the call, not in your Documents" keeps only the claims the User's Documents don't support; fails_when=a section is missing, uncited, or a supported claim is listed; no_claim=the template's sections (#688).
  test("with no notes, the sections, and only the claims the Documents don't support", async () => {
    const supported = "The enterprise price is 45 dollars a seat.";
    const model = fillingModel(
      [
        "### SUMMARY",
        "The call settled pricing and the contract [^1].",
        "### DECISIONS",
        "- The price is 45 dollars a seat [^1].",
        "### ACTIONS",
        "- Dana sends the contract by Friday — Me [^2].",
        "### QUESTIONS",
        "- The security review is still open [^3].",
        "### CLAIMS",
        `- ${supported.replace(".", "")} [^1].`,
        "- The budget is approved for this year [^4].",
      ].join("\n"),
      {
        1: MY_LINES[0] as string,
        2: MY_LINES[1] as string,
        3: THEIR_LINES[1] as string,
        4: THEIR_LINES[0] as string,
      },
      {
        "The enterprise price is 45 dollars a seat.": {
          verdict: "supported",
          quote: "Enterprise plan: 45 dollars a seat",
        },
      },
    );
    const { core, meeting, client } = await recorded(model, null, async (core) => {
      const sources = await createSourceFolder();
      await addAndProcess(core, [
        await writeSourceFile(sources, "Price list.md", "Enterprise plan: 45 dollars a seat.\n"),
      ]);
    });

    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "sections" });
    await vi.waitFor(() => expect(shown(client).length).toBeGreaterThan(5));
    expect(shown(client)).toEqual([
      "«Summary»",
      "«The call settled pricing and the contract »\uFFFC«.»",
      "«Decisions»",
      "«The price is 45 dollars a seat »\uFFFC«.»",
      "«Action items»",
      "«Dana sends the contract by Friday — Me »\uFFFC«.»",
      "«Open questions»",
      "«The security review is still open »\uFFFC«.»",
      "«Said in the call, not in your Documents»",
      "«The budget is approved for this year »\uFFFC«.»",
    ]);
    core.close();
  });

  // protects=an addition the model wrote without a Citation is dropped, never written uncited, while its cited ones go in; fails_when=an uncited sentence lands in the notes; no_claim=none beyond protects.
  test("an addition without a Citation is dropped", async () => {
    const model = fillingModel(
      "### L1\nThe enterprise price is 45 dollars a seat [^1].\n\n### L2\nDana sends the contract by Friday.\n\n### L3\n- The rollout starts in the second quarter [^1].\n- Everyone agreed.",
      { 1: MY_LINES[0] as string },
    );
    const { core, meeting, client } = await recorded(model, NOTES);
    const before = shown(client);
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    await vi.waitFor(() => expect(shown(client).length).toBeGreaterThan(before.length));
    const added = shown(client).filter((line) => line.includes("«"));
    expect(added).toEqual([
      "«The enterprise price is 45 dollars a seat »\uFFFC«.»",
      "«The rollout starts in the second quarter »\uFFFC«.»",
    ]);
    core.close();
  });

  // protects=a model that fails leaves the Mind as it was and says why, and Try again fills it in; fails_when=anything is written on a failure, or Try again does nothing; no_claim=which provider error it was.
  test("a failing model writes nothing and says why; Try again fills the notes in", async () => {
    let failing = true;
    const model = fillingModel(
      "### L1\nThe enterprise price is 45 dollars a seat [^1].",
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

  // protects=lines the User deletes or moves while the notes are filled in keep their additions, at the end of their heading's part, and nothing the User typed changes; fails_when=an addition is lost, overwrites, or lands under the wrong heading; no_claim=a line moved under another heading, whose additions follow it there.
  test("a line deleted while it fills in gets its addition at the end of its heading's part", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = fillingModel(
      "### L1\nThe enterprise price is 45 dollars a seat [^1].\n\n### L2\nDana sends the contract by Friday [^2].",
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
    core.close();
  });

  // protects=quitting while the notes are filled in leaves the Mind as it was, and the next start says so with Try again; fails_when=anything half-written stays, or the Meeting says it is still filling; no_claim=none beyond protects.
  test("a quit while it fills in leaves nothing written, and the next start says so", async () => {
    const held = new Promise<void>(() => {});
    const model = fillingModel(
      "### L1\nThe enterprise price is 45 dollars a seat [^1].",
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
      fillingModel("### L1\nThe enterprise price is 45 dollars a seat [^1].", {
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
    actionsHeading: "Action items",
    titles: ["Summary", "Decisions", "Action items", "Open questions"],
    stop: ".",
    written: {
      L1: "The enterprise price is 45 dollars a seat ",
      L2: "Dana will send the contract by Friday ",
      SUMMARY: "The budget for this year is approved ",
      DECISIONS: "The rollout starts in the second quarter ",
      ACTIONS: "Finish the security review — Them ",
      QUESTIONS: "Whether the security review is done in time ",
    },
  },
  {
    language: "zh-CN",
    mine: ["我们同意企业版每个席位 45 美元", "Dana 周五前把合同发过来", "第二季度开始上线"],
    theirs: ["今年的预算已经批了", "安全审查还没做"],
    typed: ["价格", "合同"],
    actionsHeading: "待办",
    titles: ["摘要", "决定", "待办事项", "待定问题"],
    stop: "。",
    written: {
      L1: "企业版每个席位 45 美元",
      L2: "Dana 周五前把合同发过来",
      SUMMARY: "今年的预算已经批了",
      DECISIONS: "第二季度开始上线",
      ACTIONS: "完成安全审查 — 对方",
      QUESTIONS: "安全审查能否按时完成",
    },
  },
] as const;

for (const call of CALLS) {
  const { written, stop, titles } = call;
  const ai = (text: string) => `«${text}»￼«${stop}»`;
  const asked: string[] = [];
  const limits: (number | undefined)[] = [];
  // Writes every section whatever the prompt asks, as a model may: only those asked go in.
  const model = () =>
    fillingModel(
      (prompt) => {
        const lines = new Set([...prompt.matchAll(/^(L\d+): /gm)].map((match) => match[1]));
        return [
          lines.has("L1") && `### L1\n${written.L1}[^1]${stop}`,
          lines.has("L2") && `### L2\n${written.L2}[^2]${stop}`,
          `### SUMMARY\n${written.SUMMARY}[^4]${stop}`,
          `### DECISIONS\n- ${written.DECISIONS}[^3]${stop}`,
          `### ACTIONS\n- ${written.ACTIONS}[^5]${stop}`,
          `### QUESTIONS\n- ${written.QUESTIONS}[^5]${stop}`,
        ]
          .filter((part) => part !== false)
          .join("\n\n");
      },
      {
        1: call.mine[0] as string,
        2: call.mine[1] as string,
        3: call.mine[2] as string,
        4: call.theirs[0] as string,
        5: call.theirs[1] as string,
      },
      {},
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
  ) => {
    asked.length = 0;
    limits.length = 0;
    return recorded(
      model(),
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
      expect(asked.at(-1)).toContain("### CLAIMS:");
      // The lines and the sections, with the thinking before them, get twice an Answer's room.
      expect(limits.length).toBeGreaterThan(0);
      expect(new Set(limits)).toEqual(new Set([16_000]));
      core.close();
    });

    // protects=a heading the User typed for a section ("Action items", "待办") is that section's place: its items go under it, after the User's own lines there, and the section isn't written again below; fails_when=the action items are missing under the heading, or a second Action items heading follows; no_claim=headings named otherwise, which follow the notes as any section does.
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

    // protects=with "Fill sections my notes don't cover" off, only the typed lines are filled out and nothing is written below them, even from a model that writes sections unasked; turned back on, Fill in again adds the sections; fails_when=a section is written with the switch off, or none with it on; no_claim=the switch's row in Settings, which the smoke test covers.
    test("with the switch off, nothing is written below the typed lines", async () => {
      const { core, meeting, client } = await recordedWith(typedLines(), (core) =>
        core.updateSettings({ user: { meetingFillUncovered: false } }).then(() => {}),
      );
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled", mode: "notes" });
      await vi.waitFor(() => expect(shown(client)).toHaveLength(4));
      expect(shown(client)).toEqual([call.typed[0], ai(written.L1), call.typed[1], ai(written.L2)]);
      expect(asked.at(-1)).not.toContain("### SUMMARY:");

      await core.undoMeetingFill(meeting.id);
      await core.updateSettings({ user: { meetingFillUncovered: true } });
      await core.fillMeetingNotes(meeting.id);
      await vi.waitFor(() => expect(shown(client)).toHaveLength(4 + sectionsBelow.length));
      expect(shown(client).slice(4)).toEqual(sectionsBelow);
      expect(asked.at(-1)).toContain("### SUMMARY:");
      core.close();
    });

    // protects=one Undo takes back the filled-out lines and the sections below them together, leaving the notes exactly as typed; fails_when=a section or an addition stays after Undo, or a typed line changes; no_claim=⌘Z in the editor, which the smoke test covers.
    test("one Undo restores the notes exactly as typed", async () => {
      const { core, meeting, client } = await recordedWith([
        note(call.typed[0]),
        heading(2, call.actionsHeading),
        note(call.typed[1]),
      ]);
      const before = shown(client);
      expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
      await vi.waitFor(() => expect(shown(client)).toContain(`«${titles[0]}»`));
      expect(shown(client)).toContain(ai(written.ACTIONS));

      await core.undoMeetingFill(meeting.id);
      await vi.waitFor(() => expect(shown(client)).toEqual(before));
      expect(await fillOf(core, meeting.id)).toMatchObject({ state: "undone" });
      core.close();
    });
  });
}

describe("How a fill asks its model (#2306)", { timeout: 60_000 }, () => {
  // protects=a Meeting's notes are asked thinking as an Answer does, and the Citations a reply left out are asked of the small calls' model, which doesn't think first, so neither reply's room goes to thinking and the addition keeps its Citation; fails_when=the notes are asked at a Task's thinking, the Citations of a thinking model, or the addition is dropped as uncited; no_claim=how long a real model thinks, which the real-model run measures.
  test("the notes think as an Answer does, and the Citations they left out are asked without thinking", async () => {
    const asked: { fill: boolean; cites: boolean; thinking: string | undefined }[] = [];
    const sentence = "The enterprise price is 45 dollars a seat";
    const scripted = scriptedModel((call) => {
      if (call.json && call.system === CITE_RETRY_INSTRUCTIONS) {
        const passage = [
          ...call.prompt.matchAll(/<passage id="(P\d+)">\n([\s\S]*?)\n<\/passage>/g),
        ].find((each) => each[2]?.includes(MY_LINES[0] as string));
        // The fake engine says its lines again: only the whole Passage is one place.
        const quote = passage?.[2]?.replace(/\[\d{1,2}:\d{2}(?: [^\]\n]+)?\]\s*/g, "");
        const citations = passage ? [{ sentence, passage: passage[1], quote }] : [];
        return { text: JSON.stringify({ citations }) };
      }
      if (isCheckRun(call)) return checkReply(call, {});
      if (!isFill(call)) return { text: "OK" };
      // Writes its markers, but never calls cite.
      return { text: `### L1\n${sentence} [^1].` };
    });
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
    expect(await settledFill(core, meeting)).toMatchObject({ state: "filled" });
    await vi.waitFor(() => expect(shown(client)).toEqual(["price", `«${sentence} »\uFFFC«.»`]));
    expect(asked.filter((each) => each.fill).map((each) => each.thinking)).toEqual(["answer"]);
    expect(asked.filter((each) => each.cites).map((each) => each.thinking)).toEqual(["off"]);
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
