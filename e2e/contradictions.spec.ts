import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * Contradiction watch (#112): "Check for contradictions" (⌘K, the Mind's
 * menu) checks each cited sentence of a Mind against the other Documents in
 * its Folder. The User cites a sentence with Check against Documents' Add as Citation;
 * the scripted model (src/main/fakeChat/checks.ts) finds a sentence
 * contradicted when it shares three words with a line that has other numbers.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 6 months."] },
]);
const OFFICE = buildPdf([
  { lines: ["Harbour office", "Harbours publish the times of high water every 12 months."] },
]);
const QUIET_OFFICE = buildPdf([
  { lines: ["Harbour office", "The harbour office opens to visitors in the morning."] },
]);
const CLAIM = "Harbours publish the times of high water every 6 months.";

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

const bridge = (window: Page) => ({
  /** Claude Haiku 5.5 on an Anthropic key, billed per token, allowed to be sent to. */
  cloudModel: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-haiku-5-5",
      });
      if (provider.service) {
        for (const flow of ["chat", "tagging", "checks"] as const) {
          await core.allowDataFlow(flow, provider.service.id);
        }
      }
    }),
  /** A Folder holding these Documents, by name, and the Mind in front. */
  folder: (name: string, documents: string[]) =>
    window.evaluate(
      async ({ folderName, names }) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const folder = await core.createLibraryGroup({ name: folderName, description: "" });
        const all = await core.listDocuments();
        const documentIds = all.filter((each) => names.includes(each.name)).map((each) => each.id);
        const mindIds = (await core.listMinds()).map((mind) => mind.id);
        await core.moveToFolder({ documentIds, mindIds, folderId: folder.id });
      },
      { folderName: name, names: documents },
    ),
});

/** A Mind with the claim, cited with Check against Documents' Add as Citation. */
async function citedClaim(window: Page): Promise<Locator> {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(CLAIM);
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Harbours publish", { line, words: "6 months." });
  const menu = window.getByTestId("selection-menu");
  await pointAndClick(window, menu.getByTestId("selection-action-check-against-documents"));
  const mark = window.getByTestId("claim-mark");
  await expect(mark).toHaveAttribute("data-check", "supported");
  await pointAndClick(window, mark);
  await pointAndClick(window, window.getByTestId("claim-card").getByTestId("claim-add-citation"));
  await expect(line.getByTestId("citation")).toHaveAttribute("data-check", "found");
  await expect(window.getByTestId("claim-mark")).toHaveCount(0);
  return line;
}

async function runFromPalette(window: Page, query: string, label: string) {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(query);
  const item = window.getByTestId("palette-item").filter({ hasText: label }).first();
  await expect(item).toBeVisible();
  await pointAndClick(window, item);
}

test("Check for contradictions: the estimate first, then a cited claim another Document contradicts gets “≠”, its card naming that Document", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(join(sources, "Office.pdf"), OFFICE);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Office.pdf")]);
  const line = await citedClaim(window);
  await bridge(window).folder("Harbours", ["Tides", "Office"]);

  await runFromPalette(window, "contradictions", "Check for contradictions");

  // A model billed per token: the badge's card opens by itself and asks first; one claim costs
  // less than a dollar, so no price line shows (#1941).
  const ask = window.getByTestId("check-card").getByTestId("contradictions-ask");
  await expect(ask).toContainText("Check 1 cited claim against this Folder’s other Documents?");
  await expect(ask).not.toContainText("About");
  const checks = await checkCard(window);
  await screenshot(window, "contradictions-ask-en");
  await pointAndClick(window, ask.getByTestId("contradictions-check"));

  // What it found is the mark and the card's own row (#1941).
  const mark = window.getByTestId("claim-mark");
  await expect(mark).toHaveAttribute("data-check", "contradicted");
  await expect(line.locator(".claim-wash--contradicted").first()).toBeVisible();
  await expect(checks.getByTestId("health-contradicted")).toContainText("1 claim contradicted");
  await screenshot(window, "contradictions-found-en");

  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-badge")).toHaveText("Needs a look · Contradicted");
  await expect(card).toContainText("Office");
  await expect(card.getByTestId("claim-quote")).toHaveText(
    "Harbours publish the times of high water every 12 months.",
  );
  await screenshot(window, "contradictions-card-en");
  await window.keyboard.press("Escape");

  // Editing the claim makes it need a re-check, as Check against Documents' do.
  await slideSelect(window, line, "Harbours");
  await window.keyboard.type("Ports");
  await expect(mark).toHaveAttribute("data-check", "needs-recheck");
});

test("the one Check in a Folder checks the cited sentence and its contradiction in one press, then says nothing changed", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(join(sources, "Office.pdf"), OFFICE);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await bridge(window).cloudModel();
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Office.pdf")]);
  await citedClaim(window);
  await bridge(window).folder("Harbours", ["Tides", "Office"]);

  // One action: Check asks once, with the one count (#1909) and no price line for a run under a dollar (#1941).
  const card = await checkCard(window);
  await expect(card.getByTestId("badge-check-mind")).toHaveText("Check");
  await pointAndClick(window, card.getByTestId("badge-check-mind"));
  const ask = card.getByTestId("mind-check-ask");
  await expect(ask).toContainText("Check this note’s claim against this Folder’s Documents?");
  await expect(ask).not.toContainText("About");
  await pointAndClick(window, ask.getByTestId("mind-check-check"));

  // The sentence is checked for support and against the Folder's other Document: the contradiction is what shows.
  await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted");
  const done = await checkCard(window);
  await expect(done.getByTestId("health-contradicted")).toContainText("1 claim contradicted");
  await expect(done.getByTestId("health-toCheck")).toHaveCount(0);
  await expect(window.getByTestId("check-badge")).toHaveAttribute("data-state", "needs-look");
  await screenshot(window, "one-check-folder-en");

  // Nothing changed since: Check sends nothing and the card says so.
  await expect(done.getByTestId("badge-check-mind")).toHaveAttribute("title", "Nothing changed");
  await pointAndClick(window, done.getByTestId("badge-check-mind"));
  await expect(done.getByTestId("mind-check-unchanged")).toBeVisible();
  await expect(done.getByTestId("mind-check-ask")).toHaveCount(0);
  await app.close();
});

test("In Chinese and a narrow window: a Mind in no Folder, and a Folder of only the cited Document, say so; the Mind's menu has the command", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await citedClaim(window);
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);

  await runFromPalette(window, "矛盾", "核对矛盾");
  // A check the User started that can't run opens the card to say why.
  const problem = window.getByTestId("check-card").getByTestId("checks-problem");
  await expect(problem).toContainText("这篇笔记不在文件夹中");

  await bridge(window).folder("潮汐", ["Tides"]);
  await pointAndClick(window, problem.getByTestId("checks-problem-close"));
  // The Mind's own menu, on its tab.
  await window.getByTestId("mind-tab").first().click({ button: "right" });
  const item = window.getByRole("menuitem", { name: "核对矛盾" });
  await expect(item).toBeVisible();
  await pointAndClick(window, item);
  await expect(window.getByTestId("check-card").getByTestId("checks-problem")).toContainText(
    "“潮汐”中只有这些说法引用的文档。",
  );
  await screenshot(window, "contradictions-only-cited-zh-narrow");
});

test("A new version of a Document in the Folder has the Mind's cited claims checked by themselves; the line says what was found until closed", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(join(sources, "Office.pdf"), QUIET_OFFICE);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    contradictionWatchDelayMs: 0,
  });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Office.pdf")]);
  const line = await citedClaim(window);
  await bridge(window).folder("Harbours", ["Tides", "Office"]);

  await writeFile(join(sources, "Office.pdf"), OFFICE);

  // Work in the background never opens the card: the badge shows the mark, and the card what the run found.
  await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted", {
    timeout: 30_000,
  });
  await expect(line.locator(".claim-wash--contradicted").first()).toBeVisible();
  await expect(window.getByTestId("check-card")).toHaveCount(0);
  await expect(
    window.getByTestId("check-badge").locator('[data-part="contradicted"] .check-badge-words'),
  ).toHaveText("1 needs a look");
  const checks = await checkCard(window);
  const watched = checks.getByTestId("contradictions-watched");
  await expect(watched).toContainText("After “Office” changed: 1 of 1 cited claims contradicted");
  await expect(checks.getByTestId("health-contradicted")).toContainText("1 claim contradicted");
  await screenshot(window, "contradictions-watched-en");

  await pointAndClick(window, watched.getByTestId("contradictions-watched-close"));
  await expect(watched).toHaveCount(0);
  await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted");
});
