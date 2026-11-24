import { join } from "node:path";
import { test } from "@playwright/test";
import { openBench, workDir } from "./bench";

/** Pictures a local page of pictures (the side-by-side sheets and the stills page). */
test("picture the sheets", async () => {
  const pages = (process.env.PICTURE_PAGES ?? "").split(",").filter(Boolean);
  for (const page of pages) {
    const { app, window } = await openBench(join(workDir, page), "pictures");
    await window.waitForLoadState("load");
    await window.waitForTimeout(300);
    await window.screenshot({
      path: join(workDir, page.replace(/\.html$/, ".png")),
      fullPage: true,
    });
    await app.close();
  }
});
