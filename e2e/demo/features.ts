/**
 * Cuts the README's feature pictures from the app's own screen during the take, and lays each on
 * the app's card: a crop laid at 2.5 pixels per CSS pixel (2.5 × 435 = the card's 1088), on
 * `sheet` with the card's corners and the popover's depth, over `frame`. The app is never
 * retouched: a picture is its pixels, cropped and placed, with no pointer, arrow or caption added.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";
import type { DemoLanguage } from "./documents";
import {
  FEATURE_CROP,
  FEATURE_INSET,
  FEATURE_MAX_BYTES,
  FEATURE_PIXELS,
  FEATURE_SCREEN_PIXELS,
  FEATURE_SIZE,
  FEATURES,
  type Feature,
} from "./stills";

/**
 * The app's screen around these parts of it, as a PNG: the crop the card will show, taken at the
 * window's own density and centred on them, kept inside the window. A card that runs past the
 * crop asks for its bottom: the crop then ends just under the moment, in the gap after it, rather
 * than through a line below. The card lays it at the picture's 2.5 pixels per CSS pixel, so the
 * app's text reads at the README's size; a moment too big for the crop is a moment to crop again,
 * so it says so rather than shrinking the text.
 */
export async function captureFeature(
  page: Page,
  targets: Locator | readonly Locator[],
  { anchor = "center" }: { anchor?: "center" | "bottom" } = {},
): Promise<Buffer> {
  const list = Array.isArray(targets) ? targets : [targets as Locator];
  const boxes = await Promise.all(list.map((target) => target.boundingBox()));
  if (boxes.length === 0 || boxes.some((box) => box === null)) {
    throw new Error("A feature picture's target is not visible.");
  }
  const { ratio, width, height } = await page.evaluate(() => ({
    ratio: devicePixelRatio,
    width: innerWidth,
    height: innerHeight,
  }));
  if (ratio < FEATURE_SCREEN_PIXELS) {
    throw new Error(`Feature pictures need ${FEATURE_SCREEN_PIXELS} pixels per CSS pixel.`);
  }
  const crop = {
    width: FEATURE_CROP.width / FEATURE_PIXELS,
    height: FEATURE_CROP.height / FEATURE_PIXELS,
  };
  if (crop.width > width || crop.height > height) {
    throw new Error("The window is too small for the feature picture.");
  }
  const shown = boxes.filter((box) => box !== null);
  const left = Math.min(...shown.map((box) => box.x));
  const top = Math.min(...shown.map((box) => box.y));
  const right = Math.max(...shown.map((box) => box.x + box.width));
  const bottom = Math.max(...shown.map((box) => box.y + box.height));
  if (right - left > crop.width || bottom - top > crop.height) {
    throw new Error(
      "Recrop the feature picture around one readable moment; its target is too large.",
    );
  }
  const middle = (top + bottom - crop.height) / 2;
  const under = bottom + 8 - crop.height;
  return page.screenshot({
    clip: {
      x: Math.min(Math.max((left + right - crop.width) / 2, 0), width - crop.width),
      y: Math.min(Math.max(anchor === "bottom" ? under : middle, 0), height - crop.height),
      ...crop,
    },
    style: OVERLAY,
  });
}

/** The recording's layer, its pointer and rings, which a picture never shows. */
const OVERLAY = "#demo-overlay { visibility: hidden !important; }";

const sizeOf = (picture: Buffer) => ({
  width: picture.readUInt32BE(16),
  height: picture.readUInt32BE(20),
});

/**
 * Lays every picture of the take on its card and writes the eight into
 * `<output>/features/<language>/`, under the name the README uses. A missing picture, a crop that
 * is not the card's shape, or one over the size limit stops the take: the pictures come out with
 * the film or not at all. `staging` holds the framed PNGs until they are copied.
 */
export async function writeFeatures(
  pictures: ReadonlyMap<Feature, Buffer>,
  staging: string,
  output: string,
  language: DemoLanguage,
): Promise<void> {
  await mkdir(staging, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: FEATURE_SIZE.width, height: FEATURE_SIZE.height },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    for (const name of FEATURES) {
      const picture = pictures.get(name);
      if (!picture) throw new Error(`No ${name} feature picture was captured in this take.`);
      const crop = sizeOf(picture);
      if (Math.abs(crop.width / crop.height - FEATURE_CROP.width / FEATURE_CROP.height) > 0.01) {
        throw new Error(
          `The ${name} crop is ${crop.width} × ${crop.height}, not the picture's 16:10 crop.`,
        );
      }
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>
        body { margin:0; background:#F4F5F7; }
        img { position:absolute; left:${FEATURE_INSET}px; top:${FEATURE_INSET}px;
          width:${FEATURE_CROP.width}px; height:${FEATURE_CROP.height}px; background:#FFFFFF;
          border-radius:10px; box-shadow:0 0 0 1px #E3E5E9,0 12px 32px rgba(23,25,28,.12); }
        </style><img alt="" src="data:image/png;base64,${picture.toString("base64")}">`);
      await page.locator("img").evaluate((image) => (image as HTMLImageElement).decode());
      const framed = await page.screenshot();
      const framedSize = sizeOf(framed);
      if (framedSize.width !== FEATURE_SIZE.width || framedSize.height !== FEATURE_SIZE.height) {
        throw new Error(
          `The ${name} picture is ${framedSize.width} × ${framedSize.height}, not ${FEATURE_SIZE.width} × ${FEATURE_SIZE.height}.`,
        );
      }
      if (framed.length >= FEATURE_MAX_BYTES) {
        throw new Error(`The ${name} feature picture is over 250 KB; recrop it.`);
      }
      await writeFile(join(staging, `${name}.png`), framed);
    }
  } finally {
    await browser.close();
  }
  const folder = join(output, "features", language);
  await mkdir(folder, { recursive: true });
  for (const name of FEATURES) {
    await copyFile(join(staging, `${name}.png`), join(folder, `${name}.png`));
  }
}

/**
 * Every picture of both takes on one sheet, as the review sees them: four to a row at the width
 * the README shows each, each captioned with its language and name. Written to `file`.
 */
export async function contactSheet(
  output: string,
  languages: readonly DemoLanguage[],
  file: string,
): Promise<void> {
  const cards: string[] = [];
  for (const language of languages) {
    for (const name of FEATURES) {
      const bytes = await readFile(join(output, "features", language, `${name}.png`));
      cards.push(`<figure><img alt="" src="data:image/png;base64,${bytes.toString("base64")}">
        <figcaption>${language} · ${name}</figcaption></figure>`);
    }
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: {
        width: 16 + 4 * 410 + 3 * 20 + 16,
        height: Math.ceil(cards.length / 4) * 306 + 32,
      },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body { margin:16px; background:#F4F5F7; color:#17191C;
        font:14px/20px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
        display:grid; grid-template-columns:repeat(4,410px); gap:20px; }
      figure { margin:0; } img { width:410px; display:block; }
      figcaption { margin-top:8px; }
      </style>${cards.join("")}`);
    await page
      .locator("img")
      .evaluateAll((images) =>
        Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
      );
    await page.screenshot({ path: file });
  } finally {
    await browser.close();
  }
}
