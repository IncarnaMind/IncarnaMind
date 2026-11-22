import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  createDataFolder,
  dismissChatSetup,
  enterContent,
  frontMind,
  launchApp,
  newMind,
  removeDataFolder,
  urlsOpened,
} from "./app";
import { connectCanvasAgent, inCanvas, publishCanvas, showCanvasTab } from "./canvases";

test.skip(!SHOW_AGENT_CONNECTION, "Settings › AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * A Canvas an outside agent publishes (#3406) is the first content the app draws live that it didn't
 * write. Each test publishes pages that try every way out, through the agent connection as Claude
 * Code would, with Chromium's sandbox on, and a server, a UDP socket and a TCP listener on this
 * computer stand in for the network: none of them may hear anything, and no name may be looked up.
 */

let dataDir: string;
let home: string;
let files: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  files = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(files);
});

/** The network, on this computer: an HTTP server, a UDP socket (STUN, TURN) and a TCP listener (TURN). */
async function standIns() {
  const heard: string[] = [];
  const web = createHttpServer((request, response) => {
    heard.push(`http ${request.method} ${request.url}`);
    response.end("reached");
  });
  web.on("connection", () => heard.push("http connection"));
  web.on("upgrade", (request, socket) => {
    heard.push(`upgrade ${request.url}`);
    socket.destroy();
  });
  const tcp = createTcpServer((socket) => {
    heard.push("tcp connection");
    socket.destroy();
  });
  const udp = createSocket("udp4");
  udp.on("message", (message) => heard.push(`udp ${message.length} bytes`));
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  return {
    heard,
    web: `http://127.0.0.1:${(web.address() as AddressInfo).port}`,
    webPort: (web.address() as AddressInfo).port,
    tcp: (tcp.address() as AddressInfo).port,
    udp: udp.address().port,
    close() {
      web.close();
      tcp.close();
      udp.close();
    },
  };
}

/** Every file's path under a folder. */
const everyFile = async (folder: string): Promise<string[]> =>
  (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const logLines = async (event: string) =>
  (await readFile(join(dataDir, "logs", "incarnamind.log"), "utf8"))
    .split("\n")
    .filter((line) => line.includes(event));

test("a Canvas reaches no network, no file, no part of the app and no other Canvas, and keeps nothing", async () => {
  test.setTimeout(120_000);
  const network = await standIns();
  const { app, window } = await launchApp(dataDir, { home, sandboxed: true });
  try {
    await dismissChatSetup(window);
    const agent = await connectCanvasAgent(window);
    const looked = join(dataDir, "net-log.json");
    await app.evaluate(({ netLog }, file) => netLog.startLogging(file), looked);
    const prefetched = `canvas-probe-${randomUUID()}.example`;

    // One pixel: a Canvas's own picture draws, another Canvas's never does.
    await writeFile(join(files, "chart.png"), Buffer.from(PIXEL, "base64"));
    await writeFile(join(files, "app.js"), "window.ownScript = true;");
    const other = await publishCanvas(agent, "Other", "<p>Another Canvas</p>", [
      join(files, "chart.png"),
    ]);
    const otherUrl = (
      await window.evaluate(
        (id) => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.showCanvas(id),
        other,
      )
    ).url;
    const { web, tcp, udp } = network;
    const probes = await publishCanvas(
      agent,
      "Probes",
      `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${web}/style.css">
<link rel="dns-prefetch" href="//${prefetched}">
<link rel="preconnect" href="${web}">
<link rel="prefetch" href="${web}/prefetch">
<script src="${web}/script.js"></script>
<script src="app.js"></script>
<style>
@import url("${web}/import.css");
@font-face { font-family: Probe; src: url("${web}/font.woff2"); }
body { background: url("${web}/background.png"); font-family: Probe; }
</style></head><body>
<p>Probes</p>
<img src="${web}/img.png"><img id="own" src="chart.png"><img id="other" src="${otherUrl}chart.png">
<video src="${web}/video.mp4"></video><audio src="${web}/audio.mp3"></audio>
<object data="${web}/object"></object>
<iframe src="${web}/frame"></iframe>
<iframe srcdoc="<script>fetch('${web}/srcdoc')</script>"></iframe>
<form id="form" method="post" action="${web}/form"><input name="a" value="b"></form>
<script>
(async () => {
  const r = {};
  const attempt = async (name, run) => {
    try { r[name] = String(await run()); } catch (error) { r[name] = "refused"; }
  };
  await attempt("fetch", () => fetch("${web}/fetch").then((x) => x.status));
  await attempt("fetchOther", () => fetch("${otherUrl}chart.png").then((x) => x.status));
  await attempt("xhr", () => new Promise((ok, no) => {
    const x = new XMLHttpRequest(); x.open("GET", "${web}/xhr");
    x.onload = () => ok(x.status); x.onerror = () => no(new Error("xhr")); x.send();
  }));
  await attempt("webSocket", () => new Promise((ok, no) => {
    const w = new WebSocket("ws://127.0.0.1:${network.webPort}/ws");
    w.onopen = () => ok("open"); w.onerror = () => no(new Error("ws"));
  }));
  await attempt("eventSource", () => new Promise((ok, no) => {
    const e = new EventSource("${web}/events"); e.onopen = () => ok("open"); e.onerror = () => no(new Error("es"));
  }));
  await attempt("beacon", () => { navigator.sendBeacon("${web}/beacon", "x"); throw new Error("sent, to nowhere"); });
  await attempt("import", () => import("${web}/module.js"));
  await attempt("worker", () => new Promise((ok, no) => {
    const worker = new Worker("data:text/javascript,postMessage('ran');fetch('${web}/worker')");
    worker.onmessage = () => ok("ran");
    worker.onerror = () => no(new Error("refused"));
    setTimeout(() => no(new Error("never ran")), 3000);
  }));
  await attempt("form", () => { document.getElementById("form").submit(); throw new Error("sandboxed"); });
  await attempt("webrtc", async () => {
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: "stun:127.0.0.1:${udp}" },
      { urls: "turn:127.0.0.1:${tcp}?transport=tcp", username: "u", credential: "p" },
      { urls: "turn:127.0.0.1:${udp}?transport=udp", username: "u", credential: "p" },
    ] });
    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((done) => setTimeout(done, 4000));
    throw new Error("gathered, to nowhere");
  });
  await attempt("cookie", () => { document.cookie = "a=b"; return document.cookie; });
  await attempt("localStorage", () => localStorage.setItem("a", "b"));
  await attempt("indexedDB", () => indexedDB.open("probe"));
  await attempt("notification", () => Notification.requestPermission().then((p) => p === "granted" ? p : Promise.reject(new Error(p))));
  await attempt("geolocation", () => new Promise((ok, no) => navigator.geolocation.getCurrentPosition(() => ok("position"), () => no(new Error("denied")))));
  await attempt("pointerLock", () => document.body.requestPointerLock());
  await attempt("keyboardLock", () => navigator.keyboard.lock());
  await attempt("paste", () => document.execCommand("paste") || Promise.reject(new Error("no")));
  await attempt("popup", () => window.open("${web}/popup") || Promise.reject(new Error("no")));
  await attempt("download", () => {
    const a = document.createElement("a"); a.href = "data:text/plain,kept"; a.download = "kept.txt";
    document.body.append(a); a.click(); throw new Error("sandboxed");
  });
  window.print();
  r.reach = JSON.stringify({
    incarnamind: typeof window.incarnamind,
    files: typeof window.incarnamindFiles,
    require: typeof require,
    process: typeof process,
    top: window.top === window,
    parent: window.parent === window,
    opener: window.opener,
    bridge: typeof window.incarnamindCanvas,
    secure: window.isSecureContext,
    clipboard: typeof navigator.clipboard,
    serviceWorker: typeof navigator.serviceWorker,
    mediaDevices: typeof navigator.mediaDevices,
    caches: typeof caches,
    ownScript: window.ownScript === true,
  });
  r.pictures = JSON.stringify([document.getElementById("own").naturalWidth, document.getElementById("other").naturalWidth]);
  window.probes = r;
})();
</script></body></html>`,
      [join(files, "chart.png"), join(files, "app.js")],
    );
    const url = await showCanvasTab(window, probes);
    await expect
      .poll(() => inCanvas(app, url, "window.probes ?? null"), { timeout: 30_000 })
      .not.toBeNull();
    const results = (await inCanvas(app, url, "window.probes")) as Record<string, string>;
    const { reach, pictures, ...attempts } = results;
    expect(attempts).toEqual(
      Object.fromEntries(Object.keys(attempts).map((name) => [name, "refused"])),
    );
    expect(Object.keys(attempts)).toHaveLength(20);
    expect(JSON.parse(pictures ?? "[]"), "its own picture, and another Canvas's").toEqual([1, 0]);
    expect(JSON.parse(reach ?? "{}")).toEqual({
      incarnamind: "undefined",
      files: "undefined",
      require: "undefined",
      process: "undefined",
      top: true,
      parent: true,
      opener: null,
      bridge: "undefined",
      secure: false,
      clipboard: "undefined",
      serviceWorker: "undefined",
      mediaDevices: "undefined",
      caches: "undefined",
      ownScript: true,
    });

    // Still at its own address, in a window still at the app's; nothing downloaded, nothing opened.
    expect(await inCanvas(app, url, "location.href")).toBe(url);
    expect(await window.evaluate(() => location.protocol)).toMatch(/^(file|http):$/);
    expect(await everyFile(home)).not.toContainEqual(expect.stringContaining("kept"));
    expect(await urlsOpened(app)).toEqual([]);
    await app.evaluate(({ netLog }) => netLog.stopLogging());
    expect(await readFile(looked, "utf8")).not.toContain(prefetched);
    expect(network.heard).toEqual([]);
    await agent.close();
  } finally {
    await app.close();
    network.close();
  }
});

test("a Canvas never goes anywhere: a website it tries to open is only offered, and opens in the browser at the User's click", async () => {
  test.setTimeout(90_000);
  const network = await standIns();
  const { app, window } = await launchApp(dataDir, { home, sandboxed: true });
  try {
    await dismissChatSetup(window);
    const agent = await connectCanvasAgent(window);
    const { web } = network;
    const canvasId = await publishCanvas(
      agent,
      "Links",
      `<!doctype html><meta charset="utf-8"><p id="here">Links</p>
<a id="self" href="${web}/self">here</a><a id="blank" href="${web}/link" target="_blank">there</a>
<script>
const steps = [
  () => { location.href = "${web}/location"; },
  () => { location.href = "file:///etc/hosts"; },
  () => document.getElementById("self").click(),
  () => { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${web}/refresh"; document.head.append(m); },
  () => { window.top.location = "${web}/top"; },
  () => { window.open("${web}/open"); },
  () => document.getElementById("blank").click(),
];
steps.forEach((step, at) => setTimeout(step, 150 * (at + 1)));
setTimeout(() => { window.tried = true; }, 150 * (steps.length + 2));
</script>`,
    );
    const url = await showCanvasTab(window, canvasId);
    await expect
      .poll(() => inCanvas(app, url, "window.tried ?? null"), { timeout: 20_000 })
      .toBe(true);
    expect(await inCanvas(app, url, "location.href")).toBe(url);
    expect(await inCanvas(app, url, "document.getElementById('here')?.textContent")).toBe("Links");

    const offer = window.getByTestId("canvas-link");
    await expect(offer).toContainText("This Canvas links to 127.0.0.1");
    expect(await urlsOpened(app)).toEqual([]);
    await window.getByTestId("canvas-link-open").click();
    await expect.poll(() => urlsOpened(app)).toEqual([`${web}/link`]);
    await expect(offer).toHaveCount(0);
    expect(network.heard).toEqual([]);
    await agent.close();
  } finally {
    await app.close();
    network.close();
  }
});

test("a Canvas that loops forever or takes memory without end never holds the window: it alone stops", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, {
    home,
    sandboxed: true,
    extraEnv: { INCARNAMIND_TEST_CANVAS_MEMORY_MB: "300" },
  });
  try {
    await dismissChatSetup(window);
    const agent = await connectCanvasAgent(window);
    await newMind(window);
    await enterContent(window);
    const notes = await frontMind(window).getAttribute("data-mind-id");
    const loop = await publishCanvas(agent, "Loop", "<p>Loop</p><script>while (true) {}</script>");
    const memory = await publishCanvas(
      agent,
      "Memory",
      `<p>Memory</p><script>
const kept = [];
setInterval(() => { for (let i = 0; i < 8; i++) kept.push(new Uint8Array(16 * 1024 * 1024).fill(1)); }, 20);
</script>`,
    );

    // While the page that never stops is on screen, the window answers at once.
    const looping = await showCanvasTab(window, loop);
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, url) =>
            webContents.getAllWebContents().some((each) => each.getURL() === url),
          looping,
        ),
      )
      .toBe(true);
    await window.getByTestId("plus-menu").click();
    await expect(window.getByTestId("plus-new-mind")).toBeVisible({ timeout: 5_000 });
    await window.keyboard.press("Escape");
    await window.locator(`[data-testid="mind-tab"][data-mind-id="${notes}"]`).click();
    await enterContent(window);
    await window.keyboard.type("Still here.");
    await expect(frontMind(window).getByTestId("mind-editor")).toContainText("Still here.", {
      timeout: 5_000,
    });

    await showCanvasTab(window, memory);
    await expect(window.getByTestId("canvas-stopped")).toHaveText(
      /This Canvas stopped: it used more memory than a Canvas may\./,
      { timeout: 30_000 },
    );
    expect(await logLines("canvas.stopped")).toEqual([expect.stringContaining("memory")]);
    await window.locator(`[data-testid="mind-tab"][data-mind-id="${notes}"]`).click();
    await enterContent(window);
    await window.keyboard.type(" Still.");
    await expect(frontMind(window).getByTestId("mind-editor")).toContainText("Still here. Still.");
    await agent.close();
  } finally {
    await app.close();
  }
});
