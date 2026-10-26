import { expect, test } from "@playwright/test";
import {
  useLocalChatModel as connectLocalChatModel,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The prompts that teach a later feature (docs/agents/interaction.md, rule 14) wait for the
 * User's second own note or their first export of one of their own, the milestone Home's row
 * reads (gettingStarted.exported). The citation style and suggestion offers are covered in their
 * own specs; this is the guide's Connect an app offer, which lives in an empty note's steps.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`Connect an app waits for a second own note, and still shows after a restart (${language})`, async () => {
    let { app, window } = await launchApp(dataDir, { examples: false, fakeChat: true });
    try {
      await setWindowSize(app, window, 900, 800);
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      // The steps are open but their first-run card was never drawn: an empty note of the
      // User's own is where the guide, and with it the connect offer, shows.
      await (await coreOf(window)).evaluate(async (core) => {
        const { device } = await core.getSettings();
        await core.updateSettings({
          device: { gettingStarted: { ...device.gettingStarted, started: true, seen: false } },
        });
      });
      await newMind(window);
      const connect = window.getByTestId("start-connect-app");
      for (const width of [900, 1600]) {
        await setWindowSize(app, window, width, 800);
        await expect(window.getByTestId("start-guide")).toBeVisible();
        await expect(connect).toHaveCount(0);
      }
      await setWindowSize(app, window, 900, 800);
      await newMind(window);
      await expect(window.getByTestId("tip")).toHaveAttribute("data-tip", "connect-app");
      await expect(connect).toBeVisible();
      await app.close();

      ({ app, window } = await launchApp(dataDir, { examples: false, fakeChat: true }));
      await setWindowSize(app, window, 1600, 800);
      await newMind(window);
      await expect(window.getByTestId("start-connect-app")).toBeVisible();
      await window.getByTestId("start-connect-app").click();
      await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "connectors");
    } finally {
      await app.close();
    }
  });
}
