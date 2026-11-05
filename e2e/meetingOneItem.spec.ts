import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../src/core/api";
import { openDatabase } from "../src/core/storage";
import { migrations } from "../src/core/storage/migrations";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  recordMeetingNow,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * One meeting is one item (#2528): its Transcript has no row of its own, a hit inside it is the
 * Note's, and a pair an earlier version filed apart is joined once, said once in the sidebar.
 */

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

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

const core = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

const meetings = async (window: Page): Promise<Meeting[]> =>
  (await core(window)).evaluate((bridge) => bridge.listMeetings());

/** Records a meeting in a new Note until it has lines, stops it, and waits for its Transcript to be read. */
async function recordAndStop(window: Page): Promise<{ meeting: Meeting; title: string }> {
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ device: { meetingNoticeAccepted: true } });
  });
  await recordMeetingNow(window);
  await expect
    .poll(async () => (await meetings(window))[0]?.transcript?.lines ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(1);
  await window.getByTestId("meeting-stop").click();
  await expect(window.getByTestId("meeting-transcript-line")).toContainText("Transcript saved", {
    timeout: 30_000,
  });
  const [meeting] = await meetings(window);
  if (!meeting?.transcript?.documentId) throw new Error("The meeting has no Transcript.");
  const documentId = meeting.transcript.documentId;
  await expect
    .poll(async () =>
      (await core(window)).evaluate(
        async (bridge, id) => (await bridge.listDocuments()).find((each) => each.id === id)?.status,
        documentId,
      ),
    )
    .toBe("ready");
  const title = await (await core(window)).evaluate(
    async (bridge, id) => (await bridge.listMinds()).find((mind) => mind.id === id)?.title ?? "",
    meeting.mindId,
  );
  return { meeting, title };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("a meeting's Transcript has no row; a ⌘K hit inside it is the Note's and opens the Transcript beside it there; its menu can't move, tag or delete it alone, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  const tides = join(sources, "tide-tables.txt");
  await writeFile(tides, "High water at the pier at noon.");
  await addDocuments(window, [tides]);
  const { title } = await recordAndStop(window);

  // No row of its own: the sidebar and the Library list the User's Document, and only it.
  const rows = window.getByTestId("document-list-item");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("tide-tables");
  await pointAndClick(window, window.getByTestId("open-library"));
  const library = window.getByTestId("library");
  await expect(library.getByTestId("library-document")).toHaveCount(1);
  await expect(library.getByTestId("library-document").first()).toContainText("tide-tables");
  await expect(library).not.toContainText("Transcript");
  await shot(window, "one-item-library-en");

  // ⌘K: the words said in the meeting are the Note's hit, with when they were said.
  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("eighteenth");
  const hits = window
    .getByTestId("palette")
    .locator('[data-testid="palette-group"][data-group="documentText"]')
    .getByTestId("palette-item");
  await expect(hits).toHaveCount(1);
  await expect(hits.first()).toContainText(
    new RegExp(`^${escaped(title)} · Transcript, \\d+:\\d{2}`),
  );
  await shot(window, "one-item-palette-en");
  await window.keyboard.press("Enter");
  // The Note in front, its Transcript beside it, at the words.
  const transcript = window.getByTestId("viewer-transcript");
  await expect(transcript).toBeVisible();
  await expect(window.getByTestId("mind-pane")).toBeVisible();
  const [note, beside] = await Promise.all([
    window.getByTestId("mind-pane").boundingBox(),
    transcript.boundingBox(),
  ]);
  if (!note || !beside) throw new Error("The Note or its Transcript isn't drawn.");
  expect(beside.x).toBeGreaterThanOrEqual(note.x + note.width - 1);
  await expect(transcript.locator("[data-quote-highlight]").first()).toBeInViewport();
  await shot(window, "one-item-opened-en");

  // Its menu keeps Get info, and has no Move to…, Tags… or Delete of its own.
  const header = window.getByTestId("viewer-header");
  await expect(header).toContainText("Transcript");
  await pointAndClick(window, header.getByTestId("document-file-menu"));
  const menu = header.getByTestId("document-file-actions");
  await expect(menu.getByTestId("file.info")).toBeVisible();
  await expect(menu.getByTestId("document.moveTo")).toHaveCount(0);
  await expect(menu.getByTestId("document.tags")).toHaveCount(0);
  await expect(menu.getByTestId("document.delete")).toHaveCount(0);
  await window.keyboard.press("Escape");

  await setLanguage(window, "zh-CN");
  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("eighteenth");
  await expect(hits.first()).toContainText(new RegExp(`^${escaped(title)} · 转写稿 \\d+:\\d{2}`));
  await shot(window, "one-item-palette-zh");
  await window.keyboard.press("Escape");
  await app.close();
});

test("a Note an earlier version filed apart from its Transcript joins it behind the wall once, and the sidebar says so once, with Undo, in Chinese and English", async () => {
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  await setWindowSize(first.app, first.window, 1280, 800);
  const { meeting, title } = await recordAndStop(first.window);
  const documentId = meeting.transcript?.documentId as string;
  const { vault, desk } = await (await core(first.window)).evaluate(async (bridge, mindId) => {
    const vault = await bridge.createLibraryGroup({ name: "Vault", description: "" });
    await bridge.updateLibraryGroup(vault.id, { name: "Vault", description: "", keepInside: true });
    const desk = await bridge.createLibraryGroup({ name: "Open desk", description: "" });
    await bridge.moveToFolder({ mindIds: [mindId], folderId: desk.id });
    await bridge.updateSettings({ user: { language: "zh-CN" } });
    return { vault: vault.id, desk: desk.id };
  }, meeting.mindId);
  await first.app.close();

  // As the version before left it: the Transcript filed on its own, behind the wall.
  const ours = migrations.find((each) => each.description.includes("(#2528)"));
  if (!ours) throw new Error("The migration isn't listed.");
  const db = openDatabase(join(dataDir, "incarnamind.db"));
  db.exec(`
    DROP TABLE meeting_joins;
    DROP INDEX documents_by_meeting_mind;
    ALTER TABLE documents DROP COLUMN meeting_mind_id;
    DELETE FROM schema_migrations WHERE version = ${ours.version};
  `);
  db.run(
    `INSERT INTO document_groups (id, document_id, group_id, source, status, request_id,
       created_at, updated_at)
     VALUES ('filed-alone', ?, ?, 'user', 'classified', 'request', ?, ?)`,
    [documentId, vault, "2026-10-20T09:00:00.000Z", "2026-10-20T09:00:00.000Z"],
  );
  db.close();

  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1280, 800);
  const line = window.getByTestId(/^meeting-joined-[0-9a-f]{8}-/);
  await expect(line).toBeVisible();
  await expect(line.getByTestId("status-label")).toHaveText(`“${title}”已随转写稿移到“Vault”`);
  await expect(line.getByTestId("meeting-joined-undo")).toHaveText("撤销");
  await shot(window, "one-item-joined-zh");
  // Narrow, the line wraps by word inside the sidebar, its Undo kept with it.
  await setWindowSize(app, window, 900, 700);
  const [row, label, sidebar] = await Promise.all([
    line.boundingBox(),
    line.getByTestId("status-label").boundingBox(),
    window.getByTestId("sidebar-status").boundingBox(),
  ]);
  if (!row || !label || !sidebar) throw new Error("The line isn't drawn.");
  expect(label.x + label.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1);
  expect(row.x + row.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1);
  await shot(window, "one-item-joined-narrow-zh");
  await setWindowSize(app, window, 1280, 800);
  await setLanguage(window, "en");
  await expect(line.getByTestId("status-label")).toHaveText(
    `“${title}” moved to “Vault” with its Transcript`,
  );
  await shot(window, "one-item-joined-en");
  const folderOfNote = () =>
    window.evaluate(
      async (id) =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()).find(
          (mind) => mind.id === id,
        )?.folderId,
      meeting.mindId,
    );
  expect(await folderOfNote()).toBe(vault);

  // Undo moves the Note back, its Transcript with it, as any move does.
  await pointAndClick(window, line.getByTestId("meeting-joined-undo"));
  await expect(line).toHaveCount(0);
  await expect.poll(folderOfNote).toBe(desk);
  await app.close();

  // Said once: the next start says nothing.
  const again = await launchApp(dataDir);
  await expect(again.window.getByTestId("sidebar-status")).toBeVisible();
  await expect(again.window.getByTestId(/^meeting-joined-[0-9a-f]{8}-/)).toHaveCount(0);
  await again.app.close();
});
