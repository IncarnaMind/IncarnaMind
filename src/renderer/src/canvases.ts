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
