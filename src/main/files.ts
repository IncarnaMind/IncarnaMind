/**
 * The main process's half of the renderer's file helpers (`FilesBridge`):
 * choosing the Output location and showing a file saved there, showing the data and logs
 * folders, choosing a Skill folder or zip to import, choosing a folder to
 * link or where a Linked folder is now, opening a Document's file in another
 * app or showing it (or a Linked folder) in the file manager, and logging the
 * window's uncaught errors. The core saves
 * files, reads the Skill, and checks a Document is live and its
 * file there before it hands the file's path to the shell adapter; only
 * this side touches dialogs.
 */
import { mkdir, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  type OpenDialogOptions,
  shell,
} from "electron";
import type { Core } from "../core";
import { addFilesTitleByPlatform } from "../shared/addFilesAction";
import { FILES_CHANNELS } from "../shared/bridge";
import { type MessageKey, translate } from "../shared/i18n";
import { sandboxOff } from "./analysisPaths";
import { handle } from "./ipc";
import { type FileLogger, logsFolder, logWindowError } from "./log";
import {
  isEditMenuState,
  setEditMenu,
  setExamplesRemoved,
  setExportMenu,
  setMenuSidebarHidden,
} from "./menu";
import { rememberPick, startFolder, startNear } from "./pickerFolders";
import { showOpenDialog } from "./systemDialogs";
import { saveMindCopy } from "./unsavedChanges";

/** What "Add Documents" offers; the core decides what it takes (and says what it skipped). */
const DOCUMENT_EXTENSIONS = ["pdf", "docx", "pptx", "xlsx", "csv", "txt", "md", "markdown"];

/** What "Import references" offers; the core reads the format from what is in the file. */
const REFERENCE_EXTENSIONS = ["json", "bib", "bibtex", "ris", "txt"];

export interface FileActionsOptions {
  /** The data folder, which "Open data folder" shows. */
  dataDir: string;
  /** Whether a call comes from IncarnaMind's own page. */
  trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean;
  /** Where the window's uncaught errors are logged. */
  logger: FileLogger;
}

export function serveFileActions(
  core: Core,
  { dataDir, trusted, logger }: FileActionsOptions,
): void {
  const refuseUnknown = (event: IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error("Refused a call from an unknown page.");
  };

  /** Opens a folder in the system's file manager, or a file in its default app. */
  const openPath = async (path: string) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  };

  // The core checks it saved the file, then shows it through the shell adapter.
  handle(FILES_CHANNELS.showSavedFile, async (event, path: unknown) => {
    refuseUnknown(event);
    await core.showSavedFile(path as string);
  });

  handle(FILES_CHANNELS.openSavedFile, async (event, path: unknown) => {
    refuseUnknown(event);
    await core.openSavedFile(path as string);
  });

  handle(FILES_CHANNELS.pickOutputLocation, async (event): Promise<string | null> => {
    refuseUnknown(event);
    const [{ language }, { location }] = await Promise.all([
      core.getSettings(),
      core.getOutputSettings(),
    ]);
    const openOptions: OpenDialogOptions = {
      title: translate(language, "outputLocation.pick.title"),
      buttonLabel: translate(language, "outputLocation.pick.button"),
      properties: ["openDirectory", "createDirectory", "promptToCreate"],
      defaultPath: location ?? startFolder(dataDir, "folders", app.getPath("home")),
    };
    const { canceled, filePaths } = await showOpenDialog(
      BrowserWindow.fromWebContents(event.sender),
      openOptions,
    );
    return canceled ? null : (filePaths[0] ?? null);
  });

  handle(FILES_CHANNELS.saveMindCopy, async (event, mindId: unknown): Promise<boolean> => {
    refuseUnknown(event);
    if (typeof mindId !== "string") throw new Error("A Mind id must be a string.");
    return saveMindCopy(core, BrowserWindow.fromWebContents(event.sender), mindId);
  });

  handle(FILES_CHANNELS.openDataFolder, async (event) => {
    refuseUnknown(event);
    await openPath(dataDir);
  });

  handle(FILES_CHANNELS.openLogsFolder, async (event) => {
    refuseUnknown(event);
    const folder = logsFolder(dataDir);
    await mkdir(folder, { recursive: true });
    await openPath(folder);
  });

  handle(FILES_CHANNELS.pickSkill, async (event, kind: unknown): Promise<string | null> => {
    refuseUnknown(event);
    const { language } = await core.getSettings();
    const openOptions: OpenDialogOptions =
      kind === "zip"
        ? {
            title: translate(language, "skills.import.pickZip"),
            properties: ["openFile"],
            filters: [
              { name: translate(language, "skills.import.zipFilter"), extensions: ["zip"] },
            ],
          }
        : { title: translate(language, "skills.import.pickFolder"), properties: ["openDirectory"] };
    const { canceled, filePaths } = await showOpenDialog(
      BrowserWindow.fromWebContents(event.sender),
      openOptions,
    );
    return canceled ? null : (filePaths[0] ?? null);
  });

  // The core checks the Document is live and its file there, then opens it through the shell adapter.
  handle(FILES_CHANNELS.openDocumentExternally, async (event, documentId: unknown) => {
    refuseUnknown(event);
    await core.openDocumentInApp(documentId as string);
  });

  handle(FILES_CHANNELS.showDocumentInFolder, async (event, documentId: unknown) => {
    refuseUnknown(event);
    await core.showDocumentInFolder(documentId as string);
  });

  handle(
    FILES_CHANNELS.pickLinkedFolder,
    async (event, locating: unknown): Promise<string | null> => {
      refuseUnknown(event);
      const { language } = await core.getSettings();
      const moved =
        typeof locating === "string"
          ? (await core.listLinkedFolders()).find((each) => each.id === locating)
          : undefined;
      const start = startFolder(dataDir, "folders", app.getPath("home"));
      const openOptions: OpenDialogOptions = moved
        ? {
            title: translate(language, "linkedFolders.locate.pickTitle", {
              name: basename(moved.path) || moved.path,
            }),
            buttonLabel: translate(language, "linkedFolders.locate.pickButton"),
            properties: ["openDirectory"],
            // A folder that moved is most likely near where it was.
            defaultPath: startNear(moved.path, start),
          }
        : {
            title: translate(language, "linkedFolders.pick.title"),
            buttonLabel: translate(language, "linkedFolders.pick.button"),
            properties: ["openDirectory"],
            defaultPath: start,
          };
      const { canceled, filePaths } = await showOpenDialog(
        BrowserWindow.fromWebContents(event.sender),
        openOptions,
      );
      const picked = canceled ? null : (filePaths[0] ?? null);
      if (picked) rememberPick(dataDir, "folders", picked);
      return picked;
    },
  );

  /**
   * The one sheet for Documents, opened on the window, from the folder last
   * picked from (see pickerFolders.ts) rather than the web file input, which
   * starts wherever macOS last was, often iCloud. `titleKey` and `properties`
   * are the caller's, since a picker that takes a folder too differs there.
   */
  const pickDocumentsSheet = async (
    event: IpcMainInvokeEvent,
    titleKey: MessageKey,
    properties: OpenDialogOptions["properties"],
  ): Promise<string[]> => {
    refuseUnknown(event);
    const { language } = await core.getSettings();
    const openOptions: OpenDialogOptions = {
      title: translate(language, titleKey),
      properties,
      filters: [
        { name: translate(language, "documents.pick.filter"), extensions: DOCUMENT_EXTENSIONS },
      ],
      defaultPath: startFolder(dataDir, "documents", app.getPath("downloads")),
    };
    const { canceled, filePaths } = await showOpenDialog(
      BrowserWindow.fromWebContents(event.sender),
      openOptions,
    );
    if (canceled) return [];
    if (filePaths[0]) rememberPick(dataDir, "documents", filePaths[0]);
    return filePaths;
  };

  handle(FILES_CHANNELS.pickDocumentsOrFolder, async (event) => {
    const mac = process.platform === "darwin";
    const picked = await pickDocumentsSheet(
      event,
      // The sheet's own title says what this platform's sheet takes, as its button does.
      addFilesTitleByPlatform(mac),
      // Windows and Linux show a folder chooser when both are asked for, so only files are offered there.
      mac ? ["openFile", "openDirectory", "multiSelections"] : ["openFile", "multiSelections"],
    );
    const folders: string[] = [];
    const files: string[] = [];
    for (const path of picked) {
      // A path that can't be looked at goes on as a file, so adding it says why in the window.
      const isFolder = await stat(path).then(
        (found) => found.isDirectory(),
        () => false,
      );
      (isFolder ? folders : files).push(path);
    }
    return { files, folders };
  });

  handle(
    FILES_CHANNELS.pickDocuments,
    (event): Promise<string[]> =>
      pickDocumentsSheet(event, "documents.pick.title", ["openFile", "multiSelections"]),
  );

  // The core reads the file and sends nothing; this is only the User choosing it (#287).
  handle(FILES_CHANNELS.pickReferenceFile, async (event): Promise<string | null> => {
    refuseUnknown(event);
    const { language } = await core.getSettings();
    const openOptions: OpenDialogOptions = {
      title: translate(language, "references.import.pick.title"),
      message: translate(language, "references.import.pick.message"),
      properties: ["openFile"],
      filters: [
        {
          name: translate(language, "references.import.pick.filter"),
          extensions: REFERENCE_EXTENSIONS,
        },
      ],
      defaultPath: startFolder(dataDir, "documents", app.getPath("downloads")),
    };
    const { canceled, filePaths } = await showOpenDialog(
      BrowserWindow.fromWebContents(event.sender),
      openOptions,
    );
    const picked = canceled ? null : (filePaths[0] ?? null);
    if (picked) rememberPick(dataDir, "documents", picked);
    return picked;
  });

  /** One file of a kind, for the core to read: only the User choosing it. */
  const pickOneFile = async (
    event: IpcMainInvokeEvent,
    title: MessageKey,
    filter: MessageKey,
    extension: string,
  ): Promise<string | null> => {
    refuseUnknown(event);
    const { language } = await core.getSettings();
    const openOptions: OpenDialogOptions = {
      title: translate(language, title),
      properties: ["openFile"],
      filters: [{ name: translate(language, filter), extensions: [extension] }],
      defaultPath: startFolder(dataDir, "documents", app.getPath("downloads")),
    };
    const { canceled, filePaths } = await showOpenDialog(
      BrowserWindow.fromWebContents(event.sender),
      openOptions,
    );
    const picked = canceled ? null : (filePaths[0] ?? null);
    if (picked) rememberPick(dataDir, "documents", picked);
    return picked;
  };

  // The core reads the file and keeps a copy for the Mind (#104).
  handle(FILES_CHANNELS.pickWordFile, (event) =>
    pickOneFile(event, "wordImport.pick.title", "wordImport.pick.filter", "docx"),
  );
  // The core adds it to the Library and makes a Mind of its text (#97).
  handle(FILES_CHANNELS.pickPdfFile, (event) =>
    pickOneFile(event, "verify.pick.title", "verify.pick.filter", "pdf"),
  );

  // Only a folder the User linked: its path comes from the core's list, never from the page.
  handle(FILES_CHANNELS.showLinkedFolder, async (event, linkedFolderId: unknown) => {
    refuseUnknown(event);
    const linked = (await core.listLinkedFolders()).find((each) => each.id === linkedFolderId);
    if (!linked) throw new Error("There is no such Linked folder.");
    if (linked.status === "unavailable") {
      throw new Error("The Linked folder can't be reached right now.");
    }
    shell.showItemInFolder(linked.path);
  });

  handle(FILES_CHANNELS.runsWithoutSandbox, (event) => {
    refuseUnknown(event);
    // Playwright starts a test build on Linux with --no-sandbox: only a test that is about the line asks for it.
    if (import.meta.env.MODE === "test" && process.env.INCARNAMIND_TEST_SANDBOX_NOTICE !== "1") {
      return false;
    }
    return sandboxOff((name) => app.commandLine.hasSwitch(name), process.env);
  });

  ipcMain.on(FILES_CHANNELS.sidebarHidden, (event, hidden: unknown) => {
    if (trusted(event) && typeof hidden === "boolean") setMenuSidebarHidden(hidden);
  });

  ipcMain.on(FILES_CHANNELS.editMenu, (event, state: unknown) => {
    if (trusted(event) && isEditMenuState(state)) setEditMenu(state);
  });

  ipcMain.on(FILES_CHANNELS.paste, (event) => {
    if (trusted(event)) event.sender.paste();
  });

  ipcMain.on(FILES_CHANNELS.examplesRemoved, (event, removed: unknown) => {
    if (trusted(event) && typeof removed === "boolean") setExamplesRemoved(removed);
  });

  ipcMain.on(FILES_CHANNELS.exportMenu, (event, mindName: unknown) => {
    if (trusted(event) && (typeof mindName === "string" || mindName === null)) {
      setExportMenu(mindName);
    }
  });

  ipcMain.on(FILES_CHANNELS.logError, (event, report: unknown) => {
    if (trusted(event)) logWindowError(logger, report);
  });
}
