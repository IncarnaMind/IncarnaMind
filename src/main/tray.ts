/**
 * The menu bar icon (macOS) or tray icon (Windows, Linux) of #189, with its menu (./trayMenu). On
 * macOS a click opens the menu; on Windows and Linux, as there, a click opens the window, or the
 * Note being recorded, and a right-click the menu.
 */
import { readFileSync } from "node:fs";
import { Menu, type NativeImage, nativeImage, Tray } from "electron";
import colourIcon from "../../build/icon/png/32x32.png?asset";
import recordingIcon2x from "../../build/icon/tray/trayRecordingTemplate@2x.png?asset";
import recordingIcon from "../../build/icon/tray/trayRecordingTemplate.png?asset";
import idleIcon2x from "../../build/icon/tray/trayTemplate@2x.png?asset";
import idleIcon from "../../build/icon/tray/trayTemplate.png?asset";
import { meetingTimeAt } from "../shared/blockTimes";
import { clockTime } from "../shared/clock";
import { translate } from "../shared/i18n";
import { type TrayActions, type TrayState, trayMenu } from "./trayMenu";

/** A template image macOS colours for the menu bar, at both its scales. */
function templateImage(one: string, two: string): NativeImage {
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, buffer: readFileSync(one) });
  image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(two) });
  image.setTemplateImage(true);
  return image;
}

export interface AppTray {
  update(state: TrayState): void;
  destroy(): void;
}

export function createAppTray(actions: TrayActions, initial: TrayState): AppTray {
  const platform = process.platform;
  const mac = platform === "darwin";
  const image = (recording: boolean) => {
    if (!mac) return nativeImage.createFromPath(colourIcon);
    return recording
      ? templateImage(recordingIcon, recordingIcon2x)
      : templateImage(idleIcon, idleIcon2x);
  };
  let state = initial;
  const tray = new Tray(image(state.recording !== null));
  const menu = () => Menu.buildFromTemplate(trayMenu(state, actions, Date.now(), platform));
  const show = () => {
    tray.setImage(image(state.recording !== null));
    tray.setToolTip(
      state.recording
        ? translate(state.language, "tray.tooltip.recording", {
            time: clockTime(meetingTimeAt(state.recording.meeting, Date.now())),
          })
        : "IncarnaMind",
    );
    // Linux shows the menu it was given; macOS and Windows build it as it opens, so its times are now's.
    if (platform === "linux") tray.setContextMenu(menu());
  };
  if (mac) {
    tray.on("click", () => tray.popUpContextMenu(menu()));
    tray.on("right-click", () => tray.popUpContextMenu(menu()));
  } else {
    tray.on("click", () =>
      state.recording ? actions.openRecording(state.recording.meeting.id) : actions.open(),
    );
    tray.on("right-click", () => tray.popUpContextMenu(menu()));
  }
  show();
  return {
    update(next) {
      state = next;
      show();
    },
    destroy: () => tray.destroy(),
  };
}
