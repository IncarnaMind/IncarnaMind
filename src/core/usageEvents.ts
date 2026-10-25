/**
 * Usage data (#187): every event IncarnaMind can send, and every field of
 * each, in one place. Nothing else can be sent: the core checks each event
 * against this list before it leaves (`parseUsageEvent`), and
 * docs/privacy.md lists the same.
 *
 * A field is one of three kinds, and nothing else:
 * - `oneOf`: one value of a closed list, so no text the User wrote (a
 *   Document's name, a Question, a Folder or Tag name, a path) can fit;
 * - `count`: a whole number, 0 or more, such as a count or a duration;
 * - `flag`: true or false.
 *
 * Events go out only while the User agrees (./usage), under a random install
 * ID, with `COMMON_FIELDS`. The same names will serve the mobile app.
 *
 * Pure module, with no imports but types: the renderer may import it too.
 */
import type {
  ChatProviderKind,
  CitationCheck,
  ConnectorErrorKind,
  DocumentFailureReason,
  DocumentKind,
  ExampleGroup,
  ExportFormat,
  ProviderErrorKind,
} from "./api";
import type { Language } from "./language";

interface OneOf<V extends string> {
  readonly kind: "one-of";
  readonly values: readonly V[];
}

interface Count {
  readonly kind: "count";
}

interface Flag {
  readonly kind: "flag";
}

export type UsageField = OneOf<string> | Count | Flag;

const oneOf = <const V extends readonly string[]>(values: V): OneOf<V[number]> => ({
  kind: "one-of",
  values,
});
const count: Count = { kind: "count" };
const flag: Flag = { kind: "flag" };

/** True when `List` holds every member of `T` and nothing else: keeps a list here in step with its type. */
type Exactly<List extends readonly string[], T extends string> = [T] extends [List[number]]
  ? [List[number]] extends [T]
    ? true
    : never
  : never;

const LANGUAGES = ["en", "zh-CN"] as const;
const EXAMPLE_GROUPS = ["credit", "papers", "reports", "contracts", "meetings"] as const;
const PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "qwen",
  "kimi",
  "glm",
  "siliconflow",
  "mistral",
  "xai",
  "openrouter",
  "openai-compatible",
  "ollama",
  "chatgpt",
  "claude-account",
  "copilot",
] as const;
const CITATION_CHECKS = [
  "checking",
  "found",
  "not-found",
  "cant-check",
  "unsupported",
  "contradicted",
] as const;
const EXPORT_FORMATS = ["markdown", "docx", "pdf", "source-pack", "html", "share-page"] as const;

/** The Settings pages (src/renderer/src/settingsPages.ts; a test keeps them the same). */
export const SETTINGS_PAGES = [
  "general",
  "models",
  "search",
  "meetings",
  "connectors",
  "skills",
  "agents",
  "privacy",
] as const;

/**
 * The built-in Skills, the only Skill names ever sent (resources/skills; a
 * test keeps them the same). A Skill of the User's own is sent as "own".
 */
export const BUILT_IN_SKILL_NAMES = [
  "literature-review",
  "mind-to-report",
  "summarise-document",
] as const;

/** Where an error happened, for `error_occurred`. */
const ERROR_AREAS = ["answer", "document", "connector"] as const;
const ANSWER_ERRORS = [
  "auth",
  "model",
  "rate-limit",
  "network",
  "provider",
  "refused",
  "out-of-credit",
  "region",
  "consent-declined",
  "consent-revoked",
  "local-mode",
  "ollama-not-running",
  "data-retention",
  "not-signed-in",
  "plan-limit",
  "blocked",
  "too-long",
  "cost-cap",
  "no-answer",
  "unknown",
] as const;
const DOCUMENT_ERRORS = [
  "unreadable",
  "password-protected",
  "too-large",
  "file-missing",
  "processing-error",
  "pages-unread",
  "app-stopped",
] as const;
const CONNECTOR_ERRORS = [
  "missing-command",
  "missing-secrets",
  "timed-out",
  "stopped",
  "unreachable",
  "failed",
] as const;

/** Organize's model, by kind only: never which model, server or provider. */
const ORGANIZE_MODELS = ["chat", "jev", "auto", "ollama"] as const;

/** Each Document format, counted in `documents_added`. */
export const DOCUMENT_FORMATS = [
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "markdown",
  "text",
  "web",
  "transcript",
] as const satisfies readonly DocumentKind[];

// The lists above follow their types: a new kind fails the type-check until it is listed.
const _inStep: [
  Exactly<typeof LANGUAGES, Language>,
  Exactly<typeof EXAMPLE_GROUPS, ExampleGroup>,
  Exactly<typeof PROVIDER_KINDS, ChatProviderKind>,
  Exactly<typeof CITATION_CHECKS, CitationCheck>,
  Exactly<typeof EXPORT_FORMATS, ExportFormat>,
  Exactly<typeof ANSWER_ERRORS, ProviderErrorKind>,
  Exactly<typeof DOCUMENT_ERRORS, DocumentFailureReason>,
  Exactly<typeof CONNECTOR_ERRORS, ConnectorErrorKind>,
  Exactly<typeof DOCUMENT_FORMATS, DocumentKind>,
] = [true, true, true, true, true, true, true, true, true];
void _inStep;

/**
 * Every event, and its fields. Every field is required. Events marked in
 * `UI_USAGE_EVENTS` come from the interface; the core sends the others.
 */
export const USAGE_EVENTS = {
  /** IncarnaMind started. `language`: the interface language. */
  app_opened: { language: oneOf(LANGUAGES) },
  example_opened: { group: oneOf(EXAMPLE_GROUPS) },
  /** The User made a Mind (not the example Mind). */
  mind_created: {},
  /** An Answer started: the kind of provider of its model, and whether the model runs on this computer. */
  question_asked: { provider: oneOf(PROVIDER_KINDS), local: flag },
  /** An Answer finished or was stopped: how long it took, and its Citations by check. */
  answer_finished: {
    outcome: oneOf(["done", "stopped"]),
    duration_ms: count,
    citations: count,
    found: count,
    not_found: count,
    cant_check: count,
  },
  /** The User opened a Citation's card: its check. */
  citation_opened: { check: oneOf(CITATION_CHECKS) },
  /**
   * The User added files: how many became new Documents, how many were in
   * already, how many couldn't be added, and the new ones by format.
   */
  documents_added: {
    documents: count,
    already_added: count,
    skipped: count,
    pdf: count,
    docx: count,
    pptx: count,
    xlsx: count,
    csv: count,
    markdown: count,
    text: count,
    web: count,
    transcript: count,
  },
  /** The User linked a folder. */
  folder_linked: {},
  /** The User ran Organize: on how many Documents, whether on all of them, and the kind of model. */
  organize_run: { documents: count, all: flag, model: oneOf(ORGANIZE_MODELS) },
  /** The User exported a Mind: the format, and whether Questions were included. */
  mind_exported: { format: oneOf(EXPORT_FORMATS), questions: flag },
  /**
   * An Answer used a Connector, once per Connector and Answer: whether it is
   * remote. Every Connector is the User's own, so nothing names it.
   */
  connector_used: { remote: flag },
  /**
   * An Answer used a Skill, once per Skill and Answer: a built-in Skill's
   * name, or "own" for one of the User's; and whether the Question forced it.
   */
  skill_used: { skill: oneOf([...BUILT_IN_SKILL_NAMES, "own"]), forced: flag },
  /** Something failed: where, and the kind of error. Never its message. */
  error_occurred: {
    area: oneOf(ERROR_AREAS),
    kind: oneOf([...ANSWER_ERRORS, ...DOCUMENT_ERRORS, ...CONNECTOR_ERRORS]),
  },
  /** The User opened a Settings page. */
  settings_page_viewed: { page: oneOf(SETTINGS_PAGES) },
} as const satisfies Readonly<Record<string, Readonly<Record<string, UsageField>>>>;

/** The events the interface sends (`CoreApi.recordUsage`); the core sends the others itself. */
export const UI_USAGE_EVENTS = [
  "example_opened",
  "citation_opened",
  "settings_page_viewed",
] as const satisfies readonly (keyof typeof USAGE_EVENTS)[];

/**
 * Sent with every event, set by the core, never by a caller:
 * - `app_version`: this build's version, the only value accepted;
 * - `os` and `arch`: the operating system and processor family, "other"
 *   for any the app isn't built for;
 * - `build`: "tester" for a test build (for invited testers), otherwise "release".
 */
export const COMMON_FIELDS = {
  app_version: { kind: "app-version" },
  os: oneOf(["darwin", "win32", "linux", "other"]),
  arch: oneOf(["arm64", "x64", "other"]),
  build: oneOf(["release", "tester"]),
} as const;

/**
 * Added to every event by the desktop app's sender (src/main/usageAnalytics.ts)
 * and PostHog's SDK, the same for every event and every install:
 * - `$process_person_profile: false`: no person profile is made;
 * - `$geoip_disable: true`: no location is looked up;
 * - `$ip: "0.0.0.0"`: stored instead of the connection's IP address, which
 *   PostHog would otherwise fill in (it does for a missing or null `$ip`);
 * - `$lib` and `$lib_version`: the SDK's name and version.
 */
export const SENDER_FIELDS = [
  "$process_person_profile",
  "$geoip_disable",
  "$ip",
  "$lib",
  "$lib_version",
] as const;

export type UsageEventName = keyof typeof USAGE_EVENTS;
export type UiUsageEventName = (typeof UI_USAGE_EVENTS)[number];

type FieldValue<F> =
  F extends OneOf<infer V> ? V : F extends Count ? number : F extends Flag ? boolean : never;

/** An event's fields, as the type-checker enforces them: no free text fits. */
export type UsageEventFields<E extends UsageEventName> = {
  -readonly [K in keyof (typeof USAGE_EVENTS)[E]]: FieldValue<(typeof USAGE_EVENTS)[E][K]>;
};

/** One event, with its fields. */
export type UsageEvent = {
  [E in UsageEventName]: { event: E; fields: UsageEventFields<E> };
}[UsageEventName];

/** An event the interface sends. */
export type UiUsageEvent = Extract<UsageEvent, { event: UiUsageEventName }>;

/** A field's value as sent: one of a list's values, a count or a flag. */
export type UsageValue = string | number | boolean;

/** The largest count accepted: anything bigger is a bug, not a count. */
const MAX_COUNT = 1_000_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The reason `value` doesn't fit `field`, or null when it does. */
function misfit(field: UsageField, value: unknown): string | null {
  switch (field.kind) {
    case "one-of":
      return typeof value === "string" && field.values.includes(value)
        ? null
        : `must be one of ${field.values.join(", ")}`;
    case "count":
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_COUNT
        ? null
        : "must be a whole number, 0 or more";
    case "flag":
      return typeof value === "boolean" ? null : "must be true or false";
  }
}

export class InvalidUsageEventError extends Error {
  override name = "InvalidUsageEventError";
}

const isUsageEventName = (value: unknown): value is UsageEventName =>
  typeof value === "string" && Object.hasOwn(USAGE_EVENTS, value);

/**
 * Checks an event against the catalog at runtime: a known event, an object
 * with exactly its fields, each of the right kind. Returns a copy holding only
 * those fields; throws `InvalidUsageEventError` otherwise.
 */
export function parseUsageEvent(event: unknown, fields: unknown): UsageEvent {
  if (!isUsageEventName(event)) throw new InvalidUsageEventError(`Unknown usage event "${event}".`);
  if (!isRecord(fields)) throw new InvalidUsageEventError(`"${event}" needs an object of fields.`);
  const declared: Readonly<Record<string, UsageField>> = USAGE_EVENTS[event];
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(declared, key)) {
      throw new InvalidUsageEventError(`"${event}" has no field "${key}".`);
    }
  }
  const parsed: Record<string, UsageValue> = {};
  for (const [key, field] of Object.entries(declared)) {
    const value = fields[key];
    const problem = misfit(field, value);
    if (problem) throw new InvalidUsageEventError(`"${event}.${key}" ${problem}.`);
    parsed[key] = value as UsageValue;
  }
  return { event, fields: parsed } as UsageEvent;
}

/** The common fields, checked: `appVersion` is the only version accepted. */
export function parseCommonFields(
  appVersion: string,
  fields: Record<string, unknown>,
): Record<keyof typeof COMMON_FIELDS, UsageValue> {
  const parsed: Record<string, UsageValue> = {};
  for (const [key, field] of Object.entries(COMMON_FIELDS)) {
    const value = fields[key];
    const problem =
      field.kind === "app-version"
        ? value === appVersion
          ? null
          : "must be this build's version"
        : misfit(field, value);
    if (problem) throw new InvalidUsageEventError(`"${key}" ${problem}.`);
    parsed[key] = value as UsageValue;
  }
  return parsed as Record<keyof typeof COMMON_FIELDS, UsageValue>;
}
