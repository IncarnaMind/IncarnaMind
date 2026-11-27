import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  checkCard,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  motionSettled,
  noteCheck,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  slideSelect,
  useLocalChatModel,
  writeNote,
} from "./app";
import { holdModel, modelHeld } from "./heldModel";

/*
 * The Note's check card in its four states (#3840), as a person sees them through the Note: Not
 * checked yet, with no Check of its own while the Note's button is in sight; Checking, with how far
 * it has got and no Stop or row repeating it; Check done and when, with a quiet Check again; and
 * All supported and when. After the whole check, a sentence edited keeps the Note's verdict and the
 * card offers to check it; Check again with nothing changed says so, without the time. The time
 * and the count of what can be cited are said once. The scripted model supports a sentence that
 * shares three words with a line of a Document and contradicts one whose figure differs. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save each state's window.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  // The pointer rests on the card's head, which lights nothing, as a person reading the card holds
  // it, rather than over the last thing pressed.
  const head = window.getByTestId("check-card-head");
  if (await head.isVisible()) await head.hover();
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIMETABLE = [
  "# Ferry timetable 2025",
  "",
  "The 07:40 crossing from Kestrel Bay carried 412 passengers on average in the third quarter.",
  "",
  "Freight vans load on the lower deck during weekday morning sailings.",
  "",
  "Winter crossings run on a reduced timetable from November through March.",
  "",
].join("\n");
const REPORT = [
  "# Harbour report 2025",
  "",
  "On-time departures reached 94.2% across the summer schedule.",
  "",
  "The south berth upgrade cost £3.1m and was completed in October 2025.",
  "",
].join("\n");

const CROSSING =
  "The 07:40 crossing from Kestrel Bay carried 412 passengers on average in the third quarter.";
const ON_TIME = "On-time departures reached 94.2% across the summer schedule.";
const FREIGHT = "Freight vans load on the lower deck during weekday morning sailings.";
const BERTH = "The south berth upgrade was completed in October 2025 at a cost of £2.4m.";
const WINTER = "Winter crossings run on a reduced timetable from November through March.";
const COMMUTERS =
  "Commuters from Ardmore Island wait an average of 22 minutes for the connecting train.";

const WORDS = {
  en: {
    folder: "Kestrel Bay",
    notChecked: "Not checked yet",
    notCheckedLine: "6 sentences · against “Kestrel Bay” (2 Documents)",
    checking: "Checking…",
    progress: /^[0-6] of 6$/,
    done: "Check done",
    allSupported: "All supported",
    cleanLine: "4 sentences checked against “Kestrel Bay”.",
    checkAgain: "Check again",
    checkNew: "Check 1 new",
    nothingChanged: "Nothing changed",
    every: "Check every sentence again",
    look: "2 need a look",
    lookButton: "2 need a look",
    waits: "1 not checked yet",
    canBeCited: "can be cited",
  },
  "zh-CN": {
    folder: "茶隼湾",
    notChecked: "尚未核对",
    notCheckedLine: "共 6 句 · 对照“茶隼湾”（2 个文档）",
    checking: "正在核对…",
    progress: /^[0-6]\/6$/,
    done: "核对完成",
    allSupported: "全部有依据",
    cleanLine: "已对照“茶隼湾”核对 4 句。",
    checkAgain: "重新核对",
    checkNew: "核对新改的 1 句",
    nothingChanged: "没有改动",
    every: "重新核对每一句",
    look: "2 句需要留意",
    lookButton: "需要留意 2 处",
    waits: "1 句未核对",
    canBeCited: "可添加引用",
  },
} as const;

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

/** The Folder with its two Documents, and the Notes to check in it: the memo and the crossings. */
async function kestrelBay(window: Page, folder: string) {
  const files = [join(sources, "Ferry timetable 2025.md"), join(sources, "Harbour report 2025.md")];
  await writeFile(files[0] ?? "", TIMETABLE);
  await writeFile(files[1] ?? "", REPORT);
  const folderId = await window.evaluate(
    async ([paths, name]) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const group = await bridge.createLibraryGroup({ name, description: "" });
      await bridge.addDocuments(paths, { groupId: group.id });
      return group.id;
    },
    [files, folder] as const,
  );
  await expectReadyDocuments(window, 2);
  const crossings = await writeNote(
    window,
    "Kestrel Bay crossings",
    [{ text: `${CROSSING} ${ON_TIME}` }, { text: `${FREIGHT} ${WINTER}` }],
    { folderId },
  );
  const memo = await writeNote(
    window,
    "Kestrel Bay ferry memo",
    [
      { text: `${CROSSING} ${ON_TIME}` },
      { text: `${FREIGHT} ${BERTH}` },
      { text: `${WINTER} ${COMMUTERS}` },
    ],
    { folderId },
  );
  return { memo, crossings };
}

async function openNote(window: Page, folder: string, mindId: string) {
  const row = sidebarFolder(window, folder).getByTestId("folder-row");
  if ((await row.getAttribute("aria-expanded")) !== "true") await pointAndClick(window, row);
  await pointAndClick(
    window,
    window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
  );
  await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
}

/** Lets the held judgements go and holds the next ones, so the run moves on and stops again. */
const releaseHeld = (app: ElectronApplication) =>
  app.evaluate(() => {
    (
      globalThis as unknown as { incarnamindSlowCheck: { release(): void } }
    ).incarnamindSlowCheck.release();
  });

/** The card's whole text, its buttons' words among it. */
const cardText = async (card: Locator) => (await card.textContent()) ?? "";

/** How many times `part` is in `text`. */
const times = (text: string, part: string) => text.split(part).length - 1;

/** The card sits inside the window, its head on one line. */
async function fitsTheWindow(window: Page, card: Locator) {
  const box = await card.boundingBox();
  const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!box) throw new Error("The card isn't drawn.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  const head = await card.getByTestId("check-card-head").boundingBox();
  if (!head) throw new Error("The card's head isn't drawn.");
  expect(head.height).toBeLessThanOrEqual(36);
}

for (const [language, width, height] of [
  ["en", 1440, 900],
  ["en", 900, 680],
  ["zh-CN", 1440, 900],
  ["zh-CN", 900, 680],
] as const) {
  const words = WORDS[language];
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  // protects=#3840: the card says where the Note's check stands in each state, the time and the can-be-cited count once, with one filled control and quiet Check again; fails_when=a state's head is missing, a count or the time shows twice, the card has its own Check or Stop, or an edit after a whole check turns the Note's button back into Check
  test(`the check card in its four states, with an edit and nothing changed, each said once (${language}, ${width})`, async () => {
    test.setTimeout(300_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, height);
    const { memo, crossings } = await kestrelBay(window, words.folder);
    await openNote(window, words.folder, memo);
    const button = noteCheck(window);
    const stop = window.getByTestId("note-check-place").getByTestId("note-check-stop");

    // Not checked yet: the card says so and how many sentences against what, and has no Check of
    // its own: the Note's button, in sight above it, is the one press.
    await expect(button).toHaveAttribute("data-state", "check");
    await expect(button).toHaveAccessibleName(`${t("mindCheck.command")} 6`);
    const card = await checkCard(window);
    await expect(card).toHaveAccessibleName(t("health.label"));
    const head = card.getByTestId("check-card-head");
    const aside = card.getByTestId("check-card-head-aside");
    await expect(head).toHaveAttribute("data-stage", "not-checked");
    await expect(head).toContainText(words.notChecked);
    await expect(aside).toHaveCount(0);
    // The line counts the sentences once and is their row's Next, the card's one press: no Check
    // of its own and no row repeating the count.
    const waiting = card.getByTestId("check-card-line").getByRole("button");
    await expect(waiting).toHaveAccessibleName(t("health.next", { part: words.notCheckedLine }));
    await expect(waiting).toHaveAttribute("data-testid", "health-toCheck");
    await expect(card.getByRole("button")).toHaveCount(1);
    await expect(card.getByTestId("mind-health").getByTestId("health-toCheck")).toHaveCount(0);
    await expect(button).toBeInViewport();
    await fitsTheWindow(window, card);
    // Its Documents counted once it has opened, the line is still whole: none of it scrolls away.
    await expect(card.getByTestId("check-card-line")).not.toHaveAttribute("aria-busy", "true");
    await expect
      .poll(() =>
        card.locator(".check-card-body").evaluate((body) => body.scrollHeight - body.clientHeight),
      )
      .toBeLessThanOrEqual(1);
    await screenshot(window, `01-not-checked-${language}-${width}`);

    // Checking: one press on the Note's button with the card open starts the run. The card's head
    // says it and how far it has got, over a bar that moves with that count; no row repeats it and
    // the Note's button has the only Stop.
    await holdModel(app, "hold", true);
    await pointAndClick(window, button);
    await expect(button).toHaveAttribute("data-state", "checking");
    await expect.poll(() => modelHeld(app)).toBe(true);
    const running = window.getByTestId("check-card");
    // A press outside the open card closes it as it starts the run; a second press opens it.
    if (!(await running.isVisible())) await pointAndClick(window, button);
    await expect(running).toBeVisible();
    const runningHead = running.getByTestId("check-card-head");
    await expect(runningHead).toHaveAttribute("data-stage", "checking");
    await expect(runningHead).toContainText(words.checking);
    await expect(running.getByTestId("check-card-head-aside")).toHaveText(words.progress);
    await expect(running.locator(".check-card-bar")).toBeVisible();
    await expect(running.getByTestId("health-checking")).toHaveCount(0);
    await expect(running.getByTestId("health-toCheck")).toHaveCount(0);
    await expect(running.getByRole("button", { name: t("checks.stop") })).toHaveCount(0);
    await expect(running.getByTestId("check-card-again")).toHaveCount(0);
    await expect(stop).toHaveAccessibleName(t("checks.stop"));
    // Part-way, the results so far show under the head. Opened again then, as a person looks in
    // while it runs, the card fits them; watched from the start, it kept the height it opened with
    // (#2313).
    const progress = running.getByTestId("check-card-head-aside");
    for (let step = 0; step < 6 && /^0\D/.test((await progress.textContent()) ?? ""); step += 1) {
      await releaseHeld(app);
      await expect.poll(() => modelHeld(app)).toBe(true);
    }
    await expect(progress).not.toHaveText(/^0\D/);
    await pointAndClick(window, button);
    await expect(running).toHaveCount(0);
    await pointAndClick(window, button);
    await expect(running).toBeVisible();
    await expect(running.getByTestId("mind-health").locator(".check-row")).not.toHaveCount(0);
    await expect(running.getByTestId("health-checking")).toHaveCount(0);
    await expect(running.getByTestId("health-toCheck")).toHaveCount(0);
    await fitsTheWindow(window, running);
    await screenshot(window, `02-checking-${language}-${width}`);
    await holdModel(app, "hold", false);

    // Check done with things to look at: the head says so and when, with no warning mark, the time
    // and the can-be-cited count each once, the Note's button and its tooltip saying neither; the
    // foot's quiet Check again sits beside the fix.
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
    await expect(button).toHaveAttribute("data-state", "look");
    await expect(button.locator(".note-check-words")).toHaveText(words.lookButton);
    // Watched through the run, the card kept the height it opened with (#2313); opened again, it
    // fits what the check found.
    const done = window.getByTestId("check-card");
    await expect(done).toBeVisible();
    await pointAndClick(window, button);
    await expect(done).toHaveCount(0);
    await pointAndClick(window, button);
    await expect(done).toBeVisible();
    await motionSettled(window);
    await expect(done.getByTestId("check-card-head")).toHaveAttribute("data-stage", "done");
    await expect(done.getByTestId("check-card-head")).toContainText(words.done);
    await expect(done.locator(".check-card-head-mark svg")).toHaveCount(0);
    const time = (await done.getByTestId("check-card-head-aside").textContent()) ?? "";
    expect(time).toMatch(/\d/);
    expect(times(await cardText(done), time)).toBe(1);
    const title = (await button.getAttribute("title")) ?? "";
    expect(title).not.toContain(time);
    expect(title).not.toContain(words.canBeCited);
    await expect(done.getByTestId("health-look")).toHaveAttribute("data-count", "2");
    await expect(done.getByTestId("health-notYetCited")).toHaveAttribute("data-count", "4");
    expect(times(await cardText(done), words.canBeCited)).toBe(1);
    await expect(done.getByTestId("health-look")).toHaveAccessibleName(
      t("health.next", { part: words.look }),
    );
    const again = done.getByTestId("check-card-again");
    await expect(again).toHaveText(words.checkAgain);
    await expect(again).toHaveAccessibleName(words.checkAgain);
    await expect(done.getByTestId("badge-fix-sentences")).toBeVisible();
    await expect(done.getByRole("switch")).toHaveAccessibleName(t("checks.everyResult"));
    await fitsTheWindow(window, done);
    await screenshot(window, `03-done-findings-${language}-${width}`);

    // Done, then one sentence edited: the Note's button keeps its verdict and names the sentence
    // waiting in its tooltip; the card stays done and offers to check that one.
    await window.keyboard.press("Escape");
    const freight = frontMind(window).locator("p").filter({ hasText: FREIGHT });
    await slideSelect(window, freight, "lower");
    await window.keyboard.type("main");
    await expect(button).toHaveAttribute("data-state", "look");
    await expect(button).toHaveAttribute("title", new RegExp(words.waits));
    const edited = await checkCard(window);
    await expect(edited.getByTestId("check-card-head")).toHaveAttribute("data-stage", "done");
    await expect(edited.getByTestId("health-toCheck")).toHaveCount(0);
    const checkNew = edited.getByTestId("check-card-again");
    await expect(checkNew).toHaveText(words.checkNew);
    await expect(checkNew).toHaveAccessibleName(words.checkNew);
    await fitsTheWindow(window, edited);
    await screenshot(window, `05-edited-${language}-${width}`);
    await pointAndClick(window, checkNew);
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
    await expect(button).toHaveAttribute("data-state", "look");
    await expect(button).not.toHaveAttribute("title", new RegExp(words.waits));

    // Check again with nothing changed says so, without the time the head gives, and still offers
    // to check every sentence.
    const unchanged = await checkCard(window);
    await pointAndClick(window, unchanged.getByTestId("check-card-again"));
    const line = unchanged.getByTestId("mind-check-unchanged");
    await expect(line).toContainText(words.nothingChanged);
    const doneAt = (await unchanged.getByTestId("check-card-head-aside").textContent()) ?? "";
    await expect(line).not.toContainText(doneAt);
    expect(times(await cardText(unchanged), doneAt)).toBe(1);
    await expect(line).toHaveAttribute("role", "status");
    await expect(line.getByTestId("mind-check-every")).toHaveText(words.every);
    await expect(unchanged.getByTestId("check-card-again")).toHaveCount(0);
    await fitsTheWindow(window, unchanged);
    await screenshot(window, `06-nothing-changed-${language}-${width}`);
    await window.keyboard.press("Escape");

    // All supported: the other Note, checked and its sentences cited, says All supported and
    // when, how many against what on its line, with no row saying the same count again.
    await openNote(window, words.folder, crossings);
    await pointAndClick(window, button);
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
    await expect(button).toHaveAttribute("data-state", "checked");
    const cited = await checkCard(window);
    await pointAndClick(window, cited.getByTestId("found-passages-add"));
    const clean = cited.getByTestId("check-card-head");
    await expect(clean).toHaveAttribute("data-stage", "clean");
    await expect(clean).toContainText(words.allSupported);
    await expect(cited.getByTestId("check-card-line").getByRole("button")).toHaveAccessibleName(
      t("health.next", { part: words.cleanLine }),
    );
    await expect(cited.getByTestId("mind-health").getByTestId("health-supported")).toHaveCount(0);
    await expect(cited.getByTestId("health-notYetCited")).toHaveCount(0);
    const cleanAt = (await cited.getByTestId("check-card-head-aside").textContent()) ?? "";
    expect(times(await cardText(cited), cleanAt)).toBe(1);
    await expect(button).toHaveAttribute("data-tone", "success");
    expect((await button.getAttribute("title")) ?? "").not.toContain(cleanAt);
    await expect(cited.getByTestId("check-card-again")).toHaveText(words.checkAgain);
    // Opened again, it fits what it holds now: the row Add all emptied leaves no room behind.
    await pointAndClick(window, button);
    await expect(cited).toHaveCount(0);
    const reopened = await checkCard(window);
    await expect(reopened.getByTestId("check-card-head")).toHaveAttribute("data-stage", "clean");
    await fitsTheWindow(window, reopened);
    await screenshot(window, `04-done-clean-${language}-${width}`);
    await app.close();
  });
}
