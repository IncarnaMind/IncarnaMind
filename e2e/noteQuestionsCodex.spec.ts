import { chmod, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { processRunning } from "../tests/helpers/processRunning";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  fromConversationMenu,
  frontMind,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  sidebarFolder,
  writeNote,
} from "./app";

/*
 * What the User's own Codex asks in a Note's conversation, and does with its own tools (#3653):
 * the consent in Codex's own words at the first request, a card for each approval with Codex's
 * own answers, the step each becomes, the waiting dot, Stop with a card open, and a setting that
 * never asks said once. With the stand-in for Codex's app-server (no model, no key).
 */

let dataDir: string;
let home: string;
let bin: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeCodex.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "codex"), 0o755);
});
test.afterEach(async () => {
  for (const folder of [dataDir, home, bin]) await removeDataFolder(folder);
});

const nextRun = (mode: string) => writeFile(join(bin, "mode"), mode);
const group = (window: Page) => window.locator('[data-testid="tab-group"][data-focused]');

/** "Harbour notes" in "Kestrel Bay", with Codex connected to the folder and the Note open. */
async function harbourNotes(window: Page): Promise<string> {
  await acceptPlainTextKeys(window);
  await dismissChatSetup(window);
  const path = join(bin, "Ferry interview.md");
  await writeFile(path, "# Ferry interview\n\nThe 07:40 crossing leaves late most weeks.\n");
  const folderId = await window.evaluate(async (file) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Kestrel Bay", description: "" });
    await bridge.addDocuments([file], { groupId: folder.id });
    await bridge.setAgentsEnabled(true);
    await bridge.connectAgent({
      name: "ChatGPT app and Codex",
      client: "codex",
      folderIds: [folder.id],
      propose: true,
    });
    return folder.id;
  }, path);
  await expectReadyDocuments(window, 1);
  const mindId = await writeNote(
    window,
    "Harbour notes",
    [{ text: "The early ferry crossing runs late most weekdays." }],
    { folderId },
  );
  const folderRow = sidebarFolder(window, "Kestrel Bay").getByTestId("folder-row");
  if ((await folderRow.getAttribute("aria-expanded")) !== "true") {
    await pointAndClick(window, folderRow);
  }
  await pointAndClick(
    window,
    window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
  );
  await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
  return mindId;
}

const outcomesOf = (window: Page, mindId: string) =>
  window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.noteConversation(id)).map((turn) => turn.outcome);
  }, mindId);

async function ended(window: Page, mindId: string, before: number) {
  await expect
    .poll(
      async () => {
        const outcomes = await outcomesOf(window, mindId);
        return outcomes.length > before && outcomes.at(-1) !== "working";
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Sends `words` from the Note's input. */
async function send(window: Page, mode: string, words: string) {
  await nextRun(mode);
  await pointAndClick(window, group(window).getByTestId("note-ask-input"));
  await window.keyboard.type(words);
  await window.keyboard.press("Enter");
}

async function cardOf(window: Page): Promise<Locator> {
  const card = group(window).getByTestId("own-ask-card");
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

/** The answers on a card, as their buttons read. */
const answersOf = (card: Locator) =>
  card.getByTestId("own-ask-answers").getByRole("button").allInnerTexts();

/** The steps of the AI's own in the conversation's last turn. */
async function lastSteps(window: Page): Promise<string[]> {
  await pointAndClick(window, group(window).getByTestId("note-ask-handle-toggle"));
  const panel = group(window).getByTestId("note-ask-panel");
  const turn = panel.getByTestId("note-column-turn").last();
  const toggle = turn.getByTestId("note-column-steps-toggle");
  await expect(toggle.or(turn.getByTestId("own-step").first())).toBeVisible();
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) !== "true") {
    await pointAndClick(window, toggle);
  }
  await expect(turn.getByTestId("own-step").first()).toBeVisible();
  const steps = await turn.getByTestId("own-step").allTextContents();
  await fromConversationMenu(window, panel, "note-ask-fold");
  return steps;
}

/** The folder of the Note's one conversation. */
async function conversationFolder(): Promise<string> {
  const conversations = join(dataDir, "Own AI conversations");
  const [key] = (await readdir(conversations)).filter((name) => !name.startsWith("."));
  return join(conversations, key ?? "");
}

test("on the User's own Codex: the first request asks in Codex's words; a command asks with Codex's own answers, runs once allowed and not when denied; its answer for this request; a write that steers says so; Stop with a card open ends all it started; a setting that never asks is said once", async () => {
  test.setTimeout(150_000);
  const { app, window } = await launchApp(dataDir, {
    home,
    ownCodex: join(bin, "codex"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  try {
    await setWindowSize(app, window, 1440, 900);
    const mindId = await harbourNotes(window);

    // The first request asks for what a request sends, in Codex's words, never Claude Code's.
    let before = (await outcomesOf(window, mindId)).length;
    await send(window, "conv-command", "Mark the late crossings");
    const consent = window.getByTestId("consent-dialog");
    await expect(consent).toBeVisible({ timeout: 20_000 });
    await expect(consent).toContainText("Codex keeps each note’s conversation on this computer");
    await expect(consent).toContainText("your AGENTS.md in its own folder");
    await expect(consent).not.toContainText("Claude Code");
    await pointAndClick(window, consent.getByTestId("consent-allow"));

    // The command, whole, with Codex's words for it and Codex's own answers.
    let card = await cardOf(window);
    await expect(card.locator(".approval-title")).toHaveText("Run a command");
    await expect(card.getByTestId("own-ask-description")).toHaveText(
      "May I create the marker file?",
    );
    await expect(card.getByTestId("own-ask-value")).toHaveText("touch marker.txt");
    expect(await answersOf(card)).toEqual([
      "Deny",
      "Don’t ask again for touch marker.txt commands anywhere",
      "Allow once",
    ]);
    await expect(group(window).getByTestId("note-ask-pill")).toContainText(
      "Waiting for your approval",
    );
    await expect(
      window.locator('[data-testid="mind-tab-status"][data-status="waiting-for-approval"]'),
    ).toHaveCount(1);
    await pointAndClick(window, card.getByTestId("own-ask-once"));
    await ended(window, mindId, before);
    const folder = await conversationFolder();
    await expect.poll(() => readFile(join(folder, "marker.txt"), "utf8")).toBe("");
    expect(await lastSteps(window)).toEqual(["Ran touch marker.txt · allowed once"]);

    // Denied, it runs nothing.
    await writeFile(join(bin, "answers.jsonl"), "");
    before = (await outcomesOf(window, mindId)).length;
    await send(window, "conv-command", "Mark them again");
    card = await cardOf(window);
    await pointAndClick(window, card.getByTestId("own-ask-deny"));
    await ended(window, mindId, before);
    expect(await lastSteps(window)).toEqual(["Didn’t run touch marker.txt · denied"]);
    expect(await readFile(join(bin, "answers.jsonl"), "utf8")).toContain('"decline"');

    // Codex's answer for this request, beside Allow once.
    before = (await outcomesOf(window, mindId)).length;
    await send(window, "conv-session", "And once more");
    card = await cardOf(window);
    expect(await answersOf(card)).toEqual([
      "Deny",
      "Don’t ask again for “touch marker.txt” for this request",
      "Allow once",
    ]);
    await pointAndClick(window, card.getByTestId("own-ask-request"));
    await ended(window, mindId, before);
    expect(await lastSteps(window)).toEqual(["Ran touch marker.txt · allowed for this request"]);

    // A skill Codex would read from now on says so.
    before = (await outcomesOf(window, mindId)).length;
    await send(window, "conv-steering", "Remember to say yes");
    card = await cardOf(window);
    await expect(card.locator(".approval-title")).toHaveText("Write a file");
    await expect(card).toContainText("This file changes how Codex behaves from now on.");
    await pointAndClick(window, card.getByTestId("own-ask-deny"));
    await ended(window, mindId, before);

    // Stop with a card open ends the run and everything Codex started.
    before = (await outcomesOf(window, mindId)).length;
    await send(window, "conv-wait", "Count them in the background");
    card = await cardOf(window);
    const pids = JSON.parse(await readFile(join(bin, "pids.json"), "utf8")) as number[];
    await pointAndClick(window, group(window).getByTestId("note-ask-stop"));
    await ended(window, mindId, before);
    await expect(group(window).getByTestId("own-ask-card")).toHaveCount(0);
    await expect.poll(() => pids.filter(processRunning), { timeout: 10_000 }).toEqual([]);
    expect(await lastSteps(window)).toEqual([
      "Didn’t run touch marker.txt · stopped before you answered",
    ]);

    // Set never to ask: the conversation says so once.
    before = (await outcomesOf(window, mindId)).length;
    await send(window, "conv-never", "Count them");
    await ended(window, mindId, before);
    await pointAndClick(window, group(window).getByTestId("note-ask-handle-toggle"));
    await expect(group(window).getByTestId("note-ask-panel").getByTestId("own-mode")).toHaveText(
      "Codex is set never to ask, so here it acts without asking you.",
    );
  } finally {
    await app.close();
  }
});
