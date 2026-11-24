import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { openDatabase } from "../src/core/storage";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  agentsToConnect,
  catchCopies,
  copied,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  urlsOpened,
  writeNote,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");
test.skip(process.platform === "win32", "The stand-in for Claude Code starts from a shell script.");

/*
 * A Check pressed with no model set up runs on the User's own Claude Code in the background (#3606).
 * A Node script stands in for `claude`: the app starts it as it would start Claude Code, and it
 * reaches IncarnaMind only through the settings it was given. Nothing opens: every link the app
 * would open is recorded. The Note's line says it is checking with Stop beside it, the marks land,
 * and a run that can't start or fails says why; a take-back in Settings › Privacy keeps the link
 * with no dialog, and a connection made before asks once.
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
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeCodex.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "codex"), 0o755);
});
test.afterEach(async () => {
  for (const folder of [dataDir, sources, home, bin]) await removeDataFolder(folder);
});

/** What the stand-in does at its next start. */
const nextRun = (
  mode: "check" | "wait" | "signed-out" | "limit" | "outside" | "extra-tool" | "old",
) => writeFile(join(bin, "mode"), mode);

/** Saves a screenshot when INCARNAMIND_SCREENSHOTS names a folder for them. */
async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

/** "Kestrel Bay" with its annual report, and Claude Code (or the ChatGPT app and Codex) connected to it. */
async function connected(
  window: Page,
  client: "claude-code" | "codex" = "claude-code",
): Promise<{ folderId: string; pairingId: string }> {
  const report = join(sources, "Annual report 2025.md");
  await writeFile(
    report,
    "# Kestrel Bay Harbour Authority: annual report 2025\n\nIn 2025 the harbour handled 1,240 ship calls.\n",
  );
  const made = await window.evaluate(
    async ({ path, client }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await bridge.createLibraryGroup({ name: "Kestrel Bay", description: "" });
      await bridge.addDocuments([path], { groupId: folder.id });
      await bridge.setAgentsEnabled(true);
      const agent = await bridge.connectAgent({
        name: client === "codex" ? "ChatGPT app and Codex" : "Claude Code",
        client,
        folderIds: [folder.id],
      });
      return { folderId: folder.id, pairingId: agent.pairing.id };
    },
    { path: report, client },
  );
  await expectReadyDocuments(window, 1);
  return made;
}

async function open(window: Page, mindId: string) {
  const folderRow = sidebarFolder(window, "Kestrel Bay").getByTestId("folder-row");
  if ((await folderRow.getAttribute("aria-expanded")) !== "true") {
    await pointAndClick(window, folderRow);
  }
  await pointAndClick(
    window,
    window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
  );
  await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
}

async function press(window: Page) {
  if (!(await window.getByTestId("check-card").isVisible())) {
    await pointAndClick(window, window.getByTestId("check-badge-open"));
  }
  await pointAndClick(window, window.getByTestId("badge-check-mind"));
}

/** Each shot at 1440 wide in English and 900 wide in Chinese, then back to English. */
async function both(
  app: Parameters<typeof setWindowSize>[0],
  window: Page,
  name: string,
  zh: () => Promise<void>,
) {
  await shot(window, `${name}-en`);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 760);
  await zh();
  await shot(window, `${name}-zh-CN`);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
}

/** The data folder as a connection made before the background existed left it: no decision on it. */
function madeBefore() {
  const db = openDatabase(join(dataDir, "incarnamind.db"));
  try {
    db.run("DELETE FROM data_flow_consents WHERE flow = 'hosted-agents'");
  } finally {
    db.close();
  }
}

test("with no model, one press checks a Note the User wrote on their own Claude Code in the background, with nothing opened; Stop stops it; a run that can't start or fails says why; a take-back keeps the link; a connection made before asks once", async () => {
  const { app, window } = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    await setWindowSize(app, window, 1440, 900);
    const { folderId, pairingId } = await connected(window);
    const first = await writeNote(
      window,
      "Harbour notes",
      [
        { text: "The harbour handled 1,240 ship calls in 2025." },
        { text: "Harbour pilots went on strike in July." },
      ],
      { folderId },
    );
    await open(window, first);
    const asked = window.getByTestId("checks-asked");

    // While it runs: the line says so, with Stop beside it, and nothing opens or is copied.
    await nextRun("wait");
    await press(window);
    await expect(asked).toHaveText("Checking this note in Claude Code.");
    await expect(window.getByTestId("checks-asked-stop")).toHaveText("Stop");
    await both(app, window, "background-running", async () => {
      await expect(asked).toHaveText("Claude Code 正在核对这篇笔记。");
      await expect(window.getByTestId("checks-asked-stop")).toHaveText("停止");
    });
    await pointAndClick(window, window.getByTestId("checks-asked-stop"));
    await expect(asked).toHaveCount(0);
    await expect(window.locator('[data-testid="claim-mark"]')).toHaveCount(0);

    // One press, and its marks land on the Note the User wrote.
    await nextRun("check");
    await press(window);
    await expect(window.locator('[data-testid="claim-mark"]')).toHaveCount(2);
    await expect(asked).toHaveCount(0);
    expect(await urlsOpened(app)).toEqual([]);
    expect(await copied(window)).toBe("");

    // A run that can't start, and one that fails, say why, with Check again.
    const second = await writeNote(
      window,
      "Harbour notes, second draft",
      [{ text: "Dredging of the north channel finished in March 2025." }],
      { folderId },
    );
    await open(window, second);
    await nextRun("signed-out");
    await press(window);
    await expect(asked).toHaveText(
      "Claude Code isn’t signed in on this computer. Sign in to it in a terminal, then press Check again.",
    );
    await expect(window.getByTestId("checks-asked-line-ask")).toHaveText("Check again");
    await both(app, window, "background-signed-out", async () => {
      await expect(asked).toHaveText(
        "Claude Code 尚未在这台电脑上登录。在终端中登录后，再点“核对”。",
      );
    });
    await nextRun("limit");
    await pointAndClick(window, window.getByTestId("checks-asked-line-ask"));
    await expect(asked).toHaveText(
      "Claude Code stopped: your Claude plan or API key has reached its limit. Try again later.",
    );
    await both(app, window, "background-plan-limit", async () => {
      await expect(asked).toHaveText(
        "Claude Code 已停止：你的 Claude 订阅或 API 密钥已达用量上限。稍后再试。",
      );
    });

    // Taken back in Settings › Privacy: Check goes by the link, with no dialog.
    await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.revokeConsent("hosted-agents", `agent:${id}`);
    }, pairingId);
    await nextRun("check");
    await pointAndClick(window, window.getByTestId("checks-asked-line-ask"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    // The link opened only once the press was decided: a dialog would have come before it.
    const dialog = window.getByTestId("consent-dialog");
    await expect(dialog).toBeHidden();

    // A connection made before this asks once, in the consent dialog; no keeps the link.
    const third = await writeNote(
      window,
      "Harbour notes, third draft",
      [{ text: "The harbour master retired in 2024." }],
      { folderId },
    );
    await open(window, third);
    madeBefore();
    await press(window);

    await expect(dialog).toContainText(
      "To start your own AI on this computer when you press Check or ask at the bottom of a note",
    );
    await both(app, window, "background-consent", async () => {
      await expect(dialog).toContainText(
        "在你点“核对”或在笔记底部提问时，在这台电脑上启动你自己的 AI",
      );
    });
    await pointAndClick(window, dialog.getByTestId("consent-decline"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(2);

    // Connecting Claude Code says so where the User allows it.
    await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.disconnectAgent(id);
    }, pairingId);
    const settings = await openSettings(window, "ai");
    await (await agentsToConnect(settings))
      .locator('[data-client="claude-code"]')
      .getByTestId("agent-connect")
      .click();
    const sheet = window.getByTestId("connect-agent-dialog");
    await expect(sheet.getByTestId("connect-agent-background")).toHaveText(
      "With no AI model set up here, Check and the box at the bottom of a note run your Claude Code in the background. Nothing opens and no chat is added. It works only through IncarnaMind, and uses your own Claude plan or API key.",
    );
    await both(app, window, "background-connect-sheet", async () => {
      await expect(sheet.getByTestId("connect-agent-background")).toHaveText(
        "没设置 AI 模型时，“核对”和笔记底部的输入框会在后台运行你的 Claude Code，不打开窗口，也不新增对话。它只通过 IncarnaMind 工作，用的是你自己的 Claude 订阅或 API 密钥。",
      );
    });
  } finally {
    await app.close();
  }
});

/** Whether a process with this id is still running. */
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("with no model, a press checks the Note on the User's own Codex in the background; Stop ends it and the server it started; a stopped or failed run says why; a Codex that can't run here keeps the link; connecting it says what it reads", async () => {
  const { app, window } = await launchApp(dataDir, {
    home,
    ownCodex: join(bin, "codex"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    await setWindowSize(app, window, 1440, 900);
    const { folderId, pairingId } = await connected(window, "codex");
    const first = await writeNote(
      window,
      "Harbour notes",
      [
        { text: "The harbour handled 1,240 ship calls in 2025." },
        { text: "Harbour pilots went on strike in July." },
      ],
      { folderId },
    );
    await open(window, first);
    const asked = window.getByTestId("checks-asked");

    // While it runs the line names Codex, with Stop; Stop ends Codex and the server it started.
    await nextRun("wait");
    await press(window);
    await expect(asked).toHaveText("Checking this note in Codex.");
    await expect(window.getByTestId("checks-asked-stop")).toHaveText("Stop");
    await both(app, window, "codex-running", async () => {
      await expect(asked).toHaveText("Codex 正在核对这篇笔记。");
    });
    await expect.poll(() => existsSync(join(bin, "pids"))).toBe(true);
    const pids = (await readFile(join(bin, "pids"), "utf8")).split(" ").map(Number);
    await pointAndClick(window, window.getByTestId("checks-asked-stop"));
    await expect(asked).toHaveCount(0);
    await expect.poll(() => pids.filter(running)).toEqual([]);
    await expect(window.locator('[data-testid="claim-mark"]')).toHaveCount(0);

    // One press, and its marks land; nothing opens and nothing is copied.
    await nextRun("check");
    await press(window);
    await expect(window.locator('[data-testid="claim-mark"]')).toHaveCount(2);
    await expect(asked).toHaveCount(0);
    expect(await urlsOpened(app)).toEqual([]);
    expect(await copied(window)).toBe("");

    // A plan's limit, which Codex names no category for, and a run its watch stopped, say why.
    const second = await writeNote(
      window,
      "Harbour notes, second draft",
      [{ text: "Dredging of the north channel finished in March 2025." }],
      { folderId },
    );
    await open(window, second);
    await nextRun("limit");
    await press(window);
    await expect(asked).toHaveText(
      "Codex stopped before finishing. Check your sign-in and usage in Codex.",
    );
    await both(app, window, "codex-service", async () => {
      await expect(asked).toHaveText("Codex 未完成就停止了。在 Codex 中检查登录状态和用量。");
    });
    await nextRun("outside");
    await pointAndClick(window, window.getByTestId("checks-asked-line-ask"));
    await expect(asked).toHaveText(
      "Codex stopped because it requested an action outside this check. Open the check in Codex.",
    );
    await both(app, window, "codex-outside", async () => {
      await expect(asked).toHaveText(
        "Codex 要执行这次核对以外的操作，已停止。在 Codex 中打开这次核对。",
      );
    });
    // Its one action opens the check in the User's app, by its link.
    await expect(window.getByTestId("checks-asked-line-ask")).toHaveText(
      "Ask ChatGPT app and Codex",
    );
    await pointAndClick(window, window.getByTestId("checks-asked-line-ask"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    expect((await urlsOpened(app))[0]).toMatch(/^codex:\/\/new\?prompt=/);

    // A Codex that can't be held to the check's Tools, or isn't signed in, keeps the link, with no line saying so.
    for (const [mode, opened] of [
      ["extra-tool", 2],
      ["signed-out", 3],
    ] as const) {
      const note = await writeNote(
        window,
        `Harbour notes, ${mode}`,
        [{ text: "The harbour master retired in 2024." }],
        {
          folderId,
        },
      );
      await open(window, note);
      await nextRun(mode);
      await press(window);
      await expect.poll(() => urlsOpened(app)).toHaveLength(opened);
      await expect(asked).not.toContainText("stopped");
    }

    // A connection made before asks once, and says Codex reads the User's own instructions file.
    const older = await writeNote(
      window,
      "Harbour notes, made before",
      [{ text: "The ferry runs hourly." }],
      {
        folderId,
      },
    );
    await open(window, older);
    madeBefore();
    await nextRun("check");
    await press(window);
    const dialog = window.getByTestId("consent-dialog");
    await expect(dialog.getByTestId("consent-codex-note")).toHaveText(
      "In these runs Codex also reads your own instructions file, AGENTS.md in your Codex folder.",
    );
    await both(app, window, "codex-consent", async () => {
      await expect(dialog.getByTestId("consent-codex-note")).toHaveText(
        "这样运行时，Codex 也会读取你自己的说明文件，即 Codex 文件夹里的 AGENTS.md。",
      );
    });
    await pointAndClick(window, dialog.getByTestId("consent-allow"));
    await expect(window.locator('[data-testid="claim-mark"]')).toHaveCount(1);

    // Connecting it says what runs, on what, and what it reads of the User's own.
    await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.disconnectAgent(id);
    }, pairingId);
    const settings = await openSettings(window, "ai");
    await (await agentsToConnect(settings))
      .locator('[data-client="codex"]')
      .getByTestId("agent-connect")
      .click();
    const sheet = window.getByTestId("connect-agent-dialog");
    await expect(sheet.getByTestId("connect-agent-background")).toHaveText(
      "With no AI model set up here, Check runs your Codex command line in the background, if it is installed. Nothing opens and no chat is added. It may use only IncarnaMind, which stops it at anything else. It uses your own ChatGPT plan or API key. In these runs Codex also reads your own instructions file, AGENTS.md in your Codex folder.",
    );
    await both(app, window, "codex-connect-sheet", async () => {
      await expect(sheet.getByTestId("connect-agent-background")).toHaveText(
        "没设置 AI 模型时，如果装了 Codex 命令行，“核对”会在后台运行它，不打开窗口，也不新增对话。它只能使用 IncarnaMind，做其他事会被 IncarnaMind 停下。它用的是你自己的 ChatGPT 订阅或 API 密钥。这样运行时，Codex 也会读取你自己的说明文件，即 Codex 文件夹里的 AGENTS.md。",
      );
    });
  } finally {
    await app.close();
  }
});
