import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { COMMON_FIELDS, SENDER_FIELDS, USAGE_EVENTS } from "../src/core/usageEvents";
import {
  askInAssistant,
  assistantAnswers,
  closeSettings,
  createDataFolder,
  examplesMenu,
  flushUsageData,
  launchApp,
  leaveFirstOpen,
  newMind,
  openPrivacySettings,
  pointAndClick,
  removeDataFolder,
  showSettingsPage,
  useLocalChatModel,
} from "./app";

interface SentEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

/** A stand-in for PostHog on this computer: it keeps every request it is sent. */
async function startFakePostHog() {
  const requests: { path: string; events: SentEvent[] }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const text = (
      request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body
    ).toString();
    let events: SentEvent[] = [];
    try {
      events = (JSON.parse(text) as { batch?: SentEvent[] }).batch ?? [];
    } catch {
      // Not a batch: recorded with no events, and the test fails on its path.
    }
    requests.push({ path: request.url ?? "", events });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    host: `http://127.0.0.1:${port}`,
    requests,
    events: () => requests.flatMap((each) => each.events),
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

type FakePostHog = Awaited<ReturnType<typeof startFakePostHog>>;

let dataDir: string;
/** A home folder for the app, so nothing it writes there is the User's. */
let home: string;
let posthog: FakePostHog;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  posthog = await startFakePostHog();
});
test.afterEach(async () => {
  await posthog.close();
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

/** Each event holds exactly its declared fields, the common ones and PostHog's own, and nothing of the User's. */
function expectOnlyDeclared(events: readonly SentEvent[]) {
  for (const sent of events) {
    const declared = USAGE_EVENTS[sent.event as keyof typeof USAGE_EVENTS];
    expect(declared, sent.event).toBeDefined();
    expect(Object.keys(sent.properties).sort()).toEqual(
      [...Object.keys(declared), ...Object.keys(COMMON_FIELDS), ...SENDER_FIELDS].sort(),
    );
    expect(sent.properties).toMatchObject({ $ip: "0.0.0.0", $process_person_profile: false });
  }
  expect(JSON.stringify(events)).not.toContain(dataDir);
}

/** Asks the failing Question, then a real one: only the Answer that arrives counts. */
async function askOwnQuestion(window: Page, card: Locator): Promise<void> {
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Send a blank reply");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "failed", {
    timeout: 15_000,
  });
  await expect(card).toBeHidden();
  await askInAssistant(window, "Where does tea come from?");
  await expect(card).toBeHidden();
  await leaveFirstOpen(window);
}

const releaseOptions = () => ({
  home,
  usageData: { host: posthog.host },
  examples: true,
  fakeChat: true,
});

test("a release build asks after the first Answer to the User's own Question, sends nothing when declined, and only what is declared once allowed", async () => {
  const { app, window } = await launchApp(dataDir, releaseOptions());

  // A first run asks nothing before the example, nor does an Answer that fails.
  const card = window.getByTestId("usage-data-card");
  await expect(window.getByTestId("first-open-steps")).toBeVisible();
  await expect(card).toBeHidden();
  await useLocalChatModel(window);
  await askOwnQuestion(window, card);

  // Asked in the sidebar, under Get started, with what is sent in place.
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-tester", "false");
  await expect(card).toContainText("Help improve IncarnaMind?");
  await expect(window.getByTestId("usage-data-examples")).toBeHidden();
  await card.getByTestId("usage-data-what").click();
  await expect(card.getByTestId("usage-data-examples")).toContainText("A Question was asked");
  await expect(card).toContainText("Change it any time in Settings → Privacy.");
  await expect(card.getByRole("link", { name: "See every event" })).toBeVisible();
  const sendBox = await card.getByTestId("usage-data-send").boundingBox();
  const declineBox = await card.getByTestId("usage-data-decline").boundingBox();
  expect(sendBox?.width).toBeCloseTo(declineBox?.width ?? 0, 0);

  // Declined: nothing is sent, whatever the User does.
  await card.getByTestId("usage-data-decline").click();
  await expect(card).toBeHidden();
  const privacy = await openPrivacySettings(window);
  await expect(privacy).toContainText("collects usage data only if you agree");
  const row = privacy.locator('[data-testid="network-traffic-item"][data-traffic-id="usage-data"]');
  await expect(row).toContainText("PostHog (127.0.0.1)");
  const usageSwitch = row.getByTestId("usage-data-switch");
  await expect(usageSwitch).not.toBeChecked();
  await flushUsageData(app);
  expect(posthog.requests).toEqual([]);
  await app.close();

  // Asked once: not again, even after another Answer.
  const second = await launchApp(dataDir, releaseOptions());
  await expect(second.window.getByTestId("mind-list-item")).toHaveCount(1);
  await askInAssistant(second.window, "Where does tea come from?");
  await expect(second.window.getByTestId("usage-data-card")).toBeHidden();
  await flushUsageData(second.app);
  expect(posthog.requests).toEqual([]);

  // Turned on in Settings → Privacy: events arrive, holding only what is declared.
  const reopened = await openPrivacySettings(second.window);
  const switchAgain = reopened.getByTestId("usage-data-switch");
  await switchAgain.check();
  await expect(switchAgain).toBeChecked();
  await showSettingsPage(second.window, "search");
  await expect
    .poll(() => posthog.events().map((each) => each.event), { timeout: 10_000 })
    .toContain("settings_page_viewed");
  expect(posthog.requests.every((each) => each.path === "/batch/")).toBe(true);
  const viewed = posthog.events().find((each) => each.event === "settings_page_viewed");
  expect(viewed?.properties).toMatchObject({ page: "search", build: "release" });
  expectOnlyDeclared(posthog.events());

  // Resetting the install ID: later events carry a new one.
  await showSettingsPage(second.window, "privacy");
  const before = viewed?.distinct_id;
  await second.window.getByTestId("usage-data-reset-id").click();
  await showSettingsPage(second.window, "general");
  await expect
    .poll(() => posthog.events().at(-1)?.distinct_id, { timeout: 10_000 })
    .not.toBe(before);

  // Turned off: nothing more is sent.
  await showSettingsPage(second.window, "privacy");
  await expect.poll(() => posthog.events().at(-1)?.properties).toMatchObject({ page: "privacy" });
  const sent = posthog.events().length;
  await second.window.getByTestId("usage-data-switch").uncheck();
  await showSettingsPage(second.window, "models");
  await closeSettings(second.window);
  await newMind(second.window);
  await flushUsageData(second.app);
  expect(posthog.events()).toHaveLength(sent);
  await second.app.close();
});

test("a release waits for the steps: with them open the card comes at the next launch (#123)", async () => {
  const first = await launchApp(dataDir, releaseOptions());
  await useLocalChatModel(first.window);
  await askInAssistant(first.window, "Where does tea come from?");
  await expect(first.window.getByTestId("first-open-steps")).toBeVisible();
  await expect(first.window.getByTestId("usage-data-card")).toBeHidden();
  await flushUsageData(first.app);
  expect(posthog.requests).toEqual([]);
  await first.app.close();

  const again = await launchApp(dataDir, releaseOptions());
  await expect(again.window.getByTestId("usage-data-card")).toBeVisible();
  await again.app.close();
});

test("nothing is sent or kept to send before Send; after it, an example opened carries its group only", async () => {
  const { app, window } = await launchApp(dataDir, releaseOptions());
  const card = window.getByTestId("usage-data-card");

  // An example opened before the question: its event is neither sent nor kept.
  const examples = await examplesMenu(window);
  await pointAndClick(window, examples.locator('[data-group="meetings"]'));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await useLocalChatModel(window);
  await askOwnQuestion(window, card);
  await expect(card).toBeVisible();
  await flushUsageData(app);
  expect(posthog.requests).toEqual([]);

  await card.getByTestId("usage-data-send").click();
  await expect(card).toBeHidden();
  // The Examples row is only in the quiet first open; the example Mind's banner has the others.
  await leaveFirstOpen(window);
  await pointAndClick(
    window,
    window.locator('[data-testid="example-more-link"][data-group="contracts"]').first(),
  );
  await expect
    .poll(() => posthog.events().map((each) => each.event), { timeout: 10_000 })
    .toContain("example_opened");
  await flushUsageData(app);
  const opened = posthog.events().filter((each) => each.event === "example_opened");
  expect(opened).toHaveLength(1);
  expect(opened[0]?.properties).toMatchObject({ group: "contracts" });
  expectOnlyDeclared(posthog.events());
  await app.close();
});

test("a test build says so from the first run, in the sidebar, with the switch, and stops at once when it is turned off", async () => {
  const { app, window } = await launchApp(dataDir, {
    home,
    usageData: { host: posthog.host, testerBuild: true },
    examples: true,
  });

  const card = window.getByTestId("usage-data-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-tester", "true");
  await expect(card).toContainText("This test version sends usage data");
  const usageSwitch = card.getByTestId("usage-data-switch");
  await expect(usageSwitch).toBeChecked();
  await card.getByTestId("usage-data-what").click();
  await expect(card.getByTestId("usage-data-examples")).toBeVisible();
  // On by default, as testers agree when they join: the app's opening is sent.
  await expect
    .poll(() => posthog.events().map((each) => each.event), { timeout: 10_000 })
    .toContain("app_opened");
  expect(posthog.events()[0]?.properties).toMatchObject({ build: "tester" });
  expectOnlyDeclared(posthog.events());

  // Turned off in the notice: nothing more is sent, and the notice stays until hidden.
  await flushUsageData(app);
  const sent = posthog.events().length;
  await usageSwitch.uncheck();
  await expect(usageSwitch).not.toBeChecked();
  await expect(card).toBeVisible();
  const privacy = await openPrivacySettings(window);
  const row = privacy.locator('[data-traffic-id="usage-data"]');
  await expect(row.getByTestId("usage-data-switch")).not.toBeChecked();
  await expect(row).toContainText("this test version");
  await closeSettings(window);
  await card.getByTestId("usage-data-hide").click();
  await expect(card).toBeHidden();
  await flushUsageData(app);
  expect(posthog.events()).toHaveLength(sent);
  await app.close();

  const again = await launchApp(dataDir, {
    home,
    usageData: { host: posthog.host, testerBuild: true },
    examples: true,
  });
  await expect(again.window.getByTestId("home")).toBeVisible();
  await again.window.getByTestId("mind-tab").click();
  await expect(again.window.getByTestId("first-open-steps")).toBeVisible();
  await expect(again.window.getByTestId("usage-data-card")).toBeHidden();
  await again.app.close();
});
