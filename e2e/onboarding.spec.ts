import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  exampleRow,
  examplesMenu,
  expectHomeInFront,
  expectReadyDocuments,
  frontMind,
  gettingStarted,
  launchApp,
  leaveFirstOpen,
  leaveText,
  linkedFolderRow,
  newMind,
  openExample,
  paletteFound,
  removeDataFolder,
  useCloudChatModel as saveCloudChatModel,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

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

/**
 * Moves the mouse onto an element as a person does, in steps, checks that it
 * is what is under the pointer there (nothing covers it), and clicks.
 * `atX`: that far into it from its left edge, instead of its middle;
 * `through`: it lets the pointer through to what is under it, which is clicked.
 */
async function pointAndClick(
  window: Page,
  target: Locator,
  { atX, through = false }: { atX?: number; through?: boolean } = {},
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  const x = box.x + (atX ?? box.width / 2);
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y, { steps: 8 });
  const hit = await target.evaluate(
    (element, [px, py]) => {
      const under = document.elementFromPoint(px as number, py as number);
      return under !== null && (under === element || element.contains(under));
    },
    [x, y],
  );
  expect(hit).toBe(!through);
  await window.mouse.click(x, y);
}

/** Words a newcomer shouldn't meet on the first screens: the left column of #763's glossary. */
const JARGON = [
  /\bindex(?:es|ed|ing)?\b/i,
  /\bPassages?\b/,
  /\bMCP\b/,
  /\bchat model/i,
  /\bembedding/i,
  /\brerank/i,
  /\bproviders?\b/i,
  /\blocal mode\b/i,
  /\bOCR\b/,
  /\btokens?\b/i,
  /\bstdio\b/,
  /\bendpoint/i,
  /\bOAuth\b/,
  /\b(?:claude|gpt|qwen|llama|gemini|deepseek)[\w.]*[-:][\w.:-]+/i,
  /索引|嵌入|重排序|重新排序|对话模型|提供商|本地模式/,
];

/** Each region's text, as shown, has none of the glossary's words. */
async function expectPlainWords(regions: Locator[]): Promise<void> {
  for (const region of regions) {
    const text = await region.innerText();
    for (const word of JARGON) expect(text, `${word} on the first screens`).not.toMatch(word);
  }
}

test("a first run's example, opened from its row, is the credit paper with no model set up: its Citations are found and open the PDF at the quote, and its wrong figure's card says what the results say", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await openExample(window);
  await setWindowSize(app, window, 1440, 900);

  const pane = window.getByTestId("mind-pane");
  await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
    "Draft: credit committee paper",
  );
  // One line above the foot says it is an example, with its one wrong figure (#3791).
  await expect(window.getByTestId("example-line")).toContainText(
    "An example with one figure that doesn’t match its source.",
  );
  await expect(exampleRow(window)).toHaveCount(1);
  await expect(exampleRow(window).getByTestId("example-chip")).toHaveCount(0);
  await expectReadyDocuments(window, 2);
  // No model needed: no setup over it, and no "set up a chat model" notice in it.
  await expect(window.getByTestId("chat-setup")).toBeHidden();
  await expect(pane.getByTestId("chat-readiness")).toHaveCount(0);

  const answer = pane.getByTestId("answer");
  await expect(answer.getByTestId("answer-example")).toHaveText("Example Answer · no model needed");
  // Both Citations are checked against the Documents' text: the quotes are found.
  const checks = pane.getByTestId("mind-editor").getByTestId("citation-chip");
  await expect(checks).toHaveCount(2);
  await expect(checks.nth(0)).toHaveAttribute("data-check", "found", { timeout: 20_000 });
  await expect(checks.nth(1)).toHaveAttribute("data-check", "found", { timeout: 20_000 });
  // The draft's wrong figure is already checked: contradicted.
  const mark = pane.getByTestId("claim-mark");
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute("data-check", "contradicted");

  // The example's red ≠: its card says what the results say, and quotes them where they say it.
  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "contradicted");
  await expect(card.getByTestId("claim-says")).toHaveText(
    "The Q3 results say gross margin was 38.6%, not 36.8%.",
  );
  await expect(card.getByTestId("claim-where")).toHaveText(
    "Northwind Retail · Q3 2026 results · p. 1",
  );
  await expect(card.getByTestId("claim-quote")).toHaveText(
    "Group gross margin was 38.6%, down from 40.3% a year earlier, with online the main drag.",
  );
  await window.keyboard.press("Escape");

  // A Citation opens the results at the page it quotes, the quote highlighted.
  await pointAndClick(window, checks.nth(0));
  await expect(window.getByTestId("citation-card")).toBeVisible();
  await expect(window.getByTestId("viewer-title")).toHaveText("Northwind Retail · Q3 2026 results");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("1");
  const highlight = window
    .getByTestId("viewer")
    .locator('[data-page-number="1"] [data-quote-highlight]');
  await expect(highlight.first()).toBeInViewport();
  await expect
    .poll(async () => (await highlight.allTextContents()).join(""))
    .toContain("Net debt to EBITDA was 3.1 times");
  await window.keyboard.press("Escape");

  // The Document in front has its row, under the example's Note, on the first open. Its row is the
  // selected one once the User is in its pane, as for every open item (#1098).
  const sidebar = window.getByTestId("sidebar");
  const examples = sidebar.getByTestId("not-in-a-folder-section");
  await expect(examples.getByTestId("not-in-a-folder-title")).toHaveText("Examples");
  await expect(examples.getByTestId("document-list-item")).toHaveCount(2);
  await pointAndClick(window, window.getByTestId("viewer"));
  const selected = examples.getByRole("treeitem", { selected: true });
  await expect(selected).toHaveCount(1);
  await expect(selected.getByTestId("row-text")).toHaveText("Northwind Retail · Q3 2026 results");

  // The example's line offers the User's own files, in place.
  const addOwn = window.getByTestId("example-line").getByTestId("example-add-own");
  await expect(addOwn).toHaveText("Add your own files");
  await pointAndClick(window, addOwn);
  const ways = window.getByTestId("example-add-items");
  await expect(ways.getByRole("menuitem")).toHaveText(["Add files…", "Link a folder…"]);
  await expect(ways.getByRole("menuitem").first()).toBeFocused();
  await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
    "Draft: credit committee paper",
  );
  await expect(window.getByTestId("chat-setup")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(addOwn).toBeFocused();
  await setLanguage(window, "zh-CN");
  await expect(addOwn).toHaveText("添加你自己的文件");
  await pointAndClick(window, addOwn);
  await expect(ways.getByRole("menuitem")).toHaveText(["添加文件…", "添加关联文件夹…"]);
  await window.keyboard.press("Escape");

  await setLanguage(window, "en");
  await expect(window.getByTestId("document-list-item")).toHaveText([
    /Northwind Retail · (Q3 2026 results|Senior facilities agreement \(excerpt\))/,
    /Northwind Retail · (Q3 2026 results|Senior facilities agreement \(excerpt\))/,
  ]);
  // The example’s Linked folder is no Linked folder of the User’s, and never a Folder (#1942,
  // #3613).
  await expect(window.locator("[data-linked-folder-id]")).toHaveCount(0);
});

test("removing the examples deletes the example Mind, its Documents and the copies of their files, and they aren't made again", async () => {
  const first = await launchApp(dataDir, { examples: true });
  await openExample(first.window);
  const window = first.window;
  await leaveFirstOpen(window);

  await pointAndClick(window, (await examplesMenu(window)).getByTestId("examples-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await expect(window.getByTestId("document-list-item")).toHaveCount(0);
  await expect(linkedFolderRow(window, "Examples")).toHaveCount(0);
  await expectHomeInFront(window);
  // Moving on from the example: the empty Home says asking needs the User's AI (#3767).
  await expect(window.getByTestId("home-ask-no-ai")).toBeVisible();
  await expect
    .poll(() =>
      access(join(dataDir, "Examples")).then(
        () => "there",
        () => "gone",
      ),
    )
    .toBe("gone");
  await first.app.close();

  const again = await launchApp(dataDir, { examples: true });
  await expect(again.window.getByTestId("home")).toBeVisible();
  await expect(again.window.getByTestId("mind-list-item")).toHaveCount(0);
  await again.window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.createExamples();
  });
  await expect(again.window.getByTestId("mind-list-item")).toHaveCount(1);
  await again.app.close();
});

test("with no model and no AI connected, the footer never asks for a model to tag, even once a Document of the User's own carries a Tag (#1942, #3767)", async () => {
  const own = join(sources, "Harbour notes.md");
  await writeFile(own, "# Harbour notes\n\nThe harbour master publishes the tide tables.\n");
  const { app, window } = await launchApp(dataDir, { examples: true });
  await openExample(window);
  await leaveFirstOpen(window);
  const items = window.getByTestId("document-list-item");
  const notice = window.getByTestId("sidebar-footer").getByTestId("tagging-waiting");

  // The examples are ready and their tagging waits for a model, but they need none: no notice.
  await expect(items).toHaveCount(2);
  for (const item of await items.all()) {
    await expect(item).toHaveAttribute("data-tagging", "waiting-for-provider", {
      timeout: 30_000,
    });
  }
  await expect(notice).toHaveCount(0);

  // A Document of one's own with no model, and no Tag anywhere: nothing names Tags yet.
  await window.getByTestId("add-documents-input").setInputFiles([own]);
  const added = items.filter({ hasText: "Harbour notes" });
  await expect(added).toHaveAttribute("data-tagging", "waiting-for-provider");
  await expect(notice).toHaveCount(0);

  // A Tag of the User's own: the notice comes.
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [document] = (await bridge.listDocuments()).filter(
      (each) => each.name === "Harbour notes",
    );
    const tag = await bridge.createTag({ name: "Harbour", description: "" });
    if (document) await bridge.addTagToDocuments([document.id], tag.id);
  });
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const tags = await bridge.listTags();
        return tags.some((each) => each.name === "Harbour");
      }),
    )
    .toBe(true);
  // Choosing a model to tag can't be done here any more, so nothing asks for one (#3767).
  const footer = window.getByTestId("sidebar-footer");
  await expect(footer).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(footer).not.toContainText("Tags need an AI model");
  await setLanguage(window, "zh-CN");
  await expect(footer).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(footer).not.toContainText("打标签需要 AI 模型");
  await app.close();
});

test("an empty Mind of one's own shows no start guide once the example was seen, and its own Question counts as one asked", async () => {
  await writeFile(
    join(sources, "Harbour notes.md"),
    "# Harbour notes\n\nThe harbour master publishes the tide tables every January.\n",
  );
  const { window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(window);
  await expect(window.getByTestId("example-line")).toBeVisible();

  await newMind(window);
  await dismissChatSetup(window);
  // The example has been seen: an empty note of one's own shows no second guide (#1940).
  const editor = frontMind(window).getByTestId("mind-editor");
  await expect(window.getByTestId("start-guide")).toHaveCount(0);
  await expect(editor).not.toContainText("Start in three steps");
  await expect(editor).not.toContainText("Connect an app…");

  await window
    .getByTestId("add-documents-input")
    .setInputFiles([join(sources, "Harbour notes.md")]);
  await expect.poll(() => gettingStarted(window)).toMatchObject({ indexed: true });

  await useLocalChatModel(window);
  const hint = window.getByTestId("end-hint");
  await expect(hint).toHaveAttribute("data-place", "empty");
  await pointAndClick(window, window.getByTestId("mind-editor").locator("p").first());
  await expect(hint).toHaveAttribute("data-armed", "true");
  await pointAndClick(window, hint.getByTestId("end-hint-ask"));
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("When are the tide tables published?");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("assistant-question")).toContainText(
    "When are the tide tables published?",
  );
  await expect(assistantAnswers(window)).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await expect.poll(() => gettingStarted(window)).toMatchObject({ askedOwn: true });
  await expect(window.getByTestId("mind-editor").getByTestId("question")).toHaveCount(0);
  await expect(window.getByTestId("start-guide")).toHaveCount(0);
});

test("the first screens and the example's line speak plainly, and an empty note of one's own shows no start guide, in English and Chinese (#766)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await openExample(window);
  await setWindowSize(app, window, 1440, 900);
  const pane = window.getByTestId("mind-pane");
  const checks = pane.getByTestId("mind-editor").getByTestId("citation-chip");
  await expect(checks.nth(0)).toHaveAttribute("data-check", "found", { timeout: 20_000 });
  // With no model and no AI connected there is no assistant: the example's foot says how to ask (#3767).
  await expect(window.getByTestId("assistant")).toBeHidden();
  const firstScreen = [
    window.getByTestId("sidebar"),
    window.getByTestId("example-line"),
    window.getByTestId("note-ask-no-ai"),
  ];
  await expectPlainWords(firstScreen);
  await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
    "Draft: credit committee paper",
  );
  await expect(window.getByTestId("chat-setup")).toBeHidden();

  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, 760);
  await expect(window.getByTestId("example-add-own")).toHaveText("添加你自己的文件");
  await expectPlainWords(firstScreen);
  await newMind(window);
  await dismissChatSetup(window);
  // The example has been seen: an empty note of one's own shows no guide (#1940).
  await expect(window.getByTestId("start-guide")).toHaveCount(0);
  await setLanguage(window, "en");
  await expectPlainWords([window.getByTestId("sidebar")]);
});

test("Remove the examples or a deleted example ends the first open, after a restart too (#123)", async () => {
  // With no model and no AI connected, the shell has no assistant: one line says how to ask (#3767).
  const shellIsBack = async (window: Page) => {
    await expect(
      window
        .locator(
          '[data-testid="home-ask-no-ai"], [data-testid="home-foot-no-ai"], [data-testid="note-ask-no-ai"]',
        )
        .first(),
    ).toBeVisible();
    await expect(window.getByTestId("assistant")).toBeHidden();
    await expect(window.getByTestId("ask-pill")).toHaveCount(0);
    await expect(window.getByTestId("sidebar").getByTestId("sidebar-status")).toHaveCount(1);
  };
  const removing = await createDataFolder();
  const second = await launchApp(removing, { examples: true });
  await pointAndClick(
    second.window,
    (await examplesMenu(second.window)).getByTestId("examples-remove"),
  );
  await expect(second.window.getByTestId("mind-list-item")).toHaveCount(0);
  await dismissChatSetup(second.window);
  await shellIsBack(second.window);
  await second.app.close();
  const afterRemoving = await launchApp(removing, { examples: true });
  await dismissChatSetup(afterRemoving.window);
  await shellIsBack(afterRemoving.window);
  await afterRemoving.app.close();
  await removeDataFolder(removing);

  const deleting = await createDataFolder();
  const third = await launchApp(deleting, { examples: true });
  await openExample(third.window);
  await expect(third.window.getByTestId("example-line")).toBeVisible();
  await third.window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { mindId } = await bridge.getExamples();
    if (mindId) await bridge.deleteMind(mindId);
  });
  await third.app.close();
  const afterDeleting = await launchApp(deleting, { examples: true });
  await dismissChatSetup(afterDeleting.window);
  await shellIsBack(afterDeleting.window);
  await afterDeleting.app.close();
  await removeDataFolder(deleting);
});

test("with a model set up, a first checked Citation from the User's own file takes four steps (#3767)", async () => {
  const notes = join(sources, "Harbour notes.md");
  await writeFile(
    notes,
    "# Harbour notes\n\nThe harbour master publishes the tide tables every Monday morning.\n",
  );
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  try {
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    // A model is no longer set up in the interface (#3767): the profile has one, as one from before it.
    await saveCloudChatModel(window, { cap: false });
    await expectHomeInFront(window);
    const taken: string[] = [];
    const step = async (name: string, action: () => Promise<unknown>) => {
      taken.push(name);
      await action();
    };

    await step("drop the file", () =>
      window.getByTestId("add-documents-input").setInputFiles([notes]),
    );
    await expect(
      window.locator('[data-testid="document-list-item"][data-status="ready"]').filter({
        hasText: "Harbour notes",
      }),
    ).toHaveCount(1);
    // ⇧⌘O opens the assistant, which asks the model set up in IncarnaMind.
    await step("⇧⌘O", () => window.keyboard.press("Shift+ControlOrMeta+o"));
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await step("type the Question", () =>
      window.keyboard.type("When does the harbour master publish the tide tables?"),
    );
    await step("Enter", () => window.keyboard.press("Enter"));

    const citation = assistantAnswers(window).last().getByTestId("citation").first();
    await expect(citation).toHaveAttribute("data-check", "found", { timeout: 20_000 });
    await expect(citation.getByTestId("citation-chip")).toHaveAttribute(
      "aria-label",
      /Harbour notes/,
    );
    expect(taken).toHaveLength(4);
  } finally {
    await app.close();
  }
});

test("on the quiet first open the question before the first Document goes still shows, with Allow, in the footer (#1027, #3353)", async () => {
  const invoice = join(sources, "Invoice 41.txt");
  await writeFile(invoice, "Invoice 41. Amount due: 120 EUR.\n");
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" });
  });
  await expect(window.getByTestId("assistant")).toBeHidden();
  await window.getByTestId("add-documents-input").setInputFiles([invoice]);
  const item = window.getByTestId("document-list-item").filter({ hasText: "Invoice 41" });
  await expect(item).toHaveAttribute("data-tagging", "off");
  const question = window.getByTestId("sidebar").getByTestId("sort-consent");
  await expect(question).toContainText("1 to tag");
  await question.getByTestId("sort-consent-allow").click();
  await expect(item).toHaveAttribute("data-tagging", "tagged", { timeout: 15_000 });
  await app.close();
});

test("scrolled to the end, the example's last line sits above the Ask pill, and the page fades out above it (#1027)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(window);
  // The Ask pill asks IncarnaMind's own model, so it floats where one is set up (#3791).
  await useLocalChatModel(window);
  const pill = window.getByTestId("ask-pill");
  const fade = window.getByTestId("ask-pill-fade");
  for (const [width, height] of [
    [1440, 900],
    [1100, 760],
  ] as const) {
    await setWindowSize(app, window, width, height);
    await expect(pill).toBeVisible();
    await window
      .getByTestId("mind-pane")
      .evaluate((pane) => pane.parentElement?.scrollTo({ top: pane.parentElement.scrollHeight }));
    const lastLine = window.getByTestId("mind-editor").locator(":scope > *").last();
    await expect
      .poll(async () => {
        const line = await lastLine.boundingBox();
        const ask = await pill.boundingBox();
        return line && ask ? ask.y - (line.y + line.height) : null;
      })
      .toBeGreaterThanOrEqual(0);
    const ask = await pill.boundingBox();
    const faded = await fade.boundingBox();
    expect(ask && faded && faded.y <= ask.y - 56 + 1).toBe(true);
  }
  await app.close();
});

test("the example has no hint at its end, and Add to note asks which note instead of filling the example (#1940, #3791)", async () => {
  const { window } = await launchApp(dataDir, { examples: true, fakeChat: true });
  await openExample(window);
  const editor = window.getByTestId("mind-editor");
  // The example is asked at its foot, as a Note of one's own is: no line at its end says ⌘J.
  await expect(window.getByTestId("example-line")).toBeVisible();
  await expect(window.getByTestId("end-hint")).toHaveCount(0);
  await expect(editor.getByTestId("question")).toHaveCount(1);

  // A Question asked in the assistant beside it is answered there, the example left as it was.
  await useLocalChatModel(window);
  await editor.click();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("What was the online gross margin in Q3?");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(editor.getByTestId("question")).toHaveCount(1);
  await expect(editor.locator('[data-origin="conversation"]')).toHaveCount(0);
  // The example is never a target of Add to note (#1940): it asks which note, and nothing goes in.
  await expect(answer.getByTestId("answer-add-label")).toHaveText("Add to note");
  await pointAndClick(window, answer.getByTestId("answer-add"));
  await expect(window.getByTestId("add-to-picker")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("add-to-picker")).toHaveCount(0);
  await expect(editor.locator('[data-origin="conversation"]')).toHaveCount(0);
  await expect(editor.getByTestId("question")).toHaveCount(1);
});

test("the Examples row's ⋯ offers the other examples in an order picked once per install; each opens in a new tab and is made once (#123)", async () => {
  const first = await launchApp(dataDir, { examples: true });
  await openExample(first.window);
  const { app, window } = first;
  await setWindowSize(app, window, 1100, 720);
  await expect(window.getByTestId("example-line")).toBeVisible();

  const groupsShown = async () =>
    (await examplesMenu(window))
      .getByTestId("example-more-link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("data-group")));
  const choose = async (group: string) => {
    const menu = await examplesMenu(window);
    await pointAndClick(window, menu.locator(`[data-group="${group}"]`));
    await expect(menu).toBeHidden();
  };
  const tabs = window.getByTestId("mind-tab").getByTestId("tab-title");
  await expect(tabs).toHaveCount(1);
  const order = await groupsShown();
  expect([...order].sort()).toEqual(["contracts", "meetings", "papers", "reports"]);
  await window.keyboard.press("Escape");

  // Contracts opens beside the first example, which stays in its own tab.
  await choose("contracts");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first()).toHaveText("Draft: credit committee paper");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  expect(await groupsShown()).toEqual(order);
  await window.keyboard.press("Escape");

  // From the first example again, Contracts shows the one made, not a second.
  await pointAndClick(window, tabs.first());
  await choose("contracts");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await expect(tabs).toHaveCount(2);
  await app.close();

  // The same order after a restart.
  const again = await launchApp(dataDir, { examples: true });
  const credit = again.window.getByTestId("mind-tab").getByTestId("tab-title").first();
  await expect(credit).toHaveText("Draft: credit committee paper");
  const menu = await examplesMenu(again.window);
  expect(
    await menu
      .getByTestId("example-more-link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("data-group"))),
  ).toEqual(order);
  await again.app.close();
});

test("Remove the examples removes every example Mind made, and Undo brings them back (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await openExample(window);
  const menu = await examplesMenu(window);
  await pointAndClick(window, menu.locator('[data-group="papers"]'));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);

  await pointAndClick(window, (await examplesMenu(window)).getByTestId("examples-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await dismissChatSetup(window);
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await app.close();
});

test("Undo after Remove the examples brings back the same Minds and Documents, and leaves nothing of them in Recently deleted (#1292)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await openExample(window);
  const menu = await examplesMenu(window);
  await pointAndClick(window, menu.locator('[data-group="papers"]'));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await expectReadyDocuments(window, 5);

  const held = () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [minds, linkedFolders, documents, deleted] = await Promise.all([
        core.listMinds(),
        core.listLinkedFolders(),
        core.listDocuments(),
        core.listDeleted(),
      ]);
      return {
        minds: minds.map((each) => each.id).sort(),
        linkedFolders: linkedFolders.map((each) => each.id).sort(),
        documents: documents.map((each) => each.id).sort(),
        deleted: deleted.map((each) => `${each.kind}:${each.id}`),
      };
    });
  const before = await held();
  expect(before.minds).toHaveLength(2);
  expect(before.documents).toHaveLength(5);

  await pointAndClick(window, (await examplesMenu(window)).getByTestId("examples-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  // What Undo has to take back: the Minds wait in Recently deleted, until it does.
  expect((await held()).deleted).toHaveLength(2);

  await dismissChatSetup(window);
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  // Settled first: an embedding or a scan still running after Undo could change what is held.
  await expectReadyDocuments(window, 5);
  await expect.poll(held).toEqual({ ...before, deleted: [] });
  const back = await held();
  expect(back.minds).toHaveLength(before.minds.length);
  expect(back.linkedFolders).toHaveLength(before.linkedFolders.length);
  expect(back.documents).toHaveLength(before.documents.length);
  expect(back.deleted).toEqual([]);
  await app.close();
});

const paletteItems = paletteFound;

async function askPalette(window: Page, text: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(text);
}

const helpItem = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const found = Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((each) => each.id === "examples.show");
    return found ? { label: found.label, visible: found.visible } : null;
  });

test("the Examples row's ⋯ removes the examples with Undo, and the commands show only in the right state (#123)", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await openExample(window);
  await expect(window.getByTestId("example-line")).toBeVisible();

  await askPalette(window, "the examples");
  await expect(paletteItems(window)).toHaveText([/Remove the examples/]);
  await window.keyboard.press("Escape");
  await expect.poll(() => helpItem(app)).toMatchObject({ visible: false });

  await pointAndClick(window, (await examplesMenu(window)).getByTestId("examples-remove"));
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
    "Removed the examples",
  );
  await dismissChatSetup(window);
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(1);

  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.press("Escape");
  await askPalette(window, "Remove the examples");
  await paletteItems(window).first().click();
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);

  await expect
    .poll(() => helpItem(app))
    .toEqual({
      label: "Show the examples again",
      visible: true,
    });
  await askPalette(window, "the examples");
  await expect(paletteItems(window).first()).toHaveText(/Show the examples again/);
  await expect(paletteItems(window).filter({ hasText: /^Remove the examples/ })).toHaveCount(0);
  await window.keyboard.press("Escape");

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((each) => each.id === "examples.show")
      ?.click();
  });
  await expect(window.getByTestId("mind-list-item")).toHaveCount(1);
  await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveText(
    "Showed the examples",
  );
  await expect.poll(() => helpItem(app)).toMatchObject({ visible: false });
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(0);
  await app.close();
});
