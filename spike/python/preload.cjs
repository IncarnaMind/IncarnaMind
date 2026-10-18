// Passes messages between the main process and the page, and nothing else.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spikeBridge", {
  ready: () =>
    ipcRenderer.send("spike:ready", {
      sandboxed: process.sandboxed === true,
      contextIsolated: process.contextIsolated === true,
    }),
  reply: (requestId, reply) => ipcRenderer.send("spike:reply", requestId, reply),
  onRequest: (listener) => ipcRenderer.on("spike:request", (_event, request) => listener(request)),
});
