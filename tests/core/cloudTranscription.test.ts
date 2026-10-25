import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { readVtt } from "../../src/core/documents/formats/vtt";
import { InvalidInputError } from "../../src/core/errors";
import { FAKE_LINES } from "../../src/core/transcription/fake";
import { FAKE_CLOUD_LINES } from "../../src/core/transcription/fakeCloud";
import { askAndFinish, citingModel, onlyCitation, type ShownPassage } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { fakeSeparator, transcribingCore, transcriptOf, until } from "../helpers/transcription";

const SECOND = 1000;
const SONIOX_KEY = "soniox-test-key-0123456789";

async function chooseSoniox(core: Core) {
  await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
  await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
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
    expect(await core.listTranscriptionServices()).toEqual([
      expect.objectContaining({ route: "openai", key: "provider", hasKey: false }),
      expect.objectContaining({ route: "soniox", key: "own", hasKey: false, liveSpeakers: true }),
    ]);

    await chooseSoniox(core);
    expect((await core.listTranscriptionServices())[1]).toMatchObject({ hasKey: true });
    const leaked = filesUnder(dataDir).filter((file) => file.text.includes(SONIOX_KEY));
    expect(leaked.map((file) => file.path)).toEqual([]);

    await core.removeTranscriptionKey("soniox");
    expect((await core.listTranscriptionServices())[1]).toMatchObject({ hasKey: false });
    expect((await core.getSettings()).device.transcriptionRoute).toBe("local");
  });

  test("OpenAI uses the key of the OpenAI provider in Models", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-5.4-mini" });
    expect((await core.listTranscriptionServices())[0]).toMatchObject({
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
});
