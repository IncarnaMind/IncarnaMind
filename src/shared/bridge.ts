/** Names shared by the main process and the preload script for the typed core bridge. */
import type { AudioSource, CoreApiMethod } from "../core/api";
import type { MenuCommandId } from "./commands";
import type { GeneralHelpKind } from "./meetingHelp";
import type { PanelCommand, PanelState } from "./meetingPanel";
import type { PanelName } from "./panels";
import type { GuidePlacement, PermissionGuideState } from "./permissionGuide";
import type { TitleBar } from "./titleBar";

/** The renderer reaches the core as `window.incarnamind`. */
export const BRIDGE_KEY = "incarnamind";

export const channelFor = (method: CoreApiMethod): string => `core:${method}`;

/** The one channel the main process uses to push core events to the renderer: (event name, payload). */
export const EVENT_CHANNEL = "core:event";

/**
 * Helpers the preload script adds next to the core, as `window.incarnamindFiles`.
 * They need Electron (in the renderer's process, or the main process's dialogs
 * and shell), so they aren't part of the core's API.
 */
export const FILES_BRIDGE_KEY = "incarnamindFiles";

export interface FilesBridge {
  /** The absolute path of a dropped or picked file, or "" for a file that isn't on disk. */
  pathForFile(file: File): string;
  /** Shows a file IncarnaMind saved (`CoreApi.saveMindExport`), selected in the system's file manager. */
  showSavedFile(path: string): Promise<void>;
  /** Opens a file IncarnaMind saved (`CoreApi.saveMindExport`) in the system's default app for it. */
  openSavedFile(path: string): Promise<void>;
  /**
   * Shows the system's open dialog for the Output location (see
   * `CoreApi.setOutputLocation`), starting at the current one. Resolves with
   * the folder's absolute path, or null if the User cancelled.
   */
  pickOutputLocation(): Promise<string | null>;
  /**
   * Saves the Mind as a .docx where the User chooses, in the system's save dialog: a copy of
   * changes storage refused (#1119). False when they chose nowhere.
   */
  saveMindCopy(mindId: string): Promise<boolean>;
  /** Shows the data folder in the system's file manager, e.g. to back it up. */
  openDataFolder(): Promise<void>;
  /** Shows the data folder's `logs/` in the system's file manager, e.g. to attach the log to a bug report. */
  openLogsFolder(): Promise<void>;
  /**
   * Shows the system's open dialog for a Skill to import: a folder, or a zip
   * file. Resolves with its absolute path, or null if the User cancelled.
   */
  pickSkill(kind: SkillPickKind): Promise<string | null>;
  /**
   * Opens a Document's file, where the User keeps it, in the system's default
   * app for its type. Rejects for a deleted Document, or one whose file is
   * missing or can't be reached.
   */
  openDocumentExternally(documentId: string): Promise<void>;
  /**
   * Shows a Document's file selected in the system's file manager. Rejects
   * as `openDocumentExternally` does.
   */
  showDocumentInFolder(documentId: string): Promise<void>;
  /**
   * Shows the system's open dialog for a folder to link (see
   * `CoreApi.addLinkedFolder`), or, given a Linked folder's id, for where
   * that folder is now (see `CoreApi.locateLinkedFolder`). Resolves with its
   * absolute path, or null if the User cancelled.
   */
  pickLinkedFolder(locating?: string): Promise<string | null>;
  /**
   * Shows the system's open dialog for Documents to add, as a sheet on the
   * window, starting in the folder last picked from (else Downloads).
   * Resolves with their absolute paths, or none if the User cancelled.
   */
  pickDocuments(): Promise<string[]>;
  /**
   * Shows the system's open dialog for a reference file to import (CSL JSON,
   * BibTeX or RIS: see `CoreApi.importReferences`), as a sheet on the window,
   * starting in the folder last picked from (else Downloads). Resolves with
   * its absolute path, or null if the User cancelled.
   */
  pickReferenceFile(): Promise<string | null>;
  /**
   * Shows the system's open dialog for a Word file to import as a Mind (see
   * `CoreApi.importWordFile`), as a sheet on the window, starting in the folder
   * last picked from (else Downloads). Resolves with its absolute path, or null
   * if the User cancelled.
   */
  pickWordFile(): Promise<string | null>;
  /** As `pickWordFile`, for a PDF to verify (see `CoreApi.verifyDocument`). */
  pickPdfFile(): Promise<string | null>;
  /**
   * Shows a Linked folder selected in the system's file manager (Finder,
   * Explorer). Rejects for an unknown Linked folder, or one that can't be
   * reached.
   */
  showLinkedFolder(linkedFolderId: string): Promise<void>;
  /**
   * Whether Chromium's sandbox is off for this app (`--no-sandbox` or
   * `ELECTRON_DISABLE_SANDBOX`), the check Analyses make too: the window says so.
   */
  runsWithoutSandbox(): Promise<boolean>;
  /** Writes an error nothing in the window caught to the log, scrubbed of the User's content. */
  logError(report: RendererErrorReport): void;
  /** Calls `listener` with each command chosen in the application menu. Returns how to stop. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  /** Tells the application menu whether the sidebar is hidden, so View says "Hide Sidebar" or "Show Sidebar". */
  setSidebarHidden(hidden: boolean): void;
  /** Tells the Edit menu where Undo and Redo go now, and what they would take back or do again. */
  setEditMenu(state: EditMenuState): void;
  /** Pastes where the focus is, as Edit › Paste does, for a menu's Paste: the page can't read the clipboard. */
  paste(): void;
  /** The Mind File › Export names: its name, or null when no Mind is open, which disables the item. */
  setExportMenu(mindName: string | null): void;
  /** Whether the examples are removed: Help › Show the examples again appears only then. */
  setExamplesRemoved(removed: boolean): void;
  /** The window's title bar (./titleBar.ts), for the page to keep room for the window's buttons. */
  readonly titleBar: TitleBar;
  /**
   * Calls `listener` with true when the window enters full screen, where
   * macOS hides its traffic lights, and false when it leaves. Returns how to stop.
   */
  onFullScreenChange(listener: (fullScreen: boolean) => void): () => void;
  /**
   * Calls `listener` when a help button's global shortcut is pressed during a call while
   * the floating panel isn't shown: the window asks for that help itself. Returns how to stop.
   */
  onMeetingHelp(listener: (kind: GeneralHelpKind) => void): () => void;
  /** Whether no other app holds these keys as its global shortcut, as far as the system says. */
  globalKeysFree(keys: string): Promise<boolean>;
  /**
   * Says which keys the window binds itself, in the form `keysForm` gives. A meeting shortcut the
   * User set to one of them is held only while another app is in front.
   */
  windowKeys(forms: readonly string[]): void;
  /** Shows the floating panel during a call again after the User closed it, or hides it. */
  showMeetingPanel(shown: boolean): void;
  /** Calls `listener` with the floating panel's state, now and when it changes. Returns how to stop. */
  onMeetingPanel(listener: (state: PanelState) => void): () => void;
  /** ⌘K: pins the floating panel's latest suggestion, or folds or unfolds the panel. */
  meetingPanelCommand(command: PanelCommand): void;
  /** Calls `listener` when the floating panel's Set up was clicked: the window shows where a model is chosen. */
  onSetUpModel(listener: () => void): () => void;
  /**
   * Shows the guide for a permission the User must add by hand in System Settings (#1105), beside
   * it if the screen has room: where it showed, "none" where this system has no such guide.
   */
  showPermissionGuide(source: AudioSource): Promise<GuidePlacement>;
  /** Closes the guide, and the steps in the window. */
  closePermissionGuide(): void;
  /** Calls `listener` with the guide's state, now and when it changes; null when there is none. Returns how to stop. */
  onPermissionGuide(listener: (state: PermissionGuideState | null) => void): () => void;
}

/** The command the application menu asks the window to run (see src/main/menu.ts). */
export type MenuCommand = MenuCommandId;

/**
 * What the Edit menu's Undo and Redo show for the window in front: whether the
 * focus is in a field or the note, whose own undo they reach, or neither (`text`
 * null), where they reach the app's changes. `undo` and `redo` name the change
 * each would reach ("Move 3 Documents"; "" for one without a name), or are null
 * when there is none. The window decides where they go when they are chosen.
 */
export interface EditMenuState {
  text: "field" | "note" | null;
  undo: string | null;
  redo: string | null;
}

export type SkillPickKind = "folder" | "zip";

/**
 * An error nothing in the window caught: a thrown error, or a rejected promise nobody handled.
 * Or, with `panel`, one a panel's boundary caught while it drew (#1500): the panel that failed,
 * and React's component stack, the components it was drawing.
 */
export interface RendererErrorReport {
  kind: "error" | "rejection";
  name: string;
  message: string;
  stack: string;
  panel?: PanelName;
  componentStack?: string;
}

/** The main process's channels for the `FilesBridge` methods that need it. */
export const FILES_CHANNELS = {
  showSavedFile: "files:showSavedFile",
  openSavedFile: "files:openSavedFile",
  pickOutputLocation: "files:pickOutputLocation",
  saveMindCopy: "files:saveMindCopy",
  openDataFolder: "files:openDataFolder",
  openLogsFolder: "files:openLogsFolder",
  pickSkill: "files:pickSkill",
  openDocumentExternally: "files:openDocumentExternally",
  showDocumentInFolder: "files:showDocumentInFolder",
  pickLinkedFolder: "files:pickLinkedFolder",
  pickDocuments: "files:pickDocuments",
  pickReferenceFile: "files:pickReferenceFile",
  pickWordFile: "files:pickWordFile",
  pickPdfFile: "files:pickPdfFile",
  showLinkedFolder: "files:showLinkedFolder",
  runsWithoutSandbox: "files:runsWithoutSandbox",
  logError: "files:logError",
  /** From the page: the sidebar is hidden (true) or shown (false), for the View menu's label. */
  sidebarHidden: "app:sidebarHidden",
  /** From the page: where the Edit menu's Undo and Redo go now (`EditMenuState`). */
  editMenu: "app:editMenu",
  /** From the page: paste where the focus is (`paste`). */
  paste: "app:paste",
  exportMenu: "app:exportMenu",
  examplesRemoved: "app:examplesRemoved",
  /** From the main process: a command chosen in the application menu. */
  menuCommand: "app:menuCommand",
  /** From the main process: the window entered (true) or left (false) full screen. */
  fullScreen: "app:fullScreen",
  /** From the main process: a help button's shortcut was pressed with no floating panel shown. */
  meetingHelp: "app:meetingHelp",
  globalKeysFree: "app:globalKeysFree",
  /** From the page: the keys the window binds itself (`windowKeys`). */
  windowKeys: "app:windowKeys",
  /** From the page: show (true) or hide (false) the floating panel. */
  showMeetingPanel: "app:showMeetingPanel",
  /** From the page: what the floating panel's state is now; the main process answers on `meetingPanel`. */
  meetingPanelWanted: "app:meetingPanelWanted",
  /** From the main process: the floating panel's state (`PanelState`). */
  meetingPanel: "app:meetingPanel",
  /** From the page: a `PanelCommand` for the floating panel. */
  meetingPanelCommand: "app:meetingPanelCommand",
  /** From the main process: the floating panel's Set up was clicked. */
  setUpModel: "app:setUpModel",
  /** From the page: show the guide beside System Settings for a source; the main process answers where. */
  showPermissionGuide: "app:showPermissionGuide",
  closePermissionGuide: "app:closePermissionGuide",
  /** From the page: what the guide's state is now; the main process answers on `permissionGuide`. */
  permissionGuideWanted: "app:permissionGuideWanted",
  /** From the main process: the guide's state (`PermissionGuideState`), or null. */
  permissionGuide: "app:permissionGuide",
} as const;
