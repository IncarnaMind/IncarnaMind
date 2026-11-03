import { expect, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  WINDOW_SIZE,
} from "./app";

/*
 * The conversation the assistant shows comes back after quitting and reopening the app (#258):
 * the one it showed, which is not always the newest, and a New chat when there was none.
 */

const QUESTIONS: Record<"en" | "zh-CN", readonly [string, string]> = {
  en: ["When do spring tides happen?", "Why are neap tides weaker?"],
  "zh-CN": ["大潮什么时候出现？", "小潮为什么更弱？"],
};

/** What each Question is called, as the conversation's title: the Question without its end mark. */
const NAMES: Record<"en" | "zh-CN", readonly [string, string]> = {
  en: ["When do spring tides happen", "Why are neap tides weaker"],
  "zh-CN": ["大潮什么时候出现", "小潮为什么更弱"],
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const language of ["en", "zh-CN"] as const) {
  const questions = QUESTIONS[language];
  const names = NAMES[language];

  test(`an empty data folder opens on a New chat, and a conversation the assistant showed comes back after a quit (${language}) (#258)`, async () => {
    // Nothing kept yet: the assistant says a New chat, in the app's own words.
    const empty = await createDataFolder();
    let session = await launchApp(empty, { fakeChat: true });
    await setWindowSize(session.app, session.window, WINDOW_SIZE.width, WINDOW_SIZE.height);
    await dismissChatSetup(session.window);
    await useLocalChatModel(session.window);
    await setLanguage(session.window, language);
    await expect(session.window.getByTestId("assistant-title")).toHaveText(
      translate(language, "conversation.untitled"),
    );
    await expect(
      session.window.getByTestId("assistant").getByTestId("assistant-question"),
    ).toHaveCount(0);
    await session.app.close();
    await removeDataFolder(empty);

    // Two conversations: the second is the newest, and the first is the one shown before quitting.
    session = await launchApp(dataDir, { fakeChat: true });
    let { window } = session;
    await setWindowSize(session.app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await askInAssistant(window, questions[0]);
    await pointAndClick(window, window.getByTestId("assistant-new-chat"));
    await askInAssistant(window, questions[1]);
    await pointAndClick(window, window.getByTestId("assistant-title"));
    const rows = window.getByTestId("assistant-history-row");
    await expect(rows).toHaveCount(2);
    await pointAndClick(window, rows.filter({ hasText: names[0] }));
    await expect(window.getByTestId("assistant-title")).toHaveText(names[0]);

    await session.app.close();

    // Reopened: the conversation it showed, not the newest one and not a New chat.
    session = await launchApp(dataDir, { fakeChat: true });
    ({ window } = session);
    await setWindowSize(session.app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
    await expect(window.getByTestId("assistant-title")).toHaveText(names[0]);
    const questionsShown = window.getByTestId("assistant").getByTestId("assistant-question");
    await expect(questionsShown.filter({ hasText: questions[0] })).toHaveCount(1);
    await expect(questionsShown.filter({ hasText: questions[1] })).toHaveCount(0);
    await session.app.close();
  });
}
