import { expect, test } from "@playwright/test";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  frontMind,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * Asked to write in a new, empty Mind with no name yet, the assistant writes
 * there (#1212). The scripted model says no Mind is open when the Mind
 * reaches it with no name, as models did; in English and Chinese.
 */

const CASES = [
  {
    name: "English",
    language: "en",
    request: "Write a brief summary of this agreement.",
    refusal: "No Mind is open",
  },
  {
    name: "Chinese",
    language: "zh-CN",
    request: "写一份简要总结。",
    refusal: "没有打开的笔记",
  },
] as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const each of CASES) {
  test(`a request to write in a new, empty, unnamed Mind writes there (${each.name})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, each.language);
    await newMind(window);

    const answer = await askInAssistant(window, each.request);

    await expect(answer).not.toContainText(each.refusal);
    await expect(frontMind(window).getByTestId("mind-editor")).toContainText(
      "Spring tides come at new and full moon",
    );
    await app.close();
  });
}
