/**
 * Records one take of the README film's meeting part (#1812): a call recorded and transcribed on
 * this computer, and its notes prepared by the User's own agent, with no AI model set up in the
 * app. The User records a meeting beside their notes for the call, watches the transcript come in
 * its sheet, stops, and presses Write notes above the meeting's control. Claude Code gets the one
 * line the app wrote for it, reads the request and the transcript, and proposes the notes, each
 * point quoting the call; the User accepts them and opens a quote.
 *
 * The call is a test recording in synthetic voices (`call.ts`), heard by the app's own speech
 * models: no real person's voice is used. The frames, the stream and the marks are kept as
 * `agentFilm.demo.ts` keeps them, and every take is kept for the tally. The speech and search
 * models come from `INCARNAMIND_MODEL_CACHE`. Build the test app first, then:
 *
 *   ANTHROPIC_API_KEY=… DEMO_OUT=<folder> DEMO_LANGUAGE=en npx playwright test \
 *     -c e2e/demo/playwright.demo.config.ts meetingFilm
 *
 * `DEMO_REHEARSE=1` stops once the line for Claude Code is written: no agent runs, and a
 * rehearsal is never a take.
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { AgentLaunch, CoreBridge } from "../../src/core/api";
import { HELP_SHORTCUTS } from "../../src/shared/meetingHelp";
import { createDataFolder, launchApp, removeDataFolder, setLanguage, urlsOpened } from "../app";
import { writeNorthwindPapers } from "./agentDocuments";
import { atSurface, type Box, claudeCode, film, pointer, SURFACE, sleep } from "./agentTake";
import { connectCall, learnLines, sayLine, speech } from "./call";
import { openMind } from "./steps";
import { seedModels } from "./workspace";

const language = (process.env.DEMO_LANGUAGE ?? "en") as "en" | "zh-CN";
const OUT = process.env.DEMO_OUT ?? "";
const WRITER = process.env.DEMO_WRITER ?? "claude-haiku-5-5";
const REHEARSAL = process.env.DEMO_REHEARSE === "1";

interface Line {
  side: "me" | "them";
  text: string;
}

const WORDS = {
  en: {
    folder: "Northwind Retail",
    prep: "Questions for Northwind",
    questions: [
      "Where did leverage close the half?",
      "Room under the limit at year end",
      "When does the compliance certificate come?",
    ],
    voices: { them: "Daniel", me: "Samantha" },
    call: [
      {
        side: "them",
        text: "Thanks for making the time. Leverage closed the half at two point seven times, well inside the limit of three and a half.",
      },
      {
        side: "me",
        text: "The limit steps down to three and a quarter at the end of the year. How much room does that leave you?",
      },
      {
        side: "them",
        text: "On our forecast we finish the year at two point nine times. We will send you the compliance certificate by the fifteenth of January.",
      },
      {
        side: "me",
        text: "Good. I will take the renewal to the credit committee on Monday, and I need your updated forecast before then.",
      },
      { side: "them", text: "You will have the updated forecast by Friday." },
    ] as Line[],
  },
  "zh-CN": {
    folder: "Northwind Retail",
    prep: "Northwind 电话提纲",
    questions: ["上半年末的杠杆率是多少？", "年底上限下调后还有多少余量", "合规证明什么时候发来？"],
    voices: { them: "Tingting", me: "Meijia" },
    call: [
      {
        side: "them",
        text: "谢谢你抽出时间。六月底，我们的杠杆率是二点七倍，低于三点五倍的上限。",
      },
      { side: "me", text: "到今年年底，上限会降到三点二五倍。这样你们还有多少余量？" },
      {
        side: "them",
        text: "年底，我们的杠杆率预计是二点九倍。合规证明我们会在一月十五日之前发给你。",
      },
      {
        side: "me",
        text: "好的。我周一把续贷方案提交信贷委员会，在那之前我需要你们更新后的预测。",
      },
      { side: "them", text: "更新后的预测，周五之前发给你。" },
    ] as Line[],
  },
} as const;

test.describe.configure({ mode: "serial" });

test(`records a take of the film's meeting part in ${language}`, async () => {
  test.setTimeout(60 * 60_000);
  if (!OUT) throw new Error("Set DEMO_OUT to the folder the take goes in.");
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key && !REHEARSAL) throw new Error("Set ANTHROPIC_API_KEY.");
  const words = WORDS[language];
  await mkdir(join(OUT, "shots"), { recursive: true });
  const dataDir = await createDataFolder();
  const home = await createDataFolder();
  const papers = await createDataFolder();
  const started = Date.now();
  const marks: Record<string, number> = {};
  const mark = (name: string) => {
    marks[name] = (Date.now() - started) / 1000;
  };
  const rects: Record<string, Box> = {};
  const take: Record<string, unknown> = {
    language,
    part: "meeting",
    writer: REHEARSAL ? "rehearsal" : WRITER,
    surface: SURFACE,
    started,
    outcome: "unfinished",
  };
  await seedModels(dataDir);
  const { app, window } = await launchApp(dataDir, {
    real: ["embedder", "transcriber"],
    sandboxed: true,
    home,
  });
  const shot = (name: string) =>
    window.screenshot({ path: join(OUT, "shots", `${name}.png`) }).catch(() => undefined);
  let stopFilm: (() => Promise<void>) | undefined;
  try {
    await atSurface(app, window);
    if (language !== "en") await setLanguage(window, language);

    const credit = await writeNorthwindPapers(papers, language);
    const { folderId, launch } = await window.evaluate(
      async ({ name, paths, prep, keys }) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        // As a User who has recorded before has it: a recording made on this device, transcription
        // on this computer. The call help is the built-in assistant's and holds system-wide
        // shortcuts while a Meeting records: off, so the recording takes no key from this computer.
        await core.updateSettings({
          device: {
            meetingNoticeAccepted: true,
            transcriptionRoute: "local",
            meetingPanel: false,
            meetingHelpKeys: Object.fromEntries(keys.map((each) => [each, ""])),
          },
        });
        const folder = await core.createLibraryGroup({ name, description: "" });
        await core.addDocuments(paths, { groupId: folder.id });
        await core.createMind({ title: prep, headed: true, folderId: folder.id });
        await core.setAgentsEnabled(true);
        const connected = await core.connectAgent({
          name: "Claude Code",
          client: "claude-code",
          folderIds: [folder.id],
          propose: true,
        });
        return { folderId: folder.id, launch: connected.launch as AgentLaunch };
      },
      { name: words.folder, paths: credit, prep: words.prep, keys: [...HELP_SHORTCUTS] },
    );
    take.folderId = folderId;
    await expect
      .poll(
        () =>
          window.evaluate(async (expected) => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const documents = await core.listDocuments();
            return documents.length === expected && documents.every((d) => d.status === "ready");
          }, credit.length),
        { timeout: 900_000, intervals: [1000] },
      )
      .toBe(true);
    const mcpFile = join(home, "mcp.json");
    await writeFile(mcpFile, JSON.stringify({ mcpServers: { incarnamind: launch } }), {
      mode: 0o600,
    });
    const written = claudeCode({ home, mcpFile, key: key ?? "", model: WRITER, out: OUT });

    const voices = join(papers, "voices");
    const spoken: number[][] = [];
    for (const [index, line] of words.call.entries()) {
      spoken.push(await speech(voices, `line-${index}`, words.voices[line.side], line.text));
    }
    take.call = words.call;
    await connectCall(app);
    await learnLines(app, spoken);

    await expect
      .poll(async () => ((await window.getByTestId("sidebar-status").textContent()) ?? "").trim(), {
        timeout: 1_200_000,
        intervals: [2000],
      })
      .toBe("");
    // The window as the film has it: the User's notes for the call open, the assistant put away.
    await openMind(window, words.prep);
    const editor = window.getByTestId("mind-editor");
    await expect(editor).toContainText(words.prep);
    // The app places the caret itself a moment after the Note opens; typed before that, the
    // questions land in front of the title. A take never starts on a Note that came out wrong.
    await sleep(1500);
    await editor.click();
    await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    for (const question of words.questions) {
      await window.keyboard.press("Enter");
      await window.keyboard.type(question);
    }
    await expect(editor.locator("h1")).toHaveText([words.prep]);
    await expect(editor.locator(":scope > p").filter({ hasText: /\S/ })).toHaveText(
      words.questions,
    );
    const assistant = window.getByTestId("assistant");
    if ((await assistant.count()) > 0 && (await assistant.getAttribute("data-folded")) !== "true")
      await window
        .getByTestId("assistant-fold")
        .click()
        .catch(() => undefined);
    await sleep(600);
    const { glide, boxOf, click, leave } = await pointer(window, rects);

    stopFilm = await film(window, join(OUT, "app"));
    const finish = async (outcome: string) => {
      take.outcome = outcome;
      mark("end");
    };
    await sleep(1500);
    await shot("01-prep");

    mark("plus");
    await click(window.getByTestId("plus-menu"), "plus");
    const record = window.getByTestId("plus-record-meeting");
    await expect(record).toBeVisible();
    await sleep(500);
    await shot("02-menu");
    await click(record, "record");
    mark("record");
    const control = window.getByTestId("meeting-foot");
    await expect(control).toHaveAttribute("data-status", "recording", { timeout: 60_000 });
    mark("recording");
    await boxOf(control, "control");
    await sleep(900);
    await shot("03-recording");

    // The call, in real time; the User turns to the transcript once the first line is said.
    const talk = (async () => {
      for (const [index, line] of words.call.entries()) {
        mark(`say-${index}`);
        await sayLine(app, line.side === "me" ? "microphone" : "system", index);
        await sleep(700);
      }
      mark("said");
    })();
    await sleep(2500);
    mark("to-transcript");
    await click(control.getByTestId("meeting-foot-transcript"), "view-transcript");
    const sheet = window.getByTestId("meeting-sheet");
    await expect(sheet).toBeVisible();
    mark("transcript");
    await leave();
    await talk;
    const lines = sheet.getByTestId("transcript-line");
    await expect
      .poll(() => lines.count(), { timeout: 120_000 })
      .toBeGreaterThan(0)
      .catch(() => undefined);
    await sleep(3000);
    take.heardLive = await lines.allInnerTexts().catch(() => []);
    await shot("04-transcript");
    if ((await lines.count()) === 0) {
      await finish("no transcript line");
      return;
    }

    // Back to the notes, and Stop: Write notes comes above the control.
    mark("to-notes");
    await click(sheet.getByTestId("meeting-sheet-hide"), "view-notes");
    await expect(sheet).toBeHidden();
    mark("notes");
    await sleep(900);
    mark("to-stop");
    await click(control.getByTestId("meeting-foot-stop"), "stop");
    mark("stop");
    await leave();
    const ready = window.getByTestId("meeting-write-notes");
    const offered = await ready
      .waitFor({ timeout: 300_000 })
      .then(() => true)
      .catch(() => false);
    await shot("05-stopped");
    take.meeting = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [meeting] = await core.listMeetings();
      return meeting
        ? { status: meeting.status, fill: meeting.fill, transcript: meeting.transcript }
        : null;
    });
    if (!offered) {
      take.afterStop = (await window.locator("body").textContent())?.slice(0, 3000);
      await finish("hand-over not offered");
      return;
    }
    mark("ready");
    await boxOf(ready, "ready");
    take.readyLine = await ready.textContent();
    await sleep(1800);

    mark("ask");
    await click(ready, "ask");
    mark("asked");
    await expect
      .poll(async () => (await urlsOpened(app)).some((url) => url.startsWith("claude-cli://")))
      .toBe(true);
    const link = (await urlsOpened(app)).find((url) => url.startsWith("claude-cli://")) ?? "";
    const line = new URL(link).searchParams.get("q") ?? "";
    take.line = line;
    if (!line) throw new Error("The link to Claude Code carried no line.");
    await sleep(1200);
    await leave();
    await shot("06-asked");
    if (REHEARSAL) {
      await finish("rehearsal");
      return;
    }

    mark("turn-1");
    const turn = await written(line, "turn-1");
    mark("turn-1-end");
    take.turn1 = turn;
    await sleep(2500);
    await shot("07-proposed");
    take.noteProposed = (await editor.textContent())?.slice(0, 4000);
    const accept = window.getByTestId("proposals-accept-all");
    if (!(await accept.isVisible().catch(() => false))) {
      take.afterTurn = (await window.locator("body").textContent())?.slice(0, 4000);
      await finish("no proposal to accept");
      return;
    }
    await boxOf(window.getByTestId("proposals-bar"), "proposals");
    take.proposals = await window.getByTestId("proposals-bar").textContent();
    await sleep(1500);
    mark("accept");
    await click(accept, "accept");
    mark("accepted");
    await expect(accept).toBeHidden({ timeout: 30_000 });
    await leave();
    await sleep(2500);
    await shot("08-notes");
    take.note = (await editor.textContent())?.slice(0, 4000);

    const quotes = editor.getByTestId("citation");
    if ((await quotes.count()) === 0) {
      await finish("notes accepted, no quote");
      return;
    }
    // A quote with room under it for its card: one at the page's top opens its card over the tabs.
    let quote = quotes.first();
    for (const each of await quotes.all()) {
      const box = await each.boundingBox();
      if (box && box.y > 300 && box.y < 620) {
        quote = each;
        break;
      }
    }
    mark("quote");
    await click(quote, "quote");
    const card = window.getByTestId("citation-card");
    await expect(card).toBeVisible();
    await boxOf(card, "quote-card");
    take.quoteCard = (await card.textContent())?.slice(0, 800);
    mark("quote-card");
    await glide(SURFACE.width - 70, 560);
    await sleep(3000);
    await shot("09-quote");
    await finish("notes accepted, quote opened");
  } finally {
    if (marks.end === undefined) mark("end");
    await stopFilm?.().catch(() => undefined);
    take.marks = marks;
    take.rects = rects;
    await writeFile(join(OUT, "take.json"), JSON.stringify(take, null, 2));
    await app.close().catch(() => undefined);
    await cp(join(dataDir, "logs", "incarnamind.log"), join(OUT, "app.log")).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(papers, { recursive: true, force: true });
    await removeDataFolder(dataDir);
  }
});
