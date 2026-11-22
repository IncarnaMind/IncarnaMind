import { expect, test } from "vitest";
import type { SystemCalendarEvent } from "../../src/core/adapters";
import { createFakeSystemCalendar } from "../../src/core/calendars/fakeSystem";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { BUILT_IN_SKILLS_DIR } from "../helpers/skills";

const from = "2026-10-06T09:00:00.000Z";
const to = "2026-10-06T18:00:00.000Z";

test("a calendar Note starts its Meeting with the suggested template and its original empty page", async () => {
  const dataDir = await createTempDataFolder();
  const clock = manualClock(from);
  const event = {
    calendarId: "work",
    id: "calendar-interview",
    externalId: "calendar-interview",
    occurrence: null,
    title: "Interview with Priya",
    start: "2026-10-06T10:00:00.000Z",
    end: "2026-10-06T10:30:00.000Z",
    status: "confirmed",
    allDay: false,
    organizer: null,
    attendees: [
      { name: "Me", email: "me@example.test", self: true, status: "accepted" },
      { name: "Priya", email: "priya@example.test", self: false, status: "accepted" },
    ],
    url: null,
    notes: null,
    location: null,
  } satisfies SystemCalendarEvent;
  const core = startCore(dataDir, {
    paths: { dataDir, builtInSkills: BUILT_IN_SKILLS_DIR },
    now: clock.now,
    audioCapture: createFakeCapture({ now: () => clock.now().getTime() }),
    systemCalendar: createFakeSystemCalendar({
      access: "allowed",
      calendars: [{ id: "work", title: "Work", source: "Exchange", kind: "exchange" }],
      events: [event],
    }),
  });

  const starter = (await core.listSkills()).find((skill) => skill.name === "meeting-interview");
  if (!starter) throw new Error("Missing Interview template.");
  await core.connectCalendar("mac");
  const [scheduled] = await core.listCalendarEvents({ from, to });
  if (!scheduled) throw new Error("Missing scheduled interview.");
  const { mindId } = await core.takeEventNotes(scheduled.id);
  const client = await connectToMind(core, mindId);

  const meeting = await core.createMeeting({ mindId });
  expect(meeting).toMatchObject({ writeupTemplateId: starter.id, helpTemplate: "interview" });
  expect(readMind(client).textContent).toBe("");
});

test("a template picked while recording survives Stop and reopening the Meeting", async () => {
  const dataDir = await createTempDataFolder();
  const clock = manualClock(from);
  const open = () =>
    startCore(dataDir, {
      paths: { dataDir, builtInSkills: BUILT_IN_SKILLS_DIR },
      now: clock.now,
      audioCapture: createFakeCapture({ now: () => clock.now().getTime() }),
    });
  const core = open();
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  const meeting = await core.createMeeting();
  const sales = (await core.listSkills()).find((skill) => skill.name === "meeting-sales");
  if (!sales) throw new Error("Missing Sales call template.");
  await core.startMeeting({ meetingId: meeting.id });
  expect(sales.meetingFillUncovered).toBe(true);
  await expect(core.setMeetingTemplateFillUncovered(sales.id, false)).resolves.toMatchObject({
    meetingFillUncovered: false,
  });

  await expect(core.setMeetingWriteupTemplate(meeting.id, sales.id)).resolves.toMatchObject({
    writeupTemplateId: sales.id,
    helpTemplate: "sales",
  });
  expect(readMind(await connectToMind(core, meeting.mindId)).textContent).toBe("");
  await core.stopMeeting(meeting.id);
  core.close();

  const reopened = open();
  expect((await reopened.listSkills()).find(({ id }) => id === sales.id)).toMatchObject({
    meetingFillUncovered: false,
  });
  expect((await reopened.listMeetings()).find(({ id }) => id === meeting.id)).toMatchObject({
    status: "stopped",
    writeupTemplateId: sales.id,
  });
});
