/**
 * Exposes the core's public interface to the renderer as `window.incarnamind`.
 * Runs sandboxed with context isolation: the renderer gets these functions and
 * nothing else from Node or Electron.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  type CoreApi,
  type CoreBridge,
  type CoreEventListener,
  type CoreEventName,
  coreApiMethods,
} from "../core/api";
import {
  BRIDGE_KEY,
  channelFor,
  EVENT_CHANNEL,
  FILES_BRIDGE_KEY,
  FILES_CHANNELS,
  type FilesBridge,
  type MenuCommand,
} from "../shared/bridge";
import {
  CITED_PAGE_ARGUMENT,
  CITED_PAGE_BRIDGE_KEY,
  CITED_PAGE_CHANNELS,
  type CitedPageBridge,
} from "../shared/citedPage";
import type { GeneralHelpKind } from "../shared/meetingHelp";
import {
  type HeldKeys,
  MEETING_PANEL_ARGUMENT,
  MEETING_PANEL_BRIDGE_KEY,
  MEETING_PANEL_CHANNELS,
  type MeetingPanelBridge,
  type PanelCommand,
  type PanelState,
} from "../shared/meetingPanel";
import {
  PERMISSION_GUIDE_ARGUMENT,
  PERMISSION_GUIDE_BRIDGE_KEY,
  PERMISSION_GUIDE_CHANNELS,
  type PermissionGuideBridge,
  type PermissionGuideState,
} from "../shared/permissionGuide";
import { titleBarOf } from "../shared/titleBar";

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const receive = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => {
    ipcRenderer.removeListener(channel, receive);
  };
}

const methods = Object.fromEntries(
  coreApiMethods.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(channelFor(method), ...args),
  ]),
) as unknown as CoreApi;

// One IPC listener for all core events, fanned out to the renderer's listeners by event name.
const listeners = new Map<string, Set<(payload: unknown) => void>>();
ipcRenderer.on(EVENT_CHANNEL, (_event, name: string, payload: unknown) => {
  for (const listener of listeners.get(name) ?? []) {
    try {
      listener(payload);
    } catch (error) {
      console.error(error);
    }
  }
});

const bridge: CoreBridge = {
  ...methods,
  on<E extends CoreEventName>(event: E, listener: CoreEventListener<E>) {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    const entry = listener as (payload: unknown) => void;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);

// A sandboxed renderer can't see where a dropped or picked file lives; Electron's preload can.
const files: FilesBridge = {
  pathForFile: (file) => webUtils.getPathForFile(file),
  decodePicture: (bytes) => ipcRenderer.invoke(FILES_CHANNELS.decodePicture, bytes),
  showSavedFile: (path) => ipcRenderer.invoke(FILES_CHANNELS.showSavedFile, path),
  openSavedFile: (path) => ipcRenderer.invoke(FILES_CHANNELS.openSavedFile, path),
  pickOutputLocation: () => ipcRenderer.invoke(FILES_CHANNELS.pickOutputLocation),
  saveMindCopy: (mindId) => ipcRenderer.invoke(FILES_CHANNELS.saveMindCopy, mindId),
  openDataFolder: () => ipcRenderer.invoke(FILES_CHANNELS.openDataFolder),
  openLogsFolder: () => ipcRenderer.invoke(FILES_CHANNELS.openLogsFolder),
  pickSkill: (kind) => ipcRenderer.invoke(FILES_CHANNELS.pickSkill, kind),
  openDocumentExternally: (documentId) =>
    ipcRenderer.invoke(FILES_CHANNELS.openDocumentExternally, documentId),
  showDocumentInFolder: (documentId) =>
    ipcRenderer.invoke(FILES_CHANNELS.showDocumentInFolder, documentId),
  pickLinkedFolder: (locating) => ipcRenderer.invoke(FILES_CHANNELS.pickLinkedFolder, locating),
  pickDocuments: () => ipcRenderer.invoke(FILES_CHANNELS.pickDocuments),
  pickDocumentsOrFolder: () => ipcRenderer.invoke(FILES_CHANNELS.pickDocumentsOrFolder),
  pickReferenceFile: () => ipcRenderer.invoke(FILES_CHANNELS.pickReferenceFile),
  pickWordFile: () => ipcRenderer.invoke(FILES_CHANNELS.pickWordFile),
  pickFileToVerify: () => ipcRenderer.invoke(FILES_CHANNELS.pickFileToVerify),
  showLinkedFolder: (linkedFolderId) =>
    ipcRenderer.invoke(FILES_CHANNELS.showLinkedFolder, linkedFolderId),
  runsWithoutSandbox: () => ipcRenderer.invoke(FILES_CHANNELS.runsWithoutSandbox),
  takeUnexpectedEnd: () => ipcRenderer.invoke(FILES_CHANNELS.takeUnexpectedEnd),
  logError: (report) => ipcRenderer.send(FILES_CHANNELS.logError, report),
  onMenuCommand: (listener) => {
    const receive = (_event: unknown, command: MenuCommand) => listener(command);
    ipcRenderer.on(FILES_CHANNELS.menuCommand, receive);
    return () => {
      ipcRenderer.removeListener(FILES_CHANNELS.menuCommand, receive);
    };
  },
  setSidebarHidden: (hidden) => ipcRenderer.send(FILES_CHANNELS.sidebarHidden, hidden),
  setEditMenu: (state) => ipcRenderer.send(FILES_CHANNELS.editMenu, state),
  paste: () => ipcRenderer.send(FILES_CHANNELS.paste),
  setExportMenu: (mindName) => ipcRenderer.send(FILES_CHANNELS.exportMenu, mindName),
  setExamplesRemoved: (removed) => ipcRenderer.send(FILES_CHANNELS.examplesRemoved, removed),
  titleBar: titleBarOf(process.platform),
  onFullScreenChange: (listener) => {
    const receive = (_event: unknown, fullScreen: boolean) => listener(fullScreen);
    ipcRenderer.on(FILES_CHANNELS.fullScreen, receive);
    return () => {
      ipcRenderer.removeListener(FILES_CHANNELS.fullScreen, receive);
    };
  },
  onMeetingHelp: (listener) => listen<GeneralHelpKind>(FILES_CHANNELS.meetingHelp, listener),
  globalKeysFree: (keys) => ipcRenderer.invoke(FILES_CHANNELS.globalKeysFree, keys),
  windowKeys: (forms) => ipcRenderer.send(FILES_CHANNELS.windowKeys, forms),
  showMeetingPanel: (shown) => ipcRenderer.send(FILES_CHANNELS.showMeetingPanel, shown),
  meetingPanelCommand: (command) => ipcRenderer.send(FILES_CHANNELS.meetingPanelCommand, command),
  onMeetingPanel: (listener) => {
    const stop = listen<PanelState>(FILES_CHANNELS.meetingPanel, listener);
    ipcRenderer.send(FILES_CHANNELS.meetingPanelWanted);
    return stop;
  },
  onSetUpModel: (listener) => listen<void>(FILES_CHANNELS.setUpModel, () => listener()),
  showPermissionGuide: (source) => ipcRenderer.invoke(FILES_CHANNELS.showPermissionGuide, source),
  closePermissionGuide: () => ipcRenderer.send(FILES_CHANNELS.closePermissionGuide),
  onPermissionGuide: (listener) => {
    const stop = listen<PermissionGuideState | null>(FILES_CHANNELS.permissionGuide, listener);
    ipcRenderer.send(FILES_CHANNELS.permissionGuideWanted);
    return stop;
  },
};

// The hidden window that draws a cited page (#133) shows the viewer's views, which need the core,
// and says to the main process where it drew the page; it needs none of the file helpers.
if (process.argv.includes(CITED_PAGE_ARGUMENT)) {
  const citedPage: CitedPageBridge = {
    request: () => ipcRenderer.invoke(CITED_PAGE_CHANNELS.request),
    resize: (height) => ipcRenderer.invoke(CITED_PAGE_CHANNELS.resize, height),
    drawn: (layout) => ipcRenderer.send(CITED_PAGE_CHANNELS.drawn, layout),
    failed: (reason) => ipcRenderer.send(CITED_PAGE_CHANNELS.failed, reason),
  };
  contextBridge.exposeInMainWorld(CITED_PAGE_BRIDGE_KEY, citedPage);
} else {
  contextBridge.exposeInMainWorld(FILES_BRIDGE_KEY, files);
}

// The floating panel during a call has the file helpers too, for the window's error log.
if (process.argv.includes(MEETING_PANEL_ARGUMENT)) {
  const panel: MeetingPanelBridge = {
    resize: (width, height) => ipcRenderer.send(MEETING_PANEL_CHANNELS.size, width, height),
    close: () => ipcRenderer.send(MEETING_PANEL_CHANNELS.close),
    setUp: () => ipcRenderer.send(MEETING_PANEL_CHANNELS.setUp),
    keys: () => ipcRenderer.invoke(MEETING_PANEL_CHANNELS.keys),
    onKeys: (listener) => listen<HeldKeys>(MEETING_PANEL_CHANNELS.keysChanged, listener),
    onHelp: (listener) => listen<GeneralHelpKind>(MEETING_PANEL_CHANNELS.help, listener),
    state: (state) => ipcRenderer.send(MEETING_PANEL_CHANNELS.state, state),
    onCommand: (listener) => listen<PanelCommand>(MEETING_PANEL_CHANNELS.command, listener),
  };
  contextBridge.exposeInMainWorld(MEETING_PANEL_BRIDGE_KEY, panel);
}

// The guide beside System Settings has the file helpers too, for the window's error log.
if (process.argv.includes(PERMISSION_GUIDE_ARGUMENT)) {
  const guide: PermissionGuideBridge = {
    resize: (width, height) => ipcRenderer.send(PERMISSION_GUIDE_CHANNELS.size, width, height),
    close: () => ipcRenderer.send(PERMISSION_GUIDE_CHANNELS.close),
    state: () => ipcRenderer.invoke(PERMISSION_GUIDE_CHANNELS.state),
    onState: (listener) =>
      listen<PermissionGuideState | null>(PERMISSION_GUIDE_CHANNELS.state, listener),
  };
  contextBridge.exposeInMainWorld(PERMISSION_GUIDE_BRIDGE_KEY, guide);
}
