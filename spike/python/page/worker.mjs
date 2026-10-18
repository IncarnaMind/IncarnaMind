// The module Worker that runs Python: Pyodide from the bundled files, numpy and pandas from
// the same place, no package index. It answers the page's requests by id.
import { loadPyodide } from "pyspike://app/dist/pyodide.mjs";

const started = performance.now();
let pyodide = null;
const timings = {};

async function boot() {
  const core = performance.now();
  pyodide = await loadPyodide({
    indexURL: "pyspike://app/dist/",
    lockFileURL: "pyspike://app/dist/pyodide-lock.json",
    packageBaseUrl: "pyspike://app/dist/",
    fullStdLib: false,
    stdout: () => {},
    stderr: () => {},
  });
  timings.core = performance.now() - core;
  const packages = performance.now();
  await pyodide.loadPackage(["numpy", "pandas"], { messageCallback: () => {}, errorCallback: () => {} });
  timings.packages = performance.now() - packages;
  const imports = performance.now();
  await pyodide.runPythonAsync("import numpy, pandas");
  timings.imports = performance.now() - imports;
  timings.total = performance.now() - started;
}

const settle = async (work) => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).split("\n").slice(-3).join(" | ") };
  }
};

/** What the Worker itself can reach, without Python. */
const JS_PROBES = {
  typeofs: async () => ({
    require: typeof globalThis.require,
    process: typeof globalThis.process,
    Buffer: typeof globalThis.Buffer,
    importScripts: typeof globalThis.importScripts,
    WebTransport: typeof globalThis.WebTransport,
    electron: typeof globalThis.electron,
    spikeBridge: typeof globalThis.spikeBridge,
  }),
  eval: async () => (0, eval)("1 + 1"),
  newFunction: async () => new Function("return 2")(),
  importNodeFs: async () => Object.keys(await import("node:fs")),
  importWeb: async () => Object.keys(await import("https://example.com/module.js")),
  importScriptsWeb: async () => globalThis.importScripts("https://example.com/script.js"),
  fetch: async () => (await fetch("https://example.com/")).status,
  fetchDns: async () => (await fetch("https://spike-dns-probe.example.org/")).status,
  fetchFile: async () => (await fetch("file:///etc/hosts")).status,
  xhr: async () =>
    new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.onload = () => resolve(request.status);
      request.onerror = () => reject(new Error("XMLHttpRequest failed"));
      request.open("GET", "https://example.com/");
      request.send();
    }),
  webSocket: async () =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket("wss://echo.websocket.org/");
      socket.onopen = () => resolve("open");
      socket.onerror = () => reject(new Error("WebSocket failed"));
    }),
  eventSource: async () =>
    new Promise((resolve, reject) => {
      if (typeof EventSource === "undefined") return reject(new Error("EventSource undefined"));
      const source = new EventSource("https://example.com/events");
      source.onopen = () => resolve("open");
      source.onerror = () => {
        source.close();
        reject(new Error("EventSource failed"));
      };
    }),
  webTransport: async () => {
    if (typeof WebTransport === "undefined") throw new Error("WebTransport undefined");
    const transport = new WebTransport("https://example.com:4433/");
    await transport.ready;
    return "ready";
  },
  indexedDbWrite: async () =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open("spike", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("marks");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const store = open.result.transaction("marks", "readwrite").objectStore("marks");
        store.put("left by the first run", "mark");
        store.transaction.oncomplete = () => resolve("written");
      };
    }),
  indexedDbRead: async () =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open("spike", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("marks");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const get = open.result.transaction("marks").objectStore("marks").get("mark");
        get.onsuccess = () => resolve(get.result ?? null);
      };
    }),
};

self.onmessage = async ({ data }) => {
  const { id, kind } = data;
  if (kind === "boot") {
    const result = await settle(boot);
    self.postMessage({ id, ...result, timings, memory: pyodide ? memory() : null });
    return;
  }
  if (kind === "python") {
    for (const [name, value] of Object.entries(data.globals ?? {})) pyodide.globals.set(name, value);
    const start = performance.now();
    const result = await settle(async () => {
      const value = await pyodide.runPythonAsync(data.code);
      const plain = value?.toJs ? value.toJs({ dict_converter: Object.fromEntries }) : value;
      value?.destroy?.();
      return plain;
    });
    self.postMessage({ id, ...result, ms: performance.now() - start, memory: memory() });
    return;
  }
  if (kind === "js") {
    const probe = JS_PROBES[data.name];
    const result = await settle(probe);
    self.postMessage({ id, ...result });
  }
};

/** Wasm memory Pyodide holds, in MB. */
function memory() {
  return Math.round(pyodide._module.HEAPU8.byteLength / 1048576);
}

self.postMessage({ kind: "alive" });
