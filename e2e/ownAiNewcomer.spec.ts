import { copyFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import type { MessageKey, MessageParams } from "../src/shared/i18n";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  catchCopies,
  createDataFolder,
  expectHomeInFront,
  frontMind,
  interceptOpenDialog,
  interceptOpenExternal,
  interceptOpenPath,
  launchApp,
  openExample,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * The newcomer walk with only the User's own AI (#763's walk, on the path every test has taken
 * since 2026-11-21): a new User with no model, key or sign-in in IncarnaMind, and a Library of 40
 * real-looking files in English and Chinese, connects Claude Code in the first run, adds the files,
 * asks their AI about one of them from IncarnaMind, gets its Note with Citations, asks for a check,
 * sees its marks and opens one Citation at its quote. Claude Code is a stand-in: an MCP client on
 * the app's own connection, and the links that would open it are recorded, not opened.
 */

const SET = join(__dirname, "../tests/fixtures/organize-fresh/files");
const DEAD = "http://127.0.0.1:9";

interface Said {
  /** The sentence as the agent writes it, without its Citation or its full stop. */
  text: string;
  /** Words of the file, word for word, that the sentence cites. */
  quote: string;
  verdict: "supported" | "contradicted";
  explanation: string;
}

interface Walk {
  file: string;
  /** What finds the file in ⌘K. */
  find: string;
  /** Words of the file the viewer shows once it is open. */
  shows: string;
  query: string;
  title: string;
  stop: string;
  said: readonly Said[];
}

const WALKS: Record<"en" | "zh-CN", Walk> = {
  en: {
    file: "f16-2026-09-18 product sync.md",
    find: "product sync",
    shows: "Beta feedback from week 2",
    query: "beta testers onboarding release target",
    title: "What the product sync decided",
    stop: ".",
    said: [
      {
        text: "31 of 40 beta testers are still active",
        quote: "31 of 40 testers are still active.",
        verdict: "supported",
        explanation: "The notes say so.",
      },
      {
        text: "38% of new users quit before creating their first project",
        quote: "38% of new users quit before creating their first project.",
        verdict: "supported",
        explanation: "The funnel Elena showed.",
      },
      {
        text: "The 0.9 release is set for Oct 1",
        quote: "Target is Oct 6.",
        verdict: "contradicted",
        explanation: "The target is Oct 6; Oct 1 is the Windows fix's deadline.",
      },
    ],
  },
  "zh-CN": {
    file: "f35-周会记录.md",
    find: "周会记录",
    shows: "国庆活动复盘",
    query: "国庆 销售额 注册 投放 ROI",
    title: "周会要点",
    stop: "。",
    said: [
      {
        text: "国庆活动期间销售额 86 万，完成目标的 108%",
        quote: "活动期间销售额 86 万，完成目标的 108%",
        verdict: "supported",
        explanation: "周会记录这样写。",
      },
      {
        text: "小程序 2.3 版本上线当天新增注册 412 人",
        quote: "小程序 2.3 版本已于周三上线，当天新增注册 412 人，高于预期（预期 300）",
        verdict: "supported",
        explanation: "上周事项回顾里写的。",
      },
      {
        text: "投放 ROI 达到了计划的 1:3",
        quote: "投放 ROI 为 1:2.7，低于计划的 1:3",
        verdict: "contradicted",
        explanation: "实际是 1:2.7，低于计划。",
      },
    ],
  },
};

/** Words a newcomer must never meet (the glossary's left column, as #763's walk holds them). */
const JARGON = {
  en: /\bIndex(?:ing|ed)?\b|\bembeddings?\b|\bre-?rank(?:ing|ed)?\b|chat model|\bmodel ID\b|\bMCP\b|\bstdio\b|OAuth client|\bOCR\b|\bRevoke\b|\bproviders?\b|local mode|\bPassages?\b/,
  "zh-CN":
    /段落|\b索引\b|嵌入|向量|重排|聊天模型|对话模型|模型 ID|\bMCP\b|\bstdio\b|OAuth|OCR|撤销授权|提供商|服务商|本地模式/i,
};

let dataDir: string;
let home: string;
let sources: string;
let app: ElectronApplication | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  sources = await realpath(await createDataFolder());
  // Claude Code keeps its settings here, so the first run finds it on this computer.
  await writeFile(join(home, ".claude.json"), "{}\n");
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(sources);
});

const bridge = (window: Page) => ({
  documents: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    ),
  launchOf: async () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [pairing] = (await core.getAgents()).pairings;
      if (!pairing) throw new Error("No agent is connected.");
      return core.getAgentLaunch(pairing.id);
    }),
});

/** Claude Code, the stand-in: a client started as Claude Code starts IncarnaMind's server. */
async function claudeCode(window: Page): Promise<Client> {
  const launch = await bridge(window).launchOf();
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  return agent;
}

const structured = <T>(result: unknown): T => {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
};

/** What each link opening Claude Code would have typed there. */
async function typedInClaudeCode(): Promise<string[]> {
  const links = await urlsOpened(app as ElectronApplication);
  return links
    .filter((link) => link.startsWith("claude-cli://"))
    .map((link) => new URL(link).searchParams.get("q") ?? "");
}

/** What the window says, its Note, sidebar, setup and Get started included. */
async function shown(window: Page): Promise<string> {
  return (await window.locator("body").innerText()).trim();
}

/** No refusal without a way on, and no word the glossary leaves out, on the screen now. */
async function plainAndWithAWayOn(window: Page, language: "en" | "zh-CN", where: string) {
  const text = await shown(window);
  expect(text, `${where}, ${language}: ${text}`).not.toMatch(JARGON[language]);
  for (const line of await window.locator('[role="alert"]').all()) {
    if (!(await line.isVisible())) continue;
    await expect(line.locator("button, a"), `${where}: ${await line.innerText()}`).not.toHaveCount(
      0,
    );
  }
}

for (const language of ["en", "zh-CN"] as const) {
  // protects=a new User with only their own AI and no model goes from the first run to a checked Note of their AI's and a Citation opened at its quote, each step saying what happens, with no model asked for and no jargon; fails_when=a step asks for a model or key, the assistant panel shows, the agent's Note doesn't come up with its Citations, the check's marks don't land, or the Citation opens anywhere but its quote
  test(`a new User with only their own AI walks from the first run to a checked Note and a Citation at its quote (${language})`, async () => {
    test.setTimeout(480_000);
    const walk = WALKS[language];
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    const files = (await readdir(SET)).sort();
    for (const name of files) await copyFile(join(SET, name), join(sources, name));
    const paths = files.map((name) => join(sources, name));

    const launched = await launchApp(dataDir, {
      firstRunSetup: true,
      home,
      ollama: DEAD,
      decisions: DEAD,
    });
    app = launched.app;
    const { window } = launched;
    await interceptOpenPath(app);
    await interceptOpenExternal(app);
    await setWindowSize(app, window, 1440, 900);
    // A runner has no keyring; the User's computer usually has one.
    await acceptPlainTextKeys(window);
    await catchCopies(window);
    await setLanguage(window, language);
    const panel = window.getByTestId("setup-panel");
    const atStep = async (step: string) => {
      await expect(panel).toHaveAttribute("data-step", step);
      return panel;
    };
    const assistant = window.getByTestId("assistant");

    // 1. The first run: the User's own AI comes first, and it connects inside the step.
    await pointAndClick(window, (await atStep("work")).getByTestId("setup-skip"));
    const ai = await atStep("ai");
    const found = ai.locator('[data-testid="setup-agent"][data-value="claude-code"]');
    await expect(found).toContainText(t("setupPage.agent.found"));
    await plainAndWithAWayOn(window, language, "the Your AI step");
    await found.locator("input").press("Space");
    await pointAndClick(
      window,
      ai.getByTestId("setup-agent-connect").getByTestId("setup-agent-allow"),
    );
    await expect(ai.getByTestId("setup-agent-connected")).toHaveText(
      t("setupPage.agent.connected", { agent: "Claude Code" }),
    );
    await pointAndClick(window, ai.getByTestId("setup-next"));
    await pointAndClick(window, (await atStep("meetings")).getByTestId("setup-skip"));
    await expect(panel).toHaveCount(0);
    await expectHomeInFront(window);
    await openExample(window);

    // 2. Get started: the User adds their files with its own press; every one of the 40 is read.
    const card = window.getByTestId("first-open-steps");
    const step = (name: string) =>
      card.locator(`[data-testid="first-open-step"][data-step="${name}"]`);
    await expect(step("files")).toHaveAttribute("data-state", "open");
    await expect(assistant).toBeHidden();
    await plainAndWithAWayOn(window, language, "Get started");
    await interceptOpenDialog(app, paths);
    await pointAndClick(window, step("files").getByTestId("first-open-add-files"));
    await expect(step("files")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    // The example's own Documents are there too, apart from the User's; each of the User's 40 is
    // read, a scan with no text in it as such.
    const stems = new Set(files.map((name) => name.replace(/\.[^.]+$/, "")));
    await expect
      .poll(
        async () => {
          const theirs = (await bridge(window).documents()).filter((each) => stems.has(each.name));
          return theirs.length === files.length &&
            theirs.every((each) => ["ready", "no-text"].includes(each.status))
            ? theirs.filter((each) => each.status === "ready").length
            : null;
        },
        { timeout: 240_000, intervals: [2_000] },
      )
      .toBeGreaterThan(files.length - 6);
    await expect(step("agentAsk")).toHaveAttribute("data-state", "open");

    // 3. The User opens one file from ⌘K and asks their AI about it from its foot.
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type(walk.find);
    await pointAndClick(
      window,
      window.getByTestId("palette-item").filter({ hasText: walk.find }).first(),
    );
    const viewer = window.getByTestId("viewer");
    await expect(viewer).toContainText(walk.shows);
    await expect(assistant).toBeHidden();
    const pill = window.getByTestId("own-ai-pill-ask");
    await expect(pill).toContainText(t("agents.ask.pill", { agent: "Claude Code" }));
    await pointAndClick(window, pill);
    await expect.poll(typedInClaudeCode).toHaveLength(1);
    const [asked = ""] = await typedInClaudeCode();
    expect(asked).toContain(walk.find);
    await expect(window.getByTestId("copied-line")).toHaveText(
      t("agents.ask.opened", { agent: "Claude Code" }),
    );
    await plainAndWithAWayOn(window, language, "the file open, asked");

    const agent = await claudeCode(window);
    try {
      // 4. Claude Code reads the request, cites the file and writes its Note, which comes up in
      // front with a chip for each Citation.
      const request = structured<{ mindId: string | null; title: string; request: string }>(
        await agent.callTool({ name: "read_request", arguments: {} }),
      );
      expect(request.mindId).toBeNull();
      const [document] = (await bridge(window).documents()).filter((each) =>
        each.name.includes(walk.find),
      );
      if (!document) throw new Error(`No Document named like “${walk.find}”.`);
      expect(request.request).toContain(document.id);
      const { passages } = structured<{ passages: { passageId: string; documentId: string }[] }>(
        await agent.callTool({ name: "search", arguments: { query: walk.query } }),
      );
      const own = passages.filter((each) => each.documentId === document.id);
      expect(own.length).toBeGreaterThan(0);
      const cites: string[] = [];
      for (const said of walk.said) {
        const { citations } = structured<{ citations: { cite: string | null }[] }>(
          await agent.callTool({
            name: "cite",
            arguments: {
              citations: own.map(({ passageId }) => ({ passageId, quote: said.quote })),
            },
          }),
        );
        const cite = citations.find((each) => each.cite !== null)?.cite;
        if (!cite) throw new Error(`No Passage of ${walk.file} holds “${said.quote}”.`);
        cites.push(cite);
      }
      const markdown = walk.said
        .map((said, at) => `${said.text} ${cites[at]}${walk.stop}`)
        .join("\n\n");
      const { mindId } = structured<{ mindId: string }>(
        await agent.callTool({ name: "create_mind", arguments: { title: walk.title, markdown } }),
      );
      const note = frontMind(window);
      await expect(note).toHaveAttribute("data-mind-id", mindId);
      await expect(note.getByTestId("mind-editor")).toContainText(walk.said[0]?.text ?? "");
      await expect(note.getByTestId("citation-chip")).toHaveCount(walk.said.length);
      await expect(assistant).toBeHidden();
      await plainAndWithAWayOn(window, language, "the agent's Note");

      // 5. The User asks for a check with one press: Claude Code is asked, the Note says so until
      // the marks land, and each sentence gets the mark its check gave.
      if (!(await window.getByTestId("check-card").isVisible())) {
        await pointAndClick(window, window.getByTestId("check-badge-open"));
      }
      await pointAndClick(window, window.getByTestId("badge-check-mind"));
      await expect
        .poll(typedInClaudeCode)
        .toEqual([asked, t("agents.ask.line.check", { title: `“${walk.title}”` })]);
      const badge = window.getByTestId("badge-asked");
      await expect(badge).toHaveText(t("agents.asked.short.asked"));
      const given = structured<{ task: string; sentences: { n: number; text: string }[] }>(
        await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
      );
      await expect(badge).toHaveText(t("agents.asked.short.working"));
      const results = given.sentences.map((sentence) => {
        const at = walk.said.findIndex((said) => sentence.text.startsWith(said.text));
        const said = walk.said[at];
        return said
          ? {
              n: sentence.n,
              verdict: said.verdict,
              cites: [cites[at]],
              explanation: said.explanation,
            }
          : { n: sentence.n, verdict: "nothing to check" };
      });
      expect(results.filter((each) => "cites" in each)).toHaveLength(walk.said.length);
      structured(
        await agent.callTool({
          name: "report_check",
          arguments: { mindId, task: given.task, results },
        }),
      );
      await expect(badge).toHaveCount(0);
      const marks = note.getByTestId("claim-mark");
      await expect(marks).toHaveCount(walk.said.length);
      await expect
        .poll(async () => marks.evaluateAll((all) => all.map((each) => each.dataset.check)))
        .toEqual(walk.said.map((said) => said.verdict));
      await plainAndWithAWayOn(window, language, "the checked Note");

      // 6. One Citation opens the file at its quote.
      const first = walk.said[0];
      if (!first) throw new Error("The walk says nothing.");
      await window.mouse.move(0, 0);
      await pointAt(window, note.getByTestId("citation-chip").first());
      const citation = window.getByTestId("citation-card");
      await expect(citation).toBeVisible();
      await pointAndClick(window, citation.getByTestId("citation-open"));
      await expect(viewer.locator("[data-quote-highlight]").first()).toBeVisible();
      await expect(viewer.locator("[data-quote-highlight]")).toContainText([first.quote]);
      await expect(assistant).toBeHidden();
      await plainAndWithAWayOn(window, language, "the Citation opened");
    } finally {
      await agent.close();
    }
  });
}
