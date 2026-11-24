import { join } from "node:path";
import { test } from "@playwright/test";
import { lane, openBench } from "./bench";

/** Pictures a local page of pictures (the side-by-side sheets and the stills page). */
test("picture the sheets", async () => {
  const pages = (process.env.PICTURE_PAGES ?? "").split(",").filter(Boolean);
  for (const page of pages) {
    const { app, window } = await openBench(join(lane, page), "pictures");
    await window.waitForLoadState("load");
    await window.waitForTimeout(300);
    await window.screenshot({ path: join(lane, page.replace(/\.html$/, ".png")), fullPage: true });
    await app.close();
  }
});
