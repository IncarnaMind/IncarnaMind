import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/*
 * The assistant does what the app can (#1110): asked to rename, move, tag, export or add files,
 * it finds exactly what is meant and runs the app's commands. A change in the Library happens at
 * once and one Undo takes back the request; a file saved outside the Output location and files
 * read from a folder wait for Allow. The model is the smoke tests' fake. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
let out: string;
let elsewhere: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  out = await createDataFolder();
  elsewhere = await createDataFolder();
});
test.afterEach(async () => {
  for (const folder of [dataDir, sources, out, elsewhere]) await removeDataFolder(folder);
});

const DOCUMENTS = [
  "Northwind invoice March",
  "Northwind invoice April",
  "Lease Harbour Street",
  "Lease Mill Lane",
];

const library = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [documents, folders, tags] = await Promise.all([
      core.listDocuments(),
      core.getLibrary(),
      core.listTags(),
    ]);
    return {
      names: documents.map((each) => each.name).sort(),
      folders: folders.groups.map((each) => each.name),
      tags: tags.map((each) => each.name),
      added: documents[0]?.createdAt.slice(0, 10) ?? "",
    };
  });

async function setUp(
  app: ElectronApplication,
  window: Page,
  language: "en" | "zh-CN" = "en",
): Promise<void> {
  await setLanguage(window, language);
  await setWindowSize(app, window, 1440, 900);
  const paths = await Promise.all(
    DOCUMENTS.map(async (name) => {
      const path = join(sources, `${name}.md`);
      await writeFile(path, `# ${name}\n\nSigned in 2026.\n`);
      return path;
    }),
  );
  await addDocuments(window, paths);
  await newMind(window);
  await nameMind(window, "Deal notes");
  await window.keyboard.type("Notes on the deal.");
}

// ⌘Z where a person presses it, after a click on the card: not in a field, whose ⌘Z is its own.
async function undoFrom(window: Page, card: Locator): Promise<void> {
  await pointAndClick(window, card.getByTestId("command-changes-title").first());
  await window.keyboard.press("ControlOrMeta+z");
}

async function askAndWait(window: Page, question: string): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1);
  const card = answers.last().getByTestId("approval-card");
  await expect(card).toBeVisible();
  return card;
}

// A small Organize on the local model asks nothing, so its answer goes straight to done (#2252).
async function askAndFinish(window: Page, question: string): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1);
  const answer = answers.last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(answer.getByTestId("approval-card")).toHaveCount(0);
  return answer;
}

test("renaming by date, moving into a new Folder and tagging each happen at once, and one Undo takes each back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  const { added } = await library(window);

  const renamed = await askInAssistant(window, "Rename the Northwind files by date");
  const card = renamed.getByTestId("command-changes");
  await expect(card.getByTestId("command-changes-title")).toHaveText("Renamed 2 Documents");
  const items = card.getByTestId("command-changes-item");
  await expect(items).toHaveCount(2);
  expect((await items.allTextContents()).sort()).toEqual([
    `Northwind invoice April → ${added} Northwind invoice April`,
    `Northwind invoice March → ${added} Northwind invoice March`,
  ]);
  await expect(window.getByTestId("undo-line")).toContainText("Renamed 2 Documents");
  await screenshot(window, "commands-renamed-en");
  expect((await library(window)).names).toContain(`${added} Northwind invoice March`);
  const sidebar = window.getByTestId("sidebar");
  await expect(sidebar).toContainText(`${added} Northwind invoice March`);
  await undoFrom(window, card);
  await expect(sidebar).not.toContainText(`${added} Northwind invoice March`);
  await expect.poll(async () => (await library(window)).names).toEqual([...DOCUMENTS].sort());
  await expect(card.getByTestId("command-changes-undone")).toHaveText("Undone");

  const moved = await askInAssistant(window, "Move the leases into Real estate");
  const movedCard = moved.getByTestId("command-changes");
  await expect(movedCard.getByTestId("command-changes-title")).toHaveText(
    "Made “Real estate” and moved 2 Documents into it",
  );
  await expect(window.getByTestId("sidebar")).toContainText("Real estate");
  await pointAndClick(window, movedCard.getByTestId("command-changes-undo"));
  await expect.poll(async () => (await library(window)).folders).not.toContain("Real estate");
  await expect(movedCard.getByTestId("command-changes-undone")).toBeVisible();

  const tagged = await askInAssistant(window, "Tag every invoice Finance");
  const tagCard = tagged.getByTestId("command-changes");
  await expect(tagCard.getByTestId("command-changes-title")).toHaveText(
    "Tagged 2 Documents “Finance”",
  );
  expect((await library(window)).tags).toContain("Finance");
  await undoFrom(window, tagCard);
  await expect.poll(async () => (await library(window)).tags).not.toContain("Finance");
  await app.close();
});

test("a delete the assistant starts asks first, naming what goes, and Don't delete keeps it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);

  const card = await askAndWait(window, "Delete this Mind");
  await expect(card).toHaveAttribute("data-reason", "delete");
  await expect(card).toContainText("Delete “Deal notes”?");
  await expect(card).toContainText(
    "It goes to Recently deleted, where you can restore it for 30 days. The assistant always asks before it deletes.",
  );
  await expect(card.getByTestId("approval-allow-once")).toContainText("Delete");
  await expect(card.getByTestId("approval-deny")).toHaveText("Don’t delete");
  await expect(card.getByTestId("approval-always-allow")).toHaveCount(0);
  await screenshot(window, "commands-delete-asks-en");
  await pointAndClick(window, card.getByTestId("approval-deny"));
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer.getByTestId("command-changes-unrun")).toHaveText(
    "Not allowed, so nothing changed",
  );
  await expect(window.getByTestId("mind-row").filter({ hasText: "Deal notes" })).toBeVisible();
  await app.close();
});

test("a delete of 60 Documents names the first 50 and says how many more", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  const paths = await Promise.all(
    Array.from({ length: 60 }, async (_, index) => {
      const path = join(sources, `Draft ${String(index + 1).padStart(2, "0")}.md`);
      await writeFile(path, `# Draft ${index + 1}\n\nA first go.\n`);
      return path;
    }),
  );
  await addDocuments(window, paths);
  await newMind(window);

  const card = await askAndWait(window, "Delete the drafts");
  await expect(card).toContainText("Delete 60 Documents?");
  const names = card.getByTestId("approval-file");
  await expect(names).toHaveCount(51);
  await expect(names.last()).toHaveText("and 10 more");
  await screenshot(window, "commands-delete-60-en");
  await pointAndClick(window, card.getByTestId("approval-deny"));
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  expect((await library(window)).names).toHaveLength(60);
  await app.close();
});

test("a command that fails says so on the card and changes nothing", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  const before = await library(window);

  const answer = await askInAssistant(window, "Delete the document with id nope");

  await expect(answer.getByTestId("command-changes-unrun")).toHaveText(
    "Didn’t run: There is no Document with the id nope.",
  );
  await expect(answer.getByTestId("command-changes-title")).toHaveCount(0);
  expect(await library(window)).toEqual(before);
  await app.close();
});

test("export as Word saves into the Output location at once; to another folder it waits for Allow, and Don't allow saves nothing", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  await useOutputLocation(window, out);

  const here = await askInAssistant(window, "Export this Mind as Word");
  await expect(here.getByTestId("approval-card")).toHaveCount(0);
  // Nothing is asked about marking the text IncarnaMind wrote: the default marks it (#1945).
  await expect(window.getByTestId("task-tray").getByTestId("question-card")).toHaveCount(0);
  await expect(here.getByTestId("command-changes-title")).toHaveText(
    `Saved “Deal notes.docx” in “${out.split("/").at(-1)}”`,
  );
  await expect(here.getByTestId("command-changes-undo")).toHaveCount(0);
  await expect.poll(() => readdir(out)).toEqual(["Deal notes.docx"]);

  const card = await askAndWait(window, `Export this Mind as Word to ${elsewhere}`);
  await expect(card).toHaveAttribute("data-ask", "export");
  await expect(card).toContainText("Save “Deal notes” as Word (.docx) in ");
  await expect(card.getByTestId("approval-file")).toHaveText(["Deal notes.docx"]);
  await expect(card.getByTestId("approval-always-allow")).toHaveCount(0);
  await screenshot(window, "commands-export-asks-en");
  expect(await readdir(elsewhere)).toEqual([]);
  await pointAndClick(window, card.getByTestId("approval-allow-once"));
  const allowed = assistantAnswers(window).last();
  await expect(allowed).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect.poll(() => readdir(elsewhere)).toEqual(["Deal notes.docx"]);

  const again = await askAndWait(window, `Export this Mind as Word to ${elsewhere}`);
  await pointAndClick(window, again.getByTestId("approval-deny"));
  const denied = assistantAnswers(window).last();
  await expect(denied).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(denied.getByTestId("command-changes-unrun")).toHaveText(
    "Not allowed, so nothing changed",
  );
  expect(await readdir(elsewhere)).toEqual(["Deal notes.docx"]);
  await app.close();
});

test("a file that appears while the export card waits refreshes it, marks the new name, and writes only after a second Allow", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  await useOutputLocation(window, out);

  const card = await askAndWait(window, `Export this Mind as Word to ${elsewhere}`);
  await expect(card.getByTestId("approval-file")).toHaveText(["Deal notes.docx"]);
  await writeFile(
    join(elsewhere, "Deal notes.docx"),
    "A file that appeared while the card waited.",
  );
  await pointAndClick(window, card.getByTestId("approval-allow-once"));

  const refreshed = window.getByTestId("approval-card").last();
  await expect(refreshed).toContainText("The files changed since you looked. Allow these instead?");
  await expect(refreshed.getByTestId("approval-file")).toContainText("Deal notes 2.docx");
  await expect(refreshed.getByTestId("approval-file-new")).toHaveText("New");
  await expect(refreshed.getByTestId("approval-allow-once")).toBeDisabled();
  expect(await readdir(elsewhere)).toEqual(["Deal notes.docx"]);
  await screenshot(window, "commands-export-changed");
  await expect(refreshed.getByTestId("approval-allow-once")).toBeEnabled({ timeout: 3_000 });
  await pointAndClick(window, refreshed.getByTestId("approval-allow-once"));

  const allowed = assistantAnswers(window).last();
  await expect(allowed).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect.poll(() => readdir(elsewhere)).toEqual(["Deal notes 2.docx", "Deal notes.docx"]);
  await app.close();
});

test("adding the PDFs in a folder lists them and waits for Allow, then adds them, and one Undo takes them out", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  const inbox = await createDataFolder();
  try {
    await writeFile(join(inbox, "Term sheet.pdf"), buildPdf([{ lines: ["Term sheet"] }]));
    await writeFile(join(inbox, "Teaser.pdf"), buildPdf([{ lines: ["Teaser"] }]));
    await writeFile(join(inbox, "notes.txt"), "Not a PDF.\n");

    const card = await askAndWait(window, `Add the PDFs in ${inbox}`);
    await expect(card).toHaveAttribute("data-ask", "add");
    await expect(card.getByTestId("approval-file")).toHaveText(["Teaser.pdf", "Term sheet.pdf"]);
    await screenshot(window, "commands-add-asks-en");
    expect((await library(window)).names).toHaveLength(DOCUMENTS.length);
    await pointAndClick(window, card.getByTestId("approval-allow-once"));
    const answer = assistantAnswers(window).last();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    const changes = answer.getByTestId("command-changes");
    await expect(changes.getByTestId("command-changes-title")).toHaveText("Added 2 Documents");
    await expect
      .poll(async () => (await library(window)).names)
      .toEqual([...DOCUMENTS, "Teaser", "Term sheet"].sort());

    await undoFrom(window, changes);
    await expect.poll(async () => (await library(window)).names).toEqual([...DOCUMENTS].sort());
  } finally {
    await removeDataFolder(inbox);
  }
  await app.close();
});

test("in Chinese, tagging says what changed in the card and the undo line, at a narrow window", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window, "zh-CN");
  await setWindowSize(app, window, 900, 700);

  const answer = await askInAssistant(window, "给发票加上“财务”标签");

  const card = answer.getByTestId("command-changes");
  await expect(card.getByTestId("command-changes-title")).toHaveText("已给 2 个文档加上“财务”标签");
  await expect(card.getByTestId("command-changes-undo")).toHaveText("撤销");
  await expect(window.getByTestId("undo-line")).toContainText("已给 2 个文档加上“财务”标签");
  const [box, width] = await Promise.all([
    card.boundingBox(),
    window.evaluate(() => globalThis.innerWidth),
  ]);
  expect(box && box.x + box.width <= width).toBe(true);
  await screenshot(window, "commands-tagged-zh-narrow");
  await app.close();
});

/*
 * The assistant does what the User can in the app, from the one command list (#1421), as the
 * prototype's Guide flow "Ask the assistant to organize files" has it.
 */

async function organizeWithTheFake(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [provider] = await core.listChatProviders();
    if (!provider) throw new Error("No provider.");
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
      automatic: false,
    });
  });
}

test("a Folder made and the leases moved into it are one request: the card, the undo line and ⌘Z take both back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);

  const answer = await askInAssistant(
    window,
    "Make a Folder called Leases and move the leases into it",
  );

  const card = answer.getByTestId("command-changes");
  await expect(card.getByTestId("command-changes-title")).toHaveText(
    "Made “Leases” and moved 2 Documents into it",
  );
  await expect(window.getByTestId("undo-line")).toContainText(
    "Made “Leases” and moved 2 Documents into it",
  );
  await expect(window.getByTestId("sidebar")).toContainText("Leases");
  await screenshot(window, "commands-made-moved-en");
  await undoFrom(window, card);
  await expect.poll(async () => (await library(window)).folders).not.toContain("Leases");
  await expect(card.getByTestId("command-changes-undone")).toBeVisible();

  await pointAndClick(window, card.getByTestId("command-changes-title").first());
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(async () => (await foldersOf(window)).Leases)
    .toEqual(["Lease Harbour Street", "Lease Mill Lane"]);
  await expect(window.getByTestId("sidebar")).toContainText("Leases");
  await expect(card.getByTestId("command-changes-undone")).toHaveCount(0);
  await expect(window.getByTestId("undo-line")).toContainText(
    "Made “Leases” and moved 2 Documents into it",
  );
  await undoFrom(window, card);
  await expect.poll(async () => (await library(window)).folders).not.toContain("Leases");
  await expect(card.getByTestId("command-changes-undone")).toBeVisible();
  await expect(window.getByTestId("sidebar")).not.toContainText("Leases");
  expect((await library(window)).names).toEqual([...DOCUMENTS].sort());
  await app.close();
});

test("open a Document beside this one splits to the right and says so in one line, with no Undo; this Note is still the one asked from", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  await expect(window.getByTestId("tab-group")).toHaveCount(1);

  const answer = await askInAssistant(window, "Open the Lease Mill Lane beside this one");

  await expect(answer.getByTestId("command-changes-title")).toHaveText(
    "Opened “Lease Mill Lane” beside this one",
  );
  await expect(answer.getByTestId("command-changes-undo")).toHaveCount(0);
  await expect(window.getByTestId("tab-group")).toHaveCount(2);
  await expect(window.getByTestId("tab-group").last()).toContainText("Lease Mill Lane");
  // The Note the User asked from stays where it was.
  await expect(window.getByTestId("tab-group").first()).toContainText("Deal notes");
  await screenshot(window, "commands-open-beside-en");
  const checked = await askInAssistant(window, "Check this Note");
  // The one Check runs from its one press, and the reply says Done once it has (#2313).
  await expect(checked.getByTestId("command-changes-title")).toHaveText("Done: Check", {
    timeout: 60_000,
  });
  await expect(window.getByTestId("mind-check-ask")).toHaveCount(0);
  await app.close();
});

test("starting a recording waits for Allow, whoever asked, and Don't allow records nothing", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);

  const card = await askAndWait(window, "Start recording a meeting");
  await expect(card).toHaveAttribute("data-ask", "listen");
  await expect(card).toContainText("Run “Record a meeting”?");
  await expect(card).toContainText("It starts or changes a recording, so it waits for you.");
  await expect(card.getByTestId("approval-always-allow")).toHaveCount(0);
  await screenshot(window, "commands-record-asks-en");
  await pointAndClick(window, card.getByTestId("approval-deny"));
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer.getByTestId("command-changes-unrun")).toHaveText(
    "Not allowed, so nothing changed",
  );
  const meetings = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listMeetings()).length;
  });
  expect(meetings).toBe(0);
  await app.close();
});

test("Check this Note runs the check as ⌘K does, and the reply says Done", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);

  const answer = await askInAssistant(window, "Check this Note");
  // The one Check runs from its one press: the reply says Done once it has (#2313).
  await expect(answer.getByTestId("command-changes-title")).toHaveText("Done: Check", {
    timeout: 60_000,
  });
  await expect(window.getByTestId("mind-check-ask")).toHaveCount(0);
  await expect(answer.getByTestId("command-changes-undo")).toHaveCount(0);
  await app.close();
});

test("Local mode is the User's: nothing changes, and one button opens Privacy", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);

  const answer = await askInAssistant(window, "Turn on Local mode");

  const said =
    "“Keep everything on this computer” and what goes to cloud services are yours to change, not mine. They’re in Settings › Privacy.";
  // Said once, in the reply: the card under it keeps only its button, and nothing to keep in a note.
  await expect(answer.getByTestId("assistant-answer-text")).toHaveText(said);
  await expect(answer.getByText(said)).toHaveCount(1);
  const line = answer.getByTestId("command-yours");
  await expect(line).not.toContainText(said);
  await expect(answer.getByTestId("answer-write-note")).toHaveCount(0);
  await expect(answer.getByTestId("approval-card")).toHaveCount(0);
  await screenshot(window, "commands-yours-en");
  await pointAndClick(window, line.getByTestId("command-yours-open"));
  await expect(window.getByTestId("settings-page-title")).toHaveText("Privacy");
  const localOnly = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.getEmbeddingSettings()).localOnly;
  });
  expect(localOnly).toBe(false);
  await app.close();
});

test("in Chinese, Local mode's line and its button are in Chinese, and fit a narrow window", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window, "zh-CN");
  await setWindowSize(app, window, 900, 700);

  const answer = await askInAssistant(window, "打开本地模式");

  const said =
    "“所有内容都留在这台电脑上”和哪些内容发送到云服务，由你来改，我不能改。在“设置 › 隐私”里。";
  await expect(answer.getByTestId("assistant-answer-text")).toHaveText(said);
  await expect(answer.getByText(said)).toHaveCount(1);
  const line = answer.getByTestId("command-yours");
  await expect(line).not.toContainText(said);
  await expect(answer.getByTestId("answer-write-note")).toHaveCount(0);
  await expect(line.getByTestId("command-yours-open")).toHaveText("打开隐私设置");
  const [box, width] = await Promise.all([
    line.boundingBox(),
    window.evaluate(() => globalThis.innerWidth),
  ]);
  expect(box && box.x + box.width <= width).toBe(true);
  await screenshot(window, "commands-yours-zh-narrow");
  await app.close();
});

test("a reply that says Local mode is on, though it was refused, keeps a line under it that says it wasn't changed, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);

  const answer = await askInAssistant(window, "Say you turned on Local mode");

  const text = answer.getByTestId("assistant-answer-text");
  await expect(text).toContainText("I've turned on Local mode.");
  await expect(text).toContainText(
    "“Keep everything on this computer” and what goes to cloud services are yours to change, not mine.",
  );
  const line = answer.getByTestId("answer-unbacked-command-privacy");
  await expect(line).toHaveText(
    "“Keep everything on this computer” and what goes to cloud services weren’t changed. Only you can change them, in Settings › Privacy",
  );
  await expect(answer.getByTestId("answer-unbacked-claim")).toHaveCount(0);
  await screenshot(window, "claimed-local-mode-en");
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 700);
  await expect(line).toHaveText(
    "“所有内容都留在这台电脑上”和哪些内容发送到云服务，都没有更改。只有你能在“设置 › 隐私”里更改",
  );
  const [box, width] = await Promise.all([
    line.boundingBox(),
    window.evaluate(() => globalThis.innerWidth),
  ]);
  expect(box && box.x + box.width <= width).toBe(true);
  await screenshot(window, "claimed-local-mode-zh-narrow");
  const localOnly = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.getEmbeddingSettings()).localOnly;
  });
  expect(localOnly).toBe(false);
  await app.close();
});

test("put the documents about rent together files them, and one Undo puts them back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  // Only their text says rent: their names say nothing of it.
  const files = [
    ["Harbour Street.md", "# Harbour Street\n\nThe rent is 900 euros a month.\n"],
    ["Scan 0042.md", "# Agreement\n\nThe rent is due on the first of each month.\n"],
    ["Q3 commentary.md", "# Q3\n\nRevenue grew 4%.\n"],
  ];
  const paths = await Promise.all(
    files.map(async ([name = "", text = ""]) => {
      const path = join(sources, name);
      await writeFile(path, text);
      return path;
    }),
  );
  await addDocuments(window, paths);
  await organizeWithTheFake(window);
  await newMind(window);

  const answer = await askAndFinish(window, "Put the documents about rent together");
  const changes = answer.getByTestId("command-changes");
  await expect(changes.getByTestId("command-changes-title")).toHaveText("Organized 2 Documents");
  // Nothing is left waiting in To review: the User's request was the acceptance.
  expect(
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const { assignments } = await core.getLibrary();
      return assignments.filter((each) => each.suggested).length;
    }),
  ).toBe(0);
  const placed = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [{ assignments, groups }, documents] = await Promise.all([
      core.getLibrary(),
      core.listDocuments(),
    ]);
    const rent = groups.find((group) => group.name === "Rent");
    return documents
      .map((document) => {
        const held = assignments.find((each) => each.documentId === document.id);
        return {
          name: document.name,
          inRent: held?.groupId === rent?.id,
          chosenByUser: held?.source === "user",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  expect(placed).toEqual([
    { name: "Harbour Street", inRent: true, chosenByUser: true },
    { name: "Q3 commentary", inRent: false, chosenByUser: false },
    { name: "Scan 0042", inRent: true, chosenByUser: true },
  ]);
  await screenshot(window, "commands-organized-en");

  await pointAndClick(window, changes.getByTestId("command-changes-undo"));
  await expect(changes.getByTestId("command-changes-undone")).toBeVisible();
  await expect.poll(async () => (await foldersOf(window)).Rent ?? []).toEqual([]);
  await app.close();
});

test("the first cloud read for Organize asks on its card, and Allow is that consent", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  await organizeWithTheFake(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "fake-model",
    });
    const settings = (await core.getLibrary()).settings;
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
      automatic: settings.automatic,
    });
    const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
    if (!flow) throw new Error("No classification flow.");
    await core.revokeConsent("classification", flow.flow.service.id);
  });

  const card = await askAndWait(window, "Re organise the files");
  await expect(card).toHaveAttribute("data-reason", "organize");
  await expect(card).toContainText("Organize 4 Documents into Folders?");
  await expect(card).toContainText("Sends document names and excerpts to OpenAI.");
  await expect(card).toContainText(
    "Each Document’s name and the start of its text (for a scan, images of its first pages), and your Folders’ and Tags’ names and descriptions, go to OpenAI.",
  );
  await screenshot(window, "commands-organize-cloud-asks-en");
  await setWindowSize(app, window, 900, 900);
  await card.evaluate((each) => each.scrollIntoView({ block: "start" }));
  await screenshot(window, "commands-organize-cloud-asks-en-narrow");
  await setWindowSize(app, window, 1440, 900);
  await pointAndClick(window, card.getByTestId("approval-allow-once"));

  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(answer.getByTestId("command-changes-title")).toHaveText("Organized 4 Documents");
  const consent = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listDataFlows()).find((each) => each.flow.id === "classification")?.consent;
  });
  expect(consent).toBe("accepted");
  await app.close();
});

test("中文：第一次用云端整理时，卡片写明会发送什么，允许后记住同意", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window, "zh-CN");
  await organizeWithTheFake(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "fake-model",
    });
    const settings = (await core.getLibrary()).settings;
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
      automatic: settings.automatic,
    });
    const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
    if (!flow) throw new Error("No classification flow.");
    await core.revokeConsent("classification", flow.flow.service.id);
  });

  const card = await askAndWait(window, "重新整理一下这些文件");
  await expect(card).toHaveAttribute("data-reason", "organize");
  await expect(card).toContainText("整理 4 个文档，放进文件夹？");
  await expect(card).toContainText(
    "每个文档的名称和开头的文字（扫描件则是前几页的图片），以及文件夹和标签的名称与描述，会发送给 OpenAI。",
  );
  // The card's Chinese sentences meet with full-width punctuation, never an ASCII space.
  await expect(card).toContainText("可以用撤销恢复。会把文档名称和摘录发送给 OpenAI。");
  await screenshot(window, "commands-organize-cloud-asks-zh");
  await setWindowSize(app, window, 900, 900);
  await card.evaluate((each) => each.scrollIntoView({ block: "start" }));
  await screenshot(window, "commands-organize-cloud-asks-zh-narrow");
  await setWindowSize(app, window, 1440, 900);
  await pointAndClick(window, card.getByTestId("approval-allow-once"));

  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(answer.getByTestId("command-changes-title")).toHaveText("整理了 4 个文档");
  const consent = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listDataFlows()).find((each) => each.flow.id === "classification")?.consent;
  });
  expect(consent).toBe("accepted");
  await app.close();
});

test("Re organise the files files every Document, and one Undo puts them back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  await organizeWithTheFake(window);

  const answer = await askAndFinish(window, "Re organise the files");
  const changes = answer.getByTestId("command-changes");
  await expect(changes.getByTestId("command-changes-title")).toHaveText("Organized 4 Documents");
  await expect
    .poll(() => foldersOf(window))
    .toEqual({
      Lease: ["Lease Harbour Street", "Lease Mill Lane"],
      Northwind: ["Northwind invoice April", "Northwind invoice March"],
    });

  await pointAndClick(window, changes.getByTestId("command-changes-undo"));
  await expect(changes.getByTestId("command-changes-undone")).toBeVisible();
  await expect.poll(() => foldersOf(window)).toEqual({});
  await app.close();
});

test("重新整理文件：整理完成后撤销一次就恢复原样", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window, "zh-CN");
  await organizeWithTheFake(window);

  const answer = await askAndFinish(window, "重新整理一下这些文件");
  const changes = answer.getByTestId("command-changes");
  await expect(changes.getByTestId("command-changes-title")).toHaveText("整理了 4 个文档");
  await expect
    .poll(() => foldersOf(window))
    .toEqual({
      Lease: ["Lease Harbour Street", "Lease Mill Lane"],
      Northwind: ["Northwind invoice April", "Northwind invoice March"],
    });
  await screenshot(window, "commands-organized-zh");

  await pointAndClick(window, changes.getByTestId("command-changes-undo"));
  await expect(changes.getByTestId("command-changes-undone")).toBeVisible();
  await expect.poll(() => foldersOf(window)).toEqual({});
  await app.close();
});

test("Reduce the number of tags merges them after one Apply, and one Undo brings every Tag back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  await tagSetUp(window, [
    ["Harbour", "Harbours"],
    ["Dock", "Docks"],
  ]);

  const card = await askAndWait(window, "Reduce the number of tags");
  await expect(card).toHaveAttribute("data-kind", "command");
  await expect(card).toHaveAttribute("data-reason", "merge");
  await expect(card).toContainText("Merge 2 Tags?");
  await expect(card.getByTestId("approval-file")).toHaveText([
    "Docks → Dock",
    "Harbours → Harbour",
  ]);
  await expect(card).toContainText(
    "Each Tag’s Documents get the Tag beside it, and the Tags merged away go to Recently deleted. Undo brings them back.",
  );
  await expect(card.getByTestId("approval-allow-once")).toContainText("Apply");
  await screenshot(window, "commands-tags-merge-asks-en");
  await setWindowSize(app, window, 900, 900);
  await screenshot(window, "commands-tags-merge-asks-en-narrow");
  await setWindowSize(app, window, 1440, 900);
  await pointAndClick(window, card.getByTestId("approval-allow-once"));

  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  const changes = answer.getByTestId("command-changes");
  await expect(changes.getByTestId("command-changes-title")).toHaveText("Merged 2 Tags");
  await screenshot(window, "commands-tags-merged-en");
  await expect.poll(async () => (await library(window)).tags).toContain("Harbour");
  expect((await library(window)).tags).not.toContain("Harbours");
  expect((await library(window)).tags).not.toContain("Docks");

  await pointAndClick(window, changes.getByTestId("command-changes-undo"));
  await expect(changes.getByTestId("command-changes-undone")).toBeVisible();
  await expect.poll(async () => (await library(window)).tags).toContain("Harbours");
  await expect.poll(async () => (await library(window)).tags).toContain("Docks");
  await app.close();
});

test("减少标签数量：确认一次就合并，撤销一次全部恢复", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window, "zh-CN");
  await tagSetUp(window, [["港口", "港口区"]]);

  const card = await askAndWait(window, "减少标签的数量");
  await expect(card).toHaveAttribute("data-reason", "merge");
  await expect(card).toContainText("将“港口区”合并到“港口”？");
  await expect(card).toContainText(
    "这些文档会打上“港口”标签，其他标签会移到回收站。可以用撤销恢复。",
  );
  await expect(card.getByTestId("approval-allow-once")).toContainText("应用");
  await screenshot(window, "commands-tags-merge-asks-zh");
  await setWindowSize(app, window, 900, 900);
  await screenshot(window, "commands-tags-merge-asks-zh-narrow");
  await setWindowSize(app, window, 1440, 900);
  await pointAndClick(window, card.getByTestId("approval-allow-once"));

  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  const changes = answer.getByTestId("command-changes");
  await expect(changes.getByTestId("command-changes-title")).toHaveText("已将“港口区”合并到“港口”");
  await expect.poll(async () => (await library(window)).tags).toContain("港口");
  expect((await library(window)).tags).not.toContain("港口区");
  await screenshot(window, "commands-tags-merged-zh");

  await pointAndClick(window, changes.getByTestId("command-changes-undo"));
  await expect(changes.getByTestId("command-changes-undone")).toBeVisible();
  await expect.poll(async () => (await library(window)).tags).toContain("港口区");
  await app.close();
});

/** Each Folder's Documents, by name, sorted. */
const foldersOf = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [library, documents] = await Promise.all([core.getLibrary(), core.listDocuments()]);
    const names = new Map(documents.map((each) => [each.id, each.name]));
    return Object.fromEntries(
      library.groups.map((group) => [
        group.name,
        library.assignments
          .filter((each) => each.groupId === group.id)
          .map((each) => names.get(each.documentId) ?? "")
          .sort(),
      ]),
    );
  });

/** Each pair is two Tags, the shorter a prefix of the longer, the first of them on a lease. */
async function tagSetUp(window: Page, pairs: [string, string][]): Promise<void> {
  await window.evaluate(async (all: [string, string][]) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const documents = await core.listDocuments();
    const harbour = documents.find((each) => each.name === "Lease Harbour Street");
    const mill = documents.find((each) => each.name === "Lease Mill Lane");
    if (!harbour || !mill) throw new Error("The leases are missing.");
    for (const [at, [kept, merged]] of all.entries()) {
      const shorter = await core.createTag({ name: kept });
      const longer = await core.createTag({ name: merged });
      if (at === 0) {
        await core.addTagToDocuments([harbour.id], shorter.id);
        await core.addTagToDocuments([mill.id], longer.id);
      }
    }
  }, pairs);
}
