/**
 * A voice memo (#1568), through the core's public interface as "Record a voice memo" uses it:
 * it records the microphone at once, its lines name no one, and after Stop its note lands as
 * one Undo, a title line naming the Mind and the speech in paragraphs, each with its time, in
 * the speaker's own words with nothing added; with no model, the Transcript as it is.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test, vi } from "vitest";
import {
  type Core,
  type CoreAdapters,
  MEETING_SAMPLE_RATE,
  type Meeting,
  type MeetingFill,
} from "../../src/core";
import { CITATION_NODE, GENERATED_MARK } from "../../src/core/api";
import { readVtt } from "../../src/core/documents/formats/vtt";
import { wordsAdded } from "../../src/core/meetings/memo";
import { shownPassages, transcriptCitations } from "../helpers/citations";
import { createTempDataFolder, saveProviderUnasked, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { note, readMind, shownWithAiText, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { fakeSeparator, transcribingCore, transcriptOf, until } from "../helpers/transcription";

const SECOND = 1000;
const SAID = [
  "So I was thinking about the garden this morning",
  "We should plant the tomatoes in May after the frost",
  "And the fence by the shed needs fixing first",
  "Maybe ask Sam to bring the long ladder",
  "The roses can wait until the autumn",
  "That is all for now",
  "One more thing about the water butt",
];
const SAID_ZH = ["我今天早上在想花园的事", "五月霜冻过后种番茄", "先把棚子旁边的篱笆修好"];

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null;

const isTidy = (call: ModelCall) => call.prompt.includes("voice memo the User just recorded");

function tidyingModel(
  reply: string,
  quotes: Record<number, string>,
  {
    failing = () => false,
    seen,
  }: { failing?: () => boolean; seen?: (call: ModelCall) => void } = {},
) {
  return scriptedModel((call) => {
    seen?.(call);
    if (!isTidy(call)) return { text: "OK" };
    if (failing()) return { error: { status: 500, message: "The model is overloaded." } };
    const shown = shownPassages(block(call.prompt, "live-transcript") ?? "");
    const citations = transcriptCitations(call, shown, quotes);
    if (citations) return citations;
    return { text: reply };
  });
}

async function recordedMemo({
  model,
  lines = SAID,
  seconds = 12,
  before,
  into,
}: {
  model?: ReturnType<typeof scriptedModel>;
  lines?: readonly string[];
  seconds?: number;
  before?: (core: Core) => Promise<void>;
  /** Where it goes: a Mind made first, with these notes in it (none: an empty one). */
  into?: Parameters<typeof writeMind>[1];
} = {}) {
  const dataDir = await createTempDataFolder();
  const speakers = fakeSeparator();
  const { core, record } = await transcribingCore(dataDir, {
    ...(model && { model }),
    engine: { lines },
    speakerSeparator: speakers.separator,
  });
  if (model) await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await before?.(core);
  let mindId: string | undefined;
  if (into) {
    mindId = (await core.createMind()).id;
    writeMind(await connectToMind(core, mindId), into);
  }
  const memo = await core.recordMemo(mindId ? { mindId } : undefined);
  const client = await connectToMind(core, memo.mindId);
  await client.settled();
  record(seconds * SECOND, ["microphone", "system"]);
  if (seconds > 0) await until(core, memo.id, (transcript) => transcript.lines >= seconds / 2 - 1);
  await core.stopMeeting(memo.id);
  return { core, memo, client, speakerPasses: speakers.requests };
}

async function settledFill(core: Core, meeting: Meeting): Promise<MeetingFill> {
  return vi.waitFor(
    async () => {
      const fill = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!fill || fill.state === "waiting" || fill.state === "filling") {
        throw new Error(`Not yet: ${JSON.stringify(fill)}`);
      }
      return fill;
    },
    { timeout: 20_000 },
  );
}

function shown(client: MindClient): string[] {
  const lines: string[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      lines.push(shownWithAiText(node));
      return false;
    }
    return true;
  });
  return lines;
}

function citationsIn(node: ProseMirrorNode): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  node.descendants((each) => {
    if (each.type.name === CITATION_NODE) found.push(each.attrs);
  });
  return found;
}

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

async function transcriptText(core: Core, meetingId: string): Promise<string> {
  const { savedPath } = await transcriptOf(core, meetingId);
  if (!savedPath) throw new Error("The Transcript wasn't saved.");
  return readVtt(readFileSync(savedPath, "utf8"))
    .cues.map((cue) => cue.text)
    .join("\n");
}

const microphoneFailed = (): CoreAdapters["audioCapture"] => ({
  systemAudio: true,
  start(_request, sink) {
    sink.state("microphone", "recording");
    sink.audio("microphone", new Int16Array(MEETING_SAMPLE_RATE * 10), Date.now());
    throw new Error("The microphone failed.");
  },
  openSettings: async () => {},
});

async function wavsIn(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(join(dataDir, "meetings"), { recursive: true })).filter((file) =>
      file.endsWith(".wav"),
    );
  } catch {
    return [];
  }
}

describe("Record a voice memo (#1568)", { timeout: 60_000 }, () => {
  // protects=a memo records the microphone at once, in a new Mind with no title in the Folder given, its lines name no one and no speaker pass runs, even with a separator; fails_when=it waits for a start, records the computer's sound, titles its Mind, or labels its lines; no_claim=the window's flow, which e2e/voiceMemo.spec.ts covers.
  test("records the microphone at once, in an untitled Mind, and its lines name no one", async () => {
    const { core, memo, speakerPasses } = await recordedMemo();
    expect(memo).toMatchObject({ kind: "memo", status: "recording", systemAudio: false });
    const mind = (await core.listMinds()).find((each) => each.id === memo.mindId);
    expect(mind?.title).toBe("");

    const saved = await until(core, memo.id, (transcript) => transcript.state === "saved");
    expect(saved.separating).toBe(false);
    await settledFill(core, memo);
    expect(speakerPasses).toEqual([]);
    const cues = readVtt(readFileSync(saved.savedPath as string, "utf8")).cues;
    expect(cues.length).toBeGreaterThan(3);
    expect(cues.map((cue) => cue.speaker)).toEqual(cues.map(() => null));
    expect(cues[0]?.text).toBe(SAID[0]);
    const document = (await core.listDocuments()).find((each) => each.id === saved.documentId);
    expect(document?.name).toMatch(/^Transcript · Voice memo, /);
    core.close();
  });

  // protects=call help refuses a voice memo before it creates a Question or an Answer; fails_when=help is asked on a memo, or a conversation is made; no_claim=the renderer hiding its buttons, which the e2e covers.
  test("call help refuses a voice memo before it asks anything", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, { engine: { lines: SAID } });
    const memo = await core.recordMemo();
    record(6 * SECOND, ["microphone"]);
    await until(core, memo.id, (transcript) => transcript.lines >= 2);

    await expect(core.askMeetingHelp({ meetingId: memo.id, kind: "sum" })).rejects.toThrow(
      "no call help",
    );
    expect(await core.listConversations()).toEqual([]);
    expect((await core.listMeetings())[0]?.help).toBeNull();
    core.close();
  });

  // protects=without the recording notice read, nothing is made and nothing records; fails_when=a Mind or a Meeting is left behind, or audio is captured; no_claim=the notice's words, which the e2e covers.
  test("before the recording notice is read, it makes nothing", async () => {
    const { core } = await transcribingCore(await createTempDataFolder());
    await core.updateSettings({ device: { meetingNoticeAccepted: false } });
    await expect(core.recordMemo()).rejects.toThrow();
    expect(await core.listMeetings()).toEqual([]);
    expect(await core.listMinds()).toEqual([]);
    core.close();
  });

  // protects=with a model, the note lands at the start of the Mind as one write: a title line naming the Mind, then paragraphs each citing its time, all AI text, with no word that wasn't said; one Undo leaves the Mind empty again; fails_when=the title is missing or doesn't name the Mind, a paragraph is uncited or its Citation names a speaker, a word was added, or Undo leaves anything; no_claim=a real model's wording, which the hand check covers.
  test("with a model, a title line and cited paragraphs in the speaker's words, with one Undo", async () => {
    const model = tidyingModel(
      [
        "# The garden",
        "",
        "So I was thinking about the garden this morning [^1].",
        "",
        "We should plant the tomatoes in May after the frost, and the fence by the shed needs fixing first [^2].",
      ].join("\n"),
      { 1: SAID[0] as string, 2: SAID[1] as string },
    );
    const { core, memo, client } = await recordedMemo({ model });
    expect(await settledFill(core, memo)).toMatchObject({
      state: "filled",
      mode: "memo",
      problem: null,
    });
    await vi.waitFor(() => expect(shown(client)).toHaveLength(3));
    expect(shown(client)).toEqual([
      "«The garden»",
      "«So I was thinking about the garden this morning »\uFFFC«.»",
      "«We should plant the tomatoes in May after the frost, and the fence by the shed needs fixing first »\uFFFC«.»",
    ]);
    const doc = readMind(client);
    expect(doc.firstChild?.type.name).toBe("heading");
    expect(doc.firstChild?.attrs.level).toBe(1);
    const citations = citationsIn(doc);
    expect(citations).toHaveLength(2);
    for (const citation of citations) {
      expect(citation).toMatchObject({ check: "found", location: { kind: "time" } });
      expect((citation.location as { speaker?: string }).speaker).toBeUndefined();
    }
    const mind = (await core.listMinds()).find((each) => each.id === memo.mindId);
    expect(mind?.autoTitle).toBe("The garden");

    // The acceptance test: every word of the note was said.
    const said = new Set(wordsOf(await transcriptText(core, memo.id)));
    expect(wordsOf(shown(client).join("\n")).filter((word) => !said.has(word))).toEqual([]);

    await core.undoMeetingFill(memo.id);
    await vi.waitFor(() => expect(shown(client).filter((line) => line !== "")).toEqual([]));
    expect((await settledFill(core, memo)).state).toBe("undone");
    core.close();
  });

  // protects=a tidied note with a word that wasn't said never goes in: the Transcript goes in as it is, a line a paragraph with its time, and the fill says why; fails_when=the invented words land in the Mind, or nothing is written; no_claim=which words a real model adds.
  test("a tidied note that adds words gives way to the Transcript as it is", async () => {
    const model = tidyingModel(
      "# Garden plans\n\nThe whole family loves the garden this morning [^1].",
      { 1: SAID[0] as string },
    );
    const { core, memo, client } = await recordedMemo({ model });
    expect(await settledFill(core, memo)).toMatchObject({
      state: "filled",
      mode: "transcript",
      problem: { kind: "added" },
    });
    await vi.waitFor(() => expect(shown(client).length).toBeGreaterThan(3));
    const lines = shown(client);
    expect(lines[0]).toMatch(/^«Voice memo, .+»$/);
    expect(lines.slice(1, 4)).toEqual(SAID.slice(0, 3).map((line) => `«${line} »\uFFFC`));
    expect(lines.join("\n")).not.toContain("family");
    core.close();
  });

  // protects=with no model set up, the Transcript goes in as it is under a dated title line, a line a paragraph, each citing its own time in order, and the line says why; fails_when=nothing is written, a line is doubled or lost where Passages overlap, or a time is out of order; no_claim=a long Transcript's Passages, which the unit test below covers.
  test("with no model, the Transcript goes in as it is, a line a paragraph, each with its time", async () => {
    const { core, memo, client } = await recordedMemo();
    expect(await settledFill(core, memo)).toMatchObject({
      state: "filled",
      mode: "transcript",
      problem: { kind: "no-model" },
    });
    const cues = readVtt(
      readFileSync((await transcriptOf(core, memo.id)).savedPath as string, "utf8"),
    ).cues;
    await vi.waitFor(() => expect(shown(client)).toHaveLength(cues.length + 1));
    expect(shown(client)).toEqual([
      expect.stringMatching(/^«Voice memo, .+»$/),
      ...cues.map((cue) => `«${cue.text} »\uFFFC`),
    ]);
    const times = citationsIn(readMind(client)).map(
      (citation) => (citation.location as { from: number }).from,
    );
    expect(times).toEqual(cues.map((cue) => cue.startMs));
    core.close();
  });

  /** The note's time chips, as "from-to", in the order of the Transcript's cues. */
  const chipRanges = (client: MindClient): string[] =>
    citationsIn(readMind(client)).map((citation) => {
      const { from, to } = citation.location as { from: number; to: number };
      return `${from}-${to}`;
    });

  // protects=a line said twice gets the time of its own saying, not the first one's; fails_when=the second and third paragraphs cite the same time; no_claim=the shapes below, which carry a cue's identity.
  test("a line said twice gets its own time chip", async () => {
    const lines = ["The blue door is open.", "Check the hallway first.", "The blue door is open."];
    const { core, memo, client } = await recordedMemo({ lines, seconds: 8 });
    expect(await settledFill(core, memo)).toMatchObject({
      state: "filled",
      mode: "transcript",
    });
    const cues = readVtt(
      readFileSync((await transcriptOf(core, memo.id)).savedPath as string, "utf8"),
    ).cues;
    await vi.waitFor(() => expect(shown(client)).toHaveLength(cues.length + 1));
    expect(chipRanges(client)).toEqual(cues.map((cue) => `${cue.startMs}-${cue.endMs}`));
    core.close();
  });

  // protects=a line whose words are inside another cue's text still cites its own cue; fails_when=the first two both cite the first cue, because an occurrence was matched by prefix; no_claim=none beyond protects.
  test("lines that repeat a cue's words get their own cue, not a prefix match", async () => {
    const lines = [
      "Please remember: The blue door is open.",
      "The blue door is open.",
      "The blue door is open.",
    ];
    const { core, memo, client } = await recordedMemo({ lines, seconds: 8 });
    expect(await settledFill(core, memo)).toMatchObject({
      state: "filled",
      mode: "transcript",
    });
    const cues = readVtt(
      readFileSync((await transcriptOf(core, memo.id)).savedPath as string, "utf8"),
    ).cues;
    await vi.waitFor(() => expect(shown(client)).toHaveLength(cues.length + 1));
    expect(chipRanges(client)).toEqual(cues.map((cue) => `${cue.startMs}-${cue.endMs}`));
    core.close();
  });

  // protects=a duplicate line in a long, dense Transcript cites its own cue's start and end, wherever it is; fails_when=a chip takes another cue's range; no_claim=none beyond protects.
  test("a duplicate line in a dense Transcript cites its own cue", async () => {
    const lines = ["The blue door is open.", "Check the hallway first.", "The blue door is open."];
    const { core, memo, client } = await recordedMemo({ lines, seconds: 40 });
    expect(await settledFill(core, memo)).toMatchObject({
      state: "filled",
      mode: "transcript",
    });
    const cues = readVtt(
      readFileSync((await transcriptOf(core, memo.id)).savedPath as string, "utf8"),
    ).cues;
    await vi.waitFor(() => expect(shown(client)).toHaveLength(cues.length + 1));
    expect(chipRanges(client)).toEqual(cues.map((cue) => `${cue.startMs}-${cue.endMs}`));
    core.close();
  });

  // protects=in Local mode with a cloud model, nothing is sent and the Transcript goes in as it is, saying why; fails_when=the cloud model is asked, or nothing is written; no_claim=a local model, which the other tests use.
  test("in Local mode with a cloud model, nothing is sent and the Transcript goes in as it is", async () => {
    const calls: ModelCall[] = [];
    const model = tidyingModel(
      "# The garden\n\nSo I was thinking [^1].",
      { 1: SAID[0] as string },
      {
        seen: (call) => calls.push(call),
      },
    );
    const { core, memo, client } = await recordedMemo({
      model,
      before: async (core) => {
        const cloud = await core.saveChatProvider({
          kind: "openai",
          apiKey: "sk-test",
          modelId: "gpt-test",
        });
        await core.updateSettings({
          user: { chatModel: { providerId: cloud.id, modelId: "gpt-test" } },
        });
        await core.setLocalOnly(true);
      },
    });
    expect(await settledFill(core, memo)).toMatchObject({
      state: "filled",
      mode: "transcript",
      problem: { kind: "local-mode" },
    });
    expect(calls.filter(isTidy)).toEqual([]);
    await vi.waitFor(() => expect(shown(client).length).toBeGreaterThan(1));
    core.close();
  });

  // protects=when the model's service isn't allowed yet, nothing is sent and the Transcript goes in as it is, saying why; fails_when=the cloud model is asked, or nothing is written; no_claim=the consent dialog, which the e2e covers.
  test("with the model's service not allowed yet, nothing is sent and the Transcript goes in as it is", async () => {
    const calls: ModelCall[] = [];
    const model = tidyingModel(
      "# The garden\n\nSo I was thinking about the garden this morning [^1].",
      { 1: SAID[0] as string },
      { seen: (call) => calls.push(call) },
    );
    const { core, memo, client } = await recordedMemo({
      model,
      before: async (core) => {
        const cloud = await saveProviderUnasked(core, {
          kind: "openai",
          apiKey: "sk-test",
          modelId: "gpt-test",
        });
        await core.updateSettings({
          user: { chatModel: { providerId: cloud.id, modelId: "gpt-test" } },
        });
      },
    });
    expect(await settledFill(core, memo)).toMatchObject({
      state: "filled",
      mode: "transcript",
      problem: { kind: "not-allowed" },
    });
    expect(calls.filter(isTidy)).toEqual([]);
    await vi.waitFor(() => expect(shown(client).length).toBeGreaterThan(1));
    core.close();
  });

  // protects=a model that fails leaves the Mind as it was, says why, and Write it again writes the note; fails_when=the failed attempt wrote anything, or the retry can't write it; no_claim=a real model's failure, which the provider tests cover.
  test("a model that fails leaves the Mind as it was, and Write it again writes the note", async () => {
    let failing = true;
    const model = tidyingModel(
      "# The garden\n\nSo I was thinking about the garden this morning [^1].",
      { 1: SAID[0] as string },
      { failing: () => failing },
    );
    const { core, memo, client } = await recordedMemo({ model });
    expect(await settledFill(core, memo)).toMatchObject({
      state: "failed",
      problem: { kind: "model" },
    });
    expect(shown(client).filter((line) => line !== "")).toEqual([]);

    failing = false;
    await core.fillMeetingNotes(memo.id);
    const retried = await vi.waitFor(
      async () => {
        const fill = (await core.listMeetings()).find((each) => each.id === memo.id)?.fill;
        if (fill?.state !== "filled") throw new Error(`Not yet: ${JSON.stringify(fill)}`);
        return fill;
      },
      { timeout: 20_000 },
    );
    expect(retried).toMatchObject({ state: "filled", mode: "memo" });
    await vi.waitFor(() => expect(shown(client)).toHaveLength(2));
    core.close();
  });

  // protects=two quick retries after Undo write the note once, so one Undo takes the whole note back; fails_when=the note is written twice and the second Undo leaves a copy; no_claim=the store's own undo line, which the e2e covers.
  test("two quick retries write the note once, and one Undo takes it all back", async () => {
    const model = tidyingModel(
      "# The garden\n\nSo I was thinking about the garden this morning [^1].",
      { 1: SAID[0] as string },
    );
    const { core, memo, client } = await recordedMemo({ model });
    expect(await settledFill(core, memo)).toMatchObject({ state: "filled", mode: "memo" });
    await core.undoMeetingFill(memo.id);
    await vi.waitFor(() => expect(shown(client).filter((line) => line !== "")).toEqual([]));

    await Promise.all([core.fillMeetingNotes(memo.id), core.fillMeetingNotes(memo.id)]);
    await vi.waitFor(
      async () => {
        const fill = (await core.listMeetings()).find((each) => each.id === memo.id)?.fill;
        if (fill?.state !== "filled") throw new Error(`Not yet: ${JSON.stringify(fill)}`);
      },
      { timeout: 20_000 },
    );
    expect(shown(client)).toEqual([
      "«The garden»",
      "«So I was thinking about the garden this morning »￼«.»",
    ]);

    await core.undoMeetingFill(memo.id);
    await vi.waitFor(() => expect(shown(client).filter((line) => line !== "")).toEqual([]));
    core.close();
  });

  // protects=when recording can't start, no Meeting and no Mind are left behind, so the next try is clean; fails_when=an untitled Mind or a recording memo row stays, or the error is swallowed; no_claim=the window's line for the error.
  test("when recording can't start, nothing is left behind", async () => {
    const core = startCore(await createTempDataFolder(), {
      audioCapture: {
        systemAudio: true,
        start() {
          throw new Error("The microphone couldn't be opened.");
        },
        openSettings: async () => {},
      },
    });
    await core.updateSettings({ device: { meetingNoticeAccepted: true } });
    await expect(core.recordMemo()).rejects.toThrow("microphone");
    expect(await core.listMeetings()).toEqual([]);
    expect(await core.listMinds()).toEqual([]);
    core.close();
  });

  // protects=a start that fails after it heard audio deletes that audio, for a new Mind and an existing one, instead of leaving it where no sweep finds it; fails_when=a WAV stays, a Meeting stays, or the new Mind stays; no_claim=the capture's own cleanup.
  test("a start that fails after it heard audio leaves no audio behind, for a new Mind or an existing one", async () => {
    for (const into of ["new", "existing"] as const) {
      const dataDir = await createTempDataFolder();
      const { core } = await transcribingCore(dataDir, { audioCapture: microphoneFailed() });
      let mindId: string | undefined;
      if (into === "existing") mindId = (await core.createMind({ title: "Notes" })).id;

      await expect(core.recordMemo(mindId ? { mindId } : undefined)).rejects.toThrow(
        "The microphone failed.",
      );

      expect(await wavsIn(dataDir)).toEqual([]);
      expect(await core.listMeetings()).toEqual([]);
      expect(await core.listMinds()).toHaveLength(into === "existing" ? 1 : 0);
      core.close();
    }
  });

  // protects=a memo in which nothing was said writes nothing and says so; fails_when=a title line or an empty note is written; no_claim=none beyond protects.
  test("an empty recording writes nothing, and says so", async () => {
    const { core, memo, client } = await recordedMemo({ seconds: 0 });
    expect(await settledFill(core, memo)).toMatchObject({
      state: "off",
      problem: { kind: "no-transcript" },
    });
    expect(shown(client).filter((line) => line !== "")).toEqual([]);
    core.close();
  });

  // protects=a memo started from a Mind that already has the User's words keeps them as they are and adds its note after them; fails_when=a line of theirs changes or moves; no_claim=the empty Mind in front, which the window chooses.
  test("in a Mind with the User's words, the note goes after them, which stay as they are", async () => {
    const model = tidyingModel(
      "# The garden\n\nSo I was thinking about the garden this morning [^1].",
      { 1: SAID[0] as string },
    );
    const { core, memo, client } = await recordedMemo({ model, into: [note("Shopping list")] });
    expect(await settledFill(core, memo)).toMatchObject({ state: "filled", mode: "memo" });
    await vi.waitFor(() => expect(shown(client)).toHaveLength(3));
    expect(shown(client)).toEqual([
      "Shopping list",
      "«The garden»",
      "«So I was thinking about the garden this morning »\uFFFC«.»",
    ]);
    core.close();
  });

  // protects=quitting while a memo records leaves it paused where its audio ends, still a memo; Stop at the next start transcribes it from its audio and writes its note, its lines naming no one; fails_when=the memo is lost, turns into a call, or its lines get speaker labels; no_claim=a quit while the note is written, which the Meeting tests cover for both.
  test("quitting halfway through keeps the memo; Stop after the next start writes its note", async () => {
    const dataDir = await createTempDataFolder();
    const first = await transcribingCore(dataDir, { engine: { lines: SAID, decodeMs: 30 } });
    const memo = await first.core.recordMemo();
    await until(first.core, memo.id, (transcript) => transcript.state === "live");
    first.record(10 * SECOND, ["microphone"]);
    first.core.close();

    const second = await transcribingCore(dataDir, { engine: { lines: SAID } });
    const [recovered] = await second.core.listMeetings();
    expect(recovered).toMatchObject({
      id: memo.id,
      kind: "memo",
      status: "paused",
      pausedBy: "interrupted",
    });
    await second.core.stopMeeting(memo.id);
    const saved = await until(second.core, memo.id, (transcript) => transcript.state === "saved");
    const cues = readVtt(readFileSync(saved.savedPath as string, "utf8")).cues;
    expect(cues.length).toBeGreaterThan(2);
    expect(cues.every((cue) => cue.speaker === null)).toBe(true);
    expect(await settledFill(second.core, recovered as Meeting)).toMatchObject({
      state: "filled",
      mode: "transcript",
    });
    second.core.close();
  });

  // protects=a memo said in Chinese gets its note in Chinese, its words all said; fails_when=a Chinese word the speaker said reads as added, or the note is dropped; no_claim=a real model's Chinese, which the hand check with Kimi covers.
  test("a memo said in Chinese gets its note with the words said", async () => {
    const model = tidyingModel(
      "# 花园\n\n我今天早上在想花园的事 [^1]。\n\n五月霜冻过后种番茄，先把棚子旁边的篱笆修好 [^2]。",
      { 1: SAID_ZH[0] as string, 2: SAID_ZH[1] as string },
    );
    const { core, memo, client } = await recordedMemo({ model, lines: SAID_ZH });
    expect(await settledFill(core, memo)).toMatchObject({ state: "filled", mode: "memo" });
    await vi.waitFor(() => expect(shown(client)).toHaveLength(3));
    expect(shown(client)[0]).toBe("«花园»");
    const marks = readMind(client).firstChild?.firstChild?.marks.map((mark) => mark.type.name);
    expect(marks).toContain(GENERATED_MARK);
    core.close();
  });
});

describe("What a voice memo's note is made of", () => {
  // protects=a word is added when the Transcript doesn't hold it, in English as words and in Chinese as characters wherever the words split; stopwords and case don't count; fails_when=a said word reads as added, or an unsaid one passes; no_claim=inflections, which count as other words on purpose.
  test("words not said are found, in English and Chinese", () => {
    const said = "So I was thinking about the garden. 我们城市的绿地很多";
    expect(wordsAdded("The Garden, I was thinking.", said)).toEqual([]);
    expect(wordsAdded("The whole family loves the garden", said)).toEqual([
      "whole",
      "family",
      "loves",
    ]);
    expect(wordsAdded("城市绿地很多", said)).toEqual([]);
    expect(wordsAdded("城市公园很多", said)).toEqual(["公园"]);
  });
});
