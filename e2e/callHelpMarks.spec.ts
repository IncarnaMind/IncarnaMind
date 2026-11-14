import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  expectQuoteLines,
  firstTranscriptLine,
  launchApp,
  panelOf,
  panelOpen,
  pointAndClick,
  pressHelp,
  pressHelpPrompt,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setMeetingKeys,
  setWindowSize,
  startRecording,
  useLocalChatModel,
} from "./app";

/**
 * In call help, under each line that carries a Citation's number, the app draws that Citation's
 * quote word for word, with a ✓ only where it found the quote in its place (#2847); the model's
 * own line keeps plain numbers. On the scripted chat model, in English and Chinese: an option, a
 * reading's moment and a short line, the panel shown again, a number written before its quote
 * came, and an option the model wrapped in quotation marks. Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

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

const CALLS = [
  {
    language: "English",
    interface: "en" as const,
    buyer: [
      "Can you do thirty-five dollars a seat for Enterprise?",
      "How much is the Enterprise plan per seat, and does it include single sign-on?",
    ],
    sheet:
      "Price sheet 2026\n\nTeam plan: $25 per seat a month.\nEnterprise plan: $45 per seat a month, single sign-on included.\n",
    // The option cites the line that shares the most words with their newest one.
    cited: "Enterprise plan: $45 per seat a month, single sign-on included.",
    answer: "Answer their question",
    want: "What do they want?",
    check: "Check what was said",
    showPanel: "Show the call help panel",
  },
  {
    language: "Chinese",
    interface: "zh-CN" as const,
    buyer: ["企业版能不能每个席位 35 美元？", "企业版每个席位多少钱，含不含单点登录？"],
    sheet: "企业版：每个席位每月 45 美元，含单点登录。\n团队版：每个席位每月 25 美元。\n",
    // A Chinese line shares no word the scripted model counts, so the option cites the first.
    cited: "企业版：每个席位每月 45 美元，含单点登录。",
    answer: "回答对方的问题",
    want: "对方想要什么？",
    check: "核对刚才说的话",
    showPanel: "显示通话助手浮窗",
  },
];

/** A call with the price sheet added and the panel shown, on the scripted model named. */
async function callWithSheet(call: (typeof CALLS)[number], model?: string) {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { theirLines: call.buyer },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setLanguage(window, call.interface);
  await setMeetingKeys(window);
  // biome-ignore lint/correctness/useHookAtTopLevel: an e2e helper whose name begins with "use", not a React hook.
  await useLocalChatModel(window, model);
  // Documents wait while a meeting records: the price sheet is added first.
  const sheet = join(sources, "Price sheet.txt");
  await writeFile(sheet, call.sheet);
  const bridge = await window.evaluateHandle(
    () => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind,
  );
  await bridge.evaluate((core, path) => core.addDocuments([path]), sheet);
  await expect
    .poll(() =>
      bridge.evaluate(async (core) =>
        (await core.listDocuments()).map((document) => document.status),
      ),
    )
    .toEqual(["ready"]);
  await startRecording(window, await recordMeeting(window), { notice: true });
  await firstTranscriptLine(window);
  return { app, window, panel: await panelOf(app) };
}

interface SlowCheck {
  holdCite: boolean;
  holdAsked: boolean;
  waiting: unknown[];
  release(): void;
}

/**
 * Holds the scripted model's cite calls, or its one request for a reply's Citations, until set
 * false, which lets every held one go.
 */
async function holdModel(
  app: ElectronApplication,
  which: "holdCite" | "holdAsked",
  hold: boolean,
): Promise<void> {
  await app.evaluate(
    (_electron, { which, hold }) => {
      const slow = (globalThis as unknown as { incarnamindSlowCheck: SlowCheck })
        .incarnamindSlowCheck;
      slow[which] = hold;
      if (!hold) slow.release();
    },
    { which, hold },
  );
}

/** Whether a request of the scripted model is held now. */
const held = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as unknown as { incarnamindSlowCheck: SlowCheck }).incarnamindSlowCheck.waiting
        .length > 0,
  );

/** The panel closed, then shown again from ⌘K: it draws its reply from what is stored. */
async function shownAgain(
  app: ElectronApplication,
  window: Page,
  panel: Page,
  call: (typeof CALLS)[number],
): Promise<Page> {
  const close = panel.getByTestId("panel-close");
  await close.hover();
  // The window goes as the click lands, which a click Playwright waits on would call a failure.
  await close.evaluate((button) => setTimeout(() => (button as HTMLElement).click(), 0));
  await expect.poll(() => panelOpen(app)).toBe(false);
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type(call.showPanel);
  await window.keyboard.press("Enter");
  return panelOf(app);
}

const topOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Not drawn.");
  return box;
};

for (const call of CALLS) {
  // protects=under each line of call help, each Citation's quote shows word for word with ✓ where the app found it, the model's line keeps plain numbers, a reading's moment takes ✓ beside its own words, and the panel shown again draws the same from what is stored, in English and Chinese (#2847); fails_when=a ✓ shows in a line the model wrote or beside words no Citation found, or the panel shown again draws other lines; no_claim=what a real model writes.
  test(`call help in ${call.language}: each Citation's quote under its line, a ✓ only beside words the app found`, async () => {
    const { app, window, panel } = await callWithSheet(call);

    const answer = await pressHelp(panel, call.answer);
    const answered = await expectQuoteLines(window, answer);
    expect(answered[0]).toEqual({
      state: "found",
      words: `“${call.cited}”`,
      numbers: ["1"],
      found: true,
    });
    await expect(answer.getByTestId("help-citation").first()).toHaveAttribute(
      "data-check",
      "found",
    );
    await shot(panel, `call-help-quotes-answer-${call.interface}`);

    // A reading's moment keeps its words and takes ✓ beside them, at the time its source row shows.
    const want = await pressHelp(panel, call.want);
    const [moment] = await expectQuoteLines(window, want);
    expect(moment).toMatchObject({ state: "found", numbers: ["1"], found: true });
    const time = /^\d{1,2}:\d{2}/.exec(moment?.words ?? "")?.[0];
    expect(time).toBeDefined();
    await expect(want.getByTestId("help-source").first()).toContainText(time ?? "");
    await shot(panel, `call-help-quotes-want-${call.interface}`);

    const lines = await pressHelp(panel, call.check);
    expect((await expectQuoteLines(window, lines))[0]).toMatchObject({
      state: "found",
      numbers: ["1"],
      found: true,
    });
    await shot(panel, `call-help-quotes-check-${call.interface}`);

    // The panel closed and shown again draws the last reply from what is stored, the same.
    const drawn = await expectQuoteLines(window, lines);
    const shown = await shownAgain(app, window, panel, call);
    const latest = shown.getByTestId("help-suggestion").last();
    await expect(latest.getByTestId("help-heading")).toContainText(call.check);
    expect(await expectQuoteLines(window, latest)).toEqual(drawn);
    await shot(shown, `call-help-quotes-reopened-${call.interface}`);

    await app.close();
  });

  // protects=a number written before its quote comes keeps a room under its option, and when its quote lands wholly inside the other's, of the same place, its number joins that line and its spare room closes: the option's line and everything above keep their place, in English and Chinese (#2847); fails_when=no room shows while the quote is on its way, the joined number keeps a line of its own, or the heading, the option's line or its first quote line moves; no_claim=pixels, which the stills show.
  test(`call help in ${call.language}: a number written before its quote keeps its room, and a quote inside another joins its line`, async () => {
    const { app, window, panel } = await callWithSheet(call, "fake-model-writes-before-it-cites");

    await holdModel(app, "holdCite", true);
    await pressHelpPrompt(panel, call.answer);
    const reply = panel.getByTestId("help-suggestion").last();
    const option = reply.getByTestId("help-option").first();
    const rows = option.getByTestId("help-quote");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-state", "waiting");
    await expect(rows.nth(1)).toHaveAttribute("data-state", "waiting");
    await expect(rows.nth(0).getByTestId("help-quote-number")).toHaveText(["1"]);
    await expect(rows.nth(1).getByTestId("help-quote-number")).toHaveText(["2"]);
    const say = option.getByTestId("help-option-say");
    const heading = reply.getByTestId("help-heading");
    const before = {
      heading: await topOf(heading),
      say: await topOf(say),
      first: await topOf(rows.nth(0)),
    };
    await shot(panel, `call-help-quotes-room-${call.interface}`);

    await holdModel(app, "holdCite", false);
    await expect(reply).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId("help-quote-number")).toHaveText(["1", "2"]);
    await expect(rows.first()).toHaveAttribute("data-state", "found");
    const after = {
      heading: await topOf(heading),
      say: await topOf(say),
      first: await topOf(rows.first()),
    };
    expect(Math.abs(after.heading.y - before.heading.y)).toBeLessThan(0.5);
    expect(Math.abs(after.say.y - before.say.y)).toBeLessThan(0.5);
    // The first quote line still starts right under the option's line.
    expect(
      Math.abs(
        after.first.y -
          (after.say.y + after.say.height) -
          (before.first.y - (before.say.y + before.say.height)),
      ),
    ).toBeLessThan(0.5);
    expect((await expectQuoteLines(window, reply))[0]).toMatchObject({
      words: `“${call.cited}”`,
      numbers: ["1", "2"],
      found: true,
    });
    await shot(panel, `call-help-quotes-joined-${call.interface}`);
    await app.close();
  });

  // protects=the third movement allowed while a reply is written: options that came with no number stand whole while the app's one request for their Citations is out, a later line on screen, and then the numbers, their quote lines and the reply's end land in one write, so the heading and the line that gains them keep their place, the later line moves only down, and the panel shown again draws the reply as it ended, in English and Chinese (#2847); fails_when=a number shows while the reply is still written or without its quote line, the heading or that line moves, the later line moves up, or the panel shown again draws otherwise; no_claim=how often a model leaves its Citations out, which the description counts.
  test(`call help in ${call.language}: Citations the app asks for once more land with the reply's end, the line and all above in place`, async () => {
    const { app, window, panel } = await callWithSheet(call, "fake-model-cites-when-asked");

    await holdModel(app, "holdAsked", true);
    await pressHelpPrompt(panel, call.answer);
    const reply = panel.getByTestId("help-suggestion").last();
    const options = reply.getByTestId("help-option");
    await expect.poll(() => held(app), { timeout: 20_000 }).toBe(true);
    await expect(options).toHaveCount(2);
    await expect(reply).toHaveAttribute("data-status", "streaming");
    await expect(reply.getByTestId("help-citation")).toHaveCount(0);
    await expect(reply.getByTestId("help-quote")).toHaveCount(0);
    const heading = reply.getByTestId("help-heading");
    const first = options.nth(0).getByTestId("help-option-say");
    const later = options.nth(1).getByTestId("help-option-say");
    const before = {
      heading: await topOf(heading),
      first: await topOf(first),
      later: await topOf(later),
    };
    await shot(panel, `call-help-quotes-asked-${call.interface}`);

    // Every change drawn from here on, as it lands: the numbers and quote lines, and the state.
    await reply.evaluate((suggestion) => {
      const landed: { numbers: number; quotes: number; status: string | null }[] = [];
      (globalThis as unknown as { landed: typeof landed }).landed = landed;
      new MutationObserver(() =>
        landed.push({
          numbers: suggestion.querySelectorAll('[data-testid="help-citation"]').length,
          quotes: suggestion.querySelectorAll('[data-testid="help-quote"]').length,
          status: suggestion.getAttribute("data-status"),
        }),
      ).observe(suggestion, { subtree: true, childList: true, attributes: true });
    });
    await holdModel(app, "holdAsked", false);
    await expect(reply).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    const landed = await panel.evaluate(
      () =>
        (globalThis as unknown as { landed: { numbers: number; quotes: number; status: string }[] })
          .landed,
    );
    const numbered = landed.filter((each) => each.numbers > 0);
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered.every((each) => each.status === "done" && each.quotes > 0)).toBe(true);
    const drawn = await expectQuoteLines(window, reply);
    expect(drawn).toEqual([
      { state: "found", words: `“${call.cited}”`, numbers: ["1"], found: true },
    ]);
    await expect(options.nth(0).getByTestId("help-quote")).toHaveCount(1);
    await expect(options.nth(1).getByTestId("help-quote")).toHaveCount(0);
    const after = {
      heading: await topOf(heading),
      first: await topOf(first),
      later: await topOf(later),
    };
    expect(Math.abs(after.heading.y - before.heading.y)).toBeLessThan(0.5);
    expect(Math.abs(after.first.y - before.first.y)).toBeLessThan(0.5);
    expect(after.later.y).toBeGreaterThan(before.later.y);
    await shot(panel, `call-help-quotes-asked-landed-${call.interface}`);

    const shown = await shownAgain(app, window, panel, call);
    expect(await expectQuoteLines(window, shown.getByTestId("help-suggestion").last())).toEqual(
      drawn,
    );
    await app.close();
  });
}

// protects=an option the model wrapped in its own quotation marks shows in the panel in one pair of the panel's own with its quote line's ✓, and the assistant shows the reply without the model's marks (#2925, #2847); fails_when=the panel shows two pairs, the quote line misses its ✓, or the assistant shows the model's marks; no_claim=how often a model wraps an option.
test("call help: an option the model wrapped in quotation marks shows in one pair, its quote line with ✓, and the assistant shows it without the model's marks", async () => {
  const [call] = CALLS;
  if (!call) throw new Error("No call.");
  const { app, window, panel } = await callWithSheet(call, "fake-model-options-quoted");

  const answer = await pressHelp(panel, call.answer);
  await expect(answer.getByTestId("help-option-say").first()).toHaveText(
    /^“Yes: Enterprise plan: \$45 per seat a month, single sign-on included”\s*1$/,
  );
  expect((await expectQuoteLines(window, answer))[0]).toMatchObject({
    words: `“${call.cited}”`,
    found: true,
  });
  await shot(panel, "call-help-quoted-option-panel-en");

  // The panel closed, the buttons sit at the top of the assistant, which shows the help asked there.
  const close = panel.getByTestId("panel-close");
  await close.hover();
  // The window goes as the click lands, which a click Playwright waits on would call a failure.
  await close.evaluate((button) => setTimeout(() => (button as HTMLElement).click(), 0));
  await expect.poll(() => panelOpen(app)).toBe(false);
  await pointAndClick(
    window,
    window.getByTestId("help-strip").getByTestId("help-button").filter({ hasText: call.answer }),
  );
  const reply = window.getByTestId("assistant-answer").last();
  await expect(reply).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(reply).toContainText("Yes: Enterprise plan: $45 per seat a month");
  await expect(reply).not.toContainText('"');
  await expect(reply.getByTestId("citation-chip").first()).toHaveAttribute("data-check", "found", {
    timeout: 20_000,
  });
  await shot(window, "call-help-quoted-option-assistant-en");
  await app.close();
});
