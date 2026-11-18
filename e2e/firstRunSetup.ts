import type { Page } from "@playwright/test";

/**
 * Skips through the first run's setup (#3296) if the window opened on it, as a User pressing each
 * step's skip would, and returns once the app shows. A window on the app is left as it is. The
 * packaged app is a release build, so a fresh profile there always opens on the setup.
 */
export async function skipFirstRunSetup(window: Page): Promise<void> {
  const setup = window.getByTestId("first-run-setup");
  const app = window.getByTestId("plus-menu");
  await setup.or(app).first().waitFor({ timeout: 60_000 });
  if (!(await setup.isVisible())) return;
  for (;;) {
    const skip = setup.getByTestId("setup-skip");
    await skip.or(app).first().waitFor();
    if (await app.isVisible()) return;
    const step = await setup.getByTestId("setup-panel").getAttribute("data-step");
    await skip.click();
    if (step === "meetings") break;
    await setup
      .locator(`[data-testid="setup-panel"]:not([data-step="${step}"])`)
      .or(app)
      .first()
      .waitFor();
  }
  await app.waitFor({ timeout: 60_000 });
}
