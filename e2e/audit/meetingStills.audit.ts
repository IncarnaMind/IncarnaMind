/**
 * Full-window stills of a recorded meeting, from the way in to the notes after (#3762), with what
 * each still measures beside it. A drawing, not a test: it records a call with the fake microphone
 * and the fake transcriber speaking a harbour meeting, asks the stand-in for the User's Claude Code,
 * stops, has it write the notes and check them. Build the test app first, then:
 *
 *   STILLS_OUT=<folder> STILLS_LANG=en npx playwright test \
 *     -c e2e/audit/playwright.audit.config.ts meetingStills
 */
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "../app";

const OUT = process.env.STILLS_OUT ?? "";
const LANG = (process.env.STILLS_LANG ?? "en") as "en" | "zh-CN";
const HEIGHT = 900;
/** Every state at three widths; with the conversation in its column only where the column fits. */
const WIDTHS = [1440, 1280, 900] as const;
const COLUMN_WIDTHS = [1440, 1280] as const;

const WORDS = {
  en: {
    folder: "Kestrel Bay",
    title: "Harbour board: second ramp",
    longTitle:
      "Harbour board call with the contractor and the harbour master about the second ramp, the dredging and the winter timetable",
    typed: ["Ramp works: dates and cost", "Early ferry during the works"],
    question: "When do the ramp works start?",
    check: "Check",
    mine: [
      "Can everyone hear me?",
      "Thanks for joining.",
      "Let's start with the second ramp at Kestrel Bay.",
      "When do the works start?",
      "Is that the contractor's date?",
      "What does the dredging add?",
      "And the figure in the tender?",
      "Please send it round after the call.",
      "Can the early ferry keep running?",
      "Who confirms the tide tables?",
      "I'll write to the commuters about the new time.",
      "Thursday after next is fine.",
      "What about the café on the quay?",
      "Will the contractor work at weekends?",
      "Can the slipway stay open on Saturdays?",
      "Who tells the ferry passengers?",
      "I'll draft the notice for the website.",
      "Should we put a sign on the quay as well?",
      "What if the tides run late?",
      "Then we keep a week in hand.",
      "Let's put that in the minutes.",
      "One more thing on parking.",
      "How many spaces do we lose?",
      "Can the council lend us its car park?",
      "I'll ask them tomorrow.",
      "Anything else before we close?",
      "Thanks, everyone.",
      "Speak on Thursday after next.",
      "I'll send the notes round today.",
      "Bye for now.",
      "One last check on the date.",
      "Yes, the third of March.",
      "Good.",
      "Thanks again.",
      "Talk soon.",
      "Bye.",
    ],
    theirs: [
      "Yes, we can hear you.",
      "The contractor is with us today.",
      "The ramp works start on the third of March and close the slipway for six weeks.",
      "We checked the tide tables last week.",
      "The contractor wants an early start.",
      "The dredging adds about two hundred thousand pounds, so the budget is one point four million.",
      "That was the figure in the tender.",
      "We can send the tender after the call.",
      "The 07:40 crossing moves to 07:55 while the works last.",
      "The harbour master confirms the tide tables by Friday.",
      "The café owner asked for two weeks' notice.",
      "Thursday after next works for us.",
      "Weekend work costs more.",
      "Saturdays should be fine for the first month.",
      "The ferry company will put it on the timetable.",
      "Please send us the draft.",
      "A sign on the quay would help.",
      "The harbour master builds in a week for the tides.",
      "That should cover it.",
      "We'll check the minutes.",
      "We lose twenty spaces.",
      "The council car park is free after six.",
      "That would help the early commuters.",
      "We'll wait to hear.",
      "Nothing more from us.",
      "Thanks, bye for now.",
      "We'll look out for the notes.",
      "The third of March, yes.",
      "Agreed.",
      "Thank you.",
      "Talk soon.",
      "Bye.",
      "Bye now.",
      "Speak then.",
      "Good luck with the board.",
      "Bye.",
    ],
  },
  "zh-CN": {
    folder: "Kestrel Bay",
    title: "港务委员会：第二条坡道",
    longTitle: "与承包商和港务长的港务委员会通话：第二条坡道、疏浚工程和冬季时刻表的安排与费用",
    typed: ["坡道工程：日期和费用", "施工期间的早班渡轮"],
    question: "坡道工程什么时候开工？",
    check: "核对",
    mine: [
      "大家能听到我吗？",
      "谢谢大家参加。",
      "我们先说 Kestrel Bay 的第二条坡道。",
      "工程什么时候开工？",
      "这是承包商定的日期吗？",
      "疏浚要增加多少费用？",
      "招标里是多少？",
      "请会后发给我。",
      "早班渡轮还能开吗？",
      "潮汐表由谁确认？",
      "我来通知通勤乘客新的时间。",
      "下下周四可以。",
      "码头上的咖啡馆呢？",
      "承包商周末施工吗？",
      "周六滑道能开放吗？",
      "谁来通知渡轮乘客？",
      "我来起草网站上的通知。",
      "码头上也立个牌子吧？",
      "如果潮汐推迟怎么办？",
      "那我们留一周余量。",
      "把这点写进会议纪要。",
      "还有一件事，停车。",
      "会少多少个车位？",
      "能借用市政府的停车场吗？",
      "我明天去问。",
      "散会前还有别的事吗？",
      "谢谢大家。",
      "下下周四再聊。",
      "我今天把纪要发出来。",
      "先这样。",
      "最后确认一下日期。",
      "对，三月三日。",
      "好的。",
      "再次感谢。",
      "回头聊。",
      "再见。",
    ],
    theirs: [
      "能听到。",
      "承包商今天也在。",
      "坡道工程三月三日开工，滑道关闭六周。",
      "上周我们核对过潮汐表。",
      "承包商希望早点开工。",
      "疏浚大约增加二十万英镑，预算因此增至一百四十万英镑。",
      "这是招标里的数字。",
      "会后我们可以把标书发给你。",
      "施工期间，七点四十的班次改到七点五十五。",
      "港务长周五前确认潮汐表。",
      "咖啡馆老板希望提前两周通知。",
      "下下周四我们可以。",
      "周末施工费用更高。",
      "第一个月周六应该没问题。",
      "渡轮公司会写进时刻表。",
      "请把草稿发给我们。",
      "码头上立个牌子会有帮助。",
      "港务长为潮汐留了一周。",
      "这样应该够了。",
      "我们会看纪要。",
      "会少二十个车位。",
      "市政府停车场六点后免费。",
      "这对早班通勤的人有帮助。",
      "等你们的消息。",
      "我们这边没有别的了。",
      "谢谢，先这样。",
      "等你们的纪要。",
      "对，三月三日。",
      "同意。",
      "谢谢。",
      "回头聊。",
      "再见。",
      "再见。",
      "到时候聊。",
      "祝董事会顺利。",
      "再见。",
    ],
  },
}[LANG];

type Core = { incarnamind: CoreBridge };
const meetings = (window: Page): Promise<Meeting[]> =>
  window.evaluate(() => (globalThis as unknown as Core).incarnamind.listMeetings());

/** Nothing under the pointer: it rests in the window's top-left corner, left of the traffic lights. */
async function rest(window: Page) {
  await window.mouse.move(2, 2);
}

/** What a still measures: each region's box, and each control in it with its type and icon sizes. */
async function measure(window: Page, regions: readonly string[]) {
  return window.evaluate((testIds) => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none"
      );
    };
    const type = (el: Element) => {
      const s = getComputedStyle(el);
      return { size: s.fontSize, line: s.lineHeight, weight: s.fontWeight, color: s.color };
    };
    const out: Record<string, unknown> = {
      window: { w: globalThis.innerWidth, h: globalThis.innerHeight },
    };
    for (const id of testIds) {
      const root = [...document.querySelectorAll(`[data-testid="${id}"]`)].find(shown);
      if (!root) continue;
      const controls = [...root.querySelectorAll("button, [role=button], select, input, textarea")]
        .filter(shown)
        .map((el) => ({
          name:
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            (el as HTMLElement).innerText?.trim().slice(0, 60) ||
            el.getAttribute("placeholder") ||
            "",
          box: box(el),
          type: type(el),
          radius: getComputedStyle(el).borderRadius,
          icons: [...el.querySelectorAll("svg")]
            .filter(shown)
            .map((svg) => box(svg))
            .map((b) => `${b.w}x${b.h}`),
          disabled: (el as HTMLButtonElement).disabled === true,
        }));
      const texts = [...root.querySelectorAll("h1, h2, h3, p, li, span, label")]
        .filter((el) => shown(el) && el.children.length === 0 && (el.textContent ?? "").trim())
        .slice(0, 40)
        .map((el) => ({
          text: (el.textContent ?? "").trim().slice(0, 80),
          box: box(el),
          type: type(el),
        }));
      out[id] = { box: box(root), radius: getComputedStyle(root).borderRadius, controls, texts };
    }
    const title = document.querySelector('[data-testid="mind-editor"] h1');
    if (title) out.noteTitle = { box: box(title), type: type(title) };
    const firstLine = document.querySelector('[data-testid="mind-editor"] p');
    if (firstLine) out.noteText = { box: box(firstLine), type: type(firstLine) };
    return out;
  }, regions);
}

/**
 * Asks the stand-in about the call in front, then moves the conversation to the window's column at
 * the left: the input goes with it, the control stays at the Note's foot.
 */
async function askIntoColumn(window: Page, bin: string) {
  await expect
    .poll(
      async () =>
        (await meetings(window)).find((each) => each.status !== "stopped")?.transcript?.documentId,
      { timeout: 60_000 },
    )
    .toBeTruthy();
  const live = (await meetings(window)).find((each) => each.status !== "stopped");
  await writeFile(join(bin, "mode.doc"), live?.transcript?.documentId ?? "");
  await writeFile(join(bin, "mode"), "ask");
  await window.getByTestId("note-ask-input").click();
  await window.keyboard.type(WORDS.question);
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("note-ask-pill-open")).toBeVisible({ timeout: 60_000 });
  await window.getByTestId("note-ask-handle-toggle").click();
  await window.getByTestId("conversation-move-left").click();
  await expect(window.getByTestId("note-column")).toBeVisible();
}

const REGIONS = [
  "meeting-foot",
  "meeting-foot-tip",
  "meeting-sheet",
  "note-ask-box",
  "note-ask-panel",
  "note-column",
  "citation-card",
  "meeting-write-notes",
  "check-card",
  "plus-menu-items",
  "mind-pane",
] as const;

test(`meeting stills, ${LANG}`, async () => {
  test.setTimeout(30 * 60_000);
  if (!OUT) throw new Error("Set STILLS_OUT.");
  await mkdir(OUT, { recursive: true });
  const dataDir = await createDataFolder();
  const home = await realpath(await createDataFolder());
  const bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "meetingClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  const mode = (value: string) => writeFile(join(bin, "mode"), value);
  const log: string[] = [];
  const { app, window } = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
    transcriber: { lines: WORDS.mine, theirLines: WORDS.theirs, maxSpeechMs: 6000 },
  });
  const tag = LANG === "en" ? "en" : "zh";

  /** The window at each width the state is drawn at, with what it measures. */
  const still = async (
    name: string,
    widths: readonly number[] = WIDTHS,
    before?: () => Promise<void>,
  ) => {
    for (const width of widths) {
      try {
        await setWindowSize(app, window, width, HEIGHT);
        await before?.();
        await rest(window);
        await motionSettled(window);
        await window.waitForTimeout(500);
        const file = `${name}-${tag}-${width}`;
        await window.screenshot({ path: join(OUT, `${file}.png`) });
        await writeFile(
          join(OUT, `${file}.json`),
          JSON.stringify(await measure(window, REGIONS), null, 2),
        );
        log.push(`ok ${file}`);
      } catch (error) {
        log.push(`FAILED ${name} ${width}: ${String(error).slice(0, 300)}`);
      }
    }
    await setWindowSize(app, window, 1440, HEIGHT);
  };
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      log.push(`FAILED step ${name}: ${String(error).slice(0, 400)}`);
    }
  };

  try {
    await acceptPlainTextKeys(window);
    await dismissChatSetup(window);
    await setLanguage(window, LANG);
    await setWindowSize(app, window, 1440, HEIGHT);
    const ids = await window.evaluate(async (name) => {
      const core = (globalThis as unknown as Core).incarnamind;
      const folder = await core.createLibraryGroup({ name, description: "" });
      await core.setAgentsEnabled(true);
      const { pairing } = await core.connectAgent({
        name: "Claude Code",
        client: "claude-code",
        folderIds: [folder.id, "not-in-a-folder"],
        propose: true,
      });
      await core.updateSettings({
        device: { meetingNotesAgentId: pairing.id, meetingPanel: false },
      });
      return { folder: folder.id, agent: pairing.id };
    }, WORDS.folder);

    // a. The way in: the + menu's Record a meeting, which records at once, the first time too.
    const plus = window.getByTestId("plus-menu");
    await step("way in", async () => {
      await still("a1-way-in", [1440, 900], async () => {
        if (!(await window.getByTestId("plus-record-meeting").isVisible())) await plus.click();
        await expect(window.getByTestId("plus-record-meeting")).toBeVisible();
      });
      await window.keyboard.press("Escape");
    });
    await plus.click();
    await window.getByTestId("plus-record-meeting").click();
    await expect(window.getByTestId("meeting-foot")).toHaveAttribute("data-status", "recording", {
      timeout: 10_000,
    });
    await expect
      .poll(async () => (await meetings(window)).some((each) => each.status === "recording"), {
        timeout: 30_000,
      })
      .toBe(true);
    const meeting = (await meetings(window)).find((each) => each.status === "recording");
    if (!meeting) throw new Error("No meeting recording.");
    await window.evaluate(
      async ({ mindId, folderId }) => {
        const core = (globalThis as unknown as Core).incarnamind;
        await core.moveToFolder({ mindIds: [mindId], folderId });
      },
      { mindId: meeting.mindId, folderId: ids.folder },
    );

    // b. Recording, the Note in view: first an empty Note with the first tip, then two lines the
    // User typed.
    await step("recording empty", async () => {
      await still("b0-recording-empty", [1440, 1280, 900]);
    });
    const editor = window.getByTestId("mind-editor");
    const rename = (title: string) =>
      window.evaluate(
        ({ mindId, name }) => (globalThis as unknown as Core).incarnamind.renameMind(mindId, name),
        { mindId: meeting.mindId, name: title },
      );
    const named = (
      await window
        .locator(`[data-testid="mind-row"][data-mind-id="${meeting.mindId}"]`)
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    await step("type", async () => {
      await window
        .getByTestId("meeting-foot-tip-close")
        .click({ timeout: 2000 })
        .catch(() => undefined);
      await editor.locator("p").first().click();
      await window.keyboard.type(WORDS.typed[0] ?? "");
      await window.keyboard.press("Enter");
      await window.keyboard.type(WORDS.typed[1] ?? "");
      await editor.evaluate((el) => (el as HTMLElement).blur());
    });
    await expect
      .poll(
        async () =>
          (await meetings(window)).find((each) => each.id === meeting.id)?.transcript?.lines ?? 0,
        {
          timeout: 60_000,
        },
      )
      .toBeGreaterThanOrEqual(5);
    await step("recording", async () => {
      await still("b1-recording", [1440, 1280, 900]);
    });

    // c. The live Transcript.
    await step("transcript", async () => {
      await window.getByTestId("meeting-foot-transcript").click();
      await expect(window.getByTestId("meeting-sheet")).toBeVisible();
      await still("c1-transcript", [1440, 1280, 900]);
      await window.getByTestId("meeting-foot-transcript").click();
      await expect(window.getByTestId("meeting-sheet")).toBeHidden();
    });

    // d. Asking during the meeting: the reply on its line, then opened, with a Citation's card.
    const documentId = (await meetings(window)).find((each) => each.id === meeting.id)?.transcript
      ?.documentId;
    await writeFile(join(bin, "mode.doc"), documentId ?? "");
    await step("ask", async () => {
      await mode("ask");
      const input = window.getByTestId("note-ask-input");
      await input.click();
      await window.keyboard.type(WORDS.question);
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("note-ask-pill-open")).toBeVisible({ timeout: 60_000 });
      await editor.evaluate((el) => (el as HTMLElement).blur());
      await window.getByTestId("note-ask-input").blur();
      await still("d1-asked");
      // Opened from its line: upward in the input's box (the column at the left is drawn apart).
      const panel = window.getByTestId("note-ask-panel");
      const openUpward = async () => {
        if (await panel.isVisible()) return;
        const handle = window.getByTestId("note-ask-handle-toggle");
        if (await handle.isVisible()) await handle.click();
        else await window.getByTestId("note-ask-pill-open").click();
        if (
          await window
            .getByTestId("note-column")
            .isVisible()
            .catch(() => false)
        )
          await window.getByTestId("conversation-move-down").click();
        await expect(panel).toBeVisible();
      };
      await still("d2-reply", WIDTHS, openUpward);
      await still("d3-citation", WIDTHS, async () => {
        await openUpward();
        await panel.locator(".citation-marker").first().click();
        await expect(window.getByTestId("meeting-sheet")).toBeVisible();
      });
      await window.getByTestId("meeting-sheet-hide").click();
      await still("d4-narrow-conversation", [900], openUpward);
      // Folded to its line again, as a person leaves it before Stop.
      if (await panel.isVisible()) await window.getByTestId("note-ask-fold").click();
      await expect(panel).toBeHidden();
    });

    await step("long title", async () => {
      await rename(WORDS.longTitle);
      await still("b2-long-title", [1440, 900]);
      if (named) await rename(named);
    });

    // e. After Stop.
    await step("stop", async () => {
      await window.getByTestId("meeting-foot-stop").click();
      await expect
        .poll(async () => (await meetings(window)).find((each) => each.id === meeting.id)?.status, {
          timeout: 60_000,
        })
        .toBe("stopped");
      await expect
        .poll(
          async () =>
            (await meetings(window)).find((each) => each.id === meeting.id)?.transcript?.state,
          { timeout: 60_000 },
        )
        .toBe("saved");
      await window.waitForTimeout(1500);
      await still("e1-stopped");
      await window.getByTestId("meeting-foot-transcript").click();
      await expect(window.getByTestId("meeting-sheet")).toBeVisible();
      await still("e2-stopped-sheet");
      const details = window.getByTestId("meeting-sheet").getByTestId("meeting-details-toggle");
      await details.click();
      await expect(window.getByTestId("meeting-sheet-details")).toBeVisible();
      await still("e3-details-open", [1440]);
      await details.click();
      await window.getByTestId("meeting-sheet-hide").click();
    });

    // f. The notes the User's AI writes, then the check, then the words said for one sentence.
    await step("notes", async () => {
      await mode(LANG === "en" ? "notes" : "notes-zh");
      await window.getByTestId("meeting-write-notes").click();
      // Drawn: the name written from what was said, which no tool of the AI's can set yet.
      await rename(WORDS.title);
      await expect
        .poll(async () => (await editor.innerText()).includes(LANG === "en" ? "slipway" : "滑道"), {
          timeout: 60_000,
        })
        .toBe(true);
      const accept = window.getByTestId("proposals-accept-all");
      if (await accept.isVisible().catch(() => false)) await accept.click();
      await window.waitForTimeout(1500);
      await still("f0-notes-written");
      await mode(LANG === "en" ? "check" : "check-zh");
      await editor.click();
      await runCommand(window, "mind.check", WORDS.check);
      await expect
        .poll(
          async () =>
            (await window.getByTestId("check-badge-open").first().getAttribute("aria-label")) ?? "",
          { timeout: 90_000 },
        )
        .toMatch(/look|留意/)
        .catch(() => log.push("the check badge never named a sentence to look at"));
      await window.waitForTimeout(2000);
      await editor.evaluate((el) => (el as HTMLElement).blur());
      const closeCard = async () => {
        if (
          await window
            .getByTestId("check-card")
            .isVisible()
            .catch(() => false)
        )
          await window.keyboard.press("Escape");
      };
      await still("f1-notes-checked", WIDTHS, closeCard);
      const cite = editor.getByTestId("citation").first();
      await still("f2-words-said", WIDTHS, async () => {
        await closeCard();
        await cite.click({ force: true });
        await expect(window.getByTestId("citation-card")).toBeVisible();
      });
      await still("f3-unsupported", WIDTHS, async () => {
        await window.keyboard.press("Escape");
        await window
          .getByText(LANG === "en" ? "already approved" : "已经批准")
          .first()
          .click({ force: true });
      });
      await window.keyboard.press("Escape");
    });
  } finally {
    await writeFile(join(OUT, `log-${tag}.txt`), log.join("\n"));
    await app.close().catch(() => undefined);
    await removeDataFolder(dataDir);
    await removeDataFolder(home);
    await removeDataFolder(bin);
  }
});

// The control's states that change its words or width: the time past an hour, paused, and a
// microphone the app may not use. The clock is the page's own, fixed; the core records on.
for (const microphone of ["allowed", "denied"] as const)
  test(`meeting control states, microphone ${microphone}, ${LANG}`, async () => {
    test.setTimeout(10 * 60_000);
    await mkdir(OUT, { recursive: true });
    const dataDir = await createDataFolder();
    const home = await realpath(await createDataFolder());
    const bin = await realpath(await createDataFolder());
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "meetingClaudeCode.mjs")}" "$@"\n`,
    );
    await chmod(join(bin, "claude"), 0o755);
    const log: string[] = [];
    const tag = LANG === "en" ? "en" : "zh";
    const { app, window } = await launchApp(dataDir, {
      home,
      ownAi: join(bin, "claude"),
      extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
      transcriber: { lines: WORDS.mine, theirLines: WORDS.theirs, maxSpeechMs: 6000 },
      microphone,
    });
    const still = async (name: string, widths: readonly number[]) => {
      for (const width of widths) {
        try {
          await setWindowSize(app, window, width, HEIGHT);
          await rest(window);
          await motionSettled(window);
          await window.waitForTimeout(1500);
          const file = `${name}-${tag}-${width}`;
          await window.screenshot({ path: join(OUT, `${file}.png`) });
          await writeFile(
            join(OUT, `${file}.json`),
            JSON.stringify(await measure(window, REGIONS), null, 2),
          );
          log.push(`ok ${file}`);
        } catch (error) {
          log.push(`FAILED ${name} ${width}: ${String(error).slice(0, 300)}`);
        }
      }
      await setWindowSize(app, window, 1440, HEIGHT);
    };
    try {
      await acceptPlainTextKeys(window);
      await dismissChatSetup(window);
      await setLanguage(window, LANG);
      const folderId = await window.evaluate(async () => {
        const core = (globalThis as unknown as Core).incarnamind;
        await core.updateSettings({
          device: { transcriptionRoute: "local", meetingPanel: false },
        });
        const folder = await core.createLibraryGroup({ name: "Kestrel Bay", description: "" });
        await core.setAgentsEnabled(true);
        await core.connectAgent({
          name: "Claude Code",
          client: "claude-code",
          folderIds: [folder.id, "not-in-a-folder"],
          propose: true,
        });
        return folder.id;
      });
      await setWindowSize(app, window, 1440, HEIGHT);
      // A plain Note from the same build: its input's edges are the text's, as the meeting's row.
      if (microphone === "allowed") {
        await window.keyboard.press("ControlOrMeta+t");
        const plain = window.getByTestId("mind-editor");
        await expect(plain).toBeVisible();
        // A new Note opens with the cursor in its title.
        await window.waitForTimeout(1500);
        await window.keyboard.type(WORDS.folder);
        await window.keyboard.press("Enter");
        await window.keyboard.type(WORDS.typed[0] ?? "");
        await plain.evaluate((el) => (el as HTMLElement).blur());
        await window.evaluate(async (folderId) => {
          const core = (globalThis as unknown as Core).incarnamind;
          const mindIds = (await core.listMinds()).map((each) => each.id);
          await core.moveToFolder({ mindIds, folderId });
        }, folderId);
        await expect(window.getByTestId("note-ask-input"))
          .toBeVisible({ timeout: 15_000 })
          .catch(() => log.push("no input on the plain Note"));
        await still("p1-plain-note", [1440, 900]);
      }
      await window.getByTestId("plus-menu").click();
      await window.getByTestId("plus-record-meeting").click();
      await expect
        .poll(async () => (await meetings(window)).some((each) => each.status === "recording"), {
          timeout: 30_000,
        })
        .toBe(true);
      await window.evaluate(async (folderId) => {
        const core = (globalThis as unknown as Core).incarnamind;
        const [recording] = (await core.listMeetings()).filter(
          (each) => each.status === "recording",
        );
        if (recording) await core.moveToFolder({ mindIds: [recording.mindId], folderId });
      }, folderId);
      await window
        .getByTestId("meeting-foot-tip-close")
        .click({ timeout: 5000 })
        .catch(() => undefined);
      const editor = window.getByTestId("mind-editor");
      await editor.locator("p").first().click();
      await window.keyboard.type(WORDS.typed[0] ?? "");
      await editor.evaluate((el) => (el as HTMLElement).blur());
      await expect(window.getByTestId("note-ask-input"))
        .toBeVisible({ timeout: 15_000 })
        .catch(() => log.push("no input at the Note's foot"));
      const meeting = async () => {
        const found = (await meetings(window)).find((each) => each.status !== "stopped");
        if (!found) throw new Error("No meeting.");
        return found;
      };

      // The microphone the app may not use: its line above the control, the mark in the bars' place.
      if (microphone === "denied") {
        await expect(window.getByTestId("meeting-foot-problem"))
          .toBeVisible({ timeout: 15_000 })
          .catch(() => log.push("no microphone line"));
        await still("g3-mic-denied", WIDTHS);
        await askIntoColumn(window, bin).catch((error: unknown) =>
          log.push(`FAILED column: ${String(error).slice(0, 300)}`),
        );
        await still("h1m-column-mic-denied", COLUMN_WIDTHS);
        return;
      }

      // Paused once something was said, so the time it holds isn't the first second's.
      await expect
        .poll(async () => (await meeting()).transcript?.lines ?? 0, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(2);
      const { id } = await meeting();
      await window.evaluate(
        (meetingId) => (globalThis as unknown as Core).incarnamind.pauseMeeting(meetingId),
        id,
      );
      await expect(window.getByTestId("meeting-foot")).toHaveAttribute("data-status", "paused");
      await still("g4-paused", WIDTHS);
      await window.evaluate(
        (meetingId) => (globalThis as unknown as Core).incarnamind.resumeMeeting(meetingId),
        id,
      );
      await expect(window.getByTestId("meeting-foot")).toHaveAttribute("data-status", "recording");

      // The stop square's name, in the shared tip, once the pointer rests on it.
      const stop = window.getByTestId("meeting-foot-stop");
      await stop.hover();
      await expect(window.getByRole("tooltip"))
        .toBeVisible({ timeout: 5000 })
        .catch(() => log.push("no tip on the stop square"));
      await motionSettled(window);
      await window.waitForTimeout(400);
      await window.screenshot({ path: join(OUT, `b3-stop-tip-${tag}-1440.png`) });
      await writeFile(
        join(OUT, `b3-stop-tip-${tag}-1440.json`),
        JSON.stringify(await measure(window, REGIONS), null, 2),
      );
      log.push(`ok b3-stop-tip-${tag}-1440`);
    } finally {
      await writeFile(join(OUT, `log-states-${microphone}-${tag}.txt`), log.join("\n"));
      await app.close().catch(() => undefined);
      await removeDataFolder(dataDir);
      await removeDataFolder(home);
      await removeDataFolder(bin);
    }
  });

// The meeting with the Note's conversation in the window's column at the left (#3759): the control
// stays at the Note's foot, the input goes with the conversation, the sheet rises over the Note.
test(`meeting with the conversation at the left, ${LANG}`, async () => {
  test.setTimeout(15 * 60_000);
  await mkdir(OUT, { recursive: true });
  const dataDir = await createDataFolder();
  const home = await realpath(await createDataFolder());
  const bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "meetingClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  const mode = (value: string) => writeFile(join(bin, "mode"), value);
  const log: string[] = [];
  const tag = LANG === "en" ? "en" : "zh";
  const { app, window } = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
    transcriber: { lines: WORDS.mine, theirLines: WORDS.theirs, maxSpeechMs: 6000 },
  });
  const still = async (name: string, widths: readonly number[], before?: () => Promise<void>) => {
    for (const width of widths) {
      try {
        await setWindowSize(app, window, width, HEIGHT);
        await before?.();
        await rest(window);
        await motionSettled(window);
        await window.waitForTimeout(800);
        const file = `${name}-${tag}-${width}`;
        await window.screenshot({ path: join(OUT, `${file}.png`) });
        await writeFile(
          join(OUT, `${file}.json`),
          JSON.stringify(await measure(window, REGIONS), null, 2),
        );
        log.push(`ok ${file}`);
      } catch (error) {
        log.push(`FAILED ${name} ${width}: ${String(error).slice(0, 300)}`);
      }
    }
    await setWindowSize(app, window, 1440, HEIGHT);
  };
  try {
    await acceptPlainTextKeys(window);
    await dismissChatSetup(window);
    await setLanguage(window, LANG);
    await setWindowSize(app, window, 1440, HEIGHT);
    const folderId = await window.evaluate(async () => {
      const core = (globalThis as unknown as Core).incarnamind;
      await core.updateSettings({
        device: { transcriptionRoute: "local", meetingPanel: false },
      });
      const folder = await core.createLibraryGroup({ name: "Kestrel Bay", description: "" });
      await core.setAgentsEnabled(true);
      await core.connectAgent({
        name: "Claude Code",
        client: "claude-code",
        folderIds: [folder.id, "not-in-a-folder"],
        propose: true,
      });
      return folder.id;
    });
    await window.getByTestId("plus-menu").click();
    await window.getByTestId("plus-record-meeting").click();
    await expect
      .poll(async () => (await meetings(window)).some((each) => each.status === "recording"), {
        timeout: 30_000,
      })
      .toBe(true);
    const meeting = (await meetings(window)).find((each) => each.status === "recording");
    if (!meeting) throw new Error("No meeting recording.");
    await window.evaluate(
      async ({ mindId, folderId }) =>
        (globalThis as unknown as Core).incarnamind.moveToFolder({ mindIds: [mindId], folderId }),
      { mindId: meeting.mindId, folderId },
    );
    await window
      .getByTestId("meeting-foot-tip-close")
      .click({ timeout: 5000 })
      .catch(() => undefined);
    const editor = window.getByTestId("mind-editor");
    await editor.locator("p").first().click();
    await window.keyboard.type(WORDS.typed[0] ?? "");
    await window.keyboard.press("Enter");
    await window.keyboard.type(WORDS.typed[1] ?? "");
    await editor.evaluate((el) => (el as HTMLElement).blur());
    await expect
      .poll(
        async () =>
          (await meetings(window)).find((each) => each.id === meeting.id)?.transcript?.lines ?? 0,
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(5);
    const documentId = (await meetings(window)).find((each) => each.id === meeting.id)?.transcript
      ?.documentId;
    await writeFile(join(bin, "mode.doc"), documentId ?? "");

    // Asked, then the conversation moved to the window's column at the left.
    await mode("ask");
    await window.getByTestId("note-ask-input").click();
    await window.keyboard.type(WORDS.question);
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("note-ask-pill-open")).toBeVisible({ timeout: 60_000 });
    await window.getByTestId("note-ask-handle-toggle").click();
    await window.getByTestId("conversation-move-left").click();
    await expect(window.getByTestId("note-column")).toBeVisible();
    await still("h1-column-recording", COLUMN_WIDTHS);

    // Paused, the column beside: the resume triangle in the bars' slot.
    await window.evaluate(
      (meetingId) => (globalThis as unknown as Core).incarnamind.pauseMeeting(meetingId),
      meeting.id,
    );
    await expect(window.getByTestId("meeting-foot")).toHaveAttribute("data-status", "paused");
    await still("h1p-column-paused", COLUMN_WIDTHS);
    await window.evaluate(
      (meetingId) => (globalThis as unknown as Core).incarnamind.resumeMeeting(meetingId),
      meeting.id,
    );
    await expect(window.getByTestId("meeting-foot")).toHaveAttribute("data-status", "recording");

    // The sheet over the Note, the column beside it.
    await still("h2-column-sheet", COLUMN_WIDTHS, async () => {
      if (!(await window.getByTestId("meeting-sheet").isVisible()))
        await window.getByTestId("meeting-foot-transcript").click();
      await expect(window.getByTestId("meeting-sheet")).toBeVisible();
    });
    await window.getByTestId("meeting-sheet-hide").click();

    // A Citation pressed in the column's reply: the sheet at its line, the reply beside it.
    await still("h3-column-citation", COLUMN_WIDTHS, async () => {
      if (await window.getByTestId("meeting-sheet").isVisible())
        await window.getByTestId("meeting-sheet-hide").click();
      const reply = window.getByTestId("note-column").or(window.getByTestId("note-ask-panel"));
      if (!(await reply.first().isVisible()))
        await window.getByTestId("note-ask-handle-toggle").click();
      await reply.first().locator(".citation-marker").first().click();
      await expect(window.getByTestId("meeting-sheet")).toBeVisible();
    });
    if (await window.getByTestId("meeting-sheet").isVisible())
      await window.getByTestId("meeting-sheet-hide").click();

    // After Stop: Write notes above the control; then the finished change on the column's input line.
    await window.getByTestId("meeting-foot-stop").click();
    await expect
      .poll(async () => (await meetings(window)).find((each) => each.id === meeting.id)?.status, {
        timeout: 60_000,
      })
      .toBe("stopped");
    await expect
      .poll(
        async () =>
          (await meetings(window)).find((each) => each.id === meeting.id)?.transcript?.state,
        { timeout: 60_000 },
      )
      .toBe("saved");
    if (
      !(await window
        .getByTestId("note-column")
        .isVisible()
        .catch(() => false))
    )
      await window
        .getByTestId("note-ask-handle-toggle")
        .click()
        .catch(() => undefined);
    await still("h4-column-stopped", COLUMN_WIDTHS);
    await mode(LANG === "en" ? "notes" : "notes-zh");
    await window.getByTestId("meeting-write-notes").click();
    await expect
      .poll(async () => (await editor.innerText()).includes(LANG === "en" ? "slipway" : "滑道"), {
        timeout: 60_000,
      })
      .toBe(true);
    await still("h5-column-notes", COLUMN_WIDTHS);

    // Checked against the Transcript, the column beside.
    await mode(LANG === "en" ? "check" : "check-zh");
    await editor.click();
    await runCommand(window, "mind.check", WORDS.check);
    await expect
      .poll(
        async () =>
          (await window.getByTestId("check-badge-open").first().getAttribute("aria-label")) ?? "",
        { timeout: 90_000 },
      )
      .toMatch(/look|留意/)
      .catch(() => log.push("the check badge never named a sentence to look at"));
    await editor.evaluate((el) => (el as HTMLElement).blur());
    await still("h6-column-checked", COLUMN_WIDTHS, async () => {
      if (
        await window
          .getByTestId("check-card")
          .isVisible()
          .catch(() => false)
      )
        await window.keyboard.press("Escape");
    });
  } finally {
    await writeFile(join(OUT, `log-column-${tag}.txt`), log.join("\n"));
    await app.close().catch(() => undefined);
    await removeDataFolder(dataDir);
    await removeDataFolder(home);
    await removeDataFolder(bin);
  }
});
