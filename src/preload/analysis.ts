/**
 * The analysis window's preload (ADR-0023): its page gets jobs from the main
 * process and sends back what they came to. Nothing else: no core, no files.
 * The Worker that runs Python can't reach it.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  ANALYSIS_BRIDGE_KEY,
  ANALYSIS_CHANNELS,
  type AnalysisBridge,
  type AnalysisRequest,
} from "../shared/analysisWindow";

const bridge: AnalysisBridge = {
  onRun: (listener) => {
    ipcRenderer.on(ANALYSIS_CHANNELS.run, (_event, request: AnalysisRequest) => listener(request));
  },
  ready: (state) => ipcRenderer.send(ANALYSIS_CHANNELS.ready, state),
  started: (id) => ipcRenderer.send(ANALYSIS_CHANNELS.started, id),
  done: (reply) => ipcRenderer.send(ANALYSIS_CHANNELS.done, reply),
};

contextBridge.exposeInMainWorld(ANALYSIS_BRIDGE_KEY, bridge);
