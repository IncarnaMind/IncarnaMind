import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSettings,
  openSteps,
  removeDataFolder,
  showSettingsPage,
  useLocalChatModel,
} from "./app";

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

/** A Skill with one tiny JavaScript script, which greets its first argument. */
async function writeGreeterSkill(): Promise<string> {
  const folder = join(sources, "greeter");
  await mkdir(join(folder, "scripts"), { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: greeter\ndescription: Greets people. Use to say hello.\n---\n\nRun scripts/hello.js with the name.\n",
  );
  await writeFile(
    join(folder, "scripts", "hello.js"),
    'console.log("Hello, " + process.argv[2] + "!");\n',
  );
  return folder;
}

/** Imports a Skill through the core's bridge (e2e/skills.spec.ts covers Settings). */
async function importSkill(window: Page, folder: string): Promise<void> {
  await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const check = await bridge.previewSkillImport(path);
    if (!check.ok) throw new Error(check.error.message);
    await bridge.importSkill(check.preview.importId);
  }, folder);
}

/**
 * How scripts run in this app: "os" in the OS sandbox (macOS; Linux with
 * bubblewrap), "none" elsewhere. The cards and Settings say what they can reach by it.
 */
async function scriptSandbox(window: Page): Promise<string> {
  return window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getSettings()).scriptSandbox;
  });
}

/** Asks a Question in the assistant, beside the Mind. */
async function ask(window: Page, text: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(text);
  await window.keyboard.press("Enter");
}

test("a Skill script asks first with an approval card: Allow once runs it, and the Answer finishes with its output in a card", async () => {
  const folder = await writeGreeterSkill();
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await importSkill(window, folder);

  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await ask(window, "Run greeter scripts/hello.js for Dover");

  // The fake model calls run_skill_script: the Answer waits, showing the Skill, the script and its argument.
  const answer = assistantAnswers(window).first();
  const card = answer.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute("data-kind", "skill-script");
  await expect(card).toContainText("greeter wants to run scripts/hello.js");
  await expect(card.getByTestId("approval-script-skill")).toHaveText("greeter");
  await expect(card.getByTestId("approval-script-path")).toHaveText("scripts/hello.js");
  await expect(card.getByTestId("approval-argument")).toHaveText(["Dover"]);
  // What the script can reach, as it runs here: in the OS sandbox on macOS (and Linux with
  // bubblewrap), with no sandbox elsewhere.
  const sandbox = await scriptSandbox(window);
  if (process.platform === "darwin") expect(sandbox).toBe("os");
  const reach = card.getByTestId("approval-sandbox");
  await expect(reach).toHaveAttribute("data-sandbox", sandbox);
  await expect(reach).toContainText(
    sandbox === "os"
      ? "Runs in a sandbox: no internet, no home folder."
      : "No sandbox: it can read, change or delete your files and use the internet.",
  );
  if (sandbox === "os") {
    const details = reach.getByTestId("approval-sandbox-reach-details");
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await details.click();
    await expect(reach.getByTestId("approval-sandbox-reach-list")).toContainText(
      "It can’t open your home folder or IncarnaMind’s data",
    );
  }
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await expect(answer.getByTestId("answer-writing")).toHaveText("Waiting for your approval");

  // Allow once: it runs (on Electron's own Node), and the Answer finishes with what it printed.
  await card.getByTestId("approval-allow-once").click();
  await expect(card).toHaveCount(0);
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer).toContainText("scripts/hello.js said: Hello, Dover!");
  await expect(answer).toContainText("That is all.");
  const run = (await openSteps(window, answer)).getByTestId("answer-script-call");
  await expect(run).toHaveAttribute("data-status", "done");
  await expect(run).toHaveAttribute("data-approval", "allowed");
  await expect(run).toContainText("Ran scripts/hello.js (greeter): exit code 0");
  await run.getByRole("button").click();
  await expect(run.getByTestId("answer-script-args")).toHaveText("Dover");
  await expect(run.getByTestId("answer-script-stdout")).toHaveText("Hello, Dover!");
  await app.close();
});

test("Always run shows a risk warning first; confirmed, the Skill's scripts run without asking until revoked in Settings, and the switch turns scripts off", async () => {
  const folder = await writeGreeterSkill();
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await importSkill(window, folder);

  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await ask(window, "Run greeter scripts/hello.js for Calais");

  // "Always run" warns first; Cancel goes back to the three choices.
  const first = assistantAnswers(window).first();
  const card = first.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByTestId("approval-always-run").click();
  const warning = card.getByTestId("always-run-warning");
  await expect(warning).toContainText("Always run the scripts of greeter?");
  const sandboxed = (await scriptSandbox(window)) === "os";
  await expect(warning).toContainText(
    sandboxed
      ? "From now on, greeter’s scripts run without asking. They run in a sandbox, but can still read files on other drives."
      : "From now on, greeter’s scripts run without asking. With no sandbox, they can delete your files and send your data online.",
  );
  await expect(warning).toContainText("Only for a Skill you trust. Reset in Settings › Approvals.");
  if (sandboxed) {
    await warning.getByTestId("always-run-reach-details").click();
    await expect(warning.getByTestId("always-run-reach-list")).toContainText(
      "can’t open your home folder or IncarnaMind’s data",
    );
  }
  await warning.getByTestId("always-run-cancel").click();
  await expect(warning).toHaveCount(0);
  await expect(card.getByTestId("approval-allow-once")).toBeVisible();
  await card.getByTestId("approval-always-run").click();
  await card.getByTestId("always-run-confirm").click();
  await expect(first).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(first).toContainText("scripts/hello.js said: Hello, Calais!");

  // The next run doesn't ask.
  await ask(window, "Run greeter scripts/hello.js for Dover");
  const second = assistantAnswers(window).nth(1);
  await expect(second).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(second).toContainText("scripts/hello.js said: Hello, Dover!");
  await expect(second.getByTestId("approval-card")).toHaveCount(0);

  // Settings: the policy is listed under Tools and can be revoked; the switch, under
  // Skills, is on.
  await openSettings(window, "privacy");
  const policy = window.getByTestId("approvals-settings").getByTestId("approval-policy");
  await expect(policy).toHaveCount(1);
  await expect(policy).toContainText("Scripts of greeter");
  await expect(policy.getByTestId("approval-policy-value")).toHaveText("Always run");
  await policy.getByRole("button", { name: "Reset Scripts of greeter to its default" }).click();
  await expect(policy).toHaveCount(0);
  await showSettingsPage(window, "skills");
  const scripts = window.getByTestId("skill-scripts-settings");
  const toggle = scripts.getByTestId("skill-scripts-enabled");
  await expect(toggle).toBeChecked();
  await expect(scripts.getByTestId("skill-scripts-timeout")).toHaveValue("60");
  await expect(scripts.getByTestId("skill-scripts-sandbox")).toContainText(
    sandboxed
      ? "Scripts run in a sandbox and ask before each run."
      : "No sandbox: scripts run here and ask before each run.",
  );
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await closeSettings(window);

  // Off: the script isn't offered, so the Answer is written without running it.
  await ask(window, "Run greeter scripts/hello.js for Brest");
  const third = assistantAnswers(window).nth(2);
  await expect(third).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(third).not.toContainText("said:");
  await expect((await openSteps(window, third)).getByTestId("answer-script-call")).toHaveCount(0);
  await app.close();
});
