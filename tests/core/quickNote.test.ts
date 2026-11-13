/**
 * A quick note from the call-help panel's field (#2925), through the core's public interface as
 * the panel writes one: each line a paragraph of the User's own text at the end of the Meeting's
 * Note, the first with the time typing began, landing beside whatever the User is typing in the
 * open Note without taking or losing a character of it, and taken back by the field's Undo.
 */
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { type Core, type Meeting, MIND_BLOCK_TIMES_FIELD } from "../../src/core";
import { blockTimeOf } from "../../src/shared/blockTimes";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { note, readMind, shownWithAiText, writeMind } from "../helpers/minds";
import { transcribingCore } from "../helpers/transcription";

const SECOND = 1000;

/** The Note's top-level lines as shown, AI text in «». */
const lines = (client: MindClient) => {
  const shown: string[] = [];
  readMind(client).forEach((block) => {
    shown.push(shownWithAiText(block));
  });
  return shown;
};

/** Types `text` into the line at `index`, as the editor does, an empty line taking its first text. */
function typeAt(client: MindClient, index: number, offset: number, text: string): void {
  const line = client.blocks.get(index);
  if (line instanceof Y.XmlElement && line.length === 0) line.insert(0, [new Y.XmlText(text)]);
  else typeInto(client, index, offset, text);
}

const idAt = (client: MindClient, index: number): string => {
  const block = client.blocks.get(index);
  const id = block instanceof Y.XmlElement ? block.getAttribute("id") : undefined;
  if (typeof id !== "string") throw new Error(`Block ${index} has no id.`);
  return id;
};

/** A Meeting recording for `seconds`, its Note holding `notes` first, and a client on that Note. */
async function recording(notes: ReturnType<typeof note>[] = [], seconds = 9) {
  const dataDir = await createTempDataFolder();
  const { core, record } = await transcribingCore(dataDir);
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  if (notes.length > 0) writeMind(client, notes);
  await client.settled();
  await core.startMeeting({ meetingId: meeting.id });
  record(seconds * SECOND);
  return { core, meeting, client, record };
}

async function landed(client: MindClient, core: Core, expected: string[]) {
  await expect.poll(() => lines(client)).toEqual(expected);
  core.close();
}

describe("A quick note from the call-help panel (#2925)", () => {
  test("goes at the end of the Meeting's Note as the User's own text, its time the moment typing began", async () => {
    const { core, meeting, client } = await recording([note("Agenda: pricing")]);

    const added = await core.addQuickNote({
      meetingId: meeting.id,
      text: "Ask about single sign-on",
      atMs: 4 * SECOND,
    });

    expect(added).toEqual({ mindId: meeting.mindId, blockIds: [expect.any(String)] });
    await expect
      .poll(() => lines(client).filter(Boolean))
      .toEqual(["Agenda: pricing", "Ask about single sign-on"]);
    const [id] = added.blockIds;
    expect(blockTimeOf(client.doc, id ?? "")).toBe(4 * SECOND);
    // The User's words: no AI mark, and nothing in the record of AI use.
    expect(lines(client).join("\n")).not.toContain("«");
    expect(await core.listAiUse(meeting.mindId)).toEqual([]);
    core.close();
  });

  test("of several lines is one paragraph a line, empty lines dropped, the time on the first only", async () => {
    const { core, meeting, client } = await recording();

    const { blockIds } = await core.addQuickNote({
      meetingId: meeting.id,
      text: "Budget: 40k\n\n  Owner is Dana  \nNext call Friday\n",
      atMs: 6 * SECOND,
    });

    expect(blockIds).toHaveLength(3);
    await expect
      .poll(() => lines(client).filter(Boolean))
      .toEqual(["Budget: 40k", "Owner is Dana", "Next call Friday"]);
    expect(blockIds.map((id) => blockTimeOf(client.doc, id))).toEqual([6 * SECOND, null, null]);
    core.close();
  });

  test("begun while the Meeting was paused has no time, as a line typed in the Note has none", async () => {
    const { core, meeting, client } = await recording();
    await core.pauseMeeting(meeting.id);

    const { blockIds } = await core.addQuickNote({
      meetingId: meeting.id,
      text: "Paused for a side chat",
      atMs: null,
    });

    await expect.poll(() => lines(client).filter(Boolean)).toEqual(["Paused for a side chat"]);
    expect(blockTimeOf(client.doc, blockIds[0] ?? "")).toBeNull();
    expect(client.doc.getMap(MIND_BLOCK_TIMES_FIELD).size).toBe(0);
    core.close();
  });

  test("never claims a moment the Meeting hasn't reached", async () => {
    const { core, meeting, client } = await recording([], 9);

    const { blockIds } = await core.addQuickNote({
      meetingId: meeting.id,
      text: "A line",
      atMs: 60 * SECOND,
    });

    await expect.poll(() => blockTimeOf(client.doc, blockIds[0] ?? "")).toBe(9 * SECOND);
    core.close();
  });

  test("goes after the last line that holds anything, leaving the empty line at the end where it is", async () => {
    const { core, meeting, client } = await recording([note("Pricing"), note("")]);
    const waiting = idAt(client, 1);

    await core.addQuickNote({ meetingId: meeting.id, text: "Quick", atMs: 2 * SECOND });

    await expect.poll(() => lines(client)).toEqual(["Pricing", "Quick", ""]);
    expect(idAt(client, 2)).toBe(waiting);
    core.close();
  });

  test.each([
    {
      case: "into the empty line the cursor waits in at the end",
      notes: [note("Pricing"), note("")],
      at: { index: 1, offset: 0, text: "Budget is set" },
      after: ["Pricing", "Quick note", "Budget is set"],
      undone: ["Pricing", "Quick note", ""],
    },
    {
      case: "at the end of the last line",
      notes: [note("Pricing"), note("Price is")],
      at: { index: 1, offset: "Price is".length, text: " 45 a seat" },
      after: ["Pricing", "Price is 45 a seat", "Quick note"],
      undone: ["Pricing", "Price is", "Quick note"],
    },
  ])(
    "lands while the User types $case in the open Note, losing neither, and ⌘Z there takes back only the typing",
    async ({ notes, at, after, undone }) => {
      const { core, meeting, client } = await recording(notes);
      // The editor's own undo tracks only what the User typed there, by its origin.
      const TYPING = Symbol("typed in the Note");
      const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set([TYPING]) });

      // The core's write and the typing cross: each side makes its change before it hears the other's.
      client.goOffline();
      client.doc.transact(() => typeAt(client, at.index, at.offset, at.text), TYPING);
      await core.addQuickNote({ meetingId: meeting.id, text: "Quick note", atMs: 3 * SECOND });
      await client.goOnline();

      await expect.poll(() => lines(client)).toEqual(after);
      const server = await connectToMind(core, meeting.mindId);
      expect(lines(server)).toEqual(after);

      undo.undo();
      await client.settled();
      expect(lines(client)).toEqual(undone);
      await landed(server, core, undone);
    },
  );

  test("the field's Undo takes it out again, every line of it", async () => {
    const { core, meeting, client } = await recording([note("Pricing")]);
    const added = await core.addQuickNote({
      meetingId: meeting.id,
      text: "One\nTwo",
      atMs: 2 * SECOND,
    });
    await expect.poll(() => lines(client).filter(Boolean)).toEqual(["Pricing", "One", "Two"]);

    expect(await core.undoAddToNote(added)).toEqual({ kept: 0 });

    await landed(client, core, ["Pricing"]);
  });

  test("Undo keeps a line the User changed since, and says so", async () => {
    const { core, meeting, client } = await recording([note("Pricing")]);
    const added = await core.addQuickNote({
      meetingId: meeting.id,
      text: "Budget",
      atMs: 2 * SECOND,
    });
    await expect.poll(() => lines(client).filter(Boolean)).toEqual(["Pricing", "Budget"]);
    typeInto(client, 1, "Budget".length, " is 40k");
    await client.settled();

    expect(await core.undoAddToNote(added)).toEqual({ kept: 1 });

    await landed(client, core, ["Pricing", "Budget is 40k"]);
  });

  test.each([
    { case: "nothing but spaces and empty lines", text: " \n \n" },
    { case: "no text", text: "" },
  ])("refuses $case, writing nothing", async ({ text }) => {
    const { core, meeting, client } = await recording([note("Pricing")]);
    await expect(core.addQuickNote({ meetingId: meeting.id, text, atMs: 0 })).rejects.toMatchObject(
      { name: "InvalidInputError" },
    );
    expect(lines(client)).toEqual(["Pricing"]);
    core.close();
  });

  test.each([
    { case: "not started yet", stopped: false, started: false },
    { case: "stopped", stopped: true, started: true },
  ])("refuses a Meeting $case, writing nothing", async ({ stopped, started }) => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir);
    let meeting: Meeting = await core.createMeeting();
    if (started) {
      meeting = await core.startMeeting({ meetingId: meeting.id });
      record(3 * SECOND);
    }
    if (stopped) meeting = await core.stopMeeting(meeting.id);
    const client = await connectToMind(core, meeting.mindId);
    const before = lines(client);

    await expect(
      core.addQuickNote({ meetingId: meeting.id, text: "Late line", atMs: 0 }),
    ).rejects.toMatchObject({ name: "InvalidInputError" });
    expect(lines(client)).toEqual(before);
    core.close();
  });
});

/** The Block holding `text` among the Note's lines, and its time; null when there is none. */
function lineWith(client: MindClient, text: string): { time: number | null } | null {
  const index = lines(client).indexOf(text);
  return index < 0 ? null : { time: blockTimeOf(client.doc, idAt(client, index)) };
}

const LANGUAGES = [
  { language: "English", line: "Ask about single sign-on" },
  { language: "Chinese", line: "问一下单点登录的价格" },
];

describe("A line left unsent in the call-help panel's field (#2925)", () => {
  test.each(LANGUAGES)(
    "goes into the Note as a quick note when the recording stops, with the time typing began ($language)",
    async ({ line }) => {
      const { core, meeting, client } = await recording([note("Agenda")]);
      await core.setQuickNoteDraft({ meetingId: meeting.id, text: line, atMs: 4 * SECOND });

      await core.stopMeeting(meeting.id);

      await expect.poll(() => lineWith(client, line)).toEqual({ time: 4 * SECOND });
      expect(lines(client).join("\n")).not.toContain("«");
      core.close();
    },
  );

  test.each(LANGUAGES)("goes in when the panel closes, once ($language)", async ({ line }) => {
    const { core, meeting, client } = await recording();
    await core.setQuickNoteDraft({ meetingId: meeting.id, text: line, atMs: 2 * SECOND });

    expect(await core.addQuickNoteDraft(meeting.id)).toMatchObject({ mindId: meeting.mindId });
    expect(await core.addQuickNoteDraft(meeting.id)).toBeNull();
    await core.stopMeeting(meeting.id);

    await expect.poll(() => lines(client).filter((each) => each === line)).toHaveLength(1);
    core.close();
  });

  test.each(LANGUAGES)(
    "goes in when IncarnaMind quits while it records ($language)",
    async ({ line }) => {
      const { core, meeting, client } = await recording();
      await core.setQuickNoteDraft({ meetingId: meeting.id, text: line, atMs: 3 * SECOND });

      core.close();

      await expect.poll(() => lineWith(client, line)).toEqual({ time: 3 * SECOND });
    },
  );

  test("begun while the Meeting was paused, it goes in with no time", async () => {
    const { core, meeting, client } = await recording();
    await core.pauseMeeting(meeting.id);
    await core.setQuickNoteDraft({ meetingId: meeting.id, text: "Side chat", atMs: null });

    await core.stopMeeting(meeting.id);

    await expect.poll(() => lineWith(client, "Side chat")).toEqual({ time: null });
    core.close();
  });

  test.each([
    { case: 'a "/" search', text: "/su" },
    { case: 'a Chinese "/" search', text: "/zj" },
    { case: "only spaces", text: "  \n " },
  ])("adds nothing for $case", async ({ text }) => {
    const { core, meeting, client } = await recording([note("Agenda")]);
    await core.setQuickNoteDraft({ meetingId: meeting.id, text, atMs: 1 * SECOND });

    await core.stopMeeting(meeting.id);

    expect(lines(client).filter(Boolean)).toEqual(["Agenda"]);
    core.close();
  });

  test("a line already sent isn't added again, and a line emptied since adds nothing", async () => {
    const { core, meeting, client } = await recording();
    await core.setQuickNoteDraft({ meetingId: meeting.id, text: "Sent", atMs: 1 * SECOND });
    await core.addQuickNote({ meetingId: meeting.id, text: "Sent", atMs: 1 * SECOND });
    await core.setQuickNoteDraft({ meetingId: meeting.id, text: "Typed then deleted", atMs: null });
    await core.setQuickNoteDraft({ meetingId: meeting.id, text: "", atMs: null });

    await core.stopMeeting(meeting.id);

    await expect.poll(() => lines(client).filter(Boolean)).toEqual(["Sent"]);
    core.close();
  });
});
