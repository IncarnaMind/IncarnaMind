import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { createFakeOpenAI, signInAt } from "../tests/helpers/fakeOpenAI";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  openSettings,
  removeDataFolder,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * Settings has six pages (General, Models, Search, Connectors, Skills, Privacy;
 * Meetings and Memory join with their first setting), and every setting there was before is on one of them. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save a screenshot of each page.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** Each page, its name in the list, and the sections on it. */
const ALL_PAGES = [
  {
    page: "general",
    name: "General",
    sections: [
      "language-settings",
      "spending-cap-settings",
      "motion-settings",
      "output-location-settings",
      "data-folder-settings",
      "about-settings",
    ],
  },
  {
    page: "models",
    name: "Models",
    sections: [
      "model-defaults",
      "your-providers",
      "plans-settings",
      "chatgpt-settings",
      "tagging-settings",
      "jev-settings",
    ],
  },
  { page: "search", name: "Search", sections: ["embedding-settings", "rerank-settings"] },
  { page: "meetings", name: "Meetings", sections: ["meetings-settings"] },
  { page: "connectors", name: "Connectors", sections: ["connectors-settings"] },
  {
    page: "skills",
    name: "Skills",
    sections: ["skills-settings", "skills-yours", "skills-built-in", "skill-scripts-settings"],
  },
  { page: "agents", name: "Agents", sections: ["agents-settings"] },
  {
    page: "privacy",
    name: "Privacy",
    sections: ["consent-settings", "network-traffic", "approvals-settings"],
  },
] as const;

const shown = (page: string) => page !== "agents" || SHOW_AGENT_CONNECTION;
const PAGES = ALL_PAGES.filter((each) => shown(each.page));

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

test("Settings lists its pages, and each holds its settings", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.getByRole("button", { name: "Settings" }).click();
    const settings = window.getByTestId("settings");
    const nav = settings.getByTestId("settings-nav");
    await expect(nav.getByRole("button")).toHaveText(PAGES.map((each) => each.name));

    for (const { page, name, sections } of PAGES) {
      await nav.getByRole("button", { name, exact: true }).click();
      await expect(settings).toHaveAttribute("data-page", page);
      await expect(settings.getByTestId("settings-page-title")).toHaveText(name);
      const content = settings.getByTestId(`settings-page-${page}`);
      for (const section of sections) {
        await expect(content.getByTestId(section), `${name}: ${section}`).toBeAttached();
      }
      await shot(window, `settings-${page}`);
      if (page === "models") {
        await content.getByTestId("tagging-settings").scrollIntoViewIfNeeded();
        await shot(window, "settings-models-tagging");
      }
    }
  } finally {
    await app.close();
  }
});

test("a press on the dimmed area closes Settings, and one inside it doesn't", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1280, 800);
    await window.getByRole("button", { name: "Settings" }).click();
    const settings = window.getByTestId("settings");
    await expect(settings).toBeVisible();

    // Inside: a page's name switches the page and leaves Settings open.
    await settings.getByTestId("settings-nav-models").click();
    await expect(settings).toHaveAttribute("data-page", "models");
    await expect(settings).toBeVisible();

    // Outside: the press lands on the dimmed area, clear of Settings, and closes it.
    const box = await settings.boundingBox();
    if (!box) throw new Error("Settings isn't on the page.");
    expect(box.x).toBeGreaterThan(24);
    await window.mouse.click(box.x - 24, box.y + box.height / 2);
    await expect(settings).toBeHidden();
  } finally {
    await app.close();
  }
});

test("the list of pages works by keyboard, with a focus ring", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.getByRole("button", { name: "Settings" }).click();
    const settings = window.getByTestId("settings");
    const models = settings.getByTestId("settings-nav-models");
    // Tab reaches the list the way a keyboard user would (a focus() call shows no ring).
    for (let step = 0; step < 12; step += 1) {
      if (await models.evaluate((each) => each === document.activeElement)) break;
      await window.keyboard.press("Tab");
    }
    await expect(models).toBeFocused();
    expect(await models.evaluate((each) => getComputedStyle(each).outlineStyle)).not.toBe("none");
    await window.keyboard.press("Enter");
    await expect(settings).toHaveAttribute("data-page", "models");
    await window.keyboard.press("Tab");
    await expect(settings.getByTestId("settings-nav-search")).toBeFocused();
    await window.keyboard.press("Space");
    await expect(settings).toHaveAttribute("data-page", "search");
  } finally {
    await app.close();
  }
});

test("Organize in the Library, with no model chosen yet, opens Models, where Tagging is", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    const sources = await createDataFolder();
    try {
      const path = join(sources, "Harbour notes.txt");
      await writeFile(path, "Notes on the harbour.\n");
      await addDocuments(window, [path]);
    } finally {
      await removeDataFolder(sources);
    }
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createLibraryGroup({
        name: "Harbour",
        description: "",
      }),
    );
    await window.getByTestId("open-library").click();
    await window.getByTestId("library").getByTestId("library-organize").click();
    await window.getByTestId("library").getByTestId("library-organize-set-up").click();
    const settings = window.getByTestId("settings");
    await expect(settings).toHaveAttribute("data-page", "models");
    await expect(settings.getByTestId("tagging-settings")).toBeAttached();
  } finally {
    await app.close();
  }
});

test("the pages are named in Chinese too", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.evaluate(async () =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "zh-CN" },
      }),
    );
    await window.getByRole("button", { name: "设置" }).click();
    const nav = window.getByTestId("settings-nav");
    const chinese = (
      [
        ["general", "通用"],
        ["models", "模型"],
        ["search", "搜索"],
        ["meetings", "会议"],
        ["connectors", "连接器"],
        ["skills", "技能"],
        ["agents", "智能体"],
        ["privacy", "隐私"],
      ] as const
    ).filter(([page]) => shown(page));
    await expect(nav.getByRole("button")).toHaveText(chinese.map(([, name]) => name));
    for (const [page] of chinese) {
      await window.getByTestId(`settings-nav-${page}`).click();
      await expect(window.getByTestId("settings")).toHaveAttribute("data-page", page);
      if (page === "models")
        await expect(window.getByTestId("settings-page-title")).toHaveText("模型");
      await shot(window, `settings-${page}-zh`);
      if (page === "models") {
        await window.getByTestId("tagging-settings").scrollIntoViewIfNeeded();
        await shot(window, "settings-models-tagging-zh");
      }
    }
  } finally {
    await app.close();
  }
});

test("signed in with ChatGPT, the plan's model is chosen in one place: the Answers default", async () => {
  // A local stand-in for OpenAI: the sign-in and the account's models, with no network or account.
  const openai = await createFakeOpenAI();
  const { app, window } = await launchApp(dataDir, { chatGpt: openai.endpoints.issuer });
  try {
    await dismissChatSetup(window);
    await interceptOpenExternal(app);
    const settings = await openSettings(window, "models");
    const plan = settings.getByTestId("chatgpt-settings");
    await acceptPlainTextKeys(window, plan);
    await plan.getByTestId("chatgpt-continue").click();
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    const [authorize] = await urlsOpened(app);
    expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
    await window.getByTestId("chatgpt-welcome-ok").click();
    await expect(plan.getByTestId("chatgpt-account")).toHaveText(
      "Signed in as reader@example.com.",
    );

    // With no model before, the plan became the default: Answers offers the account's models.
    await expect(settings.getByTestId("provider-row")).toHaveText([/^ChatGPT plan/]);
    const model = settings.getByRole("combobox", { name: "Answers" });
    await expect(model.locator("option")).toHaveText([
      "GPT-6.1 Sol · ChatGPT plan",
      "GPT-6 Luna · ChatGPT plan",
    ]);
    await expect(model).toHaveValue(/\ngpt-6\.1-sol$/);

    // The plan's own section keeps the account, its usage, a test and Sign out: no second model choice.
    await expect(plan.getByTestId("chatgpt-in-use")).toContainText("Using ChatGPT plan");
    await expect(plan.getByTestId("chatgpt-manage-usage")).toBeVisible();
    await expect(plan.getByRole("combobox")).toHaveCount(0);
    await expect(plan.getByTestId("chatgpt-use")).toHaveCount(0);
    await expect(plan.getByTestId("chatgpt-test")).toBeVisible();
    await expect(plan.getByTestId("chatgpt-sign-out")).toBeVisible();

    // Another of the plan's models, chosen there, becomes the default.
    await model.selectOption({ label: "GPT-6 Luna · ChatGPT plan" });
    await expect
      .poll(async () =>
        window.evaluate(async () => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          return (await bridge.getSettings()).user.chatModel?.modelId;
        }),
      )
      .toBe("gpt-6-luna");
    await expect(model).toHaveValue(/\ngpt-6-luna$/);
  } finally {
    await app.close();
    await openai.close();
  }
});
