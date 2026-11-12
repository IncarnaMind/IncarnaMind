import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  checkCard,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  cutALineAtFoot,
  dismissChatSetup,
  expectEstimateTip,
  focusSettled,
  footFadeOf,
  interceptOpenExternal,
  launchApp,
  mindWrittenBefore,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  slideSelect,
  urlsOpened,
} from "./app";

/*
 * One Check (#1941): "Check" (⌘K, the Note's menu, the badge's card) checks
 * everything a Note can be checked for in one run, then runs again to check
 * what changed. The scripted model
 * (src/main/fakeChat/claims.ts) names every sentence a claim but questions,
 * thanks and "we think"; a claim sharing three words with a line of the
 * Tides PDF is supported, or contradicted when it has a number the line
 * doesn't; any other is unsupported. Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};
const screenshotOf = async (locator: Locator, name: string) => {
  if (!SCREENSHOTS) return;
  await locator.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

/** Whether the button's box sits inside the card's, as a clipped one would not. */
const inside = async (inner: Locator, outer: Locator) => {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (!a || !b) return false;
  return (
    a.x >= b.x - 1 &&
    a.y >= b.y - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y + a.height <= b.y + b.height + 1
  );
};

const TIDES = buildPdf([
  {
    lines: [
      "Harbour times",
      "Harbours publish the times of high water every 12 months.",
      "Spring tides come at new moon and at full moon.",
      "Neap tides come at the first and last quarter moons.",
      "The harbour office opens at nine in the morning.",
    ],
  },
]);

/** Fifteen claims, three questions and two opinions: twenty sentences. */
const CLAIMS = [
  "Harbours publish the times of high water every 6 months.",
  "Spring tides come at new moon and at full moon.",
  "Neap tides come at the first and last quarter moons.",
  "The harbour office opens at nine in the morning.",
  "Penguins nest on the cliffs above the harbour.",
  "The ferry to the island leaves twice a day.",
  "Fishing boats land their catch before dawn.",
  "The lighthouse was built in 1867.",
  "The pier is closed to cars in summer.",
  "Two cranes unload the cargo ships.",
  "The harbour master keeps a log of every arrival.",
  "Storm warnings are posted at the harbour office.",
  "The sea wall was raised after the 1953 flood.",
  "Pilots guide large ships into the channel.",
  "The marina has berths for sixty yachts.",
];
const QUESTIONS = [
  "Does high water come at noon on Sundays?",
  "Who looks after the lighthouse now?",
  "Can visitors walk on the sea wall?",
];
const OPINIONS = [
  "We think the harbour is at its best in spring.",
  "I believe the new marina was worth building.",
];

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

/** The Mind of twenty sentences under a heading, opened. */
async function harbourNotes(window: Page) {
  await mindWrittenBefore(window, "Harbour notes", [
    { heading: "The harbour" },
    { note: `${CLAIMS.slice(0, 5).join(" ")} ${QUESTIONS[0]} ${OPINIONS[0]}` },
    { heading: "Ships and boats" },
    { note: `${CLAIMS.slice(5, 10).join(" ")} ${QUESTIONS[1]}` },
    { note: `${CLAIMS.slice(10).join(" ")} ${QUESTIONS[2]} ${OPINIONS[1]}` },
  ]);
  await window.getByTestId("mind-list-item").filter({ hasText: "Harbour notes" }).click();
  await expect(window.getByTestId("mind-editor")).toContainText(CLAIMS[0] ?? "");
}

const marks = (window: Page) => window.getByTestId("claim-mark");

/**
 * Every one of the Note's `claims` marked and none still being checked; with `card` (the default),
 * the check card open and showing no progress too.
 */
const mindCheckFinished = (window: Page, claims: number, { card = true } = {}) =>
  window.waitForFunction(
    ({ count, withCard }) => {
      const open = document.querySelector('[data-testid="check-card"]');
      const marks = document.querySelectorAll('[data-testid="claim-mark"]');
      return (
        (open !== null || !withCard) &&
        marks.length === count &&
        [...marks].every((mark) => mark.getAttribute("data-check") !== "checking") &&
        open?.querySelector('[data-testid="card-progress"]') == null
      );
    },
    { count: claims, withCard: card },
  );

for (const language of ["en", "zh-CN"] as const) {
  test(`a temporarily unavailable check says the problem in one line and Try again does it (${language})`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 900, 800);
      await addDocuments(window, [join(sources, "Tides.pdf")]);
      await mindWrittenBefore(window, "Tide note", [
        { note: "Spring tides come at new moon and at full moon." },
      ]);
      await window.getByTestId("mind-list-item").filter({ hasText: "Tide note" }).click();
      await app.evaluate(({ ipcMain }) => {
        const channel = "core:planMindCheck";
        const handlers = (
          ipcMain as unknown as {
            _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
          }
        )._invokeHandlers;
        const original = handlers.get(channel);
        if (!original) throw new Error("The check handler is unavailable.");
        let fail = true;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, ...args) => {
          if (fail) {
            fail = false;
            throw new Error("Checking is temporarily unavailable.");
          }
          return original(event, ...args);
        });
      });
      await runCommand(window, "mind.check", translate(language, "mindCheck.command"));
      const problem = window.getByTestId("checks-problem");
      await expect(problem).toContainText(translate(language, "checks.problem.failed"));
      await problem.getByTestId("checks-problem-details").click();
      await expect(problem.getByTestId("checks-problem-details-text")).toContainText(
        "Checking is temporarily unavailable",
      );
      const retry = problem.getByTestId("checks-try-again");
      for (const width of [900, 1600]) {
        await setWindowSize(app, window, width, 800);
        await expect(retry).toBeVisible();
        const box = await retry.boundingBox();
        if (!box) throw new Error("Retry is not drawn.");
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await screenshot(window, `check-failed-${language}-${width}`);
      }
      await retry.focus();
      await window.keyboard.press("Enter");
      await expect(problem).toHaveCount(0);
      await expect(marks(window)).toHaveAttribute("data-check", "supported");
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a sentence the model says nothing of is counted as one it couldn't tell is a claim and stays to check; the next Check asks about it (${language})`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      // The scripted model says nothing of the last sentence it is shown when it names the claims.
      await connectLocalChatModel(window, "fake-model-claims-undecided");
      await setLanguage(window, language);
      await setWindowSize(app, window, 900, 800);
      await addDocuments(window, [join(sources, "Tides.pdf")]);
      await mindWrittenBefore(window, "Tide note", [
        { note: `${CLAIMS[1]} ${CLAIMS[2]} ${CLAIMS[4]}` },
      ]);
      await window.getByTestId("mind-list-item").filter({ hasText: "Tide note" }).click();
      await runCommand(window, "mind.check", translate(language, "mindCheck.command"));
      const card = await checkCard(window, window, { stopTimeout: 120_000 });
      await mindCheckFinished(window, 2);
      const checked = card.getByTestId("health-checked-all");
      await expect(checked).toContainText(
        language === "en"
          ? "Couldn’t tell whether 1 sentence needs checking"
          : "1 句未能判断是否需要核对",
      );
      // Named on this line with no action of its own (#2313), and counted under not checked, so
      // the rows add up to the sentences (#2831): the card's own Check runs the check again.
      await expect(checked.getByRole("button")).toHaveCount(0);
      await expect(card.getByTestId("health-toCheck")).toContainText(
        language === "en" ? "1 not checked" : "1 句未核对",
      );
      for (const width of [900, 1600]) {
        await setWindowSize(app, window, width, 800);
        await expect(checked).toBeVisible();
        const line = await checked.boundingBox();
        const shown = await card.boundingBox();
        if (!line || !shown) throw new Error("The card's result line isn't drawn.");
        expect(line.x).toBeGreaterThanOrEqual(shown.x);
        expect(line.x + line.width).toBeLessThanOrEqual(shown.x + shown.width);
        await screenshot(window, `mind-check-unexamined-${language}-${width}`);
      }

      // With a model that decides every sentence, Check asks about the one left and the line goes.
      await connectLocalChatModel(window);
      const again = (await checkCard(window)).getByTestId("badge-check-mind");
      await pointAndClick(window, again);
      await mindCheckFinished(window, 3);
      await expect(checked).not.toContainText(translate(language, "health.unexamined.one"));
      await expect(card.getByTestId("health-toCheck")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

/**
 * A model billed per token, whose requests the cost meter counts, with the checks allowed to use it.
 * A monthly cap is set, so a run under a dollar still shows its estimate (#1941); a test that
 * needs the price line from the amount alone sets none.
 */
async function useCloudChatModel(
  window: Page,
  { modelId = "claude-haiku-5-5", cap = true }: { modelId?: string; cap?: boolean } = {},
) {
  await window.evaluate(
    async ({ modelId, cap }) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId,
      });
      if (provider.service) {
        for (const flow of ["chat", "tagging", "checks"] as const) {
          await core.allowDataFlow(flow, provider.service.id);
        }
      }
      if (cap) await core.updateSettings({ user: { monthlyCap: { amount: 20, currency: "USD" } } });
    },
    { modelId, cap },
  );
}

/** The requests made to cloud models this month, as the cost meter counts them. */
const modelRequests = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { providers } = await core.getCostSummary();
    return providers.reduce((sum, each) => sum + each.requests, 0);
  });

test("The card's one Check: the price line first on a cloud model under a cap, then one press checks, every claim marked, the headings, questions and opinions not; an edited claim is checked again alone", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await useCloudChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await harbourNotes(window);

  // The badge's card prices the run before it starts, and its one press runs it: no question
  // first (#2313). Of the 20 sentences, all make a claim, so the one count says 20; the model
  // names the 15 claims among them.
  const health = await checkCard(window);
  await expect(health.getByTestId("badge-check-mind")).toHaveAttribute(
    "title",
    "20 sentences to check",
  );
  await expect(health.getByTestId("check-estimate")).toContainText("About $");
  // The price line landing does not clip the card: its press stays inside at both widths.
  const press = health.getByTestId("badge-check-mind");
  expect(await inside(press, health)).toBe(true);
  await setWindowSize(app, window, 900, 800);
  expect(await inside(press, health)).toBe(true);
  await setWindowSize(app, window, 1440, 900);
  await screenshot(window, "mind-check-card-en");
  // The price says whose it is and when that was checked, in the app's tip that Tab shows at once,
  // and Pricing ↗ opens the provider's own page (#1257).
  const price = health.getByTestId("check-estimate").getByTestId("estimate-price");
  const pricing = health.getByTestId("check-estimate").getByTestId("estimate-pricing");
  await expectEstimateTip(
    window,
    price,
    /^Estimate from Anthropic’s price, checked \d{1,2}\s\w+\s\d{4}$/,
    pricing,
  );
  await expect(price).toHaveAccessibleDescription(/^Estimate from Anthropic’s price/);
  await expect(pricing).toHaveText("Pricing ↗");
  await interceptOpenExternal(app);
  await pointAndClick(window, pricing);
  await expect
    .poll(() => urlsOpened(app))
    .toEqual(["https://platform.claude.com/docs/en/about-claude/pricing"]);
  await pointAndClick(window, press);
  await expect(window.getByTestId("mind-check-ask")).toHaveCount(0);
  await mindCheckFinished(window, 15);

  await expect(health.getByTestId("health-checked-all")).toContainText("Checked 15 sentences, ");
  await expect(marks(window)).toHaveCount(15);
  await expect(marks(window).and(window.locator('[data-check="checking"]'))).toHaveCount(0);
  await expect(marks(window).and(window.locator('[data-check="contradicted"]'))).toHaveCount(1);
  await expect(marks(window).and(window.locator('[data-check="supported"]'))).toHaveCount(3);
  // Nothing changed since: no claim is one not checked yet.
  await expect(health.getByTestId("health-toCheck")).toHaveCount(0);
  await expect(window.getByTestId("check-badge")).toContainText("1");
  await screenshot(window, "mind-check-done-en");

  // An edited claim needs a re-check, and Check checks it alone.
  const editor = window.getByTestId("mind-editor");
  const first = editor.locator(":scope > p").first();
  await slideSelect(window, first, "Penguins");
  await window.keyboard.type("Puffins");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(1);
  // The card's one action checks what changed, here the edited claim alone, at once; its
  // tooltip says how many that is.
  const again = (await checkCard(window)).getByTestId("badge-check-mind");
  await expect(again).toHaveText("Check");
  await expect(again).toHaveAttribute("title", "1 sentence to check");
  await pointAndClick(window, again);
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(0);
  await expect(marks(window).and(window.locator('[data-check="unsupported"]'))).toHaveCount(11);
  await expect(marks(window)).toHaveCount(15);
  await expect(again).toHaveAttribute("title", "Nothing changed");

  // ⌘K's "Check" goes through the same estimate: a spending cap is set, so it opens the card's
  // question and waits for the User's OK there; "Check every sentence again" is every claim.
  await slideSelect(window, first, "Puffins");
  await window.keyboard.type("Gulls");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(1);
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("check this note");
  await pointAndClick(
    window,
    window.getByTestId("palette-item").filter({ hasText: "Checks this note" }).first(),
  );
  const ask = window.getByTestId("check-card").getByTestId("mind-check-ask");
  await expect(ask).toContainText("Check 1 sentence in this note against your Documents?");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(1);
  await pointAndClick(window, ask.getByTestId("mind-check-check"));
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(0);
  // Every sentence again is offered once that check is done.
  await expect(marks(window).and(window.locator('[data-check="checking"]'))).toHaveCount(0);
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("check every sentence");
  await pointAndClick(
    window,
    window.getByTestId("palette-item").filter({ hasText: "Check every sentence again" }).first(),
  );
  // Check every sentence again re-checks the 15 claims; the 5 the first run found make none stay out.
  await expect(window.getByTestId("check-card").getByTestId("mind-check-ask")).toContainText(
    "Check 15 sentences in this note against your Documents?",
  );
});

test("A price line that lands after the card opened makes room for itself and the Check", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  // Claude Opus 5.5 prices ten short sentences above $1 by itself, with no monthly cap: the card
  // opens under the line with no price, and typing takes the plan across it while the card stays open.
  await useCloudChatModel(window, { modelId: "claude-opus-5-5", cap: false });
  await setWindowSize(app, window, 900, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await mindWrittenBefore(window, "Price later", [
    { note: "One claim here. Two claims here. Three claims here." },
  ]);
  await window.getByTestId("mind-list-item").filter({ hasText: "Price later" }).click();
  const editor = window.getByTestId("mind-editor");
  await expect(editor).toContainText("One claim here.");

  const health = await checkCard(window);
  await expect(health.getByTestId("check-estimate")).toHaveCount(0);
  // Its content has settled: the card holds the height it opened with.
  await expect(health.locator(".check-card-body")).toHaveAttribute("style", /height/);
  const press = health.getByTestId("badge-check-mind");
  expect(await inside(press, health)).toBe(true);

  // Seven more sentences, typed while the card is open, take the plan past $1 on Claude Opus
  // 5.5's price: the card plans again from them, and its price line lands in the card already open.
  await editor.evaluate((dom) => {
    (dom as unknown as { editor: Editor }).editor.commands.focus("end");
  });
  await focusSettled(window, editor);
  await window.keyboard.type(
    " Four claims here. Five claims here. Six claims here. Seven claims here. Eight claims here. Nine claims here. Ten claims here.",
  );
  await expect(press).toHaveAttribute("title", "10 sentences to check", { timeout: 15_000 });
  await expect(health.getByTestId("check-estimate")).toContainText("About $");
  // The price line and the Check sit inside the card: neither is clipped by the height held from before it.
  expect(await inside(health.getByTestId("check-estimate"), health)).toBe(true);
  expect(await inside(press, health)).toBe(true);
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`after a capped run the held card keeps the Check in view at 900 and 1,440 px (${language})`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await useCloudChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await harbourNotes(window);

    const health = await checkCard(window);
    const press = health.getByTestId("badge-check-mind");
    await expect(health.getByTestId("check-estimate")).toContainText(
      language === "en" ? "About $" : "约 $",
    );
    await screenshotOf(health, `mind-check-price-${language}-900`);
    expect(await inside(press, health)).toBe(true);

    // All the claims fit the height the card opened with: nothing is cut, so its edge is bare.
    const body = health.locator(".check-card-body");
    const bare = await footFadeOf(body, "*");
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight + 1)).toBe(
      false,
    );
    expect(bare.marked).toBe(false);
    expect(bare.fade).toBe(0);
    await screenshotOf(body, `card-body-${language}-900-none`);

    await pointAndClick(window, press);
    await mindCheckFinished(window, 15);
    // The verdicts need more room than the body holds, so it scrolls: the Check stays in the
    // card's fixed foot, never scrolled away with them, and the body's last line and a half fade
    // to the sheet, so a line the foot cuts fades out whole and reads as more below.
    expect(await inside(press, health)).toBe(true);
    const fading = () => body.evaluate((element) => element.hasAttribute("data-more-after"));
    await expect.poll(fading).toBe(true);
    await cutALineAtFoot(body, "*");
    const edge = await body.evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return { content: style.content, background: style.backgroundImage };
    });
    expect(edge.content).toBe('""');
    expect(edge.background).toContain("linear-gradient");
    const shown = await footFadeOf(body, "*");
    if (!shown.cut) throw new Error("The foot cut no line.");
    expect(shown.position).toBe("sticky");
    expect(shown.fadeBottom).toBeCloseTo(shown.foot, 0);
    expect(shown.fade).toBeGreaterThanOrEqual(1.5 * shown.cut.lineHeight);
    expect(shown.cut.top).toBeGreaterThanOrEqual(shown.foot - shown.fade - 0.5);
    await screenshotOf(body, `card-body-${language}-900-cut`);
    // At the scroll's end nothing is cut below, so the fade goes; at the top it is back.
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(fading).toBe(false);
    expect((await footFadeOf(body, "*")).fade).toBe(0);
    await body.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect.poll(fading).toBe(true);
    await setWindowSize(app, window, 1440, 900);
    expect(await inside(press, health)).toBe(true);
    await expect.poll(fading).toBe(true);
    await screenshotOf(health, `mind-check-price-${language}-1440`);
    const pricing = health.getByTestId("check-estimate").getByTestId("estimate-pricing");
    await expectEstimateTip(
      window,
      health.getByTestId("check-estimate").getByTestId("estimate-price"),
      language === "en"
        ? /^Estimate from Anthropic’s price, checked \d{1,2}\s\w+\s\d{4}$/
        : /^按 Anthropic 的价格估算，核对于 \d{4}年\d{1,2}月\d{1,2}日$/,
      pricing,
    );
    await expect(pricing).toHaveText(language === "en" ? "Pricing ↗" : "价格 ↗");
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the card's foot keeps its height at the Check press (${language}, 900 and 1,440 px)`, async () => {
    test.setTimeout(240_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await useCloudChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await harbourNotes(window);
    const editor = window.getByTestId("mind-editor");
    await expect(editor).toContainText(CLAIMS[0] ?? "");

    // The badge is the card's anchor: opening the card leaves its box as it was.
    await expect(window.getByTestId("check-badge")).toBeVisible();
    let health = await checkCard(window);
    const badgeOpen = await window.getByTestId("check-badge").boundingBox();
    await window.keyboard.press("Escape");
    await expect(health).toBeHidden();
    const badgeClosed = await window.getByTestId("check-badge").boundingBox();
    if (!badgeOpen || !badgeClosed) throw new Error("The badge isn't drawn.");
    expect(badgeClosed.x).toBeCloseTo(badgeOpen.x, 0);
    expect(badgeClosed.width).toBeCloseTo(badgeOpen.width, 0);
    expect(badgeClosed.height).toBeCloseTo(badgeOpen.height, 0);

    const hold = () =>
      app.evaluate(() => {
        (
          globalThis as unknown as { incarnamindSlowCheck: { hold: boolean } }
        ).incarnamindSlowCheck.hold = true;
      });
    const release = () =>
      app.evaluate(() => {
        const slow = (
          globalThis as unknown as { incarnamindSlowCheck: { hold: boolean; release(): void } }
        ).incarnamindSlowCheck;
        slow.hold = false;
        slow.release();
      });
    // The hold is real: a sentence judgement waits for this test, not for a timed run.
    const heldRun = () =>
      expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as unknown as { incarnamindSlowCheck: { waiting: unknown[] } })
                .incarnamindSlowCheck.waiting.length,
          ),
        )
        .toBeGreaterThan(0);

    for (const [at, width] of [900, 1440].entries()) {
      if (at > 0) {
        await editor.evaluate((dom) => {
          (dom as unknown as { editor: Editor }).editor.commands.focus("end");
        });
        await focusSettled(window, editor);
        await window.keyboard.type(
          language === "en" ? " A gull rests on the pier." : " 一只海鸥停在码头上。",
        );
      }
      await setWindowSize(app, window, width, 900);
      health = await checkCard(window);
      const press = health.getByTestId("badge-check-mind");
      const price = health.getByTestId("check-estimate");
      const line = health.getByTestId("card-foot-progress");
      const foot = health.getByTestId("check-card-foot");
      // The scripted cloud model's estimate is of nothing, which shows no amount: its tokens show.
      await expect(price).toContainText(language === "en" ? "tokens" : "token");
      // At rest the row is Check's own: no progress line, no empty one.
      await expect(line).toHaveCount(0);
      await screenshot(window, `card-foot-${language}-${width}-open`);
      // The card takes its first paint's height; no line is reserved empty, and a finished
      // check's note line shows its when, never the run's progress words.
      const notes = health.locator(".check-card-note");
      if ((await notes.count()) > 0) {
        await expect(notes).not.toContainText(language === "en" ? "Checking" : "正在核对");
      }
      const before = { card: await health.boundingBox(), foot: await foot.boundingBox() };
      if (!before.card || !before.foot) throw new Error("The card isn't drawn.");

      // The run holds at its sentence judgement, so the press's line stays on show.
      await hold();
      await pointAndClick(window, press);
      await expect(line).toBeVisible();
      await heldRun();
      await screenshot(window, `card-foot-${language}-${width}-pressed`);
      const after = { card: await health.boundingBox(), foot: await foot.boundingBox() };
      if (!after.card || !after.foot) throw new Error("The card went at the press.");
      // The run's words take Check's own row: the card and its foot keep their box, and the card
      // keeps its edge as the badge widens around it.
      expect(after.card.height).toBeCloseTo(before.card.height, 0);
      expect(after.card.width).toBeCloseTo(before.card.width, 0);
      expect(after.card.x).toBeCloseTo(before.card.x, 0);
      expect(after.card.y).toBeCloseTo(before.card.y, 0);
      expect(after.foot.height).toBeCloseTo(before.foot.height, 0);
      // The run's own words are one line, in the foot's row, ending where Check ends.
      const lineBox = await line.boundingBox();
      const pressBox = await health.getByTestId("badge-check-mind").boundingBox();
      if (!lineBox || !pressBox) throw new Error("The run's line isn't drawn.");
      expect(lineBox.height).toBeCloseTo(20, 0);
      expect(lineBox.y).toBeGreaterThanOrEqual(after.foot.y - 0.5);
      expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(
        after.foot.y + after.foot.height + 0.5,
      );
      expect(lineBox.x + lineBox.width).toBeCloseTo(pressBox.x + pressBox.width, 0);
      // The price line stays as it was, so the run leaves no blank band in the foot.
      await expect(price).toBeVisible();
      // A keyboard User can stop the run: the press leaves them on Stop.
      await expect(health.getByTestId("card-foot-stop")).toBeFocused();
      // The foot carries the run's words; the body's note line takes a line only with something
      // to say, and nothing has landed yet.
      await expect(health.locator(".check-card-note")).toHaveCount(0);
      await expect(line).toContainText(language === "en" ? "Checking" : "正在核对");
      // The badge keeps its words while the card is open.
      await expect(window.getByTestId("badge-progress")).toBeVisible();

      await release();
      await mindCheckFinished(window, at === 0 ? 15 : 16);
      // The row goes back to Check, in the same room: the run's end does not jump either.
      const ended = { card: await health.boundingBox(), foot: await foot.boundingBox() };
      if (!ended.card || !ended.foot) throw new Error("The card went at the run's end.");
      expect(ended.card.height).toBeCloseTo(before.card.height, 0);
      expect(ended.foot.height).toBeCloseTo(before.foot.height, 0);
      // The price stays, and the first row is in view at the top of the body, never under the fade.
      await expect(price).toBeVisible();
      const first = health.locator(".check-row").first();
      await expect(first).toHaveCount(1);
      await expect(first).toBeInViewport();
      await expect(press).toBeVisible();
      await expect(press).toBeFocused();
      await screenshot(window, `card-${language}-${width}-ended`);
      await window.keyboard.press("Escape");
    }

    if (language === "zh-CN") {
      // The Chinese price line is one row at 360 px; narrowed, it wraps, so the foot has to keep
      // the price line's room in Chinese too.
      await editor.evaluate((dom) => {
        (dom as unknown as { editor: Editor }).editor.commands.focus("end");
      });
      await focusSettled(window, editor);
      await window.keyboard.type(" 海豹退潮时慢慢地睡在岩石上。");
      await setWindowSize(app, window, 900, 900);
      const health = await checkCard(window);
      const press = health.getByTestId("badge-check-mind");
      const price = health.getByTestId("check-estimate");
      const line = health.getByTestId("card-foot-progress");
      await expect(price).toContainText("token");
      await health.evaluate((element) => {
        (element as HTMLElement).style.width = "220px";
      });
      const priceHeight = () => price.evaluate((element) => element.getBoundingClientRect().height);
      await expect.poll(priceHeight).toBeGreaterThan(30);
      await expect(line).toHaveCount(0);
      const priceLine = health.locator(".check-card-estimate");
      const priceBox = await priceLine.boundingBox();
      await screenshot(window, "card-foot-zh-CN-220-wrapped-open");

      await hold();
      await pointAndClick(window, press);
      await expect(line).toBeVisible();
      await heldRun();
      // The wrapped price line keeps its room while the run hides it.
      const priceRoom = await priceLine.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      if (!priceBox) throw new Error("The price line isn't drawn.");
      expect(priceRoom).toBeCloseTo(priceBox.height, 0);
      await screenshot(window, "card-foot-zh-CN-220-wrapped-pressed");
      await release();
      await mindCheckFinished(window, 17);
      await window.keyboard.press("Escape");
    }

    // A card that never showed a price line: no empty line at rest, and the run's words take
    // Check's own row, so the card does not jump at the press.
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.updateSettings({ user: { monthlyCap: null } });
    });
    await editor.evaluate((dom) => {
      (dom as unknown as { editor: Editor }).editor.commands.focus("end");
    });
    await focusSettled(window, editor);
    await window.keyboard.type(
      language === "en"
        ? " A seal sleeps on the rocks at low tide."
        : " 海豹退潮时 slowly 睡在岩石上。",
    );
    const plain = await checkCard(window);
    const plainPress = plain.getByTestId("badge-check-mind");
    const plainPrice = plain.getByTestId("check-estimate");
    const plainLine = plain.getByTestId("card-foot-progress");
    const plainFoot = plain.getByTestId("check-card-foot");
    await expect(plainPress).toHaveAttribute(
      "title",
      language === "en" ? "1 sentence to check" : "1 句待核对",
    );
    await expect(plainPrice).toHaveCount(0);
    // Its content has settled: the estimate is none, not still on its way, so the press runs.
    await expect(plain.locator(".check-card-body")).toHaveAttribute("style", /height/);
    // No price line, no empty line: at rest the foot holds only the Check.
    await expect(plainLine).toHaveCount(0);
    const beforePlain = {
      card: await plain.boundingBox(),
      foot: await plainFoot.boundingBox(),
    };
    if (!beforePlain.card || !beforePlain.foot) throw new Error("The card isn't drawn.");
    await screenshot(window, `card-foot-${language}-noprice`);

    await hold();
    await pointAndClick(window, plainPress);
    await expect(plainLine).toBeVisible();
    await heldRun();
    const heldPlain = { card: await plain.boundingBox(), foot: await plainFoot.boundingBox() };
    if (!heldPlain.card || !heldPlain.foot) throw new Error("The card went at the press.");
    expect(heldPlain.foot.height).toBeCloseTo(beforePlain.foot.height, 0);
    expect(heldPlain.card.height).toBeCloseTo(beforePlain.card.height, 0);
    expect(heldPlain.card.x).toBeCloseTo(beforePlain.card.x, 0);
    expect(heldPlain.card.y).toBeCloseTo(beforePlain.card.y, 0);
    const plainLineBox = await plainLine.boundingBox();
    const plainPressBox = await plainPress.boundingBox();
    if (!plainLineBox || !plainPressBox) throw new Error("The run's line isn't drawn.");
    expect(plainLineBox.height).toBeCloseTo(20, 0);
    expect(plainLineBox.x + plainLineBox.width).toBeCloseTo(
      plainPressBox.x + plainPressBox.width,
      0,
    );
    await expect(plainLine).toContainText(language === "en" ? "Checking" : "正在核对");
    await screenshot(window, `card-foot-${language}-noprice-held`);
    await release();
    await mindCheckFinished(window, language === "en" ? 17 : 18);
    const endedPlain = { card: await plain.boundingBox(), foot: await plainFoot.boundingBox() };
    if (!endedPlain.card || !endedPlain.foot) throw new Error("The card went at the run's end.");
    expect(endedPlain.foot.height).toBeCloseTo(beforePlain.foot.height, 0);
    expect(endedPlain.card.height).toBeCloseTo(beforePlain.card.height, 0);
    await expect(plainPress).toBeVisible();
    await app.close();
  });
}

test("a run's start and end leave the composer's typing alone", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await useCloudChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await harbourNotes(window);
  const health = await checkCard(window);
  await app.evaluate(() => {
    (
      globalThis as unknown as { incarnamindSlowCheck: { hold: boolean } }
    ).incarnamindSlowCheck.hold = true;
  });
  await pointAndClick(window, health.getByTestId("badge-check-mind"));
  await expect(health.getByTestId("card-foot-progress")).toBeVisible();
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as { incarnamindSlowCheck: { waiting: unknown[] } })
            .incarnamindSlowCheck.waiting.length,
      ),
    )
    .toBeGreaterThan(0);

  // The User goes on typing in the composer while the run is on (⌘J reaches it without a press
  // that would close the card), and the run's end leaves the words and the focus where they are.
  const composer = window.getByTestId("composer-input");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(composer).toBeFocused();
  await window.keyboard.type("A note while the check runs");
  await app.evaluate(() => {
    const slow = (
      globalThis as unknown as { incarnamindSlowCheck: { hold: boolean; release(): void } }
    ).incarnamindSlowCheck;
    slow.hold = false;
    slow.release();
  });
  await mindCheckFinished(window, 15);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("A note while the check runs");
  await app.close();
});

test("In Chinese and a narrow window, from the Mind's tab menu: a model on this computer checks at once with no price; a Folder that holds too little offers all Documents; Check checks a sentence written since", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(
    join(sources, "Garden.pdf"),
    buildPdf([{ lines: ["Garden notes", "Roses like a sunny wall and rich soil."] }]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Garden.pdf")]);
  await harbourNotes(window);
  // The Mind's Folder holds only the garden notes; the Tides PDF is outside it.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await core.createLibraryGroup({ name: "Garden", description: "" });
    const garden = (await core.listDocuments()).filter((each) => each.name === "Garden");
    const mind = (await core.listMinds()).filter((each) => each.title === "Harbour notes");
    await core.moveToFolder({
      documentIds: garden.map((each) => each.id),
      mindIds: mind.map((each) => each.id),
      folderId: folder.id,
    });
  });
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);

  await window.getByTestId("mind-tab").first().click({ button: "right" });
  await pointAndClick(window, window.getByRole("menuitem", { name: "核对", exact: true }));
  // On this computer it checks at once, asking nothing: no price line and no question. The run
  // takes about ten seconds: the card is aimed at once every claim is marked, not after a time.
  await mindCheckFinished(window, 15, { card: false });
  const health = await checkCard(window, window, { stopTimeout: 120_000 });
  await mindCheckFinished(window, 15);
  const ask = health.getByTestId("mind-check-ask");
  await expect(ask).toHaveCount(0);
  await expect(health.getByTestId("check-estimate")).toHaveCount(0);
  await expect(health.getByTestId("health-checked-all")).toContainText("已核对 15 句，");
  await expect(marks(window).and(window.locator('[data-check="unsupported"]'))).toHaveCount(15);

  // Nothing in the Folder says any of it: checked against every Document, the Tides PDF does.
  const widen = health.getByTestId("checks-uncovered").getByTestId("checks-check-all");
  await expect(widen).toHaveText("对照全部文档核对");
  await pointAndClick(window, widen);
  // The claims are named already and a model on this computer is free: it checks at once, asking nothing.
  await expect(marks(window).and(window.locator('[data-check="checking"]')).first()).toBeVisible();
  await expect(ask).toHaveCount(0);
  await mindCheckFinished(window, 15);
  await expect(marks(window).and(window.locator('[data-check="supported"]'))).toHaveCount(3);
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await expect(health.getByTestId("health-checked-all")).toBeVisible();
  await expect(marks(window).and(window.locator('[data-check="contradicted"]'))).toHaveCount(1);
  await expect(widen).toHaveCount(0);
  await expect(marks(window)).toHaveCount(15);
  await expect(health.getByTestId("health-look")).toContainText("12 句需要留意");
  await screenshot(window, "mind-check-done-zh-narrow");

  // A sentence written since: "核对" checks it alone, and the rest stay as they were.
  const editor = window.getByTestId("mind-editor");
  const last = editor.locator(":scope > p").last();
  const box = await last.boundingBox();
  if (!box) throw new Error("The last paragraph isn't drawn.");
  // Right of its last line: the caret goes to the paragraph's end.
  await last.click({ position: { x: box.width - 2, y: box.height - 4 } });
  await window.keyboard.type(" The harbour office opens at nine in the morning.");
  await expect(last).toContainText("worth building. The harbour office opens");
  const all = (await checkCard(window)).getByTestId("badge-check-mind");
  await expect(all).toHaveText("核对");
  await expect(all).toHaveAttribute("title", "1 句待核对");
  await pointAndClick(window, all);
  await expect(marks(window)).toHaveCount(16);
  await expect(health.getByTestId("health-toCheck")).toHaveCount(0);
});

test("when the provider can't be reached while the claims are named, Try again names them again and checks", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  // The scripted model can't reach its provider the first time it names the claims.
  await connectLocalChatModel(window, "fake-model-claims-offline");
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await harbourNotes(window);

  await window.getByTestId("mind-tab").first().click({ button: "right" });
  await pointAndClick(window, window.getByRole("menuitem", { name: "Check", exact: true }));
  // The one press has the model name the claims; the failure opens the badge's card to say why,
  // with Try again.
  const failure = window.getByTestId("check-card").getByTestId("answer-error");
  await expect(failure).toHaveAttribute("data-error-kind", "network");
  await pointAndClick(window, failure.getByTestId("answer-error-action"));

  await expect(marks(window)).toHaveCount(15);
  await expect(window.getByTestId("mind-check-ask")).toHaveCount(0);
});

test("Check with nothing changed sends nothing: the marks stay and the card says since when, with Check every sentence again, which checks for real; in English and Chinese", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await useCloudChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await harbourNotes(window);

  const card = await checkCard(window);
  await pointAndClick(window, card.getByTestId("badge-check-mind"));
  await expect(card.getByTestId("health-checked-all")).toContainText("Checked 15 sentences, ");
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await expect(marks(window)).toHaveCount(15);
  const verdicts = () =>
    marks(window).evaluateAll((all) =>
      all.map((each) => `${each.getAttribute("data-check")}: ${each.textContent}`),
    );
  const checked = await verdicts();
  const sent = await modelRequests(window);
  expect(sent).toBeGreaterThan(0);

  // Again: no model is asked, no question, no run; the marks are as they were, and the card says why.
  const again = card.getByTestId("badge-check-mind");
  await pointAndClick(window, again);
  const unchanged = card.getByTestId("mind-check-unchanged");
  await expect(unchanged).toContainText("Nothing changed since ");
  await expect(unchanged).toHaveAttribute("role", "status");
  await expect(card.getByTestId("mind-check-ask")).toHaveCount(0);
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await expect(window.getByTestId("badge-progress")).toHaveCount(0);
  expect(await verdicts()).toEqual(checked);
  expect(await modelRequests(window)).toBe(sent);
  await screenshot(window, "mind-check-unchanged-en");

  // The action is the line's own button, reached from the keyboard, and checks every sentence for real.
  const every = unchanged.getByTestId("mind-check-every");
  await expect(every).toHaveText("Check every sentence again");
  // The price line's own stops, its tip and Pricing ↗, lie between the line and Check (#1257).
  await window.keyboard.press("Shift+Tab");
  await expect(card.getByTestId("estimate-pricing")).toBeFocused();
  await window.keyboard.press("Shift+Tab");
  await expect(card.getByTestId("estimate-price")).toBeFocused();
  await window.keyboard.press("Shift+Tab");
  await expect(every).toBeFocused();
  await window.keyboard.press("Enter");
  const ask = card.getByTestId("mind-check-ask");
  // Every sentence again re-checks the 15 claims; the 5 the first run found make none stay out.
  await expect(ask).toContainText("Check 15 sentences in this note against your Documents?");
  await expect(unchanged).toHaveCount(0);
  expect(await modelRequests(window)).toBe(sent);
  await pointAndClick(window, ask.getByTestId("mind-check-check"));
  await expect.poll(() => modelRequests(window)).toBeGreaterThan(sent);
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await expect(marks(window)).toHaveCount(15);
  await expect(unchanged).toHaveCount(0);

  // An edit makes a sentence to check; the same words again, and nothing changed.
  const editor = window.getByTestId("mind-editor");
  const first = editor.locator(":scope > p").first();
  await slideSelect(window, first, "Penguins");
  await window.keyboard.type("Puffins");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(1);
  const editedCard = await checkCard(window);
  await expect(editedCard.getByTestId("badge-check-mind")).toHaveAttribute(
    "title",
    "1 sentence to check",
  );
  await slideSelect(window, first, "Puffins");
  await window.keyboard.type("Penguins");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(0);

  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  const reopened = await checkCard(window);
  const sentAgain = await modelRequests(window);
  await pointAndClick(window, reopened.getByTestId("badge-check-mind"));
  await expect(unchanged).toContainText(/^自 .+ 起没有改动/);
  await expect(unchanged.getByTestId("mind-check-every")).toHaveText("重新核对每一句");
  expect(await modelRequests(window)).toBe(sentAgain);
  const [lineBox, cardBox] = [await unchanged.boundingBox(), await reopened.boundingBox()];
  if (!lineBox || !cardBox) throw new Error("The line or the card isn't drawn.");
  expect(lineBox.x).toBeGreaterThanOrEqual(cardBox.x);
  expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  await screenshot(window, "mind-check-unchanged-zh-narrow");
  await app.close();
});

test("the line that says nothing changed goes when a Document is edited or deleted, or the Mind leaves the Folder, and stays when a cited Document does (#2313)", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(
    join(sources, "Garden.pdf"),
    buildPdf([{ lines: ["Garden notes", "Roses like a sunny wall and rich soil."] }]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Garden.pdf")]);
  await harbourNotes(window);
  const inFolder = (documents: string[], mind: boolean, folder: "Harbours" | null) =>
    window.evaluate(
      async ([names, withMind, name]) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const ids = (await core.listDocuments())
          .filter((each) => names.includes(each.name))
          .map((each) => each.id);
        const minds = withMind
          ? (await core.listMinds()).filter((each) => each.title === "Harbour notes")
          : [];
        const { groups } = await core.getLibrary();
        const folderId = name
          ? (
              groups.find((each) => each.name === name) ??
              (await core.createLibraryGroup({ name, description: "" }))
            ).id
          : null;
        await core.moveToFolder({
          documentIds: ids,
          mindIds: minds.map((each) => each.id),
          folderId,
        });
      },
      [documents, mind, folder] as const,
    );
  await inFolder(["Tides", "Garden"], true, "Harbours");

  const card = await checkCard(window);
  const check = card.getByTestId("badge-check-mind");
  const unchanged = card.getByTestId("mind-check-unchanged");
  await pointAndClick(window, check);
  await expect(card.getByTestId("health-checked-all")).toBeVisible({ timeout: 30_000 });
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);

  // Each change leaves checks to make, so the line goes and the button says how many; checking them brings it back.
  const checkedAgain = async () => {
    await checkCard(window);
    await pointAndClick(window, check);
    await expect(check).toHaveAttribute("title", "Nothing changed", { timeout: 20_000 });
    // The press that planned may have found nothing changed itself: the line is on, and a second
    // press would only say it again.
    if (await unchanged.isVisible()) return;
    // Otherwise it checked, and a finished check never says "nothing changed": only a press on
    // what that left can say it, so press again, waiting each check out, and open the card again
    // if one closed it.
    await expect(async () => {
      await checkCard(window);
      await pointAndClick(window, check);
      await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 30_000 });
      await expect(unchanged).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  };
  await pointAndClick(window, check);
  await expect(unchanged).toBeVisible();

  await writeFile(
    join(sources, "Tides.pdf"),
    buildPdf([
      { lines: ["Harbour times", "Harbours publish the times of high water every 6 months."] },
    ]),
  );
  await expect(unchanged).toHaveCount(0, { timeout: 30_000 });
  await expect(check).toHaveAttribute("title", /sentences? to check$/);
  await checkedAgain();

  // A cited Document leaves the Folder: a result its quote backs holds wherever the Note is
  // filed, so the line stays and a press still finds nothing to send (#2313).
  await inFolder(["Tides"], false, null);
  await checkCard(window);
  await expect(unchanged).toBeVisible();
  await pointAndClick(window, check);
  await expect(unchanged).toBeVisible();

  // The Mind goes to another Folder: its Unsupported-with-no-quote results rested on the Folder
  // they were read in, so they are checked in the new one (#2313).
  await inFolder([], true, null);
  await expect(unchanged).toHaveCount(0);
  await expect(check).toHaveAttribute("title", /sentences? to check$/);
  await checkedAgain();

  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.deleteDocuments((await core.listDocuments()).map((each) => each.id));
  });
  await expect(unchanged).toHaveCount(0);
  await expect(check).not.toHaveAttribute("title", "Nothing changed");
  await app.close();
});

const MONTH = { en: "used this month", "zh-CN": "本月已用" } as const;

for (const language of ["en", "zh-CN"] as const) {
  // protects=a Check the User starts from ⌘K says how it went once, in the Note's card (#2831); fails_when=a notice says "That didn’t work: Nothing to check" beside the card's line; no_claim=the assistant's own Check, whose reply says it.
  test(`a Check from ⌘K on a Note with nothing to check says so once, in the card (${language})`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 1440, 900);
      await addDocuments(window, [join(sources, "Tides.pdf")]);
      await newMind(window);
      // A heading alone: no sentence a check reads.
      await window.keyboard.type("# Harbour notes");
      const editor = window.getByTestId("mind-editor");
      await expect(editor.getByRole("heading", { name: "Harbour notes" })).toBeVisible();
      await runCommand(window, "mind.check", translate(language, "mindCheck.command"));
      await expect(window.getByTestId("check-card").getByTestId("checks-problem")).toContainText(
        language === "en" ? "This note has no sentences to check." : "这篇笔记里没有要核对的句子。",
      );
      await motionSettled(window);
      await expect(window.getByTestId("error-notice")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

for (const [first, then] of [
  ["en", "zh-CN"],
  ["zh-CN", "en"],
] as const) {
  // protects=the whole-Note question's estimate is put in words in the language the card shows, also after a switch while it is open (#2831); fails_when=it keeps the words of the language it was asked in; no_claim=the amounts.
  test(`the question's estimate follows the language switched to while it is open (${first} to ${then})`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await useCloudChatModel(window);
    await setLanguage(window, first);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await mindWrittenBefore(window, "Harbour notes", [{ note: `${CLAIMS[1]} ${CLAIMS[4]}` }]);
    await window.getByTestId("mind-list-item").filter({ hasText: "Harbour notes" }).click();
    await runCommand(window, "mind.check", translate(first, "mindCheck.command"));
    const ask = window.getByTestId("check-card").getByTestId("mind-check-ask");
    await expect(ask).toContainText(MONTH[first]);
    await setLanguage(window, then);
    await expect(ask).toContainText(MONTH[then]);
    await expect(ask).not.toContainText(MONTH[first]);
    await app.close();
  });
}
