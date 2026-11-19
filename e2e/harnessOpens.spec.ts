import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  catchCopies,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  openSettings,
  opensRecorded,
  pathsOpened,
  removeDataFolder,
  urlsOpened,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Agents are hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * The harness itself (#3362): an app a spec launches opens nothing on this computer, not Claude's
 * app, not a browser, not the file manager, whatever the spec does, and finds only the agents the
 * spec set up, never the apps this computer has. Connecting Claude's app and Cursor, the two that
 * hand something to another app, is recorded instead.
 */

let dataDir: string;
let home: string;
let freshHome: string;
let apps: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  freshHome = await realpath(await createDataFolder());
  apps = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(freshHome);
  await removeDataFolder(apps);
});

const clients = (window: Parameters<typeof dismissChatSetup>[0]) =>
  window.evaluate(async () =>
    (
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listAgentClients()
    ).map((each) => [each.id, each.installed] as const),
  );

// protects=no spec's launched app hands a file or link to this computer's own apps, and no spec reads which agents this computer has; fails_when=the harness's default record of opens is missing, connecting Claude's app or Cursor opens them, or an agent counts as found from this computer's Applications folder
test("a launched app records what it would open, and finds only the agents the test set up", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { home });
  try {
    expect(await opensRecorded(app)).toBe(true);
    await dismissChatSetup(window);
    expect((await clients(window)).filter(([, installed]) => installed)).toEqual([]);

    await acceptPlainTextKeys(window);
    await catchCopies(window);
    const tides = join(home, "Tides.md");
    await writeFile(tides, "# Tides\n\nSpring tides come at new moon and full moon.\n");
    await window.evaluate(async (path) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.addDocuments([path]);
      await core.setAgentsEnabled(true);
    }, tides);
    await expectReadyDocuments(window, 1);
    const page = await openSettings(window, "agents");
    for (const client of ["claude-desktop", "cursor"]) {
      await page
        .getByTestId("agents-list")
        .locator(`[data-client="${client}"]`)
        .getByTestId("agent-connect")
        .click();
      const dialog = window.getByTestId("connect-agent-dialog");
      await dialog.getByTestId("connect-agent-allow").click();
      await expect(dialog).toBeHidden();
    }
    await expect.poll(() => pathsOpened(app)).toEqual([expect.stringMatching(/\.mcpb$/)]);
    expect(await urlsOpened(app)).toEqual([expect.stringMatching(/^cursor:\/\//)]);
  } finally {
    await app.close();
  }

  // An agent's app the test made is found; still nothing of this computer's. A home of its own:
  // connecting Cursor above put its Skill in the first one, which counts as Cursor found.
  await mkdir(join(apps, "Cursor.app"));
  const again = await launchApp(dataDir, { home: freshHome, agentApps: [apps] });
  try {
    expect((await clients(again.window)).filter(([, installed]) => installed)).toEqual([
      ["cursor", true],
    ]);
  } finally {
    await again.app.close();
  }
});
