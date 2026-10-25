import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { xlsxOf } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  openSteps,
  placeAssistant,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setCheck,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/** Three short pages: the line about spring tides is on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

/** Two short pages, so one Passage covers both: the line about spring tides is on page 1. */
const TWO_PAGES = buildPdf([
  { lines: ["Spring tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

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

/** Asks a Question in the assistant, beside a new Mind, and waits for its Answer to finish. */
async function ask(window: Page, text: string) {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  return askInAssistant(window, text);
}

test("an Answer cites a PDF: its badge says the quote was found, and clicking it opens the page with the quote highlighted", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);

  const answer = await ask(window, "When do spring tides happen?");

  // Its steps say that it searched the Documents, and what for.
  await expect(answer.getByTestId("answer-steps")).toContainText("Searched");
  const steps = await openSteps(window, answer);
  await expect(steps.locator('[data-step="search"]')).toContainText(
    "for “When do spring tides happen?”",
  );

  // Added to a Note, the sentence keeps its Citation, check result and all.
  const editor = window.getByTestId("mind-editor");
  await pointAt(window, answer.getByTestId("assistant-answer-text"));
  await pointAndClick(window, answer.getByTestId("answer-add"));
  const note = editor.locator(":scope > p").first();
  await expect(note).toContainText("Your Documents answer this");
  await expect(note.getByTestId("citation")).toHaveAttribute("data-check", "found");
  await expect(editor.getByTestId("answer")).toHaveCount(0);

  // The marker became a Citation whose quote was found on page 2: numbered 1 in the text,
  // its label naming the Document, the page and the check.
  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveCount(1);
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(citation.getByTestId("citation-chip")).toHaveText("1");
  await expect(citation.getByTestId("citation-chip")).toHaveAttribute(
    "aria-label",
    "Citation 1: Tides, p. 2. Quote found on p. 2",
  );
  await expect(answer).toContainText("Your Documents answer this");
  await expect(answer).not.toContainText("[^1]");

  // Clicking it shows its badge and opens the viewer at that page, the quote highlighted.
  await citation.getByTestId("citation-chip").click();
  await expect(window.getByTestId("citation-badge")).toHaveText("Quote found on p. 2");
  const viewer = window.getByTestId("viewer");
  await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
  const highlights = viewer.locator('[data-page-number="2"] [data-quote-highlight]');
  await expect(highlights).toHaveText(["Spring tides happen at new moon and at full moon."]);
  await expect(highlights.first()).toBeInViewport();
  // It opened as a preview in a group right of the Mind, which stays where it was, in front.
  const groups = window.getByTestId("tab-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.first().getByTestId("mind-tab")).toHaveAttribute("aria-selected", "true");
  await expect(groups.first()).toHaveAttribute("data-focused", "true");
  await expect(groups.nth(1).getByTestId("document-tab")).toHaveAttribute("data-preview", "true");
  await app.close();
});

test("a quote on page 1 of a Passage that runs onto page 2 is labelled p. 1, as the page it opens at", async () => {
  await writeFile(join(sources, "Tides.pdf"), TWO_PAGES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);

  const answer = await ask(window, "When do spring tides happen? Name no page.");

  const chip = answer.getByTestId("citation").getByTestId("citation-chip");
  await expect(chip).toHaveAttribute("aria-label", "Citation 1: Tides, p. 1. Quote found on p. 1");
  await pointAndClick(window, chip);
  await expect(window.getByTestId("citation-badge")).toHaveText("Quote found on p. 1");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("1");
  await app.close();
});

test("a quote that isn't on its page says so, and the page can still be opened, or the Citation removed", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);

  const answer = await ask(window, "When do spring tides happen? Misquote it.");

  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "not-found");
  await citation.getByTestId("citation-chip").click();
  const card = window.getByTestId("citation-card");
  await expect(card.getByTestId("citation-badge")).toHaveText("Quote not found on p. 2");
  await expect(card.getByTestId("citation-reason")).toContainText("isn’t in the text");
  // Not found: the viewer doesn't open by itself.
  await expect(window.getByTestId("viewer")).toHaveCount(0);

  await card.getByTestId("citation-open-anyway").click();
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
  await expect(window.getByTestId("viewer").locator("[data-quote-highlight]")).toHaveCount(0);

  // An Answer in the assistant can't be edited: its card offers no removing.
  await citation.getByTestId("citation-chip").click();
  await expect(
    window.getByTestId("citation-card").getByTestId("citation-open-anyway"),
  ).toBeVisible();
  await expect(window.getByTestId("citation-card").getByTestId("citation-remove")).toHaveCount(0);

  // Regenerating from the card writes the Answer again, where it is.
  await window.getByTestId("citation-card").getByTestId("citation-regenerate").click();
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(assistantAnswers(window)).toHaveCount(1);

  // Added to the note, the Citation is checked again there, and can be removed from the note.
  const editor = window.getByTestId("mind-editor");
  await pointAt(window, answer.getByTestId("assistant-answer-text"));
  await pointAndClick(window, answer.getByTestId("answer-add"));
  const added = editor.getByTestId("citation");
  await expect(added).toHaveAttribute("data-check", "not-found");
  await added.getByTestId("citation-chip").click();
  await window.getByTestId("citation-card").getByTestId("citation-remove").click();
  await expect(editor.getByTestId("citation")).toHaveCount(0);
  await expect(editor).toContainText("Your Documents answer this");
  await app.close();
});

for (const [width, side] of [
  [1440, true],
  [1000, true],
  // Below 1,000px the groups merge, so the Document comes to the front.
  [960, false],
] as const) {
  test(`at ${width}px a Citation's card opens on hover and on focus, and Open shows the page beside the Mind`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await setWindowSize(app, window, width, 800);
    // At 1,000px the page opens beside the Mind with the assistant at the bottom (#253).
    if (side && width < 1400) await placeAssistant(window, { dock: "bottom" });

    const answer = await ask(window, "When do spring tides happen?");
    const chip = answer.getByTestId("citation-chip");
    const card = window.getByTestId("citation-card");

    // Hovering shows the card, and nothing else opens.
    await chip.hover();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("citation-badge")).toHaveText("Quote found on p. 2");
    await expect(card).toContainText("Tides");
    await expect(card).toContainText("Spring tides happen at new moon and at full moon.");
    await expect(window.getByTestId("viewer")).toHaveCount(0);
    // Esc closes it, wherever the focus is.
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // So does focusing it with the keyboard.
    await window.mouse.move(0, 0);
    await chip.focus();
    await expect(card).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // Open, in the card, shows the cited page with the quote washed.
    await chip.hover();
    await card.getByTestId("citation-open").click();
    await expect(card).toHaveCount(0);
    await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
    await expect(
      window.getByTestId("viewer").locator('[data-page-number="2"] [data-quote-highlight]'),
    ).toHaveText(["Spring tides happen at new moon and at full moon."]);
    const groups = window.getByTestId("tab-group");
    if (side) {
      // A preview tab in the group to the right; the focus stays in the Mind's group.
      await expect(groups).toHaveCount(2);
      await expect(groups.nth(1).getByTestId("document-tab")).toHaveAttribute(
        "data-preview",
        "true",
      );
      await expect(groups.first()).toHaveAttribute("data-focused", "true");
    } else {
      await expect(window.getByTestId("document-tab")).toHaveAttribute("aria-selected", "true");
    }
    await app.close();
  });
}

test("a Citation's badge in an Answer opens its card, and every state has its word", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await setWindowSize(app, window, 1600, 800);

  const answer = await ask(window, "When do spring tides happen?");
  const mark = answer.getByTestId("citation-chip");
  const card = window.getByTestId("citation-card");
  await expect(mark).toHaveAttribute("aria-label", /Quote found/);
  await mark.hover();
  await expect(card.getByTestId("citation-badge")).toHaveText("Quote found on p. 2");
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // #96 will produce these for real; here the Citation is given each state.
  const states = [
    ["not-found", "Quote not found", ""],
    ["unsupported", "Unsupported by your Documents", ""],
    [
      "contradicted",
      "Contradicted",
      "The agreement says spring tides happen at new moon only, p. 2",
    ],
  ] as const;
  for (const [check, word, verdict] of states) {
    await setCheck(answer, { check, verdict: verdict || null });
    await expect(answer.getByTestId("citation")).toHaveAttribute("data-check", check);
    await expect(mark).toHaveAttribute("data-check", check);
    await expect(mark).toHaveAttribute("aria-label", new RegExp(word));
    // The badge keeps the focus Esc left on it: it takes it again.
    await mark.blur();
    await mark.focus();
    await expect(card.getByTestId("citation-badge")).toContainText(word);
    if (verdict) await expect(card.getByTestId("citation-verdict")).toHaveText(verdict);
    if (check === "not-found") {
      // One amber line, not the quote.
      await expect(card).not.toContainText("Spring tides happen at new moon");
    } else {
      await expect(card.getByTestId("citation-open")).toBeVisible();
    }
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
  }
  await app.close();
});

test("a contradicted Citation's words are outlined in red on the page, never washed green, with the ≠ mark", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await setWindowSize(app, window, 1440, 800);
  const answer = await ask(window, "When do spring tides happen?");

  // #96 will produce this for real; here the Citation is given the state.
  await setCheck(answer, { check: "contradicted" });
  await answer.getByTestId("citation-chip").click();
  await window.getByTestId("citation-card").getByTestId("citation-open").click();

  const highlight = window
    .getByTestId("viewer")
    .locator('[data-page-number="2"] [data-quote-highlight]')
    .first();
  await expect(highlight).toBeVisible();
  const look = await highlight.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });
  // No fill, and an outline in red.
  expect(look.background).toBe("rgba(0, 0, 0, 0)");
  expect(look.shadow).toContain("rgb(180, 35, 24)");
  const mark = window.getByTestId("viewer-quote-mark");
  await expect(mark).toHaveAttribute("data-check", "contradicted");
  await expect(mark).toHaveAttribute("aria-label", /contradicted/);
  await app.close();
});

test("in Chinese, a Citation of a Chinese sheet's row has no space between Chinese characters", async () => {
  await writeFile(
    join(sources, "年报.xlsx"),
    xlsxOf([
      {
        name: "利润表",
        rows: [
          ["Item", "Amount"],
          ["Revenue", 1200],
          ["Cost of sales", 800],
          ["Net profit", 400],
        ],
      },
    ]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "年报.xlsx")]);
  await expect(window.getByTestId("document-list-item")).toHaveAttribute("data-status", "ready", {
    timeout: 30_000,
  });

  const answer = await ask(window, "What is the net profit, in rows?");
  const chip = answer.getByTestId("citation-chip");
  await expect(chip).toHaveCount(1);
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );

  await expect(chip).toHaveAttribute(
    "aria-label",
    /^引用 1：年报，利润表，第 \d+–?\d* 行。已在“利润表，第 \d+–?\d* 行”中找到引文$/,
  );
  await chip.click();
  const badge = window.getByTestId("citation-badge");
  await expect(badge).toHaveText(/^已在“利润表，第 \d+–?\d* 行”中找到引文$/);
  expect(await badge.innerText()).not.toMatch(/[一-鿿] [一-鿿]/);
  await app.close();
});
