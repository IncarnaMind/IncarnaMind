import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * An Answer about the main few of the Documents says which it took, above
 * its reply, with Use others: that asks again with the rest, in a new Answer
 * under the first, whose steps line says so. The first stays as it was. And
 * an Answer from the User's own Mind never cites or names the examples'
 * Documents (#894).
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let files: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  files = await mkdtemp(join(tmpdir(), "coverage-e2e-"));
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await rm(files, { recursive: true, force: true });
});

/** Three reports, the first the longest. */
async function reports(): Promise<string[]> {
  return Promise.all(
    [1, 2, 3].map(async (at) => {
      const path = join(files, `Report ${at}.md`);
      const lines = Array.from(
        { length: (4 - at) * 12 },
        (_, line) => `Report ${at}, finding ${line + 1}: the tide rose ${line} cm.`,
      );
      await writeFile(path, `# Report ${at}\n\n${lines.join("\n\n")}\n`);
      return path;
    }),
  );
}

test("“the two main documents” names the two it took, and Use others asks again with the rest under it; in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, await reports());
  await newMind(window);
  await window.keyboard.type("Reading group");

  await askInAssistant(window, "Summarise the two main documents");

  // The Answer stays the first; `askInAssistant` gives the last, which moves.
  const first = assistantAnswers(window).nth(0);
  const coverage = first.getByTestId("answer-coverage");
  await expect(coverage).toHaveText(
    "I took “Report 1” and “Report 2” as the main ones. · Use others",
  );
  // Above the reply.
  const line = await coverage.boundingBox();
  const reply = await first.getByTestId("assistant-answer-text").boundingBox();
  expect(line && reply && line.y < reply.y).toBe(true);
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "main-pick-en.png") });

  await pointAndClick(window, coverage.getByTestId("answer-coverage-rest"));
  const answers = assistantAnswers(window);
  await expect(answers).toHaveCount(2);
  const again = answers.last();
  await expect(again).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  // The steps line says it, as one line, the whole of it in its tooltip.
  const againSteps = again.getByTestId("answer-steps");
  await expect(againSteps).toHaveText("Asked again with the other Document");
  await expect(againSteps).toHaveAttribute("title", "Asked again with the other Document");
  const steps = await againSteps.boundingBox();
  const againReply = await again.getByTestId("assistant-answer-text").boundingBox();
  expect(steps && againReply && steps.y < againReply.y).toBe(true);
  await expect(again.getByTestId("answer-coverage")).toHaveCount(0);
  await expect(coverage).toHaveText(
    "I took “Report 1” and “Report 2” as the main ones. · Use others",
  );
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "asked-again-en.png") });

  await setLanguage(window, "zh-CN");
  await expect(coverage).toHaveText("我选了“Report 1”和“Report 2”作为主要文档。· 换别的");
  await expect(againSteps).toHaveText("用其余 1 个文档重新回答");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "main-pick-zh.png") });
});

test("on first run, with the examples there, an Answer from the User's own Mind never cites or names the example's Documents", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, examples: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1440, 900);
  const path = join(files, "Store notes.md");
  await writeFile(path, "# Store notes\n\nOur gross margin rose to 41% in the third quarter.\n");
  // The examples' Documents are listed too, so the helper's count doesn't hold.
  await window.getByTestId("add-documents-input").setInputFiles([path]);
  await expect(
    window.getByTestId("document-list-item").filter({ hasText: "Store notes" }),
  ).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await newMind(window);
  await window.keyboard.type("Margins");

  // "each" cites every Document the search finds; the examples' results speak of gross margin too.
  await askInAssistant(window, "What does each say about the gross margin?");

  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  const chips = answer.getByTestId("citation-chip");
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveAttribute("aria-label", /Store notes/);
  await expect(answer).not.toContainText("Northwind");
});

/** The example's title in each language, once made (and swapped when the language changes). */
const EXAMPLE_TITLE = {
  en: "Draft: credit committee paper",
  "zh-CN": "授信委员会报告（草稿）",
} as const;

for (const [language, question, asks, count] of [
  [
    "en",
    "Summarise the two main documents.",
    "Which two Documents do you mean?",
    "Your Library has 3",
  ],
  ["zh-CN", "总结两份主要文档。", "你指的是哪两份文档？", "资料库里有 3 份"],
] as const) {
  // protects=with three Documents in the Library, two of them the example's and one the User's, “the two main documents” asks which two in one line and says the Library's whole count (#1333); fails_when=the reply asks for two among a count the Library contradicts, or says the Library holds one; no_claim=how a real model words it (the hand test on Claude Haiku 5.5).
  test(`in ${language === "en" ? "English" : "Chinese"}, “the two main documents” is asked for, and the Library's count is its own (#1333)`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true, examples: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    // The example was made in the language the app started in: wait for the one this run reads.
    await expect(window.getByTestId("mind-editor").locator("h1")).toHaveText(
      EXAMPLE_TITLE[language],
      { timeout: 30_000 },
    );
    const name = language === "en" ? "Harbour lease" : "海港租约";
    const path = join(files, `${name}.md`);
    await writeFile(path, `# ${name}\n\nThe rent is 1,450 pounds a month.\n`);
    // The example's Documents are listed too, so the helper's count doesn't hold.
    await window.getByTestId("add-documents-input").setInputFiles([path]);
    await expect(
      window.getByTestId("document-list-item").filter({ hasText: name }),
    ).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
    // Three Documents in the Library: the two the example made, and this one.
    await expect
      .poll(async () =>
        (await coreOf(window)).evaluate(async (core) => (await core.listDocuments()).length),
      )
      .toBe(3);
    await newMind(window);

    const answer = await askInAssistant(window, question);

    const said = answer.getByTestId("assistant-answer-text");
    await expect(said).toContainText(asks);
    await expect(said).toContainText(count);
    await expect(said).toContainText(name);
    await expect(said).not.toContainText(/only one Document/i);
    await expect(said).not.toContainText("只有一份文档");
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `library-count-${language}.png`) });
    }
  });
}
