const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("probe", { result: (line) => ipcRenderer.send("probe:result", line), done: () => ipcRenderer.send("probe:done") });
