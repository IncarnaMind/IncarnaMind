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
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * The sidebar's "Needs attention · Review" (#2308): each press takes the User to the next
 * Document Organize couldn't sort, its row in view with the group's line and its action; once
 * every one was seen the status goes. A failure is one plain line for the group, naming the
 * service Organize sends to, with that cause's action and Try again; a cause the Library can't
 * name is one plain line with Try again. Never the provider's sentence. In English and Chinese,
 * at 900 and 1,440 pixels. Set INCARNAMIND_SCREENSHOTS to save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** A name long enough to cut the cause beside it if the cause gives way first (#2535). */
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

const unsortedRows = (window: Page) =>
  window.getByTestId("library-review-unsorted").getByTestId("library-review-document");

/** The ids of the rows To review lists as not sorted, in the page's order. */
const unsortedIds = (window: Page) =>
  window.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="library-review-unsorted"] [data-testid="library-review-document"]',
      ),
    ].map((row) => row.dataset.documentId ?? ""),
  );

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

test("Review goes to each Document that needs attention, and a credit failure is one plain line for the group", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await leaveFirstOpen(window);
    await acceptPlainTextKeys(window);
    await interceptOpenExternal(app);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test",
        modelId: "fake-model",
      });
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
        automatic: false,
      });
      // The classification flow goes where the model kept for Organize sends.
      const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
      if (flow) await core.allowDataFlow("classification", flow.flow.service.id);
      await core.createLibraryGroup({ name: "Invoice", description: "Invoices" });
    });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "en");

    const files: string[] = [];
    for (let at = 1; at <= 4; at++) {
      const name = at === 4 ? LONG_NAME : `Invoice ${at}`;
      const path = join(sources, `${name}.txt`);
      await writeFile(path, `Invoice ${at} for consulting. The account is out of credit.`);
      files.push(path);
    }
    await addDocuments(window, files);
    await window.getByTestId("open-library").click();
    await pointAndClick(window, window.getByTestId("library").getByTestId("library-organize"));

    const library = window.getByTestId("library");
    const status = attentionOf(window);
    await expect(status).toBeVisible({ timeout: 60_000 });
    await expect(status.getByTestId("status-label")).toHaveText("Needs attention");

    // The Not in a Folder header says the shared cause in words only: the action is on To review's line.
    const header = library.getByTestId("library-organize-failed");
    await expect(header).toHaveText("4 Documents not organized: no credit left");
    await expect(header.getByRole("button")).toHaveCount(0);

    // A row names only the cause, and its tooltip and accessible name carry the whole sentence (#2535).
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

    await pointAndClick(window, library.getByTestId("library-review-not-sorted"));

    // One line for the group, not the provider's sentence in every row.
    const line = library.getByTestId("library-review-problem");
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute("data-kind", "credit");
    await expect(line).toContainText("Your OpenAI key is out of credit");
    await expect(line.getByRole("button")).toHaveText(["Add credit"]);
    await expect(unsortedRows(window)).toHaveCount(4);
    await expect(
      window.getByTestId("library-review-unsorted").getByTestId("library-not-sorted"),
    ).toHaveCount(0);
    const order = await unsortedIds(window);
    expect(order).toHaveLength(4);
    const [firstId = "", secondId = "", thirdId = "", fourthId = ""] = order;

    // The first press from the Library, in English: that Document's row in view, its line showing.
    await screenshot(window, "review-attention-en-1440-status");
    const first = await pressReview(window, firstId);
    expect(first.selected).toBe(firstId);
    expect(first.ms).toBeGreaterThanOrEqual(0);
    expect(first.ms).toBeLessThan(100);
    await screenshot(window, "review-attention-en-1440-first");

    // The second from the Library, in Chinese.
    await setLanguage(window, "zh-CN");
    await expect(header).toHaveText("4 个文档未整理：额度已用完");
    await expect(line).toContainText("你的 OpenAI 密钥额度已用完");
    await expect(line.getByRole("button")).toHaveText(["充值"]);
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
    await expect(line).toContainText("你的 OpenAI 密钥额度已用完");
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

    // Add credit opens the company's billing page; back in the app, they try once by themselves (#2535).
    await pointAndClick(window, line.getByTestId("library-review-problem-fix"));
    await expect
      .poll(() => urlsOpened(app))
      .toContain("https://platform.openai.com/settings/organization/billing/overview");
    await window.evaluate(() => {
      globalThis.dispatchEvent(new Event("focus"));
    });
    await expect(library.getByTestId("library-review-unsorted")).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(library.getByTestId("library-review-problem")).toHaveCount(0);
    await expect(attentionOf(window)).toHaveCount(0);
    // The retry runs on its own: wait for the four to be classified, not only queued.
    await expect
      .poll(
        async () =>
          await window.evaluate(async () => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const [{ assignments }, documents] = await Promise.all([
              core.getLibrary(),
              core.listDocuments(),
            ]);
            return documents
              .filter((document) => /^Invoice \d/.test(document.name))
              .map(
                (document) =>
                  assignments.find((each) => each.documentId === document.id)?.status ?? null,
              );
          }),
        { timeout: 60_000 },
      )
      .toEqual(["classified", "classified", "classified", "classified"]);
    const sorted = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [{ groups, assignments }, documents] = await Promise.all([
        core.getLibrary(),
        core.listDocuments(),
      ]);
      return documents
        .filter((document) => /^Invoice \d/.test(document.name))
        .map((document) => {
          const held = assignments.find((each) => each.documentId === document.id);
          return {
            folder: groups.find((each) => each.id === held?.groupId)?.name ?? null,
            status: held?.status ?? null,
          };
        });
    });
    expect(sorted).toHaveLength(4);
    for (const each of sorted) expect(each).toEqual({ folder: "Invoice", status: "classified" });

    // A cause the Library can't name is still one plain line with Try again, never the provider's words.
    const unreadable: string[] = [];
    for (let at = 1; at <= 2; at++) {
      const path = join(sources, `Field notes ${at}.txt`);
      await writeFile(path, `Field notes ${at}. The server is unreachable.`);
      unreadable.push(path);
    }
    await addDocuments(window, unreadable);
    await pointAndClick(window, library.getByTestId("library-organize"));
    const notSorted = library.getByTestId("library-review-not-sorted");
    await expect(notSorted).toBeVisible({ timeout: 60_000 });
    await pointAndClick(window, notSorted);
    const fallback = library.getByTestId("library-review-problem");
    await expect(fallback).toHaveCount(1);
    await expect(fallback).toHaveAttribute("data-kind", "other");
    await expect(fallback).toContainText("Couldn’t organize 2 Documents");
    await expect(fallback.getByRole("button")).toHaveText(["Try again"]);
    const unsorted = library.getByTestId("library-review-unsorted");
    await expect(unsorted).toBeVisible();
    await expect(unsorted).not.toContainText("Cannot connect to API");
    await setLanguage(window, "zh-CN");
    await expect(fallback).toContainText("“整理”未能处理 2 个文档");
    await expect(fallback.getByRole("button")).toHaveText(["重试"]);
    await expect(unsorted).not.toContainText("Cannot connect to API");
  } finally {
    await app.close();
  }
});

test("Review opens To review past its first rows when a search hides them", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await leaveFirstOpen(window);
    await acceptPlainTextKeys(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test",
        modelId: "fake-model",
      });
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
        automatic: false,
      });
      const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
      if (flow) await core.allowDataFlow("classification", flow.flow.service.id);
      await core.createLibraryGroup({ name: "Invoice", description: "Invoices" });
    });
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
    await pointAndClick(window, library.getByTestId("library-organize"));
    const notSorted = library.getByTestId("library-review-not-sorted");
    await expect(notSorted).toBeVisible({ timeout: 60_000 });
    await pointAndClick(window, notSorted);

    // To review draws the first 8; the ninth is the Document the page doesn't draw yet.
    await expect(unsortedRows(window)).toHaveCount(8);
    const listed = await unsortedIds(window);
    expect(listed).toHaveLength(8);
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

    // A search on before each press hides every row it lists; with more than a fold's worth
    // not sorted, Review still opens the list and lands on the ninth.
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
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test",
        modelId: "fake-model",
      });
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
        automatic: false,
      });
      const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
      if (flow) await core.allowDataFlow("classification", flow.flow.service.id);
      await core.createLibraryGroup({ name: "Invoice", description: "Invoices" });
    });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "en");

    const path = join(sources, "Invoice 1.txt");
    await writeFile(path, "Invoice 1 for consulting. The account is out of credit.");
    await addDocuments(window, [path]);
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    await pointAndClick(window, library.getByTestId("library-organize"));

    // One Document needs attention, and the sidebar says so in the singular (#2535).
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
      .getByTestId("library-review-document")
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

test("mixed causes retry only what can help, and the one credit line stays with a row far down", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await leaveFirstOpen(window);
    await acceptPlainTextKeys(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "openai",
        apiKey: "sk-test",
        modelId: "fake-model",
      });
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "fake-model" } },
        automatic: false,
      });
      const flow = (await core.listDataFlows()).find((each) => each.flow.id === "classification");
      if (flow) await core.allowDataFlow("classification", flow.flow.service.id);
      for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
        await core.createLibraryGroup({ name, description: `Notes about ${name}.` });
      }
    });
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
    const networkPath = join(sources, "Alpha unreachable check.txt");
    await writeFile(networkPath, "The model was unreachable slowly.");
    files.push(creditPath, networkPath);
    await addDocuments(window, files);
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    await pointAndClick(window, library.getByTestId("library-organize"));

    // One credit failure and one the model couldn't reach: Try again can help only the second.
    const header = library.getByTestId("library-organize-failed");
    await expect(header).toHaveText("2 Documents not organized · Try again", {
      timeout: 120_000,
    });
    await expect(header.getByRole("button")).toHaveText(["Try again"]);

    // The first resend fails again, as its first run did; the credit failure is not sent.
    await pointAndClick(window, header.getByRole("button"));
    await expect(library.getByTestId("library-organizing")).toBeVisible({ timeout: 30_000 });
    await expect(header).toHaveText("2 Documents not organized · Try again", {
      timeout: 60_000,
    });

    // The second resend reaches the model: only the credit failure is left, with nothing to retry.
    await pointAndClick(window, header.getByRole("button"));
    await expect(library.getByTestId("library-organizing")).toBeVisible({ timeout: 30_000 });
    await expect(header).toHaveText("1 Document not organized: no credit left", {
      timeout: 60_000,
    });
    await expect(header.getByRole("button")).toHaveCount(0);

    // Four Suggested Folder blocks sit above the one Document left unsorted.
    await pointAndClick(window, library.getByTestId("library-review-not-sorted"));
    await expect(library.getByTestId("library-review-group")).toHaveCount(4);
    const creditLine = library.getByTestId("library-review-credit");
    await expect(creditLine).toHaveCount(1);
    await expect(
      library.locator('[data-testid="library-review-problem"][data-kind="credit"]'),
    ).toHaveCount(1);
    await expect(creditLine).toContainText("Your OpenAI key is out of credit");
    await expect(creditLine.getByTestId("library-review-problem-fix")).toHaveText("Add credit");

    const creditId = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const documents = await core.listDocuments();
      return (
        documents.find((document) => document.name.startsWith("Alpha credit check"))?.id ?? null
      );
    });
    if (creditId === null) throw new Error("The credit Document isn't in the Library.");

    // Review lands on it far below the Suggested Folder blocks; its one line and action come too.
    const press = await pressReview(window, creditId);
    expect(press.selected).toBe(creditId);
    const geometry = await window.evaluate((id) => {
      const panel = document.querySelector('[data-testid="library"]');
      const scroller = panel?.querySelector<HTMLElement>(":scope > div");
      const wrapper = document.querySelector<HTMLElement>('[data-testid="library-review-credit"]');
      const row = document.querySelector<HTMLElement>(
        `[data-review] [data-document-id="${CSS.escape(id)}"]`,
      );
      if (!scroller || !wrapper || !row) return null;
      const view = scroller.getBoundingClientRect();
      const line = wrapper.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const action = wrapper.querySelector<HTMLElement>(
        '[data-testid="library-review-problem-fix"]',
      );
      const actionBox = action?.getBoundingClientRect() ?? null;
      return {
        scrollTop: scroller.scrollTop,
        view: { top: view.top, bottom: view.bottom },
        line: { top: line.top, bottom: line.bottom },
        row: { top: rowBox.top, bottom: rowBox.bottom },
        action: actionBox ? { top: actionBox.top, bottom: actionBox.bottom } : null,
      };
    }, creditId);
    if (!geometry) throw new Error("The credit line, its action or the row isn't drawn.");
    expect(geometry.scrollTop).toBeGreaterThan(300);
    expect(Math.abs(geometry.line.top - geometry.view.top)).toBeLessThanOrEqual(2);
    expect(geometry.line.bottom).toBeLessThanOrEqual(geometry.view.bottom);
    expect(geometry.row.top).toBeGreaterThanOrEqual(geometry.view.top);
    expect(geometry.row.bottom).toBeLessThanOrEqual(geometry.view.bottom);
    if (!geometry.action) throw new Error("Add credit isn't drawn on the credit line.");
    expect(geometry.action.top).toBeGreaterThanOrEqual(geometry.view.top);
    expect(geometry.action.bottom).toBeLessThanOrEqual(geometry.view.bottom);
    await screenshot(window, "review-attention-en-1440-credit-line-below-blocks");
  } finally {
    await app.close();
  }
});
