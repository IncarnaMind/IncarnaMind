import { randomUUID } from "node:crypto";
import { isRecentStyles } from "../shared/citationStyles";
import { isHelpKeys } from "../shared/meetingHelp";
import { DEFAULT_MIND_STYLE, isMindStyle } from "../shared/mindStyle";
import {
  type ChatModelChoice,
  CITATION_PLACES,
  type DeviceSettings,
  EXPORT_FORMATS,
  type ExportPreferences,
  type GettingStarted,
  MARK_AI_TEXT_CHOICES,
  MAX_MONTHLY_CAP,
  type MarkAiTextChoice,
  MODEL_SOURCE_CHOICES,
  MOTION_PREFERENCES,
  type ModelSourceChoice,
  type MonthlyCap,
  type MotionPreference,
  type SandboxLevel,
  type Settings,
  type SharePagePreferences,
  SKILL_SCRIPT_LIMITS,
  TRANSCRIPTION_ROUTES,
  type TranscriptionRoute,
  type UserSettings,
  type WordExportPreferences,
} from "./api";
import { InvalidInputError, isRecord } from "./errors";
import { isLanguagePreference, resolveLanguage } from "./language";
import type { Database } from "./storage";

/**
 * Settings are split into per-User (synced later) and per-device (never synced),
 * each in its own table (ADR-0003). A row holds one setting as JSON.
 */
interface Scope<T> {
  name: "user" | "device";
  table: "user_settings" | "device_settings";
  defaults: T;
  validators: { [K in keyof T]-?: (value: unknown) => value is T[K] };
}

const isPaneWidth = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000;

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const isTipCounts = (value: unknown): value is Record<string, number> =>
  isRecord(value) &&
  Object.values(value).every(
    (count) => typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 100,
  );

const isNonBlankText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= 500;

/** Checks the shape only; the core checks that the provider exists. */
export const isChatModelChoice = (value: unknown): value is ChatModelChoice =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  isNonBlankText(value.providerId) &&
  isNonBlankText(value.modelId);

const isModelSetting = (value: unknown): value is ChatModelChoice | null =>
  value === null || isChatModelChoice(value);

const hasOnly = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const isQuestionsOption = (value: unknown) =>
  hasOnly(value, ["includeQuestions"]) && isBoolean(value.includeQuestions);

const WORD_SWITCHES = ["trackChanges", "commentFailedChecks"] as const;

const isMarkAiTextAnswer = (value: unknown): value is MarkAiTextChoice | null =>
  value === null || MARK_AI_TEXT_CHOICES.some((choice) => choice === value);

/**
 * Word's choices of #107 came later: choices saved before them have none, and read as the
 * defaults. A boolean is still read for marking AI text, as `markAiTextRead` says.
 */
const isWordOption = (value: unknown) =>
  isQuestionsOption(value) ||
  (hasOnly(value, ["includeQuestions", "markAiText", ...WORD_SWITCHES]) &&
    isBoolean(value.includeQuestions) &&
    WORD_SWITCHES.every((choice) => isBoolean(value[choice])) &&
    (isBoolean(value.markAiText) || isMarkAiTextAnswer(value.markAiText)));

function markAiTextRead(saved: unknown): MarkAiTextChoice | null {
  // The switch was on by default, so a saved "on" was never an answer; "off" was a choice.
  if (isMarkAiTextAnswer(saved)) return saved;
  return saved === false ? "leave" : null;
}

const SHARE_PAGE_CHOICES = ["includeQuestions", "citationCards", "checkedLine"] as const;

const isSharePageOption = (value: unknown) =>
  hasOnly(value, SHARE_PAGE_CHOICES) && SHARE_PAGE_CHOICES.every((key) => isBoolean(value[key]));

const SHARE_PAGE_DEFAULTS: SharePagePreferences = {
  includeQuestions: false,
  citationCards: true,
  checkedLine: false,
};

/**
 * HTML came after the others, how someone's changes are shown (#734) after HTML, and the web
 * page to share after that: choices saved before them have none, and read as the defaults.
 */
const isExportPreferences = (value: unknown): value is ExportPreferences => {
  if (!isRecord(value)) return false;
  const later = [
    "html",
    "share-page",
    "theirChanges",
    "citationPlace",
    "commentOthersFiles",
  ].filter((key) => Object.hasOwn(value, key));
  return (
    hasOnly(value, ["format", "docx", "pdf", ...later]) &&
    EXPORT_FORMATS.some((format) => format === value.format) &&
    isWordOption(value.docx) &&
    isQuestionsOption(value.pdf) &&
    (!Object.hasOwn(value, "html") || isQuestionsOption(value.html)) &&
    (!Object.hasOwn(value, "share-page") || isSharePageOption(value["share-page"])) &&
    (!Object.hasOwn(value, "theirChanges") ||
      value.theirChanges === "shown" ||
      value.theirChanges === "accepted") &&
    (!Object.hasOwn(value, "citationPlace") ||
      CITATION_PLACES.some((place) => place === value.citationPlace)) &&
    (!Object.hasOwn(value, "commentOthersFiles") || isBoolean(value.commentOthersFiles))
  );
};

/** The Word switches on by default (#107), so a file says what IncarnaMind changed and checked. */
const WORD_DEFAULTS: Omit<WordExportPreferences, "includeQuestions"> = {
  trackChanges: true,
  markAiText: null,
  commentFailedChecks: true,
};

/** A cap of up to a million a month, in dollars or yuan. */
const isMonthlyCap = (value: unknown): value is MonthlyCap =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  typeof value.amount === "number" &&
  Number.isFinite(value.amount) &&
  value.amount >= 0 &&
  value.amount <= MAX_MONTHLY_CAP &&
  (value.currency === "USD" || value.currency === "CNY");

const userScope: Scope<UserSettings> = {
  name: "user",
  table: "user_settings",
  defaults: {
    language: "system",
    chatModel: null,
    quickTasksModel: null,
    imageModel: null,
    suggestWhileWriting: false,
    leaveOutOwnFiles: true,
    // Word is the deliverable most asked for; the deliverables leave the Questions out.
    exportOptions: {
      format: "docx",
      docx: { includeQuestions: false, ...WORD_DEFAULTS },
      pdf: { includeQuestions: false },
      html: { includeQuestions: false },
      "share-page": SHARE_PAGE_DEFAULTS,
    },
    authorName: null,
    personId: null,
    monthlyCap: null,
    webSearch: false,
    keepWebPageLook: false,
    taskNotifications: true,
    recentCitationStyles: [],
    newMindStyle: DEFAULT_MIND_STYLE,
  },
  validators: {
    language: isLanguagePreference,
    chatModel: isModelSetting,
    quickTasksModel: isModelSetting,
    imageModel: isModelSetting,
    suggestWhileWriting: isBoolean,
    leaveOutOwnFiles: isBoolean,
    exportOptions: isExportPreferences,
    authorName: (value): value is string | null => value === null || isNonBlankText(value),
    personId: (value): value is string | null => value === null || isNonBlankText(value),
    monthlyCap: (value): value is MonthlyCap | null => value === null || isMonthlyCap(value),
    webSearch: isBoolean,
    keepWebPageLook: isBoolean,
    taskNotifications: isBoolean,
    recentCitationStyles: isRecentStyles,
    newMindStyle: isMindStyle,
  },
};

const GETTING_STARTED_STEPS = [
  "started",
  "citationChecked",
  "mistakeSeen",
  "indexed",
  "askedOwn",
  "askedReady",
  "exported",
  "hidden",
  "seen",
];

// Progress kept before the ready Question (#123) has no `askedReady`; `get` reads it as not asked.
// Progress kept before the mistake had its own step has no `mistakeSeen`; `get` takes it from
// `citationChecked`, so a first open already finished stays finished. A device that exported no
// note, or showed no first-run card, has no `exported` or `seen`: both read as false.
const ADDED_LATER = ["askedReady", "mistakeSeen", "exported", "seen"];
const isGettingStarted = (value: unknown): value is GettingStarted =>
  isRecord(value) &&
  Object.keys(value).every((key) => GETTING_STARTED_STEPS.includes(key)) &&
  GETTING_STARTED_STEPS.every(
    (key) => isBoolean(value[key]) || (ADDED_LATER.includes(key) && value[key] === undefined),
  );

const isScriptTimeout = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= SKILL_SCRIPT_LIMITS.minTimeoutSeconds &&
  value <= SKILL_SCRIPT_LIMITS.maxTimeoutSeconds;

const deviceScope: Scope<DeviceSettings> = {
  name: "device",
  table: "device_settings",
  defaults: {
    // DESIGN.md: the sidebar is 248px by default.
    sidebarWidth: 248,
    sidebarHidden: false,
    sandboxNoticeDismissed: false,
    openedBefore: false,
    gettingStarted: {
      started: false,
      citationChecked: false,
      mistakeSeen: false,
      indexed: false,
      askedOwn: false,
      askedReady: false,
      exported: false,
      hidden: false,
      seen: false,
    },
    skillScriptsEnabled: true,
    skillScriptTimeoutSeconds: SKILL_SCRIPT_LIMITS.defaultTimeoutSeconds,
    suggestionOffers: 0,
    tips: {},
    meetingSystemAudio: true,
    transcriptionRoute: null,
    modelSource: "auto",
    meetingNoticeAccepted: false,
    meetingPanel: true,
    meetingPanelHidden: true,
    meetingHelpKeys: {},
    motion: "system",
    lastChatModel: null,
  },
  validators: {
    sidebarWidth: isPaneWidth,
    sidebarHidden: isBoolean,
    sandboxNoticeDismissed: isBoolean,
    openedBefore: isBoolean,
    gettingStarted: isGettingStarted,
    skillScriptsEnabled: isBoolean,
    skillScriptTimeoutSeconds: isScriptTimeout,
    suggestionOffers: (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100,
    tips: isTipCounts,
    meetingSystemAudio: isBoolean,
    transcriptionRoute: (value): value is TranscriptionRoute | null =>
      value === null || TRANSCRIPTION_ROUTES.some((route) => route === value),
    modelSource: (value): value is ModelSourceChoice =>
      MODEL_SOURCE_CHOICES.some((choice) => choice === value),
    meetingNoticeAccepted: isBoolean,
    meetingPanel: isBoolean,
    meetingPanelHidden: isBoolean,
    meetingHelpKeys: isHelpKeys,
    motion: (value): value is MotionPreference =>
      MOTION_PREFERENCES.some((preference) => preference === value),
    lastChatModel: isModelSetting,
  },
};

function validatorFor<T>(scope: Scope<T>, key: string) {
  return Object.hasOwn(scope.validators, key)
    ? (scope.validators[key as keyof T] as (value: unknown) => boolean)
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function read<T>(db: Database, scope: Scope<T>): T {
  const values = { ...scope.defaults } as Record<string, unknown>;
  const rows = db.all<{ key: string; value: string }>(
    `SELECT key, value FROM ${scope.table} WHERE deleted_at IS NULL`,
  );
  for (const row of rows) {
    // Keys this version doesn't know (e.g. written by a newer version) are left alone.
    const isValid = validatorFor(scope, row.key);
    if (!isValid) continue;
    const value = parseJson(row.value);
    if (value !== undefined && isValid(value)) values[row.key] = value;
  }
  return values as T;
}

function parsePatch<T>(scope: Scope<T>, patch: unknown): [string, unknown][] {
  if (patch === undefined) return [];
  if (!isRecord(patch))
    throw new InvalidInputError(`The ${scope.name} settings must be an object.`);
  return Object.entries(patch).map(([key, value]) => {
    const isValid = validatorFor(scope, key);
    if (!isValid) throw new InvalidInputError(`Unknown ${scope.name} setting "${key}".`);
    if (!isValid(value)) {
      throw new InvalidInputError(`Invalid value for the ${scope.name} setting "${key}".`);
    }
    return [key, value];
  });
}

function write(db: Database, table: string, key: string, value: unknown, at: string): void {
  const json = JSON.stringify(value);
  const existing = db.get<{ id: string }>(
    `SELECT id FROM ${table} WHERE key = ? AND deleted_at IS NULL`,
    [key],
  );
  if (existing) {
    db.run(`UPDATE ${table} SET value = ?, updated_at = ? WHERE id = ?`, [json, at, existing.id]);
  } else {
    db.run(`INSERT INTO ${table} (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
      randomUUID(),
      key,
      json,
      at,
      at,
    ]);
  }
}

export type SettingsStore = ReturnType<typeof createSettings>;

/**
 * `scriptSandbox`: the level of the Executor Skill scripts run on
 * (`Settings.scriptSandbox`); `meetingAudio`: what a Meeting can record here.
 */
export function createSettings(
  db: Database,
  now: () => string,
  systemLanguages: () => readonly string[],
  scriptSandbox: SandboxLevel,
  meetingAudio: Settings["meetingAudio"] = "none",
  systemUserName: () => string = () => "",
) {
  const get = (): Settings => {
    const user = read(db, userScope);
    const stored: Partial<ExportPreferences> = user.exportOptions;
    user.exportOptions = {
      ...user.exportOptions,
      docx: {
        ...WORD_DEFAULTS,
        ...user.exportOptions.docx,
        markAiText: markAiTextRead(user.exportOptions.docx.markAiText),
      },
      html: stored.html ?? { includeQuestions: false },
      "share-page": stored["share-page"] ?? SHARE_PAGE_DEFAULTS,
    };
    const device = read(db, deviceScope);
    const progress: Partial<GettingStarted> = device.gettingStarted;
    device.gettingStarted = {
      ...deviceScope.defaults.gettingStarted,
      ...progress,
      mistakeSeen: progress.mistakeSeen ?? progress.citationChecked ?? false,
    };
    const language = resolveLanguage(user.language, systemLanguages());
    const author = user.authorName ?? systemUserName().trim();
    return { user, device, language, scriptSandbox, meetingAudio, author };
  };

  return {
    get,

    update(patch: unknown): Settings {
      if (!isRecord(patch)) throw new InvalidInputError("updateSettings expects an object.");
      for (const key of Object.keys(patch)) {
        if (key !== "user" && key !== "device") {
          throw new InvalidInputError(`Unknown settings group "${key}".`);
        }
      }
      // Validate everything before writing anything.
      const changes = [
        ...parsePatch(userScope, patch.user).map((change) => [userScope.table, ...change] as const),
        ...parsePatch(deviceScope, patch.device).map(
          (change) => [deviceScope.table, ...change] as const,
        ),
      ];
      const at = now();
      db.transaction(() => {
        for (const [table, key, value] of changes) write(db, table, key, value, at);
      });
      return get();
    },

    /**
     * A per-device value the core keeps for itself, outside `DeviceSettings`,
     * so `updateSettings` can't change it (e.g. accepting plain-text secrets).
     */
    readDeviceValue(key: string): unknown {
      const row = db.get<{ value: string }>(
        `SELECT value FROM ${deviceScope.table} WHERE key = ? AND deleted_at IS NULL`,
        [key],
      );
      return row ? parseJson(row.value) : undefined;
    },

    writeDeviceValue(key: string, value: unknown): void {
      if (validatorFor(deviceScope, key)) throw new Error(`"${key}" is a device setting.`);
      write(db, deviceScope.table, key, value, now());
    },

    /** Forgets a value `writeDeviceValue` kept, e.g. one a removed feature left behind. */
    deleteDeviceValue(key: string): void {
      if (validatorFor(deviceScope, key)) throw new Error(`"${key}" is a device setting.`);
      const at = now();
      db.run(
        `UPDATE ${deviceScope.table} SET deleted_at = ?, updated_at = ? WHERE key = ? AND deleted_at IS NULL`,
        [at, at, key],
      );
    },
  };
}
