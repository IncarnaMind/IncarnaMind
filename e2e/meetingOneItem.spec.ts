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
  transcriptSaved,
} from "./app";

/**
 * One meeting is one item (#2528): its Transcript has no row of its own, a hit inside it is the
 * Note's, and a pair an earlier version filed apart is joined once, on the walled side of one wall
 * with Undo, or left apart by two, each said once in the sidebar.
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
  await transcriptSaved(window);
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
  const { meeting: recorded, title } = await recordAndStop(window);
  const transcriptId = recorded.transcript?.documentId as string;

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
  // The Library's search finds the words said in the meeting as its Note's, under Notes.
  const librarySearch = window.getByTestId("library-search");
  await librarySearch.fill("eighteenth");
  const meetingsFound = library.getByTestId("library-meetings");
  await expect(meetingsFound.getByRole("heading")).toHaveText("Notes");
  await expect(meetingsFound.getByTestId("library-meeting-hit")).toHaveCount(1);
  await expect(meetingsFound.getByTestId("library-meeting-hit")).toContainText(
    new RegExp(`^${escaped(title)} · Transcript, \\d{2}:\\d{2}`),
  );
  // Its right-click menu is its Note's.
  await pointAndClick(window, meetingsFound.getByTestId("library-meeting-hit"), {
    button: "right",
  });
  await expect(window.getByRole("menuitem", { name: "Don’t cite the Transcript" })).toBeVisible();
  await window.keyboard.press("Escape");
  await librarySearch.fill("");

  // ⌘K: the words said in the meeting are the Note's hit, with when they were said.
  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("eighteenth");
  const hits = window
    .getByTestId("palette")
    .locator('[data-testid="palette-group"][data-group="notes"]')
    .getByTestId("palette-item");
  await expect(hits).toHaveCount(1);
  // A meeting is a Note: never under the Documents' words, and timed as its Transcript shows it.
  await expect(
    window
      .getByTestId("palette")
      .locator('[data-testid="palette-group"][data-group="documentText"]'),
  ).toHaveCount(0);
  await expect(hits.first()).toContainText(
    new RegExp(`^${escaped(title)} · Transcript, \\d{2}:\\d{2}`),
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

  // Its menu keeps Get info, and has no Move to…, Tags… or Delete of its own; nor has its viewer
  // a Tags button.
  const header = window.getByTestId("viewer-header");
  await expect(header).toContainText("Transcript");
  await expect(header.getByTestId("document-tags")).toHaveCount(0);
  await pointAndClick(window, header.getByTestId("document-file-menu"));
  const menu = header.getByTestId("document-file-actions");
  await expect(menu.getByTestId("file.info")).toBeVisible();
  await expect(menu.getByTestId("document.moveTo")).toHaveCount(0);
  await expect(menu.getByTestId("document.tags")).toHaveCount(0);
  await expect(menu.getByTestId("document.delete")).toHaveCount(0);
  await expect(menu.getByTestId("document.rename")).toHaveCount(0);
  await expect(menu.getByTestId("document.dontCite")).toHaveCount(0);
  await window.keyboard.press("Escape");

  // Don't cite the Transcript is the meeting Note's, on its menu, and back.
  const notCited = () =>
    window.evaluate(
      async (id) =>
        (
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
        ).find((each) => each.id === id)?.notCited,
      transcriptId,
    );
  const noteTab = window.getByTestId("mind-tab").first();
  await pointAndClick(window, noteTab, { button: "right" });
  await pointAndClick(window, window.getByRole("menuitem", { name: "Don’t cite the Transcript" }));
  await expect.poll(notCited).toBe(true);
  await pointAndClick(window, noteTab, { button: "right" });
  await pointAndClick(window, window.getByRole("menuitem", { name: "Cite the Transcript again" }));
  await expect.poll(notCited).toBe(false);

  // "@" in the composer finds the meeting by words said in it, as its Note's choice.
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("@eighteenth");
  await expect(window.getByTestId("scope-picker")).toContainText(
    new RegExp(`${escaped(title)} · Transcript, \\d{2}:\\d{2}`),
  );
  await window.keyboard.press("Escape");
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.press("Backspace");

  await setLanguage(window, "zh-CN");
  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("eighteenth");
  await expect(hits.first()).toContainText(new RegExp(`^${escaped(title)} · 转写稿 \\d{2}:\\d{2}`));
  await shot(window, "one-item-palette-zh");
  await window.keyboard.press("Escape");
  await pointAndClick(window, window.getByTestId("open-library"));
  await librarySearch.fill("eighteenth");
  await expect(meetingsFound.getByRole("heading")).toHaveText("笔记");
  await expect(meetingsFound.getByTestId("library-meeting-hit")).toContainText(
    new RegExp(`^${escaped(title)} · 转写稿 \\d{2}:\\d{2}`),
  );
  await app.close();
});

/** Takes the data folder back to how the version before left it, these Transcripts filed alone. */
function asBefore(filings: readonly { documentId: string; folderId: string }[]) {
  const ours = migrations.find((each) => each.description.includes("(#2528)"));
  if (!ours) throw new Error("The migration isn't listed.");
  const db = openDatabase(join(dataDir, "incarnamind.db"));
  db.exec(`
    DROP TABLE meeting_joins;
    DROP TABLE meeting_join_transcripts;
    DROP TABLE meetings_left_apart;
    DROP INDEX documents_by_meeting_mind;
    ALTER TABLE documents DROP COLUMN meeting_mind_id;
    DELETE FROM schema_migrations WHERE version = ${ours.version};
  `);
  for (const { documentId, folderId } of filings) {
    db.run(
      `INSERT INTO document_groups (id, document_id, group_id, source, status, request_id,
         created_at, updated_at)
       VALUES (?, ?, ?, 'user', 'classified', 'request', ?, ?)`,
      [
        `filed-${documentId}`,
        documentId,
        folderId,
        "2026-10-20T09:00:00.000Z",
        "2026-10-20T09:00:00.000Z",
      ],
    );
  }
  db.close();
}

const placeOf = (window: Page, mindId: string, documentId: string) =>
  window.evaluate(
    async (ids) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const note = (await bridge.listMinds()).find((mind) => mind.id === ids.mindId);
      const transcript = (await bridge.listDocuments()).find((each) => each.id === ids.documentId);
      const filed = (await bridge.getLibrary()).assignments.filter(
        (each) => each.documentId === ids.documentId,
      );
      return {
        noteFolder: note?.folderId ?? null,
        ownedBy: transcript?.meetingMindId ?? null,
        filedIn: filed.map((each) => each.groupId),
      };
    },
    { mindId, documentId },
  );

test("a meeting an earlier version filed apart, one wall between, joins on the walled side and says which half moved, once, with Undo, which puts it back exactly, in Chinese and English", async () => {
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  await setWindowSize(first.app, first.window, 1440, 900);
  // "Weekly call": its Note outside, its Transcript behind Vault, so the Note goes in.
  // "周例会": its Note behind Cellar, its Transcript outside, so the Transcript goes in.
  const weekly = { ...(await recordAndStop(first.window)), title: "Weekly call" };
  const standup = { ...(await recordAndStop(first.window)), title: "周例会" };
  const { vault, cellar, desk } = await (await core(first.window)).evaluate(
    async (bridge, ids) => {
      const [weeklyId, standupId] = ids;
      if (!weeklyId || !standupId) throw new Error("Two meetings were recorded.");
      await bridge.renameMind(weeklyId, "Weekly call");
      await bridge.renameMind(standupId, "周例会");
      const walled = async (name: string) => {
        const folder = await bridge.createLibraryGroup({ name, description: "" });
        await bridge.updateLibraryGroup(folder.id, { name, description: "", keepInside: true });
        return folder.id;
      };
      const vault = await walled("Vault");
      const cellar = await walled("Cellar");
      const desk = (await bridge.createLibraryGroup({ name: "Open desk", description: "" })).id;
      await bridge.moveToFolder({ mindIds: [weeklyId], folderId: desk });
      await bridge.moveToFolder({ mindIds: [standupId], folderId: cellar });
      await bridge.updateSettings({ user: { language: "zh-CN" } });
      return { vault, cellar, desk };
    },
    [weekly.meeting.mindId, standup.meeting.mindId],
  );
  await first.app.close();
  const weeklyTranscript = weekly.meeting.transcript?.documentId as string;
  const standupTranscript = standup.meeting.transcript?.documentId as string;
  asBefore([
    { documentId: weeklyTranscript, folderId: vault },
    { documentId: standupTranscript, folderId: desk },
  ]);

  const said = {
    [weekly.title]: {
      zh: "“Weekly call”已随转写稿移到“Vault”",
      en: "“Weekly call” moved to “Vault” with its Transcript",
      joined: { noteFolder: vault, ownedBy: weekly.meeting.mindId, filedIn: [] },
      undone: { noteFolder: desk, ownedBy: null, filedIn: [vault] },
      transcript: weeklyTranscript,
      mindId: weekly.meeting.mindId,
    },
    [standup.title]: {
      zh: "“周例会”的转写稿已移到“Cellar”，与笔记放在一起",
      en: "The Transcript of “周例会” moved to “Cellar”, beside its note",
      joined: { noteFolder: cellar, ownedBy: standup.meeting.mindId, filedIn: [] },
      undone: { noteFolder: cellar, ownedBy: null, filedIn: [desk] },
      transcript: standupTranscript,
      mindId: standup.meeting.mindId,
    },
  };
  const whoseLine = async (line: ReturnType<Page["getByTestId"]>) => {
    const text = (await line.getByTestId("status-label").textContent()) ?? "";
    const found = text.includes(weekly.title) ? said[weekly.title] : said[standup.title];
    if (!found) throw new Error(`No meeting says “${text}”.`);
    return found;
  };

  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  const line = window.getByTestId(/^meeting-joined-[0-9a-f]{8}-/).first();
  await expect(line).toBeVisible();
  const shown = await whoseLine(line);
  await expect(line.getByTestId("status-label")).toHaveText(shown.zh);
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
  await setWindowSize(app, window, 1440, 900);
  await setLanguage(window, "en");
  await expect(line.getByTestId("status-label")).toHaveText(shown.en);
  await shot(window, "one-item-joined-en");
  expect(await placeOf(window, shown.mindId, shown.transcript)).toEqual(shown.joined);

  // Undo puts the pair back exactly: whichever half went in is back where it was.
  const lineId = (await line.getAttribute("data-testid")) as string;
  await pointAndClick(window, line.getByTestId("meeting-joined-undo"));
  await expect.poll(() => placeOf(window, shown.mindId, shown.transcript)).toEqual(shown.undone);
  await expect(window.getByTestId(lineId)).toHaveCount(0);

  // The other meeting's line, naming the other half, in both languages; left alone.
  const otherLine = window.getByTestId(/^meeting-joined-[0-9a-f]{8}-/).first();
  await expect(otherLine).toBeVisible();
  const other = await whoseLine(otherLine);
  expect(other).not.toBe(shown);
  await expect(otherLine.getByTestId("status-label")).toHaveText(other.en);
  await setLanguage(window, "zh-CN");
  await expect(otherLine.getByTestId("status-label")).toHaveText(other.zh);
  await app.close();

  // Said once, the next start says nothing, and the one left alone stays joined.
  const again = await launchApp(dataDir);
  await expect(again.window.getByTestId("sidebar-status")).toBeVisible();
  await expect(again.window.getByTestId(/^meeting-joined-[0-9a-f]{8}-/)).toHaveCount(0);
  expect(await placeOf(again.window, other.mindId, other.transcript)).toEqual(other.joined);
  await again.app.close();
});

test("a meeting two walls keep apart from its Transcript stays where it is, and the sidebar says so once and lists it, in Chinese and English", async () => {
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  await setWindowSize(first.app, first.window, 1440, 900);
  const { meeting, title } = await recordAndStop(first.window);
  const documentId = meeting.transcript?.documentId as string;
  const { vault, cellar } = await (await core(first.window)).evaluate(async (bridge, mindId) => {
    const walled = async (name: string) => {
      const folder = await bridge.createLibraryGroup({ name, description: "" });
      await bridge.updateLibraryGroup(folder.id, { name, description: "", keepInside: true });
      return folder.id;
    };
    const vault = await walled("Vault");
    const cellar = await walled("Cellar");
    await bridge.moveToFolder({ mindIds: [mindId], folderId: cellar });
    await bridge.updateSettings({ user: { language: "zh-CN" } });
    return { vault, cellar };
  }, meeting.mindId);
  await first.app.close();
  asBefore([{ documentId, folderId: vault }]);

  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  const line = window.getByTestId("meetings-left-apart");
  await expect(line).toBeVisible();
  await expect(line.getByTestId("status-label")).toHaveText(
    "1 场会议未与转写稿合并：笔记和转写稿所在的文件夹都只在本文件夹内工作",
  );
  const show = line.getByTestId("meetings-left-apart-show");
  await expect(show).toHaveText("查看");
  await expect(line.getByRole("button", { name: "撤销" })).toHaveCount(0);
  await shot(window, "one-item-left-apart-zh");
  await setWindowSize(app, window, 900, 700);
  const [row, label, sidebar] = await Promise.all([
    line.boundingBox(),
    line.getByTestId("status-label").boundingBox(),
    window.getByTestId("sidebar-status").boundingBox(),
  ]);
  if (!row || !label || !sidebar) throw new Error("The line isn't drawn.");
  expect(label.x + label.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1);
  expect(row.x + row.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1);
  await shot(window, "one-item-left-apart-narrow-zh");
  await setWindowSize(app, window, 1440, 900);
  await setLanguage(window, "en");
  await expect(line.getByTestId("status-label")).toHaveText(
    "1 meeting left apart from its Transcript, since each Folder keeps its work inside it",
  );
  await expect(show).toHaveText("Show");

  // Show is a button in the tab order: from the keyboard it lists the meeting, and Esc folds it.
  expect(await show.evaluate((button) => button.tagName === "BUTTON" && button.tabIndex >= 0)).toBe(
    true,
  );
  await show.focus();
  await window.keyboard.press("Enter");
  const listed = line.getByTestId("meetings-left-apart-note");
  await expect(listed).toHaveText([title]);
  await expect(show).toHaveText("Hide");
  await shot(window, "one-item-left-apart-en");
  await window.keyboard.press("Escape");
  await expect(listed).toHaveCount(0);
  await expect(show).toBeFocused();
  await pointAndClick(window, show);
  await pointAndClick(window, listed);
  await expect(window.getByTestId("mind-pane")).toBeVisible();

  // Nothing moved: the Note in its Folder, the Transcript behind the other wall, a Document of its
  // own with its row, and a ⌘K hit inside it is a plain Document hit.
  expect(await placeOf(window, meeting.mindId, documentId)).toEqual({
    noteFolder: cellar,
    ownedBy: null,
    filedIn: [vault],
  });
  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("eighteenth");
  await expect(
    window
      .getByTestId("palette")
      .locator('[data-testid="palette-group"][data-group="documentText"]')
      .getByTestId("palette-item"),
  ).toContainText([/^Transcript/]);
  await window.keyboard.press("Escape");
  await app.close();

  // Said once, and left alone: the next start says nothing.
  const again = await launchApp(dataDir);
  await expect(again.window.getByTestId("sidebar-status")).toBeVisible();
  await expect(again.window.getByTestId("meetings-left-apart")).toHaveCount(0);
  await again.app.close();
});
