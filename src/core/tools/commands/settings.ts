/**
 * The settings the assistant changes for the User (#1421): those of Settings and the export
 * options that decide nothing about privacy or security, each taken back with Undo. A new Output
 * location asks first, since files are saved there without asking (ADR-0013). Those that are the
 * User's alone (`YOURS_SETTINGS`) are named too, so a request for one is told where to change it.
 */
import type { Yours } from "../../../shared/commands";
import { FONT_PRESETS, isFontFamily, type MindFont, TEXT_SIZES } from "../../../shared/mindStyle";
import {
  type DeviceSettings,
  EXPORT_FORMATS,
  MOTION_PREFERENCES,
  type Settings,
  type SettingsPatch,
  type UserSettings,
} from "../../api";
import { InvalidInputError } from "../../errors";
import { isLanguagePreference } from "../../language";
import {
  type CheckedCommand,
  type Checker,
  type CommandsCore,
  folderOnDisk,
  IN_APP,
  needs,
  same,
} from "./run";
import { yoursChecked } from "./window";

interface Setting {
  /** The values it takes, as the model reads them. */
  takes: string;
  read(now: Settings): string;
  patch(value: string, now: Settings, core: CommandsCore): Promise<SettingsPatch> | SettingsPatch;
}

const notValue = (setting: string, value: string) =>
  new InvalidInputError({ key: "error.commands.notValue", values: { setting, value } });

const ON = ["on", "true", "yes"];
const OFF = ["off", "false", "no"];

function onOff(setting: string, value: string): boolean {
  if (ON.some((each) => same(each, value))) return true;
  if (OFF.some((each) => same(each, value))) return false;
  throw notValue(setting, value);
}

const said = (on: boolean) => (on ? "on" : "off");

function oneOf<T extends string>(setting: string, values: readonly T[], value: string): T {
  const found = values.find((each) => same(each, value));
  if (!found) throw notValue(setting, value);
  return found;
}

const switchOf = (
  name: string,
  read: (now: Settings) => boolean,
  patch: (on: boolean) => SettingsPatch,
): Setting => ({
  takes: "on or off",
  read: (now) => said(read(now)),
  patch: (value) => patch(onOff(name, value)),
});

const fontName = (font: MindFont) => (typeof font === "string" ? font : font.family);

/** Each setting the assistant may change, by the name the model gives it. */
const SETTINGS: Readonly<Record<string, Setting>> = {
  language: {
    takes: "en, zh-CN, or system (the computer's language)",
    read: (now) => now.user.language,
    patch: (value) => {
      const language = ["en", "zh-CN", "system"].find((each) => same(each, value));
      if (!isLanguagePreference(language)) throw notValue("language", value);
      return { user: { language } };
    },
  },
  motion: {
    takes: MOTION_PREFERENCES.join(", "),
    read: (now) => now.device.motion,
    patch: (value) => ({ device: { motion: oneOf("motion", MOTION_PREFERENCES, value) } }),
  },
  taskNotifications: switchOf(
    "taskNotifications",
    (now) => now.user.taskNotifications,
    (on) => ({ user: { taskNotifications: on } }),
  ),
  authorName: {
    takes: "the name the User's edits go under in a Word file, or none for the computer's own",
    read: (now) => now.user.authorName ?? "none",
    patch: (value) => ({ user: { authorName: same(value, "none") ? null : value.trim() } }),
  },
  newNoteFont: {
    takes: `${FONT_PRESETS.join(", ")}, or a font installed on the computer, by name`,
    read: (now) => fontName(now.user.newMindStyle.font),
    patch: (value, now) => {
      const preset = FONT_PRESETS.find((each) => same(each, value));
      if (!preset && !isFontFamily(value)) throw notValue("newNoteFont", value);
      return {
        user: {
          newMindStyle: { ...now.user.newMindStyle, font: preset ?? { family: value.trim() } },
        },
      };
    },
  },
  newNoteTextSize: {
    takes: TEXT_SIZES.join(", "),
    read: (now) => now.user.newMindStyle.size,
    patch: (value, now) => ({
      user: {
        newMindStyle: {
          ...now.user.newMindStyle,
          size: oneOf("newNoteTextSize", TEXT_SIZES, value),
        },
      },
    }),
  },
  exportFormat: {
    takes: EXPORT_FORMATS.join(", "),
    read: (now) => now.user.exportOptions.format,
    patch: (value, now) => ({
      user: {
        exportOptions: {
          ...now.user.exportOptions,
          format: oneOf("exportFormat", EXPORT_FORMATS, value),
        },
      },
    }),
  },
  leaveOutOwnFiles: switchOf(
    "leaveOutOwnFiles",
    (now) => now.user.leaveOutOwnFiles,
    (on) => ({ user: { leaveOutOwnFiles: on } }),
  ),
  keepWebPageLook: switchOf(
    "keepWebPageLook",
    (now) => now.user.keepWebPageLook,
    (on) => ({ user: { keepWebPageLook: on } }),
  ),
  meetingSystemAudio: switchOf(
    "meetingSystemAudio",
    (now) => now.device.meetingSystemAudio,
    (on) => ({ device: { meetingSystemAudio: on } }),
  ),
  meetingPanel: switchOf(
    "meetingPanel",
    (now) => now.device.meetingPanel,
    (on) => ({ device: { meetingPanel: on } }),
  ),
  meetingPanelHidden: switchOf(
    "meetingPanelHidden",
    (now) => now.device.meetingPanelHidden,
    (on) => ({ device: { meetingPanelHidden: on } }),
  ),
  model: {
    takes:
      "a model set up in Settings › Models, by its id or name: what Answers are written with by default",
    read: (now) => now.user.chatModel?.modelId ?? "none",
    patch: async (value, _now, core) => {
      for (const group of await core.listChatModels()) {
        const modelId = group.offered.find(
          (id) => same(id, value) || same(group.names[id] ?? "", value),
        );
        if (modelId) return { user: { chatModel: { providerId: group.provider.id, modelId } } };
      }
      throw new InvalidInputError({ key: "error.commands.noModel", values: { model: value } });
    },
  },
};

/** What the assistant never changes, by the name a request may give it, and why (#1421). */
export const YOURS_SETTINGS: Readonly<Record<string, Yours>> = {
  localMode: "privacy",
  consent: "privacy",
  privacy: "privacy",
  usageData: "privacy",
  webSearch: "privacy",
  suggestWhileWriting: "privacy",
  transcription: "privacy",
  apiKey: "keys",
  signIn: "keys",
  provider: "keys",
  approvals: "approvals",
  skillScripts: "approvals",
  monthlyCap: "spending",
};

/** The settings' names and values, as `run_command`'s description gives them. */
export const SETTINGS_TAKEN = [
  ...Object.entries(SETTINGS).map(([name, setting]) => `${name} (${setting.takes})`),
  "outputLocation (an absolute folder path: where new files are saved)",
].join("; ");

export const SETTING_NAMES = [
  ...Object.keys(SETTINGS),
  "outputLocation",
  ...Object.keys(YOURS_SETTINGS),
];

const copy = <T, K extends keyof T>(to: Partial<T>, from: T, key: K) => {
  to[key] = from[key];
};

/** What puts back the settings a patch changes, as they are now. */
function restoring(patch: SettingsPatch, now: Settings): SettingsPatch {
  const user: Partial<UserSettings> = {};
  for (const key of Object.keys(patch.user ?? {}) as (keyof UserSettings)[])
    copy(user, now.user, key);
  const device: Partial<DeviceSettings> = {};
  for (const key of Object.keys(patch.device ?? {}) as (keyof DeviceSettings)[]) {
    copy(device, now.device, key);
  }
  return { user, device };
}

const named = <T>(table: Readonly<Record<string, T>>, given: string): [string, T] | undefined =>
  Object.entries(table).find(([name]) => same(name, given));

export const settingsChecker: Checker = async (input, { core }) => {
  const given = needs(input.setting, "error.commands.noSetting");
  const yours = named(YOURS_SETTINGS, given);
  if (yours) return yoursChecked("settings.change", yours[1]);
  const value = needs(input.value, "error.commands.noValue");
  if (same(given, "outputLocation")) return outputLocation(core, await folderOnDisk(value));
  const found = named(SETTINGS, given);
  if (!found)
    throw new InvalidInputError({
      key: "error.commands.noSettingNamed",
      values: { setting: given },
    });
  const [name, setting] = found;
  const now = await core.getSettings();
  const patch = await setting.patch(value, now, core);
  const back = restoring(patch, now);
  return {
    command: "settings.change",
    effects: IN_APP,
    items: [],
    into: null,
    outside: null,
    changes: true,
    deletes: false,
    final: false,
    yours: null,
    async run() {
      const from = setting.read(now);
      const after = await core.updateSettings(patch);
      const to = setting.read(after);
      return {
        done: { items: [], setting: { name, from, to } },
        step: {
          undo: async () => {
            await core.updateSettings(back);
            return null;
          },
          redo: async () => {
            await core.updateSettings(patch);
          },
        },
        said: `Changed the setting ${name} from ${from} to ${to}.`,
      };
    },
  };
};

/** A new Output location asks first: from then on, files are saved there without asking. */
async function outputLocation(core: CommandsCore, folder: string): Promise<CheckedCommand> {
  const before = (await core.getOutputSettings()).location;
  return {
    command: "settings.change",
    effects:
      before === folder ? [] : [{ action: "write", scope: { kind: "folder", path: folder } }],
    items: [],
    into: null,
    outside: before === folder ? null : { kind: "output", folder },
    changes: false,
    deletes: false,
    final: false,
    yours: null,
    async run() {
      if (before === folder) {
        return {
          done: { items: [] },
          step: null,
          said: `The Output location is ${folder} already; nothing changed.`,
        };
      }
      await core.setOutputLocation(folder);
      return {
        done: {
          items: [],
          setting: { name: "outputLocation", from: before ?? "none", to: folder },
        },
        step:
          before === null
            ? null
            : {
                undo: async () => {
                  await core.setOutputLocation(before);
                  return null;
                },
                redo: async () => {
                  await core.setOutputLocation(folder);
                },
              },
        said: `New files are now saved in ${folder}, the Output location.`,
      };
    },
  };
}
