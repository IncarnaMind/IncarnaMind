import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { buildPdf } from "../tests/helpers/pdf";
import { plainDeck } from "../tests/helpers/pptx";
import {
  checkCard,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMindName,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";
import { callTool, connectCanvasAgent } from "./canvases";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Settings › Agents is hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * A deck an agent made and handed over (#3412): each version's check is a Note of its own, and its
 * card says which agent handed it over and which version it is, how many claims kept the version
 * before's result, with a press to check every claim again, and opens the other versions. The
 * scripted model (src/main/fakeChat/) finds a claim contradicted when it shares three words with a
 * Document's line and has a number the line doesn't. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save stills there.
 */

let dataDir: string;
let home: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(sources);
});

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const TIDES = buildPdf([
  {
    lines: [
      "Harbour times",
      "Harbours publish the times of high water every 12 months.",
      "Spring tides happen at new moon and at full moon.",
    ],
  },
]);
const WRONG = "Harbours publish the times of high water every 6 months.";
const RIGHT = "Harbours publish the times of high water every 12 months.";
const SPRING = "Spring tides happen at new moon and at full moon.";

for (const language of ["en", "zh-CN"] as const) {
  const words =
    language === "en"
      ? {
          name: "Checking version 2: Harbour review",
          firstName: "Checking version 1: Harbour review",
          second: "From Claude Code · version 2 of 2",
          first: "From Claude Code · version 1 of 2",
          kept: "1 claim kept its result from version 1",
          checkAll: "Check every claim again",
          open: ["Version 1", "Version 2"],
        }
      : {
          name: "核对第 2 版：Harbour review",
          firstName: "核对第 1 版：Harbour review",
          second: "来自 Claude Code · 第 2 版，共 2 版",
          first: "来自 Claude Code · 第 1 版，共 2 版",
          kept: "1 条说法沿用第 1 版的结果",
          checkAll: "重新核对全部说法",
          open: ["第 1 版", "第 2 版"],
        };

  test(`a deck an agent handed over twice (${language}): each version's check names the agent and its version, and opens the other`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, { home, fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      const tides = join(sources, "Tides.pdf");
      await writeFile(tides, TIDES);
      await window.evaluate(async (path) => {
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments([
          path,
        ]);
      }, tides);
      await expectReadyDocuments(window, 1);
      const agent = await connectCanvasAgent(window);

      const deck = join(sources, "Harbour review.pptx");
      await writeFile(deck, plainDeck([{ title: "Harbour review" }, { lines: [WRONG, SPRING] }]));
      const first = await callTool<{ version: number; mindId: string; needLook: number }>(
        agent,
        "hand_over_file",
        { path: deck },
      );
      expect(first).toMatchObject({ version: 1, needLook: 1 });
      await writeFile(deck, plainDeck([{ title: "Harbour review" }, { lines: [RIGHT, SPRING] }]));
      const second = await callTool<{ version: number; mindId: string; needLook: number }>(
        agent,
        "hand_over_file",
        { path: deck },
      );
      expect(second).toMatchObject({ version: 2, needLook: 0 });
      await agent.close();

      const row = window.locator(`[data-testid="mind-row"][data-mind-id="${second.mindId}"]`);
      await pointAndClick(window, row.locator("button").first());
      await expect(frontMindName(window)).toHaveText(words.name);
      const card = await checkCard(window);
      const handed = card.getByTestId("verify-handed");
      await expect(handed).toContainText(words.second);
      // The spring tides line stood as it was: it kept version 1's result.
      await expect(handed).toContainText(words.kept);
      await shot(window, `handed-version-2-${language}`);
      const checkAll = handed.getByTestId("verify-handed-check-all");
      await expect(checkAll).toHaveText(words.checkAll);
      await pointAndClick(window, checkAll);
      await expect(handed).not.toContainText(words.kept);
      await expect(checkAll).toHaveCount(0);

      const other = handed.getByTestId("verify-handed-version");
      await expect(other).toHaveText([words.open[0] ?? ""]);
      await pointAndClick(window, other);
      await expect(frontMindName(window)).toHaveText(words.firstName);
      const firstCard = await checkCard(window);
      await expect(firstCard.getByTestId("verify-handed")).toContainText(words.first);
      await expect(firstCard.getByTestId("verify-handed-version")).toHaveText([
        words.open[1] ?? "",
      ]);
      await shot(window, `handed-version-1-${language}`);
    } finally {
      await app.close();
    }
  });
}
