import { contextBridge, ipcRenderer } from "electron";
import type { ShapeEdit } from "../../../src/core/exports/pptxPatch/shapeEdit";

contextBridge.exposeInMainWorld("bench", {
  read: (path: string): Promise<Uint8Array> => ipcRenderer.invoke("bench:read", path),
  write: (path: string, bytes: Uint8Array): Promise<void> =>
    ipcRenderer.invoke("bench:write", path, bytes),
  edit: (bytes: Uint8Array, edits: ShapeEdit[]): Promise<Uint8Array> =>
    ipcRenderer.invoke("bench:edit", bytes, edits),
});
