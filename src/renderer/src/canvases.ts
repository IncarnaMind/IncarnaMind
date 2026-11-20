/**
 * The Canvases outside agents publish (#3406), as the window knows them: read once as the window
 * starts (the store's `load`), then kept as the core says the list changed.
 */
import { create } from "zustand";
import type { Canvas } from "../../core/api";
import { core } from "./core";

export const useCanvases = create<{ canvases: readonly Canvas[] }>()(() => ({ canvases: [] }));

export const canvasOf = (canvasId: string): Canvas | null =>
  useCanvases.getState().canvases.find((canvas) => canvas.id === canvasId) ?? null;

export async function loadCanvases(): Promise<void> {
  useCanvases.setState({ canvases: await core.listCanvases() });
}

core.on("canvases.changed", (canvases) => useCanvases.setState({ canvases }));

/** Where each Canvas shown in this window is drawn now, by its id: for what asks about it. */
const drawnAt = new Map<string, string>();

export const canvasFrameOf = (canvasId: string): string | null => drawnAt.get(canvasId) ?? null;

/** Says where a Canvas is drawn, until the returned function says it no longer is. */
export function drawnCanvas(canvasId: string, frameUrl: string): () => void {
  drawnAt.set(canvasId, frameUrl);
  return () => {
    if (drawnAt.get(canvasId) === frameUrl) drawnAt.delete(canvasId);
  };
}
