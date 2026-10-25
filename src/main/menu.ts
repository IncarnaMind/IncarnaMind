import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import type { Language } from "../core/language";
import { type EditMenuState, FILES_CHANNELS, type MenuCommand } from "../shared/bridge";
import { MENU_COMMANDS } from "../shared/commands";
import { type MessageKey, translate } from "../shared/i18n";
import { systemDialogOpen } from "./systemDialogs";

/** The window the menu acts on: the one in front, or else the only one. */
function front(): BrowserWindow | null {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return window && !window.isDestroyed() ? window : null;
}

/** Asks the window in front to run a menu item's command (see `files.onMenuCommand`); none while a system dialog has the keys. */
function send(command: MenuCommand): void {
  if (systemDialogOpen()) return;
  front()?.webContents.send(FILES_CHANNELS.menuCommand, command);
}

/**
 * Select All: on macOS, while a system dialog is open, its own file list takes it, as ⌘A does in
 * any Mac app; the window behind gets nothing (#1684, #1707).
 */
function selectAll(): void {
  if (process.platform === "darwin" && systemDialogOpen()) {
    Menu.sendActionToFirstResponder("selectAll:");
    return;
  }
  send("edit.selectAll");
}

/**
 * The application menu, in the interface language. As in a browser, ⌘W closes
 * the tab and Shift+⌘W the window. Reload and the developer tools are only in
 * development and test builds. Ctrl stands in for ⌘ on Windows and Linux.
 * `windows` is the app's own windows, for Close All: never the hidden ones.
 */
export function installAppMenu(
  language: Language,
  { developer, windows }: { developer: boolean; windows: () => BrowserWindow[] },
): void {
  installed = { language, developer, windows };
  buildMenu();
}

/** What the menu was last built from, to build it again when the sidebar is hidden or shown. */
let installed: {
  language: Language;
  developer: boolean;
  windows: () => BrowserWindow[];
} | null = null;
let sidebarHidden = false;
let exportedMind: string | null = null;
let examplesRemoved = false;

/** Until the window says where its focus is, Undo and Redo show as a field's: enabled, naming nothing. */
let editMenu: EditMenuState = { text: "field", undo: null, redo: null };

/** Where the focus is in the window in front, and the change Undo and Redo name (see `EditMenuState`). */
export function setEditMenu(state: EditMenuState): void {
  if (state.text === editMenu.text && state.undo === editMenu.undo && state.redo === editMenu.redo)
    return;
  editMenu = state;
  if (installed) buildMenu();
}

const isTextPlace = (value: unknown) => value === "field" || value === "note" || value === null;
const isNamed = (value: unknown) => typeof value === "string" || value === null;

export function isEditMenuState(value: unknown): value is EditMenuState {
  if (typeof value !== "object" || value === null) return false;
  const { text, undo, redo } = value as Record<string, unknown>;
  return isTextPlace(text) && isNamed(undo) && isNamed(redo);
}

export function setExamplesRemoved(removed: boolean): void {
  if (removed === examplesRemoved) return;
  examplesRemoved = removed;
  if (installed) buildMenu();
}

export function setExportMenu(mindName: string | null): void {
  if (mindName === exportedMind) return;
  exportedMind = mindName;
  if (installed) buildMenu();
}

/** Makes View say "Show Sidebar" while the sidebar is hidden, "Hide Sidebar" otherwise. */
export function setMenuSidebarHidden(hidden: boolean): void {
  if (hidden === sidebarHidden) return;
  sidebarHidden = hidden;
  if (installed) buildMenu();
}

function buildMenu(): void {
  if (!installed) return;
  const { language, developer, windows } = installed;
  const isMac = process.platform === "darwin";
  const t = (key: MessageKey) => translate(language, key);
  const command = (
    id: MenuCommand,
    label: MessageKey = MENU_COMMANDS[id].label,
  ): MenuItemConstructorOptions => ({
    label: t(label),
    accelerator: MENU_COMMANDS[id].keys,
    // The window's keymap binds the keys. macOS ignores this, but there the page has them first.
    registerAccelerator: false,
    click: () => send(id),
  });
  const settings = command("settings.open");
  /**
   * Undo and Redo: the window decides where they go from its focus when they are
   * chosen, as a reported focus may be behind (#516): a field's own undo, the
   * note's own, or the app's changes, which the menu then names ("Undo Move 3 Documents").
   */
  const edit = (step: "undo" | "redo"): MenuItemConstructorOptions => {
    const id = step === "undo" ? "edit.undo" : "edit.redo";
    const action = editMenu[step];
    const label =
      editMenu.text === null && action
        ? translate(language, step === "undo" ? "menu.undo.named" : "menu.redo.named", { action })
        : t(MENU_COMMANDS[id].label);
    return {
      id,
      label,
      // Windows writes Redo as Ctrl+Y, which the window binds with Ctrl+Shift+Z.
      accelerator:
        step === "redo" && process.platform === "win32" ? "Ctrl+Y" : MENU_COMMANDS[id].keys,
      registerAccelerator: false,
      enabled: editMenu.text !== null || action !== null,
      click: () => send(id),
    };
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "IncarnaMind",
            submenu: [
              { role: "about", label: t("menu.about") },
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "services", label: t("menu.services") },
              { type: "separator" },
              { role: "hide", label: t("menu.hide") },
              { role: "hideOthers", label: t("menu.hideOthers") },
              { role: "unhide", label: t("menu.showAll") },
              { type: "separator" },
              { role: "quit", label: t("menu.quit") },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t("menu.file"),
      submenu: [
        command("mind.new"),
        command("folder.new"),
        { type: "separator" },
        command("documents.add"),
        command("linkedFolder.add"),
        { type: "separator" },
        {
          ...command("mind.export", "menu.export"),
          id: "mind.export",
          label:
            exportedMind === null
              ? t("menu.export")
              : translate(language, "menu.export.named", { name: exportedMind }),
          enabled: exportedMind !== null,
        },
        { type: "separator" },
        command("tab.close"),
        command("tab.reopen"),
        // Not the `close` role: macOS adds its own "Close All" beside it, in the system's language (#1346).
        {
          id: "window.close",
          label: t("menu.closeWindow"),
          accelerator: "Shift+CmdOrCtrl+W",
          click: () => BrowserWindow.getFocusedWindow()?.close(),
        },
        {
          id: "window.closeAll",
          label: t("menu.closeAll"),
          accelerator: "Alt+Shift+CmdOrCtrl+W",
          click: () => {
            for (const window of windows()) window.close();
          },
        },
        ...(isMac
          ? []
          : ([
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "quit", label: t("menu.quit") },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t("menu.edit"),
      submenu: [
        edit("undo"),
        edit("redo"),
        { type: "separator" },
        { role: "cut", label: t("menu.cut") },
        { role: "copy", label: t(isMac ? "menu.copy" : "menu.copy.other") },
        { role: "paste", label: t("menu.paste") },
        { ...command("edit.selectAll"), id: "edit.selectAll", click: selectAll },
      ],
    },
    {
      label: t(isMac ? "menu.view" : "menu.view.other"),
      submenu: [
        ...(developer
          ? ([
              // No ⌘R, the role's own keys: in a Mind ⌘R aligns right, as Users have it.
              {
                label: t("menu.reload"),
                click: (_item, window) => {
                  if (window instanceof BrowserWindow) window.webContents.reload();
                },
              },
              { role: "forceReload", label: t("menu.forceReload") },
              { role: "toggleDevTools", label: t("menu.devTools") },
              { type: "separator" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        command("sidebar.toggle", sidebarHidden ? "menu.showSidebar" : "menu.hideSidebar"),
        command("tab.split"),
        { type: "separator" },
        { role: "resetZoom", label: t("menu.actualSize") },
        { role: "zoomIn", label: t("menu.zoomIn") },
        { role: "zoomOut", label: t("menu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("menu.fullScreen") },
      ],
    },
    {
      label: t("menu.help"),
      role: "help",
      submenu: [
        { ...command("examples.show"), id: "examples.show", visible: examplesRemoved },
        command("help.feedback"),
      ],
    },
    {
      label: t("menu.window"),
      role: "windowMenu",
      submenu: [
        { role: "minimize", label: t("menu.minimize") },
        { role: "zoom", label: t("menu.zoom") },
        ...(isMac
          ? ([
              { type: "separator" },
              { role: "front", label: t("menu.front") },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
