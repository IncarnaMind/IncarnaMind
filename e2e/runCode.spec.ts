import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  addDocuments,
  askInAssistant,
  assistantAnswers,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * An Analysis on whole files in the OS sandbox (`run_code`, ADR-0025), in the built app: bash on a
 * copy of a log, and Python waiting on IncarnaMind's own runtime as it downloads the first time,
 * from a stand-in release that stalls, so the step says how far it has come and then, in plain
 * words, why it couldn't be had. The Linux smoke runners have no bubblewrap, so code has no OS
 * sandbox there and the Tool isn't offered; the nightly run covers macOS.
 */
const NO_SANDBOX =
  "The Linux smoke runners have no bubblewrap: code has no OS sandbox there, so run_code isn't offered.";

const LOG = ["GET /a 200", "GET /b 500", "GET /c 500", "POST /d 201", ""].join("\n");
const ORDERS = ["region,amount", "North,1", "South,2", ""].join("\n");

/** Sends the first 1.2 MB of a 3 MB runtime and nothing more, as a release that stalls would. */
async function stallingRelease(): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": 3_000_000 });
    response.write(Buffer.alloc(1_200_000, 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/python-runtime-darwin-arm64.tar.zst`, server };
}

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

async function launch(language: "en" | "zh-CN", runtime: string | null) {
  const launched = await launchApp(dataDir, {
    fakeChat: true,
    sandboxed: true,
    // Claude Haiku 5.5 is offered run_code by the shipped catalog (#2351).
    ...(runtime && { extraEnv: { INCARNAMIND_TEST_PYTHON_RUNTIME: runtime } }),
  });
  const { app, window } = launched;
  await setWindowSize(app, window, 1200, 760);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  const core = await coreOf(window);
  await core.evaluate((bridge) =>
    bridge.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    }),
  );
  await core.evaluate(
    (bridge, chosen) => bridge.updateSettings({ user: { language: chosen } }),
    language,
  );
  await writeFile(join(sources, "server.log.txt"), LOG);
  await writeFile(join(sources, "orders.csv"), ORDERS);
  await addDocuments(window, [join(sources, "server.log.txt"), join(sources, "orders.csv")]);
  for (const name of ["server.log", "orders"]) {
    await expect(
      window.getByTestId("document-list-item").filter({ hasText: name }).first(),
    ).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  }
  await newMind(window);
  return launched;
}

const shot = async (window: Page, name: string) => {
  const folder = process.env.INCARNAMIND_RUN_CODE_EVIDENCE_DIR;
  if (folder) await window.screenshot({ path: join(folder, `${name}.png`) });
};

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);

  test(`${language}: bash looks at a log on its copy, as an Analysis, and its numbers never reach the Answer`, async () => {
    test.skip(process.platform !== "darwin", NO_SANDBOX);
    test.setTimeout(120_000);
    const { app, window } = await launch(language, null);
    try {
      const answer = await askInAssistant(
        window,
        language === "en"
          ? "How many errors are in the log server.log?"
          : "server.log 日志里有多少个错误？",
      );
      // This copy has no Python to count with, and bash's own count is never typed in.
      const text = answer.getByTestId("assistant-answer-text");
      await expect(text).toHaveText(
        language === "en"
          ? "I looked at the log's error lines, but Python couldn't run this time to count them."
          : "我看了日志里的错误行，但这次无法运行 Python 来数清有多少。",
      );
      await pointAndClick(window, answer.getByTestId("answer-steps"));
      await expect(answer.getByTestId("answer-timeline")).toContainText(
        t("analysis.call.ran", { document: "server.log" }),
      );
      await shot(window, `bash-${language}`);
    } finally {
      await app.close();
    }
  });

  test(`${language}: Python's first download shows its progress where the User asked, then why it couldn't come`, async () => {
    test.skip(process.platform !== "darwin", NO_SANDBOX);
    test.setTimeout(180_000);
    const release = await stallingRelease();
    const manifest = join(sources, "runtime.json");
    await writeFile(
      manifest,
      JSON.stringify({
        file: "python-runtime-darwin-arm64.tar.zst",
        url: release.url,
        size: 3_000_000,
        sha256: "c".repeat(64),
        platform: `${process.platform}-${process.arch}`,
        python: "3.14.10",
        packages: {},
      }),
    );
    const { app, window } = await launch(language, manifest);
    try {
      await window.keyboard.press("ControlOrMeta+j");
      await window.keyboard.type(
        language === "en"
          ? "What do the amounts in orders.csv add up to over every row?"
          : "orders.csv 订单所有行的金额合计是多少？",
      );
      await window.keyboard.press("Enter");
      const answer = assistantAnswers(window).last();
      await expect(answer.getByTestId("answer-steps-live")).toContainText(
        t("analysis.call.preparing", { downloaded: 1, total: 3 }),
        { timeout: 30_000 },
      );
      await shot(window, `python-downloading-${language}`);
      await expect(answer).toHaveAttribute("data-status", "done", { timeout: 90_000 });
      await expect(answer).toContainText(
        language === "en" ? "Python couldn't run this time." : "这次无法运行 Python。",
      );
      await pointAndClick(window, answer.getByTestId("answer-steps"));
      await expect(answer.getByTestId("answer-timeline")).toContainText(
        t("analysis.unavailable.python", { reason: t("embedding.model.failure.network") }),
      );
      await shot(window, `python-failed-${language}`);
    } finally {
      await app.close();
      release.server.closeAllConnections();
      await new Promise<void>((resolve) => release.server.close(() => resolve()));
    }
  });

  test(`${language}: Settings › Skills says why the sandbox for analyses and scripts can't start, and how to fix it`, async () => {
    const launched = await launchApp(dataDir, {
      extraEnv: {
        INCARNAMIND_TEST_SANDBOX_PROBLEM: JSON.stringify({
          kind: "missing",
          packages: ["bubblewrap", "socat", "ripgrep"],
        }),
      },
    });
    const { app, window } = launched;
    try {
      await setWindowSize(app, window, 900, 700);
      await dismissChatSetup(window);
      // Opened by its English name, then shown in the language under test.
      await openSettings(window, "skills");
      await (await coreOf(window)).evaluate(
        (bridge, chosen) => bridge.updateSettings({ user: { language: chosen } }),
        language,
      );
      const problem = window.getByTestId("code-sandbox-problem");
      await problem.scrollIntoViewIfNeeded();
      await expect(problem).toContainText(
        t("scripts.settings.problem.sandboxMissing", {
          packages: t("list.and", {
            first: language === "zh-CN" ? "bubblewrap、socat" : "bubblewrap, socat",
            last: "ripgrep",
          }),
        }),
      );
      await expect(
        problem.getByRole("button", { name: t("analysis.unavailable.noSandbox.fix") }),
      ).toBeVisible();
      await shot(window, `settings-problem-${language}`);
    } finally {
      await app.close();
    }
  });
}
