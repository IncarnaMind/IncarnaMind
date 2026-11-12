import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { createFakeSystemCalendar } from "../../src/core/calendars/fakeSystem";
import { readVtt } from "../../src/core/documents/formats/vtt";
import type { FakeSpeechOptions } from "../../src/core/transcription/fake";
import { createTempDataFolder, nextTurn } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { recordingLog } from "../helpers/log";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;

/** The other side's lines say "Dana is joining us from the Leeds office.", which the engine mishears. */
const MISHEARING: FakeSpeechOptions = { mishears: { Dana: "Donna", Leeds: "Leads" } };

async function linesOf(core: Core, meetingId: string, record: (ms: number) => void) {
  record(12 * SECOND);
  const transcript = await until(core, meetingId, (each) => each.lines >= 6);
  await core.stopMeeting(meetingId);
  await until(core, meetingId, (each) => each.state === "saved");
  const document = (await core.listDocuments()).find((each) => each.id === transcript.documentId);
  return readVtt(readFileSync(document?.path ?? "", "utf8")).cues.map((cue) => cue.text);
}

describe("The transcriber on this computer knows the names in the call (#1031)", {
  timeout: 60_000,
}, () => {
  test("a Words to know word is written as the User writes it; a name not told is still misheard", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
    });
    await core.updateSettings({ user: { meetingWords: ["Leeds", "星河科技"] } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("Donna is joining us from the Leeds office.");
    expect(lines.join(" ")).not.toContain("Leads");
  });

  test("the User's name from Settings › General is told too, without being in Words to know", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
    });
    await core.updateSettings({ user: { authorName: "Dana" } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("Dana is joining us from the Leads office.");
    expect(lines.join(" ")).not.toContain("Donna");
  });

  test("the names in the meeting's Note and the names its Folder's Documents use are told too", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
    });
    const folder = await core.createLibraryGroup({ name: "Expansion", description: "" });
    const file = await writeSourceFile(
      await createSourceFolder(),
      "Office plan.md",
      "# Office plan\n\nThe team moves to the new office in Leeds. Rent in Leeds is lower.",
    );
    const { documents } = await core.addDocuments([file]);
    await waitForProcessing(
      core,
      documents.map((each) => each.id),
    );
    await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
    const mind = await core.createMind({ title: "Weekly call with Dana", folderId: folder.id });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("Dana is joining us from the Leeds office.");
    expect(lines.join(" ")).not.toMatch(/Donna|Leads/);
  });

  test("the people on the calendar event a Note was made for, and their companies, are told first (#190)", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
      systemCalendar: createFakeSystemCalendar({
        access: "allowed",
        calendars: [{ id: "work", title: "Work", source: "Exchange", kind: "exchange" }],
        events: [
          {
            calendarId: "work",
            id: "intro",
            externalId: "intro@example",
            occurrence: null,
            title: "Intro call",
            start: "2026-10-06T09:30:00Z",
            end: "2026-10-06T10:00:00Z",
            allDay: false,
            status: "confirmed",
            attendees: [
              { name: "Priya", email: "priya@example.com", self: true, status: "accepted" },
              { name: "Dana", email: "dana@leeds.co.uk", self: false, status: "accepted" },
            ],
            organizer: null,
            url: null,
            location: null,
            notes: null,
          },
        ],
      }),
    });
    await core.connectCalendar("mac");
    const [event] = await core.listCalendarEvents({
      from: "2026-10-06T00:00:00Z",
      to: "2026-10-07T00:00:00Z",
    });
    const { mindId } = await core.takeEventNotes(event?.id ?? "");
    const meeting = await core.createMeeting({ mindId });
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("Dana is joining us from the Leeds office.");
    expect(lines.join(" ")).not.toMatch(/Donna|Leads/);
  });

  test("a Meeting outside any Folder, with nothing to tell, is transcribed as it was heard", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("Donna is joining us from the Leads office.");
    expect(lines.join(" ")).not.toContain("Dana");
  });
});

describe("A name is written as the meeting's Note writes it (#1031)", { timeout: 60_000 }, () => {
  const SPELLED: FakeSpeechOptions = {
    lines: ["We asked Katherine to send the draft."],
    theirLines: ["高新说下周交付。"],
  };

  // protects=an English name the engine spells another way than the meeting's Note is written the Note's way, on every line, while a Chinese line whose characters read the same as a told name stays as the engine wrote it; fails_when=the English line keeps Katherine, or the Chinese line is rewritten to 高欣; no_claim=a name the engine heard as other sounds, a name that opens a sentence, or any Chinese name.
  test("an English name the Note spells another way is written the Note's way; a Chinese line that reads like a told name stays as heard", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: SPELLED,
    });
    await core.updateSettings({ user: { meetingWords: ["高欣"] } });
    const mind = await core.createMind({ title: "Sync with Catherine Marsh" });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("We asked Catherine to send the draft.");
    expect(lines).toContain("高新说下周交付。");
    expect(lines.join(" ")).not.toMatch(/Katherine|高欣/);
  });

  // protects=a line the engine writes with its accents apart (e and U+0301) has the name written the Note's way, the whole name with no accent left behind, and what the Note doesn't name stays in the Transcript as the engine wrote it, its accent still apart; fails_when=the line keeps Kathérine, or reads Catherine with a stray accent or half the heard name after it, or Renée is rewritten or its accent put into its letter; no_claim=which spellings sound the same (tests/core/toldSpelling.test.ts holds the table).
  test("a name the engine writes with its accent apart is written the Note's way, whole; a name the Note doesn't hold stays as the engine wrote it", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: {
        lines: ["We asked Kathe\u0301rine to send the draft."],
        theirLines: ["Then Rene\u0301e joined the call."],
      },
    });
    const mind = await core.createMind({ title: "Sync with Catherine Marsh" });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("We asked Catherine to send the draft.");
    expect(lines).toContain("Then Rene\u0301e joined the call.");
    expect(lines.join(" ")).not.toMatch(/Kathe|\u0301rine|Ren\u00e9e/);
  });

  test("its twin: a meeting whose Note doesn't name her keeps the engine's spelling", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: SPELLED,
    });
    const mind = await core.createMind({ title: "Sync about the draft" });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);
    expect(lines).toContain("We asked Katherine to send the draft.");
    expect(lines.join(" ")).not.toContain("Catherine");
  });

  // protects=a name typed in the meeting's Note during the call is told to the engine on this computer, so the lines after it spell it the Note's way, and the lines written before stay as they were; fails_when=the later line still reads Donna, or the earlier line is rewritten; no_claim=how soon after typing (the Note is read once it is quiet), a cloud service's own spelling, or the lines before the name was typed.
  test("a name typed in the Note during the call is in the lines that follow; the lines before it stay", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, { engine: MISHEARING });
    const mind = await core.createMind({ title: "Weekly call" });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });
    const live = () =>
      readVtt(readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8")).cues.map(
        (cue) => cue.text,
      );
    record(12 * SECOND);
    await until(core, meeting.id, (each) => each.lines >= 6);
    expect(live()).toContain("Donna is joining us from the Leads office.");
    expect(live().join(" ")).not.toContain("Dana");

    const client = await connectToMind(core, mind.id);
    writeMind(client, [note("Then we ask Dana about the Leeds office.")]);
    await client.settled();
    await vi.waitFor(
      () => {
        record(SECOND);
        expect(live()).toContain("Dana is joining us from the Leeds office.");
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(live()).toContain("Donna is joining us from the Leads office.");
    await core.stopMeeting(meeting.id);
    core.close();
  });

  // protects=the Note's title is part of what a Meeting's words are gathered from, so a name put in it by renaming the Note during the call is told to the engine on this computer, and the lines after it spell it the Note's way, while the lines written before stay as they were; fails_when=the later line still reads Donna and Leads, or the earlier line is rewritten; no_claim=what a cloud service is sent, which the renaming does not change (tests/core/cloudWords.test.ts).
  test("a name put in the Note's title during the call is in the lines that follow; the lines before it stay", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, { engine: MISHEARING });
    const mind = await core.createMind({ title: "Weekly call" });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });
    const live = () =>
      readVtt(readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8")).cues.map(
        (cue) => cue.text,
      );
    record(12 * SECOND);
    await until(core, meeting.id, (each) => each.lines >= 6);
    expect(live()).toContain("Donna is joining us from the Leads office.");
    expect(live().join(" ")).not.toContain("Dana");

    await core.renameMind(mind.id, "Weekly call with Dana in Leeds");
    await vi.waitFor(
      () => {
        record(SECOND);
        expect(live()).toContain("Dana is joining us from the Leeds office.");
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(live()).toContain("Donna is joining us from the Leads office.");
    await core.stopMeeting(meeting.id);
    core.close();
  });

  test("typing in the Note and quitting at once reads nothing after the core closed", async () => {
    const { log, entries } = recordingLog();
    const errors = vi.spyOn(console, "error");
    const { core, record, engineHost } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
      log,
    });
    const mind = await core.createMind({ title: "Weekly call" });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });
    record(6 * SECOND);
    await until(core, meeting.id, (each) => each.lines >= 2);
    const client = await connectToMind(core, mind.id);
    writeMind(client, [note("Then we ask Dana about the Leeds office.")]);
    await client.settled();

    core.close();
    await nextTurn();
    expect(engineHost.started).toBe(1);
    expect(entries.filter((entry) => entry.level !== "info")).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("Chinese in a Transcript follows the User's script (#1031)", { timeout: 60_000 }, () => {
  test("a Traditional line is written in Simplified by default, and both in Traditional once chosen", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: {
        lines: ["我们下周一把盖章的合同寄给你们。"],
        theirLines: ["會議室需要能坐二十四個人。"],
      },
    });
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect((await core.getSettings()).chineseScript).toBe("simplified");
    const first = await core.createMeeting();
    await core.startMeeting({ meetingId: first.id });
    const simplified = await linesOf(core, first.id, record);
    expect(simplified).toContain("会议室需要能坐二十四个人。");
    expect(simplified).toContain("我们下周一把盖章的合同寄给你们。");
    expect(simplified.join("")).not.toContain("會議室");

    await core.updateSettings({ user: { transcriptScript: "traditional" } });
    expect((await core.getSettings()).chineseScript).toBe("traditional");
    const second = await core.createMeeting();
    await core.startMeeting({ meetingId: second.id });
    const traditional = await linesOf(core, second.id, record);
    expect(traditional).toContain("我們下週一把蓋章的合同寄給你們。");
    expect(traditional).toContain("會議室需要能坐二十四個人。");
    expect(traditional.join("")).not.toContain("会议室");
  });

  test("in Traditional, a name the meeting was told stays as the User writes it", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: { lines: ["我们下周一开会。"], theirLines: ["于丽说余总同意。"] },
    });
    await core.updateSettings({
      user: { language: "zh-CN", transcriptScript: "traditional", meetingWords: ["于丽"] },
    });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });

    expect(await linesOf(core, meeting.id, record)).toContain("于丽說餘總同意。");
  });

  test("a walled sub-Folder's Documents name nothing outside the wall", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder(), {
      engine: MISHEARING,
    });
    const expansion = await core.createLibraryGroup({ name: "Expansion", description: "" });
    const secret = await core.createLibraryGroup({
      name: "Secret",
      description: "",
      parentId: expansion.id,
    });
    await core.updateLibraryGroup(secret.id, {
      name: secret.name,
      description: secret.description,
      keepInside: true,
    });
    const file = await writeSourceFile(
      await createSourceFolder(),
      "Office plan.md",
      "# Office plan\n\nThe team moves to the new office in Leeds. Rent in Leeds is lower.",
    );
    const { documents } = await core.addDocuments([file]);
    await waitForProcessing(
      core,
      documents.map((each) => each.id),
    );
    await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: secret.id });
    const mind = await core.createMind({ title: "Weekly call with Dana", folderId: expansion.id });
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });

    const lines = await linesOf(core, meeting.id, record);

    // The Note's own Folder's Documents would say Leeds; the walled sub-Folder's are not theirs.
    expect(lines.join(" ")).toContain("Leads");
    expect(lines.join(" ")).not.toContain("Leeds");
  });
});
