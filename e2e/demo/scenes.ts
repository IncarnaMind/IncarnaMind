/**
 * The scenes of the README recording, in the order of the story: one person's Monday on one
 * task. Each drives the built app as a person does and leaves the model's waiting out of the film.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import type { CoreBridge } from "../../src/core/api";
import { assistantAnswers, leaveText, openDocumentAt } from "../app";
import { say } from "./call";
import type { Film, Hand } from "./film";
import type { DemoScript } from "./script";
import { clearAside, command, dismissNotice, markBeside, openMind, snap } from "./steps";
import type { Workspace } from "./workspace";

const repository = resolve(__dirname, "../..");

/** Where the pointer waits at the start of a scene: over nothing, so no card opens under it. */
const PARK = { x: 640, y: 600 };

export interface Take {
  window: Page;
  hand: Hand;
  film: Film;
  script: DemoScript;
  app: ElectronApplication;
  output: string;
  workspace: Workspace;
  voices: { them: number[]; me: number[] };
}

export interface Scene {
  name: string;
  run(take: Take): Promise<void>;
}

const bridgeOf = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

const highlighted = (window: Page) =>
  window.getByTestId("viewer").locator("[data-quote-highlight]").first();

/** Scene 0: the film opens on the payoff, a wrong figure caught, with its card open. */
async function hook({ window, hand, script }: Take): Promise<void> {
  const mark = window.locator('[data-testid="claim-mark"][data-check="contradicted"]');
  const box = await mark.boundingBox();
  if (!box) throw new Error("The wrong figure has no mark.");
  const card = window.getByTestId("claim-card");
  await hand.cut(
    async () => {
      await mark.click();
      await expect(card).toContainText(script.wrong.document);
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  hand.caption(script.captions.hook);
  await hand.hold(600);
  const sentence = window
    .getByTestId("mind-editor")
    .locator("p", { hasText: script.wrong.draft })
    .first();
  await hand.zoomOn([sentence, card], 1.5);
  await hand.hold(1700);
  await hand.zoomOut();
}

/** Scene 1: the Library has read the lenders' new Documents; Organize suggests a Folder and Tags. */
async function organize({ window, hand, script }: Take): Promise<void> {
  hand.caption(script.captions.organize);
  const library = window.getByTestId("library");
  await hand.cut(async () => {
    await window.keyboard.press("Escape");
    if ((await window.getByTestId("claim-card").count()) > 0) await leaveText(window);
    await window.getByTestId("open-library").click();
    await expect(library).toBeVisible();
    await expect(library.getByTestId("library-document")).toHaveCount(5);
  }, PARK);
  await hand.hold(600);
  await hand.click(library.getByTestId("library-organize"));
  await hand.cut(async () => {
    await expect(library.getByTestId("library-suggested")).toHaveCount(3, { timeout: 180_000 });
    await expect(library.getByTestId("library-organizing")).toHaveCount(0, { timeout: 180_000 });
  });
  await hand.hold(1900);
}

/** Scene 2: the Question is typed; the Answer streams in with Citations; one is clicked. */
async function ask({ window, hand, film, script }: Take): Promise<void> {
  await hand.cut(async () => {
    const tabs = window.getByTestId("library-tab");
    while ((await tabs.count()) > 0) await tabs.first().getByTestId("tab-close").click();
    await clearAside(window);
    await openMind(window, script.paper.title);
    await window.getByTestId("sidebar-toggle").first().click();
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type(script.question);
  }, PARK);
  hand.caption(script.captions.ask);
  await hand.hold(500);
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  await hand.hold(500);
  await hand.cut(() =>
    expect
      .poll(async () => (await answer.getByTestId("assistant-answer-text").innerText()).length, {
        timeout: 90_000,
      })
      .toBeGreaterThan(40),
  );
  film.speed(2);
  const streamed = film.kept;
  while ((await answer.getAttribute("data-status")) !== "done" && film.kept - streamed < 2.2) {
    await hand.hold(100);
  }
  film.speed(1);
  await hand.cut(() => expect(answer).toHaveAttribute("data-status", "done", { timeout: 90_000 }));
  // Markdown the Answer shows as typed ("**") is the app's own problem, but not what the demo opens on.
  const said = await answer.getByTestId("assistant-answer-text").innerText();
  expect(said).not.toContain("**");
  expect(said).not.toMatch(script.words.failed);
  film.mark("answer");
  const citation = answer.getByTestId("citation").first();
  await expect(citation).toHaveAttribute("data-check", "found");
  await hand.hold(600);
  hand.caption(script.captions.click);
  film.mark("click");
  await hand.click(citation.getByTestId("citation-chip"));
  await expect(highlighted(window)).toBeVisible();
  await hand.hold(300);
  await hand.zoomOn([highlighted(window), window.getByTestId("citation-card")], 1.6);
  await hand.hold(1400);
  await hand.zoomOut();
}

/** Scene 2b: the sentence the check worked out opens its card: the formula and each input's page. */
async function formula({ window, hand, script }: Take): Promise<void> {
  await hand.cut(async () => {
    await clearAside(window);
    if ((await window.getByTestId("citation-card").count()) > 0) await leaveText(window);
  }, PARK);
  hand.caption(script.captions.working);
  const derived = script.paper.blocks[6]?.text.slice(0, 12) ?? "";
  const mark = await markBeside(window, derived);
  await hand.click(mark);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-working")).toBeVisible();
  await hand.hold(200);
  await hand.zoomOn(card, 1.5);
  await hand.hold(1400);
  await hand.zoomOut();
}

/** Scene 3: Compare Documents over three term sheets, and a cell's page. */
async function compare(take: Take): Promise<void> {
  const { window, hand, film, script } = take;
  await hand.cut(async () => {
    await window.keyboard.press("Escape");
    await openMind(window, script.options.title);
  }, PARK);
  hand.caption(script.captions.compare);
  await hand.hold(200);
  await command(window, hand, script.words.typed.compare, script.words.compareCommand);
  const sheet = window.getByTestId("compare-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText(/^3/);
  film.speed(2);
  for (const [index, question] of script.compareQuestions.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await hand.type(question, 60);
  }
  film.speed(1);
  await hand.hold(100);
  await hand.click(sheet.getByTestId("compare-sheet-make"));
  const table = window.getByTestId("comparison-table");
  await expect(table).toBeVisible();
  // A provider that refuses stops the table's cells: that take is not kept.
  await expect(table.locator(".comparison-cell-reading").first()).toBeVisible();
  await hand.hold(400);
  await hand.cut(async () => {
    await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 180_000 });
    await expect(table.locator(".comparison-cell-reading:visible")).toHaveCount(0);
  });
  await hand.hold(600);
  await hand.click(
    table.getByTestId("comparison-cell").nth(2).getByTestId("citation-chip").first(),
  );
  await expect(highlighted(window)).toBeVisible();
  await hand.hold(800);
}

/** Scene 4: the Answer goes into the paper as grey text with its Undo, and a chart from the same numbers. */
async function addToNote(take: Take): Promise<void> {
  const { window, hand, film, script } = take;
  const answer = assistantAnswers(window).last();
  const editor = window.getByTestId("mind-editor");
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
    await expect(answer).toBeVisible();
  }, PARK);
  hand.caption(script.captions.addToNote);
  await hand.hold(200);
  await hand.click(answer.getByTestId("answer-add"));
  await expect(answer.getByTestId("answer-added")).toBeVisible();
  await hand.cut(async () => {
    const box = await editor.boundingBox();
    if (box) await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, 6000);
  });
  await hand.hold(1500);

  hand.caption(script.captions.chart);
  await window.keyboard.press("ControlOrMeta+j");
  film.speed(2);
  await hand.type(script.chartRequest, 40);
  film.speed(1);
  await window.keyboard.press("Enter");
  const chart = editor.getByTestId("chart");
  await hand.cut(async () => {
    await expect(chart).toBeVisible({ timeout: 120_000 });
    await chart.scrollIntoViewIfNeeded();
    await snap(window, "chart");
  });
  await hand.hold(1700);
}

/** Scene 5: a test call; the transcript, call help, and the notes after Stop. */
async function call(take: Take): Promise<void> {
  const { window, hand, script, app, voices } = take;
  const notice = window.getByTestId("meeting-notice");
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
    // The Mind redraws while an earlier check or Answer is still running: wait for it to settle.
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 120_000 });
    await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
      timeout: 120_000,
    });
    await command(window, hand, script.words.typed.record, script.words.recordCommand);
    // The button sits at the window's left edge, where the pointer would pull the sidebar out over it.
    await window
      .getByTestId("meeting-start")
      .getByTestId("meeting-start-record")
      .evaluate((button) => (button as HTMLElement).click());
    await expect(notice).toBeVisible();
  }, PARK);
  hand.caption(script.captions.call);
  await hand.hold(700);
  await hand.click(notice.getByTestId("meeting-notice-start"));
  const bar = window.getByTestId("meeting-bar");
  await expect(bar).toHaveAttribute("data-status", "recording");

  await hand.cut(async () => {
    if ((await window.getByTestId("assistant").getAttribute("data-folded")) === "true") {
      await window.keyboard.press("ControlOrMeta+j");
    }
    await window.getByTestId("assistant-new-chat").click();
    await bar.getByTestId("meeting-call-help").click();
    await window.getByTestId("mind-editor").click();
    await window.keyboard.type(script.callNote);
    await say(app, "system", voices.them);
    await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 240_000 });
    await bar.getByTestId("meeting-transcript-toggle").click();
    await expect(window.getByTestId("transcript-line")).toHaveCount(1);
  });
  await hand.hold(500);
  await hand.click(
    window.getByTestId("help-button").filter({ hasText: script.words.answerTheirQuestion }).first(),
  );
  const help = assistantAnswers(window).last();
  await hand.hold(300);
  await hand.cut(() => expect(help).toHaveAttribute("data-status", "done", { timeout: 120_000 }));
  await hand.hold(200);
  await hand.zoomOn(help, 1.6);
  await hand.hold(1600);
  await hand.zoomOut();

  await hand.cut(async () => {
    await say(app, "microphone", voices.me);
    const lines = window.getByTestId("transcript-line");
    await expect(lines.last().getByTestId("transcript-speaker")).toHaveText(script.words.me, {
      timeout: 120_000,
    });
    // The line grows as the engine reads the rest of what was said: the cut ends on the figures.
    await expect
      .poll(async () => (await lines.allInnerTexts()).join(" "), { timeout: 60_000 })
      .toMatch(script.words.heard);
  });
  await hand.hold(300);
  await hand.click(bar.getByTestId("meeting-stop"));
  await hand.cut(() =>
    expect(window.getByTestId("meeting-fill-line")).toContainText(script.words.filled, {
      timeout: 240_000,
    }),
  );
  hand.caption(script.captions.callNotes);
  await hand.hold(1900);
}

/** Scene 6: Check this Mind marks the wrong figure again; it is corrected and the mark turns green. */
async function check(take: Take): Promise<void> {
  const { window, hand, film, script } = take;
  const editor = window.getByTestId("mind-editor");
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
    const box = await editor.boundingBox();
    if (box) await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, -6000);
  }, PARK);
  hand.caption(script.captions.check);
  await hand.hold(200);
  await command(window, hand, script.words.typed.check, script.words.checkCommand);
  // The question comes with its estimate once the claims are found: a moment the recording leaves out.
  const ask = window.getByTestId("mind-check-check");
  const asked = await hand.cut(() =>
    ask
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false),
  );
  if (asked) await hand.click(ask);
  await hand.cut(async () => {
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 240_000 });
    await expect(window.getByTestId("claim-mark").first()).toBeVisible();
    await window.keyboard.press("Escape");
  });
  const wrong = window.locator('[data-testid="claim-mark"][data-check="contradicted"]');
  await expect(wrong).toHaveCount(1);
  const sentence = editor.locator("p", { hasText: script.wrong.draft }).first();
  const box = await sentence.boundingBox();
  if (!box) throw new Error("The wrong figure's sentence isn't showing.");
  film.mark("wrong");
  await hand.zoomOnRect(
    { x: box.x - 10, y: box.y - 30, width: box.width + 70, height: box.height + 260 },
    1.5,
  );
  await hand.hold(500);

  // The correction, typed over the figure as a person does.
  const figure = await figureAt(window, script.wrong.draft);
  await hand.doubleClickAt(figure.x, figure.y);
  await hand.hold(150);
  await hand.type(script.wrong.document, 80);
  await hand.hold(300);
  const again = window.locator('[data-testid="claim-mark"][data-check="needs-recheck"]');
  await expect(again).toHaveCount(1);
  await hand.click(again);
  await hand.click(window.getByTestId("claim-check-again"));
  const green = window.locator('[data-testid="claim-mark"][data-check="supported"]');
  await hand.cut(async () => {
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 120_000 });
    await expect(window.locator('[data-testid="claim-mark"][data-check="checking"]')).toHaveCount(
      0,
    );
    await expect(wrong).toHaveCount(0);
    await expect(again).toHaveCount(0);
    await expect(green.first()).toBeVisible();
  });
  await hand.hold(1100);
  film.mark("fixed");
  await hand.zoomOut();
}

/** The middle of a text in the Mind, in the window's pixels. */
async function figureAt(window: Page, text: string): Promise<{ x: number; y: number }> {
  const at = await window.evaluate((needle) => {
    const root = document.querySelector('[data-testid="mind-editor"]');
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const start = node.data.indexOf(needle);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return null;
  }, text);
  if (!at) throw new Error(`The Mind has no “${text}”.`);
  return at;
}

/** Scene 7: Export to Word, the Saved line, and the file as the app shows it. */
async function exportToWord({ window, hand, script }: Take): Promise<void> {
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
  }, PARK);
  hand.caption(script.captions.export);
  await hand.hold(300);
  await hand.click(window.getByTestId("export-mind"));
  const menu = window.getByTestId("export-menu");
  await expect(menu).toBeVisible();
  if ((await menu.getByTestId("export-as-docx").count()) === 0) {
    await hand.click(menu.getByTestId("export-more"));
  }
  await hand.click(window.getByTestId("export-as-docx"));
  const done = window.getByTestId("export-result").getByTestId("export-done");
  await expect(done).toContainText(script.words.saved, { timeout: 60_000 });
  await hand.hold(700);

  await hand.cut(async () => {
    const path = (await done.getAttribute("title")) ?? "";
    const documentId = await (await bridgeOf(window)).evaluate(async (bridge, file) => {
      const [added] = (await bridge.addDocuments([file], {})).documents;
      return added?.id ?? "";
    }, path);
    await window.waitForFunction(
      async (id) =>
        (
          await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
        ).some((each) => each.id === id && each.status === "ready"),
      documentId,
      { timeout: 60_000 },
    );
    // The file alone beside the assistant, so its page and footnotes read at the recording's size.
    const open = window.getByTestId("mind-tab");
    while ((await open.count()) > 0) {
      await open.first().click();
      await window.keyboard.press("ControlOrMeta+w");
    }
    await openDocumentAt(window, { documentId });
    await expect(window.getByTestId("viewer")).toBeVisible();
    await dismissNotice(window);
    await expect(window.getByTestId("viewer-docx")).toHaveAttribute("data-rendered", "yes");
  });
  await hand.hold(500);
  // Down the page to its footnotes, with the wheel.
  const pane = window.getByTestId("viewer-docx");
  const footnote = pane.getByText(script.words.footnote).last();
  await hand.cut(async () => {
    const at = await pane.boundingBox();
    if (at) await hand.place(at.x + at.width / 2, at.y + at.height / 2);
    const [paneBox, noteBox] = await Promise.all([pane.boundingBox(), footnote.boundingBox()]);
    let remaining =
      (noteBox?.y ?? 0) +
      (noteBox?.height ?? 0) +
      30 -
      ((paneBox?.y ?? 0) + (paneBox?.height ?? 0));
    while (remaining > 0) {
      const step = Math.min(120, remaining);
      await window.mouse.wheel(0, step);
      remaining -= step;
      await hand.hold(40);
    }
  });
  await hand.hold(200);
  await hand.zoomOn(footnote, 1.6);
  await hand.hold(1300);
  await hand.zoomOut();
}

/** The end card's words, from the README's own, and the app's icon. */
export async function endCardContent(
  script: DemoScript,
): Promise<{ icon: string; lines: string[] }> {
  const readme = await readFile(join(repository, script.readme), "utf8");
  const [headline, shows, free, address] = script.endCard.lines;
  const lines = [
    headline,
    shows,
    ...(readme.includes(script.endCard.audience) ? [script.endCard.audience] : []),
    free,
    address,
  ].filter((line): line is string => line !== undefined);
  const icon = await readFile(join(repository, "build/icon/svg/mac-light.svg"));
  return { icon: `data:image/svg+xml;base64,${icon.toString("base64")}`, lines };
}

/** The end card: a still. */
async function endCard({ hand, script }: Take): Promise<void> {
  const card = await endCardContent(script);
  hand.caption(null);
  await hand.cut(() => hand.endCard(card));
  await hand.hold(2200);
}

export const SCENES: Scene[] = [
  { name: "hook", run: hook },
  { name: "organize", run: organize },
  { name: "ask", run: ask },
  { name: "formula", run: formula },
  { name: "compare", run: compare },
  { name: "add to note", run: addToNote },
  { name: "call", run: call },
  { name: "check", run: check },
  { name: "export", run: exportToWord },
  { name: "end card", run: endCard },
];
