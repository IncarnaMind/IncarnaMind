import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import { type CoreBridge, NOT_IN_A_FOLDER_ID } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import { WorkbookBuilder } from "../tests/helpers/financeWorkbooks";
import {
  acceptPlainTextKeys,
  checkCard,
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

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Settings › Agents is hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * A workbook Claude Code handed over while no AI model is set up in IncarnaMind (#3536): Home and
 * the file's own Note say the same thing about it, before Claude Code checks it and after.
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

const FINANCE = "# Finance notes\n\nRent for 2026 is 14000.\n\nInsurance for 2026 is 2200.\n";

function budget(): Buffer {
  const book = new WorkbookBuilder();
  book
    .sheet("Plan")
    .text("A1", "Item")
    .text("B1", "2026")
    .text("A2", "Rent")
    .number("B2", 14000)
    .text("A3", "Insurance")
    .number("B3", 2300);
  return book.xlsx();
}

for (const language of ["en", "zh-CN"] as const) {
  // protects=with only the User's own AI and no model in IncarnaMind, a handed-over file's Note says what Home says before its check, and shows the marks Claude Code's own check left after it (#3536); fails_when=the Note says its claims haven't been found, or offers only a model's Find claims, while Home counts sentences to check, or the card ignores the agent's marks
  test(`a workbook handed over with no model (${language}): Home and its Note agree, before and after Claude Code checks it`, async () => {
    test.setTimeout(180_000);
    const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
      translate(language, key, values);
    const { app, window } = await launchApp(dataDir, { home });
    await dismissChatSetup(window);
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      await writeFile(join(sources, "Finance notes.md"), FINANCE);
      await window.evaluate(
        async (paths) => {
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments(
            paths,
          );
        },
        [join(sources, "Finance notes.md")],
      );
      await expectReadyDocuments(window, 1);
      await acceptPlainTextKeys(window);
      const launch = await window.evaluate(async (unfiled) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.setAgentsEnabled(true);
        return (
          await bridge.connectAgent({
            name: "Claude Code",
            client: "claude-code",
            folderIds: [unfiled],
            propose: true,
          })
        ).launch;
      }, NOT_IN_A_FOLDER_ID);
      const agent = new Client({ name: "test-agent", version: "1.0.0" });
      await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));

      const book = join(sources, "Budget.xlsx");
      await writeFile(book, budget());
      const handed = await callTool<{ mindId: string; status: string }>(agent, "hand_over_file", {
        path: book,
      });
      expect(handed.status).toBe("not-checked");

      await window.getByTestId("sidebar-home").click();
      const next = window.getByTestId("home-next-step");
      await expect(next).toHaveAttribute("data-step", "check");
      const toCheck = t("health.toCheck", { count: 2 });
      await expect(next).toContainText(toCheck);

      await pointAndClick(
        window,
        window
          .locator(`[data-testid="mind-row"][data-mind-id="${handed.mindId}"]`)
          .locator("button")
          .first(),
      );
      const card = await checkCard(window);
      await expect(card.getByTestId("verify-to-check")).toHaveText(toCheck);

      const given = await callTool<{ task: string; sentences: { n: number; text: string }[] }>(
        agent,
        "check_mind_yourself",
        { mindId: handed.mindId },
      );
      const { passages } = await callTool<{ passages: { passageId: string }[] }>(agent, "search", {
        query: "rent insurance 2026",
      });
      const cite = async (quote: string) => {
        const { citations } = await callTool<{ citations: { cite: string | null }[] }>(
          agent,
          "cite",
          { citations: passages.map(({ passageId }) => ({ passageId, quote })) },
        );
        return citations.find((each) => each.cite !== null)?.cite;
      };
      const rent = await cite("Rent for 2026 is 14000.");
      const insurance = await cite("Insurance for 2026 is 2200.");
      await callTool(agent, "report_check", {
        mindId: handed.mindId,
        task: given.task,
        results: given.sentences.map((sentence) =>
          sentence.text.startsWith("Rent")
            ? { n: sentence.n, verdict: "supported", cites: [rent] }
            : sentence.text.startsWith("Insurance")
              ? {
                  n: sentence.n,
                  verdict: "contradicted",
                  cites: [insurance],
                  explanation: "The finance notes give insurance for 2026 as 2200.",
                }
              : { n: sentence.n, verdict: "nothing to check" },
        ),
      });
      await agent.close();

      const checked = await checkCard(window);
      await expect(checked.getByTestId("verify-done")).toContainText(t("verify.needLook.one"));
      await expect(checked).not.toContainText(t("verify.notFound"));
      await window.keyboard.press("Escape");
      await window.getByTestId("sidebar-home").click();
      await expect(window.getByTestId("home-next-step")).toHaveAttribute("data-step", "look");
    } finally {
      await app.close();
    }
  });
}
