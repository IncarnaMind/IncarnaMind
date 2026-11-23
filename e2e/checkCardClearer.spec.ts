/**
 * The check card reads in the order a person decides in (#3715): what is wrong in the check's
 * words, the quotes grouped by what they do, what the sentence becomes, and what to press. The
 * User's own AI (a test client over its real connection) writes the Note and hands back its check
 * with report_check, giving the change and which quotes say otherwise; no model is set up.
 */
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { AgentLaunch, CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

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

type Lang = "en" | "zh-CN";

const DOCS: Record<Lang, { name: string; text: string }[]> = {
  en: [
    {
      name: "Kestrel Bay Harbour Board meeting transcript, 12 March 2026.txt",
      text: [
        "Kestrel Bay Harbour Board: meeting of 12 March 2026",
        "Mara Quinn: The new pontoon opens to the public in May, once the last pile is driven.",
        "Owen Hale: We can't promise a boat every 30 minutes. At low water the channel only lets us sail once an hour.",
        "Owen Hale: Half-hourly sailings are possible only on spring tides, and only in July and August.",
        "Mara Quinn: The pontoon takes one boat at a time until its second arm is built in 2027.",
      ].join("\n\n"),
    },
    {
      name: "Kestrel Ferries annual report 2025.txt",
      text: [
        "Kestrel Ferries: annual report 2025",
        "Kestrel Ferries carried 42,800 passengers in 2025, up 6% on 2024.",
        "The adult single fare stays at £4 through 2026.",
      ].join("\n\n"),
    },
  ],
  "zh-CN": [
    {
      name: "海湾港务委员会2026年3月12日会议记录.txt",
      text: [
        "海湾港务委员会：2026年3月12日会议",
        "林晓雯：新浮码头5月对公众开放，最后一根桩打完就开。",
        "何文海：我们没法保证每30分钟一班。低潮时航道只能一小时开一班。",
        "何文海：半小时一班只有在大潮时才行，而且只在7月和8月。",
      ].join("\n\n"),
    },
  ],
};

const TEXT = {
  en: {
    folder: "Kestrel Bay",
    title: "Kestrel Bay: harbour update",
    owner:
      "Mara Quinn confirmed the pontoon opens in May, and Owen Hale agreed the ferry will run every 30 minutes all summer.",
    figure: "Kestrel Ferries carried 48,200 passengers in 2025.",
    none: "The council has set aside £1.2 million to dredge the channel.",
    q: {
      pontoon: "The new pontoon opens to the public in May, once the last pile is driven.",
      promise: "We can't promise a boat every 30 minutes.",
      spring:
        "Half-hourly sailings are possible only on spring tides, and only in July and August.",
      carried: "Kestrel Ferries carried 42,800 passengers in 2025, up 6% on 2024.",
    },
    why: {
      owner: "Owen Hale didn’t say all summer: he said only on spring tides in July and August.",
      figure: "The annual report says 42,800 passengers in 2025, not 48,200.",
      none: "No Document in “Kestrel Bay” mentions money set aside to dredge the channel.",
    },
    change: {
      replace: "agreed the ferry will run every 30 minutes all summer",
      with: "said the ferry can run every 30 minutes only on spring tides in July and August",
    },
    changed:
      "Mara Quinn confirmed the pontoon opens in May, and Owen Hale said the ferry can run every 30 minutes only on spring tides in July and August.",
    search: {
      transcript: "pontoon ferry every 30 minutes spring tides",
      report: "passengers 2025",
    },
    labels: {
      overstated: "Needs a look · Overstated",
      otherwise: "Says otherwise",
      so: "Says so",
      change: "Suggested change",
      accept: "Accept change",
      keep: "Keep as written",
      ask: "Ask Claude Code to fix it",
      signed: "Checked by me",
      noPassage: "No passage found in “Kestrel Bay”",
      searchAll: "Search all Documents",
      showQuotes: "Show quotes",
    },
  },
  "zh-CN": {
    folder: "海湾",
    title: "海湾：港务情况汇报",
    owner: "林晓雯确认浮码头5月开放，何文海也同意整个夏天渡轮每30分钟一班。",
    figure: "",
    none: "镇议会已拨出120万元用于疏浚航道。",
    q: {
      pontoon: "新浮码头5月对公众开放，最后一根桩打完就开。",
      promise: "我们没法保证每30分钟一班。",
      spring: "半小时一班只有在大潮时才行，而且只在7月和8月。",
      carried: "",
    },
    why: {
      owner: "何文海没说整个夏天：他说只有7月和8月的大潮时才行。",
      figure: "",
      none: "“海湾”里没有文档提到为疏浚航道拨款。",
    },
    change: { replace: "也同意整个夏天", with: "说只有7月和8月的大潮时" },
    changed: "林晓雯确认浮码头5月开放，何文海说只有7月和8月的大潮时渡轮每30分钟一班。",
    search: { transcript: "浮码头 渡轮 每30分钟 大潮", report: "" },
    labels: {
      overstated: "需要留意：夸大",
      otherwise: "说法不同",
      so: "说法一致",
      change: "建议改为",
      accept: "接受修改",
      keep: "保留原句",
      ask: "交给 Claude Code 修改",
      signed: "我已核对",
      noPassage: "未在“海湾”中找到相关段落",
      searchAll: "搜索全部文档",
      showQuotes: "查看引文",
    },
  },
} as const;

async function claudeCode(launch: AgentLaunch): Promise<Client> {
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  return agent;
}

/** The test Documents in their Folder, and Claude Code connected to it. */
async function connected(window: Page, lang: Lang): Promise<AgentLaunch> {
  const paths: string[] = [];
  for (const doc of DOCS[lang]) {
    const path = join(sources, doc.name);
    await writeFile(path, `${doc.text}\n`);
    paths.push(path);
  }
  const launch = await window.evaluate(
    async ([files, folderName]) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await bridge.createLibraryGroup({ name: folderName, description: "" });
      await bridge.addDocuments(files, { groupId: folder.id });
      await bridge.setAgentsEnabled(true);
      const agent = await bridge.connectAgent({
        name: "Claude Code",
        client: "claude-code",
        folderIds: [folder.id],
        propose: true,
      });
      return agent.launch;
    },
    [paths, TEXT[lang].folder] as const,
  );
  await expectReadyDocuments(window, DOCS[lang].length);
  return launch;
}

/** Claude Code writes the Note and hands back its check: the change and the roles with it. */
async function writtenAndChecked(launch: AgentLaunch, lang: Lang): Promise<string> {
  const T = TEXT[lang];
  const agent = await claudeCode(launch);
  try {
    const cite = async (query: string, quote: string) => {
      const found = (await agent.callTool({ name: "search", arguments: { query } }))
        .structuredContent as { passages: { passageId: string }[] };
      const { citations } = (
        await agent.callTool({
          name: "cite",
          arguments: { citations: found.passages.map(({ passageId }) => ({ passageId, quote })) },
        })
      ).structuredContent as { citations: { cite: string | null }[] };
      const token = citations.find((each) => each.cite !== null)?.cite;
      if (!token) throw new Error(`No Passage holds “${quote}”.`);
      return token;
    };
    const sentences = [T.owner, T.figure, T.none].filter(Boolean);
    const made = await agent.callTool({
      name: "create_mind",
      arguments: { title: T.title, markdown: sentences.join("\n\n") },
    });
    const { mindId } = made.structuredContent as { mindId: string };
    const { task, sentences: given } = (
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } })
    ).structuredContent as { task: string; sentences: { n: number; text: string }[] };
    const n = (sentence: string) => given.find((each) => each.text === sentence)?.n;
    const pontoon = await cite(T.search.transcript, T.q.pontoon);
    const promise = await cite(T.search.transcript, T.q.promise);
    const spring = await cite(T.search.transcript, T.q.spring);
    const results: unknown[] = [
      {
        n: n(T.owner),
        verdict: "overstated",
        cites: [pontoon, promise, spring],
        otherwise: [spring, promise],
        change: T.change,
        explanation: T.why.owner,
      },
      { n: n(T.none), verdict: "not found", explanation: T.why.none },
    ];
    if (T.figure) {
      results.push({
        n: n(T.figure),
        verdict: "contradicted",
        cites: [await cite(T.search.report, T.q.carried)],
        change: { replace: "48,200", with: "42,800" },
        explanation: T.why.figure,
      });
    }
    const reported = await agent.callTool({
      name: "report_check",
      arguments: { mindId, task, results },
    });
    expect(reported.isError ?? false).toBe(false);
    return mindId;
  } finally {
    await agent.close();
  }
}

async function openNote(window: Page, mindId: string): Promise<void> {
  await pointAndClick(window, window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`));
  await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
  await motionSettled(window);
}

/** Opens the card of the sentence that starts with `start`, by a click on its mark. */
async function openCard(window: Page, start: string): Promise<Locator> {
  const card = window.getByTestId("claim-card").filter({ visible: true });
  const marks = frontMind(window).getByTestId("claim-mark");
  await expect(marks.first()).toBeVisible();
  for (let i = 0; i < (await marks.count()); i++) {
    const mark = marks.nth(i);
    if (!(await mark.isVisible())) continue;
    await pointAndClick(window, mark);
    await expect(card).toBeVisible();
    if (((await card.getAttribute("aria-label")) ?? "").includes(start)) return card;
    await window.keyboard.press("Escape");
    await expect(card).toBeHidden();
  }
  throw new Error(`No card for “${start}”.`);
}

const top = async (locator: Locator) => (await locator.boundingBox())?.y ?? Number.NaN;

for (const lang of ["en", "zh-CN"] as const) {
  // protects=the card of a sentence the User's own AI found overstated says what is wrong, groups the quotes by what they do, shows the change and Accept makes it, in English and Chinese; fails_when=the sentence is repeated, a quote that says otherwise shows under Says so, the change isn't drawn, or Accept doesn't change the Note with one Undo
  test(`an overstated sentence's card reads in the order a person decides in, and Accept makes its change (${lang})`, async () => {
    test.setTimeout(180_000);
    const T = TEXT[lang];
    const L = T.labels;
    const { app, window } = await launchApp(dataDir, { home });
    await acceptPlainTextKeys(window);
    try {
      await dismissChatSetup(window);
      await setLanguage(window, lang);
      await setWindowSize(app, window, 1440, 900);
      const mindId = await writtenAndChecked(await connected(window, lang), lang);
      await openNote(window, mindId);

      const card = await openCard(window, T.owner.slice(0, 10));
      await expect(card.getByTestId("claim-badge")).toHaveText(L.overstated);
      const problem = card.getByTestId("claim-part-reason");
      await expect(problem).toHaveText(T.why.owner);
      await expect(card.getByTestId("claim-sentence")).toHaveCount(0);

      // Says otherwise first, its first quote with a count that opens the other; then Says so.
      const groups = card.getByTestId("claim-group");
      await expect(groups).toHaveCount(2);
      await expect(groups.nth(0)).toHaveAttribute("data-role", "otherwise");
      await expect(groups.nth(0).getByTestId("claim-group-label")).toHaveText(`${L.otherwise}· 2`);
      await expect(groups.nth(0)).toContainText(T.q.spring);
      await expect(groups.nth(0)).not.toContainText(T.q.promise);
      await expect(groups.nth(1)).toHaveAttribute("data-role", "so");
      await expect(groups.nth(1).getByTestId("claim-group-label")).toHaveText(L.so);
      await expect(groups.nth(1)).toContainText(T.q.pontoon);
      await pointAndClick(window, groups.nth(0).getByTestId("claim-part-more"));
      await expect(groups.nth(0)).toContainText(T.q.promise);

      // The change, drawn as a waiting change is, then the two buttons.
      const change = card.getByTestId("claim-change");
      await expect(change).toContainText(L.change);
      await expect(change.locator("del").first()).toBeVisible();
      await expect(change.locator("ins").first()).toBeVisible();
      const buttons = card.locator(".citation-card-actions button");
      await expect(buttons).toHaveText([L.accept, L.keep]);
      expect(await top(problem)).toBeLessThan(await top(groups.nth(0)));
      expect(await top(groups.nth(1))).toBeLessThan(await top(change));
      expect(await top(change)).toBeLessThan(await top(buttons.first()));

      // Folded to one line by its label, and open again by Show quotes.
      await pointAndClick(window, groups.nth(0).getByTestId("claim-group-label"));
      const folded = card.getByTestId("claim-quotes-folded");
      await expect(folded).toContainText(L.otherwise);
      await expect(folded).toContainText(L.so);
      await expect(groups).toHaveCount(0);
      await pointAndClick(window, folded.getByTestId("claim-show-quotes"));
      await expect(groups).toHaveCount(2);
      // From the keyboard the focus stays in the card: on Show quotes, then on the first label.
      const label = groups.nth(0).getByTestId("claim-group-label");
      await label.focus();
      await window.keyboard.press("Enter");
      await expect(folded.getByTestId("claim-show-quotes")).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(label).toBeFocused();

      // Checked by me is a row of the ⋯ that ticks, and the card says it once set.
      await pointAndClick(window, card.getByTestId("check-menu"));
      const signRow = window.getByRole("menuitemcheckbox", { name: L.signed });
      await expect(signRow).toHaveAttribute("aria-checked", "false");
      await expect(window.getByRole("menuitem", { name: L.ask })).toBeVisible();
      await pointAndClick(window, signRow);
      await expect(card.getByTestId("claim-signed")).toBeVisible();

      // Accept writes the change, the sentence waits for the AI's next check; ⌘Z takes it back.
      await pointAndClick(window, buttons.first());
      await expect(card).toBeHidden();
      const editor = frontMind(window).getByTestId("mind-editor");
      await expect(editor).toContainText(T.changed);
      await expect(
        frontMind(window).locator('[data-testid="claim-mark"][data-check="needs-recheck"]'),
      ).toHaveCount(1);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(editor).toContainText(T.owner);

      // Not found: Ask first, Keep as written second, Search all Documents on its own line.
      const none = await openCard(window, T.none.slice(0, 8));
      await expect(none.getByTestId("claim-why")).toHaveText(T.why.none);
      await expect(none.getByTestId("claim-nothing")).toContainText(L.noPassage);
      await expect(none.getByTestId("claim-nothing")).toContainText(L.searchAll);
      await expect(none.locator(".citation-card-actions button")).toHaveText([L.ask, L.keep]);
      await window.keyboard.press("Escape");
    } finally {
      await app.close();
    }
  });
}

// protects=⌘↩ in a card makes its change, as Accept does a waiting change's, and a card taller than a narrow window keeps its buttons in view with its quotes scrolling; fails_when=the shortcut does nothing, or the buttons fall below the window at 900 × 600
test("⌘↩ makes the change, and at 900 × 600 the buttons stay in view", async () => {
  test.setTimeout(180_000);
  const T = TEXT.en;
  const { app, window } = await launchApp(dataDir, { home });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 900, 600);
    const mindId = await writtenAndChecked(await connected(window, "en"), "en");
    await openNote(window, mindId);

    const card = await openCard(window, T.owner.slice(0, 10));
    const accept = card.getByRole("button", { name: T.labels.accept });
    await expect(accept).toBeInViewport({ ratio: 1 });
    await expect(card.getByTestId("claim-part-reason")).toBeInViewport({ ratio: 1 });
    await window.keyboard.press("Escape");

    const figure = await openCard(window, T.figure.slice(0, 10));
    await expect(figure.getByTestId("claim-group")).toHaveAttribute("data-role", "otherwise");
    await figure.getByRole("button", { name: T.labels.keep }).focus();
    await window.keyboard.press("ControlOrMeta+Enter");
    await expect(figure).toBeHidden();
    await expect(frontMind(window).getByTestId("mind-editor")).toContainText(
      "Kestrel Ferries carried 42,800 passengers in 2025.",
    );
  } finally {
    await app.close();
  }
});
