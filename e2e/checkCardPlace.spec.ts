import { expect, test } from "@playwright/test";
import {
  acceptPlainTextKeys,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  placeAssistant,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useCloudChatModel,
} from "./app";

/*
 * A check card that opens with only its title opens down from where the Note's Check button sits,
 * at the Note's top right (#3677, #3794), inside the window, at the smallest Note pane the app
 * allows: the window at its least height with the assistant at the side, and with it at the
 * bottom, dragged as tall as it goes.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const language of ["en", "zh-CN"] as const) {
  for (const layout of ["at the side", "at the bottom, dragged tallest"] as const) {
    test(`a title-only card opens below the Note's Check button in the smallest Note pane, the assistant ${layout} (${language})`, async () => {
      test.setTimeout(120_000);
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await useCloudChatModel(window);
      await setLanguage(window, language);
      if (layout === "at the side") {
        await setWindowSize(app, window, 1440, 560);
        await placeAssistant(window, { dock: "right" });
      } else {
        await setWindowSize(app, window, 900, 560);
        await placeAssistant(window, { dock: "bottom", height: 10_000 });
      }
      await newMind(window);
      const pane = await window.getByTestId("card").boundingBox();
      if (!pane) throw new Error("The Note's pane isn't drawn.");

      // An empty Note has no sentence to check: the card holds only its title, and the Check
      // button's place at the Note's top right is the room it opens from.
      const card = await checkCard(window);
      await motionSettled(window);
      const [shown, place] = await Promise.all([
        card.boundingBox(),
        window.locator(".note-check-frame").boundingBox(),
      ]);
      if (!shown || !place) throw new Error("The card or the Check button's place isn't drawn.");
      await test.info().attach(`pane-${layout}-${language}`, {
        body: JSON.stringify({ pane: pane.height, card: shown, place }),
        contentType: "application/json",
      });
      expect(pane.height, "the pane is the smallest the app allows").toBeLessThan(
        layout === "at the side" ? 560 : 260,
      );
      expect(shown.y, "the card is below the Check button's place").toBeGreaterThanOrEqual(
        place.y + place.height - 0.5,
      );
      expect(shown.y + shown.height, "and inside the window").toBeLessThanOrEqual(560);
      await app.close();
    });
  }
}
