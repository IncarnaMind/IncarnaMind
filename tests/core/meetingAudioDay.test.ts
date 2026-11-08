/**
 * A Meeting's audio is deleted a day after the call (#687), whatever happens to its notes: the
 * Transcript, the Note and what was written in it stay. Through the core's public interface, on a
 * clock the test moves.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { MEETING_AUDIO_KEPT_MS } from "../../src/core/api";
import { meetingFolder } from "../../src/core/meetings/audioFiles";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { transcribingCore, until } from "../helpers/transcription";

const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

// protects=a call's audio stays a whole day after Stop, with its notes written and its Transcript saved, and goes then, files only: the Transcript's Document and file, the Note's text and the Meeting's record stay as they were; fails_when=the audio goes early (when the notes are done) or late, or its deletion takes the Transcript, the notes or the Meeting; no_claim=Keep audio and the setting, which tests/core/meetings.test.ts covers.
test("the audio goes a day after Stop, and the Transcript and the notes stay", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const dataDir = await createTempDataFolder();
  const { core, record, clock } = await transcribingCore(dataDir);
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  writeMind(client, [{ type: "paragraph", content: [{ type: "text", text: "Budget agreed." }] }]);
  await client.settled();
  await core.startMeeting({ meetingId: meeting.id });
  record(12_000);
  await until(core, meeting.id, (transcript) => transcript.lines >= 4);
  await core.stopMeeting(meeting.id);
  const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
  const file = readFileSync(saved.savedPath as string);
  const stopped = (await core.listMeetings()).find((each) => each.id === meeting.id);
  const expiresAt = Date.parse(stopped?.audio.expiresAt ?? "");
  expect(
    Math.abs(expiresAt - (Date.parse(stopped?.stoppedAt ?? "") + MEETING_AUDIO_KEPT_MS)),
  ).toBeLessThan(1000);

  clock.advance(MEETING_AUDIO_KEPT_MS - 2 * MINUTE);
  vi.advanceTimersByTime(MINUTE);
  expect((await core.listMeetings()).find((each) => each.id === meeting.id)?.audio.kept).toBe(true);
  clock.advance(3 * MINUTE);
  vi.advanceTimersByTime(MINUTE);
  const after = (await core.listMeetings()).find((each) => each.id === meeting.id);
  expect(after?.audio).toMatchObject({ kept: false, expiresAt: null });
  expect(existsSync(meetingFolder(dataDir, meeting.id))).toBe(false);

  expect(after).toMatchObject({
    status: "stopped",
    stoppedAt: stopped?.stoppedAt,
    transcript: { state: "saved", documentId: saved.documentId },
  });
  expect(readFileSync(saved.savedPath as string)).toEqual(file);
  const document = (await core.listDocuments()).find((each) => each.id === saved.documentId);
  expect(document?.status).toBe("ready");
  const notes = new TextDecoder().decode(
    (await core.exportMind(meeting.mindId, { format: "markdown" })).data,
  );
  expect(notes).toContain("Budget agreed.");
  core.close();
});
