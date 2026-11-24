import { join } from "node:path";
import { test } from "@playwright/test";
import { openBench, workDir } from "./bench";

test("arm A draws the test deck", async () => {
  const { app, window } = await openBench(join(workDir, "bench/A/index.html"), "smoke-a");
  await window.waitForFunction(() => "benchA" in window);
  await window.evaluate(
    (path) =>
      (
        window as unknown as { benchA: { open: (p: string, s: number) => Promise<void> } }
      ).benchA.open(path, 2),
    join(workDir, "decks/test-deck.pptx"),
  );
  await window.locator("[data-testid=viewer-slide-editor]").waitFor();
  await window.screenshot({ path: join(workDir, "shots/smoke-a.png") });
  await app.close();
});

test("arm B draws the test deck", async () => {
  const { app, window } = await openBench(join(workDir, "armB/page/index.html"), "smoke-b");
  const errors: string[] = [];
  window.on("pageerror", (error) => errors.push(error.message));
  window.on("console", (message) => errors.push(`${message.type()}: ${message.text()}`));
  await window.waitForFunction(() => "benchB" in window);
  await window.evaluate(
    (path) =>
      (window as unknown as { benchB: { open: (p: string) => Promise<void> } }).benchB.open(path),
    join(workDir, "decks/test-deck.pptx"),
  );
  await window.waitForTimeout(1500);
  await window.screenshot({ path: join(workDir, "shots/smoke-b.png") });
  console.log(
    errors.slice(0, 10),
    await window.evaluate(() => (window as unknown as { violations: unknown[] }).violations),
  );
  await app.close();
});
