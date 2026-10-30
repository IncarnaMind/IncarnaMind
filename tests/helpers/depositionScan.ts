import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const WIDTH = 1654;
const HEIGHT = 2339;
const FONT = "DepositionArial";
let fontLoaded = false;

/** A clean A4 scan at 200 dpi, with large type that the real OCR engine can read exactly. */
export function depositionScan(lines: readonly string[]): Uint8Array {
  if (!fontLoaded) {
    if (!GlobalFonts.registerFromPath("/System/Library/Fonts/Supplemental/Arial.ttf", FONT)) {
      throw new Error("Couldn't load the deposition scan fixture font.");
    }
    fontLoaded = true;
  }
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#111";
  lines.forEach((line, index) => {
    context.font = `${index === 0 ? 38 : index === 1 ? 64 : 54}px ${FONT}`;
    context.fillText(line, 170, 220 + index * 170);
  });
  return canvas.encodeSync("jpeg", 95);
}
