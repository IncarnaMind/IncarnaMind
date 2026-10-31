import { describe, expect, test } from "vitest";
import {
  estimateLine,
  formatMoney,
  formatSpent,
  formatTokens,
  notCheckedKey,
  reasonText,
  runStopParts,
  runStopText,
  setAsideText,
} from "../../src/renderer/src/cost";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const t =
  (language: "en" | "zh-CN") =>
  (key: MessageKey, params?: MessageParams): string =>
    translate(language, key, params);

describe("Cost in words", () => {
  test("amounts show cents, and a small one its first figures rather than nothing", () => {
    expect(formatMoney({ amount: 3.2, currency: "USD" }, "en")).toBe("$3.20");
    expect(formatMoney({ amount: 0.0013, currency: "USD" }, "en")).toBe("$0.0013");
    expect(formatMoney({ amount: 0, currency: "USD" }, "en")).toBe("$0");
    expect(formatMoney({ amount: 1.4, currency: "CNY" }, "zh-CN")).toBe("¥1.40");
  });

  test.each(["en", "zh-CN"] as const)(
    'dollars are "$" and yuan "¥" in %s, never "US$" or "CN¥"',
    (language) => {
      expect(formatMoney({ amount: 1.4, currency: "USD" }, language)).toBe("$1.40");
      expect(formatMoney({ amount: 1.4, currency: "CNY" }, language)).toBe("¥1.40");
      expect(formatMoney({ amount: 0.0013, currency: "USD" }, language)).toBe("$0.0013");
      expect(formatMoney({ amount: 0.0013, currency: "CNY" }, language)).toBe("¥0.0013");
    },
  );

  test("what is set aside for running work is named apart from what was spent, and absent when nothing is", () => {
    const aside = [{ amount: 1.28, currency: "USD" as const }];
    expect(setAsideText(aside, t("en"), "en")).toBe("$1.28 set aside for work in progress");
    expect(setAsideText(aside, t("zh-CN"), "zh-CN")).toBe("进行中的任务预留 $1.28");
    expect(
      setAsideText([...aside, { amount: 1.4, currency: "CNY" as const }], t("zh-CN"), "zh-CN"),
    ).toBe("进行中的任务预留 $1.28 和 ¥1.40");
    expect(setAsideText([], t("en"), "en")).toBeNull();
    expect(setAsideText([{ amount: 0, currency: "USD" }], t("en"), "en")).toBeNull();
    expect(translate("en", "cost.provider.thisMonth", { spent: "$0.01" })).toBe(
      "This month: $0.01 spent",
    );
    expect(translate("zh-CN", "cost.provider.thisMonth", { spent: "$0.01" })).toBe(
      "本月已花 $0.01",
    );
    expect(translate("en", "cost.setAside.tip")).toBe(
      "Kept aside so running work can’t go over your monthly limit",
    );
    expect(translate("zh-CN", "cost.setAside.tip")).toBe(
      "预留出来，避免进行中的任务超出你的月度上限",
    );
  });

  test("spending in two currencies names both, told apart by their symbols", () => {
    const spent = [
      { amount: 3.2, currency: "USD" as const },
      { amount: 1.4, currency: "CNY" as const },
    ];
    expect(formatSpent(spent, t("en"), "en")).toBe("$3.20 and ¥1.40");
    expect(formatSpent(spent, t("zh-CN"), "zh-CN")).toBe("$3.20 和 ¥1.40");
    expect(formatSpent([], t("en"), "en")).toBeNull();
  });

  test("a stopped run says why, with when to try again when the provider said", () => {
    const now = new Date(2026, 9, 12, 9, 0);
    const later = new Date(2026, 9, 12, 14, 30).toISOString();
    expect(runStopText({ reason: "cost-cap" }, t("en"), "en", now)).toBe(
      "Could pass your monthly cap",
    );
    expect(runStopText({ reason: "plan-limit", resetsAt: null }, t("en"), "en", now)).toBe(
      "Plan limit reached",
    );
    expect(runStopText({ reason: "plan-limit", resetsAt: later }, t("en"), "en", now)).toMatch(
      /^Plan limit reached · Try again after (14:30|2:30 pm)$/,
    );
    expect(
      runStopText({ reason: "plan-limit", resetsAt: later }, t("zh-CN"), "zh-CN", now),
    ).toMatch(/^已达到订阅用量上限 · (14:30|下午2:30) 后可重试$/);
    const parts = runStopParts({ reason: "plan-limit", resetsAt: later }, t("en"), "en", now);
    expect(parts[0]).toBe("Plan limit reached");
    expect(parts[1]).toMatch(/^Try again after (14:30|2:30 pm)$/);
    expect(parts).toHaveLength(2);
    expect(runStopParts({ reason: "cost-cap" }, t("en"), "en", now)).toEqual([
      "Could pass your monthly cap",
    ]);
    const tomorrow = new Date(2026, 9, 13, 14, 30).toISOString();
    expect(runStopText({ reason: "plan-limit", resetsAt: tomorrow }, t("en"), "en", now)).toMatch(
      /^Plan limit reached · Try again after 13 Oct, (14:30|2:30 pm)$/,
    );
  });

  test("the items a stop left say they weren't checked, and why", () => {
    expect(translate("en", notCheckedKey({ reason: "cost-cap" }))).toBe("not checked: cost cap");
    expect(translate("en", notCheckedKey({ reason: "plan-limit", resetsAt: null }))).toBe(
      "not checked: plan limit",
    );
    expect(translate("zh-CN", notCheckedKey({ reason: "cost-cap" }))).toBe("未核对：已达花费上限");
  });

  test("the estimate shows above a dollar or under a cap, with tokens and the month so far, never model calls; a plan or this computer shows none", () => {
    const estimate = {
      billing: "per-token" as const,
      calls: 24,
      tokens: 310_000,
      cost: { amount: 1.4, currency: "USD" as const },
      spentTowardCap: { amount: 12.4, currency: "USD" as const },
      setAsideTowardCap: { amount: 0, currency: "USD" as const },
      cap: { amount: 20, currency: "USD" as const },
    };
    const en = estimateLine(estimate, t("en"), "en");
    expect(en?.parts).toEqual(["About $1.40", "310K tokens", "$12.40 of $20.00 used this month"]);
    expect(en?.title).toBe("About $1.40 · 310K tokens · $12.40 of $20.00 used this month");
    expect(
      estimateLine(
        { ...estimate, setAsideTowardCap: { amount: 1.28, currency: "USD" } },
        t("en"),
        "en",
      )?.parts,
    ).toEqual([
      "About $1.40",
      "310K tokens",
      "$12.40 of $20.00 used this month",
      "$1.28 set aside for work in progress",
    ]);
    // Above a dollar, with no cap set: the price and the tokens, nothing of the month.
    expect(
      estimateLine(
        { ...estimate, cap: null, spentTowardCap: null, setAsideTowardCap: null },
        t("en"),
        "en",
      )?.parts,
    ).toEqual(["About $1.40", "310K tokens"]);
    // A small run shows no price line unless a cap is set (#1941).
    expect(
      estimateLine(
        {
          ...estimate,
          cost: { amount: 0.4, currency: "USD" },
          cap: null,
          spentTowardCap: null,
          setAsideTowardCap: null,
        },
        t("en"),
        "en",
      ),
    ).toBeNull();
    expect(
      estimateLine({ ...estimate, cost: { amount: 1, currency: "USD" } }, t("en"), "en"),
    ).not.toBeNull();
    for (const amount of [0.4, 1]) {
      expect(
        estimateLine(
          {
            ...estimate,
            cost: { amount, currency: "USD" },
            cap: null,
            spentTowardCap: null,
            setAsideTowardCap: null,
          },
          t("en"),
          "en",
          { always: true },
        )?.parts,
      ).toEqual([`About $${amount.toFixed(2)}`, "310K tokens"]);
    }
    expect(estimateLine({ ...estimate, cost: null }, t("en"), "en")?.parts).toEqual([
      "310K tokens",
      "$12.40 of $20.00 used this month",
    ]);
    // No price known and no cap: nothing tells whether it is above a dollar, so no line.
    expect(estimateLine({ ...estimate, cost: null, cap: null }, t("en"), "en")).toBeNull();
    expect(
      estimateLine({ ...estimate, cost: { amount: 0.4, currency: "USD" } }, t("zh-CN"), "zh-CN")
        ?.parts,
    ).toEqual(["约 $0.40", "31万 token", "本月已用 $12.40，上限 $20.00"]);
    // A read that may send more than it does names the most it may cost; that most counts toward
    // showing the line at all.
    const upTo = {
      ...estimate,
      cost: { amount: 0.4, currency: "USD" as const },
      upTo: { calls: 30, tokens: 340_000, cost: { amount: 1.2, currency: "USD" as const } },
      cap: null,
      spentTowardCap: null,
      setAsideTowardCap: null,
    };
    expect(estimateLine(upTo, t("en"), "en")?.parts).toEqual([
      "About $0.40, up to $1.20",
      "310K tokens",
    ]);
    expect(estimateLine(upTo, t("zh-CN"), "zh-CN")?.parts).toEqual([
      "约 $0.40，最多 $1.20",
      "31万 token",
    ]);
    expect(
      estimateLine(
        { ...upTo, upTo: { ...upTo.upTo, cost: { amount: 0.4, currency: "USD" } } },
        t("en"),
        "en",
        { always: true },
      )?.parts,
    ).toEqual(["About $0.40", "310K tokens"]);
    expect(estimateLine({ billing: "plan" }, t("en"), "en")).toBeNull();
    expect(estimateLine({ billing: "free" }, t("en"), "en")).toBeNull();
    // "model calls" never appears in the interface (#1941).
    for (const line of [en, estimateLine(estimate, t("zh-CN"), "zh-CN")]) {
      expect([...(line?.parts ?? []), line?.title ?? ""].join(" ")).not.toMatch(
        /model calls?|模型调用/,
      );
    }
  });
});

test.each([
  [708_000, "708K", "70.8万"],
  [2_710_000, "2.71M", "271万"],
  [310_000, "310K", "31万"],
  [12_345_678, "12.3M", "1230万"],
])("%d tokens read to the same three figures in English and Chinese", (tokens, en, zh) => {
  expect(formatTokens(tokens, "en")).toBe(en);
  expect(formatTokens(tokens, "zh-CN")).toBe(zh);
});

describe("A whole read stopped at the most it may spend", () => {
  test.each([
    ["en", "Stopped after $0.38; this read may spend up to $0.41.", "Continue"],
    ["zh-CN", "已花 $0.38 后停止，这次读取最多可花 $0.41。", "继续"],
  ] as const)("says what it spent and its most, with Continue (%s)", (language, line, action) => {
    const detail = JSON.stringify({
      most: { amount: 0.41, currency: "USD" },
      spent: { amount: 0.38, currency: "USD" },
      judgesAbsence: false,
    });
    expect(reasonText(t(language), language, "read-budget", detail)).toBe(line);
    expect(t(language)("claim.readBudget.continue")).toBe(action);
  });

  test.each([
    ["en", "Stopped at the most this read may spend."],
    ["zh-CN", "已停止：已达到这次读取最多可花的费用。"],
  ] as const)(
    "a detail it can't read still says it stopped, without amounts (%s)",
    (language, line) => {
      expect(reasonText(t(language), language, "read-budget", "not money")).toBe(line);
      expect(
        reasonText(
          t(language),
          language,
          "read-budget",
          JSON.stringify({ most: { amount: "0.41" } }),
        ),
      ).toBe(line);
    },
  );

  test("another reason says its detail as it is", () => {
    expect(reasonText(t("en"), "en", "failed", "The service failed.")).toBe(
      "The check failed: The service failed.",
    );
  });
});
