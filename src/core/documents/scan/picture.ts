import type { PagePicture, PictureRead, RecognizedLine } from "../../adapters";
import { engineModule, exportsOf } from "../../engineModules";
import { greys } from "./pages";

/** Draws pictures for text recognition. */
export const CANVAS = engineModule(
  "@napi-rs/canvas",
  async () => exportsOf(await import("@napi-rs/canvas")),
  ["createCanvas", "loadImage"],
);

// A chart's small print reads better a little larger, and a large photo needs no more than this.
const SMALLEST_SIDE = 1000;
const LARGEST_SIDE = 2000;

export async function figurePicture(bytes: Uint8Array): Promise<PagePicture> {
  const { createCanvas, loadImage } = await CANVAS.load();
  const image = await loadImage(Buffer.from(bytes));
  const longer = Math.max(image.width, image.height, 1);
  const scale = Math.min(LARGEST_SIDE, Math.max(SMALLEST_SIDE, longer)) / longer;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  // A transparent picture's text is dark on nothing: on white, as a page shows it.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return { width, height, pixels: greys(context.getImageData(0, 0, width, height).data) };
}

/** `TextRecognizer.readFile` for a model that reads drawn pictures: drawn here, then read. */
export async function readDrawn(
  file: Uint8Array,
  read: (picture: PagePicture) => Promise<RecognizedLine[]>,
): Promise<PictureRead> {
  const picture = await figurePicture(file);
  return { lines: await read(picture), width: picture.width, height: picture.height };
}
