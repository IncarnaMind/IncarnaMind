import "./stub";
import "../../../../src/renderer/src/fonts.css";
import "../../../../src/renderer/src/styles.css";
import "../../../../src/renderer/src/viewer/viewer.css";
import { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { imageDataUrl } from "../../../../src/core/documents/formats/pptx";
import {
  type DeckDrawing,
  drawPptx,
  type SlideDrawing,
} from "../../../../src/core/documents/formats/pptxDrawing";
import type { ShapeEdit } from "../../../../src/core/exports/pptxPatch/shapeEdit";
import { SlideCanvas } from "../../../../src/renderer/src/viewer/slides/SlideCanvas";
import { SlideEditor } from "../../../../src/renderer/src/viewer/slides/SlideEditor";
import { pictureParts } from "../../../../src/renderer/src/viewer/slides/pieces";

interface Bench {
  read: (path: string) => Promise<Uint8Array>;
  write: (path: string, bytes: Uint8Array) => Promise<void>;
  edit: (bytes: Uint8Array, edits: ShapeEdit[]) => Promise<Uint8Array>;
}
const bench = (window as unknown as { bench: Bench }).bench;

interface Shown {
  drawing: DeckDrawing;
  slide: SlideDrawing;
  images: Map<string, string | null>;
  scale: number;
  editable: boolean;
}

const state = {
  bytes: new Uint8Array(),
  edits: [] as ShapeEdit[],
  errors: [] as string[],
  commits: [] as number[],
  pending: 0,
  show: (_shown: Shown | null) => {},
};

async function shownOf(bytes: Uint8Array, number: number, editable: boolean, width: number): Promise<Shown> {
  const drawing = await drawPptx(bytes);
  const slide = drawing.slides.find((each) => each.number === number);
  if (!slide || !("items" in slide)) throw new Error(`slide ${number} can't be drawn`);
  const images = new Map<string, string | null>();
  for (const part of pictureParts(slide)) images.set(part, await imageDataUrl(bytes, part));
  return { drawing, slide, images, scale: Math.min(1, width / drawing.width), editable };
}

async function edited(edits: ShapeEdit[], number: number, width: number): Promise<boolean> {
  state.pending++;
  try {
    state.bytes = await bench.edit(state.bytes, edits);
    state.edits.push(...edits);
    state.show(await shownOf(state.bytes, number, true, width));
    return true;
  } catch (error) {
    state.errors.push(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    state.pending--;
  }
}

function Page() {
  const [shown, setShown] = useState<Shown | null>(null);
  state.show = setShown;
  if (!shown) return null;
  const { drawing, slide, images, scale } = shown;
  const width = drawing.width;
  const height = drawing.height;
  return (
    <div style={{ padding: 24, background: "#f3f2ef", minHeight: "100vh" }}>
      <div
        id="bench-slide"
        style={{ width: width * scale, height: height * scale, boxShadow: "0 0 0 1px #d8d6d0", background: "#fff" }}
      >
        <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", width, height }}>
          <Profiler id="slide" onRender={() => state.commits.push(performance.now())}>
            {shown.editable ? (
              <SlideEditor
                slide={slide}
                width={width}
                height={height}
                images={images}
                scale={scale}
                onEdit={(edits) => edited(edits, slide.number, 1400)}
              />
            ) : (
              <SlideCanvas slide={slide} width={width} height={height} images={images} ranges={null} />
            )}
          </Profiler>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  benchA: {
    state,
    async open(path: string, slide: number, editable = true) {
      state.bytes = await bench.read(path);
      state.edits = [];
      state.errors = [];
      state.show(await shownOf(state.bytes, slide, editable, 1400));
    },
    async goTo(slide: number, editable = true) {
      state.show(await shownOf(state.bytes, slide, editable, 1400));
    },
    async slides() {
      const drawing = await drawPptx(state.bytes);
      return drawing.slides.map((each) => ({ number: each.number, items: "items" in each ? each.items.length : -1 }));
    },
    save: (path: string) => bench.write(path, state.bytes),
  },
});

const root = document.getElementById("root");
if (root) createRoot(root).render(<Page />);
