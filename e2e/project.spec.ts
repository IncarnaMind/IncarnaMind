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
 * A new User's first walk with a Project (#3507, ADR-0030): a Linked folder made a Project from its
 * menu, with Undo; the folder's files filed in it; the agent given the Project alone, its folder
 * named under it in Settings › AI; and a deck the agent made in the folder and a Note it wrote
 * there, both checked. The scripted model (src/main/fakeChat/) checks. Set INCARNAMIND_SCREENSHOTS to
 * a folder to also save stills there.
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

  // protects=a new User makes a Linked folder a Project from its menu, with Undo; its files are filed in it; an agent given it alone sees its folder named in Settings › AI, hands over a deck it made there and writes a Note there, and both are checked against the folder's files (#3507); fails_when=the menu has no such item, the files stay in Not in a Folder, Undo leaves the file put in no Folder by the User or Redo doesn't file it again, the picker doesn't say which folder it is, or the hand-over is refused for lack of reach
  test(`a Linked folder made a Project: the agent's deck and Note there are checked (${language})`, async () => {
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

      const menu = await openLinkedFolderMenu(linkedFolderRow(window, basename(work)));
      const make = menu.getByTestId("linkedFolder.makeProject");
      await expect(make).toHaveText(t("linkedFolders.makeProject"));
      await shot(window, `project-menu-${language}`);
      await make.click();
      const made = t("undo.projectMade", { name: basename(work) });
      await expect(undoMessage(window)).toHaveText(made);
      const project = await (await bridge(window)).evaluate(async (core) => {
        const library = await core.getLibrary();
        const group = library.groups.find((each) => each.boundFolderId !== null);
        const filed = library.assignments.filter((each) => each.groupId === group?.id);
        return { id: group?.id ?? "", keepInside: group?.keepInside, filed: filed.length };
      });
      expect(project).toMatchObject({ keepInside: true, filed: 1 });
      await shot(window, `project-made-${language}`);
      // Undo takes the Project back, its file as it was: in no Folder, and not as the User's choice,
      // so Organize may still place it and a Project made again files it. Redo brings both back.
      const projects = () =>
        bridge(window).then((core) =>
          core.evaluate(
            async (each) =>
              (await each.getLibrary()).groups.filter((group) => group.boundFolderId !== null)
                .length,
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
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(projects).toBe(0);
      await expect.poll(planFiling).toEqual({ groupId: null, byUser: false });
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(projects).toBe(1);
      await expect.poll(planFiling).toEqual({ groupId: project.id, byUser: true });
      // Made once: the item isn't offered again for the same folder.
      const again = await openLinkedFolderMenu(linkedFolderRow(window, basename(work)));
      await expect(again.getByTestId("linkedFolder.makeProject")).toHaveCount(0);
      await window.keyboard.press("Escape");

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
