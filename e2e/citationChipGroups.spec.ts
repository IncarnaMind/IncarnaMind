import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { part, unzip } from "../tests/helpers/docx";
import { paragraph, run, wordFile } from "../tests/helpers/word";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";
import { callTool } from "./canvases";

/*
 * Citations of one source and place side by side show as one chip (#3654): a Note an outside
 * agent wrote from a test interview transcript, whose sentence quotes one speaker turn three times,
 * shows "1 2", not "1 2 2 2". Pressing the 2 lists its three quotes and opens the transcript at
 * the first, all three marked; the stepper goes from quote to quote. The keyboard reaches the chip
 * once, Backspace takes it whole with one Undo, and the Word file writes one mark for it. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save stills, light and dark.
 */

const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let sources: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

async function shot(window: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const WORDS = {
  en: {
    file: "Interview 7 - Participant B.docx",
    title: "Night-shift handover",
    turns: [
      ["Interviewer", "Do you use the electronic record during handover?"],
      ["Participant B", "We do, but we still keep the paper list, everybody does."],
      ["Interviewer", "Why keep the paper list?"],
      [
        "Participant B",
        "Partly habit, but mostly the record itself. The record takes a minute to open on the ward laptop, and at three in the morning that minute is a long time. The overnight fluids never show up on the summary screen. And you can't read it at the bedside with the lights off.",
      ],
    ],
    quotes: [
      "we still keep the paper list, everybody does",
      "The record takes a minute to open on the ward laptop",
      "The overnight fluids never show up on the summary screen",
      "you can't read it at the bedside with the lights off",
    ],
    note: (c: string[]) =>
      `The night team keeps a paper list ${c[0]}, because the record is slow, misses the fluids and can't be read in the dark ${c[1]}${c[2]}${c[3]}.`,
    sentence: "paper list",
    found: /^3 quotes found in ¶\s4$/,
    label: /^Citation 2, 3 quotes: Interview 7 - Participant B/,
    step: (at: number) => `Quote ${at} of 3`,
  },
  "zh-CN": {
    file: "访谈 7 - 受访者 B.docx",
    title: "夜班交接",
    turns: [
      ["访谈者", "交接时用电子病历吗？"],
      ["受访者 B", "用，但我们还是留着纸质清单，人人都有。"],
      ["访谈者", "为什么还要留纸质清单？"],
      [
        "受访者 B",
        "一半是习惯，主要还是电子病历本身的问题。病房的笔记本打开病历要一分钟，凌晨三点这一分钟就很长。夜间出入量从来不显示在概要页上。而且关着灯在床旁根本没法看。",
      ],
    ],
    quotes: [
      "我们还是留着纸质清单，人人都有",
      "病房的笔记本打开病历要一分钟",
      "夜间出入量从来不显示在概要页上",
      "关着灯在床旁根本没法看",
    ],
    note: (c: string[]) =>
      `夜班团队仍保留纸质清单${c[0]}，因为病历打开慢、没有出入量、关灯后无法查看${c[1]}${c[2]}${c[3]}。`,
    sentence: "纸质清单",
    found: /^已在“第 4 段”中找到 3 处引文$/,
    label: /^引用 2，共 3 处引文：访谈 7 - 受访者 B/,
    step: (at: number) => `第 ${at} 处引文，共 3 处`,
  },
} as const;

/** A Note the agent wrote, open, with the chips of its one sentence. */
async function openAgentNote(language: "en" | "zh-CN", width: number) {
  const words = WORDS[language];
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  const path = join(sources, words.file);
  await writeFile(
    path,
    wordFile({
      body: words.turns
        .map(([speaker, said]) => paragraph(run(`${speaker}: `, { b: true }) + run(said)))
        .join(""),
    }),
  );
  const folderId = await window.evaluate(async (file) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Interviews", description: "" });
    await bridge.addDocuments([file], { groupId: folder.id });
    return folder.id;
  }, path);
  await expectReadyDocuments(window, 1);
  await acceptPlainTextKeys(window);
  const launch = await window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setAgentsEnabled(true);
    return (await bridge.connectAgent({ name: "Interview agent", folderIds: [id], propose: true }))
      .launch;
  }, folderId);
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  try {
    const cited = await callTool<{ citations: { cite: string | null; check: string }[] }>(
      agent,
      "cite",
      { citations: words.quotes.map((quote) => ({ path, quote })) },
    );
    expect(cited.citations.map((each) => each.check)).toEqual(["found", "found", "found", "found"]);
    await callTool(agent, "create_mind", {
      title: words.title,
      markdown: words.note(cited.citations.map((each) => each.cite ?? "")),
    });
  } finally {
    await agent.close();
  }
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: words.title }),
  );
  const editor = window.getByTestId("mind-editor");
  await expect(editor.getByTestId("citation")).toHaveCount(4);
  const chips = editor
    .locator("p")
    .filter({ hasText: words.sentence })
    .getByTestId("citation-chip")
    .filter({ visible: true });
  return { app, window, editor, chips, words };
}

/** The transcript's quote highlights by the quote they are of, and whether each is the one on. */
const marked = (window: Page) =>
  window.getByTestId("viewer-docx").evaluate((viewer) => {
    const quotes = new Map<number, boolean>();
    for (const mark of viewer.querySelectorAll<HTMLElement>("[data-quote-index]")) {
      quotes.set(
        Number(mark.dataset.quoteIndex),
        !mark.classList.contains("quote-highlight--other"),
      );
    }
    return [...quotes].sort((a, b) => a[0] - b[0]);
  });

const stepCount = (window: Page) => window.getByTestId("quote-steps-count");

test("three quotes of one speaker turn side by side: one chip, its card, the stepper, the keys and the Word file (en)", async () => {
  test.setTimeout(240_000);
  const { app, window, editor, chips, words } = await openAgentNote("en", 1440);
  try {
    await expect(chips).toHaveText(["1", "2"]);
    const chip = chips.nth(1);
    await expect(chip).toHaveAccessibleName(words.label);
    await window.mouse.move(1430, 880);
    await shot(window, "chips-en-light");
    await window.emulateMedia({ colorScheme: "dark" });
    await shot(window, "chips-en-dark");
    await window.emulateMedia({ colorScheme: "light" });

    // Pressed: the card lists the three quotes; the transcript opens at the first, all marked.
    await pointAndClick(window, chip);
    const card = window.getByTestId("citation-group-card");
    await expect(card.getByTestId("citation-badge")).toHaveText(words.found);
    await expect(card.getByTestId("citation-group-quote")).toHaveText([
      words.quotes[1],
      words.quotes[2],
      words.quotes[3],
    ]);
    await expect(stepCount(window)).toHaveText(words.step(1));
    await expect
      .poll(() => marked(window))
      .toEqual([
        [0, true],
        [1, false],
        [2, false],
      ]);
    // What a screen reader hears: one button for the chip (the hidden ones aren't in the tree),
    // the stepper by its Citation, and each step said as it happens.
    await expect(editor.getByRole("button", { name: /^Citation 2,/ })).toHaveCount(1);
    await expect(window.getByRole("toolbar", { name: "Quotes of Citation 2" })).toBeVisible();
    await expect(stepCount(window)).toHaveAttribute("aria-live", "polite");
    await expect(window.getByRole("button", { name: "Next quote" })).toBeVisible();
    await shot(window, "chips-en-pressed");

    // Next, and the keys: ⌘G and ⇧⌘G step as they step through a find's matches.
    await pointAndClick(window, window.getByTestId("quote-steps-next"));
    await expect(stepCount(window)).toHaveText(words.step(2));
    await expect
      .poll(() => marked(window))
      .toEqual([
        [0, false],
        [1, true],
        [2, false],
      ]);
    await window.keyboard.press("ControlOrMeta+g");
    await expect(stepCount(window)).toHaveText(words.step(3));
    await expect(window.getByTestId("quote-steps-next")).toBeDisabled();
    await shot(window, "chips-en-step-3");
    await window.keyboard.press("ControlOrMeta+Shift+g");
    await expect(stepCount(window)).toHaveText(words.step(2));
    await window.emulateMedia({ colorScheme: "dark" });
    await shot(window, "chips-en-step-2-dark");
    await window.emulateMedia({ colorScheme: "light" });

    // A quote pressed in the card opens the transcript at it, the stepper on it.
    await pointAndClick(window, chip);
    await pointAndClick(
      window,
      card.getByTestId("citation-group-quote").nth(2).locator("button").first(),
    );
    await expect(stepCount(window)).toHaveText(words.step(3));
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");

    // The keyboard reaches the chip once: Tab from the 1 lands on the 2, then past the sentence.
    await chips.first().focus();
    await window.keyboard.press("Escape");
    await window.keyboard.press("Tab");
    await expect(chip).toBeFocused();
    await expect(window.getByTestId("citation-group-card")).toBeVisible();
    await window.keyboard.press("Space");
    await expect(
      card.getByTestId("citation-group-quote").first().locator("button").first(),
    ).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(chip).toBeFocused();
    await window.keyboard.press("Escape");

    // The Word file writes one mark for the chip: two footnotes, two marks, no cross-reference.
    const docx = unzip(
      new Uint8Array(
        await window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const [mind] = await core.listMinds();
          if (!mind) throw new Error("There is no Note.");
          return Array.from((await core.exportMind(mind.id, { format: "docx" })).data);
        }),
      ),
    );
    const document = part(docx, "word/document.xml");
    expect(document.match(/<w:footnoteReference /g)).toHaveLength(2);
    expect(document).not.toContain("NOTEREF");

    // Backspace after the chip takes every Citation it shows, and one Undo brings them back.
    const end = await editor.evaluate((dom) => {
      const { state } = (dom as unknown as { editor: Editor }).editor;
      let last = 0;
      state.doc.descendants((node, pos) => {
        if (node.type.name === "citation") last = pos + 1;
      });
      return last;
    });
    await editor.evaluate((dom, at) => {
      (dom as unknown as { editor: Editor }).editor.chain().focus().setTextSelection(at).run();
    }, end);
    // The editor takes the focus a frame later: the key goes to it, not to the chip it left.
    await expect(editor).toBeFocused();
    await window.keyboard.press("Backspace");
    await expect(editor.getByTestId("citation")).toHaveCount(1);
    await expect(chips).toHaveText(["1"]);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor.getByTestId("citation")).toHaveCount(4);
    await expect(chips).toHaveText(["1", "2"]);
  } finally {
    await app.close();
  }
});

test("three quotes of one speaker turn side by side, in Chinese at 900 px: the card over the Note, Open brings the transcript with the stepper", async () => {
  test.setTimeout(240_000);
  const { app, window, chips, words } = await openAgentNote("zh-CN", 900);
  try {
    await expect(chips).toHaveText(["1", "2"]);
    await expect(chips.nth(1)).toHaveAccessibleName(words.label);
    await window.mouse.move(890, 880);
    await shot(window, "chips-zh-light");
    await pointAndClick(window, chips.nth(1));
    const card = window.getByTestId("citation-group-card");
    await expect(card.getByTestId("citation-badge")).toHaveText(words.found);
    await shot(window, "chips-zh-pressed");
    await pointAndClick(window, card.getByTestId("citation-open"));
    await expect(stepCount(window)).toHaveText(words.step(1));
    await pointAndClick(window, window.getByTestId("quote-steps-next"));
    await expect(stepCount(window)).toHaveText(words.step(2));
    await expect
      .poll(() => marked(window))
      .toEqual([
        [0, false],
        [1, true],
        [2, false],
      ]);
    await shot(window, "chips-zh-step-2");
    await window.emulateMedia({ colorScheme: "dark" });
    await shot(window, "chips-zh-step-2-dark");
  } finally {
    await app.close();
  }
});

/** The scroll of the transcript's pages, to tell that a step went to its quote. */
const scrolled = (viewer: Locator) => viewer.evaluate((element) => element.scrollTop);

test("three quotes far apart in one long Word section are one chip, and each step scrolls to its quote", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 1440, 900);
    const filler = (n: number) =>
      Array.from({ length: n }, (_, at) =>
        paragraph(
          `Observation ${at + 1}: the night team handed over at the bed, one patient at a time.`,
        ),
      ).join("");
    const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    const quotes = [
      "Handover at the bedside took a median of 19 minutes across the four wards.",
      "Night staff on three of the four wards kept a paper list alongside the electronic record.",
      "Fluid balance was missing from the summary screen in 41 of the 60 handovers observed.",
    ];
    const path = join(sources, "Ward review 2026.docx");
    await writeFile(
      path,
      wordFile({
        body: [
          paragraph("Findings", { style: "Heading1" }),
          ...quotes.map(
            (quote, at) =>
              `${at > 0 ? pageBreak : ""}${filler(12)}${paragraph(quote)}${filler(12)}`,
          ),
          paragraph("Advice", { style: "Heading1" }),
          paragraph("Put fluid balance on the summary screen."),
        ].join(""),
      }),
    );
    const folderId = await window.evaluate(async (file) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await bridge.createLibraryGroup({ name: "Reviews", description: "" });
      await bridge.addDocuments([file], { groupId: folder.id });
      return folder.id;
    }, path);
    await expectReadyDocuments(window, 1);
    await acceptPlainTextKeys(window);
    const launch = await window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setAgentsEnabled(true);
      return (await bridge.connectAgent({ name: "Review agent", folderIds: [id], propose: true }))
        .launch;
    }, folderId);
    const agent = new Client({ name: "test-agent", version: "1.0.0" });
    await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
    try {
      const cited = await callTool<{
        citations: { cite: string | null; location: string | null }[];
      }>(agent, "cite", { citations: quotes.map((quote) => ({ path, quote })) });
      expect(cited.citations.map((each) => each.location)).toEqual([
        "§ Findings",
        "§ Findings",
        "§ Findings",
      ]);
      await callTool(agent, "create_mind", {
        title: "Ward review",
        markdown: `Its findings give the time, the paper lists and the missing fluid balance${cited.citations.map((each) => each.cite ?? "").join("")}.`,
      });
    } finally {
      await agent.close();
    }
    await pointAndClick(
      window,
      window.getByTestId("mind-list-item").filter({ hasText: "Ward review" }),
    );
    const editor = window.getByTestId("mind-editor");
    const chips = editor.getByTestId("citation-chip").filter({ visible: true });
    await expect(chips).toHaveText(["1"]);
    await pointAndClick(window, chips.first());
    await expect(stepCount(window)).toHaveText("Quote 1 of 3");
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");
    const viewer = window.getByTestId("viewer-docx");
    const tops: number[] = [await scrolled(viewer)];
    for (const at of [2, 3]) {
      await pointAndClick(window, window.getByTestId("quote-steps-next"));
      await expect(stepCount(window)).toHaveText(`Quote ${at} of 3`);
      await expect.poll(() => scrolled(viewer)).toBeGreaterThan(tops.at(-1) ?? 0);
      tops.push(await scrolled(viewer));
      await shot(window, `chips-long-step-${at}`);
    }
  } finally {
    await app.close();
  }
});
