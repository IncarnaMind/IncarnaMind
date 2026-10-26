import { createHook } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, mode, dataDir] = process.argv.slice(2);
if (!modulePath || !dataDir || (mode !== "resize" && mode !== "close")) {
  throw new Error(
    "Expected the window-state module, resize or close, and a temporary data folder.",
  );
}
const mockElectron = `export const screen = {};
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron"
      ? { url: `data:text/javascript,${encodeURIComponent(mockElectron)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { keepWindowPlace } = await import(pathToFileURL(modulePath).href);
const latest = { x: 100, y: 120, width: 1440, height: 660 };
class Window extends EventEmitter {
  bounds = { x: 0, y: 0, width: 1280, height: 800 };
  reads = 0;
  isDestroyed() {
    return false;
  }
  isMinimized() {
    return false;
  }
  isFullScreen() {
    return false;
  }
  isMaximized() {
    return false;
  }
  getNormalBounds() {
    this.reads++;
    queueMicrotask(() => finish(0));
    return { ...this.bounds };
  }
}
const window = new Window();
const file = join(dataDir, "window.json");
let target;
let arming = false;
let interrupted = false;
let finished = false;
const errors = [];
const saved = () => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};
const hook = createHook({
  init(id, type) {
    if (arming && type === "Timeout" && target === undefined) target = id;
  },
  before(id) {
    if (id !== target || interrupted) return;
    hook.disable();
    interrupted = true;
    window.bounds = { ...latest };
    window.emit(mode);
  },
});
function finish(code) {
  if (finished) return;
  finished = true;
  hook.disable();
  const result = { mode, interrupted, errors, saved: saved(), boundsReads: window.reads };
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(code));
}
process.on("uncaughtException", (error) => {
  errors.push({ name: error.name, message: error.message, stack: error.stack });
  finish(1);
});
keepWindowPlace(window, dataDir);
hook.enable();
arming = true;
window.emit("resize");
arming = false;
