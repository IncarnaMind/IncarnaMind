import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  acceptPlainTextKeys,
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  mindWrittenBefore,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * Check this Mind (#737): "Check this Mind" (⌘K, the Mind's menu) checks
 * every sentence that makes a claim, in one run, then the health line's
 * Check again checks only what changed. The scripted model
 * (src/main/fakeChat/claims.ts) names every sentence a claim but questions,
 * thanks and "we think"; a claim sharing three words with a line of the
 * Tides PDF is supported, or contradicted when it has a number the line
 * doesn't; any other is unsupported. Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  {
    lines: [
      "Harbour times",
      "Harbours publish the times of high water every 12 months.",
      "Spring tides come at new moon and at full moon.",
      "Neap tides come at the first and last quarter moons.",
      "The harbour office opens at nine in the morning.",
    ],
  },
]);

/** Fifteen claims, three questions and two opinions: twenty sentences. */
const CLAIMS = [
  "Harbours publish the times of high water every 6 months.",
  "Spring tides come at new moon and at full moon.",
  "Neap tides come at the first and last quarter moons.",
  "The harbour office opens at nine in the morning.",
  "Penguins nest on the cliffs above the harbour.",
  "The ferry to the island leaves twice a day.",
  "Fishing boats land their catch before dawn.",
  "The lighthouse was built in 1867.",
  "The pier is closed to cars in summer.",
  "Two cranes unload the cargo ships.",
  "The harbour master keeps a log of every arrival.",
  "Storm warnings are posted at the harbour office.",
  "The sea wall was raised after the 1953 flood.",
  "Pilots guide large ships into the channel.",
  "The marina has berths for sixty yachts.",
];
const QUESTIONS = [
  "Does high water come at noon on Sundays?",
  "Who looks after the lighthouse now?",
  "Can visitors walk on the sea wall?",
];
const OPINIONS = [
  "We think the harbour is at its best in spring.",
  "I believe the new marina was worth building.",
];

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

/** The Mind of twenty sentences under a heading, opened. */
async function harbourNotes(window: Page) {
  await mindWrittenBefore(window, "Harbour notes", [
    { heading: "The harbour" },
    { note: `${CLAIMS.slice(0, 5).join(" ")} ${QUESTIONS[0]} ${OPINIONS[0]}` },
    { heading: "Ships and boats" },
    { note: `${CLAIMS.slice(5, 10).join(" ")} ${QUESTIONS[1]}` },
    { note: `${CLAIMS.slice(10).join(" ")} ${QUESTIONS[2]} ${OPINIONS[1]}` },
  ]);
  await window.getByTestId("mind-list-item").filter({ hasText: "Harbour notes" }).click();
  await expect(window.getByTestId("mind-editor")).toContainText(CLAIMS[0] ?? "");
}

const marks = (window: Page) => window.getByTestId("claim-mark");

/** A model billed per token, whose requests the cost meter counts, with the checks allowed to use it. */
async function useCloudChatModel(window: Page) {
  await window.evaluate(async () => {
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
  });
}

/** The requests made to cloud models this month, as the cost meter counts them. */
const modelRequests = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { providers } = await core.getCostSummary();
    return providers.reduce((sum, each) => sum + each.requests, 0);
  });

test("Check this Mind from ⌘K: the estimate first on a cloud model, then every claim marked, the headings, questions and opinions not; an edited claim is checked again alone", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await useCloudChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await harbourNotes(window);

  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("check this mind");
  const item = window.getByTestId("palette-item").filter({ hasText: "Check this Mind" }).first();
  await pointAndClick(window, item);

  // The model names the claims first; the badge's card then opens by itself and asks with their
  // number and the estimate, its price first. Of the 20 sentences, the 15 claims are what it checks.
  const ask = window.getByTestId("check-card").getByTestId("mind-check-ask");
  await expect(ask).toContainText("Check this Mind’s 15 claims against your Documents?");
  await expect(ask).toContainText("About $");
  await expect(window.getByTestId("palette-search")).toBeHidden();
  await checkCard(window);
  await screenshot(window, "mind-check-ask-en");
  await pointAndClick(window, ask.getByTestId("mind-check-check"));

  const health = window.getByTestId("check-card");
  await expect(health.getByTestId("health-checked-all")).toContainText("Checked 15 claims, ");
  await expect(marks(window)).toHaveCount(15);
  await expect(marks(window).and(window.locator('[data-check="checking"]'))).toHaveCount(0);
  await expect(marks(window).and(window.locator('[data-check="contradicted"]'))).toHaveCount(1);
  await expect(marks(window).and(window.locator('[data-check="supported"]'))).toHaveCount(3);
  // Nothing changed since: no claim is one not checked yet.
  await expect(health.getByTestId("health-unchecked")).toHaveCount(0);
  await expect(window.getByTestId("check-badge")).toContainText("1");
  await screenshot(window, "mind-check-done-en");

  // An edited claim needs a re-check, and Check again checks it alone.
  const editor = window.getByTestId("mind-editor");
  const first = editor.locator(":scope > p").first();
  await slideSelect(window, first, "Penguins");
  await window.keyboard.type("Puffins");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(1);
  // The card's one action checks what changed, here the edited claim alone, at once; its
  // tooltip says how many that is.
  const again = (await checkCard(window)).getByTestId("badge-check-mind");
  await expect(again).toHaveText("Check this Mind");
  await expect(again).toHaveAttribute("title", "1 sentence to check");
  await pointAndClick(window, again);
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(0);
  await expect(marks(window).and(window.locator('[data-check="unsupported"]'))).toHaveCount(11);
  await expect(marks(window)).toHaveCount(15);
  await expect(again).toHaveAttribute("title", "Nothing changed");

  // ⌘K's "Check this Mind" is that same action; "Check every sentence again" is the whole Mind.
  await slideSelect(window, first, "Puffins");
  await window.keyboard.type("Gulls");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(1);
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("check this mind");
  await pointAndClick(
    window,
    window.getByTestId("palette-item").filter({ hasText: "Check this Mind" }).first(),
  );
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(0);
  await expect(window.getByTestId("mind-check-ask")).toHaveCount(0);
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("check every sentence");
  await pointAndClick(
    window,
    window.getByTestId("palette-item").filter({ hasText: "Check every sentence again" }).first(),
  );
  await expect(window.getByTestId("check-card").getByTestId("mind-check-ask")).toContainText(
    "Check this Mind’s 15 claims against your Documents?",
  );
});

test("In Chinese and a narrow window, from the Mind's tab menu: a model on this computer asks with the claims and no price; a Folder that holds too little offers all Documents; Check this Mind checks a sentence written since", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(
    join(sources, "Garden.pdf"),
    buildPdf([{ lines: ["Garden notes", "Roses like a sunny wall and rich soil."] }]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Garden.pdf")]);
  await harbourNotes(window);
  // The Mind's Folder holds only the garden notes; the Tides PDF is outside it.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await core.createLibraryGroup({ name: "Garden", description: "" });
    const garden = (await core.listDocuments()).filter((each) => each.name === "Garden");
    const mind = (await core.listMinds()).filter((each) => each.title === "Harbour notes");
    await core.moveToFolder({
      documentIds: garden.map((each) => each.id),
      mindIds: mind.map((each) => each.id),
      folderId: folder.id,
    });
  });
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);

  await window.getByTestId("mind-tab").first().click({ button: "right" });
  await pointAndClick(window, window.getByRole("menuitem", { name: "核对此 Mind" }));
  // On this computer it asks too, in the badge's card, with the claims the model named and no price.
  const health = window.getByTestId("check-card");
  const ask = health.getByTestId("mind-check-ask");
  await expect(ask).toContainText("要对照这个文件夹中的文档，核对这个 Mind 中的 15 条说法吗？");
  await expect(ask).not.toContainText("约");
  await checkCard(window);
  await pointAndClick(window, ask.getByTestId("mind-check-check"));
  await expect(health.getByTestId("health-checked-all")).toContainText("已核对 15 条说法，");
  await expect(marks(window).and(window.locator('[data-check="unsupported"]'))).toHaveCount(15);

  // Nothing in the Folder says any of it: checked against every Document, the Tides PDF does.
  const widen = health.getByTestId("checks-uncovered").getByTestId("checks-check-all");
  await expect(widen).toHaveText("对照全部文档核对");
  await pointAndClick(window, widen);
  // The claims are named already and a model on this computer is free: it checks at once, asking nothing.
  await expect(marks(window).and(window.locator('[data-check="supported"]'))).toHaveCount(3);
  await expect(ask).toHaveCount(0);
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await expect(health.getByTestId("health-checked-all")).toBeVisible();
  await expect(marks(window).and(window.locator('[data-check="contradicted"]'))).toHaveCount(1);
  await expect(widen).toHaveCount(0);
  await expect(marks(window)).toHaveCount(15);
  await expect(health.getByTestId("health-unsupported")).toContainText("11 条无依据");
  await screenshot(window, "mind-check-done-zh-narrow");

  // A sentence written since: "核对此 Mind" checks it alone, and the rest stay as they were.
  const editor = window.getByTestId("mind-editor");
  const last = editor.locator(":scope > p").last();
  const box = await last.boundingBox();
  if (!box) throw new Error("The last paragraph isn't drawn.");
  // Right of its last line: the caret goes to the paragraph's end.
  await last.click({ position: { x: box.width - 2, y: box.height - 4 } });
  await window.keyboard.type(" The harbour office opens at nine in the morning.");
  await expect(last).toContainText("worth building. The harbour office opens");
  const all = (await checkCard(window)).getByTestId("badge-check-mind");
  await expect(all).toHaveText("核对此 Mind");
  await expect(all).toHaveAttribute("title", "1 句待核对");
  await pointAndClick(window, all);
  await expect(ask).toContainText("要对照这个文件夹中的文档，核对这个 Mind 中的这条说法吗？");
  await pointAndClick(window, ask.getByTestId("mind-check-check"));
  await expect(marks(window)).toHaveCount(16);
  await expect(health.getByTestId("health-unchecked")).toHaveCount(0);
});

test("when the provider can't be reached while the claims are named, Try again names them again and asks before it checks", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  // The scripted model can't reach its provider the first time it names the claims.
  await useLocalChatModel(window, "fake-model-claims-offline");
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await harbourNotes(window);

  await window.getByTestId("mind-tab").first().click({ button: "right" });
  await pointAndClick(window, window.getByRole("menuitem", { name: "Check this Mind" }));
  // The failure opens the badge's card to say why, with Try again.
  const failure = window.getByTestId("check-card").getByTestId("answer-error");
  await expect(failure).toHaveAttribute("data-error-kind", "network");
  await checkCard(window);
  await pointAndClick(window, failure.getByTestId("answer-error-action"));

  const ask = window.getByTestId("check-card").getByTestId("mind-check-ask");
  await expect(ask).toContainText("Check this Mind’s 15 claims against your Documents?");
  await expect(marks(window)).toHaveCount(0);
  await pointAndClick(window, ask.getByTestId("mind-check-check"));
  await expect(marks(window)).toHaveCount(15);
});

test("Check this Mind with nothing changed sends nothing: the marks stay and the card says since when, with Check every sentence again, which checks for real; in English and Chinese", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await useCloudChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await harbourNotes(window);

  const card = await checkCard(window);
  await pointAndClick(window, card.getByTestId("badge-check-mind"));
  await pointAndClick(window, card.getByTestId("mind-check-ask").getByTestId("mind-check-check"));
  await expect(card.getByTestId("health-checked-all")).toContainText("Checked 15 claims, ");
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await expect(marks(window)).toHaveCount(15);
  const verdicts = () =>
    marks(window).evaluateAll((all) =>
      all.map((each) => `${each.getAttribute("data-check")}: ${each.textContent}`),
    );
  const checked = await verdicts();
  const sent = await modelRequests(window);
  expect(sent).toBeGreaterThan(0);

  // Again: no model is asked, no question, no run; the marks are as they were, and the card says why.
  const again = card.getByTestId("badge-check-mind");
  await pointAndClick(window, again);
  const unchanged = card.getByTestId("mind-check-unchanged");
  await expect(unchanged).toContainText("Nothing changed since ");
  await expect(unchanged).toHaveAttribute("role", "status");
  await expect(card.getByTestId("mind-check-ask")).toHaveCount(0);
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await expect(window.getByTestId("badge-progress")).toHaveCount(0);
  expect(await verdicts()).toEqual(checked);
  expect(await modelRequests(window)).toBe(sent);
  await screenshot(window, "mind-check-unchanged-en");

  // The action is the line's own button, reached from the keyboard, and checks every sentence for real.
  const every = unchanged.getByTestId("mind-check-every");
  await expect(every).toHaveText("Check every sentence again");
  await window.keyboard.press("Shift+Tab");
  await expect(every).toBeFocused();
  await window.keyboard.press("Enter");
  const ask = card.getByTestId("mind-check-ask");
  await expect(ask).toContainText("Check this Mind’s 15 claims against your Documents?");
  await expect(unchanged).toHaveCount(0);
  expect(await modelRequests(window)).toBe(sent);
  await pointAndClick(window, ask.getByTestId("mind-check-check"));
  await expect.poll(() => modelRequests(window)).toBeGreaterThan(sent);
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);
  await expect(marks(window)).toHaveCount(15);
  await expect(unchanged).toHaveCount(0);

  // An edit makes a sentence to check; the same words again, and nothing changed.
  const editor = window.getByTestId("mind-editor");
  const first = editor.locator(":scope > p").first();
  await slideSelect(window, first, "Penguins");
  await window.keyboard.type("Puffins");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(1);
  const editedCard = await checkCard(window);
  await expect(editedCard.getByTestId("badge-check-mind")).toHaveAttribute(
    "title",
    "1 sentence to check",
  );
  await slideSelect(window, first, "Puffins");
  await window.keyboard.type("Penguins");
  await expect(marks(window).and(window.locator('[data-check="needs-recheck"]'))).toHaveCount(0);

  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 720);
  const reopened = await checkCard(window);
  const sentAgain = await modelRequests(window);
  await pointAndClick(window, reopened.getByTestId("badge-check-mind"));
  await expect(unchanged).toContainText(/^自 .+ 起没有改动/);
  await expect(unchanged.getByTestId("mind-check-every")).toHaveText("重新核对每一句");
  expect(await modelRequests(window)).toBe(sentAgain);
  const [lineBox, cardBox] = [await unchanged.boundingBox(), await reopened.boundingBox()];
  if (!lineBox || !cardBox) throw new Error("The line or the card isn't drawn.");
  expect(lineBox.x).toBeGreaterThanOrEqual(cardBox.x);
  expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  await screenshot(window, "mind-check-unchanged-zh-narrow");
  await app.close();
});

test("the line that says nothing changed goes when a Document is edited, moved out of the Folder or deleted, or the Mind is moved out of it", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await writeFile(
    join(sources, "Garden.pdf"),
    buildPdf([{ lines: ["Garden notes", "Roses like a sunny wall and rich soil."] }]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Garden.pdf")]);
  await harbourNotes(window);
  const inFolder = (documents: string[], mind: boolean, folder: "Harbours" | null) =>
    window.evaluate(
      async ([names, withMind, name]) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const ids = (await core.listDocuments())
          .filter((each) => names.includes(each.name))
          .map((each) => each.id);
        const minds = withMind
          ? (await core.listMinds()).filter((each) => each.title === "Harbour notes")
          : [];
        const { groups } = await core.getLibrary();
        const folderId = name
          ? (
              groups.find((each) => each.name === name) ??
              (await core.createLibraryGroup({ name, description: "" }))
            ).id
          : null;
        await core.moveToFolder({
          documentIds: ids,
          mindIds: minds.map((each) => each.id),
          folderId,
        });
      },
      [documents, mind, folder] as const,
    );
  await inFolder(["Tides", "Garden"], true, "Harbours");

  const card = await checkCard(window);
  const check = card.getByTestId("badge-check-mind");
  const unchanged = card.getByTestId("mind-check-unchanged");
  await pointAndClick(window, check);
  await pointAndClick(window, card.getByTestId("mind-check-ask").getByTestId("mind-check-check"));
  await expect(card.getByTestId("health-checked-all")).toBeVisible();
  await expect(window.getByTestId("badge-stop")).toHaveCount(0);

  // Each change leaves checks to make, so the line goes and the button says how many; checking them brings it back.
  const checkedAgain = async () => {
    await pointAndClick(window, check);
    await expect(check).toHaveAttribute("title", "Nothing changed", { timeout: 20_000 });
    await pointAndClick(window, check);
    await expect(unchanged).toBeVisible();
  };
  await pointAndClick(window, check);
  await expect(unchanged).toBeVisible();

  await writeFile(
    join(sources, "Tides.pdf"),
    buildPdf([
      { lines: ["Harbour times", "Harbours publish the times of high water every 6 months."] },
    ]),
  );
  await expect(unchanged).toHaveCount(0, { timeout: 30_000 });
  await expect(check).toHaveAttribute("title", /sentences? to check$/);
  await checkedAgain();

  await inFolder(["Tides"], false, null);
  await expect(unchanged).toHaveCount(0);
  await expect(check).toHaveAttribute("title", /sentences? to check$/);
  await checkedAgain();

  await inFolder([], true, null);
  await expect(unchanged).toHaveCount(0);
  await expect(check).toHaveAttribute("title", /sentences? to check$/);
  await checkedAgain();

  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.deleteDocuments((await core.listDocuments()).map((each) => each.id));
  });
  await expect(unchanged).toHaveCount(0);
  await expect(check).not.toHaveAttribute("title", "Nothing changed");
  await app.close();
});
