import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { createFakeOpenAI, type FakeOpenAIServer } from "../tests/helpers/fakeOpenAI";
import {
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  signInWithChatGpt,
  urlsOpened,
} from "./app";

/*
 * "Continue with ChatGPT" opened the browser, but the browser can't come back to IncarnaMind:
 * the User pastes the address it ended on. A local stand-in for OpenAI signs in, and the
 * browser is stood in for, so OpenAI's page never loads and the loopback port is never reached.
 * A plan is no longer added in IncarnaMind (#3767): the plan here was saved before, and its
 * sign-in ended since, so its own page in Accounts and keys signs in again.
 */

let dataDir: string;
let openai: FakeOpenAIServer;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  openai = await createFakeOpenAI();
});
test.afterEach(async () => {
  await openai.close();
  await removeDataFolder(dataDir);
});

/** The address the browser ends on once the User approves on OpenAI's page. */
async function addressAfterApproving(app: ElectronApplication): Promise<string> {
  await expect.poll(() => urlsOpened(app)).toHaveLength(1);
  const [authorize] = await urlsOpened(app);
  return openai.redirectFor(authorize ?? "", { approve: {} }).href;
}

/** The field and Continue sit on one row, and the problem line under the field. */
async function expectFieldRow(field: Locator, button: Locator, problem: Locator) {
  const [box, continueBox, problemBox] = await Promise.all([
    field.boundingBox(),
    button.boundingBox(),
    problem.boundingBox(),
  ]);
  if (!box || !continueBox || !problemBox) throw new Error("The paste field isn't laid out.");
  expect(Math.abs(box.y + box.height / 2 - (continueBox.y + continueBox.height / 2))).toBeLessThan(
    1,
  );
  expect(continueBox.x).toBeGreaterThan(box.x + box.width);
  expect(problemBox.y).toBeGreaterThanOrEqual(box.y + box.height);
  expect(problemBox.x).toBeCloseTo(box.x, 0);
}

const exchanges = () =>
  openai.tokenRequests.filter((request) => request.grant_type === "authorization_code");

/** A saved ChatGPT plan signed out since: its page from Accounts and keys, Continue to press. */
async function signedOutPlan(app: ElectronApplication, window: Page): Promise<Locator> {
  await signInWithChatGpt(app, window, openai);
  const providerId = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.signOutOfChatGpt();
    return (await core.listChatProviders()).find((provider) => provider.kind === "chatgpt")?.id;
  });
  await interceptOpenExternal(app);
  const settings = await openSettings(window, "ai");
  await settings.locator(`[data-testid="provider-row"][data-provider-id="${providerId}"]`).click();
  const plan = settings.getByTestId("chatgpt-settings");
  await expect(plan.getByTestId("chatgpt-continue")).toBeEnabled();
  return plan;
}

test("Settings: a pasted address that isn't the sign-in's is said under the field; the right one signs in", async () => {
  const { app, window } = await launchApp(dataDir, { chatGpt: openai.endpoints.issuer });
  try {
    await setWindowSize(app, window, 900, 660);
    await dismissChatSetup(window);
    const plan = await signedOutPlan(app, window);
    const settings = window.getByTestId("settings");
    const before = exchanges().length;
    await plan.getByTestId("chatgpt-continue").click();
    const address = await addressAfterApproving(app);

    await expect(plan).toContainText("Didn’t come back? Paste the address the browser shows");
    const open = plan.getByTestId("chatgpt-paste-open");
    await open.click();
    const field = plan.getByTestId("chatgpt-paste-address");
    await expect(field).toBeFocused();
    // Esc closes the field only; Enter on the link opens it again.
    await field.press("Escape");
    await expect(field).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(open).toBeFocused();
    await open.press("Enter");
    await expect(field).toBeFocused();

    const elsewhere = new URL(address);
    elsewhere.hostname = "localhost";
    await field.fill(elsewhere.href);
    await field.press("Enter");
    const problem = plan.getByTestId("chatgpt-paste-problem");
    await expect(problem).toHaveText("That isn’t the sign-in address.");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expectFieldRow(field, plan.getByTestId("chatgpt-paste-continue"), problem);
    await expect(plan.getByTestId("chatgpt-cancel")).toBeVisible();
    expect(exchanges()).toHaveLength(before);

    // As copied, with spaces and quotes around it.
    await field.fill(`  "${address}" `);
    await expect(problem).toBeHidden();
    await plan.getByTestId("chatgpt-paste-continue").click();
    await expect(plan.getByTestId("chatgpt-account")).toHaveText(
      "Signed in as reader@example.com.",
    );
    await expect(plan.getByTestId("chatgpt-paste")).toHaveCount(0);
    expect(exchanges()).toHaveLength(before + 1);
  } finally {
    await app.close();
  }
});

test("in Chinese: an earlier sign-in's address is refused, and the address from this one signs in", async () => {
  const { app, window } = await launchApp(dataDir, { chatGpt: openai.endpoints.issuer });
  try {
    await setWindowSize(app, window, 1100, 660);
    const setup = await signedOutPlan(app, window);
    await setLanguage(window, "zh-CN");
    const before = exchanges().length;
    await setup.getByTestId("chatgpt-continue").click();
    const address = await addressAfterApproving(app);

    await expect(setup).toContainText("没有回到 IncarnaMind？粘贴浏览器地址栏里的地址");
    await setup.getByRole("button", { name: "粘贴浏览器地址栏里的地址" }).click();
    const field = setup.getByTestId("chatgpt-paste-address");
    await expect(field).toBeFocused();
    // Esc closes the field only, not what it sits in.
    await field.press("Escape");
    await expect(field).toBeHidden();
    await expect(setup).toBeVisible();
    await setup.getByTestId("chatgpt-paste-open").click();

    const earlier = new URL(address);
    earlier.searchParams.set("state", "from-an-earlier-sign-in");
    await field.fill(earlier.href);
    await field.press("Enter");
    const problem = setup.getByTestId("chatgpt-paste-problem");
    await expect(problem).toHaveText(
      "这个地址来自之前的一次登录。在刚打开的页面上登录后，再粘贴地址栏里的地址。",
    );
    const button = setup.getByTestId("chatgpt-paste-continue");
    await expect(button).toHaveText("继续");
    await expectFieldRow(field, button, problem);
    expect(exchanges()).toHaveLength(before);

    await field.fill(address);
    await button.click();
    await expect(setup.getByTestId("chatgpt-paste")).toHaveCount(0);
    await expect(setup.getByTestId("chatgpt-account")).toBeVisible();
    await expect(setup.getByTestId("chatgpt-continue")).toHaveCount(0);
    expect(exchanges()).toHaveLength(before + 1);
  } finally {
    await app.close();
  }
});
