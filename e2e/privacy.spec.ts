import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { startSourceServices } from "../tests/helpers/sourceServices";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openPrivacySettings,
  pointAndClick,
  removeDataFolder,
  saveProviderUnasked,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("the Privacy page lists the data flows and the update check, and offers no crash reports without a DSN", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // A chat model on a server elsewhere: the chat flow goes to it. Choosing it allows that, and sends nothing.
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      modelId: "example-model",
    });
    // Tagging and sorting by themselves start off for it; turning them on is the consent too.
    await bridge.saveLibrarySettings({ ...(await bridge.getLibrary()).settings, automatic: true });
  });

  const privacy = await openPrivacySettings(window);
  await expect(privacy).toContainText("collects no usage data");
  const statement = privacy.getByTestId("privacy-flows-intro");
  await expect(statement).toContainText("Only these services receive anything");
  await privacy.getByTestId("privacy-flows-intro-details").click();
  await expect(privacy).toContainText("asks it not to store your requests");

  // The statement, then the services, then the switch, then the other traffic.
  const service = privacy.getByTestId("data-service");
  await expect(service).toHaveCount(1);
  await expect(service).toContainText("llm.example.com");
  await expect(service).toHaveAttribute("data-consent", "partly");
  const top = async (locator: Locator) => (await locator.boundingBox())?.y ?? Number.NaN;
  const order = [
    await top(statement),
    await top(service),
    await top(privacy.getByTestId("local-only-setting")),
    await top(privacy.getByTestId("network-traffic")),
  ];
  expect(order).toEqual(order.toSorted((a, b) => a - b));

  // The decision is said once for the service, with what each use sends behind Details.
  const decision = service.getByTestId("data-service-decision");
  await expect(decision).toContainText("Some uses aren’t allowed yet");
  await decision.getByTestId("data-service-decision-details").click();
  await expect(service.locator('[data-flow-id="document-check"]')).toContainText("Not asked yet");
  const chat = service.locator('[data-testid="data-flow"][data-flow-id="chat"]');
  await expect(chat).toContainText("Chat");
  await expect(chat).toContainText(
    "This note’s text, your text and earlier Questions and Answers, minus excluded text",
  );
  await expect(chat).toContainText("passages from your Documents");
  await expect(service.locator('[data-flow-id="tagging"]')).toContainText("Automatic Tags");

  // Stop allowing it, and it asks again next time; the line to take it back is under the list.
  // Not "Revoke", which is 撤销 in Chinese, the same word as Undo (#763).
  const revoke = service.getByTestId("data-service-revoke");
  await expect(revoke).toHaveText("Stop allowing");
  await setLanguage(window, "zh-CN");
  await expect(revoke).toHaveText("停止允许");
  await setLanguage(window, "en");
  await revoke.click();
  await expect(service).toHaveAttribute("data-consent", "not-asked");
  const allow = service.getByTestId("data-service-allow");
  await expect(allow).toBeFocused();
  const undoLine = privacy.getByTestId("consent-settings").getByTestId("undo-line-here");
  await expect(undoLine).toContainText("Stopped allowing llm.example.com");
  await undoLine.getByTestId("undo-action").click();
  await expect(service).toHaveAttribute("data-consent", "partly");
  // Back as it was, chosen, not allowed anew (#1463).
  await expect(decision).toContainText("Some uses aren’t allowed yet");

  // Allowed again from here, with the date.
  await revoke.click();
  await expect(service).toHaveAttribute("data-consent", "not-asked");
  await allow.click();
  await expect(service).toHaveAttribute("data-consent", "accepted");
  await expect(decision).toContainText(/Allowed on \d{1,2} [A-Z][a-z]+ \d{4}/);

  // One use can be stopped on its own, with the rest left allowed, and taken back.
  const tagging = service.locator('[data-testid="data-flow"][data-flow-id="tagging"]');
  await tagging.getByTestId("data-flow-revoke").click();
  await expect(service).toHaveAttribute("data-consent", "partly");
  await expect(chat).toHaveAttribute("data-consent", "accepted");
  await expect(tagging).toHaveAttribute("data-consent", "not-asked");
  await expect(tagging.getByTestId("data-flow-allow")).toBeFocused();
  await expect(undoLine).toContainText("Stopped allowing Automatic Tags for llm.example.com");
  await undoLine.getByTestId("undo-action").click();
  await expect(tagging).toHaveAttribute("data-consent", "accepted");
  await expect(service).toHaveAttribute("data-consent", "accepted");

  // Traffic without the User's content: the update check, on by default, can be turned off.
  const updates = privacy.locator(
    '[data-testid="network-traffic-item"][data-traffic-id="update-check"]',
  );
  await expect(updates).toContainText("GitHub Releases");
  await expect(updates).toHaveAttribute("data-enabled", "true");
  const automatic = updates.getByTestId("automatic-update-checks");
  await expect(automatic).toBeChecked();
  await automatic.uncheck();
  await expect(updates).toHaveAttribute("data-enabled", "false");
  await expect(privacy.locator('[data-traffic-id="ollama-pull"]')).toContainText("Ollama");

  // Skill scripts are their own matter.
  await expect(privacy.getByTestId("skill-scripts-note")).toContainText(
    "unless you set it to Always allow",
  );

  // A copy built without a crash-report address doesn't offer crash reports.
  await expect(privacy.getByTestId("crash-reports")).toHaveCount(0);
  expect(
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return bridge.getPrivacySettings();
    }),
  ).toEqual({
    crashReports: { available: false, enabled: false },
    automaticUpdateChecks: false,
    // Nor usage data: a copy built without an analytics project neither sends it nor asks.
    usageData: {
      available: false,
      enabled: false,
      testerBuild: false,
      asked: false,
      localMode: false,
    },
  });
  await expect(privacy.locator('[data-traffic-id="usage-data"]')).toHaveCount(0);
  await expect(window.getByTestId("usage-data-card")).toBeHidden();

  // In Chinese, what the chat flow sends.
  const language = (value: "en" | "zh-CN") =>
    window.evaluate(
      (chosen) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: chosen },
        }),
      value,
    );
  await language("zh-CN");
  await expect(chat).toContainText(
    "这篇笔记的正文、你写的内容和之前的问题和回答，不含已排除的内容",
  );
  await language("en");
  await app.close();

  // The choice about update checks is kept.
  const second = await launchApp(dataDir);
  const reopened = await openPrivacySettings(second.window);
  await expect(reopened.getByTestId("automatic-update-checks")).not.toBeChecked();
  await second.app.close();
});

/** Searches arXiv through the bridge, as Find sources does. Resolves once the search has ended. */
const searchArxiv = (window: Page, query: string) =>
  window.evaluate(async (words) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.findSources({ query: words, providers: ["arxiv"] });
  }, query);

/** Whether arXiv has a decision of the User's, whatever it is, from the core. */
const arxivDecided = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listDataFlows()).some((each) => each.flow.service.name === "arXiv");
  });

test("stopping the only service, one allowed in an earlier search, leaves its Undo line, and Undo and ⌘Z bring it back as it was, twice", async () => {
  const sources = await startSourceServices();
  try {
    const { app, window } = await launchApp(dataDir, { sources: sources.url });
    await setWindowSize(app, window, 1280, 800);
    await dismissChatSetup(window);
    // The search ends, and arXiv is no part of any flow now: only the User's decision is left.
    const searched = searchArxiv(window, "CRISPR off-target detection");
    await pointAndClick(window, window.getByTestId("consent-allow"));
    await searched;

    const privacy = await openPrivacySettings(window);
    const arxiv = privacy.getByTestId("data-service").filter({ hasText: "arXiv" });
    await expect(arxiv).toHaveAttribute("data-consent", "accepted");
    const decision = arxiv.getByTestId("data-service-decision");
    await expect(decision).toContainText(/Allowed on \d{1,2} [A-Z][a-z]+ \d{4}/);
    const allowedOn = await decision.innerText();

    await pointAndClick(window, arxiv.getByTestId("data-service-revoke"));
    await expect(privacy.getByTestId("data-service")).toHaveCount(0);
    const undoLine = privacy.getByTestId("consent-settings").getByTestId("undo-line-here");
    await expect(undoLine).toContainText("Stopped allowing arXiv");

    // The line's Undo puts it back as it was: allowed in a dialog, on the same day.
    await pointAndClick(window, undoLine.getByTestId("undo-action"));
    await expect(arxiv).toHaveAttribute("data-consent", "accepted");
    await expect(decision).toHaveText(allowedOn);

    // Stopped again, ⌘Z does the same, Redo stops again, and Undo brings it back once more.
    await pointAndClick(window, arxiv.getByTestId("data-service-revoke"));
    await expect(privacy.getByTestId("data-service")).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(arxiv).toHaveAttribute("data-consent", "accepted");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(privacy.getByTestId("data-service")).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(arxiv).toHaveAttribute("data-consent", "accepted");
    await expect(decision).toHaveText(allowedOn);

    // In Chinese, the line names what was stopped.
    await setLanguage(window, "zh-CN");
    await pointAndClick(window, arxiv.getByTestId("data-service-revoke"));
    await expect(undoLine).toContainText("已停止允许 arXiv");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(arxiv).toHaveAttribute("data-consent", "accepted");
    await setLanguage(window, "en");

    // Back as it was, it needs no question: the next search goes straight to arXiv.
    await closeSettings(window);
    const before = sources.requests.filter((request) => request.path.startsWith("/arxiv")).length;
    await searchArxiv(window, "base editing");
    await expect(window.getByTestId("consent-dialog")).toBeHidden();
    expect(
      sources.requests.filter((request) => request.path.startsWith("/arxiv")).length,
    ).toBeGreaterThan(before);
    await app.close();
  } finally {
    await sources.close();
  }
});

test("⌘Z in Settings takes back only a step whose line is on a page in view: not one from a page the User has left", async () => {
  const sources = await startSourceServices();
  try {
    const { app, window } = await launchApp(dataDir, { sources: sources.url });
    await setWindowSize(app, window, 1280, 800);
    await dismissChatSetup(window);
    const searched = searchArxiv(window, "CRISPR off-target detection");
    await pointAndClick(window, window.getByTestId("consent-allow"));
    await searched;

    const privacy = await openPrivacySettings(window);
    const arxiv = privacy.getByTestId("data-service").filter({ hasText: "arXiv" });
    await pointAndClick(window, arxiv.getByTestId("data-service-revoke"));
    await expect(privacy.getByTestId("data-service")).toHaveCount(0);
    await expect(
      privacy.getByTestId("consent-settings").getByTestId("undo-line-here"),
    ).toContainText("Stopped allowing arXiv");

    // On another page the Privacy page stays mounted, hidden: its line isn't in view, so ⌘Z does
    // nothing to a decision the User can't see.
    await showSettingsPage(window, "general");
    await window.keyboard.press("ControlOrMeta+z");
    expect(await arxivDecided(window)).toBe(false);

    // Back on its page, ⌘Z reaches the step, and ⇧⌘Z is held the same way from another page.
    await showSettingsPage(window, "privacy");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(arxiv).toHaveAttribute("data-consent", "accepted");
    await showSettingsPage(window, "general");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    expect(await arxivDecided(window)).toBe(true);
    await showSettingsPage(window, "privacy");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(privacy.getByTestId("data-service")).toHaveCount(0);
    await app.close();
  } finally {
    await sources.close();
  }
});

test("a consent question over Settings is answered only by its own buttons: ⌘Z, ⇧⌘Z and Return on Decline never allow", async () => {
  const sources = await startSourceServices();
  try {
    const { app, window } = await launchApp(dataDir, { sources: sources.url });
    await setWindowSize(app, window, 1280, 800);
    await dismissChatSetup(window);
    const allowed = searchArxiv(window, "CRISPR off-target detection");
    await pointAndClick(window, window.getByTestId("consent-allow"));
    await allowed;
    const requestsToArxiv = () =>
      sources.requests.filter((request) => request.path.startsWith("/arxiv")).length;

    // Stopped in Settings, with its Undo line in view: a search then asks again, over Settings.
    const privacy = await openPrivacySettings(window);
    const arxiv = privacy.getByTestId("data-service").filter({ hasText: "arXiv" });
    await pointAndClick(window, arxiv.getByTestId("data-service-revoke"));
    await expect(privacy.getByTestId("data-service")).toHaveCount(0);
    const before = requestsToArxiv();
    const searching = searchArxiv(window, "base editing");
    const consent = window.getByTestId("consent-dialog");
    await expect(consent).toBeVisible();
    await expect(consent).toContainText("arXiv");
    await expect(consent.getByTestId("consent-decline")).toBeFocused();

    // No key answers it as Allow: the Undo line behind it can't be reached.
    await window.keyboard.press("ControlOrMeta+z");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    expect(await arxivDecided(window)).toBe(false);
    await expect(consent).toBeVisible();
    expect(requestsToArxiv()).toBe(before);

    // Return, on the focused Decline, declines: nothing is sent.
    await window.keyboard.press("Enter");
    await expect(consent).toBeHidden();
    await searching;
    expect(requestsToArxiv()).toBe(before);
    await expect(arxiv).toHaveAttribute("data-consent", "declined");
    await app.close();
  } finally {
    await sources.close();
  }
});

test("a Question refused because the User declined: after allowing the service in Settings, the Answer's line offers Try again and the Question is answered", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await saveProviderUnasked(window, {
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("What is due?");
  await window.keyboard.press("Enter");

  // Nothing is sent: the User says no to the question.
  await pointAndClick(window, window.getByTestId("consent-decline"));
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  const error = answer.getByTestId("answer-error");
  await expect(error).toContainText("Nothing was sent: you chose not to send data to this service");
  const action = error.getByTestId("answer-error-action");
  await expect(action).toHaveText("Allow it");

  // "Allow it" leads to the service on the Privacy page, where it is allowed.
  await pointAndClick(window, action);
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "privacy");
  const anthropic = settings.getByTestId("data-service").filter({ hasText: "Anthropic" });
  await expect(anthropic).toHaveAttribute("data-consent", "declined");
  await pointAndClick(window, anthropic.getByTestId("data-service-allow"));
  await expect(anthropic).toHaveAttribute("data-consent", "accepted");
  await closeSettings(window);

  // Back on the Answer, the line no longer sends the User to Settings again: it offers Try again.
  await expect(action).toHaveText("Try again");
  await setLanguage(window, "zh-CN");
  await expect(action).toHaveText("重试");
  await setLanguage(window, "en");
  await expect(action).toHaveText("Try again");
  await pointAndClick(window, action);
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(error).toBeHidden();
  await expect(window.getByTestId("consent-dialog")).toBeHidden();
  await app.close();
});

/** A stand-in for Sentry on this computer: it keeps every event it is sent. */
async function startFakeSentry(): Promise<{ server: Server; dsn: string; events: string[] }> {
  const events: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const text = (
      request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body
    ).toString();
    // An envelope: a header line, then an item header and its payload, per item.
    const lines = text.split("\n");
    for (let index = 1; index + 1 < lines.length; index += 2) {
      if (JSON.parse(lines[index] ?? "{}").type === "event") events.push(lines[index + 1] ?? "");
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, dsn: `http://public@127.0.0.1:${port}/1`, events };
}

test("each use of a service has a button named for it, a service with one use has only its own, and focus stays on the last button", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      modelId: "example-model",
    });
    await bridge.saveRerankSettings({ kind: "cohere", apiKey: "not-a-real-key" });
  });
  const privacy = await openPrivacySettings(window);
  const services = privacy.getByTestId("data-service");
  await expect(services).toHaveCount(2);
  const cohere = services.filter({ hasText: "Cohere" });
  await cohere.getByTestId("data-service-decision-details").click();
  await expect(cohere.getByTestId("data-flow")).toHaveCount(1);
  await expect(cohere.getByTestId("data-flow-revoke")).toHaveCount(0);
  await expect(cohere.getByTestId("data-service-revoke")).toHaveCount(1);

  const llm = services.filter({ hasText: "llm.example.com" });
  await llm.getByTestId("data-service-decision-details").click();
  await expect(llm.getByRole("button", { name: "Stop allowing Chat", exact: true })).toHaveCount(1);
  const count = await llm.getByTestId("data-flow").count();
  expect(count).toBeGreaterThan(1);
  const allowed = await llm.getByTestId("data-flow-revoke").count();
  for (let stopped = 1; stopped <= allowed; stopped++) {
    await llm.getByTestId("data-flow-revoke").first().click();
    await expect(llm.getByTestId("data-flow-revoke")).toHaveCount(allowed - stopped);
  }
  await expect(llm).toHaveAttribute("data-consent", "not-asked");
  // Every use left can be allowed again, and the focus is on a button of the service, not the page.
  await expect(llm.getByTestId("data-flow-revoke")).toHaveCount(0);
  await expect(llm.getByTestId("data-flow-allow")).toHaveCount(
    await llm.getByTestId("data-flow").count(),
  );
  await expect(llm.locator("button:focus")).toHaveCount(1);
  await app.close();
});

test("with a crash-report address, crash reports are off until opted in, scrubbed, and stop on opting out", async () => {
  const sentry = await startFakeSentry();
  try {
    const { app, window } = await launchApp(dataDir, { sentryDsn: sentry.dsn });
    await dismissChatSetup(window);
    /** An error in the main process that nothing catches, naming a file and quoting a Note. */
    const failInMainProcess = (marker: string) =>
      app.evaluate(({ app: electron }, label) => {
        const file = `${electron.getPath("userData")}/documents/Divorce papers.pdf`;
        void Promise.reject(
          new Error(`${label}: couldn't index ${file}: "Quarterly revenue fell"`),
        );
      }, marker);

    const privacy = await openPrivacySettings(window);
    const crashReports = privacy.getByTestId("crash-reports-switch");
    await expect(crashReports).not.toBeChecked();
    await privacy.getByTestId("crash-reports-description-details").click();
    await expect(privacy.getByTestId("crash-reports")).toContainText("removed first");

    // Off by default: nothing is sent. The first report that arrives, once opted in, is the
    // barrier: anything sent before it is already there to be seen.
    await failInMainProcess("before opting in");

    // Opted in: reports arrive, scrubbed.
    await crashReports.check();
    await expect
      .poll(
        async () => {
          await failInMainProcess("after opting in");
          return sentry.events.length;
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBeGreaterThan(0);
    const [event] = sentry.events;
    expect(event).toContain("after opting in: couldn't index [path]");
    for (const leak of [dataDir, "Divorce", "Quarterly"]) {
      expect(event).not.toContain(leak);
    }
    expect(sentry.events.join("\n")).not.toContain("before opting in");
    const parsed = JSON.parse(event ?? "{}");
    expect(parsed).not.toHaveProperty("user");
    expect(parsed).not.toHaveProperty("server_name");
    expect(parsed.sdk.settings).toEqual({ infer_ip: "never" });
    // Only the integrations IncarnaMind sets up: no sessions, tracing, replays or screenshots.
    expect(parsed.sdk.integrations).toEqual([
      "OnUncaughtException",
      "OnUnhandledRejection",
      "ChildProcess",
      "ElectronBreadcrumbs",
      "ElectronContext",
      "Context",
      "EventFilters",
      "FunctionToString",
      "LinkedErrors",
      "NormalizePaths",
    ]);

    // Opted out: nothing more is sent. Opting in again and waiting for its report is the barrier.
    await crashReports.uncheck();
    await expect(crashReports).not.toBeChecked();
    await failInMainProcess("after opting out");
    await crashReports.check();
    await expect
      .poll(
        async () => {
          await failInMainProcess("opted in again");
          return sentry.events.filter((each) => each.includes("opted in again")).length;
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBeGreaterThan(0);
    expect(sentry.events.join("\n")).not.toContain("after opting out");
    await app.close();
  } finally {
    sentry.server.closeAllConnections();
    await new Promise((resolve) => sentry.server.close(resolve));
  }
});
