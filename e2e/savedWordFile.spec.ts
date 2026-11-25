import { chmod, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  pathsOpened,
  pathsShown,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  writeNote,
} from "./app";

/*
 * A Word file the User's own AI saves from a Note's conversation (#3751): its step names the file
 * and its kind, with Open and Show in Finder as Export's saved line offers them; once the file is
 * moved or deleted they say so where the card is, and a run stopped after the save keeps the card.
 * With the stand-in for Claude Code (no model, no key). Set INCARNAMIND_SCREENSHOTS to a folder to
 * also save screenshots.
 */

let dataDir: string;
let sources: string;
let home: string;
let bin: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});
test.afterEach(async () => {
  for (const folder of [dataDir, sources, home, bin]) await removeDataFolder(folder);
});

async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.waitForTimeout(300);
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

const WORDS = {
  en: {
    folder: "Harbour",
    title: "Harbour brief",
    lines: [
      "The north quay holds 42 boats.",
      "The south quay holds 19 boats.",
      "The harbour office is open every day of the year.",
    ],
    ask: "Make this a Word file",
    reply:
      "I saved your note as a Word file, its sources as footnotes, in Documents › IncarnaMind.",
    gone: "Couldn’t open it: the file is no longer there; it was moved or deleted",
  },
  "zh-CN": {
    folder: "港口",
    title: "港口简报",
    lines: ["北码头停泊着四十二艘渔船。", "港务办公室全年每天开放。"],
    ask: "把这篇存成 Word 文件",
    reply: "已把这篇笔记存成 Word 文件，来源写成脚注，保存在“文稿 › IncarnaMind”中。",
    gone: "无法打开文件：这个文件已不在原处，它被移动或删除了",
  },
} as const;

/**
 * The app with the stand-in for Claude Code connected to a Folder with the survey, the Note
 * written there and in front, at 1440 × 900 in `language`; the stand-in's next run is `mode`.
 */
async function noteInFront(language: keyof typeof WORDS, mode: string) {
  const words = WORDS[language];
  const { app, window } = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  try {
    await acceptPlainTextKeys(window);
    await dismissChatSetup(window);
    if (language === "zh-CN") await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 1440, 900);
    const survey = join(sources, "Harbour survey.md");
    await writeFile(
      survey,
      "# Harbour survey\n\nThe north quay holds 42 boats and the south quay holds 19 boats.\n",
    );
    const folderId = await window.evaluate(
      async ({ file, name }) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const folder = await bridge.createLibraryGroup({ name, description: "" });
        await bridge.addDocuments([file], { groupId: folder.id });
        await bridge.setAgentsEnabled(true);
        await bridge.connectAgent({
          name: "Claude Code",
          client: "claude-code",
          folderIds: [folder.id],
          propose: true,
        });
        return folder.id;
      },
      { file: survey, name: words.folder },
    );
    await expectReadyDocuments(window, 1);
    const mindId = await writeNote(
      window,
      words.title,
      words.lines.map((text) => ({ text })),
      { folderId },
    );
    const folderRow = sidebarFolder(window, words.folder).getByTestId("folder-row");
    if ((await folderRow.getAttribute("aria-expanded")) !== "true") {
      await pointAndClick(window, folderRow);
    }
    await pointAndClick(
      window,
      window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
    );
    await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
    await writeFile(join(bin, "mode"), mode);
    await writeFile(join(bin, "mode.reply"), words.reply);
    const group = window.locator('[data-testid="tab-group"][data-focused]');
    await pointAndClick(window, group.getByTestId("note-ask-input"));
    await window.keyboard.type(words.ask);
    await window.keyboard.press("Enter");
    return { app, window, mindId, words, group };
  } catch (error) {
    await app.close();
    throw error;
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the Word file the AI saves opens and shows from its step, and says so once it is gone (${language})`, async () => {
    const { app, window, mindId, words, group } = await noteInFront(language, "word");
    try {
      await expect
        .poll(
          () =>
            window.evaluate(async (id) => {
              const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
              return (await bridge.noteConversation(id)).at(-1)?.outcome ?? null;
            }, mindId),
          { timeout: 30_000 },
        )
        .toBe("landed");
      await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
      await pointAndClick(window, group.getByTestId("conversation-move-left"));

      // Its step names the file and its kind, with Export's own Open and Show in Finder.
      const card = window.getByTestId("note-column-saved");
      await expect(card).toContainText(`${words.title}.docx`);
      await expect(card.getByTestId("note-column-saved-kind")).toHaveText("Word");
      await shot(window, `saved-word-file-card-${language}`);
      await pointAndClick(window, card.getByTestId("note-column-saved-open"));
      await pointAndClick(window, card.getByTestId("note-column-saved-show"));
      await expect.poll(async () => (await pathsOpened(app)).length).toBe(1);
      const [saved] = await pathsOpened(app);
      expect(saved).toMatch(new RegExp(`${words.title}\\.docx$`));
      expect(await pathsShown(app)).toEqual([saved]);

      // Moved or deleted since: Open says so where the card is, and hands nothing to the system.
      await rm(saved ?? "");
      await pointAndClick(window, card.getByTestId("note-column-saved-open"));
      await expect(card.getByTestId("note-column-saved-problem")).toHaveText(words.gone);
      expect(await pathsOpened(app)).toHaveLength(1);
      await shot(window, `saved-word-file-gone-${language}`);
    } finally {
      await app.close();
    }
  });

  test(`the Word file the AI saved keeps its card once the User stops the run (${language})`, async () => {
    const { app, window, words, group } = await noteInFront(language, "word-wait");
    try {
      await pointAndClick(window, group.getByTestId("note-ask-handle-toggle"));
      await pointAndClick(window, group.getByTestId("conversation-move-left"));
      const column = window.getByTestId("note-column");
      const card = column.getByTestId("note-column-saved");
      await expect(card).toContainText(`${words.title}.docx`, { timeout: 30_000 });
      await pointAndClick(window, column.getByTestId("note-ask-stop"));
      await expect(column.getByTestId("note-column-interrupted")).toBeVisible();

      // The file was saved before the stop: its card stays, and still opens it.
      await expect(card).toContainText(`${words.title}.docx`);
      await expect(card.getByTestId("note-column-saved-kind")).toHaveText("Word");
      await shot(window, `saved-word-file-stopped-${language}`);
      await pointAndClick(window, card.getByTestId("note-column-saved-open"));
      await expect.poll(async () => (await pathsOpened(app)).length).toBe(1);
      expect((await pathsOpened(app))[0]).toMatch(new RegExp(`${words.title}\\.docx$`));
    } finally {
      await app.close();
    }
  });
}
