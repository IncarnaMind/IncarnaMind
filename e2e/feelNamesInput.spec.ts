import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createDataFolder, dismissChatSetup, launchApp, removeDataFolder } from "./app";
import { FEEL_FOLDER, feelOf } from "./feel";

/*
 * A step over the input ceiling names the event and the element it reached, as they were when the
 * input was dispatched: the element may be gone, or have changed its attributes, by the time the
 * browser reports how long the input took.
 */

const SLOW_MS = 650;

/** Three controls in a fixture that is not part of the app, each slow to answer the input it gets. */
const addFixture = (window: Page) =>
  window.evaluate((slow) => {
    const wait = () => {
      const end = performance.now() + slow;
      while (performance.now() < end);
    };
    const fixture = document.createElement("div");
    fixture.dataset.testid = "feel-fixture";
    fixture.style.cssText =
      "position:fixed;top:60px;left:60px;z-index:99999;background:#fff;padding:8px";
    const password = Object.assign(document.createElement("input"), { type: "password" });
    password.addEventListener("keydown", wait);
    const removed = Object.assign(document.createElement("button"), { textContent: "Remove me" });
    removed.dataset.testid = "removed-control";
    removed.addEventListener("click", () => {
      removed.remove();
      wait();
    });
    const changed = Object.assign(document.createElement("button"), { textContent: "Rename me" });
    changed.dataset.testid = "before";
    changed.addEventListener("click", () => {
      changed.dataset.testid = "after";
      changed.setAttribute("type", "reset");
      wait();
    });
    fixture.append(password, removed, changed);
    document.body.append(fixture);
  }, SLOW_MS);

// protects=a step over the input ceiling says which event on which element was slowest, even when that element left the page or changed its attributes before the browser reported the input, and a password field is called one; fails_when=the target is described when the timing arrives, or by its nearest test id alone; no_claim=the ceiling, which the feel check sets.
test("a slow input names the event and the element it reached, as it was when it was dispatched", async () => {
  const dataDir = await createDataFolder();
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    const flow = "feel-names-input";
    const feel = await feelOf(window, flow);
    await addFixture(window);
    await feel.step("a key in a password field", async () => {
      await window.locator('input[type="password"]').focus();
      await window.keyboard.press("a");
    });
    await feel.step("a click that removes its button", async () => {
      await window.getByTestId("removed-control").click();
    });
    await feel.step("a click that changes its button's attributes", async () => {
      await window.getByTestId("before").click();
    });
    await feel.finish();
    const report = JSON.parse(await readFile(join(FEEL_FOLDER, `${flow}.json`), "utf8")) as {
      problems: { step: string; kind: string; on?: string }[];
    };
    const named = Object.fromEntries(
      report.problems.filter((each) => each.kind === "input").map((each) => [each.step, each.on]),
    );
    expect(named).toEqual({
      "a key in a password field": "keydown on input[type=password] in feel-fixture",
      "a click that removes its button":
        "pointerdown on button[data-testid=removed-control] in feel-fixture",
      "a click that changes its button's attributes":
        "pointerdown on button[data-testid=before] in feel-fixture",
    });
  } finally {
    await app.close();
    await removeDataFolder(dataDir);
  }
});
