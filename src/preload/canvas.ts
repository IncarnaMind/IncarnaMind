/**
 * The preload of a Canvas an outside agent wrote (#3406), in its own world beside the page's: it
 * tells the main process the page's height, and gives the page one function, to open a Citation.
 * Both go out as the two messages of `CANVAS_CHANNEL`, which the main process checks again by their
 * sender and shape: the page can write anything into them.
 */
import { contextBridge, ipcRenderer } from "electron";
import { CANVAS_BRIDGE_KEY, CANVAS_CHANNEL, type CanvasPageBridge } from "../shared/canvases";

const bridge: CanvasPageBridge = {
  openCitation: (cite) => ipcRenderer.send(CANVAS_CHANNEL, { kind: "cite", cite }),
};
contextBridge.exposeInMainWorld(CANVAS_BRIDGE_KEY, bridge);

let told = -1;
let waiting = false;
const tellHeight = () => {
  waiting = false;
  const height = Math.ceil(document.documentElement.scrollHeight);
  if (height === told) return;
  told = height;
  ipcRenderer.send(CANVAS_CHANNEL, { kind: "height", height });
};
const heightChanged = () => {
  if (waiting) return;
  waiting = true;
  requestAnimationFrame(tellHeight);
};

window.addEventListener("DOMContentLoaded", () => {
  const observer = new ResizeObserver(heightChanged);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  heightChanged();
});
