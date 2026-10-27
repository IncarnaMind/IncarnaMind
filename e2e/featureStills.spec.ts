import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { captureFeature, contactSheet, writeFeatures } from "./demo/features";
import { FEATURE_CROP, FEATURE_MAX_BYTES, FEATURE_SIZE, FEATURES } from "./demo/stills";

/*
 * The README's feature pictures, without the app: the recorder's crop, card and contact sheet
 * always come out at 1200 × 750 and under the size limit, hide the recording's pointer, and refuse
 * a moment too big to read. The take that draws the real pictures is cut from the same code, so a
 * change here shows before any recording is made.
 */

const sizeOf = (bytes: Buffer): [number, number] => [
  bytes.readUInt32BE(16),
  bytes.readUInt32BE(20),
];

test("a feature picture is the crop's 1088 × 638 on its card at 1200 × 750, with no pointer", async ({
  browser,
}) => {
  const output = test.info().outputPath("stills");
  const context = await browser.newContext({
    viewport: { width: 1000, height: 700 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  try {
    for (const language of ["en", "zh-CN"] as const) {
      await page.setContent(`<style>
        body { margin:0; background:white; }
        article { position:absolute;left:200px;top:200px;width:300px;height:180px;
          background:white;font:16px/1.6 system-ui; }
        #demo-overlay { position:fixed;inset:0;background:red;z-index:999; }
        </style><article>${language === "en" ? "A cited answer, from the current report." : "有引用的回答，来自当前报告。"}</article>
        <div id="demo-overlay"></div>`);
      const crop = await captureFeature(page, page.locator("article"));
      const [cropWidth, cropHeight] = sizeOf(crop);
      expect(cropWidth / cropHeight).toBeCloseTo(FEATURE_CROP.width / FEATURE_CROP.height, 1);
      await expect(page.locator("#demo-overlay")).toBeVisible();
      await writeFeatures(
        new Map(FEATURES.map((name) => [name, crop])),
        join(output, "staging", language),
        output,
        language,
      );
      for (const name of FEATURES) {
        const bytes = await readFile(join(output, "features", language, `${name}.png`));
        expect(sizeOf(bytes), name).toEqual([FEATURE_SIZE.width, FEATURE_SIZE.height]);
        expect(bytes.length, name).toBeLessThan(FEATURE_MAX_BYTES);
      }
      // The picture's edge is `frame`, and the card's is `sheet`.
      const framed = await readFile(join(output, "features", language, "ask.png"));
      const corners = await page.evaluate(async (encoded) => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const drawing = canvas.getContext("2d");
        if (!drawing) throw new Error("Canvas is unavailable.");
        drawing.drawImage(image, 0, 0);
        return [
          [...drawing.getImageData(0, 0, 1, 1).data],
          [...drawing.getImageData(600, 680, 1, 1).data],
        ];
      }, framed.toString("base64"));
      expect(corners).toEqual([
        [244, 245, 247, 255],
        [255, 255, 255, 255],
      ]);
    }
    const sheet = join(output, "contact.png");
    await contactSheet(output, ["en", "zh-CN"], sheet);
    expect(sizeOf(await readFile(sheet))).toEqual([16 + 4 * 410 + 3 * 20 + 16, 4 * 306 + 32]);
  } finally {
    await context.close();
  }
});

test("a moment too big for the crop, or off the screen, is refused rather than shrunk", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 700 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  try {
    await page.setContent(`<style>
      article { display:block; margin:200px; width:300px; height:180px; background:white; }
      </style><article>One moment.</article>`);
    const article = page.locator("article");
    await article.evaluate((target) => {
      target.style.width = "600px";
    });
    await expect(captureFeature(page, article)).rejects.toThrow("target is too large");
    await article.evaluate((target) => {
      target.style.display = "none";
    });
    await expect(captureFeature(page, article)).rejects.toThrow("not visible");
    await expect(
      writeFeatures(new Map(), test.info().outputPath("none"), "out", "en"),
    ).rejects.toThrow("No sort");
  } finally {
    await context.close();
  }
});
