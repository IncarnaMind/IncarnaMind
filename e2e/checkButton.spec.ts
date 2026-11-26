import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { ALL_SHARED_ID, type CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  checkCard,
  closeSettings,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  motionSettled,
  newMind,
  noteCheck,
  noteCheckOnLine,
  openExample,
  openSettings,
  pointAndClick,
  removeDataFolder,
  saveProviderUnasked,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  slideSelect,
  tokenColor,
  writeNote,
} from "./app";
import { holdModel, modelHeld } from "./heldModel";

/*
 * The check on a Note is one button in the Note's row of controls (#3794): the word Check and the
 * number of sentences not checked yet, the one dark button there while they wait; one press checks,
 * with no card first; while it runs, how far it has got, with Stop; then "2 need a look" in the
 * warning colour, which opens the card of results, or "Checked", quietly. Where the User's own AI
 * has just written into the Note, the same Check stands on the line above the input, beside Undo.
 * When the row runs out of room Export loses its word first and Check keeps its mark and number; it
 * never goes into the ⋯ menu. A check that can't run yet says why from the same button, with the
 * way to fix it. The scripted model (src/main/fakeChat/checks.ts) finds a sentence supported when
 * it shares three words with a line of a Document, and otherwise unsupported. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save full-window captures, light and dark.
 */

const TIDES = buildPdf([
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);
const UNSUPPORTED = ["Penguins nest on the harbour cliffs.", "Whales sing in the deep bay."];
const SUPPORTED = [
  "Spring tides happen at new and full moon.",
  "Harbours publish the times of high water every 12 months.",
];

const WORDS = {
  en: {
    check: "Check",
    running: /^Checking… \d of 2$/,
    checking: "Checking…",
    look: "2 need a look",
    checked: "Checked",
    stop: "Stop",
    needsAi: "Checking needs your AI",
    connect: "Connect your AI",
    summary: "Write a summary of the ferry interviews",
  },
  "zh-CN": {
    check: "核对",
    running: /^正在核对 \d\/2…$/,
    checking: "正在核对…",
    look: "需要留意 2 处",
    checked: "已核对",
    stop: "停止",
    needsAi: "核对需要连接你的 AI",
    connect: "连接你的 AI",
    summary: "写一份渡轮访谈的总结",
  },
} as const;

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const SIZES = [
  [1440, 900],
  [900, 900],
] as const;

/** Saves the whole window, light and dark, when INCARNAMIND_SCREENSHOTS names a folder for it. */
async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  // The pointer off the controls, so no hover is captured as their look.
  const size = window.viewportSize();
  if (size) await window.mouse.move(size.width / 2, size.height - 120);
  for (const appearance of ["light", "dark"] as const) {
    await window.evaluate(
      (theme) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          device: { appearance: theme },
        }),
      appearance,
    );
    await expect(window.locator("html")).toHaveAttribute("data-theme", appearance);
    await motionSettled(window);
    await window.screenshot({
      path: join(folder, `${name}-${appearance}.png`),
      animations: "disabled",
    });
  }
}

/** Each size in turn, with `check` and a capture at each, then back to the first. */
async function atEachSize(
  app: ElectronApplication,
  window: Page,
  name: string,
  check: () => Promise<void>,
) {
  for (const [width, height] of SIZES) {
    await setWindowSize(app, window, width, height);
    await motionSettled(window);
    await check();
    await shot(window, `${name}-${width}`);
  }
  await setWindowSize(app, window, SIZES[0][0], SIZES[0][1]);
}

/** The tab strip of the group in front. */
const frontStrip = (window: Page) =>
  window.locator('[data-testid="tab-group"][data-focused] [data-testid="tab-strip"]');

/** The buttons of the strip in front drawn in the app's primary ink: the dark ones. */
const darkButtons = (window: Page) =>
  frontStrip(window).evaluate((strip) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--color-ink)";
    document.body.append(probe);
    const ink = getComputedStyle(probe).color;
    probe.remove();
    return [...strip.querySelectorAll("button")]
      .filter((button) => button.getClientRects().length > 0)
      .filter((button) => getComputedStyle(button).backgroundColor === ink)
      .map((button) => button.getAttribute("data-testid") ?? "");
  });

/** Whether a press at the middle of `target` reaches it, with nothing over it. */
const hittable = (target: Locator) =>
  target.evaluate((element) => {
    const at = element.getBoundingClientRect();
    return element.contains(
      document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2),
    );
  });

/** A new Note with these sentences, typed as a person types them. */
async function noteOf(window: Page, sentences: readonly string[]) {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  await window.keyboard.type(sentences.join(" "));
  await expect(editor).toContainText(sentences.at(-1) ?? "");
}

async function launchWithTides(language: "en" | "zh-CN") {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const running = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(running.window);
  await connectLocalChatModel(running.window);
  await setLanguage(running.window, language);
  await addDocuments(running.window, [join(sources, "Tides.pdf")]);
  await setWindowSize(running.app, running.window, SIZES[0][0], SIZES[0][1]);
  return running;
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  // protects=#3794: a Note's check is one labelled button that checks in one press, the one dark button of its row while sentences wait, with its run's progress and Stop, then what it found; fails_when=the control has no word, a press opens a card first, another control in the row is as dark, or the result isn't said on the button
  test(`Check 2 is the one dark button; one press checks with no card, says how far it has got with Stop, then 2 need a look opens the results; a Note the Documents hold reads Checked (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchWithTides(language);
    try {
      await noteOf(window, UNSUPPORTED);
      const button = noteCheck(window);
      const card = window.getByTestId("check-card");
      await atEachSize(app, window, `check-${language}`, async () => {
        await expect(button).toHaveAttribute("data-state", "check");
        await expect(button.locator(".note-check-words")).toHaveText(words.check);
        await expect(button.locator(".note-check-count")).toHaveText("2");
        await expect(button).toHaveAccessibleName(`${words.check} 2`);
        expect(await darkButtons(window)).toEqual(["note-check"]);
        expect(await hittable(button)).toBe(true);
      });

      // One press: no card first, the run's progress on the button, and Stop beside it.
      await holdModel(app, "hold", true);
      await pointAndClick(window, button);
      await expect.poll(() => modelHeld(app)).toBe(true);
      await expect(button).toHaveAttribute("data-state", "checking");
      await expect(card).toHaveCount(0);
      const stop = frontStrip(window).getByTestId("note-check-stop");
      await expect(stop).toHaveAccessibleName(words.stop);
      await atEachSize(app, window, `checking-${language}`, async () => {
        await expect(button.locator(".note-check-words")).toHaveText(words.running);
        await expect(card).toHaveCount(0);
        expect(await hittable(stop)).toBe(true);
      });

      // Stop stops it; the button is Check again, its sentences still waiting.
      await pointAndClick(window, stop);
      await expect(stop).toHaveCount(0);
      await holdModel(app, "hold", false);
      await expect(button).toHaveAttribute("data-state", "check");
      await expect(
        window.getByTestId("claim-mark").and(window.locator('[data-check="checking"]')),
      ).toHaveCount(0);

      // A whole run: what needs a look, in the warning colour, opening the card of results.
      await pointAndClick(window, button);
      await expect(button).toHaveAttribute("data-state", "look", { timeout: 30_000 });
      await expect(card).toHaveCount(0);
      const warning = await tokenColor(window, "--color-warning");
      await atEachSize(app, window, `look-${language}`, async () => {
        await expect(button.locator(".note-check-words")).toHaveText(words.look);
        expect(await button.evaluate((element) => getComputedStyle(element).color)).toBe(warning);
        expect(await darkButtons(window)).toEqual([]);
      });
      await pointAndClick(window, button);
      await expect(card).toBeVisible();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(card.getByTestId("health-look")).toHaveAttribute("data-count", "2");
      // The card has no Check of its own: the button is the one way in.
      await expect(card.getByRole("button", { name: words.check, exact: true })).toHaveCount(0);
      await atEachSize(app, window, `look-card-${language}`, async () => {
        await expect(card).toBeVisible();
      });
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);

      // Sentences the Document holds: Checked, quietly, its press opening the card too.
      await noteOf(window, SUPPORTED);
      await expect(button).toHaveAttribute("data-state", "check");
      await expect(button.locator(".note-check-count")).toHaveText("2");
      await pointAndClick(window, button);
      await expect(button).toHaveAttribute("data-state", "checked", { timeout: 30_000 });
      await atEachSize(app, window, `checked-${language}`, async () => {
        await expect(button.locator(".note-check-words")).toHaveText(words.checked);
        expect(await darkButtons(window)).toEqual([]);
      });
      await pointAndClick(window, button);
      await expect(card).toBeVisible();
      await expect(card.getByTestId("health-all-checked")).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // protects=#3794: in a row short of room the other controls give way first, Export losing its word before Check loses its, and the Check never leaves the row for the ⋯ menu; fails_when=Check loses its word while Export keeps its, Check is clipped or covered, or it can only be reached from ⋯
  test(`a row short of room takes Export's word first, at 900 wide, then Check keeps its mark and number in a narrow group, never in the ⋯ (${language})`, async () => {
    test.setTimeout(300_000);
    const { app, window } = await launchWithTides(language);
    try {
      // The narrowest window the app has: other Notes in the group first, so its strip is full.
      await setWindowSize(app, window, 900, 900);
      for (let other = 0; other < 5; other++) await newMind(window);
      await noteOf(window, UNSUPPORTED);
      const button = noteCheck(window);
      const exportWord = frontStrip(window).locator('[data-testid="export-mind"] > span');
      await expect(button).toHaveAttribute("data-state", "check");
      // Export's word goes; Check keeps its word and number, whole and in the row.
      await expect(exportWord).toBeHidden();
      await expect(button.locator(".note-check-words")).toHaveText(words.check);
      await expect.poll(() => wordDrawn(button)).toBe(true);
      expect(await hittable(button)).toBe(true);
      await shot(window, `tight-full-strip-${language}-900`);

      // A comment on the Note puts a control in its row that never leaves it; its author is named
      // first, in Settings as the helper finds it in English.
      await setLanguage(window, "en");
      const settings = await openSettings(window, "general");
      const author = settings.getByTestId("author-name");
      await author.fill("Mira Okafor");
      await author.press("Enter");
      await closeSettings(window);
      await setLanguage(window, language);
      await slideSelect(
        window,
        window.getByTestId("mind-editor").locator("p").first(),
        "Penguins nest",
      );
      await pointAndClick(window, window.getByTestId("selection-comment"));
      await window.keyboard.type("Ask the ranger.");
      await pointAndClick(window, window.getByTestId("comment-save"));
      await expect(frontStrip(window).getByTestId("comments-count")).toBeVisible();

      // The Note's group at its least width beside another, in a wide window: short still,
      // Check gives up its word, kept for a screen reader, and keeps its mark and number.
      await setWindowSize(app, window, 1440, 900);
      await window.keyboard.press("Escape");
      await window.keyboard.press("ControlOrMeta+Alt+Backslash");
      const groups = window.getByTestId("tab-group");
      await expect(groups).toHaveCount(2);
      const divider = window.getByTestId("group-divider").first();
      await divider.focus();
      for (let press = 0; press < 60; press++) await window.keyboard.press("Shift+ArrowRight");
      await expect
        .poll(() => divider.getAttribute("aria-valuenow"))
        .toBe(await divider.getAttribute("aria-valuemax"));
      // A second Note in the narrow group, back behind the Note: its tab folds into the strip's ⌄,
      // so the row is short of room whichever language names the Check.
      const strip = groups.last().getByTestId("tab-strip");
      await pointAndClick(window, strip.getByTestId("new-tab"));
      await expect(noteCheck(groups.last())).toHaveCount(0);
      await motionSettled(window);
      await window.keyboard.press("Control+Shift+Tab");
      await motionSettled(window);
      const narrow = noteCheck(groups.last());
      await expect(narrow).toHaveAttribute("data-state", "check");
      const holds = async () => {
        await expect(strip).toHaveAttribute("data-check-compact", "");
        // Export lost its word first; the Check is still in the row, never in the ⋯ menu.
        await expect(strip.locator('[data-testid="export-mind"] > span')).toBeHidden();
        expect(await wordDrawn(narrow)).toBe(false);
        expect(await hittable(narrow)).toBe(true);
        expect(await insideOf(narrow, strip)).toBe(true);
        expect(await hittable(strip.getByTestId("page-menu"))).toBe(true);
      };
      await holds();
      await expect(narrow.locator(".note-check-count")).toBeVisible();
      await expect(narrow).toHaveAccessibleName(`${words.check} 2`);
      await shot(window, `tight-least-${language}-1440`);
      // While it runs: its mark and Stop stay in the row.
      await holdModel(app, "hold", true);
      await pointAndClick(window, narrow);
      await expect.poll(() => modelHeld(app)).toBe(true);
      await expect(narrow).toHaveAttribute("data-state", "checking");
      await holds();
      const stop = strip.getByTestId("note-check-stop");
      expect(await hittable(stop)).toBe(true);
      expect(await insideOf(stop, strip)).toBe(true);
      await shot(window, `tight-running-${language}-1440`);
      await holdModel(app, "hold", false);
      await expect(narrow).toHaveAttribute("data-state", "look", { timeout: 30_000 });
      await holds();
      await expect(narrow.locator(".note-check-short")).toHaveText("2");
    } finally {
      await app.close();
    }
  });

  // protects=#3794: with no AI connected, the same button says why the check can't run, in plain words, with the way to fix it, from the button itself; fails_when=the press does nothing, says nothing, or the line has no action
  test(`with no AI connected, Check says from the same button that checking needs the User's AI, with Connect your AI (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await writeFile(join(sources, "Tides.pdf"), TIDES);
      await addDocuments(window, [join(sources, "Tides.pdf")]);
      await setWindowSize(app, window, SIZES[0][0], SIZES[0][1]);
      await noteOf(window, UNSUPPORTED);
      const button = noteCheck(window);
      await expect(button).toHaveAttribute("data-state", "check");
      await pointAndClick(window, button);
      const card = window.getByTestId("check-card");
      const problem = card.getByTestId("checks-problem");
      await expect(problem).toContainText(words.needsAi);
      await expect(problem.getByTestId("checks-connect-ai")).toHaveText(words.connect);
      await atEachSize(app, window, `no-ai-${language}`, async () => {
        await expect(problem).toBeVisible();
        // It hangs from the button that was pressed.
        const from = await button.boundingBox();
        const box = await card.boundingBox();
        if (!from || !box) throw new Error("The button or its card isn't drawn.");
        expect(box.y).toBeGreaterThanOrEqual(from.y + from.height);
        expect(Math.abs(box.x + box.width - (from.x + from.width))).toBeLessThan(40);
      });
      // Pressed again, it checks again and says the same: nothing runs without an AI.
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await pointAndClick(window, button);
      await expect(problem).toContainText(words.needsAi);
      await pointAndClick(window, problem.getByTestId("checks-connect-ai"));
      await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "ai");
    } finally {
      await app.close();
    }
  });

  // protects=#3794: a check whose service the User declined says so from the button, with the way to allow it; fails_when=the press sends the Note's text unasked, or ends with no line
  test(`a check the User hasn't allowed to send says why from the same button, with the way to allow it (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await saveProviderUnasked(window, {
        kind: "anthropic",
        apiKey: "sk-ant-made-up",
        modelId: "claude-haiku-5-5",
      });
      await writeFile(join(sources, "Tides.pdf"), TIDES);
      await addDocuments(window, [join(sources, "Tides.pdf")]);
      await setWindowSize(app, window, SIZES[0][0], SIZES[0][1]);
      await noteOf(window, UNSUPPORTED);
      const button = noteCheck(window);
      await pointAndClick(window, button);
      // Nothing is sent: the User says no where the service is asked for.
      const consent = window.getByTestId("consent-dialog");
      await expect(consent).toBeVisible();
      await pointAndClick(window, consent.getByTestId("consent-decline"));
      await expect(consent).toBeHidden();
      const card = window.getByTestId("check-card");
      const problem = card.getByTestId("checks-problem");
      await expect(problem).toBeVisible({ timeout: 15_000 });
      await expect(problem.getByRole("button").first()).toBeVisible();
      await atEachSize(app, window, `declined-${language}`, async () => {
        await expect(problem).toBeVisible();
      });
      await expect(window.getByTestId("claim-mark")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  // protects=#3794 on the example a new User lands in with no AI app and no model: the labelled Check is in the Note's row from the moment the example opens, and its one press says why it can't check, with the way to connect an AI; fails_when=the example opens with no Check, or its press does nothing or says nothing
  test(`on the example with no AI, the Check is in the Note's row from the start, and its press says checking needs the User's AI (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true });
    try {
      await setLanguage(window, language);
      await setWindowSize(app, window, SIZES[0][0], SIZES[0][1]);
      await openExample(window);
      await expect(window.getByTestId("claim-mark")).toHaveCount(1, { timeout: 30_000 });
      const button = noteCheck(window);
      await atEachSize(app, window, `example-no-ai-${language}`, async () => {
        await expect(button).toHaveAttribute("data-state", "check");
        await expect(button.locator(".note-check-words")).toHaveText(words.check);
        expect(await wordDrawn(button)).toBe(true);
        expect(await darkButtons(window)).toEqual(["note-check"]);
        // The example's foot says how to ask, with no input to show.
        await expect(window.getByTestId("example-line")).toBeVisible();
        await expect(window.getByTestId("note-ask-no-ai")).toBeVisible();
      });
      await pointAndClick(window, button);
      const problem = window.getByTestId("check-card").getByTestId("checks-problem");
      await expect(problem).toContainText(words.needsAi);
      await expect(problem.getByTestId("checks-connect-ai")).toHaveText(words.connect);
      await expect(window.getByTestId("claim-mark")).toHaveCount(1);
      // Connecting an AI is the card's lead: the correction it offers beside it is not filled.
      const correct = window.getByTestId("check-card").getByTestId("badge-correct-contradictions");
      await expect(correct).toBeVisible();
      expect(
        await correct.evaluate((element) => getComputedStyle(element).backgroundColor),
      ).not.toBe(await tokenColor(window, "--color-ink"));
      await shot(window, `example-no-ai-card-${language}-1440`);
    } finally {
      await app.close();
    }
  });
}

/** Whether the button's word is drawn, not only kept for a screen reader. */
const wordDrawn = (button: Locator) =>
  button
    .locator(".note-check-words")
    .evaluate((element) => element.getBoundingClientRect().width > 1);

/** Whether `inner` lies whole inside `outer`. */
const insideOf = async (inner: Locator, outer: Locator) => {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (!a || !b) return false;
  return a.x >= b.x - 0.5 && a.x + a.width <= b.x + b.width + 0.5;
};

/** "Kestrel Bay" with its interviews, and Claude Code connected to it, allowed to propose changes. */
async function connected(window: Page, home: string): Promise<string> {
  const report = join(home, "Ferry interviews.md");
  await writeFile(
    report,
    "# Ferry interviews\n\nRiders say the 07:40 crossing from Kestrel Bay leaves late most weeks.\n",
  );
  const folderId = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Kestrel Bay", description: "" });
    await bridge.addDocuments([path], { groupId: folder.id });
    await bridge.setAgentsEnabled(true);
    await bridge.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
      propose: true,
    });
    return folder.id;
  }, report);
  await expectReadyDocuments(window, 1);
  return folderId;
}

test.describe("with the User's own AI", () => {
  test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");
  test.skip(
    process.platform === "win32",
    "The stand-in for Claude Code starts from a shell script.",
  );

  let home: string;
  let bin: string;
  test.beforeEach(async () => {
    home = await realpath(await createDataFolder());
    bin = await realpath(await createDataFolder());
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
    );
    await chmod(join(bin, "claude"), 0o755);
  });
  test.afterEach(async () => {
    for (const folder of [home, bin]) await removeDataFolder(folder);
  });

  for (const language of ["en", "zh-CN"] as const) {
    const words = WORDS[language];

    // protects=#3794: where the User's own AI just wrote into the Note, the same dark Check stands on the line above the input, beside Undo, checks in one press there, says how far it has got with Stop, and then what it found, whose card opens from there; fails_when=the line has no Check, it is not the strip's own, a press there does nothing, or its card opens elsewhere
    test(`after the User's AI writes into the Note, the same Check stands beside Undo above the input, checks there, and its card opens from there (${language})`, async () => {
      test.setTimeout(180_000);
      const nextRun = (mode: "summary" | "wait" | "check") => writeFile(join(bin, "mode"), mode);
      const { app, window } = await launchApp(dataDir, {
        home,
        ownAi: join(bin, "claude"),
        extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
      });
      try {
        await acceptPlainTextKeys(window);
        await dismissChatSetup(window);
        await setLanguage(window, language);
        await setWindowSize(app, window, SIZES[0][0], SIZES[0][1]);
        const folderId = await connected(window, home);
        const mindId = await writeNote(
          window,
          "Ferry notes",
          [{ heading: "Ferry notes", level: 1 }],
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
        // Nothing to check yet: no button.
        await expect(noteCheck(window)).toHaveCount(0);

        // The AI writes two sentences into the Note.
        await nextRun("summary");
        const input = window.getByTestId("note-ask-input");
        await pointAndClick(window, input);
        await window.keyboard.insertText(words.summary);
        await window.keyboard.press("Enter");
        const pill = window.getByTestId("note-ask-pill");
        await expect(pill).toHaveAttribute("data-state", "landed", { timeout: 30_000 });
        const undo = pill.getByTestId("note-ask-undo");
        await expect(undo).toBeVisible();
        const undoAt = await undo.boundingBox();
        const onLine = noteCheckOnLine(window);
        const inStrip = noteCheck(window);
        // The Check comes once the sentences are counted, never moving Undo from under the pointer.
        await expect(onLine).toHaveAttribute("data-state", "check");
        expect((await undo.boundingBox())?.x ?? 0).toBeCloseTo(undoAt?.x ?? 0, 0);
        await atEachSize(app, window, `line-check-${language}`, async () => {
          // The same dark Check, on the line beside Undo, as in the strip.
          for (const each of [onLine, inStrip]) {
            await expect(each).toHaveAttribute("data-state", "check");
            await expect(each.locator(".note-check-count")).toHaveText("2");
            await expect(each.locator(".note-check-words")).toHaveText(words.check);
          }
          const ink = await tokenColor(window, "--color-ink");
          expect(
            await onLine.evaluate((element) => getComputedStyle(element).backgroundColor),
          ).toBe(ink);
          const a = await undo.boundingBox();
          const b = await onLine.boundingBox();
          if (!a || !b) throw new Error("Undo or the line's Check isn't drawn.");
          // In one row, the Check just before Undo.
          expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThan(4);
          expect(b.x + b.width).toBeLessThan(a.x);
          expect(await hittable(onLine)).toBe(true);
        });

        // One press on the line checks, with no card first: it says so, with Stop, there and above.
        await nextRun("wait");
        await pointAndClick(window, onLine);
        await expect(onLine).toHaveAttribute("data-state", "checking");
        await expect(inStrip).toHaveAttribute("data-state", "checking");
        await expect(window.getByTestId("check-card")).toHaveCount(0);
        const lineStop = window.getByTestId("note-check-line").getByTestId("note-check-stop");
        await expect(lineStop).toHaveAccessibleName(words.stop);
        await atEachSize(app, window, `line-checking-${language}`, async () => {
          expect(await hittable(lineStop)).toBe(true);
        });
        await pointAndClick(window, lineStop);
        await expect(onLine).toHaveAttribute("data-state", "check");

        // Checked: what it found, on the line, and its card opens from there.
        await nextRun("check");
        await pointAndClick(window, onLine);
        await expect(onLine).toHaveAttribute("data-state", "look", { timeout: 30_000 });
        await expect(inStrip).toHaveAttribute("data-state", "look");
        await expect(onLine.locator(".note-check-words")).toHaveText(words.look);
        await expect(undo).toBeVisible();
        await atEachSize(app, window, `line-look-${language}`, async () => {
          expect(await hittable(onLine)).toBe(true);
        });
        await pointAndClick(window, onLine);
        const card = window.getByTestId("check-card");
        await expect(card).toBeVisible();
        await expect(onLine).toHaveAttribute("aria-expanded", "true");
        const from = await onLine.boundingBox();
        const box = await card.boundingBox();
        if (!from || !box) throw new Error("The line's Check or its card isn't drawn.");
        expect(box.y + box.height).toBeLessThanOrEqual(from.y + 0.5);
        await shot(window, `line-look-card-${language}-1440`);
        // Pressed in the strip, the card opens there instead.
        await pointAndClick(window, inStrip);
        await expect(card).toBeVisible();
        const top = await card.boundingBox();
        const above = await inStrip.boundingBox();
        if (!top || !above) throw new Error("The strip's Check or its card isn't drawn.");
        expect(top.y).toBeGreaterThanOrEqual(above.y + above.height);
        await expect(checkCard(window)).resolves.toBeTruthy();
      } finally {
        await app.close();
      }
    });

    // protects=#3794 on the example a new User lands in: with their own AI connected and nothing asked or added yet, the example's Check is the labelled one dark button of the Note's row from the moment it opens, over the example's line and its input; one press checks with no card first, and while it runs the button says so in words, with Stop; fails_when=the example's Check waits for a first request, has no word, another control in the row is as dark, its press opens a card instead of checking, or a run shows no words
    test(`on the example, the Check is the one dark labelled button of the Note's row from the start, over the example's line and its input, and checks in one press (${language})`, async () => {
      test.setTimeout(180_000);
      const { app, window } = await launchApp(dataDir, {
        home,
        ownAi: join(bin, "claude"),
        examples: true,
        extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
      });
      try {
        await acceptPlainTextKeys(window);
        await dismissChatSetup(window);
        await setLanguage(window, language);
        await setWindowSize(app, window, SIZES[0][0], SIZES[0][1]);
        // Claude Code connected to everything, with no file of the User's own and nothing asked.
        await window.evaluate(async (all) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await bridge.setAgentsEnabled(true);
          await bridge.connectAgent({
            name: "Claude Code",
            client: "claude-code",
            folderIds: [all],
          });
        }, ALL_SHARED_ID);
        await openExample(window);
        const button = noteCheck(window);
        await atEachSize(app, window, `example-${language}`, async () => {
          await expect(button).toHaveAttribute("data-state", "check");
          await expect(button.locator(".note-check-words")).toHaveText(words.check);
          await expect(button.locator(".note-check-count")).toHaveText(/^[1-9]\d*$/);
          expect(await wordDrawn(button)).toBe(true);
          expect(await hittable(button)).toBe(true);
          expect(await darkButtons(window)).toEqual(["note-check"]);
          await expect(window.getByTestId("example-line")).toBeVisible();
          await expect(window.getByTestId("note-ask-input")).toBeVisible();
        });
        await writeFile(join(bin, "mode"), "wait");
        await pointAndClick(window, button);
        await expect(button).toHaveAttribute("data-state", "checking");
        await expect(window.getByTestId("check-card")).toHaveCount(0);
        await atEachSize(app, window, `example-checking-${language}`, async () => {
          await expect(button.locator(".note-check-words")).toHaveText(words.checking);
          expect(await wordDrawn(button)).toBe(true);
          expect(await hittable(window.getByTestId("note-check-stop"))).toBe(true);
          await expect(window.getByTestId("check-card")).toHaveCount(0);
        });
        await pointAndClick(window, window.getByTestId("note-check-stop"));
        await expect(button).toHaveAttribute("data-state", "check");
      } finally {
        await app.close();
      }
    });
  }
});
