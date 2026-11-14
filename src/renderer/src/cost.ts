import type {
  ClaimCheckAttributes,
  ClaimCheckFailure,
  Money,
  RunEstimate,
  RunStop,
} from "../../core/api";
import type { Language } from "../../core/language";
import { absenceBesideFact, type ClaimCheckShown } from "../../shared/claimChecks";
import { formatDateTime } from "../../shared/dates";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import { citationLocation, formatLocation } from "../../shared/locations";
import { budgetStopOf } from "../../shared/readBudget";
import { unreadFiguresOf } from "../../shared/unreadFigures";

type Translate = (key: MessageKey, params?: MessageParams) => string;

const CENT = 0.01;

/**
 * An amount in its currency, in cents, wherever the app shows money: one under a cent reads
 * "under $0.01" (不到 $0.01), as "$0.01" would overstate it and "$0.00" call it free (#1554).
 * Each currency has its one symbol in every language: "$", never "US$", and "¥".
 */
export function formatMoney({ amount, currency }: Money, language: Language): string {
  const shown = (value: number) =>
    new Intl.NumberFormat(language, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: value === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  return amount > 0 && amount < CENT
    ? translate(language, "cost.underCent", { amount: shown(CENT) })
    : shown(amount);
}

/**
 * What an estimate from `cost` up to `most` says: "About $1.40", "About $0.40, up to $0.55";
 * "Up to $0.55" when only its low end is under a cent, and "Under $0.01" when all of it is, never
 * "About under $0.01". Null for a cost of exactly nothing, which shows no amount.
 */
export function estimateText(
  cost: Money,
  most: Money | null,
  t: Translate,
  language: Language,
): string | null {
  const top = most && most.amount > cost.amount ? most : cost;
  if (top.amount === 0) return null;
  if (top.amount < CENT) {
    return t("cost.estimate.under", {
      amount: formatMoney({ amount: CENT, currency: top.currency }, language),
    });
  }
  if (cost.amount < CENT) return t("cost.estimate.upTo", { most: formatMoney(top, language) });
  const about = formatMoney(cost, language);
  return top === cost
    ? t("cost.estimate.price", { cost: about })
    : t("cost.estimate.priceUpTo", { cost: about, most: formatMoney(top, language) });
}

/** A line that begins with an amount, its first letter in capitals: "Under $0.01 so far". */
export const atLineStart = (text: string): string =>
  text.charAt(0).toLocaleUpperCase() + text.slice(1);

/**
 * What a check's reason says (`claim.reason.*`): a whole read stopped at its budget says what it
 * spent, kept in `detail`, or that it stopped there when the detail can't be read; the most it
 * may spend goes on the action that reads the rest (`readRestText`). Figures that couldn't be read
 * name the Document and the place kept in `detail`; any other reason says its `detail` as it is.
 */
export function reasonText(
  t: Translate,
  language: Language,
  reason: ClaimCheckFailure,
  detail: string | null,
  params: MessageParams = {},
): string {
  if (reason === "figures-not-read") return figuresNotReadText(t, detail);
  if (reason !== "read-budget")
    return t(`claim.reason.${reason}`, { detail: detail ?? "", ...params });
  const stop = budgetStopOf(detail);
  return stop
    ? t("claim.reason.read-budget", { spent: atLineStart(formatMoney(stop.spent, language)) })
    : t("claim.reason.read-budget.unknown");
}

/** A Not checked sentence's line: what was checked, when only what it says is missing went unread beside a Supported part. */
export function sentenceReasonText(
  t: Translate,
  language: Language,
  shown: Extract<ClaimCheckShown, { state: "not-checked" }>,
  check: Pick<ClaimCheckAttributes, "parts" | "detail">,
  params: MessageParams = {},
): string {
  return absenceBesideFact(check, shown)
    ? t("claim.absenceBesideFact")
    : reasonText(t, language, shown.reason, check.detail, params);
}

/** The action that reads the rest of a read stopped at its budget, with the most it may spend. */
export function readRestText(t: Translate, language: Language, detail: string | null): string {
  const stop = budgetStopOf(detail);
  return stop
    ? t("claim.readBudget.readRest", { most: formatMoney(stop.most, language) })
    : t("claim.readBudget.continue");
}

/**
 * A model's estimate where models are compared, for 100 Answers, under a heading that says so, so
 * those under a cent an Answer still differ: "About $0.40". Null for one of exactly nothing.
 */
export const perHundredAnswers = (
  perAnswer: Money,
  t: Translate,
  language: Language,
): string | null =>
  estimateText({ ...perAnswer, amount: perAnswer.amount * 100 }, null, t, language);

function figuresNotReadText(t: Translate, detail: string | null): string {
  const place = unreadFiguresOf(detail);
  if (!place) return t("claim.reason.figures-not-read.unknown");
  const location = citationLocation(place);
  return location
    ? t("claim.reason.figures-not-read", {
        document: place.documentName,
        location: formatLocation(location, t),
      })
    : t("claim.reason.figures-not-read.whole", { document: place.documentName });
}

/** Amounts in one or two currencies: "$3.20", "$3.20 and ¥1.40"; null for none. */
export function formatSpent(
  spent: readonly Money[],
  t: Translate,
  language: Language,
): string | null {
  const [first, second] = spent.map((each) => formatMoney(each, language));
  if (!first) return null;
  return second ? t("cost.and", { first, second }) : first;
}

export function setAsideText(
  setAside: readonly Money[],
  t: Translate,
  language: Language,
): string | null {
  const amount = formatSpent(
    setAside.filter((each) => each.amount > 0),
    t,
    language,
  );
  return amount && atLineStart(t("cost.setAside", { amount }));
}

/** When a plan's limit resets: the time today, else the day and time. */
export function formatResetTime(iso: string, language: Language, now = new Date()): string {
  return formatDateTime(iso, language, { now });
}

export function runStopParts(
  stop: RunStop,
  t: Translate,
  language: Language,
  now = new Date(),
): string[] {
  if (stop.reason === "cost-cap") return [t("run.stopped.cost-cap")];
  const line = t("run.stopped.plan-limit");
  return stop.resetsAt
    ? [line, t("run.stopped.tryAfter", { time: formatResetTime(stop.resetsAt, language, now) })]
    : [line];
}

/** For a place that doesn't wrap: "Plan limit reached · Try again after 14:30". */
export const runStopText = (
  stop: RunStop,
  t: Translate,
  language: Language,
  now = new Date(),
): string => joinMeta(runStopParts(stop, t, language, now));

/** What each unfinished item of a stopped run says: "not checked: cost cap". */
export const notCheckedKey = (stop: RunStop): MessageKey =>
  stop.reason === "cost-cap" ? "run.notChecked.cost-cap" : "run.notChecked.plan-limit";

/** Parts of a meta line on one line, joined by middle dots; `MetaLine` is for lines that can wrap. */
export const joinMeta = (parts: readonly string[]): string => parts.filter(Boolean).join(" · ");

/**
 * A token count, short and to the same three figures in every language: 708K is 70.8万, where
 * each language's own rounding would make it 71万.
 */
export const formatTokens = (tokens: number, language: Language): string =>
  new Intl.NumberFormat(language, { notation: "compact", maximumSignificantDigits: 3 }).format(
    tokens,
  );

export interface EstimateLine {
  parts: string[];
  title: string;
  /** The provider whose price the line's first part is worked out from; absent when it shows no price. */
  providerId?: string;
}

/**
 * The line before a large run on a model billed per token, shown and never
 * asked: "About $1.40 · 310K tokens · $12.40 of $20.00 used this month"
 * (price first, as DESIGN.md's plan card writes it), or "About $0.40, up
 * to $0.55" when what it reads may ask for more requests. A run that would cost a
 * dollar or less shows none unless a monthly cap is set, whose month so far
 * is worth seeing (#1941); so does one no price is known for. Null for a
 * plan or a model on this computer, which show nothing. `always` is for a
 * confirmation that has already been chosen, where every known estimate shows.
 */
export function estimateLine(
  estimate: RunEstimate,
  t: Translate,
  language: Language,
  options: { always?: boolean } = {},
): EstimateLine | null {
  if (estimate.billing !== "per-token") return null;
  const most = estimate.upTo?.cost ?? estimate.cost;
  if (!options.always && !estimate.cap && !(most !== null && most.amount > 1)) return null;
  const tokens = t("cost.estimate.tokens", { tokens: formatTokens(estimate.tokens, language) });
  const aside = estimate.setAsideTowardCap
    ? setAsideText([estimate.setAsideTowardCap], t, language)
    : null;
  const month =
    estimate.cap && estimate.spentTowardCap
      ? [
          atLineStart(
            t("cost.estimate.month", {
              spent: formatMoney(estimate.spentTowardCap, language),
              cap: formatMoney(estimate.cap, language),
            }),
          ),
          ...(aside ? [aside] : []),
        ]
      : [];
  const price = estimate.cost && estimateText(estimate.cost, most, t, language);
  const run = price ? [price, tokens] : [tokens];
  const parts = [...run, ...month];
  return { parts, title: joinMeta(parts), ...(price && { providerId: estimate.providerId }) };
}
