import { type KeyboardEvent, useEffect, useId, useState } from "react";
import {
  type CostSummary,
  type Currency,
  MAX_MONTHLY_CAP,
  type MonthlyCap,
} from "../../../core/api";
import { core } from "../core";
import { formatMoney, formatSpent, setAsideText } from "../cost";
import { useLanguage, useT } from "../i18n";
import type { SettingsPage, SettingsTarget } from "../settingsPages";
import { useSettingsTarget } from "../settingsTarget";
import { useAppStore } from "../store";
import { ProblemMark } from "./ProblemLine";
import { PopUpSelect } from "./settings/PopUpButton";
import { SettingsRow } from "./settings/SettingsGroup";
import { errorTextClass, rowFieldClass } from "./ui";

/** A first cap, when the User turns it on: about what a light month on a strong model costs. */
const FIRST_CAP: Record<Currency, number> = { USD: 20, CNY: 150 };

const TARGET: readonly SettingsTarget[] = ["spending-cap"];

/**
 * This month's cost so far, read again each time Settings shows `page` and
 * whenever the cap changes. Null until read.
 */
export function useCostSummary(page: SettingsPage): CostSummary | null {
  const shown = useAppStore((state) => state.settingsOpen && state.settingsPage === page);
  const cap = useAppStore((state) => state.settings?.user.monthlyCap);
  const reportError = useAppStore((state) => state.reportError);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed cap is when to read it again, not what it is read from.
  useEffect(() => {
    if (shown) core.getCostSummary().then(setSummary, reportError);
  }, [shown, cap, reportError]);
  return summary;
}

/**
 * Settings › AI › Limits › Monthly spending cap (#83): what models billed per
 * token cost this month, and one optional cap, off by default. Its amount is
 * edited in place: Enter or leaving the field saves, Esc puts it back.
 */
export function SpendingCapRow() {
  const t = useT();
  const language = useLanguage();
  const cap = useAppStore((state) => state.settings?.user.monthlyCap);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const summary = useCostSummary("ai");
  const id = useId();
  const reached = useSettingsTarget<HTMLDivElement>(TARGET, cap !== undefined, () =>
    document.getElementById(id)?.focus({ preventScroll: true }),
  );
  const [draft, setDraft] = useState("");
  const [showProblem, setShowProblem] = useState(false);
  const capAmount = cap?.amount;
  const capCurrency = cap?.currency;
  useEffect(() => {
    if (capCurrency && capAmount !== undefined) setDraft(String(capAmount));
    setShowProblem(false);
  }, [capAmount, capCurrency]);
  if (cap === undefined) return null;

  const save = (next: MonthlyCap | null) => void updateSettings({ user: { monthlyCap: next } });
  const currency: Currency = cap?.currency ?? (language === "zh-CN" ? "CNY" : "USD");
  const typed = Number(draft);
  const empty = draft.trim() === "";
  const valid = !empty && Number.isFinite(typed) && typed >= 0 && typed <= MAX_MONTHLY_CAP;
  const problem = cap && showProblem && !valid;

  const commit = () => {
    if (!cap) return;
    if (empty) {
      setDraft(String(cap.amount));
      setShowProblem(false);
    } else if (!valid) {
      setShowProblem(true);
    } else {
      setShowProblem(false);
      if (typed !== cap.amount) save({ amount: typed, currency: cap.currency });
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape" && cap && draft !== String(cap.amount)) {
      // Esc puts a changed amount back, and doesn't close Settings as well.
      event.preventDefault();
      setDraft(String(cap.amount));
      setShowProblem(false);
    }
  };

  const spent = summary && formatSpent(summary.spent, t, language);
  const setAside = summary && setAsideText(summary.setAside, t, language);
  const unpriced = summary?.providers.reduce((sum, each) => sum + each.unpricedTokens, 0) ?? 0;
  const interrupted = summary?.providers.reduce((sum, each) => sum + each.interrupted, 0) ?? 0;
  const spentLine = !summary
    ? null
    : cap && summary.spentTowardCap
      ? t("cost.cap.spentOf", {
          spent: formatMoney(summary.spentTowardCap, language),
          cap: formatMoney(cap, language),
        })
      : spent
        ? t("cost.cap.spent", { spent })
        : t("cost.cap.nothing");

  return (
    <SettingsRow
      ref={reached}
      data-testid="spending-cap-settings"
      label={t("cost.cap.title")}
      htmlFor={id}
      tip={t("cost.cap.tip")}
      tipId={`${id}-tip`}
      detail={
        (spentLine || setAside || interrupted > 0 || unpriced > 0) && (
          <>
            {spentLine && <p data-testid="spending-cap-spent">{spentLine}</p>}
            {setAside && (
              <p data-testid="spending-cap-set-aside" title={t("cost.setAside.tip")}>
                {setAside}
              </p>
            )}
            {interrupted > 0 && (
              <p data-testid="spending-cap-interrupted">
                {interrupted === 1
                  ? t("cost.cap.interrupted.one")
                  : t("cost.cap.interrupted", { count: interrupted })}
              </p>
            )}
            {unpriced > 0 && (
              <p data-testid="spending-cap-unpriced">
                {t("cost.cap.unpriced", {
                  tokens: new Intl.NumberFormat(language).format(unpriced),
                })}
              </p>
            )}
          </>
        )
      }
      control={
        <>
          {cap && (
            <>
              <PopUpSelect
                aria-label={t("cost.cap.currency")}
                data-testid="spending-cap-currency"
                value={cap.currency}
                onChange={(event) => {
                  if (!valid && !empty) {
                    setShowProblem(true);
                    return;
                  }
                  save({
                    amount: valid ? typed : cap.amount,
                    currency: event.target.value === "CNY" ? "CNY" : "USD",
                  });
                }}
              >
                <option value="USD">$</option>
                <option value="CNY">¥</option>
              </PopUpSelect>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max={MAX_MONTHLY_CAP}
                step="any"
                aria-label={t("cost.cap.amount")}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? `${id}-problem` : undefined}
                data-testid="spending-cap-amount"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={onKeyDown}
                className={`${rowFieldClass} w-24`}
              />
            </>
          )}
          <input
            id={id}
            type="checkbox"
            role="switch"
            aria-checked={cap !== null}
            aria-describedby={`${id}-tip`}
            data-testid="spending-cap-switch"
            checked={cap !== null}
            onChange={(event) =>
              save(
                event.target.checked
                  ? { amount: valid && typed > 0 ? typed : FIRST_CAP[currency], currency }
                  : null,
              )
            }
            className="switch"
          />
        </>
      }
    >
      {problem && (
        <p
          id={`${id}-problem`}
          role="alert"
          data-testid="spending-cap-problem"
          className={errorTextClass}
        >
          <ProblemMark />
          {t("cost.cap.problem", {
            max: new Intl.NumberFormat(language).format(MAX_MONTHLY_CAP),
            cap: formatMoney(cap, language),
          })}
        </p>
      )}
    </SettingsRow>
  );
}
