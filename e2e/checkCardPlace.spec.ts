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
 * A check card that opens with only its title opens above its badge, at the smallest Note pane
 * the app allows: the window at its least height with the assistant at the
 * side, and with it at the bottom, dragged as tall as it goes. Below its badge such a card would
 * hold a body a title high, and what lands in it would show nothing, so a change to the pane's
 * least height, the badge's place or the card's first lines must not bring that back unseen.
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
    test(`a title-only card opens above its badge in the smallest Note pane, the assistant ${layout} (${language})`, async () => {
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

      const card = await checkCard(window);
      // A cloud model's price line comes with sentences to price, and with them a row: a card with
      // only its title has none, and its foot is the Check.
      const priced = await card.getByTestId("check-estimate").count();
      await motionSettled(window);
      const [shown, badge] = await Promise.all([
        card.boundingBox(),
        window.locator(".check-badge-place").boundingBox(),
      ]);
      if (!shown || !badge) throw new Error("The card or its badge isn't drawn.");
      await test.info().attach(`pane-${layout}-${language}`, {
        body: JSON.stringify({ pane: pane.height, card: shown, badge, priced }),
        contentType: "application/json",
      });
      expect(pane.height, "the pane is the smallest the app allows").toBeLessThan(
        layout === "at the side" ? 560 : 260,
      );
      expect(shown.y + shown.height, "the card is above its badge").toBeLessThanOrEqual(
        badge.y + 0.5,
      );
      expect(shown.y, "and inside the window").toBeGreaterThanOrEqual(0);
      await app.close();
    });
  }
}
