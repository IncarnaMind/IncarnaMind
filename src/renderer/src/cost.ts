import type { ClaimCheckFailure, Money, RunEstimate, RunStop } from "../../core/api";
import type { Language } from "../../core/language";
import { formatDateTime } from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { budgetStopOf } from "../../shared/readBudget";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * An amount in its currency: cents, and a small amount to its first figures
 * rather than "$0.00", so one short Answer still shows ("$0.0013"). Each
 * currency has its one symbol in every language: "$", never "US$", and "¥".
 */
export function formatMoney({ amount, currency }: Money, language: Language): string {
  const small = amount > 0 && amount < 0.01;
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: amount === 0 ? 0 : 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(amount);
}

/**
 * What a check's reason says (`claim.reason.*`): a whole read stopped at its budget says what it
 * spent and the most it may spend, kept in `detail`, or that it stopped there when the detail
 * can't be read; any other reason says its `detail` as it is.
 */
export function reasonText(
  t: Translate,
  language: Language,
  reason: ClaimCheckFailure,
  detail: string | null,
  params: MessageParams = {},
): string {
  if (reason !== "read-budget")
    return t(`claim.reason.${reason}`, { detail: detail ?? "", ...params });
  const stop = budgetStopOf(detail);
  return stop
    ? t("claim.reason.read-budget", {
        spent: formatMoney(stop.spent, language),
        most: formatMoney(stop.most, language),
      })
    : t("claim.reason.read-budget.unknown");
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
  return amount && t("cost.setAside", { amount });
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
          t("cost.estimate.month", {
            spent: formatMoney(estimate.spentTowardCap, language),
            cap: formatMoney(estimate.cap, language),
          }),
          ...(aside ? [aside] : []),
        ]
      : [];
  const cost = estimate.cost && formatMoney(estimate.cost, language);
  const price =
    cost && most && estimate.cost && most.amount > estimate.cost.amount
      ? t("cost.estimate.priceUpTo", { cost, most: formatMoney(most, language) })
      : cost && t("cost.estimate.price", { cost });
  const run = price ? [price, tokens] : [tokens];
  const parts = [...run, ...month];
  return { parts, title: joinMeta(parts) };
}
