import { parentPort, workerData } from "node:worker_threads";
import { CANVAS } from "../engineModules";
import type { PictureDrawn, PictureJob } from "./sharedPictures";

const WASH = "#dcf3e4";
const ERROR = "#b42318";
const QUALITY = 80;

async function draw({ image, area, width, height, marks, tone }: PictureJob): Promise<Uint8Array> {
  const { createCanvas, loadImage } = await CANVAS.load();
  const source = await loadImage(Buffer.from(image));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const scale = width / area.width;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(source, area.x, area.y, area.width, area.height, 0, 0, width, height);
  const pad = 2 * scale;
  for (const box of marks) {
    const x = (box.x - area.x) * scale - pad;
    const y = (box.y - area.y) * scale - pad;
    const w = box.width * scale + 2 * pad;
    const h = box.height * scale + 2 * pad;
    if (tone === "outline") {
      context.globalCompositeOperation = "source-over";
      context.strokeStyle = ERROR;
      context.lineWidth = 3;
      context.strokeRect(x, y, w, h);
    } else {
      // Multiplied, so the words stay as dark as the page draws them.
      context.globalCompositeOperation = "multiply";
      context.fillStyle = WASH;
      context.fillRect(x, y, w, h);
    }
  }
  return new Uint8Array(canvas.toBuffer("image/webp", QUALITY));
}

const jobs = workerData as PictureJob[];
void (async () => {
  const pictures: PictureDrawn[] = [];
  for (const job of jobs) {
    try {
      pictures.push({ data: await draw(job) });
    } catch (error) {
      pictures.push({ failed: error instanceof Error ? error.message : String(error) });
    }
  }
  parentPort?.postMessage({ pictures });
})();
