import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  boxesOverlap,
  boxOf,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";
import { callTool } from "./canvases";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * An outside agent replaces a picture and a chart in the User's Note by their names (#3429): the
 * old one struck and the new one underlined, each one change, until the User accepts it. The home
 * folder is a temporary one. Set INCARNAMIND_SCREENSHOTS to a folder to also save stills.
 */

let dataDir: string;
let sources: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const pier = (fill: string, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160"><rect width="480" height="160" fill="${fill}"/><text x="24" y="92" font-family="Helvetica" font-size="32" fill="white">${label}</text></svg>`;

test("an agent's picture swap and corrected chart wait in the User's Note, old struck and new underlined, until accepted", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 1280, 900);
    const costs = join(sources, "Fuel.md");
    await writeFile(
      costs,
      "# Fuel\n\nFuel cost 2.7 million in 2025.\n\nFuel cost 3.1 million in 2026.\n",
    );
    await writeFile(join(sources, "pier-2025.svg"), pier("#5b6b7a", "Pier, 2025"));
    await writeFile(join(sources, "pier-2026.svg"), pier("#2f7d6d", "Pier, 2026"));
    const harbour = await window.evaluate(async (path) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await bridge.createLibraryGroup({ name: "Harbour", description: "Ferries." });
      await bridge.addDocuments([path], { groupId: folder.id });
      return folder.id;
    }, costs);
    await expectReadyDocuments(window, 1);
    await acceptPlainTextKeys(window);
    const launch = await window.evaluate(async (folderId) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setAgentsEnabled(true);
      return (
        await bridge.connectAgent({ name: "Ferry agent", folderIds: [folderId], propose: true })
      ).launch;
    }, harbour);
    const agent = new Client({ name: "test-agent", version: "1.0.0" });
    await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));

    let copyId = "";
    try {
      const found = await callTool<{ passages: { passageId: string }[] }>(agent, "search", {
        query: "fuel cost million",
      });
      const passageId = found.passages[0]?.passageId;
      const cited = await callTool<{ citations: { cite: string | null }[] }>(agent, "cite", {
        citations: [
          { passageId, quote: "Fuel cost 2.7 million in 2025" },
          { passageId, quote: "Fuel cost 3.1 million in 2026" },
        ],
      });
      const [before, now] = cited.citations.map((each) => each.cite ?? "");
      // Written with 2026 wrong, as the check would find it.
      const made = await callTool<{ mindId: string }>(agent, "create_mind", {
        title: "Fuel report",
        markdown: [
          `Fuel cost more in 2026 ${now}.`,
          "",
          `![Pier](${join(sources, "pier-2025.svg")})`,
          "",
          "| Year | Fuel (million) |",
          "|---|---|",
          `| 2025 | 2.7 ${before} |`,
          `| 2026 | 3.4 ${now} |`,
          "",
          "```chart",
          '{"kind": "bar", "title": "Fuel cost"}',
          "```",
        ].join("\n"),
      });
      // A copy the User makes is theirs: the agent's changes there wait for them.
      copyId = await window.evaluate(
        async (mindId) =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.duplicateMind(
              mindId,
            )
          ).id,
        made.mindId,
      );
      const read = await callTool<{ version: string; markdown: string }>(agent, "read_mind", {
        mindId: copyId,
        named: true,
      });
      const picture = /(¶\d+) !\[Pier\]/.exec(read.markdown)?.[1];
      const cell = /(¶\d+) 3\.4 (\[cite:[^\]]+\])/.exec(read.markdown);
      const chart = /(¶\d+) ```chart\n/.exec(read.markdown)?.[1];
      expect([picture, cell?.[1], chart]).toEqual(["¶2", "¶8", "¶9"]);
      const proposed = await callTool<{ status: string; waiting: number }>(
        agent,
        "propose_changes",
        {
          mindId: copyId,
          version: read.version,
          changes: [
            { paragraph: picture, text: `![Pier](${join(sources, "pier-2026.svg")})` },
            { paragraph: cell?.[1], text: `3.1 ${cell?.[2]}` },
            { paragraph: chart, text: '```chart\n{"kind": "bar", "title": "Fuel cost"}\n```' },
          ],
        },
      );
      expect(proposed).toMatchObject({ status: "waiting", waiting: 3 });
    } finally {
      await agent.close();
    }

    expect(copyId).not.toBe("");
    await pointAndClick(
      window,
      window.getByTestId("mind-list-item").filter({ hasText: "Fuel report (copy)" }),
    );
    const editor = window.getByTestId("mind-editor");
    await expect(window.getByTestId("proposals-count")).toHaveText("3 changes waiting");
    const pictures = editor.locator(".mind-picture-block");
    // A change's class lands on the element around a picture's or a chart's own.
    const around = (block: Locator) => block.locator("xpath=..");
    const charts = editor.getByTestId("chart");
    await expect(pictures).toHaveCount(2);
    await expect(charts).toHaveCount(2);
    // The old one faded and labelled on its frame, the new one under it underlined in the accent.
    await expect(around(pictures.nth(0))).toHaveClass(/proposal-node--delete/);
    await expect(around(pictures.nth(0))).toHaveAttribute("data-removed", "Removed");
    await expect(around(pictures.nth(1))).toHaveClass(/proposal-node--insert/);
    await expect(around(charts.nth(0))).toHaveClass(/proposal-node--delete/);
    await expect(around(charts.nth(1))).toHaveClass(/proposal-node--insert/);
    const value = (chart: Locator, shown: string) =>
      chart.getByRole("button", { name: new RegExp(`^2026: ${shown.replace(".", "\\.")} `) });
    await expect(value(charts.nth(0), "3.4")).toBeVisible();
    await expect(value(charts.nth(1), "3.1")).toBeVisible();
    // Drawn from the table as its change leaves it, the new chart's table hasn't changed.
    await expect(charts.nth(1)).not.toContainText("The table changed");
    await expect(charts.nth(0)).not.toContainText("The table changed");

    // Docked at the page's foot, a change's bar stands clear of the pill that asks the agent.
    const bar = window.getByTestId("change-bar");
    const pill = window.locator("[data-ask-pill]");
    for (const width of [900, 1280]) {
      await setWindowSize(app, window, width, 900);
      await pointAndClick(window, pictures.nth(1));
      await expect(bar).toBeVisible();
      await expect(pill).toBeVisible();
      await expect
        .poll(async () => boxesOverlap(await boxOf(bar), await boxOf(pill)), `at ${width}`)
        .toBe(false);
    }
    await expect(window.getByTestId("change-bar-author")).toHaveText("Proposed by Ferry agent");
    await shot(window, "agent-visuals-picture-en-light");
    // The old one's frame in view, with the new one under it.
    const fromTop = (block: Locator) =>
      block.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await fromTop(charts.nth(0));
    await shot(window, "agent-visuals-chart-en-light");

    await setLanguage(window, "zh-CN");
    await expect(around(pictures.nth(0))).toHaveAttribute("data-removed", "已删除");
    await window.emulateMedia({ colorScheme: "dark" });
    await fromTop(pictures.nth(0));
    await shot(window, "agent-visuals-picture-zh-CN-dark");
    await fromTop(charts.nth(0));
    await shot(window, "agent-visuals-chart-zh-CN-dark");
    await window.emulateMedia({ colorScheme: "light" });
    await setLanguage(window, "en");

    await pointAndClick(window, window.getByTestId("proposals-accept-all"));
    await expect(window.getByTestId("proposals-count")).toHaveCount(0);
    await expect(pictures).toHaveCount(1);
    await expect(charts).toHaveCount(1);
    await expect(value(charts.first(), "3.1")).toBeVisible();
    // Drawn from the table as the change left it: with it accepted, they agree.
    await expect(charts.first()).not.toContainText("The table changed");
  } finally {
    await app.close();
  }
});
