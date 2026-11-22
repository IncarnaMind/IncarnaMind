import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SystemCalendarEvent } from "../src/core/adapters";
import { translate } from "../src/shared/i18n";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setLanguage,
} from "./app";

for (const language of ["en", "zh-CN"] as const) {
  test(`Preparing an upcoming note shows three checked answers from its earlier meeting and named price sheet (${language})`, async () => {
    const dir = await createDataFolder();
    const zh = language === "zh-CN";
    const title = zh ? "北桥报价单" : "Northbridge price sheet";
    const tomorrow = Date.now() + 120_000;
    const event = (id: string, name: string, at: number): SystemCalendarEvent => ({
      calendarId: "brief",
      id,
      externalId: id,
      occurrence: null,
      title: name,
      start: new Date(at).toISOString(),
      end: new Date(at + 60_000).toISOString(),
      allDay: false,
      status: "confirmed",
      organizer: null,
      attendees: [{ name: "Lee", email: "lee@example.test", self: false, status: "accepted" }],
      url: null,
      notes: "Private invite body should remain private",
      location: null,
    });
    const past = event("initial", "Initial terms", tomorrow - 10 * 60_000);
    const current = event("review", title, tomorrow);
    const speech = zh ? "我周五带样品过来。" : "I will bring the samples on Friday.";
    const sentences = zh
      ? ["年费为五百四十元。", "付款期限为三十天。"]
      : ["The annual rate is $540.", "Payment is due within 30 days."];
    const file = join(dir, `${title}.txt`);
    await writeFile(file, sentences.join("\n"));
    const out = join(dir, "output");
    await mkdir(out, { recursive: true });
    const { app, window } = await launchApp(dir, {
      fakeChat: true,
      computerSound: "silent",
      transcriber: { live: true, lines: [speech] },
      systemCalendar: {
        access: "allowed",
        calendars: [{ id: "brief", title: "Brief fixture", source: "local", kind: "local" }],
        events: [past, current],
      },
    });
    try {
      if (zh) await setLanguage(window, language);
      await dismissChatSetup(window);
      const bridge = await coreOf(window);
      const id = await bridge.evaluate(
        async (c, { file, out, start, end }) => {
          await c.setOutputLocation(out);
          await c.updateSettings({ device: { meetingNoticeAccepted: true } });
          await c.saveChatProvider({ kind: "ollama", modelId: "local-model" });
          await c.addDocuments([file]);
          await c.connectCalendar("mac");
          const events = await c.listCalendarEvents({ from: start, to: end });
          const previous = events.find((e) => e.title === "Initial terms");
          if (!previous) throw Error("Missing prior invitation");
          const note = await c.takeEventNotes(previous.id);
          const call = await c.createMeeting({ mindId: note.mindId });
          await c.startMeeting({ meetingId: call.id, systemAudio: false });
          return call.id;
        },
        { file, out, start: past.start, end: current.end },
      );
      await expect
        .poll(
          () =>
            bridge.evaluate(
              async (c, id) =>
                (await c.listMeetings()).find((m) => m.id === id)?.transcript?.lines ?? 0,
              id,
            ),
          { timeout: 35_000 },
        )
        .toBeGreaterThan(0);
      await bridge.evaluate((c, id) => c.stopMeeting(id), id);
      await expect
        .poll(
          () =>
            bridge.evaluate(
              async (c) => (await c.listDocuments()).filter((d) => d.status === "ready").length,
            ),
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(2);
      await window.getByTestId("sidebar-home").click();
      const row = window.getByTestId("home-meeting").filter({ hasText: title });
      await row.getByTestId("home-take-notes").click();
      await bridge.evaluate(async (c, name) => {
        const mind = (await c.listMinds()).find((m) => m.title === name);
        const doc = (await c.listDocuments()).find((d) => d.name === name);
        if (!mind || !doc) throw Error("Missing meeting Note or price sheet");
        const group = await c.createLibraryGroup({
          name: "Permitted meeting materials",
          description: "",
        });
        await c.moveToFolder({ mindIds: [mind.id], documentIds: [doc.id], folderId: group.id });
      }, title);
      const eventBar = window.getByTestId("event-bar");
      await eventBar
        .getByRole("button", { name: translate(language, "meetings.brief.title"), exact: true })
        .click();
      await eventBar.getByRole("button", { name: zh ? /准备简报/ : /Prepare with/ }).click();
      const questions = window.getByTestId("meeting-brief-questions");
      await expect(questions.getByRole("listitem")).toHaveCount(3);
      for (const line of [...sentences, speech]) await expect(questions).toContainText(line);
      await questions.getByRole("button").first().click();
      await expect(window.getByTestId("document-tab").filter({ hasText: title })).toBeVisible();
      await expect(window.getByTestId("meeting-brief")).toBeVisible();
      await window
        .getByTestId("meeting-brief")
        .getByRole("button", { name: translate(language, "meetings.brief.keep"), exact: true })
        .click();
      await expect(window.getByTestId("meeting-brief")).toHaveCount(0);
      await expect(window.getByTestId("mind-editor").filter({ hasText: speech })).toBeVisible();
    } finally {
      await app.close();
      await removeDataFolder(dir);
    }
  });
}
