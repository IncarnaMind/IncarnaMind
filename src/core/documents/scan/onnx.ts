/**
 * Runs the built-in text recognition model (#397): PaddleOCR's PP-OCRv5
 * mobile detection and recognition models, as ONNX, with onnxruntime-node on
 * the CPU. It blocks whatever thread it runs on for a second or more a page,
 * so the desktop app runs it in an Electron utility process
 * (src/main/scanReaderProcess.ts), never on the core's thread.
 *
 * A page is read in two passes: the detection model finds its lines of text
 * (./detect), then the recognition model reads them, a few at a time, each
 * cut out along its box and scaled to 48 pixels high (./recognize). The
 * recognition model's character list (Simplified and Traditional Chinese,
 * Latin letters, digits and symbols: 18,383 entries) is in its own file.
 */

import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import type { PagePicture, RecognizedLine, TextRecognizer } from "../../adapters";
import { ONNX_RUNTIME } from "../../engineModules";
import { textBoxes } from "./detect";
import { onnxMetadata } from "./onnxMetadata";
import { readDrawn } from "./picture";
import {
  decodeLine,
  type GreyImage,
  LINE_HEIGHT,
  lineFrame,
  MAX_LINE_WIDTH,
  MIN_LINE_WIDTH,
  readWidth,
  writeLine,
} from "./recognize";

type OnnxRuntime = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;

/** Pictures larger than this on their longer side are scaled down for detection, as PaddleOCR caps them. */
const MAX_DETECTION_SIDE = 2560;
/** Lines read together: PaddleOCR's `rec_batch_num`. */
const BATCH = 6;
/** A line the model is less sure of than this is noise, not text (PaddleOCR's drop score). */
const MIN_LINE_CONFIDENCE = 0.5;
/** ImageNet's mean and spread, in PaddleOCR's channel order (blue, green, red). */
const MEAN = [0.485, 0.456, 0.406] as const;
const SPREAD = [0.229, 0.224, 0.225] as const;

interface Loaded {
  key: string;
  ort: OnnxRuntime;
  detector: InferenceSession;
  recognizer: InferenceSession;
  characters: string[];
}

/**
 * Half the computer's cores, from one to four: reading runs in the
 * background, and must leave room for what the User is doing.
 */
const threads = () => Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

/** The picture scaled to `width` × `height` with bilinear sampling, as the detection model's input. */
function detectionInput(picture: PagePicture, width: number, height: number): Float32Array {
  const plane = width * height;
  const tensor = new Float32Array(3 * plane);
  const { pixels } = picture;
  const scaleX = picture.width / width;
  const scaleY = picture.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(Math.max((y + 0.5) * scaleY - 0.5, 0), picture.height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, picture.height - 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(Math.max((x + 0.5) * scaleX - 0.5, 0), picture.width - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, picture.width - 1);
      const fx = sx - x0;
      const top =
        (pixels[y0 * picture.width + x0] as number) * (1 - fx) +
        (pixels[y0 * picture.width + x1] as number) * fx;
      const bottom =
        (pixels[y1 * picture.width + x0] as number) * (1 - fx) +
        (pixels[y1 * picture.width + x1] as number) * fx;
      const value = (top * (1 - fy) + bottom * fy) / 255;
      const at = y * width + x;
      for (let channel = 0; channel < 3; channel++) {
        tensor[channel * plane + at] =
          (value - (MEAN[channel] as number)) / (SPREAD[channel] as number);
      }
    }
  }
  return tensor;
}

/** The size the detection model reads a picture at: a multiple of 32 each way, the longer side capped. */
function detectionSize(picture: PagePicture): { width: number; height: number } {
  const ratio = Math.min(1, MAX_DETECTION_SIDE / Math.max(picture.width, picture.height));
  return {
    width: Math.max(32, Math.round((picture.width * ratio) / 32) * 32),
    height: Math.max(32, Math.round((picture.height * ratio) / 32) * 32),
  };
}

export function createOnnxTextRecognizer(): TextRecognizer {
  let loaded: Loaded | undefined;
  let loading: Promise<Loaded> | undefined;

  async function load(detectorFile: string, recognizerFile: string): Promise<Loaded> {
    const ort = await ONNX_RUNTIME.load();
    const options = {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: threads(),
      // Each page and batch has a size of its own, so planning memory per size gains nothing,
      // and in Electron's utility process the arena's large blocks crashed it at the second page.
      // Without them, memory goes back as each page is done.
      enableCpuMemArena: false,
      enableMemPattern: false,
    } as const;
    const listed = onnxMetadata(await readFile(recognizerFile)).character;
    if (!listed) throw new Error("The recognition model has no character list.");
    const [detector, recognizer] = await Promise.all([
      ort.InferenceSession.create(detectorFile, options),
      ort.InferenceSession.create(recognizerFile, options),
    ]);
    return {
      key: JSON.stringify([detectorFile, recognizerFile]),
      ort,
      detector,
      recognizer,
      characters: listed.split("\n"),
    };
  }

  async function read(model: Loaded, picture: PagePicture): Promise<RecognizedLine[]> {
    const { ort, detector, recognizer, characters } = model;
    const size = detectionSize(picture);
    const input = new ort.Tensor("float32", detectionInput(picture, size.width, size.height), [
      1,
      3,
      size.height,
      size.width,
    ]);
    const detected = await detector.run({ [detector.inputNames[0] as string]: input });
    const map = detected[detector.outputNames[0] as string];
    if (!map) throw new Error("The detection model returned nothing.");
    const boxes = textBoxes(
      { width: size.width, height: size.height, data: map.data as Float32Array },
      size.width / picture.width,
      size.height / picture.height,
      picture.width,
      picture.height,
    );
    for (const tensor of Object.values(detected)) tensor.dispose();

    const image: GreyImage = picture;
    const lines = boxes.map((box) => {
      const frame = lineFrame(box.quad);
      return {
        box,
        frame,
        width: readWidth(frame),
        ratio: frame.length / Math.max(frame.breadth, 1),
      };
    });
    // Lines of like shape together, as PaddleOCR batches them: less padding.
    const order = lines
      .map((_, index) => index)
      .sort((a, b) => (lines[a]?.ratio ?? 0) - (lines[b]?.ratio ?? 0));
    const read: (RecognizedLine | null)[] = lines.map(() => null);
    for (let start = 0; start < order.length; start += BATCH) {
      const batch = order.slice(start, start + BATCH);
      const widest = Math.max(...batch.map((index) => lines[index]?.width ?? 1));
      const stride = Math.min(MAX_LINE_WIDTH, Math.max(MIN_LINE_WIDTH, widest));
      const plane = 3 * LINE_HEIGHT * stride;
      const data = new Float32Array(batch.length * plane);
      batch.forEach((index, slot) => {
        const line = lines[index];
        if (line)
          writeLine(image, line.frame, Math.min(line.width, stride), data, slot * plane, stride);
      });
      const output = await recognizer.run({
        [recognizer.inputNames[0] as string]: new ort.Tensor("float32", data, [
          batch.length,
          3,
          LINE_HEIGHT,
          stride,
        ]),
      });
      const probabilities = output[recognizer.outputNames[0] as string];
      if (!probabilities) throw new Error("The recognition model returned nothing.");
      const [, steps = 0, classes = 0] = probabilities.dims;
      const values = probabilities.data as Float32Array;
      batch.forEach((index, slot) => {
        const line = lines[index];
        if (!line) return;
        const decoded = decodeLine(
          values,
          slot * steps * classes,
          steps,
          classes,
          characters,
          Math.min(line.width, stride) / stride,
        );
        if (decoded.text.trim() === "" || decoded.confidence < MIN_LINE_CONFIDENCE) return;
        const [topLeft, topRight, bottomRight, bottomLeft] = line.box.quad;
        read[index] = {
          text: decoded.text,
          quad: [[...topLeft], [...topRight], [...bottomRight], [...bottomLeft]],
          confidence: decoded.confidence,
          characters: decoded.characters,
        };
      });
      for (const tensor of Object.values(output)) tensor.dispose();
    }
    return read.filter((line): line is RecognizedLine => line !== null);
  }

  return {
    async load(files) {
      const key = JSON.stringify([files.detector, files.recognizer]);
      if (loaded?.key === key) return;
      loading ??= load(files.detector, files.recognizer).finally(() => {
        loading = undefined;
      });
      const next = await loading;
      if (loaded && loaded !== next) {
        void loaded.detector.release();
        void loaded.recognizer.release();
      }
      loaded = next;
    },

    async read(picture) {
      if (!loaded) throw new Error("The text recognition model isn't loaded.");
      return read(loaded, picture);
    },

    async readFile(file) {
      const model = loaded;
      if (!model) throw new Error("The text recognition model isn't loaded.");
      return readDrawn(file, (picture) => read(model, picture));
    },

    close() {
      void loaded?.detector.release();
      void loaded?.recognizer.release();
      loaded = undefined;
    },
  };
}
