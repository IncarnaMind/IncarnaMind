import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import { type CoreBridge, NOT_IN_A_FOLDER_ID } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { WorkbookBuilder } from "../tests/helpers/financeWorkbooks";
import { buildPdf } from "../tests/helpers/pdf";
import { plainDeck } from "../tests/helpers/pptx";
import {
  acceptPlainTextKeys,
  checkAssistantWrites,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  motionSettled,
  openDocumentMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
  useLocalChatModel,
} from "./app";
import { callTool } from "./canvases";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * What the card and the Note show for a deck and a workbook Claude Code handed over (#3493): the
 * Note marks where each slide starts; the card asks Claude Code to fix everything its check flagged
 * in one request, and a claim's card asks it first and offers no fix of words that aren't the file;
 * a conclusion shows its check's mark; a workbook's differing formula is named by its row and
 * column, counted alike on the badge and in the card, and a flagged row's card says the whole row;
 * the file's row in the sidebar says what it is and offers to cite it, not to cite it "again". The
 * scripted model (src/main/fakeChat/) finds a claim contradicted when it shares three words with a
 * Document's line and has a number the line doesn't. The app opens nothing: each link it would
 * open is recorded. Set INCARNAMIND_SCREENSHOTS to a folder to also save stills there.
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
      "Neap tides come 7 days after spring tides.",
      "Spring tides happen at new moon and at full moon.",
    ],
  },
]);
const FINANCE =
  "# Finance notes\n\nRent for 2026 is 14000 and for 2027 14000.\n\nInsurance for 2026 is 2200 and for 2027 2500.\n";

/** A deck: its title slide, a slide with a wrong figure, and one with another. */
const DECK = plainDeck([
  { title: "Harbour review" },
  {
    lines: [
      "Harbours publish the times of high water every 6 months.",
      "Spring tides happen at new moon and at full moon.",
    ],
  },
  { lines: ["Neap tides come 9 days after spring tides."] },
]);

/** Two rows of typed-in numbers, Insurance's 2027 wrong, and a total whose 2027 result is saved wrong. */
function budget(): Buffer {
  const book = new WorkbookBuilder();
  book
    .sheet("Plan")
    .text("A1", "Item")
    .text("B1", "2026")
    .text("C1", "2027")
    .text("A2", "Rent")
    .number("B2", 14000)
    .number("C2", 14000)
    .text("A3", "Insurance")
    .number("B3", 2200)
    .number("C3", 2300)
    .text("A4", "Total")
    .formula("B4", "SUM(B2:B3)", 16200)
    .formula("C4", "SUM(C2:C3)", 17300);
  return book.xlsx();
}

/** Claude Code, connected as its own setup does, reading the files in no Folder. */
async function claudeCode(window: Page): Promise<Client> {
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
  return agent;
}

/** The prompt a recorded link would have typed in Claude Code. */
const typedIn = (url: string | undefined) =>
  new URL(url ?? "about:blank").searchParams.get("q") ?? "";

for (const language of ["en", "zh-CN"] as const) {
  const words =
    language === "en"
      ? {
          slides: ["Slide 1", "Slide 2", "Slide 3"],
          askAll: "Ask Claude Code to fix 2",
          asked: "Fix the 2 things IncarnaMind flagged in the file “Harbour review”.",
          ask: "Ask Claude Code to fix it",
          handedHint:
            "Claude Code made this for you to check; it isn’t a source until you cite it.",
          cite: "Cite this Document",
          differs: "Total · 2027: saved 17,300, worked out 16,300",
          needLook: "2 need a look",
        }
      : {
          slides: ["第 1 张幻灯片", "第 2 张幻灯片", "第 3 张幻灯片"],
          askAll: "交给 Claude Code 修改这 2 句",
          asked: "把 IncarnaMind 在文件“Harbour review”里标出来的 2 处改好。",
          ask: "交给 Claude Code 修改",
          handedHint: "Claude Code 制作的文件，供你核对；你引用它之前，它不作为来源。",
          cite: "作为引用来源",
          differs: "Total · 2027：保存的是 17,300，重新计算为 16,300",
          needLook: "2 条需要留意",
        };

  test(`a deck and a workbook Claude Code handed over (${language}): the card asks Claude Code, and the Note marks the slides`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir, { home, fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    // A hand-over is checked as it lands only with this on (#3576).
    await checkAssistantWrites(window);
    try {
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      await writeFile(join(sources, "Tides.pdf"), TIDES);
      await writeFile(join(sources, "Finance notes.md"), FINANCE);
      await window.evaluate(
        async (paths) => {
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments(
            paths,
          );
        },
        [join(sources, "Tides.pdf"), join(sources, "Finance notes.md")],
      );
      await expectReadyDocuments(window, 2);
      const agent = await claudeCode(window);

      const deck = join(sources, "Harbour review.pptx");
      await writeFile(deck, DECK);
      const handed = await callTool<{ mindId: string; needLook: number }>(agent, "hand_over_file", {
        path: deck,
      });
      expect(handed.needLook).toBe(2);
      const row = window.locator(`[data-testid="mind-row"][data-mind-id="${handed.mindId}"]`);
      await pointAndClick(window, row.locator("button").first());

      // Where each slide starts, drawn above its first line.
      await expect(frontMind(window).getByTestId("slide-break")).toHaveText(words.slides);

      // The card asks Claude Code to fix both, in one request; a conclusion shows its mark.
      const card = await checkCard(window);
      await expect(
        card.locator('[data-testid="verify-brief-conclusion"][data-mark="contradicted"]'),
      ).not.toHaveCount(0);
      const askAll = card.getByTestId("badge-ask-agent-all");
      await expect(askAll).toHaveText(words.askAll);
      await shot(window, `handed-card-deck-${language}`);
      await pointAndClick(window, askAll);
      await expect.poll(() => urlsOpened(app)).toHaveLength(1);
      expect(typedIn((await urlsOpened(app))[0])).toBe(words.asked);

      // A claim's card asks Claude Code first and offers no fix of words that aren't the file.
      await pointAndClick(
        window,
        frontMind(window).locator('[data-testid="claim-mark"][data-check="contradicted"]').first(),
      );
      const claim = window.getByTestId("claim-card");
      await expect(claim.getByTestId("claim-ask-agent")).toHaveText(words.ask);
      await expect(claim.getByTestId("claim-fix")).toHaveCount(0);
      await shot(window, `handed-claim-card-${language}`);
      await window.keyboard.press("Escape");

      // The file's row says what it is, and offers to cite it.
      const file = window.getByTestId("document-list-item").filter({ hasText: "Harbour review" });
      await expect(file.getByTestId("document-not-cited")).toHaveAttribute(
        "title",
        words.handedHint,
      );
      await openDocumentMenu(file);
      await expect(file.getByTestId("document.citeAgain")).toHaveText(words.cite);
      await window.keyboard.press("Escape");

      // A workbook: its differing formula is named by its row and column, and counted alike.
      const book = join(sources, "Budget.xlsx");
      await writeFile(book, budget());
      const sheet = await callTool<{ mindId: string }>(agent, "hand_over_file", { path: book });
      await agent.close();
      await pointAndClick(
        window,
        window
          .locator(`[data-testid="mind-row"][data-mind-id="${sheet.mindId}"]`)
          .locator("button")
          .first(),
      );
      const bookCard = await checkCard(window);
      await expect(bookCard.getByTestId("verify-formula-differs")).toContainText(words.differs);
      await expect(bookCard.getByTestId("verify-done")).toContainText(words.needLook);
      const badge = window.getByTestId("check-badge");
      const counted = await badge
        .locator(".check-badge-mark")
        .evaluateAll((parts) =>
          parts.reduce((sum, part) => sum + (Number(part.textContent?.replace(/\D/g, "")) || 0), 0),
        );
      expect(counted).toBe(2);
      await shot(window, `handed-card-workbook-${language}`);
      await window.keyboard.press("Escape");

      // A flagged row's card says the whole row, with the figure that is wrong.
      await pointAndClick(
        window,
        frontMind(window).locator('[data-testid="claim-mark"][data-check="contradicted"]').first(),
      );
      await expect(window.getByTestId("claim-card").getByTestId("claim-sentence")).toContainText(
        "Insurance | 2200 | 2300",
      );
      await shot(window, `handed-row-card-${language}`);
    } finally {
      await app.close();
    }
  });
}
