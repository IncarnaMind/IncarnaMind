import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  launchApp,
  openMeetingSheet,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A first run's window as the packaged app opens it on a small screen (#3762): the examples are
 * there and nothing has been asked yet, so the assistant is quiet and its Ask pill floats at the
 * middle of the window's foot, where a recorded call's control stands at its Note's foot once the
 * window is narrow. The pill gives way to the control while that Note is shown, so its press opens
 * the Transcript, and comes back over a page without one.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** Whether a press at the middle of `target` reaches it, with nothing lying over it. */
const pressable = (target: Locator) =>
  target.evaluate((element) => {
    const at = element.getBoundingClientRect();
    const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
    return hit !== null && (element.contains(hit) || hit.contains(element));
  });

async function sheetFromChevron(window: Page, chevron: Locator): Promise<void> {
  expect(await pressable(chevron)).toBe(true);
  const sheet = await openMeetingSheet(window);
  await pointAndClick(window, sheet.getByTestId("meeting-sheet-hide"));
  await expect(sheet).toBeHidden();
}

// protects=on a first run with the assistant quiet, in a window as narrow as a small screen gives the packaged app, the Ask pill never lies over a recorded call's control at its Note's foot, so the chevron's press opens the Transcript sheet, in English and Chinese, and the pill is back over Home (#3762); fails_when=the pill floats over the control and takes its press, or it is gone everywhere; no_claim=the pill's own place and look, which the first-run specs hold.
test("in a first run's small window the Ask pill gives way to a call's control, whose chevron opens the Transcript, and is back over Home", async () => {
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 1024, 677);
  const pill = window.getByTestId("ask-pill");
  await expect(pill).toBeVisible();

  const control = await recordMeeting(window);
  const chevron = control.getByTestId("meeting-foot-transcript");
  await expect(pill).toHaveCount(0);
  await sheetFromChevron(window, chevron);
  await setLanguage(window, "zh-CN");
  await expect(chevron).toHaveAccessibleName(/^显示转写稿/);
  await expect(pill).toHaveCount(0);
  await sheetFromChevron(window, chevron);

  // Over a page with no call at its foot, the quiet assistant's pill is where it was.
  await pointAndClick(window, window.getByTestId("sidebar-home"));
  await expect(window.getByTestId("home")).toBeVisible();
  await expect(pill).toBeVisible();
});
