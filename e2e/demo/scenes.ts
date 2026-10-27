/**
 * The scenes of the README recording, in the order of the story: one person's Monday on one
 * task. Each drives the built app as a person does and leaves the model's waiting out of the film.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import type { CoreBridge } from "../../src/core/api";
import { assistantAnswers, leaveText, openDocumentAt, openSteps } from "../app";
import { say } from "./call";
import type { Film, Hand } from "./film";
import { SCENE_TABLE } from "./sceneTable";
import type { DemoScript } from "./script";
import {
  clearAside,
  command,
  dismissNotice,
  markBeside,
  openAssistant,
  openMind,
  snap,
} from "./steps";
import type { Feature } from "./stills";
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
  /** The samples of each of the call's lines, in the order the script gives them. */
  call: { samples: number[][]; voices: { them: string; me: string } };
  /** Keeps the crop of this feature picture, for the take to write once it ends. */
  still(name: Feature, targets: Locator | readonly Locator[]): Promise<void>;
}

export interface Scene {
  name: string;
  run(take: Take): Promise<void>;
  /** What the scene's picture shows, its caption and whether the film keeps its frames (see ./sceneTable). */
  still: Feature | null;
  caption: keyof DemoScript["captions"] | null;
  film: boolean;
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
  await hand.hold(600);
  const sentence = window
    .getByTestId("mind-editor")
    .locator("p", { hasText: script.wrong.draft })
    .first();
  await hand.zoomOn([sentence, card], 1.5);
  await hand.hold(1700);
  await hand.zoomOut();
}

/** Scene 1: both linked folders read; Organize sorts the new Documents, and one click files them. */
async function organize(take: Take): Promise<void> {
  const { window, hand, workspace } = take;
  const library = window.getByTestId("library");
  await hand.cut(async () => {
    await window.keyboard.press("Escape");
    if ((await window.getByTestId("claim-card").count()) > 0) await leaveText(window);
    await window.getByTestId("open-library").click();
    await expect(library).toBeVisible();
    // Every Document is read, whichever few the page lists first.
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          return (await bridge.listDocuments()).length;
        }),
      )
      .toBe(workspace.documentCount);
  }, PARK);
  await hand.hold(600);
  await hand.click(library.getByTestId("library-organize"));
  await hand.cut(async () => {
    await expect(library.getByTestId("library-organizing")).toHaveCount(0, { timeout: 300_000 });
    await expect(library.getByTestId("library-suggested").first()).toBeVisible({
      timeout: 60_000,
    });
  });
  await hand.hold(1900);
  // One click takes every suggestion: the Documents move into the Folders and take the Tags.
  await hand.click(library.getByTestId("library-review-accept-all"));
  await hand.cut(async () => {
    await expect(library.getByTestId("library-suggested")).toHaveCount(0, { timeout: 60_000 });
    await expect(library.getByTestId("library-organizing")).toHaveCount(0);
  });
  await hand.hold(900);
  // The two new files the story turns on, now in their Folder with their Tags. A row's name is
  // cut with an ellipsis, so the row is found by the Document's own id, not by what it shows.
  const ids = await window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const documents = await bridge.listDocuments();
    return [wanted.workbook, wanted.guide].map(
      (name) => documents.find((each) => each.name === name)?.id ?? "",
    );
  }, workspace.research.names);
  const rowName = (id: string) =>
    window.locator(
      `[data-testid="library-document"][data-document-id="${id}"] [data-testid="library-document-name"]`,
    );
  await take.still("sort", ids.map(rowName));
}

/** The Question is typed; the Answer streams in with Citations; one is clicked. Its picture only. */
async function ask(take: Take): Promise<void> {
  const { window, hand, film, script } = take;
  await hand.cut(async () => {
    const tabs = window.getByTestId("library-tab");
    while ((await tabs.count()) > 0) await tabs.first().getByTestId("tab-close").click();
    await clearAside(window);
    await openMind(window, script.paper.title);
    await window.getByTestId("sidebar-toggle").first().click();
    await openAssistant(window);
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type(script.question);
  }, PARK);
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
  // Pace the film only while the Answer streams: a stills-only scene keeps no frames, and an
  // Answer that ends failed must fall through to the check below rather than wait forever.
  while ((await answer.getAttribute("data-status")) === "streaming" && film.kept - streamed < 2.2) {
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
  await take.still("ask", window.getByTestId("citation-card"));
  await hand.zoomOut();
}

/** The sentence the check worked out opens its card: the formula and each input's page. */
async function formula({ window, hand, script }: Take): Promise<void> {
  await hand.cut(async () => {
    await clearAside(window);
    if ((await window.getByTestId("citation-card").count()) > 0) await leaveText(window);
  }, PARK);
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

/** Compare Documents over the term sheets, and a cell's page. Its picture only. */
async function compare(take: Take): Promise<void> {
  const { window, hand, script } = take;
  await hand.cut(async () => {
    await window.keyboard.press("Escape");
    await openMind(window, script.options.title);
  }, PARK);
  await hand.hold(200);
  await command(window, hand, script.words.typed.compare, script.words.compareCommand);
  const sheet = window.getByTestId("compare-sheet");
  await expect(sheet).toBeVisible();
  // Each question in its own row: typing through the field loses an Enter on a loaded machine,
  // and the picture only needs the filled table.
  const add = sheet.getByTestId("compare-sheet-add-question");
  for (const [index, question] of script.compareQuestions.entries()) {
    const fields = sheet.getByTestId("compare-sheet-question");
    while ((await fields.count()) <= index) await add.click();
    await fields.nth(index).fill(question);
  }
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText(/^3/);
  await hand.hold(100);
  const make = sheet.getByTestId("compare-sheet-make");
  // A stills-only scene: a direct click waits for the button to stop moving, where the hand's
  // glide can land on the list above as the Documents finish loading.
  await make.click({ timeout: 30_000 });
  const table = window.getByTestId("comparison-table");
  await expect(table).toBeVisible({ timeout: 60_000 });
  // A provider that refuses stops the table's cells: that take is not kept.
  await expect(table.locator(".comparison-cell-reading").first()).toBeVisible();
  await hand.hold(400);
  await hand.cut(async () => {
    await expect(table.getByTestId("comparison-progress")).toHaveCount(0, { timeout: 180_000 });
    await expect(table.locator(".comparison-cell-reading:visible")).toHaveCount(0);
  });
  await hand.hold(600);
  await hand.click(
    table.getByTestId("comparison-cell").first().getByTestId("citation-chip").first(),
  );
  await expect(highlighted(window)).toBeVisible();
  await hand.hold(800);
  // The first cell is the one on screen; a later column sits off the table's visible width.
  await take.still("compare", table.getByTestId("comparison-cell").first());
}

/** The Answer goes into the paper as grey text with its Undo line. */
async function addToNote(take: Take): Promise<void> {
  const { window, hand, script } = take;
  const answer = assistantAnswers(window).last();
  const editor = window.getByTestId("mind-editor");
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
    await openAssistant(window);
    await expect(answer).toBeVisible();
  }, PARK);
  await hand.hold(200);
  await hand.click(answer.getByTestId("answer-add"));
  await expect(answer.getByTestId("answer-added")).toBeVisible();
  await hand.cut(async () => {
    const box = await editor.boundingBox();
    if (box) await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, 6000);
  });
  await hand.hold(1500);
  // The Answer's own words where they end, and the line that says they went in, are one moment
  // a crop can hold; a whole line of the Note is wider than one.
  const said = answer.getByTestId("assistant-answer-text");
  await take.still("write", [said.locator("p, li").last(), answer.getByTestId("answer-added")]);
}

/** Python Analysis over the workbook: its step in the Answer, then the cited table and bar chart. */
async function analyse(take: Take): Promise<void> {
  const { window, hand, film, script } = take;
  const editor = window.getByTestId("mind-editor");
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
    await openAssistant(window);
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 240_000 });
  }, PARK);
  await hand.hold(200);
  await window.keyboard.press("ControlOrMeta+j");
  film.speed(2);
  await hand.type(script.chartRequest, 30);
  film.speed(1);
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  const timeline = await hand.cut(async () => {
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 300_000 });
    await expect(answer.getByTestId("assistant-answer-text")).not.toContainText("[=");
    const timeline = await openSteps(window, answer);
    await expect(timeline.getByTestId("answer-analysis-call").first()).toBeVisible({
      timeout: 60_000,
    });
    return timeline;
  });
  await hand.hold(400);
  await hand.zoomOn(timeline.getByTestId("answer-analysis-call").first(), 1.5);
  await hand.hold(1600);
  await hand.zoomOut();

  // The Answer wrote the table and the chart into the paper; a bar keeps its source cell.
  const chart = editor.getByTestId("chart").last();
  await hand.cut(async () => {
    await expect(chart).toBeVisible({ timeout: 120_000 });
    await chart.scrollIntoViewIfNeeded();
    await snap(window, "chart");
  });
  await hand.hold(900);
  const point = chart.getByTestId("chart-point").first();
  await hand.click(point);
  const card = window.getByTestId("chart-card");
  await expect(card).toBeVisible();
  await hand.hold(700);
  await take.still("analyse", card);
  await hand.hold(700);
}

/** The meeting the window records: its Mind, kind and how many lines its transcript has. */
async function meetingNow(
  window: Page,
): Promise<{ id: string; mindId: string; template: string | null; lines: number } | null> {
  return window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [meeting] = await bridge.listMeetings();
    if (!meeting) return null;
    return {
      id: meeting.id,
      mindId: meeting.mindId,
      template: meeting.helpTemplate,
      lines: meeting.transcript?.lines ?? 0,
    };
  });
}

const meetingTab = (window: Page, mindId: string) =>
  window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`);

const helpButton = (window: Page, kind: "followUp" | "notCovered") =>
  window.locator(`[data-testid="help-button"][data-kind="${kind}"]`);

/** The talk so far, said in order, each line on the side the script gives it. */
async function speak(take: Take, from: number, to: number): Promise<void> {
  const { script, app } = take;
  for (let index = from; index < to; index++) {
    const line = script.call.lines[index];
    const samples = take.call.samples[index];
    if (!line || !samples) throw new Error(`The call has no line ${index}.`);
    await say(app, line.side === "me" ? "microphone" : "system", samples);
  }
}

/** An expert interview: the interview's help, a follow-up, then the guide's topics not covered. */
async function call(take: Take): Promise<void> {
  const { window, hand, script } = take;
  const notice = window.getByTestId("meeting-notice");
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
    // The Mind redraws while an earlier check or Answer is still running: wait for it to settle.
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 240_000 });
    await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
      timeout: 240_000,
    });
    await command(window, hand, script.words.typed.record, script.words.recordCommand);
    // The button sits at the window's left edge, where the pointer would pull the sidebar out over it.
    await window
      .getByTestId("meeting-start")
      .getByTestId("meeting-start-record")
      .evaluate((button) => (button as HTMLElement).click());
    await expect(notice).toBeVisible();
  }, PARK);
  await hand.hold(700);
  await hand.click(notice.getByTestId("meeting-notice-start"));
  const bar = window.getByTestId("meeting-bar");
  await expect(bar).toHaveAttribute("data-status", "recording");

  const meeting = await hand.cut(async () => {
    // The interview's kind adds the two buttons. The floating panel has them on a User's screen,
    // off the film's window; turning it off puts the same buttons in the assistant's strip.
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(script.words.templateCommand);
    await expect(
      window.getByTestId("palette-item").filter({ hasText: script.words.templateCommand }).first(),
    ).toBeVisible();
    await window.keyboard.press("Enter");
    await expect.poll(async () => (await meetingNow(window))?.template).toBe("interview");
    if ((await bar.getByTestId("meeting-call-help").getAttribute("aria-pressed")) === "true") {
      await bar.getByTestId("meeting-call-help").click();
    }
    await openAssistant(window);
    await window.getByTestId("assistant-new-chat").click();
    await window.getByTestId("mind-editor").click();
    await window.keyboard.type(script.callNote);
    await expect(window.getByTestId("help-strip")).toBeVisible();
    const started = await meetingNow(window);
    if (!started) throw new Error("The call did not start.");
    return started;
  });

  // The expert sets the scene, then says what changed: the follow-up digs into that. The talk is
  // heard off camera; the film keeps the transcript and the Answers, not the wait for speech.
  await hand.cut(async () => {
    await speak(take, 0, 3);
    await expect
      .poll(async () => (await meetingNow(window))?.lines ?? 0, { timeout: 300_000 })
      .toBeGreaterThanOrEqual(3);
  });
  await hand.click(bar.getByTestId("meeting-transcript-toggle"));
  await expect(window.getByTestId("transcript-line").nth(2)).toBeVisible({ timeout: 300_000 });
  await hand.hold(1400);
  await hand.cut(async () => {
    await meetingTab(window, meeting.mindId).click();
    await expect(window.getByTestId("help-strip")).toBeVisible();
  });
  await hand.click(helpButton(window, "followUp"));
  const followUp = assistantAnswers(window).last();
  await hand.cut(() =>
    expect(followUp).toHaveAttribute("data-status", "done", { timeout: 240_000 }),
  );
  await hand.hold(400);
  await hand.zoomOn(followUp, 1.5);
  await hand.hold(1800);
  await hand.zoomOut();

  // The talk drifts away from the guide.
  await hand.cut(async () => {
    await speak(take, 3, 5);
    await expect
      .poll(async () => (await meetingNow(window))?.lines ?? 0, { timeout: 300_000 })
      .toBeGreaterThanOrEqual(5);
  });
  // The live transcript again, Me and Them, on its way off the guide.
  const transcriptTab = window.getByTestId("document-tab").last();
  await hand.click(transcriptTab);
  await expect(window.getByTestId("transcript-line").nth(4)).toBeVisible({ timeout: 60_000 });
  await hand.hold(1200);
  await hand.cut(async () => {
    await meetingTab(window, meeting.mindId).click();
    await expect(window.getByTestId("help-strip")).toBeVisible();
  });
  // The guide's topics the call hasn't covered, each cited to the guide.
  hand.caption(script.captions.notCovered);
  await hand.click(helpButton(window, "notCovered"));
  const notCovered = assistantAnswers(window).last();
  await hand.cut(() =>
    expect(notCovered).toHaveAttribute("data-status", "done", { timeout: 240_000 }),
  );
  await expect(notCovered.getByTestId("citation").first()).toBeVisible();
  await hand.hold(400);
  await hand.zoomOn(notCovered, 1.5);
  await hand.hold(1800);
  // The first of the guide's topics the call missed: a whole Answer can be taller than a crop.
  const said = notCovered.getByTestId("assistant-answer-text");
  const firstMissing = said.locator("li").first();
  await take.still("meet", (await firstMissing.count()) > 0 ? firstMissing : said);
  await hand.zoomOut();

  // What comes next is said off camera, for the notes: what the expert will send, and when.
  await hand.cut(async () => {
    await speak(take, 5, 7);
    await expect
      .poll(async () => (await meetingNow(window))?.lines ?? 0, { timeout: 300_000 })
      .toBeGreaterThanOrEqual(7);
  });

  // Stop: the notes fill in from the transcript.
  await hand.click(bar.getByTestId("meeting-stop"));
  await hand.cut(() =>
    expect(window.getByTestId("meeting-fill-line")).toContainText(script.words.filled, {
      timeout: 300_000,
    }),
  );
  hand.caption(script.captions.callNotes);
  await hand.hold(1900);
}

/** After Stop: the notes the call filled in, and one citation opening its transcript line. */
async function notes(take: Take): Promise<void> {
  const { window, hand, script } = take;
  const editor = window.getByTestId("mind-editor");
  await hand.cut(async () => {
    await expect(window.getByTestId("meeting-fill-line")).toContainText(script.words.filled, {
      timeout: 300_000,
    });
    await window.keyboard.press("Escape");
  });
  await hand.hold(600);
  const citation = editor.getByTestId("citation").last();
  await hand.click(citation);
  await expect(window.getByTestId("citation-card")).toBeVisible();
  await hand.hold(700);
  // With one group on screen the card opens first and its Open brings the Transcript at the line.
  await hand.click(window.getByTestId("citation-open"));
  await expect(window.getByTestId("transcript-line").first()).toBeVisible({ timeout: 60_000 });
  await hand.hold(700);
  const quoted = highlighted(window);
  const line =
    (await quoted.count()) > 0 ? quoted.first() : window.getByTestId("transcript-line").first();
  await hand.hold(900);
  await hand.zoomOn(line, 1.5);
  await hand.hold(1400);
  await hand.zoomOut();
}

/** Scene 6: Check this note marks the wrong figure again; it is corrected and the mark turns green. */
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
  // The mark opens the card that says which page the figure contradicts.
  await hand.click(wrong);
  const card = window.getByTestId("claim-card");
  await expect(card).toBeVisible();
  await hand.hold(500);
  await take.still("check", [
    card.getByTestId("claim-badge"),
    card.getByTestId("claim-quote"),
    card.getByTestId("claim-source"),
  ]);
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

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
async function exportToWord(take: Take): Promise<void> {
  const { window, hand, script } = take;
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
  }, PARK);
  await hand.hold(300);
  await hand.click(window.getByTestId("export-mind"));
  const menu = window.getByTestId("export-menu");
  await expect(menu).toBeVisible();
  if ((await menu.getByTestId("export-as-docx").count()) === 0) {
    await hand.click(menu.getByTestId("export-more"));
  }
  await hand.hold(300);
  // The moment: the export the card's sentence names, in the menu that offers it.
  await take.still("export", window.getByTestId("export-as-docx"));
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
  // The card's first line is the README's own, as the owner wrote it there.
  const readme = await readFile(join(repository, script.readme), "utf8");
  const headline = readme.match(/<p align="center">[\s\S]*?<b>([^<]+)<\/b>/)?.[1];
  if (!headline) throw new Error("The README has no first line for the end card.");
  const icon = await readFile(join(repository, "build/icon/svg/mac-light.svg"));
  return {
    icon: `data:image/svg+xml;base64,${icon.toString("base64")}`,
    lines: [headline, ...script.endCard.lines],
  };
}

/** The end card: a still. */
async function endCard({ hand, script }: Take): Promise<void> {
  const card = await endCardContent(script);
  await hand.cut(() => hand.endCard(card));
  await hand.hold(2200);
}

/** What each scene runs: a name in ./sceneTable without a run here is a scene the take cannot film. */
const RUN: Readonly<Record<string, (take: Take) => Promise<void>>> = {
  hook,
  organize,
  ask,
  "add to note": addToNote,
  analyse,
  check,
  formula,
  compare,
  export: exportToWord,
  call,
  notes,
  "end card": endCard,
};

/** The scenes in the table's order, each with the film and picture the table gives it. */
export const SCENES: Scene[] = SCENE_TABLE.map((row) => {
  const run = RUN[row.scene];
  if (!run) throw new Error(`The scene table names “${row.scene}”, which has no run.`);
  return { name: row.scene, run, still: row.still, caption: row.caption, film: row.film };
});
