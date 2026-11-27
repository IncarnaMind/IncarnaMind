import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * The line above a Note's input while a long request runs (#3677), with the stand-in for Claude
 * Code: the request shows at once, then the AI's own words for its thinking, the Document it reads
 * and the one whose quote it writes, by their names, the paragraph it writes, and "Thinking" once a
 * call has ended; the change applied with Undo, which takes the line; and a run stopped for
 * silence with its one action. In English at 1440 and Chinese at 900. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save the stills.
 */

let dataDir: string;
let sources: string;
let home: string;
let bin: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});
test.afterEach(async () => {
  for (const folder of [dataDir, sources, home, bin]) await removeDataFolder(folder);
});

const nextRun = (mode: string) => writeFile(join(bin, "mode"), mode);
const stepTo = (n: number) => writeFile(join(bin, "mode.step"), String(n));

async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.waitForTimeout(300);
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

const LANGUAGES = {
  en: {
    size: { width: 1440, height: 900 },
    folder: "Ferry interviews",
    interviews: [
      [
        "Ferry interview 1 – deckhand",
        "The 07:40 crossing leaves late most weeks. Loading the freight vans takes too long.",
      ],
      [
        "Ferry interview 2 – harbour master",
        "The single ramp at Kestrel Bay is the bottleneck on the early crossing. A second ramp is planned for 2027.",
      ],
      [
        "Ferry interview 3 – commuter",
        "I have missed the 08:15 train four times since September because the 07:40 ferry was late.",
      ],
    ],
    ask: "Summarise what these interviews say about the early crossing, with sources.",
    working: "Working",
    thinking: "Thinking · Comparing what the crew and the passengers said",
    reading: /^Reading (1 of \d+: )?“Ferry interview \d – [a-z ]+”$/,
    quoting: /^Checking quotes from “Ferry interview \d – [a-z ]+”$/,
    writing: "Writing “The 07:40 crossing leaves late most weeks”",
    reply: "I wrote why the early crossing runs late into the note, with its source.",
    undo: "Undo",
    stalled: "Claude Code didn’t answer for six minutes, so it stopped.",
    again: "Try again",
  },
  "zh-CN": {
    size: { width: 900, height: 800 },
    folder: "渡轮访谈",
    interviews: [
      ["渡轮访谈 1 – 水手", "07:40 的渡轮大多数周都晚开。货车装船太慢。"],
      [
        "渡轮访谈 2 – 港务长",
        "凯斯特湾只有一个坡道，早班渡轮就卡在这里。第二个坡道计划在 2027 年建成。",
      ],
      ["渡轮访谈 3 – 通勤者", "从九月起，因为 07:40 的渡轮晚点，我已经四次没赶上 08:15 的火车。"],
    ],
    ask: "总结一下这些访谈里关于早班渡轮的说法，注明出处。",
    working: "处理中",
    thinking: "思考中 · 比较船员和乘客的说法",
    reading: /^正在读 (1\/\d+：)?“渡轮访谈 \d – \S+”$/,
    quoting: /^正在核对“渡轮访谈 \d – \S+”中的引文$/,
    writing: "正在写“07:40 的渡轮大多数周都晚开”",
    reply: "已把早班渡轮晚点的原因写进笔记，并注明了出处。",
    undo: "撤销",
    stalled: "Claude Code 六分钟没有回应，已停止。",
    again: "重试",
  },
} as const;

for (const [language, words] of Object.entries(LANGUAGES) as [
  keyof typeof LANGUAGES,
  (typeof LANGUAGES)[keyof typeof LANGUAGES],
][]) {
  test(`the line says what a long request is doing, from the request to its change and Undo, and a stopped run's one action, in ${language}`, async () => {
    test.setTimeout(150_000);
    const { app, window } = await launchApp(dataDir, {
      home,
      ownAi: join(bin, "claude"),
      extraEnv: {
        INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode"),
        INCARNAMIND_TEST_OWN_AI_STALL_MS: "3000",
      },
    });
    await acceptPlainTextKeys(window);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, words.size.width, words.size.height);
      if (language === "zh-CN") await setLanguage(window, "zh-CN");
      const paths: string[] = [];
      for (const [name, text] of words.interviews) {
        const path = join(sources, `${name}.md`);
        await writeFile(path, `# ${name}\n\n${text}\n`);
        paths.push(path);
      }
      const mindId = await window.evaluate(
        async ({ files, folder }) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const made = await bridge.createLibraryGroup({ name: folder, description: "" });
          await bridge.addDocuments(files, { groupId: made.id });
          await bridge.setAgentsEnabled(true);
          await bridge.connectAgent({
            name: "Claude Code",
            client: "claude-code",
            folderIds: [made.id],
            propose: true,
          });
          return (await bridge.createMind({ folderId: made.id })).id;
        },
        { files: paths, folder: words.folder },
      );
      await expectReadyDocuments(window, paths.length);
      const folderRow = sidebarFolder(window, words.folder).getByTestId("folder-row");
      if ((await folderRow.getAttribute("aria-expanded")) !== "true") {
        await pointAndClick(window, folderRow);
      }
      await pointAndClick(
        window,
        window.locator(`[data-testid="mind-row"][data-mind-id="${mindId}"]`).first(),
      );
      await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
      const group = window.locator('[data-testid="tab-group"][data-focused]');
      const input = group.getByTestId("note-ask-input");
      const line = group.getByTestId("note-ask-pill-text");

      // Sent, the request shows at once, before the AI's first word.
      await nextRun("page");
      await stepTo(0);
      await pointAndClick(window, input);
      await window.keyboard.type(words.ask);
      await window.keyboard.press("Enter");
      await expect(line).toHaveText(words.working, { timeout: 1_000 });
      await expect(input).toHaveValue("");

      // Its thinking, in its own words.
      await stepTo(1);
      await expect(line).toHaveText(words.thinking);
      await shot(window, `line-thinking-${language}`);

      // A read, by its Document's name, while it is going.
      await stepTo(2);
      await expect(line).toHaveText(words.reading);
      await shot(window, `line-long-read-${language}`);

      // Its call ended, the line says it thinks, then the Document whose quote it writes.
      await stepTo(3);
      await expect(line).toHaveText(words.quoting);

      // The paragraph it writes, by its first words.
      await stepTo(4);
      await expect(line).toHaveText(words.writing);
      await shot(window, `line-writing-${language}`);

      // Its change is in the Note while it goes on, before its line ends.
      const written = words.writing.slice(words.writing.indexOf("“") + 1, -1);
      const pill = group.getByTestId("note-ask-pill");
      await stepTo(5);
      await expect(frontMind(window)).toContainText(written);
      await expect(pill).toHaveAttribute("data-state", "working");
      await shot(window, `line-after-change-${language}`);

      // Ended, the line is its reply with Undo.
      await stepTo(6);
      await expect(pill).toHaveAttribute("data-state", "landed");
      await expect(group.getByTestId("note-ask-pill-open")).toHaveText(words.reply);
      await expect(frontMind(window)).toContainText(written);
      await shot(window, `line-ended-applied-${language}`);

      // Undone, the change goes, and the line with it.
      await pointAndClick(window, group.getByTestId("note-ask-undo"));
      await expect(pill).toHaveCount(0);
      await expect(frontMind(window)).not.toContainText(written);

      // A run that sends nothing stops, says so in plain words, with its one action.
      await nextRun("wait");
      await pointAndClick(window, input);
      await window.keyboard.type(words.ask);
      await window.keyboard.press("Enter");
      const problem = group.getByTestId("note-ask-problem");
      await expect(problem).toContainText(words.stalled, { timeout: 30_000 });
      const again = group.getByTestId("note-ask-try-again");
      await expect(again).toHaveText(words.again);
      await shot(window, `line-stopped-${language}`);

      // Sent again, its change in the Note while it goes on: the User types in the Note meanwhile.
      await nextRun("page");
      await stepTo(5);
      await pointAndClick(window, again);
      await expect(frontMind(window)).toContainText(written, { timeout: 30_000 });
      await expect(pill).toHaveAttribute("data-state", "working");
      const typed = language === "en" ? "Checked with the crew." : "已和船员核对。";
      await pointAndClick(window, frontMind(window).locator(".mind-editor > :last-child"));
      await window.keyboard.press("End");
      await window.keyboard.press("Enter");
      await window.keyboard.type(typed);
      await expect(frontMind(window)).toContainText(typed);
      await stepTo(6);
      await expect(pill).toHaveAttribute("data-state", "landed", { timeout: 30_000 });
      await expect(frontMind(window)).toContainText(written);
      await expect(frontMind(window)).toContainText(typed);
    } finally {
      await app.close();
    }
  });
}
