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
import { clearAside, command, dismissNotice, openAssistant, openMind, snap } from "./steps";
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
  still(
    name: Feature,
    targets: Locator | readonly Locator[],
    frame?: "bottom" | "top" | { anchor: "top"; topAt: Locator },
  ): Promise<void>;
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
      await expect(card).toContainText(script.words.contradicted);
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  await hand.hold(400);
  const sentence = window
    .getByTestId("mind-editor")
    .locator("p", { hasText: script.wrong.draft })
    .first();
  await hand.zoomOn([sentence, card], 1.5);
  await hand.hold(1350);
  await hand.zoomOut();
}

/** Scene 1: both linked folders read; Organize sorts the new Documents, and one click files them. */
async function organize(take: Take): Promise<void> {
  const { window, hand, workspace } = take;
  // The Chinese run's check more often flags a sentence of the draft, and the film settles it
  // on camera; the Chinese holds are shorter so the film stays at sixty seconds with or
  // without that beat.
  const hold = take.script.language === "zh-CN" ? 3400 : 3700;
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
  await hand.hold(800);
  await hand.click(library.getByTestId("library-organize"));
  await hand.cut(async () => {
    await expect(library.getByTestId("library-organizing")).toHaveCount(0, { timeout: 300_000 });
    await expect(library.getByTestId("library-suggested").first()).toBeVisible({
      timeout: 60_000,
    });
  });
  await hand.hold(hold);
  // One click takes every suggestion: the Documents move into the Folders and take the Tags.
  await hand.click(library.getByTestId("library-review-accept-all"));
  await hand.cut(async () => {
    await expect(library.getByTestId("library-suggested")).toHaveCount(0, { timeout: 60_000 });
    await expect(library.getByTestId("library-organizing")).toHaveCount(0);
  });
  await hand.hold(1800);
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
  hand.caption(script.captions.click);
  film.mark("click");
  // Both languages' pictures must show one Citation: the online margin's 32.1%, whichever
  // Citation the model put first. It is clicked as a person would and the card is kept open.
  const citations = answer.getByTestId("citation");
  await expect(citations.first()).toHaveAttribute("data-check", "found");
  await hand.hold(300);
  const cards = window.getByTestId("citation-card");
  let picked = -1;
  for (let index = 0; index < (await citations.count()); index++) {
    await citations.nth(index).getByTestId("citation-chip").click();
    const card = cards.last();
    await expect(card).toBeVisible();
    if ((await card.innerText()).includes("32.1")) {
      picked = index;
      break;
    }
    await window.keyboard.press("Escape");
  }
  if (picked < 0) throw new Error("The Answer has no Citation to the online margin.");
  await expect(highlighted(window)).toBeVisible({ timeout: 60_000 });
  await hand.hold(300);
  await take.still("ask", cards.last());
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
  // The three term sheets: the Contracts Folder is chosen, not whatever the sheet opened on,
  // and its list can arrive a Document at a time.
  await sheet.getByTestId("compare-sheet-source").click();
  await window.getByRole("menuitem", { name: script.folders.contracts.name, exact: true }).click();
  const docBoxes = sheet.getByTestId("compare-sheet-document");
  await expect.poll(() => docBoxes.count(), { timeout: 60_000 }).toBe(3);
  for (let index = 0; index < 3; index++) {
    if (!(await docBoxes.nth(index).isChecked())) await docBoxes.nth(index).check();
  }
  await expect(sheet.getByTestId("compare-sheet-counted")).toHaveText(/^3/, { timeout: 30_000 });
  // Each question in its own row: typing through the field loses an Enter on a loaded machine,
  // and the picture only needs the filled table. A row arrives after its click, so wait for it.
  const add = sheet.getByTestId("compare-sheet-add-question");
  const fields = sheet.getByTestId("compare-sheet-question");
  const counted = sheet.getByTestId("compare-sheet-counted");
  const wanted = script.compareQuestions;
  // The sheet's own load can replace what was typed as it arrives: fill until it holds them all.
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const [index, question] of wanted.entries()) {
      while ((await fields.count()) <= index) {
        const before = await fields.count();
        await add.click();
        await expect.poll(() => fields.count(), { timeout: 10_000 }).toBeGreaterThan(before);
      }
      const field = fields.nth(index);
      if ((await field.inputValue()) !== question) await field.fill(question);
    }
    if ((await counted.innerText()).startsWith(String(wanted.length))) break;
  }
  await expect(counted).toHaveText(/^3/, { timeout: 30_000 });
  await hand.hold(100);
  const make = sheet.getByTestId("compare-sheet-make");
  // A stills-only scene: a direct click waits for the button to stop moving, where the hand's
  // glide can land on the list above as the Documents finish loading.
  await make.click({ timeout: 30_000 });
  // A run this size asks first; its own Make the table starts it.
  const askMake = sheet.getByTestId("compare-sheet-ask-make");
  const table = window.getByTestId("comparison-table");
  await expect
    .poll(async () => (await askMake.count()) > 0 || (await table.count()) > 0, {
      timeout: 30_000,
    })
    .toBe(true);
  if ((await askMake.count()) > 0) await askMake.click({ timeout: 30_000 });
  await expect(table).toBeVisible({ timeout: 120_000 });
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
  // The picture is the table's cells with their Citations: the card the click opened is put
  // away before it, and the pointer with it, so no half-faded card lies over the table.
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("citation-card")).toHaveCount(0);
  await hand.place(PARK.x, PARK.y);
  await hand.hold(300);
  // The picture starts at the comparison's menu row: the row itself is the top of the frame,
  // and nothing above it — the Mind's own heading — is in the picture. Both languages' headings
  // wrap to different heights, so the row, not a fixed offset, is the anchor.
  const menuRow = table.getByTestId("comparison-title").first();
  const heading = window.getByTestId("mind-editor").locator("h1").first();
  // The pane scrolls so the menu row sits at its top: the heading leaves the view, and the
  // picture can start at the row with nothing above it.
  await menuRow.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect
    .poll(() =>
      menuRow.evaluate((element) => {
        const scroller = element.closest(".mind-scroller");
        if (!scroller) return 999;
        return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
      }),
    )
    .toBeLessThan(40);
  await hand.hold(200);
  const [rowBox, headingBox] = await Promise.all([menuRow.boundingBox(), heading.boundingBox()]);
  if (rowBox && headingBox && headingBox.y + headingBox.height > rowBox.y + 0.5) {
    throw new Error(
      "The heading reaches into the comparison's menu row; the picture would slice it.",
    );
  }
  await take.still(
    "compare",
    [
      menuRow,
      table.getByTestId("comparison-add-question").first(),
      table.getByTestId("comparison-cell").first(),
    ],
    { anchor: "top", topAt: menuRow },
  );
  // Its own tab goes, so the export's picture does not carry a strip naming another task.
  await hand.cut(async () => {
    const tab = window.getByTestId("mind-tab").filter({ hasText: script.options.title }).first();
    if ((await tab.count()) > 0) {
      await tab.click();
      await window.keyboard.press("ControlOrMeta+w");
    }
  });
}

/** The Answer goes into the paper as grey text with its Undo line. */
async function addToNote(take: Take): Promise<void> {
  const { window, hand, script } = take;
  const hold = script.language === "zh-CN" ? 3500 : 3600;
  const answer = assistantAnswers(window).last();
  const editor = window.getByTestId("mind-editor");
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
    await openAssistant(window);
    await expect(answer).toBeVisible();
  }, PARK);
  await hand.hold(400);
  await hand.click(answer.getByTestId("answer-add"));
  await expect(answer.getByTestId("answer-added")).toBeVisible();
  await hand.cut(async () => {
    const box = await editor.boundingBox();
    if (box) await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, 6000);
  });
  await hand.hold(hold);
  // The Answer's own words where they end, and the line that says they went in, are one moment
  // a crop can hold; a whole line of the Note is wider than one.
  const said = answer.getByTestId("assistant-answer-text");
  await take.still("write", [said.locator("p, li").last(), answer.getByTestId("answer-added")]);
}

/** Python Analysis over the workbook: its step in the Answer, then the cited table and bar chart. */
async function analyse(take: Take): Promise<void> {
  const { window, hand, script } = take;
  const editor = window.getByTestId("mind-editor");
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
    await openAssistant(window);
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 240_000 });
  }, PARK);
  await hand.hold(200);
  // The Question is typed off camera: the film keeps the steps and the chart, not the typing.
  await hand.cut(async () => {
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type(script.chartRequest);
    await window.keyboard.press("Enter");
  });
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
  await hand.hold(300);
  await hand.zoomOn(timeline.getByTestId("answer-analysis-call").first(), 1.5);
  await hand.hold(900);
  await hand.zoomOut();

  // The Answer wrote the table and the chart into the paper; a bar keeps its source cell.
  const chart = editor.getByTestId("chart").last();
  await hand.cut(async () => {
    await expect(chart).toBeVisible({ timeout: 120_000 });
    await chart.scrollIntoViewIfNeeded();
    await snap(window, "chart");
  });
  await hand.hold(600);
  const point = chart.getByTestId("chart-point").first();
  await hand.click(point);
  const card = window.getByTestId("chart-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await hand.hold(350);
  await take.still("analyse", card);
  await hand.hold(350);
}

/** The meeting the window records: its Mind, kind and how many lines its transcript has. */
async function meetingNow(
  window: Page,
): Promise<{ id: string; mindId: string; template: string | null } | null> {
  return window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [meeting] = await bridge.listMeetings();
    if (!meeting) return null;
    return {
      id: meeting.id,
      mindId: meeting.mindId,
      template: meeting.helpTemplate,
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
  await hand.hold(250);
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
    await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 240_000 });
  });
  await hand.click(bar.getByTestId("meeting-transcript-toggle"));
  await expect(window.getByTestId("transcript-line").first()).toBeVisible({ timeout: 120_000 });
  // The transcript has the expert's words before the follow-up, and the User's line on the Me
  // side: content and speakers, not how many rows the engine split the speech into.
  await hand.cut(async () => {
    const lines = window.getByTestId("transcript-line");
    await expect
      .poll(async () => (await lines.allInnerTexts()).join(" "), { timeout: 300_000 })
      .toMatch(script.words.heard);
    await expect(
      lines.getByTestId("transcript-speaker").filter({ hasText: script.words.me }).first(),
    ).toBeVisible({ timeout: 120_000 });
  });
  await hand.hold(700);
  await hand.cut(async () => {
    await meetingTab(window, meeting.mindId).click();
    await expect(window.getByTestId("help-strip")).toBeVisible();
  });
  const followButton = helpButton(window, "followUp");
  await expect(followButton).toContainText(script.words.followUp);
  await hand.click(followButton);
  const followUp = assistantAnswers(window).last();
  await hand.cut(() =>
    expect(followUp).toHaveAttribute("data-status", "done", { timeout: 240_000 }),
  );
  // The follow-up's Answer at the panel's own size: the second help answer is the one zoomed.
  await hand.hold(500);

  // The talk drifts away from the guide; its words are read off camera.
  await hand.cut(async () => {
    await speak(take, 3, 5);
    await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 240_000 });
    await window.getByTestId("document-tab").last().click();
    await expect
      .poll(async () => (await window.getByTestId("transcript-line").allInnerTexts()).join(" "), {
        timeout: 300_000,
      })
      .toMatch(script.words.drift);
    await meetingTab(window, meeting.mindId).click();
    await expect(window.getByTestId("help-strip")).toBeVisible();
  });
  // The guide's topics the call hasn't covered, each cited to the guide.
  hand.caption(script.captions.notCovered);
  const notCoveredButton = helpButton(window, "notCovered");
  await expect(notCoveredButton).toContainText(script.words.notCovered);
  await hand.click(notCoveredButton);
  const notCovered = assistantAnswers(window).last();
  await hand.cut(() =>
    expect(notCovered).toHaveAttribute("data-status", "done", { timeout: 240_000 }),
  );
  await expect(notCovered.getByTestId("citation").first()).toBeVisible();
  await hand.hold(200);
  await hand.zoomOn(notCovered, 1.5);
  await hand.hold(500);
  // The first of the guide's topics the call missed: a whole Answer can be taller than a crop.
  const said = notCovered.getByTestId("assistant-answer-text");
  const firstMissing = said.locator("li").first();
  await take.still("meet", (await firstMissing.count()) > 0 ? firstMissing : said, "bottom");
  await hand.zoomOut();

  // What comes next is said off camera, for the notes: what the expert will send, and when.
  await hand.cut(async () => {
    await speak(take, 5, 7);
    // The promise the notes cite: what the expert will send, and when.
    await window.getByTestId("document-tab").last().click();
    await expect
      .poll(async () => (await window.getByTestId("transcript-line").allInnerTexts()).join(" "), {
        timeout: 300_000,
      })
      .toMatch(script.words.friday);
    await meetingTab(window, meeting.mindId).click();
    await expect(window.getByTestId("help-strip")).toBeVisible();
  });

  // Stop: the notes fill in from the transcript.
  await hand.click(bar.getByTestId("meeting-stop"));
  await hand.cut(async () => {
    const fill = window.getByTestId("meeting-fill-line");
    try {
      await expect(fill).toContainText(script.words.filled, { timeout: 300_000 });
    } catch (error) {
      // A model that didn't answer once can answer on the line's own Try again; the take
      // keeps a note that cites the call, never one that says it wasn't written.
      const again = window.getByTestId("meeting-fill-again");
      if ((await again.count()) === 0) throw error;
      await again.click();
      await expect(fill).toContainText(script.words.filled, { timeout: 300_000 });
    }
  });
  hand.caption(script.captions.callNotes);
  await hand.hold(650);
}

/** After Stop: the notes the call filled in, and one citation opening its transcript line. */
async function notes(take: Take): Promise<void> {
  const { window, hand, script } = take;
  const hold = script.language === "zh-CN" ? 800 : 900;
  const editor = window.getByTestId("mind-editor");
  await hand.cut(async () => {
    await expect(window.getByTestId("meeting-fill-line")).toContainText(script.words.filled, {
      timeout: 300_000,
    });
    await window.keyboard.press("Escape");
  });
  await hand.hold(150);
  const citation = editor.getByTestId("citation").last();
  await hand.click(citation);
  await expect(window.getByTestId("citation-card")).toBeVisible();
  await hand.hold(250);
  // With one group on screen the card opens first and its Open brings the Transcript at the line.
  await hand.click(window.getByTestId("citation-open"));
  await expect(window.getByTestId("transcript-line").first()).toBeVisible({ timeout: 60_000 });
  await hand.hold(350);
  const quoted = highlighted(window);
  const line =
    (await quoted.count()) > 0 ? quoted.first() : window.getByTestId("transcript-line").first();
  await hand.hold(300);
  await hand.zoomOn(line, 1.5);
  await hand.hold(hold);
  await hand.zoomOut();
}

/**
 * Scene 4: Check this Note. The badge counts the results as they arrive, the wrong figure's card
 * opens the page it contradicts, the figure is fixed and its mark turns green, then a calculated
 * figure's card shows its formula and the page each input came from.
 */
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
  await hand.cut(async () => {
    const shown = await ask
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) await ask.click();
  });
  await hand.cut(() =>
    expect(window.getByTestId("claim-mark").first()).toBeVisible({ timeout: 180_000 }),
  );
  const counted = film.kept;
  film.speed(2);
  while ((await window.getByTestId("badge-stop").count()) > 0 && film.kept - counted < 1.6) {
    await hand.hold(100);
  }
  film.speed(1);
  await hand.cut(async () => {
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 240_000 });
    await window.keyboard.press("Escape");
  });
  const wrong = window.locator('[data-testid="claim-mark"][data-check="contradicted"]');
  await expect(wrong).toHaveCount(1);
  const sentence = editor.locator("p", { hasText: script.wrong.draft }).first();
  const box = await sentence.boundingBox();
  if (!box) throw new Error("The wrong figure's sentence isn't showing.");
  film.mark("wrong");
  // The mark opens the card that says which page the figure contradicts.
  await hand.click(wrong);
  const card = window.getByTestId("claim-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText(script.words.contradicted);
  await hand.hold(200);
  await take.still(
    "check",
    [
      card.getByTestId("claim-badge"),
      card.getByTestId("claim-quote"),
      card.getByTestId("claim-source"),
    ],
    "bottom",
  );
  // The page itself, beside the memo, with the contradicted sentence's words lit on it.
  await hand.click(card.getByTestId("claim-open"));
  await expect(highlighted(window)).toBeVisible({ timeout: 60_000 });
  await hand.hold(800);

  // Back to the memo, to make the correction as a person does.
  await hand.cut(async () => {
    await window.keyboard.press("ControlOrMeta+w");
    await openMind(window, script.paper.title);
    await editor.locator("p", { hasText: script.wrong.draft }).first().scrollIntoViewIfNeeded();
  });
  const figure = await figureAt(window, script.wrong.draft);
  hand.caption(script.captions.fixed);
  await hand.doubleClickAt(figure.x, figure.y);
  await hand.hold(150);
  await hand.type(script.wrong.document, 80);
  await hand.hold(200);
  // The whole Note checked again, off camera: the corrected sentence's mark turns green. The
  // estimate is asked once; after a fix the run can start without it.
  await hand.cut(async () => {
    await command(window, hand, script.words.typed.check, script.words.checkCommand);
    const againAsk = window.getByTestId("mind-check-check");
    const shown = await againAsk
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) await againAsk.click();
    await expect(window.getByTestId("badge-stop")).toHaveCount(0, { timeout: 240_000 });
    await expect(window.getByTestId("claim-mark").first()).toBeVisible();
    await window.keyboard.press("Escape");
  });
  await expect(wrong).toHaveCount(0);
  await expect(
    window.locator('[data-testid="claim-mark"][data-check="needs-recheck"]'),
  ).toHaveCount(0);
  await expect(window.locator('[data-testid="claim-mark"][data-check="checking"]')).toHaveCount(0);
  await hand.hold(900);
  film.mark("fixed");

  // The check can also flag what the draft wrote itself: a sentence no Document supports, or a
  // Citation the page does not hold. It is the analyst's call, settled on camera by the mark's own
  // card: Keep as my view for a sentence, Remove for a Citation the page does not hold.
  const badgeState = window.getByTestId("check-badge");
  const settle = async (): Promise<boolean> => {
    for (const state of ["unsupported", "contradicted"] as const) {
      const mark = window.locator(`[data-testid="claim-mark"][data-check="${state}"]`).first();
      if ((await mark.count()) === 0) continue;
      await hand.click(mark);
      const keep = window.getByTestId("claim-keep");
      if (!(await keep.isVisible().catch(() => false))) continue;
      await hand.click(keep);
      return true;
    }
    const citation = window.locator('[data-testid="citation"][data-check="not-found"]').first();
    if ((await citation.count()) > 0) {
      await hand.click(citation);
      const remove = window.getByTestId("citation-remove");
      if (!(await remove.isVisible().catch(() => false))) return false;
      await hand.click(remove);
      return true;
    }
    return false;
  };
  for (let round = 0; round < 2; round++) {
    if ((await badgeState.getAttribute("data-state")) !== "needs-look") break;
    if (!(await settle())) break;
    await hand.cut(() =>
      expect
        .poll(async () => badgeState.getAttribute("data-state"), { timeout: 30_000 })
        .not.toBe("needs-look")
        .catch(() => undefined),
    );
  }
  if ((await badgeState.getAttribute("data-state")) === "needs-look") {
    throw new Error("The check still has something to look at after its card's actions.");
  }

  // The calculated figure: the card shows its formula and the page each input came from.
  hand.caption(script.captions.working);
  const derived = script.paper.blocks[6]?.text.slice(0, 12) ?? "";
  // The card itself, found in the sentence's own line: a paragraph's marks can include the line
  // below, so each candidate is opened off camera until the one with the working shows.
  await hand.cut(async () => {
    const paragraph = editor.locator("p", { hasText: derived }).first();
    await paragraph.scrollIntoViewIfNeeded();
    const box = await paragraph.boundingBox();
    if (!box) throw new Error("The calculated figure's sentence isn't showing.");
    const card = window.getByTestId("claim-card");
    const marks = window.getByTestId("claim-mark");
    for (let index = 0; index < (await marks.count()); index++) {
      const mark = marks.nth(index);
      const at = await mark.boundingBox();
      if (
        !at ||
        at.y + at.height / 2 < box.y - 4 ||
        at.y + at.height / 2 > box.y + box.height + 4
      ) {
        continue;
      }
      await mark.click();
      if (
        await card
          .getByTestId("claim-working")
          .isVisible()
          .catch(() => false)
      )
        return;
      await window.keyboard.press("Escape");
    }
    throw new Error("The calculated figure's card is not beside its sentence.");
  });
  const working = window.getByTestId("claim-card");
  await expect(working.getByTestId("claim-working")).toBeVisible();
  await hand.hold(200);
  await hand.zoomOn(working, 1.5);
  await hand.hold(800);
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
  const hold = script.language === "zh-CN" ? 1650 : 1750;
  await hand.cut(async () => {
    await clearAside(window);
    await openMind(window, script.paper.title);
  }, PARK);
  await hand.hold(200);
  await hand.click(window.getByTestId("export-mind"));
  const menu = window.getByTestId("export-menu");
  await expect(menu).toBeVisible();
  if ((await menu.getByTestId("export-as-docx").count()) === 0) {
    await hand.click(menu.getByTestId("export-more"));
  }
  await hand.hold(200);
  // The moment: the export the card's sentence names, in the menu that offers it.
  await take.still("export", window.getByTestId("export-as-docx"));
  await hand.click(window.getByTestId("export-as-docx"));
  const done = window.getByTestId("export-result").getByTestId("export-done");
  await expect(done).toContainText(script.words.saved, { timeout: 60_000 });
  await hand.hold(300);

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
  await hand.hold(100);
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
  // The footnote itself, in view under the file's last line.
  await hand.hold(hold);
}

/** The end card's words, from the README's own, and the app's icon. */
export async function endCardContent(
  script: DemoScript,
): Promise<{ icon: string; lines: string[] }> {
  // The card's first line is the README's own tagline, as the owner wrote it there: the one
  // <b> line that stands alone, not the language switch at the top, which is a link's neighbour.
  const readme = await readFile(join(repository, script.readme), "utf8");
  const headline = readme.match(/<p align="center"><b>([^<]+)<\/b><\/p>/)?.[1];
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
  await hand.hold(2350);
}

/** What each scene runs: a name in ./sceneTable without a run here is a scene the take cannot film. */
const RUN: Readonly<Record<string, (take: Take) => Promise<void>>> = {
  hook,
  organize,
  ask,
  "add to note": addToNote,
  analyse,
  check,
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
