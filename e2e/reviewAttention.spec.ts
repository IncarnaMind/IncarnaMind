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
      const path = join(sources, `Invoice ${at}.txt`);
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
    await pointAndClick(window, library.getByTestId("library-review-not-sorted"));

    // One line for the group, not the provider's sentence in every row.
    const line = library.getByTestId("library-review-problem");
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute("data-kind", "credit");
    await expect(line).toContainText("Your OpenAI key is out of credit");
    await expect(line.getByRole("button")).toHaveText(["Add credit", "Try again"]);
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
    await expect(line).toContainText("你的 OpenAI 密钥额度已用完");
    await expect(line.getByRole("button")).toHaveText(["充值", "重试"]);
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

    // Add credit opens the company's billing page; Try again sorts them once it is added.
    await pointAndClick(window, line.getByTestId("library-review-problem-fix"));
    await expect
      .poll(() => urlsOpened(app))
      .toContain("https://platform.openai.com/settings/organization/billing/overview");
    await pointAndClick(window, line.getByTestId("library-review-problem-retry"));
    await expect(library.getByTestId("library-review-unsorted")).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(library.getByTestId("library-review-problem")).toHaveCount(0);
    await expect(attentionOf(window)).toHaveCount(0);
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
    await expect(fallback).toContainText("Organize couldn’t sort 2 Documents");
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
