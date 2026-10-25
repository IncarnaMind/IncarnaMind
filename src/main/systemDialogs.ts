import {
  type BrowserWindow,
  dialog,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from "electron";

let open = 0;

/**
 * Whether a system dialog is open. It takes every key, but macOS still runs
 * the application menu's items while its sheet is in front (#1515).
 */
export const systemDialogOpen = (): boolean => open > 0;

async function whileOpen<T>(show: () => Promise<T>): Promise<T> {
  open += 1;
  try {
    return await show();
  } finally {
    open -= 1;
  }
}

export const showOpenDialog = (
  window: BrowserWindow | null,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> =>
  whileOpen(() =>
    window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options),
  );

export const showSaveDialog = (
  window: BrowserWindow | null,
  options: SaveDialogOptions,
): Promise<SaveDialogReturnValue> =>
  whileOpen(() =>
    window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options),
  );

export const showMessageBox = (
  window: BrowserWindow | null,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> =>
  whileOpen(() =>
    window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options),
  );
