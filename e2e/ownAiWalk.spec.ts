import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import { type CoreBridge, NOT_IN_A_FOLDER_ID } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import { WorkbookBuilder } from "../tests/helpers/financeWorkbooks";
import {
  acceptPlainTextKeys,
  boxOf,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
  writeNote,
} from "./app";
import { callTool } from "./canvases";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * Walking the app with only the User's own AI connected and no AI model set up (#3536):
 * 1. A workbook Claude Code handed over: Home, the corner badge and the check card agree before
 *    Claude Code checks it (offering Check, not Find claims) and after its marks land.
 * 2. A Note outside the Folders Claude Code reads: no top model line, its foot and check card
 *    say Claude Code can't read this note and offer Move to… and Settings › AI, ⌘J focuses Move
 *    to…, and moving it into a shared Folder brings up asking at once.
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
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`), animations: "disabled" });
}

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
  // protects=with only the User's own AI and no model in IncarnaMind, a handed-over file's badge and card agree with Home before its check (offering Check, not Find claims) and show the marks Claude Code left after it (#3536); fails_when=the card says its claims haven't been found or offers Find claims while Home counts sentences to check, or the card ignores the agent's marks
  test(`a workbook handed over with no model (${language}): Home, badge and card agree before and after Claude Code checks it`, async () => {
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
      await expect(frontMind(window)).toHaveAttribute("data-mind-id", handed.mindId);
      const badge = window.getByTestId("check-badge");
      await expect(badge).toContainText("2");
      await expect(badge).toContainText(t("badge.toCheck"));

      const card = await checkCard(window);
      await expect(card.getByTestId("verify-to-check")).toHaveText(toCheck);
      await expect(card.getByTestId("verify-find")).toHaveCount(0);
      const checkBtn = card.getByTestId("verify-check-own-ai");
      await expect(checkBtn).toHaveText(t("mindCheck.command"));
      await shot(window, `handed-before-${language}`);

      // Pressing Check asks Claude Code directly instead of failing for a missing model.
      await pointAndClick(window, checkBtn);
      await expect.poll(() => urlsOpened(app)).toHaveLength(1);
      await expect(card.getByTestId("checks-asked")).toBeVisible();
      await expect(card.getByTestId("verify-problem")).toHaveCount(0);

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
      await expect(checked.getByTestId("verify-contradicted")).toBeVisible();
      await expect(badge).toContainText("1");
      await shot(window, `handed-after-${language}`);
      await window.keyboard.press("Escape");

      await window.getByTestId("sidebar-home").click();
      await expect(window.getByTestId("home-next-step")).toHaveAttribute("data-step", "look");
    } finally {
      await app.close();
    }
  });

  // protects=with only the User's own AI connected and no model, a Note outside its shared Folders says that AI can't read it and offers Move to… and Settings › AI, ⌘J focuses Move to…, and moving it into a shared Folder brings up asking at once (#3536); fails_when=the Note shows a model-setup line or says Asking needs your AI · Connect your AI while an AI is already connected, or Move to… does not let the User move it into a shared Folder
  test(`a Note outside the Folders your AI reads (${language}): says so, offers Move to…, and brings up asking once moved`, async () => {
    test.setTimeout(120_000);
    const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
      translate(language, key, values);
    const { app, window } = await launchApp(dataDir, { home });
    await acceptPlainTextKeys(window);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);

      const folderName = "Kestrel Bay";
      const docPath = join(sources, "Finance notes.md");
      await writeFile(docPath, FINANCE);
      const folderId = await window.evaluate(
        async ([name, path]) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const folder = await bridge.createLibraryGroup({ name, description: "" });
          await bridge.addDocuments([path], { groupId: folder.id });
          await bridge.setAgentsEnabled(true);
          await bridge.connectAgent({
            name: "Claude Code",
            client: "claude-code",
            folderIds: [folder.id],
            propose: true,
          });
          return folder.id;
        },
        [folderName, docPath] as const,
      );
      await expectReadyDocuments(window, 1);

      // A new Note lands in Not in a Folder, outside the Folder Claude Code reads.
      const mindId = await writeNote(window, "Draft notes", [
        { text: "Rent for 2026 is 14000 according to the lease." },
      ]);
      await pointAndClick(
        window,
        window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
      );
      await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);

      const group = window.locator('[data-testid="tab-group"][data-focused]');
      await expect(window.getByTestId("chat-readiness")).toHaveCount(0);
      await expect(group.getByTestId("note-ask")).toHaveCount(0);
      await expect(group.getByTestId("own-ai-pill")).toHaveCount(0);

      const footLine = group.getByTestId("note-ask-no-ai");
      await expect(footLine).toContainText(t("noteAsk.cantRead.one", { agent: "Claude Code" }));
      await expect(footLine).not.toContainText(t("noteAsk.noAi"));
      await expect(footLine.getByTestId("note-ask-move")).toHaveText(t("mind.moveTo"));
      await expect(footLine.getByTestId("note-ask-settings")).toHaveText(
        t("meetings.notesAgent.settings"),
      );
      const page = await boxOf(group.getByTestId("mind-scroller"));
      expect((await boxOf(footLine)).y).toBeGreaterThanOrEqual(page.y + page.height - 1);
      await shot(window, `cant-read-1440-${language}`);

      await setWindowSize(app, window, 900, 760);
      await shot(window, `cant-read-900-${language}`);
      await setWindowSize(app, window, 1440, 900);

      // ⌘J focuses Move to….
      await window.keyboard.press("ControlOrMeta+j");
      await expect(footLine.getByTestId("note-ask-move")).toBeFocused();

      // Checking this Note also says Claude Code can't read it instead of asking to connect an AI.
      const card = await checkCard(window);
      await pointAndClick(window, card.getByTestId("badge-check-mind"));
      const checkProblem = card.getByTestId("checks-problem");
      await expect(checkProblem).toContainText(t("noteAsk.cantRead.one", { agent: "Claude Code" }));
      await expect(checkProblem).not.toContainText(t("checks.problem.no-provider"));
      await shot(window, `cant-read-check-card-${language}`);
      await window.keyboard.press("Escape");

      // Move the Note into the shared Folder from the foot line: asking appears at once.
      await pointAndClick(window, footLine.getByTestId("note-ask-move"));
      const picker = window.getByTestId("move-to-picker");
      await expect(picker).toBeVisible();
      await pointAndClick(window, picker.locator(`[data-folder-id="${folderId}"]`));
      await expect(footLine).toHaveCount(0);
      await expect(group.getByTestId("own-ai-pill-ask")).toBeVisible();
      await shot(window, `cant-read-moved-${language}`);
    } finally {
      await app.close();
    }
  });
}
