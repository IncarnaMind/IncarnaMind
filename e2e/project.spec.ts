import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import { plainDeck } from "../tests/helpers/pptx";
import {
  acceptPlainTextKeys,
  checkAssistantWrites,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  linkedFolderRow,
  motionSettled,
  openLinkedFolderMenu,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  useLocalChatModel,
} from "./app";
import { callTool } from "./canvases";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * A new User's first walk with a linked folder's Folder (#3507, #3613, ADR-0030): linking a folder
 * makes a Folder bound to it, its files filed in it; File as one Folder turned off and back with
 * Undo and Redo; the agent given that Folder alone, its folder named under it in Settings › AI;
 * and a deck the agent made in the folder and a Note it wrote there, both checked. The scripted
 * model (src/main/fakeChat/) checks. Set INCARNAMIND_SCREENSHOTS to a folder to also save stills
 * there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(target: Page | Locator, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  if ("waitForLoadState" in target) await motionSettled(target);
  await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let home: string;
let work: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  work = join(await realpath(await createDataFolder()), "Quay works");
  await mkdir(work);
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(join(work, ".."));
});

const EAST = "The east quay holds 31 boats.";
const bridge = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);
const undoMessage = (window: Page) => window.getByTestId("undo-message");

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);

  // protects=linking a folder makes a Folder bound to it, its files filed in it; File as one Folder turned off and back is one step each for Undo and Redo; an agent given that Folder alone sees its folder named in Settings › AI, hands over a deck it made there and writes a Note there, and both are checked against the folder's files (#3507, #3613); fails_when=the files stay in Not in a Folder, Undo leaves the file put in no Folder by the User or Redo doesn't file it again, the picker doesn't say which folder it is, or the hand-over is refused for lack of reach
  test(`a linked folder's Folder: the agent's deck and Note there are checked (${language})`, async () => {
    test.setTimeout(150_000);
    const { app, window } = await launchApp(dataDir, { home, fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    // A hand-over is checked as it lands only with this on (#3576).
    await checkAssistantWrites(window);
    try {
      await acceptPlainTextKeys(window);
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      await writeFile(join(work, "Quay plan.md"), `# Quay plan\n\n${EAST}\n`);
      await (await bridge(window)).evaluate((core, path) => core.addLinkedFolder(path), work);
      await expectReadyDocuments(window, 1);
      const projects = () =>
        bridge(window).then((core) =>
          core.evaluate(async (each) =>
            (await each.getLibrary()).groups
              .filter((group) => group.boundFolderId !== null)
              .map((group) => ({ id: group.id, keepInside: group.keepInside })),
          ),
        );
      const planFiling = () =>
        bridge(window).then((core) =>
          core.evaluate(async (each) => {
            const plan = (await each.listDocuments()).find((one) => one.name === "Quay plan");
            const row = (await each.getLibrary()).assignments.find(
              (one) => one.documentId === plan?.id,
            );
            return { groupId: row?.groupId ?? null, byUser: row?.source === "user" };
          }),
        );
      const [project] = await projects();
      if (!project) throw new Error("Linking made no Folder.");
      expect(project.keepInside).toBe(false);
      await expect.poll(planFiling).toEqual({ groupId: project.id, byUser: true });
      await shot(window, `project-made-${language}`);

      // Turned off from its menu, its file goes back to no filing, not as the User's choice, so
      // Organize may still place it; Undo files it in the same Folder again, Redo turns it off.
      const menu = await openLinkedFolderMenu(linkedFolderRow(window, basename(work)));
      const fileAsFolder = menu.getByTestId("linkedFolder.fileAsFolder");
      await expect(fileAsFolder).toHaveText(t("folder.fileAsFolder"));
      await shot(window, `project-menu-${language}`);
      await fileAsFolder.click();
      await expect(undoMessage(window)).toHaveText(
        t("undo.fileAsFolder.off", { name: basename(work) }),
      );
      await expect.poll(projects).toEqual([]);
      await expect.poll(planFiling).toEqual({ groupId: null, byUser: false });
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(projects).toEqual([project]);
      await expect.poll(planFiling).toEqual({ groupId: project.id, byUser: true });
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(projects).toEqual([]);
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(planFiling).toEqual({ groupId: project.id, byUser: true });

      const launch = await (await bridge(window)).evaluate(async (core, folderId) => {
        await core.setAgentsEnabled(true);
        return (
          await core.connectAgent({ name: "Claude Code", folderIds: [folderId], propose: true })
        ).launch;
      }, project.id);
      const agent = new Client({ name: "test-agent", version: "1.0.0" });
      await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));

      await window
        .getByRole("button", { name: t("settings.title") })
        .last()
        .click();
      const page = await showSettingsPage(window, "ai");
      const pairing = page.locator('[data-testid="agent-pairing"][data-name="Claude Code"]');
      await pairing.getByTestId("agent-folders").click();
      const place = pairing.getByTestId("agent-folder-list").getByTestId("agent-folder-place");
      await expect(place).toHaveText(work);
      await shot(window, `project-picker-${language}`);
      await window.keyboard.press("Escape");
      await window.keyboard.press("Escape");

      const deck = join(work, "Quay review.pptx");
      await writeFile(deck, plainDeck([{ title: "Quay review" }, { lines: [EAST] }]));
      const handed = await callTool<{ status: string; mindId: string }>(agent, "hand_over_file", {
        path: deck,
      });
      expect(handed.status).toBe("checked");
      const note = await callTool<{ mindId: string }>(agent, "create_mind", {
        title: "Quay summary",
        markdown: EAST,
        folderId: project.id,
      });
      expect(
        await callTool<{ status: string }>(agent, "check_mind", { mindId: note.mindId }),
      ).toMatchObject({ status: "checked" });
      await agent.close();
      const inProject = await (await bridge(window)).evaluate(
        async (core, ids) =>
          (await core.listMinds())
            .filter((each) => ids.includes(each.id))
            .map((each) => each.folderId),
        [handed.mindId, note.mindId],
      );
      expect(inProject).toEqual([project.id, project.id]);
      await shot(window, `project-notes-${language}`);
    } finally {
      await app.close();
    }
  });
}
