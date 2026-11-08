import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  frontMind,
  launchApp,
  newMindAndType,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  turnOf,
} from "./app";

/**
 * A .vtt the User already has is a supported format, so the one picker offers
 * it beside the Office and text files (#2439): it is added through Add files
 * or a folder, reaches ready with its transcript text, and cancelling the
 * picker leaves the Library and the open Note as they were.
 */

const VTT = `WEBVTT - Steering committee

00:00:00.000 --> 00:00:04.500
<v Dana>So the launch moves to the eighteenth of November.

00:00:05.000 --> 00:00:09.000
Two weeks. Can the contingency cover it?

01:02:03.450 --> 01:02:05.000
发布日期推迟到十一月十八日。
`;

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`Add files or a folder offers a .vtt and reads it as a Transcript, and cancelling adds nothing (${language})`, async () => {
    test.setTimeout(240_000);
    const transcript = join(sources, "Meeting transcript.vtt");
    await writeFile(transcript, VTT);
    const notes = join(sources, "Notes.txt");
    await writeFile(notes, "The harbour master keeps the records.\n");
    const { app, window } = await launchApp(dataDir, { examples: true, home: sources });
    try {
      await setWindowSize(app, window, 1100, 800);
      await dismissChatSetup(window);
      await setLanguage(window, language);

      await app.evaluate(
        ({ dialog }, picked) => {
          const state: { asked: Electron.OpenDialogOptions[]; cancel: boolean } = {
            asked: [],
            cancel: false,
          };
          (globalThis as { openDialogsAsked?: unknown }).openDialogsAsked = state;
          dialog.showOpenDialog = (async (...args: unknown[]) => {
            state.asked.push(args.at(-1) as Electron.OpenDialogOptions);
            return state.cancel
              ? { canceled: true, filePaths: [] }
              : { canceled: false, filePaths: picked };
          }) as typeof dialog.showOpenDialog;
        },
        [transcript, notes],
      );
      const asked = () =>
        app.evaluate(
          () =>
            (globalThis as { openDialogsAsked?: { asked: Electron.OpenDialogOptions[] } })
              .openDialogsAsked?.asked ?? [],
        );
      const cancelNext = () =>
        app.evaluate(() => {
          const state = (
            globalThis as {
              openDialogsAsked?: { asked: Electron.OpenDialogOptions[]; cancel: boolean };
            }
          ).openDialogsAsked;
          if (state) state.cancel = true;
        });

      // The file input the page itself takes files through accepts a transcript too.
      await expect(window.getByTestId("add-documents-input")).toHaveAttribute("accept", /\.vtt/);

      // Add files or a folder: its filter offers a transcript beside the formats it already offered.
      await window.getByTestId("plus-menu").click();
      await window.getByTestId("plus-add-documents").click();
      await expect.poll(async () => (await asked()).length).toBe(1);
      const extensions = (await asked())[0]?.filters?.[0]?.extensions ?? [];
      expect(extensions).toEqual(
        expect.arrayContaining(["vtt", "pdf", "docx", "xlsx", "csv", "txt", "md"]),
      );

      // The .vtt reaches ready, and the TXT beside it still imports as it did.
      const rows = window.getByTestId("document-list-item");
      const row = rows.filter({ hasText: "Meeting transcript" });
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
      await expect(rows.filter({ hasText: "Notes" })).toHaveAttribute("data-status", "ready", {
        timeout: 60_000,
      });

      // Its cues are its text, with their times and the transcript's own speaker.
      await row.getByTestId("open-document").click();
      const viewer = window.getByTestId("viewer-transcript");
      await expect(viewer).toBeVisible();
      const lines = viewer.getByTestId("transcript-line");
      await expect(lines).toHaveCount(3);
      await expect(lines.first()).toContainText(
        "So the launch moves to the eighteenth of November.",
      );
      await expect(lines.last()).toContainText("发布日期推迟到十一月十八日。");
      await expect(turnOf(lines.first()).getByTestId("transcript-speaker")).toHaveText("Dana");

      // Cancelling the picker adds nothing, and the Note the User is in keeps its words.
      await newMindAndType(window, "The tide is high at noon.");
      const editor = frontMind(window).getByTestId("mind-editor");
      await expect(editor).toContainText("The tide is high at noon.");
      const before = await rows.count();
      await cancelNext();
      await window.getByTestId("plus-menu").click();
      await window.getByTestId("plus-add-documents").click();
      await expect.poll(async () => (await asked()).length).toBe(2);
      // The picker has finished: the one way in can be opened again.
      await window.getByTestId("plus-menu").click();
      await expect(window.getByTestId("plus-add-documents")).toBeEnabled();
      await window.keyboard.press("Escape");
      await expect(rows).toHaveCount(before);
      await expect(editor).toContainText("The tide is high at noon.");
    } finally {
      await app.close();
    }
  });
}
