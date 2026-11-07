import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  leaveFirstOpen,
  leaveText,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * The sidebar's "Needs attention · Review" (#2308): each press takes the User to the next
 * Document Organize couldn't sort, its row in view; once every one was seen the status goes. A
 * failure is one plain line in Not in a Folder's head, naming the cause; a row names only the
 * cause, with the whole sentence in its tooltip; a cause the Library can't name is one plain line
 * with Try again. Never the provider's sentence. Failures are recorded by the sorting that runs on
 * its own, one Document at a time; what Organize proposes waits in the Review (#1569). In English
 * and Chinese, at 900 and 1,440 pixels. Set INCARNAMIND_SCREENSHOTS to save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** A name long enough to cut the cause beside it if the cause gives way first (#2308). */
const LONG_NAME =
  "Invoice 4 quarterly maintenance invoice for the north warehouse roof and gutter repairs";

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

async function screenshot(target: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const attentionOf = (window: Page) => window.getByTestId("organization-attention");

/**
 * A chat model for Organize, allowed to send, sorting new Documents by itself: that sorting
 * records a failure on each Document it couldn't reach the model for, which Organize's plan
 * doesn't.
 */
async function sortWithChatModel(window: Page, folders: readonly string[]): Promise<void> {
  await window.evaluate(async (names) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "fake-model",
    });
    const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
    if (flow) await core.allowDataFlow("classification", flow.flow.service.id);
    for (const name of names) await core.createLibraryGroup({ name, description: `${name}.` });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
      automatic: true,
      turnOn: true,
    });
  }, folders);
}

/**
 * The scripted model meets an empty account, or can't be reached, on these words. Past the start
 * of the text, which is all Organize's plan reads of a Document, only the one-by-one sort meets
 * them: the plan answers as a model with credit again, or back online, would.
 */
const pastThePlansExcerpt = (subject: string, words: string) =>
  `${Array.from({ length: 40 }, (_, at) => `${subject}, line ${at + 1}: hours on the harbour works.`).join("\n")}\n${words}`;

/** The ids of Not in a Folder's rows Organize couldn't sort, in the page's order. */
const notSortedIds = (window: Page) =>
  window.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-section="not-in-a-folder"] [data-testid="library-document"]',
      ),
    ]
      .filter((row) => row.querySelector('[data-testid="library-not-sorted"]') !== null)
      .map((row) => row.dataset.documentId ?? ""),
  );

/** How many Documents each Folder holds, by name, read through the core. */
const filedCounts = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { groups, assignments } = await core.getLibrary();
    return Object.fromEntries(
      groups.map((group) => [
        group.name,
        assignments.filter((each) => each.groupId === group.id).length,
      ]),
    );
  });

interface Press {
  clicked: number | null;
  shown: number | null;
  selected: string | null;
}

/**
 * Presses Review as the sidebar shows it, with the mouse, and waits until `expected`'s row is
 * selected and in view: the milliseconds from the click to that, and the row's id.
 */
async function pressReview(
  window: Page,
  expected: string,
): Promise<{ ms: number; selected: string | null }> {
  await window.evaluate((wanted) => {
    const held = window as unknown as { __reviewPress?: Press };
    const record: Press = { clicked: null, shown: null, selected: null };
    held.__reviewPress = record;
    document.addEventListener(
      "click",
      (event) => {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('[data-testid="organization-attention-review"]')) return;
        record.clicked = performance.now();
      },
      true,
    );
    const look = () => {
      if (record.clicked !== null && record.shown === null) {
        const row = document.querySelector<HTMLElement>(
          `[data-document-id="${CSS.escape(wanted)}"][aria-selected="true"]`,
        );
        if (row) {
          const box = row.getBoundingClientRect();
          const view = row
            .closest<HTMLElement>('[data-testid="library"]')
            ?.querySelector<HTMLElement>(":scope > div")
            ?.getBoundingClientRect();
          if (!view || (box.bottom > view.top && box.top < view.bottom)) {
            record.shown = performance.now();
            record.selected = wanted;
          }
        }
      }
      if (record.shown === null) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, expected);
  await pointAndClick(window, window.getByTestId("organization-attention-review"));
  await expect
    .poll(
      () =>
        window.evaluate(
          () => (window as unknown as { __reviewPress?: Press }).__reviewPress?.shown ?? null,
        ),
      { timeout: 5_000 },
    )
    .not.toBeNull();
  return window.evaluate(() => {
    const record = (window as unknown as { __reviewPress?: Press }).__reviewPress;
    return {
      ms: (record?.shown ?? 0) - (record?.clicked ?? 0),
      selected: record?.selected ?? null,
    };
  });
}

/** Confirms what waits in the Review, from the Library's top, so nothing waits any more. */
async function confirmWaiting(window: Page): Promise<void> {
  await pointAndClick(window, window.getByTestId("organize-waiting-review"));
  await expect(window.getByTestId("organize-review")).toBeVisible();
  await pointAndClick(window, window.getByTestId("organize-review-confirm"));
  await expect(window.getByTestId("organize-review")).toHaveCount(0);
  await expect(window.getByTestId("organize-waiting")).toHaveCount(0);
}

test("Review goes to each Document that needs attention, and a credit failure is one plain line for the group", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await leaveFirstOpen(window);
    await acceptPlainTextKeys(window);
    await interceptOpenExternal(app);
    await sortWithChatModel(window, ["Invoice"]);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "en");

    const files: string[] = [];
    for (let at = 1; at <= 4; at++) {
      const name = at === 4 ? LONG_NAME : `Invoice ${at}`;
      const path = join(sources, `${name}.txt`);
      await writeFile(
        path,
        pastThePlansExcerpt(`Invoice ${at} for consulting`, "The account is out of credit."),
      );
      files.push(path);
    }
    await addDocuments(window, files);
    await window.getByTestId("open-library").click();

    const library = window.getByTestId("library");
    const status = attentionOf(window);
    await expect(status).toBeVisible({ timeout: 60_000 });
    await expect(status.getByTestId("status-label")).toHaveText("Needs attention");

    // The Not in a Folder header says the shared cause in words only: Try again can't help it.
    const header = library.getByTestId("library-organize-failed");
    await expect(header).toHaveText("4 Documents not organized: no credit left");
    await expect(header.getByRole("button")).toHaveCount(0);

    // A row names only the cause, and its tooltip and accessible name carry the whole sentence (#2308).
    const failedRow = library
      .locator("[data-document-id]")
      .filter({ has: window.getByTestId("library-not-sorted") })
      .first();
    await expect(failedRow.getByTestId("library-not-sorted")).toContainText("No credit left");
    await expect(failedRow.getByTestId("library-not-sorted")).toHaveAttribute(
      "title",
      "Your OpenAI key is out of credit",
    );
    const longRow = library
      .locator("[data-document-id]")
      .filter({ has: window.getByTestId("library-not-sorted") })
      .filter({ hasText: LONG_NAME })
      .first();
    const clipped = () =>
      longRow.getByTestId("library-not-sorted").evaluate((element) => {
        const text = element.querySelector('[aria-hidden="true"]');
        return text !== null && text.scrollWidth > text.clientWidth + 1;
      });
    expect(await clipped()).toBe(false);
    const nameCut = () =>
      longRow
        .getByTestId("library-document-name")
        .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(await nameCut(), "the long name truncates, not the cause").toBe(true);
    await expect(longRow.locator("[data-row-main]")).toHaveAttribute(
      "title",
      new RegExp(LONG_NAME),
    );
    await expect(library).not.toContainText("You exceeded your current quota");

    // Get info says the same plain words, never the provider's sentence.
    await failedRow.locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+i");
    const info = window.getByTestId("info-panel");
    await expect(info).toBeVisible();
    await expect(info.getByTestId("info-organize")).toContainText(
      "Your OpenAI key is out of credit",
    );
    await expect(info.getByTestId("info-organize")).not.toContainText(
      "You exceeded your current quota",
    );
    await window.keyboard.press("Escape");
    await expect(info).toHaveCount(0);

    await expect.poll(() => notSortedIds(window)).toHaveLength(4);
    const [firstId = "", secondId = "", thirdId = "", fourthId = ""] = await notSortedIds(window);

    // The first press from the Library, in English: that Document's row in view.
    await screenshot(window, "review-attention-en-1440-status");
    const first = await pressReview(window, firstId);
    expect(first.selected).toBe(firstId);
    expect(first.ms).toBeGreaterThanOrEqual(0);
    expect(first.ms).toBeLessThan(100);
    await screenshot(window, "review-attention-en-1440-first");

    // The second from the Library, in Chinese.
    await setLanguage(window, "zh-CN");
    await expect(header).toHaveText("4 个文档未整理：额度已用完");
    await expect(failedRow.getByTestId("library-not-sorted")).toHaveAttribute(
      "title",
      "你的 OpenAI 密钥额度已用完",
    );
    await screenshot(window, "review-attention-zh-1440-status");
    const second = await pressReview(window, secondId);
    expect(second.selected).toBe(secondId);
    expect(second.ms).toBeGreaterThanOrEqual(0);
    expect(second.ms).toBeLessThan(100);
    await screenshot(window, "review-attention-zh-1440-next");

    // The third from a Note, at the narrowest window, in English: the Library opens on it.
    await setLanguage(window, "en");
    await setWindowSize(app, window, 900, 760);
    await expect(status).toBeVisible();
    await expect(library.getByTestId("library-not-sorted").first()).toContainText("No credit left");
    expect(await clipped()).toBe(false);
    expect(await nameCut()).toBe(true);
    await screenshot(window, "review-attention-en-900-status");
    await newMind(window);
    const third = await pressReview(window, thirdId);
    expect(third.selected).toBe(thirdId);
    expect(third.ms).toBeGreaterThanOrEqual(0);
    expect(third.ms).toBeLessThan(100);
    await expect(library).toBeVisible();
    await screenshot(window, "review-attention-en-900-next");

    // The fourth from a Note, in Chinese: every one was seen, so the status goes.
    await setLanguage(window, "zh-CN");
    await expect(header).toHaveText("4 个文档未整理：额度已用完");
    await screenshot(window, "review-attention-zh-900-status");
    await newMind(window);
    const fourth = await pressReview(window, fourthId);
    expect(fourth.selected).toBe(fourthId);
    expect(fourth.ms).toBeGreaterThanOrEqual(0);
    expect(fourth.ms).toBeLessThan(100);
    await expect(attentionOf(window)).toHaveCount(0, { timeout: 5_000 });
    await screenshot(window, "review-attention-zh-900-gone");
    await setWindowSize(app, window, 1440, 900);
    await screenshot(window, "review-attention-zh-1440-gone");
    await setLanguage(window, "en");
    await screenshot(window, "review-attention-en-1440-gone");
    await setWindowSize(app, window, 900, 760);
    await screenshot(window, "review-attention-en-900-gone");
    await expect(attentionOf(window)).toHaveCount(0);

    // Add credit, from ⌘K, opens the company's billing page; back in the app, Organize runs once
    // by itself on those four, and its Review proposes their Folder (#2308).
    await runCommand(window, "library.addCredit", "Add credit for Organize");
    await expect
      .poll(() => urlsOpened(app))
      .toContain("https://platform.openai.com/settings/organization/billing/overview");
    await window.evaluate(() => {
      globalThis.dispatchEvent(new Event("focus"));
    });
    const review = window.getByTestId("organize-review");
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(window.getByTestId("organize-review-card-name")).toHaveText(["Invoice"]);
    await expect(window.getByTestId("organize-review-row")).toHaveCount(4);
    await pointAndClick(window, window.getByTestId("organize-review-confirm"));
    await expect(review).toHaveCount(0);
    expect(await filedCounts(window)).toEqual({ Invoice: 4 });
    await expect(header).toHaveCount(0);
    await expect(library.getByTestId("library-not-sorted")).toHaveCount(0);
    await expect(attentionOf(window)).toHaveCount(0);

    // A cause the Library can't name is still one plain line with Try again, never the provider's words.
    const unreadable: string[] = [];
    for (let at = 1; at <= 2; at++) {
      const path = join(sources, `Field notes ${at}.txt`);
      await writeFile(path, `Field notes ${at}. The server is unreachable.`);
      unreadable.push(path);
    }
    await addDocuments(window, unreadable);
    await expect(header).toHaveText("2 Documents not organized · Try again", { timeout: 60_000 });
    await expect(header.getByRole("button")).toHaveText(["Try again"]);
    const loose = library.locator(
      '[data-testid="library-section"][data-section="not-in-a-folder"]',
    );
    await expect(loose.getByTestId("library-not-sorted")).toHaveCount(2);
    await expect(loose.getByTestId("library-not-sorted").first()).toContainText(
      "Couldn’t organize",
    );
    await expect(loose).not.toContainText("Cannot connect to API");
    await setLanguage(window, "zh-CN");
    await expect(header).toHaveText("2 个文档未整理 · 重试");
    await expect(loose).not.toContainText("Cannot connect to API");
  } finally {
    await app.close();
  }
});

test("Review reaches a Document past Not in a Folder's first rows when a search hides it", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await leaveFirstOpen(window);
    await acceptPlainTextKeys(window);
    await sortWithChatModel(window, ["Invoice"]);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "en");

    const files: string[] = [];
    for (let at = 1; at <= 9; at++) {
      const path = join(sources, `Invoice ${at}.txt`);
      await writeFile(path, `Invoice ${at} for consulting. The account is out of credit.`);
      files.push(path);
    }
    await addDocuments(window, files);
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    await expect(library.getByTestId("library-organize-failed")).toHaveText(
      "9 Documents not organized: no credit left",
      { timeout: 60_000 },
    );

    // Not in a Folder draws its first 8; the ninth is the Document the page doesn't draw yet.
    await expect.poll(() => notSortedIds(window)).toHaveLength(8);
    const listed = await notSortedIds(window);
    const last = await window.evaluate(async (shown) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const documents = await core.listDocuments();
      return (
        documents.find(
          (document) => /^Invoice \d/.test(document.name) && !shown.includes(document.id),
        )?.id ?? null
      );
    }, listed);
    if (last === null) throw new Error("The ninth Document isn't in the Library.");

    // A search on before each press hides every row; Review still clears it, shows the whole
    // list and lands on the ninth.
    for (const id of [...listed, last]) {
      await library.getByTestId("library-search").fill("Nothing matches this");
      await pressReview(window, id);
    }
    await expect(attentionOf(window)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a Document Review showed needs attention again after Undo, and Review lands on it", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await leaveFirstOpen(window);
    await acceptPlainTextKeys(window);
    await sortWithChatModel(window, ["Invoice"]);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "en");

    const path = join(sources, "Invoice 1.txt");
    await writeFile(path, "Invoice 1 for consulting. The account is out of credit.");
    await addDocuments(window, [path]);
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");

    // One Document needs attention, and the sidebar says so in the singular (#2308).
    const status = attentionOf(window);
    await expect(status).toBeVisible({ timeout: 60_000 });
    await expect(status.getByTestId("status-label")).toHaveText("Needs attention");
    await expect(status).toContainText("1 Document can’t be organized yet");

    const [id] = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await core.listDocuments())
        .filter((document) => /^Invoice \d/.test(document.name))
        .map((document) => document.id);
    });
    if (id === undefined) throw new Error("The Document isn't in the Library.");
    const first = await pressReview(window, id);
    expect(first.selected).toBe(id);
    await expect(attentionOf(window)).toHaveCount(0);

    // In a Folder it needs nothing; Undo brings the failure back, and with it the status.
    const row = library
      .getByTestId("library-document")
      .filter({ has: window.getByRole("button", { name: "Invoice 1", exact: true }) });
    await expect(row).toHaveCount(1);
    await row.locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+Shift+M");
    const picker = window.getByTestId("move-to-picker");
    await expect(picker.getByTestId("move-to-search")).toBeFocused();
    await window.keyboard.type("Invoice");
    await expect(
      picker.locator('[data-testid="move-to-option"][aria-selected="true"]'),
    ).toContainText("Invoice");
    await window.keyboard.press("Enter");
    await expect.poll(() => filedCounts(window)).toEqual({ Invoice: 1 });
    await expect(attentionOf(window)).toHaveCount(0);

    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(attentionOf(window)).toBeVisible({ timeout: 10_000 });
    await expect(status.getByTestId("status-label")).toHaveText("Needs attention");
    await expect(status).toContainText("1 Document can’t be organized yet");
    const again = await pressReview(window, id);
    expect(again.selected).toBe(id);
    await expect(attentionOf(window)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("mixed causes retry only what can help, and Review lands on the credit failure far down", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await leaveFirstOpen(window);
    await acceptPlainTextKeys(window);
    await sortWithChatModel(window, ["Alpha", "Beta", "Gamma", "Delta"]);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "en");

    const files: string[] = [];
    for (const folder of ["Alpha", "Beta", "Gamma", "Delta"]) {
      for (let at = 1; at <= 8; at++) {
        const path = join(sources, `${folder} ${at}.txt`);
        await writeFile(path, `${folder} notes ${at}.`);
        files.push(path);
      }
    }
    const creditPath = join(sources, "Alpha credit check.txt");
    await writeFile(creditPath, "The account is out of credit.");
    const networkPath = join(sources, "Alpha network check.txt");
    await writeFile(
      networkPath,
      pastThePlansExcerpt("Alpha notes, read slowly", "The model stays unreachable."),
    );
    files.push(creditPath, networkPath);
    await addDocuments(window, files);
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");

    // The 32 it sorted wait in the Review; once they are confirmed, Not in a Folder's head
    // counts the two it couldn't: a credit failure and one the model couldn't reach.
    await expect(window.getByTestId("organize-waiting")).toContainText("32 Documents to confirm", {
      timeout: 120_000,
    });
    await confirmWaiting(window);
    expect(await filedCounts(window)).toEqual({ Alpha: 8, Beta: 8, Gamma: 8, Delta: 8 });
    const header = library.getByTestId("library-organize-failed");
    await expect(header).toHaveText("2 Documents not organized · Try again", {
      timeout: 60_000,
    });
    await expect(header.getByRole("button")).toHaveText(["Try again"]);

    // Try again sends only the one the model couldn't reach: the credit failure can't be helped
    // by sending it again, so the Review proposes a Folder for one Document.
    await pointAndClick(window, header.getByRole("button"));
    await expect(window.getByTestId("organize-running")).toBeVisible({ timeout: 30_000 });
    const review = window.getByTestId("organize-review");
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(window.getByTestId("organize-review-row")).toHaveCount(1);
    await expect(window.getByTestId("organize-review-name")).toHaveText(["Alpha network check"]);
    await pointAndClick(window, window.getByTestId("organize-review-confirm"));
    await expect(review).toHaveCount(0);
    await expect(header).toHaveText("1 Document not organized: no credit left");
    await expect(header.getByRole("button")).toHaveCount(0);

    // Review lands on it below the four Folders' sections, its row in view with its cause.
    const creditId = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const documents = await core.listDocuments();
      return (
        documents.find((document) => document.name.startsWith("Alpha credit check"))?.id ?? null
      );
    });
    if (creditId === null) throw new Error("The credit Document isn't in the Library.");
    const press = await pressReview(window, creditId);
    expect(press.selected).toBe(creditId);
    const geometry = await window.evaluate((id) => {
      const panel = document.querySelector('[data-testid="library"]');
      const scroller = panel?.querySelector<HTMLElement>(":scope > div");
      const row = panel?.querySelector<HTMLElement>(
        `[data-testid="library-document"][data-document-id="${CSS.escape(id)}"]`,
      );
      const cause = row?.querySelector<HTMLElement>('[data-testid="library-not-sorted"]');
      if (!scroller || !row || !cause) return null;
      const view = scroller.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const causeBox = cause.getBoundingClientRect();
      return {
        scrollTop: scroller.scrollTop,
        view: { top: view.top, bottom: view.bottom },
        row: { top: rowBox.top, bottom: rowBox.bottom },
        cause: { top: causeBox.top, bottom: causeBox.bottom },
      };
    }, creditId);
    if (!geometry) throw new Error("The credit Document's row or its cause isn't drawn.");
    expect(geometry.scrollTop).toBeGreaterThan(300);
    expect(geometry.row.top).toBeGreaterThanOrEqual(geometry.view.top);
    expect(geometry.row.bottom).toBeLessThanOrEqual(geometry.view.bottom);
    expect(geometry.cause.top).toBeGreaterThanOrEqual(geometry.view.top);
    expect(geometry.cause.bottom).toBeLessThanOrEqual(geometry.view.bottom);
    await screenshot(window, "review-attention-en-1440-credit-row-below-folders");
  } finally {
    await app.close();
  }
});
