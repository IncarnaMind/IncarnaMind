import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../src/core/storage";
import {
  addDocuments,
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * An Answer written while a Document of its scope is still being read says so (#1503): the
 * Document isn't found yet, and that is not the same as not being there.
 */

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

/** Puts a Document's status where a read under way has it, as the reading itself would. */
function setStatus(id: string, status: "extracting" | "ready") {
  const db = openDatabase(join(dataDir, "incarnamind.db"));
  try {
    db.run("UPDATE documents SET status = ? WHERE id = ?", [status, id]);
  } finally {
    db.close();
  }
}

const WORDS = {
  en: {
    one: "1 Document is still being read: Handbook · Ask again when it’s ready",
    two: "2 Documents are still being read · Ask again when it’s ready",
  },
  "zh-CN": {
    one: "还有 1 个文档正在读取：Handbook · 读取完成后再问一次",
    two: "还有 2 个文档正在读取 · 读取完成后再问一次",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [900, 1440]) {
    test(`an Answer written while a Document is still being read says so, in two lines at most, and not once it is ready (${language}, ${width}px)`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      try {
        await setWindowSize(app, window, width, 760);
        await dismissChatSetup(window);
        await connectLocalChatModel(window);
        await setLanguage(window, language);
        const memo = join(sources, "Memo.txt");
        const handbook = join(sources, "Handbook.txt");
        const policy = join(sources, "Policy.txt");
        await writeFile(memo, "Shipping costs rose in the north this quarter.");
        await writeFile(
          handbook,
          "Chapter 7 on risk: escalate any high incident to the duty manager.",
        );
        await writeFile(policy, "Policy notes on travel and expenses.");
        await addDocuments(window, [memo, handbook, policy]);
        const documents = await (await coreOf(window)).evaluate((core) => core.listDocuments());
        const id = (name: string) => documents.find((each) => each.name === name)?.id ?? "";

        setStatus(id("Handbook"), "extracting");
        const answer = await askInAssistant(window, "What does the handbook say about escalation?");
        const line = answer.getByTestId("answer-still-reading");
        await expect(line).toHaveText(WORDS[language].one);
        const height = await line.evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            element.getBoundingClientRect().height / (Number.parseFloat(style.lineHeight) || 20)
          );
        });
        expect(height).toBeLessThanOrEqual(2.5);

        setStatus(id("Handbook"), "ready");
        const again = await askInAssistant(window, "What does the handbook say about escalation?");
        await expect(again.getByTestId("answer-still-reading")).toHaveCount(0);

        setStatus(id("Handbook"), "extracting");
        setStatus(id("Policy"), "extracting");
        const several = await askInAssistant(window, "What does the policy say about travel?");
        await expect(several.getByTestId("answer-still-reading")).toHaveText(WORDS[language].two);
      } finally {
        await app.close();
      }
    });
  }
}
