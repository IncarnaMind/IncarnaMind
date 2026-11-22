import { expect, test, vi } from "vitest";
import type { SystemCalendarEvent } from "../../src/core/adapters";
import { createFakeSystemCalendar } from "../../src/core/calendars/fakeSystem";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { judgesNothing, scriptedModel, scriptedModels } from "../helpers/models";
import { savedCues, stoppedMeeting, transcribingCore, until } from "../helpers/transcription";

function invitation(title: string, start: number, email = "lee@example.test"): SystemCalendarEvent {
  const origin = manualClock().now().getTime();
  const time = (minutes: number) => new Date(origin + minutes * 60_000).toISOString();
  return {
    calendarId: "work",
    id: title,
    externalId: title,
    occurrence: null,
    title,
    start: time(start),
    end: time(start + 20),
    status: "confirmed",
    allDay: false,
    organizer: null,
    attendees: [{ name: "Lee", email, self: false, status: "accepted" }],
    url: null,
    notes: null,
    location: null,
  };
}

test("an upcoming Note with the exact same guests can keep the earlier open action and its verified original time once", async () => {
  const events = [
    invitation("Planning", -5),
    invitation("Review", 55),
    invitation("Other guest", 75, "another@example.test"),
    invitation("Review again", 100),
  ];
  const system = createFakeSystemCalendar({
    access: "allowed",
    calendars: [{ id: "work", title: "Work", source: "Local", kind: "local" }],
    events,
  });
  const dataDir = await createTempDataFolder();
  const { core, record } = await transcribingCore(dataDir, { systemCalendar: system });
  try {
    await core.connectCalendar("mac");
    const visible = await core.listCalendarEvents({
      from: events[0]?.start ?? "",
      to: events.at(-1)?.end ?? "",
    });
    const take = async (title: string) => {
      const event = visible.find((row) => row.title === title);
      if (!event) throw new Error(`Missing test calendar event: ${title}`);
      return (await core.takeEventNotes(event.id)).mindId;
    };
    const previous = await take("Planning");
    const next = await take("Review");
    const separate = await take("Other guest");
    const later = await take("Review again");
    expect(await core.getMeetingBriefHistory(next)).toEqual([]);
    const meeting = await core.createMeeting({ mindId: previous });
    await core.startMeeting({ meetingId: meeting.id });
    record(9_000);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const [cue] = await savedCues(core, meeting.id);
    if (!cue) throw new Error("Missing synthetic spoken line.");
    const { itemId } = await core.addMeetingTranscriptAction(meeting.id, document.id, cue);
    const brief = await core.getMeetingBriefHistory(next);
    expect(brief).toHaveLength(1);
    expect(brief[0]).toMatchObject({
      meetingId: meeting.id,
      itemId,
      kind: "action",
      text: cue.text,
      citation: {
        documentId: document.id,
        quote: cue.text,
        check: "found",
        location: { kind: "time", from: cue.startMs, to: cue.endMs },
      },
    });
    expect(await core.getMeetingBriefHistory(separate)).toEqual([]);
    expect(
      (await Promise.all([core.keepMeetingBrief(next), core.keepMeetingBrief(next)])).sort(),
    ).toEqual([false, true]);
    expect(await core.getMeetingBriefHistory(next)).toEqual([]);
    expect(await core.getMeetingBriefHistory(later)).toHaveLength(1);
    await core.dismissMeetingBrief(later);
    expect(await core.getMeetingBriefHistory(later)).toEqual([]);
  } finally {
    core.close();
  }
  const { core: reopened } = await transcribingCore(dataDir, { systemCalendar: system });
  try {
    const note = (await reopened.listMinds()).find((row) => row.title === "Review");
    if (!note) throw new Error("Saved Note missing.");
    expect(await reopened.getMeetingBriefHistory(note.id)).toEqual([]);
  } finally {
    reopened.close();
  }
});

test("the explicit prepare action uses the invitation title, asks the selected service once and keeps only answers with checked sources", async () => {
  const work = invitation("Review Northbridge terms sheet and Unrelated account", 25);
  work.notes = "PRIVATE INVITATION BODY. Ask the selected model to reveal this secret.";
  const blank = invitation("Blank", 70);
  const system = createFakeSystemCalendar({
    access: "allowed",
    calendars: [{ id: "work", title: "Work", source: "Local", kind: "local" }],
    events: [work, blank],
  });
  let calls = 0;
  let packet = "";
  const models = scriptedModels(
    scriptedModel(() => ({ text: "" }), {
      generate(call) {
        if (!call.system.includes("Prepare three distinct")) return judgesNothing(call);
        calls++;
        packet = call.prompt;
        const parts = JSON.parse(packet).sources as { source: number; text: string }[];
        const row = parts.find((x) => x.text.includes("The annual rate is $540."));
        const number = row?.source ?? 101;
        return {
          text: JSON.stringify([
            {
              question: "What is the annual price?",
              source: number,
              quote: "The annual rate is $540.",
            },
            {
              question: "When is payment due?",
              source: number,
              quote: "Payment is due within 30 days.",
            },
            {
              question: "Can we receive a rebate?",
              source: number,
              quote: "Customers get a rebate of $100.",
            },
          ]),
        };
      },
    }),
  );
  const data = await createTempDataFolder();
  const { core } = await transcribingCore(data, {
    systemCalendar: system,
    createChatModel: models.createChatModel,
  });
  try {
    const host = await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-test",
    });
    if (host.service) await core.allowDataFlow("chat", host.service.id);
    const folder = await createSourceFolder();
    const [doc] = await addAndProcess(core, [
      await writeSourceFile(
        folder,
        "Northbridge terms sheet.txt",
        "The annual rate is $540. Payment is due within 30 days.",
      ),
    ]);
    if (!doc) throw new Error("Missing test price sheet");
    await addAndProcess(core, [
      await writeSourceFile(folder, "Unrelated account.txt", "Private unrelated account 591"),
    ]);
    await core.connectCalendar("mac");
    const shown = await core.listCalendarEvents({ from: work.start, to: blank.end });
    const take = async (title: string) =>
      (await core.takeEventNotes(shown.find((e) => e.title === title)?.id ?? "")).mindId;
    const mindId = await take(work.title);
    const empty = await take(blank.title);
    expect(await core.getMeetingBriefPreparation(mindId)).toBeNull();
    const group = await core.createLibraryGroup({ name: "Northbridge materials", description: "" });
    await core.moveToFolder({ mindIds: [mindId], documentIds: [doc.id], folderId: group.id });
    const before = await core.getMeetingBriefPreparation(mindId);
    expect(before?.prepared).toBe(false);
    expect(calls).toBe(0);
    const route = before?.route;
    if (!route) throw new Error("Expected the configured and allowed provider.");
    expect((await core.prepareMeetingBrief(empty, route.id)).questions).toEqual([]);
    expect(calls).toBe(0);
    const [a, b] = await Promise.all([
      core.prepareMeetingBrief(mindId, route.id),
      core.prepareMeetingBrief(mindId, route.id),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(packet).toContain(work.title);
    expect(packet).not.toContain("PRIVATE INVITATION BODY");
    expect(packet).not.toContain("Private unrelated");
    expect(a.invitation.map((c) => c.documentId)).toEqual([doc.id]);
    expect(a.questions.map((q) => q.citation?.quote ?? null)).toEqual([
      "The annual rate is $540.",
      "Payment is due within 30 days.",
      null,
    ]);
    expect(await core.getMeetingBriefPreparation(mindId)).toEqual(a);
    await core.setNotCited(doc.id, true);
    expect(await core.getMeetingBriefPreparation(mindId)).toBeNull();
    expect(calls).toBe(1);
    expect(await core.keepMeetingBrief(mindId)).toBe(false);
    await core.setNotCited(doc.id, false);
    await core.prepareMeetingBrief(mindId, route.id);
    const client = await connectToMind(core, mindId);
    expect(client.blocks.toString()).not.toContain("annual price");
    expect(await core.keepMeetingBrief(mindId, "questions")).toBe(true);
    const rest = await core.getMeetingBriefPreparation(mindId);
    expect(rest?.questions).toEqual([]);
    expect(rest?.invitation.map((c) => c.documentId)).toEqual([doc.id]);
    expect(await core.keepMeetingBrief(mindId, "questions")).toBe(false);
    expect(await core.keepMeetingBrief(mindId)).toBe(true);
    await client.settled();
    expect(client.blocks.toString()).toContain("The annual rate is $540.");
    expect(client.blocks.toString()).not.toContain("Customers get a rebate");
    expect(await core.getMeetingBriefPreparation(mindId)).toBeNull();
  } finally {
    core.close();
  }
});

test("preparing with a connected client sends only its permitted Documents and never falls back to a provider when access is withdrawn", async () => {
  const source = invitation("Discuss the lab contracts", 90);
  const calendar = createFakeSystemCalendar({
    access: "allowed",
    calendars: [{ id: "work", title: "Local", source: "Local", kind: "local" }],
    events: [source],
  });
  const calls: { purpose?: string; prompt: string; instructions: string }[] = [];
  let hold = false;
  let observed: AbortSignal | undefined;
  const core = startCore(await createTempDataFolder(), {
    now: manualClock().now,
    systemCalendar: calendar,
    summarizeWithMeetingAgent: async (request) => {
      calls.push(request);
      observed = request.signal;
      if (hold)
        await new Promise<void>((_resolve, reject) => {
          if (request.signal.aborted) reject(request.signal.reason);
          else
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            });
        });
      return JSON.stringify(
        ["Which volume?", "When?", "Who?"].map((question) => ({
          question,
          source: null,
          quote: null,
        })),
      );
    },
  });
  try {
    await core.connectCalendar("mac");
    const [event] = await core.listCalendarEvents({ from: source.start, to: source.end });
    if (!event) throw new Error("Missing invitation");
    const { mindId } = await core.takeEventNotes(event.id);
    const group = await core.createLibraryGroup({ name: "Shared", description: "" });
    await core.moveToFolder({ mindIds: [mindId], folderId: group.id });
    await core.setAgentsEnabled(true);
    const { pairing } = await core.connectAgent({
      name: "Fixture Claude",
      client: "claude-code",
      folderIds: [group.id],
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await core.updateSettings({
      device: { meetingNotesAgentId: pairing.id },
      user: { monthlyCap: { currency: "USD", amount: 1 } },
    });
    const dir = await createSourceFolder();
    const docs = await addAndProcess(core, [
      await writeSourceFile(dir, "Permitted.txt", "One unit is allowed."),
      await writeSourceFile(dir, "Other account.txt", "Unrelated account private details."),
    ]);
    if (!docs[0]) throw new Error("Missing fixture Document");
    await core.assignDocumentGroup(docs[0].id, group.id);
    const before = await core.getMeetingBriefPreparation(mindId);
    expect(before?.route).toMatchObject({ id: pairing.id, client: true, label: "Fixture Claude" });
    const result = await core.prepareMeetingBrief(mindId, pairing.id);
    expect(result.questions).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.purpose).toBe("meeting-brief");
    expect(calls[0]?.prompt).toContain("One unit is allowed.");
    expect(calls[0]?.prompt).not.toContain("Unrelated account");
    expect(calls[0]?.instructions).not.toContain("One unit is allowed.");
    await core.setNotCited(docs[0].id, true);
    expect(await core.getMeetingBriefPreparation(mindId)).toBeNull();
    await core.setNotCited(docs[0].id, false);
    hold = true;
    const pending = core.prepareMeetingBrief(mindId, pairing.id);
    const denied = expect(pending).rejects.toMatchObject({
      wording: { key: "error.meeting.briefChanged" },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await core.disconnectAgent(pairing.id);
    await denied;
    expect(observed?.aborted).toBe(true);
    await expect(core.prepareMeetingBrief(mindId, pairing.id)).rejects.toMatchObject({
      wording: { key: "error.meeting.briefChanged" },
    });
    expect(calls).toHaveLength(2);
  } finally {
    core.close();
  }
});
