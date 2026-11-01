import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { hashBytes } from "../../src/core/documents/files";
import { readVtt, writeVtt } from "../../src/core/documents/formats/vtt";
import { InvalidInputError } from "../../src/core/errors";
import { FAKE_LINES, FAKE_THEIR_LINES } from "../../src/core/transcription/fake";
import { FAKE_CLOUD_LINES } from "../../src/core/transcription/fakeCloud";
import { askAndFinish, citingModel, onlyCitation, type ShownPassage } from "../helpers/citations";
import { createMemoryKeychain, createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { fakeSeparator, transcribingCore, transcriptOf, until } from "../helpers/transcription";

const SECOND = 1000;
const SONIOX_KEY = "soniox-test-key-0123456789";
const QWEN_KEY = "sk-qwen-test-key-0123456789";

async function chooseSoniox(core: Core) {
  await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
  await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
}

/** The Qwen key in Models, for a region ("cn": Beijing, the first; "intl": Singapore), and Qwen chosen for meetings. */
async function chooseQwen(core: Core, endpoint?: "cn" | "intl") {
  await core.saveChatProvider({
    kind: "qwen",
    ...(endpoint && { endpoint }),
    apiKey: QWEN_KEY,
    modelId: "qwen3.7-plus",
  });
  await core.updateSettings({ device: { transcriptionRoute: "qwen" } });
}

/** The Transcript's lines as its Document shows them, once the saved file's text is indexed: the first's start, and each line's speaker. */
function shownSpeakers(core: Core, documentId: string | null, savedPath: string | null) {
  if (!documentId || !savedPath) throw new Error("The saved Transcript has no Document.");
  const hash = hashBytes(readFileSync(savedPath));
  return vi.waitFor(async () => {
    const { pages, contentHash } = await core.readDocumentText(documentId);
    if (contentHash !== hash || pages.length === 0)
      throw new Error("The saved Transcript's text isn't indexed yet.");
    return {
      from: pages[0]?.label?.from ?? null,
      speakers: pages.flatMap((page) => page.label?.speakers ?? []),
    };
  });
}

/** Every file under a folder, with what it holds. */
function filesUnder(folder: string): { path: string; text: string }[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory()
      ? filesUnder(path)
      : [{ path, text: readFileSync(path).toString("latin1") }];
  });
}

describe("Cloud transcription with the User's own key", { timeout: 60_000 }, () => {
  test("a Meeting transcribed by the chosen service: its lines, and speakers it told apart", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");

    record(9 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    expect(live).toMatchObject({ state: "live", cloud: "soniox", fellBack: null });
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(cues.every((cue) => FAKE_CLOUD_LINES.includes(cue.text))).toBe(true);
    // The microphone in a call is the User's own; the other side's voices are numbered as told
    // apart, the first's lines too once the second spoke (DESIGN.md › Speakers).
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(
      new Set(["Me", "Speaker 1", "Speaker 2"]),
    );
  });

  // protects=on the cloud path too, a line the User said before the others made a sound becomes Me once the computer's sound is heard, not the room's "Speaker 1" the service's voice gave it (#2305); fails_when=the first line keeps a number; no_claim=the local engine, which tests/core/transcripts.test.ts covers.
  test("the User speaks before the others make a sound: the service's first lines read Me once the call is heard", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
    record(4 * SECOND, ["microphone"]);
    await until(core, meeting.id, (transcript) => transcript.lines >= 1);
    record(6 * SECOND);
    const live = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    await vi.waitFor(() =>
      expect(readVtt(readFileSync(live, "utf8")).cues.some((cue) => cue.speaker !== "Me")).toBe(
        true,
      ),
    );
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const { from, speakers } = await shownSpeakers(core, saved.documentId, saved.savedPath);
    // Only the microphone was heard for the first four seconds: the first line is the User's.
    expect(from).toBe(0);
    expect(speakers[0]).toBe("Me");
    expect(speakers.some((speaker) => speaker !== "Me")).toBe(true);
  });

  // protects=the same across a quit: the service numbered the User's first line as a room's voice before the others made a sound, IncarnaMind closed, and once the resumed Meeting hears the call, that line read back from the file becomes Me too (#2305); fails_when=the saved first line keeps "Speaker 1"; no_claim=a macOS that never allows the computer's sound.
  test("the User's first lines read Me after a quit, once the resumed Meeting hears the call", async () => {
    const dataDir = await createTempDataFolder();
    const first = await transcribingCore(dataDir);
    await chooseSoniox(first.core);
    const meeting = await first.core.createMeeting();
    await first.core.startMeeting({ meetingId: meeting.id });
    await until(first.core, meeting.id, (transcript) => transcript.cloud === "soniox");
    first.record(4 * SECOND, ["microphone"]);
    await until(first.core, meeting.id, (transcript) => transcript.lines >= 1);
    first.core.close();

    const second = await transcribingCore(dataDir);
    await chooseSoniox(second.core);
    await second.core.resumeMeeting(meeting.id);
    await until(second.core, meeting.id, (transcript) => transcript.cloud === "soniox");
    second.record(4 * SECOND, ["microphone"]);
    second.record(8 * SECOND);
    const live = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    await vi.waitFor(() =>
      expect(readVtt(readFileSync(live, "utf8")).cues.some((cue) => cue.speaker !== "Me")).toBe(
        true,
      ),
    );
    await second.core.stopMeeting(meeting.id);
    const saved = await until(
      second.core,
      meeting.id,
      (transcript) => transcript.state === "saved",
    );
    const { from, speakers } = await shownSpeakers(second.core, saved.documentId, saved.savedPath);
    expect(from).toBe(0);
    expect(speakers[0]).toBe("Me");
    expect(speakers.some((speaker) => speaker !== "Me")).toBe(true);
    second.core.close();
  });

  // protects=a Transcript saved by an older version, with no callHeard mark and only numbered voices, loads as a call that was heard, so the resumed Meeting keeps the other side's labels instead of making every saved line Me, and only the microphone's new lines are Me (#2305); fails_when=the old numbered lines become Me when the resumed Meeting hears the computer's sound; no_claim=a Transcript saved before the voices map, which has no :system: key to tell it by.
  test("a legacy Transcript with only numbered voices keeps them when the resumed Meeting hears the call", async () => {
    const dataDir = await createTempDataFolder();
    const first = await transcribingCore(dataDir);
    await chooseSoniox(first.core);
    const meeting = await first.core.createMeeting();
    await first.core.startMeeting({ meetingId: meeting.id });
    await until(first.core, meeting.id, (transcript) => transcript.cloud === "soniox");
    first.record(9 * SECOND);
    await until(first.core, meeting.id, (transcript) => transcript.lines >= 4);
    const live = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    await vi.waitFor(() =>
      expect(readVtt(readFileSync(live, "utf8")).cues.some((cue) => cue.speaker !== "Me")).toBe(
        true,
      ),
    );
    first.core.close();

    // The files an older version left: no callHeard mark, and cues whose voices are numbered only.
    const jsonPath = join(dataDir, "Transcripts", `${meeting.id}.json`);
    const saved = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
    delete saved.callHeard;
    // The older version had transcribed all it recorded: the resumed stop catches nothing up.
    saved.doneMs = 9 * SECOND;
    saved.pending = [];
    writeFileSync(jsonPath, JSON.stringify(saved));
    const vttPath = join(dataDir, "Transcripts", `${meeting.id}.vtt`);
    const legacy = readVtt(readFileSync(vttPath, "utf8"));
    writeFileSync(
      vttPath,
      writeVtt({
        cues: legacy.cues.map((cue) => ({ ...cue, speaker: "Speaker 2" })),
        gaps: legacy.gaps,
      }),
    );
    expect(saved).not.toHaveProperty("callHeard");
    expect(Object.keys((saved.voices ?? {}) as Record<string, number>)).toContainEqual(
      expect.stringContaining(":system:"),
    );

    const second = await transcribingCore(dataDir);
    await chooseSoniox(second.core);
    await second.core.resumeMeeting(meeting.id);
    await until(second.core, meeting.id, (transcript) => transcript.cloud === "soniox");
    second.record(8 * SECOND);
    await until(
      second.core,
      meeting.id,
      (transcript) => transcript.lines >= legacy.cues.length + 2,
    );
    await second.core.stopMeeting(meeting.id);
    const stopped = await until(
      second.core,
      meeting.id,
      (transcript) => transcript.state === "saved",
    );
    const { speakers } = await shownSpeakers(second.core, stopped.documentId, stopped.savedPath);
    // The saved lines keep the labels the older version gave them; the microphone's new lines are
    // the only Me, and the other side's are still its own voices.
    expect(speakers.slice(0, legacy.cues.length)).toEqual(legacy.cues.map(() => "Speaker 2"));
    const resumed = speakers.slice(legacy.cues.length);
    expect(resumed).toContain("Me");
    expect(resumed.some((speaker) => speaker !== "Me")).toBe(true);
    expect(
      resumed.every((speaker) => speaker === "Me" || /^(Them|Speaker \d+)$/.test(speaker ?? "")),
    ).toBe(true);
    second.core.close();
  });

  // protects=DESIGN.md › Speakers on the cloud path: one voice on the other side stays "Them", and the speaker pass leaves voices the service told apart as they are; fails_when=one voice is numbered, or the pass runs over the cloud's labels; no_claim=the local pass's own labels, which tests/core/speakerPass.test.ts covers.
  test('with one voice on the other side, its lines say "Them", and the speaker pass leaves the service\'s voices', async () => {
    const dataDir = await createTempDataFolder();
    const pass = fakeSeparator();
    const { core, record } = await transcribingCore(dataDir, {
      engine: { cloud: { voices: 1 } },
      speakerSeparator: pass.separator,
    });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
    record(9 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    await core.stopMeeting(meeting.id);
    const saved = await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "saved" && !transcript.separating,
    );
    const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    expect(pass.requests).toHaveLength(0);
  });

  test("in a room, with no computer sound, the voices it told apart are numbered, never the User, and a Citation names them", async () => {
    const dataDir = await createTempDataFolder();
    const quote = FAKE_CLOUD_LINES[0] as string;
    const { core, record } = await transcribingCore(dataDir, {
      capture: { system: "denied" },
      model: citingModel({
        query: "budget",
        records: (passages: ShownPassage[]) => [
          { marker: 1, passage: passages[0]?.id, quote: `[0:00] ${quote}` },
        ],
        answer: "The budget holds [^1].",
      }),
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
    record(9 * SECOND, ["microphone"]);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 3);
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Speaker 1", "Speaker 2"]));

    await vi.waitFor(
      async () => {
        const found = await core.searchPassages("one point two million", { mode: "keyword" });
        expect(found.map((passage) => passage.documentId)).toContain(live.documentId);
      },
      { timeout: 20_000, interval: 50 },
    );
    const mind = await core.createMind({ title: "Budget" });
    const client = await connectToMind(core, mind.id);
    const { answerId } = await askAndFinish(core, client, mind.id, "Does the budget hold?");
    expect(onlyCitation(client, answerId)).toMatchObject({
      documentId: live.documentId,
      location: { kind: "time", speaker: cues.find((cue) => cue.text === quote)?.speaker },
      check: "found",
    });
    expect(onlyCitation(client, answerId).location).not.toMatchObject({ speaker: "Me" });
  });

  test("the connection dropping hands the live audio to this computer: the gap is marked, the bar says when, and Stop fills it in", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, {
      engine: { cloud: { dropAfterMs: 5 * SECOND } },
    });
    await chooseSoniox(core);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");

    record(4 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    record(3 * SECOND);
    const fellBack = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
    expect(fellBack).toMatchObject({
      cloud: null,
      fellBack: { route: "soniox", reason: "dropped" },
    });
    expect(fellBack.fellBack?.atMs).toBeGreaterThanOrEqual(4 * SECOND);

    // Recording goes on, and this computer gives the lines from here.
    record(6 * SECOND);
    await until(
      core,
      meeting.id,
      (transcript, each) =>
        each.status === "recording" && transcript.state === "live" && transcript.lines >= 4,
    );
    const working = readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8");
    expect(working).toMatch(/^NOTE gap .* cloud$/m);
    const health = (await core.listMeetings())[0]?.health.events;
    expect(health).toContainEqual(
      expect.objectContaining({ kind: "switched", from: "cloud", to: "local", reason: "failed" }),
    );

    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(final.gaps).toEqual([]);
    const texts = final.cues.map((cue) => cue.text);
    expect(texts.some((text) => FAKE_CLOUD_LINES.includes(text))).toBe(true);
    expect(texts.some((text) => FAKE_LINES.includes(text))).toBe(true);
  });

  test("the monthly cap hands the live audio to this computer with a notice; recording never stops", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    await chooseSoniox(core);
    // Soniox's $0.12 an hour: about 30 seconds of the two streams' audio fit.
    await core.updateSettings({ user: { monthlyCap: { currency: "USD", amount: 0.001 } } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");

    record(20 * SECOND);
    const capped = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
    expect(capped).toMatchObject({ cloud: null, fellBack: { route: "soniox", reason: "cap" } });
    record(4 * SECOND);
    const after = await until(
      core,
      meeting.id,
      (transcript, each) => each.status === "recording" && transcript.state === "live",
    );
    expect(after.fellBack?.reason).toBe("cap");
    const events = (await core.listMeetings())[0]?.health.events ?? [];
    expect(events).toContainEqual(expect.objectContaining({ kind: "switched", reason: "cap" }));
    const summary = await core.getCostSummary();
    expect(summary.spentTowardCap?.amount ?? 0).toBeLessThanOrEqual(0.001);
    expect(summary.spent[0]?.amount ?? 0).toBeGreaterThan(0);

    // The cloud's streams finished with what they were sent: no gap at the switch.
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    expect(readVtt(readFileSync(saved.savedPath as string, "utf8")).gaps).toEqual([]);

    // A Meeting started at the cap goes to this computer at once, saying why.
    const next = await core.createMeeting();
    await core.startMeeting({ meetingId: next.id });
    const local = await until(core, next.id, (transcript) => transcript.fellBack !== null);
    expect(local).toMatchObject({ cloud: null, fellBack: { reason: "cap", atMs: 0 } });
  });

  test("choosing the service is the consent to send it meeting audio, named for it; Local mode keeps it off", async () => {
    const dataDir = await createTempDataFolder();
    const { core } = await transcribingCore(dataDir);
    await expect(core.updateSettings({ device: { transcriptionRoute: "soniox" } })).rejects.toThrow(
      InvalidInputError,
    );
    expect((await core.getSettings()).device.transcriptionRoute).toBeNull();

    await chooseSoniox(core);
    const flows = await core.listDataFlows();
    expect(flows).toContainEqual(
      expect.objectContaining({
        flow: {
          id: "transcription",
          service: { id: "https://stt-rt.soniox.com", name: "Soniox" },
          sends: ["meeting-audio"],
        },
        consent: "accepted",
        chosen: true,
      }),
    );

    await core.updateSettings({ device: { transcriptionRoute: "local" } });
    await core.setLocalOnly(true);
    await expect(core.updateSettings({ device: { transcriptionRoute: "soniox" } })).rejects.toThrow(
      InvalidInputError,
    );
  });

  test("a service's own key lives in the keychain, never in the data folder, and a key it refuses isn't kept", async () => {
    const dataDir = await createTempDataFolder();
    const { core } = await transcribingCore(dataDir);
    expect((await core.listTranscriptionServices()).services).toEqual([
      expect.objectContaining({ route: "openai", key: "provider", hasKey: false }),
      expect.objectContaining({ route: "soniox", key: "own", hasKey: false, liveSpeakers: true }),
      expect.objectContaining({ route: "qwen", key: "provider", hasKey: false }),
    ]);

    await chooseSoniox(core);
    expect((await core.listTranscriptionServices()).services[1]).toMatchObject({ hasKey: true });
    const leaked = filesUnder(dataDir).filter((file) => file.text.includes(SONIOX_KEY));
    expect(leaked.map((file) => file.path)).toEqual([]);

    await core.removeTranscriptionKey("soniox");
    expect((await core.listTranscriptionServices()).services[1]).toMatchObject({ hasKey: false });
    expect((await core.getSettings()).device.transcriptionRoute).toBe("local");
  });

  // protects=the services' revision (#2147): of two answers the higher revision is the newer, whichever was asked first; fails_when=a change doesn't raise it, a failed change does, or a list that a change overtook is stamped with a state older than it holds; no_claim=how the app orders the answers it gets, which e2e/modelSetup.spec.ts covers.
  describe("the services' revision", () => {
    test("every committed change raises it and a failed one leaves it", async () => {
      const dataDir = await createTempDataFolder();
      const { core } = await transcribingCore(dataDir);
      const first = await core.listTranscriptionServices();
      expect((await core.listTranscriptionServices()).revision).toBe(first.revision);

      await expect(core.setTranscriptionKey({ route: "soniox", apiKey: "" })).rejects.toThrow(
        InvalidInputError,
      );
      expect((await core.listTranscriptionServices()).revision).toBe(first.revision);

      const saved = await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
      expect(saved.revision).toBeGreaterThan(first.revision);
      expect(saved.services[1]).toMatchObject({ hasKey: true });
      expect((await core.listTranscriptionServices()).revision).toBe(saved.revision);

      const removed = await core.removeTranscriptionKey("soniox");
      expect(removed.revision).toBeGreaterThan(saved.revision);
      expect(removed.services[1]).toMatchObject({ hasKey: false });

      const provider = await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test",
        modelId: "gpt-5.4-mini",
      });
      const withOpenAi = await core.listTranscriptionServices();
      expect(withOpenAi.revision).toBeGreaterThan(removed.revision);
      expect(withOpenAi.services[0]).toMatchObject({ hasKey: true });
      await core.deleteChatProvider(provider.id);
      const without = await core.listTranscriptionServices();
      expect(without.revision).toBeGreaterThan(withOpenAi.revision);
      expect(without.services[0]).toMatchObject({ hasKey: false });
    });

    test("a list that changes overtake while it is read keeps the revision it began at, below theirs", async () => {
      const dataDir = await createTempDataFolder();
      const memory = createMemoryKeychain();
      let hold: Promise<void> | null = null;
      const { core } = await transcribingCore(dataDir, {
        keychain: {
          ...memory,
          get: async (name) => {
            const value = await memory.get(name);
            const waiting = hold;
            hold = null;
            await waiting;
            return value;
          },
        },
      });
      await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
      const began = (await core.listTranscriptionServices()).revision;

      // The list reads the key, then waits; three changes are committed; the list ends.
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racing = core.listTranscriptionServices();
      await core.removeTranscriptionKey("soniox");
      await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
      const last = await core.removeTranscriptionKey("soniox");
      release();
      const listed = await racing;

      expect(listed.revision).toBe(began);
      expect(last.revision).toBeGreaterThan(began);
      expect(last.services[1]).toMatchObject({ hasKey: false });
    });
  });

  test("OpenAI uses the key of the OpenAI provider in Models", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-5.4-mini" });
    expect((await core.listTranscriptionServices()).services[0]).toMatchObject({
      route: "openai",
      model: "gpt-live-transcribe",
      hasKey: true,
      perHour: { currency: "USD", amount: 1.02 },
    });
    await core.updateSettings({ device: { transcriptionRoute: "openai" } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "openai");
    record(6 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    expect(live.cloud).toBe("openai");
    expect((await transcriptOf(core, meeting.id)).fellBack).toBeNull();
  });

  describe("Qwen, with the key of the Qwen provider in Models", () => {
    test("a Meeting transcribed by Qwen: its lines come as sentences, with no speakers of its own", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir);
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(9 * SECOND);
      const live = await until(core, meeting.id, (transcript) => transcript.lines >= 4);
      expect(live).toMatchObject({ state: "live", cloud: "qwen", fellBack: null });
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(cues.every((cue) => FAKE_CLOUD_LINES.includes(cue.text))).toBe(true);
      // Qwen tells no speakers apart: the microphone is "Me" and the call "Them", until #140.
      expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    });

    test("it is offered with the region of the Qwen provider the key is from, and the price there; the consent is for that region's service", async () => {
      const dataDir = await createTempDataFolder();
      const { core } = await transcribingCore(dataDir);
      const qwen = async () =>
        (await core.listTranscriptionServices()).services.find((each) => each.route === "qwen");
      expect(await qwen()).toMatchObject({
        hasKey: false,
        region: null,
        model: "fun-asr-realtime",
      });

      await chooseQwen(core, "intl");
      expect(await qwen()).toMatchObject({
        hasKey: true,
        model: "fun-asr-realtime",
        region: { en: "International (Singapore)", zh: "国际（新加坡）" },
        perHour: { currency: "USD", amount: 0.324 },
        recipient: { en: "Alibaba Cloud", zh: "阿里云" },
        dataUse: {
          summary: { en: expect.stringContaining("isn’t used for model training") },
          url: { en: expect.stringMatching(/^https:\/\/docs\.agent\.bailian\.aliyun\.com\//) },
        },
      });
      expect(await core.listDataFlows()).toContainEqual(
        expect.objectContaining({
          flow: expect.objectContaining({
            id: "transcription",
            service: { id: "https://dashscope-intl.aliyuncs.com", name: "Qwen (Alibaba Cloud)" },
          }),
          consent: "accepted",
          chosen: true,
        }),
      );

      const beijing = await transcribingCore(await createTempDataFolder());
      await chooseQwen(beijing.core);
      expect(
        (await beijing.core.listTranscriptionServices()).services.find(
          (each) => each.route === "qwen",
        ),
      ).toMatchObject({
        region: { en: "China (Beijing)", zh: "中国内地（北京）" },
        perHour: { currency: "CNY", amount: 1.188 },
      });
      expect(await beijing.core.listDataFlows()).toContainEqual(
        expect.objectContaining({
          flow: expect.objectContaining({
            service: { id: "https://dashscope.aliyuncs.com", name: "Qwen (Alibaba Cloud)" },
          }),
          consent: "accepted",
        }),
      );
    });

    test("the key never leaves the keychain: it is in no file of the data folder", async () => {
      const dataDir = await createTempDataFolder();
      const { core } = await transcribingCore(dataDir);
      await chooseQwen(core);
      expect(filesUnder(dataDir).filter((file) => file.text.includes(QWEN_KEY))).toEqual([]);
    });

    test("the connection dropping hands the live audio to this computer: the gap is marked, the bar says when, and Stop fills it in", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        engine: { cloud: { dropAfterMs: 5 * SECOND } },
      });
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(4 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.lines >= 2);
      record(3 * SECOND);
      const fellBack = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      expect(fellBack).toMatchObject({
        cloud: null,
        fellBack: { route: "qwen", reason: "dropped" },
      });

      record(6 * SECOND);
      await until(
        core,
        meeting.id,
        (transcript, each) =>
          each.status === "recording" && transcript.state === "live" && transcript.lines >= 4,
      );
      const working = readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8");
      expect(working).toMatch(/^NOTE gap .* cloud$/m);

      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(final.gaps).toEqual([]);
      const texts = final.cues.map((cue) => cue.text);
      expect(texts.some((text) => FAKE_CLOUD_LINES.includes(text))).toBe(true);
      expect(texts.some((text) => FAKE_LINES.includes(text))).toBe(true);
    });

    test("a drop after a late first partial replays every unfinished second", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        engine: {
          cloud: {
            latePartial: { atMs: SECOND, beginMs: SECOND, text: "Unfinished cloud words" },
            dropAfterMs: 10 * SECOND,
          },
        },
      });
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(11 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(final.gaps).toEqual([]);
      expect(Math.min(...final.cues.map((cue) => cue.startMs))).toBeLessThanOrEqual(SECOND);
      expect(final.cues.some((cue) => FAKE_LINES.includes(cue.text))).toBe(true);
      expect(final.cues.some((cue) => cue.text === "Unfinished cloud words")).toBe(false);
    });

    test("a socket drop while finishing replays the unfinished sentence", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        engine: {
          cloud: {
            latePartial: {
              atMs: SECOND,
              beginMs: SECOND,
              text: "Unfinished cloud words",
              dropOnFinish: true,
            },
          },
        },
      });
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      record(4 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.partial !== null);

      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(final.gaps).toEqual([]);
      expect(Math.min(...final.cues.map((cue) => cue.startMs))).toBeLessThanOrEqual(SECOND);
      expect(final.cues.some((cue) => FAKE_LINES.includes(cue.text))).toBe(true);
    });

    // protects=a healthy Qwen connection, whose heartbeats show it keeps up, stays live through a silence longer than the lag allows, and speech after it is in the saved Transcript when the connection then drops; fails_when=the silence reads as falling behind and closes the socket, or the drop leaves the speech out; no_claim=how often the real service sends heartbeats, which needs a real key.
    test("a silence longer than the lag allows stays live on Qwen, and speech after it survives a dropped connection", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        capture: { system: "silent" },
        engine: { cloud: { dropAfterMs: 40 * SECOND } },
      });
      // The time between chunks, in which the service and the transcription process answer.
      const answered = async () => {
        for (let turn = 0; turn < 10; turn++) await new Promise((done) => setTimeout(done, 0));
      };
      await chooseQwen(core);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      for (let second = 0; second < 36; second++) {
        record(SECOND, ["system"]);
        await answered();
      }
      expect(await transcriptOf(core, meeting.id)).toMatchObject({
        state: "live",
        cloud: "qwen",
        fellBack: null,
      });

      for (let second = 0; second < 6; second++) {
        record(SECOND);
        await answered();
      }
      await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      record(4 * SECOND);
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const final = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(final.gaps).toEqual([]);
      expect(
        final.cues.some((cue) => cue.startMs >= 36 * SECOND && FAKE_LINES.includes(cue.text)),
      ).toBe(true);
    });

    test("the monthly cap counts Qwen's price from the catalog and hands the live audio to this computer; recording never stops", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir);
      await chooseQwen(core);
      // ¥1.188 an hour: about 20 seconds of the two streams' audio fit.
      await core.updateSettings({ user: { monthlyCap: { currency: "USD", amount: 0.001 } } });
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(20 * SECOND);
      const capped = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      expect(capped).toMatchObject({ cloud: null, fellBack: { route: "qwen", reason: "cap" } });
      record(4 * SECOND);
      await until(
        core,
        meeting.id,
        (transcript, each) => each.status === "recording" && transcript.state === "live",
      );
      const summary = await core.getCostSummary();
      expect(summary.spentTowardCap?.amount ?? 0).toBeLessThanOrEqual(0.001);
      expect(summary.spent.some((each) => each.currency === "CNY" && each.amount > 0)).toBe(true);
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      expect(readVtt(readFileSync(saved.savedPath as string, "utf8")).gaps).toEqual([]);
    });

    test("a key made in the other region is turned away: one problem in the bar, this computer takes over, and recording goes on", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir, {
        engine: { cloud: { refuse: true } },
      });
      await chooseQwen(core, "intl");
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      await until(core, meeting.id, (transcript) => transcript.cloud === "qwen");

      record(3 * SECOND);
      const refused = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      expect(refused).toMatchObject({
        cloud: null,
        fellBack: { route: "qwen", reason: "refused" },
      });
      record(6 * SECOND);
      await until(
        core,
        meeting.id,
        (transcript, each) =>
          each.status === "recording" && transcript.state === "live" && transcript.lines >= 2,
      );
      const health = (await core.listMeetings())[0]?.health.events;
      expect(health).toContainEqual(
        expect.objectContaining({ kind: "switched", from: "cloud", to: "local", reason: "failed" }),
      );
    });

    test("Local mode keeps the route off: it can't be chosen, and a Meeting goes to this computer, none of its audio sent", async () => {
      const dataDir = await createTempDataFolder();
      const { core, record } = await transcribingCore(dataDir);
      await chooseQwen(core);
      await core.setLocalOnly(true);
      await core.updateSettings({ device: { transcriptionRoute: "local" } });
      await expect(core.updateSettings({ device: { transcriptionRoute: "qwen" } })).rejects.toThrow(
        InvalidInputError,
      );
      expect((await core.getSettings()).device.transcriptionRoute).toBe("local");

      // Chosen before Local mode was turned on, it still sends nothing.
      await core.setLocalOnly(false);
      await core.updateSettings({ device: { transcriptionRoute: "qwen" } });
      await core.setLocalOnly(true);
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      record(5 * SECOND);
      const live = await until(core, meeting.id, (transcript) => transcript.lines >= 2);
      expect(live).toMatchObject({
        cloud: null,
        fellBack: { route: "qwen", reason: "local-mode", atMs: 0 },
      });
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(cues.some((cue) => FAKE_CLOUD_LINES.includes(cue.text))).toBe(false);
      expect(
        cues.every((cue) => FAKE_LINES.includes(cue.text) || FAKE_THEIR_LINES.includes(cue.text)),
      ).toBe(true);
    });
  });
});
