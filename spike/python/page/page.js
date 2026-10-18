// The hidden window's page: it starts the Worker, passes the main process's requests to it and
// its answers back through the preload, and runs the probes that only a page can try.
const bridge = globalThis.spikeBridge;
let worker = null;
let alive = null;
const pending = new Map();
let next = 0;

function startWorker() {
  worker?.terminate();
  worker = new Worker("pyspike://app/page/worker.mjs", { type: "module" });
  alive = new Promise((resolve) => {
    worker.addEventListener("message", ({ data }) => {
      if (data.kind === "alive") resolve();
    });
  });
  worker.onmessage = ({ data }) => {
    if (data.kind === "alive") return;
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  };
  worker.onerror = (event) => {
    for (const resolve of pending.values()) resolve({ ok: false, error: `worker error: ${event.message}` });
    pending.clear();
  };
}

const ask = async (message) => {
  await alive;
  return new Promise((resolve) => {
    const id = ++next;
    pending.set(id, resolve);
    worker.postMessage({ ...message, id });
  });
};

const settle = async (work) => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
};

const PAGE_PROBES = {
  typeofs: async () => ({
    require: typeof globalThis.require,
    process: typeof globalThis.process,
    module: typeof globalThis.module,
    electron: typeof globalThis.electron,
    bridge: Object.keys(bridge ?? {}),
  }),
  fetch: async () => (await fetch("https://example.com/")).status,
  image: async () =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve("loaded");
      image.onerror = () => reject(new Error("image failed"));
      image.src = "https://example.com/favicon.ico";
    }),
  css: async () =>
    new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://example.com/style.css";
      link.onload = () => resolve("loaded");
      link.onerror = () => reject(new Error("stylesheet failed"));
      document.head.append(link);
    }),
  formPost: async () => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = "https://example.com/form";
    document.body.append(form);
    form.submit();
    return "submitted";
  },
  navigate: async () => {
    location.href = "https://example.com/";
    return "asked";
  },
  windowOpen: async () => String(window.open("https://example.com/")),
  download: async () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["spike"], { type: "text/plain" }));
    link.download = "spike.txt";
    document.body.append(link);
    link.click();
    return "clicked";
  },
  storageWrite: async () => {
    localStorage.setItem("spike", "left by the first run");
    sessionStorage.setItem("spike", "left by the first run");
    return "written";
  },
  storageRead: async () => ({ local: localStorage.getItem("spike"), session: sessionStorage.getItem("spike") }),
  restartWorker: async () => {
    const start = performance.now();
    startWorker();
    const booted = await ask({ kind: "boot" });
    return { ms: performance.now() - start, booted };
  },
};

bridge.onRequest(async (request) => {
  let reply;
  if (request.kind === "page") reply = await settle(PAGE_PROBES[request.name]);
  else reply = await ask(request);
  bridge.reply(request.requestId, reply);
});

startWorker();
bridge.ready();
