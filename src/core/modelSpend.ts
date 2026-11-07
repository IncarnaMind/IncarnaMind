/**
 * The weekly model-spend usage event (#1993): once a completed week with a
 * model call in it, and only while the User agrees to usage data (./usageData),
 * how much that week's models cost as a range, the kind of route that paid,
 * and how many Questions and checks there were. Every value is a closed list's
 * value or a count: never a model's name, a Question, a Document or anything
 * the User wrote.
 *
 * The range is what the cost record's own estimate says the week cost (the
 * same per-request estimate the monthly cap sums, ./cost/meter), not a
 * provider's bill. A week with no model call sends nothing, and a week the
 * User had usage data off for is not sent later.
 */
import type { Currency } from "./api";
import { inCurrency } from "./cost/price";
import { catalogProviderOf } from "./providers/catalog/providers";
import { isChatProviderKind } from "./providers/kinds";
import type { SettingsStore } from "./settings";
import type { Database } from "./storage";
import type { UsageEvent, UsageEventFields } from "./usageEvents";
import { SPEND_PROVIDER_KINDS } from "./usageEvents";

type SpendFields = UsageEventFields<"model_spend_week">;
type ProviderKind = SpendFields["provider_kind"];
type Route = SpendFields["route"];

const REPORTED = "usageData.spendWeek";
/** The Questions started this week: a Note keeps its Questions in its own Blocks, so they are counted as they start. */
const QUESTIONS = "usageData.spendQuestions";
const CHECK_EVERY_MS = 60 * 60 * 1000;

/** The closed kind of a provider's service: a provider's own name, region or model is never sent. */
const SPECIAL_PROVIDERS: Readonly<Record<string, ProviderKind>> = {
  anthropic: "anthropic",
  "claude-account": "anthropic",
  openai: "openai",
  chatgpt: "openai",
  google: "google",
  openrouter: "openrouter",
  ollama: "ollama",
};

function providerKindOf(kind: string | null, catalogId: string | null): ProviderKind {
  const special = SPECIAL_PROVIDERS[kind ?? ""];
  if (special) return special;
  const known = kind !== null && isChatProviderKind(kind) ? kind : null;
  return known !== null && catalogProviderOf(known, catalogId)?.group === "china"
    ? "china"
    : "other";
}

const currencyOf = (value: string | null): Currency | null =>
  value === "USD" || value === "CNY" ? value : null;

function spendRange(usd: number): SpendFields["spend_range"] {
  if (usd <= 0) return "0";
  if (usd < 1) return "under_1";
  if (usd < 5) return "1_5";
  if (usd < 20) return "5_20";
  if (usd < 50) return "20_50";
  return "over_50";
}

/** Local midnight of the day `days` before `at`, which keeps the week on the computer's calendar. */
const dayStart = (at: Date, days: number) =>
  new Date(at.getFullYear(), at.getMonth(), at.getDate() - days);

/** This week's Monday midnight and the last completed week's, in the computer's time zone. */
function weekStarts(at: Date): { thisWeek: Date; lastWeek: Date } {
  const sinceMonday = (at.getDay() + 6) % 7;
  return {
    thisWeek: dayStart(at, sinceMonday),
    lastWeek: dayStart(at, sinceMonday + 7),
  };
}

interface RequestRow {
  provider_id: string;
  billing: string;
  currency: string | null;
  requests: number;
  settled: number;
}

interface TimingRow {
  provider_kind: string | null;
  requests: number;
}

interface ProviderRow {
  id: string;
  kind: string;
  catalog_id: string | null;
}

interface QuestionTally {
  week: string;
  questions: number;
}

/** The week's Questions, from its tally; 0 for a week the tally doesn't cover. */
function questionsIn(settings: SettingsStore, week: string): number {
  const stored = settings.readDeviceValue(QUESTIONS);
  return typeof stored === "object" &&
    stored !== null &&
    "week" in stored &&
    stored.week === week &&
    "questions" in stored &&
    typeof stored.questions === "number" &&
    Number.isInteger(stored.questions) &&
    stored.questions >= 0
    ? stored.questions
    : 0;
}

/** The week's fields, or null when no model was called in it. */
function weekFields(db: Database, start: Date, end: Date, questions: number): SpendFields | null {
  const from = start.toISOString();
  const to = end.toISOString();
  // The cost record's own rows, without cloud transcription's, which has no model call.
  const requests = db.all<RequestRow>(
    `SELECT provider_id, billing, currency, count(*) AS requests,
       coalesce(sum(CASE WHEN status <> 'reserved' THEN cost END), 0) AS settled
     FROM model_requests
     WHERE flow <> 'transcription' AND created_at >= ? AND created_at < ?
     GROUP BY provider_id, billing, currency`,
    [from, to],
  );
  const metered = requests.reduce((sum, row) => sum + row.requests, 0);
  const timings = db.all<TimingRow>(
    `SELECT provider_kind, count(*) AS requests FROM ai_timings
     WHERE kind = 'model' AND started_at >= ? AND started_at < ?
     GROUP BY provider_kind ORDER BY requests DESC`,
    [from, to],
  );
  const timed = timings.reduce((sum, row) => sum + row.requests, 0);
  if (metered === 0 && timed === 0) return null;
  // Every cloud request has its own model_requests row; a model on this computer is
  // free and has none, so timed requests beyond the metered ones are local calls.
  const local = timed > metered;

  const providers = new Map(
    db
      .all<ProviderRow>("SELECT id, kind, catalog_id FROM chat_providers")
      .map((row) => [row.id, row]),
  );
  const routes = new Set<Route>();
  const byKind = new Map<ProviderKind, { spend: number; requests: number }>();
  let spentUsd = 0;
  for (const row of requests) {
    const currency = currencyOf(row.currency);
    const spend =
      row.billing === "per-token" && currency ? inCurrency(row.settled, currency, "USD") : 0;
    spentUsd += spend;
    if (row.billing === "per-token") routes.add("own_key");
    else if (row.billing === "plan") routes.add("subscription_sign_in");
    else if (row.billing === "free") routes.add("local");
    const provider = providers.get(row.provider_id);
    const kind = providerKindOf(provider?.kind ?? null, provider?.catalog_id ?? null);
    const before = byKind.get(kind) ?? { spend: 0, requests: 0 };
    byKind.set(kind, {
      spend: before.spend + spend,
      requests: before.requests + row.requests,
    });
  }
  if (local) routes.add("local");
  if (routes.size === 0) return null;

  const ranked = [...byKind].sort(
    ([aKind, a], [bKind, b]) =>
      b.spend - a.spend ||
      b.requests - a.requests ||
      SPEND_PROVIDER_KINDS.indexOf(aKind) - SPEND_PROVIDER_KINDS.indexOf(bKind),
  );
  const providerKind = ranked[0]?.[0] ?? providerKindOf(timings[0]?.provider_kind ?? null, null);
  const route = routes.size > 1 ? "mixed" : (routes.values().next().value ?? "local");
  const checks =
    db.get<{ n: number }>(
      `SELECT count(*) AS n FROM ai_use
       WHERE kind = 'sentence-checked' AND occurred_at >= ? AND occurred_at < ?`,
      [from, to],
    )?.n ?? 0;

  return {
    spend_range: spendRange(spentUsd),
    route,
    provider_kind: providerKind,
    questions,
    checks,
  };
}

export type ModelSpend = ReturnType<typeof createModelSpend>;

export function createModelSpend(options: {
  db: Database;
  settings: SettingsStore;
  now: () => Date;
  /** Whether usage data is sending now; false sends nothing and marks the week as not to send. */
  sending: () => boolean;
  record: (event: UsageEvent) => void;
  /** Defaults to the console. */
  reportError?: (error: unknown) => void;
}) {
  const reportError = options.reportError ?? ((error: unknown) => console.error(error));
  let timer: ReturnType<typeof setInterval> | undefined;

  const check = () => {
    try {
      const { thisWeek, lastWeek } = weekStarts(options.now());
      const last = lastWeek.toISOString();
      const reported = options.settings.readDeviceValue(REPORTED);
      if (typeof reported === "string" && reported >= last) return;
      // Marked before anything is sent: a week with usage data off, or with no
      // model call in it, is not sent later.
      options.settings.writeDeviceValue(REPORTED, last);
      if (!options.sending()) return;
      const fields = weekFields(
        options.db,
        lastWeek,
        thisWeek,
        questionsIn(options.settings, last),
      );
      if (fields) options.record({ event: "model_spend_week", fields });
    } catch (error) {
      reportError(error);
    }
  };

  return {
    /** Checks for a completed week now, and every hour while the app stays open. */
    start(): void {
      check();
      timer = setInterval(check, CHECK_EVERY_MS);
      timer.unref?.();
    },
    /** An Answer to a Question started: counted for the week it starts in. */
    questionAsked(): void {
      try {
        // A completed week is read before the tally moves on, even if the app stayed open.
        check();
        const week = weekStarts(options.now()).thisWeek.toISOString();
        const tally: QuestionTally = { week, questions: questionsIn(options.settings, week) + 1 };
        options.settings.writeDeviceValue(QUESTIONS, tally);
      } catch (error) {
        reportError(error);
      }
    },
    close(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
