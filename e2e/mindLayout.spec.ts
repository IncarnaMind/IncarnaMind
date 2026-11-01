import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addTideConnector,
  addToNote,
  askInAssistant,
  assistantAnswers,
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  mindWrittenBefore,
  motionSettled,
  nameMind,
  newMind,
  paintOf,
  pointAndClick,
  removeDataFolder,
  setGroupBeside,
  setLanguage,
  setWindowSize,
  sizeMind,
  slideSelect,
  slideToHandle,
  tokenColor,
  useLocalChatModel,
} from "./app";

/** Three short pages: the line about spring tides is on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

/** DESIGN.md, Layout: the Mind's left margin for controls, its measure, its right margin for checks. */
const LEFT_MARGIN = 56;
const MEASURE = 680;
const RIGHT_MARGIN = 48;

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

/**
 * The Mind as wide as the approved mockups drew it (a 1440px window's card),
 * beside the assistant docked on the right (#253), which takes 328px of it.
 */
async function useMockupSize(app: ElectronApplication, window: Page) {
  await setWindowSize(app, window, 1600, 900);
  await window.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Saves a screenshot with the test's results (test-results/…), and attaches it to the report. */
async function screenshot(target: Page | Locator, name: string) {
  const path = test.info().outputPath(name);
  await target.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element isn't visible.");
  return found;
}

/** The editor's text column: its box reaches over the left margin, its padding keeps the text edge. */
function textColumn(editor: Locator) {
  return editor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = Number.parseFloat(style.paddingLeft);
    const right = Number.parseFloat(style.paddingRight);
    return { x: rect.left + left, width: rect.width - left - right };
  });
}

const middle = (rect: { y: number; height: number }) => rect.y + rect.height / 2;

/** `actual` is within `tolerance` px of `expected` (a soft check: the test goes on). */
function expectNear(actual: number, expected: number, tolerance: number, what: string) {
  expect
    .soft(
      Math.abs(actual - expected),
      `${what}: ${actual} should be within ${tolerance}px of ${expected}`,
    )
    .toBeLessThanOrEqual(tolerance);
}

/** Opens or closes the Document viewer through the test hook, as a Citation would. */
/**
 * Adds a sentence with two more Citations at the end of the Notes added from
 * an Answer, keeping them one run with one link back, as copies of the first
 * Citation: one found, and one whose quote wasn't found, on a later line.
 * Like an Answer that cited three times.
 */
async function citeMore(editor: Locator) {
  await editor.evaluate((dom) => {
    const { view, commands } = (dom as unknown as { editor: Editor }).editor;
    const added = dom.querySelectorAll(':scope > [data-origin="conversation"]');
    const last = added[added.length - 1];
    let cited: Record<string, unknown> | null = null;
    view.state.doc.descendants((child) => {
      if (!cited && child.type.name === "citation") cited = { ...child.attrs };
      return cited === null;
    });
    if (!last || !cited) throw new Error("No Note added from an Answer, with a Citation.");
    const $last = view.state.doc.resolve(view.posAtDOM(last, 0));
    const at = $last.after(1);
    const citation = (check: string, checkReason: string | null) => ({
      type: "citation",
      attrs: { ...(cited as Record<string, unknown>), check, checkReason },
    });
    commands.insertContentAt(at, {
      type: "paragraph",
      content: [
        { type: "text", text: "They come when the Sun and the Moon pull in line." },
        citation("found", null),
        {
          type: "text",
          text: " The pull is strongest at new moon and at full moon, when the two line up with the Earth, and weakest in between, at the quarter moons, when the smaller neap tides come instead.",
        },
        citation("not-found", "quote-not-on-pages"),
      ],
    });
  });
}

test("every text in a Mind starts at one edge, its controls sit in the left margin, and a Citation's check shows on its marker, not in the right margin", async () => {
  // Notes added from an Answer (#201) are Notes: they keep the edge, their link back sits in
  // the left margin, and their Citations' checks on their markers.
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await useMockupSize(app, window);

  // A title as its first line, a Note, a heading, a list, then an Answer added to the note.
  await newMind(window);
  await enterContent(window);
  const editor = window.getByTestId("mind-editor");
  await window.keyboard.type("# Reading notes: tides");
  await window.keyboard.press("Enter");
  const title = editor.locator(":scope > h1");
  await window.keyboard.type(
    "Goal for this week: find out what drives spring tides, and when they come. Start with the tide tables, then the notes on the Moon.",
  );
  await window.keyboard.press("Enter");
  await window.keyboard.type("## Spring tides");
  await window.keyboard.press("Enter");
  await window.keyboard.type("- Twice a month, at new moon and full moon");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Neap tides fall in between");
  await window.keyboard.press("Enter");
  await window.keyboard.press("Enter");
  await addToNote(
    window,
    await askInAssistant(window, "When do spring tides happen, and what makes them stronger?"),
  );
  await citeMore(editor);
  await clickEndOf(window, editor.locator(":scope > p").last());
  await window.keyboard.press("Enter");
  await window.keyboard.type(
    "So spring tides follow the Moon. Check whether the tables put numbers on how much higher they are.",
  );

  // One text edge: the title, a Note, a heading, and a Note added from an Answer.
  const edge = (await textColumn(editor)).x;
  const texts = {
    title: title,
    note: editor.locator(":scope > p").first(),
    heading: editor.locator(":scope > h2"),
    added: editor
      .locator(":scope > p")
      .filter({ has: window.getByTestId("citation") })
      .first(),
  };
  for (const [name, locator] of Object.entries(texts)) {
    expectNear((await box(locator)).x, edge, 1, `the ${name} starts at the text edge`);
  }
  // A list is indented as Word indents it: its text starts 48px in (DESIGN.md, #1341).
  expectNear(
    (await box(editor.locator(":scope > ul > li").first())).x,
    edge + 48,
    1,
    "the list item starts one indent in",
  );
  // The measure is 680px, with its margins inside the pane.
  expectNear((await textColumn(editor)).width, MEASURE, 1, "the measure");

  // The block handle sits in the left margin; an added Note has no mark beside it.
  const inLeftMargin = async (locator: Locator, name: string) => {
    const rect = await box(locator);
    expect
      .soft(rect.x, `${name} is right of the margin's start`)
      .toBeGreaterThanOrEqual(edge - LEFT_MARGIN - 1);
    expect.soft(rect.x + rect.width, `${name} is left of the text`).toBeLessThanOrEqual(edge + 1);
  };
  await expect(window.getByTestId("conversation-link")).toHaveCount(0);
  // The composer is the assistant's, beside the Mind (#253), not in its column.
  const composer = await box(window.getByTestId("composer"));
  expect
    .soft(composer.x, "the composer is right of the margin column")
    .toBeGreaterThan(edge + MEASURE + RIGHT_MARGIN);
  await texts.note.hover();
  const handle = window.getByTestId("block-handle");
  await expect(handle).toBeVisible();
  await inLeftMargin(handle, "the block handle");

  // The Citations are numbered through the Mind; the not-found one is amber in the text.
  const markers = editor.getByTestId("citation-chip");
  await expect(markers).toHaveText(["1", "2", "3"]);
  await expect(markers.nth(0)).toHaveAttribute("aria-label", /Tides, p\. 2\. Quote found on p\. 2/);
  await expect(markers.nth(2)).toHaveAttribute("data-check", "not-found");

  // The right margin holds a sentence's own check, never a Citation's: the markers carry theirs.
  const margin = window.locator(".mind-editor-frame").getByTestId("margin-checks");
  await expect(margin.getByRole("button")).toHaveCount(0);
  const [neutral, warning] = [
    await tokenColor(window, "--color-chip"),
    await tokenColor(window, "--color-warning-wash"),
  ];
  expect((await paintOf(markers.nth(0))).background).toBe(neutral);
  expect((await paintOf(markers.nth(1))).background).toBe(neutral);
  expect((await paintOf(markers.nth(2))).background).toBe(warning);
  await expect(markers.nth(2)).toHaveAccessibleName(/Quote not found on p\. 2/);
  await screenshot(window, "mind.png");

  // Clicking somewhere empty, right of the margin column, closes a card.
  const away = { x: edge + MEASURE + RIGHT_MARGIN + 24, y: (await box(title)).y };
  const card = window.getByTestId("citation-card");

  // A marker opens its card (and its page: closed again here, to see the card at full width).
  await markers.nth(0).click();
  await expect(card.getByTestId("citation-badge")).toHaveText("Quote found on p. 2");
  await expect(markers.nth(0)).toHaveAttribute("aria-expanded", "true");
  await setGroupBeside(window, false);
  await expect(window.getByTestId("viewer")).toHaveCount(0);
  // Measured once it has grown from its marker.
  await motionSettled(window);
  expectNear((await box(card.locator(".citation-card"))).width, 360, 1, "the card's width");
  await screenshot(window, "mind-card-found.png");
  await window.mouse.click(away.x, away.y);
  await expect(card).toHaveCount(0);

  // So does the marker whose quote wasn't found, which doesn't open the page.
  await markers.nth(2).click();
  await expect(card.getByTestId("citation-badge")).toHaveText("Quote not found on p. 2");
  await expect(card.getByTestId("citation-reason")).toContainText("isn’t in the text");
  await expect(window.getByTestId("viewer")).toHaveCount(0);
  await screenshot(window, "mind-card-not-found.png");
  await window.mouse.click(away.x, away.y);
  await expect(card).toHaveCount(0);

  // Under 760px (here, the viewer open beside it) the markers keep their states.
  await setGroupBeside(window, true);
  expect((await paintOf(markers.nth(0))).background).toBe(neutral);
  expect((await paintOf(markers.nth(2))).background).toBe(warning);
  await expect(margin.getByRole("button")).toHaveCount(0);
  expectNear((await box(texts.note)).x, (await textColumn(editor)).x, 1, "narrow: the Note's edge");
  expectNear(
    (await box(texts.added)).x,
    (await textColumn(editor)).x,
    1,
    "narrow: the added Note's edge",
  );
  await screenshot(window, "mind-narrow.png");
  await setGroupBeside(window, false);

  // Two markers on one line sit side by side.
  await editor.evaluate((dom) => {
    const { view, commands } = (dom as unknown as { editor: Editor }).editor;
    const found: Record<string, unknown>[] = [];
    view.state.doc.descendants((child) => {
      if (found.length === 0 && child.type.name === "citation") found.push({ ...child.attrs });
      return found.length === 0;
    });
    const cited = found[0] ?? {};
    commands.insertContentAt(view.state.doc.content.size, {
      type: "paragraph",
      content: [
        { type: "text", text: "Copied from the Note:" },
        { type: "citation", attrs: cited },
        { type: "citation", attrs: cited },
      ],
    });
  });
  await expect(markers).toHaveCount(5);
  const [first, second] = [await box(markers.nth(3)), await box(markers.nth(4))];
  expectNear(middle(first), middle(second), 1, "the two markers' middles");
  expect
    .soft(second.x, "the second marker is right of the first")
    .toBeGreaterThanOrEqual(first.x + first.width);
  await app.close();
});

test("a quote, a highlight, a code block and a formula keep the text edge too; their boxes reach into the margin", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await useMockupSize(app, window);
  await newMind(window);
  await nameMind(window, "Tide tables");
  await enterContent(window);
  const editor = window.getByTestId("mind-editor");

  await window.keyboard.type("> High water comes about 50 minutes later each day.");
  await window.keyboard.press("Enter");
  await window.keyboard.press("Enter");
  await window.keyboard.type("==Spring tides== are the strongest of the month.");
  await window.keyboard.press("Enter");
  await window.keyboard.type("``` ");
  await window.keyboard.type("high_water = previous + minutes(50)");
  for (const _ of [1, 2, 3]) await window.keyboard.press("Enter");
  // The slash menu: 28px rows in the interface type.
  await window.keyboard.type("/");
  const menu = window.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  const row = await box(menu.getByTestId("slash-item-text"));
  expectNear(row.height, 28, 0.5, "a slash menu row");
  await screenshot(window, "slash-menu.png");
  await window.keyboard.type("math");
  await window.keyboard.press("Enter");
  await window.getByTestId("math-editor").fill("h = h_0 + a \\cos(\\omega t)");
  await window.getByTestId("math-editor").press("Enter");
  await expect(editor.locator('[data-type="block-math"] .katex')).toBeVisible();

  const edge = (await textColumn(editor)).x;
  const quote = editor.locator(":scope > blockquote");
  expectNear((await box(quote.locator("p"))).x, edge, 1, "the quote's text");
  expect((await box(quote)).x, "the quote's rule hangs in the margin").toBeLessThan(edge - 8);
  const highlighted = editor.locator(":scope > p").filter({ has: window.locator("mark") });
  expectNear((await box(highlighted)).x, edge, 1, "the highlighted paragraph");
  expectNear((await box(highlighted.locator("mark"))).x, edge, 1, "the highlight");
  const code = editor.locator(":scope pre");
  expectNear((await box(code.locator("code"))).x, edge, 1, "the code's text");
  expectNear((await box(code)).x, edge - 16, 1, "the code block's band");
  expectNear((await box(editor.locator('[data-type="block-math"]'))).x, edge, 1, "the formula");
  await screenshot(window, "blocks.png");
  await app.close();
});

/** A Skill with one tiny JavaScript script, which greets its first argument. */
async function importGreeterSkill(window: Page): Promise<void> {
  const folder = join(sources, "greeter");
  await mkdir(join(folder, "scripts"), { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: greeter\ndescription: Greets people. Use to say hello.\n---\n\nRun scripts/hello.js with the name.\n",
  );
  await writeFile(
    join(folder, "scripts", "hello.js"),
    'console.log("Hello, " + process.argv[2] + "!");\n',
  );
  await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const check = await bridge.previewSkillImport(path);
    if (!check.ok) throw new Error(check.error.message);
    await bridge.importSkill(check.preview.importId);
  }, folder);
}

/** The text of every section of an approval card starts at the same x. */
async function expectOneTextEdge(card: Locator) {
  const starts = [
    card.locator(".approval-title-text"),
    card.locator(".approval-explanation").first(),
    card.locator(".approval-label"),
    card.locator(".approval-args dt").first(),
    card.locator(".approval-actions > :first-child"),
  ];
  const x = (await box(starts[0] as Locator)).x;
  for (const start of starts) expectNear((await box(start)).x, x, 1, "a section's text");
}

test("an approval card is a ruled block whose sections share one text edge, for a Tool and for a Skill script", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addTideConnector(window);
  await importGreeterSkill(window);
  await useMockupSize(app, window);

  await newMind(window);
  await nameMind(window, "Boat trips");
  await enterContent(window);
  await window.keyboard.type("Book the morning boat from Dover, and greet the harbour master.");
  await window.keyboard.press("Enter");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Please book_boat from Dover");
  await window.keyboard.press("Enter");

  // In the assistant, under its Answer.
  const answer = assistantAnswers(window).first();
  const card = answer.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(answer.getByTestId("answer-writing")).toHaveText("Waiting for your approval");
  await expect(card.locator(".approval-title")).toHaveText("Tides wants to run book_boat");
  await expect(card.locator(".approval-title code")).toHaveText("book_boat");
  await expectOneTextEdge(card);
  // #400: the choices may wrap under the text; each is inside the card and reachable, in the
  // card's order, with Deny last and pushed to the card's right edge on its row.
  const choices = ["approval-allow-once", "approval-always-allow", "approval-deny"] as const;
  const cardBox = await box(card);
  const order = await card.evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>(".approval-actions .approval-button")].map(
      (button) => button.dataset.testid ?? "",
    ),
  );
  expect(order).toEqual([...choices]);
  const boxes = await Promise.all(
    choices.map(async (each) => {
      const button = card.getByTestId(each);
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      return box(button);
    }),
  );
  for (const choice of boxes) {
    expect(choice.x).toBeGreaterThanOrEqual(cardBox.x - 0.5);
    expect(choice.x + choice.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
    expect(choice.y).toBeGreaterThanOrEqual(cardBox.y - 0.5);
    expect(choice.y + choice.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
  }
  const [allowOnce, always, deny] = boxes as [
    (typeof boxes)[number],
    (typeof boxes)[number],
    (typeof boxes)[number],
  ];
  expect(
    deny.y > always.y + 1 || deny.x >= always.x + always.width - 1,
    "Deny after Always allow, on its row or the next",
  ).toBe(true);
  expect(
    allowOnce.y < always.y || (Math.abs(allowOnce.y - always.y) <= 1 && allowOnce.x < always.x),
    "the choices in the card's order",
  ).toBe(true);
  expect(cardBox.x + cardBox.width - (deny.x + deny.width)).toBeLessThan(24);
  await screenshot(window, "approval.png");
  await screenshot(answer, "approval-card.png");
  await card.getByTestId("approval-deny").click();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });

  // A Skill script: the same three sections; "Always run" warns in the last one.
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Run greeter scripts/hello.js for Calais");
  await window.keyboard.press("Enter");
  const second = assistantAnswers(window).nth(1);
  const scriptCard = second.getByTestId("approval-card");
  await expect(scriptCard).toBeVisible({ timeout: 15_000 });
  await expect(scriptCard.locator(".approval-title code")).toHaveText("scripts/hello.js");
  await expectOneTextEdge(scriptCard);
  await scriptCard.scrollIntoViewIfNeeded();
  await screenshot(second, "approval-script-card.png");
  await scriptCard.getByTestId("approval-always-run").click();
  await expect(scriptCard.getByTestId("always-run-warning")).toBeVisible();
  await screenshot(second, "approval-script-warning.png");
  await scriptCard.getByTestId("always-run-cancel").click();
  await scriptCard.getByTestId("approval-deny").click();
  await expect(second).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await app.close();
});

test("an approval card at 900 px in Chinese keeps one text edge and its choices in the card, Deny last", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addTideConnector(window);
  await setWindowSize(app, window, 900, 900);
  await setLanguage(window, "zh-CN");
  await newMind(window);
  await nameMind(window, "Boat trips");
  await enterContent(window);
  await window.keyboard.type("请从 Dover 订早班船。");
  await window.keyboard.press("Enter");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Please book_boat from Dover");
  await window.keyboard.press("Enter");

  const answer = assistantAnswers(window).first();
  const card = answer.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".approval-title code")).toHaveText("book_boat");
  await expectOneTextEdge(card);
  const cardBox = await box(card);
  const choices = ["approval-allow-once", "approval-always-allow", "approval-deny"] as const;
  const order = await card.evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>(".approval-actions .approval-button")].map(
      (button) => button.dataset.testid ?? "",
    ),
  );
  expect(order).toEqual([...choices]);
  const boxes = await Promise.all(choices.map(async (each) => box(card.getByTestId(each))));
  for (const choice of boxes) {
    expect(choice.x).toBeGreaterThanOrEqual(cardBox.x - 0.5);
    expect(choice.x + choice.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
    expect(choice.y).toBeGreaterThanOrEqual(cardBox.y - 0.5);
    expect(choice.y + choice.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
  }
  const [, always, deny] = boxes as [
    (typeof boxes)[number],
    (typeof boxes)[number],
    (typeof boxes)[number],
  ];
  expect(
    deny.y > always.y + 1 || deny.x >= always.x + always.width - 1,
    "Deny after Always allow, on its row or the next",
  ).toBe(true);
  await screenshot(answer, "approval-card-zh-900.png");
  await card.getByTestId("approval-deny").click();
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  for (const mindWidth of [650, 800, 1440]) {
    test(`a Question's fold chevron and the Block handle share the 40px left margin without covering each other, in a ${mindWidth}px Mind (${language})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await window.evaluate(async (chosen) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.updateSettings({ user: { language: chosen } });
      }, language);
      // A Question is asked in the assistant now (#201): a Mind written before holds one, with
      // its Answer under it.
      await mindWrittenBefore(window, "Tides", [
        { note: "Spring tides follow the Moon." },
        { question: "When do spring tides happen?", answer: "At new moon and at full moon." },
      ]);
      await window.getByTestId("mind-list-item").filter({ hasText: "Tides" }).click();
      const editor = window.getByTestId("mind-editor");
      const answer = editor.getByTestId("answer");
      await expect(answer).toHaveAttribute("data-status", "done");
      await sizeMind(app, window, mindWidth);

      const question = editor.getByTestId("question");
      const fold = question.getByTestId("question-fold");
      const handle = window.getByTestId("block-handle");
      const edge = (await textColumn(editor)).x;

      // Hover the Question: the handle shows, in the outer half of the margin, and the
      // chevron stays in the inner half. Neither covers the other, and both are in the margin.
      await slideToHandle(window, question);
      const [foldBox, handleBox] = [await box(fold), await box(handle)];
      expect(
        handleBox.x + handleBox.width,
        "the handle is left of the chevron",
      ).toBeLessThanOrEqual(foldBox.x + 0.5);
      expect(handleBox.x, "the handle is inside the margin").toBeGreaterThanOrEqual(edge - 40 - 1);
      expect(foldBox.x + foldBox.width, "the chevron is left of the text").toBeLessThanOrEqual(
        edge + 1,
      );
      // The spark gives its place to the handle, so nothing sits under it.
      await expect(question.locator(".question-spark")).toHaveCSS("opacity", "0");
      await screenshot(window, `question-margin-${language}-${mindWidth}.png`);

      // The mouse: the chevron folds the Answer and unfolds it again.
      await pointAndClick(window, fold);
      await expect(fold).toHaveAttribute("aria-expanded", "false");
      await expect(answer).toBeHidden();
      await pointAndClick(window, fold);
      await expect(answer).toBeVisible();
      await expect(fold).toHaveAttribute("aria-expanded", "true");

      // The mouse: the handle opens its menu.
      await (await slideToHandle(window, question)).click();
      await expect(window.getByTestId("block-menu")).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(window.getByTestId("block-menu")).toHaveCount(0);
      await expect(editor).toBeFocused();

      // The keyboard: the chevron takes Enter, and Shift+F10 opens the Block's menu.
      await fold.focus();
      await window.keyboard.press("Enter");
      await expect(fold).toHaveAttribute("aria-expanded", "false");
      await expect(fold).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(fold).toHaveAttribute("aria-expanded", "true");
      await question.locator(".question-text").click();
      await window.keyboard.press("Shift+F10");
      await expect(window.getByTestId("block-menu")).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(window.getByTestId("block-menu")).toHaveCount(0);
      await app.close();
    });
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the margins narrow to 40px before they fold at 760px, where a sentence's mark moves into the text and both gutters stay 40px, with the composer under the text (${language})`, async () => {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosen } });
    }, language);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);
    await nameMind(window, "Tides");
    await enterContent(window);
    const editor = window.getByTestId("mind-editor");
    await window.keyboard.type("Spring tides follow the Moon.");
    await window.keyboard.press("Enter");
    // Asked in the assistant (#201), the Answer is added to the note with its Citation.
    await addToNote(
      window,
      await askInAssistant(window, "When do spring tides happen, and what makes them stronger?"),
    );
    await expect(editor.getByTestId("citation").first()).toBeVisible();
    // A sentence the Mind has checked has a mark in the margin: the Mind's checks, not the assistant's.
    const first = editor.locator(":scope > p").first();
    await slideSelect(window, first, "Spring tides follow the Moon.");
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    const card = window.getByTestId("card");
    const column = window.locator(".mind-column");
    const gutters = async () => {
      const [text, col] = [await textColumn(editor), await box(column)];
      return { left: text.x - col.x, right: col.x + col.width - (text.x + text.width) };
    };

    // A 1,440px window with the assistant docked at its default width: the checks stay in the margin.
    await expect(window.getByTestId("assistant")).toHaveAttribute("data-dock", "right");
    expect(await (await box(window.getByTestId("assistant"))).width).toBeCloseTo(320, 0);
    const marks = card.getByTestId("claim-mark");
    await expect(marks.first()).toBeVisible();
    expect((await box(column)).width, "the Mind is under the old 900px fold").toBeLessThan(900);
    const wide = await gutters();
    expect.soft(wide.left, "the left margin holds the controls").toBeGreaterThanOrEqual(40);
    expect.soft(wide.right, "the right margin holds the checks").toBeGreaterThanOrEqual(40);

    // Narrowed, not folded, at 760px: both margins 40px, the mark still beside the text.
    await sizeMind(app, window, 760);
    const at760 = await gutters();
    expectNear(at760.left, 40, 1, "the left margin at 760px");
    expectNear(at760.right, 40, 1, "the right margin at 760px");
    await expect(marks.first()).toBeVisible();
    const mark = await box(marks.first());
    const text = await textColumn(editor);
    expect
      .soft(mark.x, "the mark's left edge is 8px after the measure")
      .toBeGreaterThanOrEqual(text.x + text.width + 8 - 2);
    expect.soft(mark.x + mark.width).toBeLessThanOrEqual(text.x + text.width + 40);

    // Folded under 760px: the mark moves into the text, at the sentence's end; both gutters stay 40px.
    await sizeMind(app, window, 650);
    await expect(marks.first()).toBeVisible();
    const foldedMark = await box(marks.first());
    const foldedText = await textColumn(editor);
    expect.soft(foldedMark.x, "the mark sits in the text").toBeGreaterThanOrEqual(foldedText.x);
    expect
      .soft(foldedMark.x + foldedMark.width, "the mark ends in the text")
      .toBeLessThanOrEqual(foldedText.x + foldedText.width);
    expect(
      await window.getByTestId("margin-checks").getByTestId("claim-mark").count(),
      "the mark is drawn, in the text",
    ).toBe(1);
    const folded = await gutters();
    expectNear(folded.left, 40, 1, "the left gutter when folded");
    expectNear(folded.right, 40, 1, "the right gutter when folded");
    expectNear(folded.left, at760.left, 1, "the text edge across the fold");

    // The composer, drawn at the foot in a window this narrow, lines up with the text.
    await setWindowSize(app, window, 900, 900);
    await expect(window.getByTestId("assistant")).toHaveAttribute("data-dock", "bottom");
    const composer = await box(window.getByTestId("composer"));
    const edge = await textColumn(editor);
    const dock = await box(window.getByTestId("assistant"));
    expectNear(composer.x, edge.x, 1, "the composer's left edge");
    expectNear(composer.x - dock.x, 40, 1, "the composer's left gutter");
    expectNear(
      dock.x + dock.width - (composer.x + composer.width),
      40,
      1,
      "the composer's right gutter",
    );
    await screenshot(window, `folded-${language}.png`);
    await app.close();
  });
}
