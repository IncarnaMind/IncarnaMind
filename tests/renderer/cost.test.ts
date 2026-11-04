import { describe, expect, test } from "vitest";
import {
  atLineStart,
  estimateLine,
  estimateText,
  formatMoney,
  formatSpent,
  formatTokens,
  notCheckedKey,
  perHundredAnswers,
  readRestText,
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
  test("amounts show cents, and one under a cent says so, never a cent or nothing", () => {
    expect(formatMoney({ amount: 3.2, currency: "USD" }, "en")).toBe("$3.20");
    expect(formatMoney({ amount: 0.0013, currency: "USD" }, "en")).toBe("under $0.01");
    expect(formatMoney({ amount: 0.0099, currency: "USD" }, "en")).toBe("under $0.01");
    expect(formatMoney({ amount: 0.0013, currency: "USD" }, "zh-CN")).toBe("不到 $0.01");
    expect(formatMoney({ amount: 0.0013, currency: "CNY" }, "zh-CN")).toBe("不到 ¥0.01");
    expect(formatMoney({ amount: 0.01, currency: "USD" }, "en")).toBe("$0.01");
    expect(formatMoney({ amount: 0.0148, currency: "USD" }, "en")).toBe("$0.01");
    expect(formatMoney({ amount: 1.4, currency: "CNY" }, "zh-CN")).toBe("¥1.40");
  });

  test.each(["en", "zh-CN"] as const)(
    'dollars are "$" and yuan "¥" in %s, never "US$" or "CN¥"',
    (language) => {
      expect(formatMoney({ amount: 1.4, currency: "USD" }, language)).toBe("$1.40");
      expect(formatMoney({ amount: 1.4, currency: "CNY" }, language)).toBe("¥1.40");
    },
  );

  test.each([
    ["en", "About $1.40", "About $0.40, up to $0.55", "Up to $0.03", "Under $0.01"],
    ["zh-CN", "约 $1.40", "约 $0.40，最多 $0.55", "最多 $0.03", "不到 $0.01"],
  ] as const)(
    "an estimate says its low end only when it is a cent or more, and none for nothing (%s)",
    (language, about, range, upTo, under) => {
      const usd = (amount: number) => ({ amount, currency: "USD" as const });
      const said = (cost: number, most: number | null) =>
        estimateText(usd(cost), most === null ? null : usd(most), t(language), language);
      expect(said(1.4, null)).toBe(about);
      expect(said(1.4, 1.4)).toBe(about);
      expect(said(0.4, 0.55)).toBe(range);
      expect(said(0.004, 0.03)).toBe(upTo);
      expect(said(0, 0.03)).toBe(upTo);
      expect(said(0.002, 0.006)).toBe(under);
      expect(said(0.004, null)).toBe(under);
      expect(said(0, null)).toBeNull();
      expect(said(0, 0)).toBeNull();
    },
  );

  test("an estimate under a cent is never About under $0.01, and one of nothing shows no price", () => {
    const run = {
      billing: "per-token" as const,
      calls: 2,
      tokens: 1_200,
      cost: { amount: 0.004, currency: "USD" as const },
      spentTowardCap: null,
      setAsideTowardCap: null,
      cap: null,
    };
    expect(estimateLine(run, t("en"), "en", { always: true })?.parts).toEqual([
      "Under $0.01",
      "1.2K tokens",
    ]);
    expect(
      estimateLine(
        {
          ...run,
          upTo: { calls: 4, tokens: 30_000, cost: { amount: 0.03, currency: "USD" as const } },
        },
        t("zh-CN"),
        "zh-CN",
        { always: true },
      )?.parts,
    ).toEqual(["最多 $0.03", "1200 token"]);
    expect(
      estimateLine({ ...run, cost: { amount: 0, currency: "USD" as const } }, t("en"), "en", {
        always: true,
      })?.parts,
    ).toEqual(["1.2K tokens"]);
  });

  test("in Chinese, an amount under a cent sits in its sentence with no space between Chinese words", () => {
    const under = formatMoney({ amount: 0.0048, currency: "USD" }, "zh-CN");
    const most = formatMoney({ amount: 0.5, currency: "USD" }, "zh-CN");
    expect(translate("zh-CN", "claim.reason.read-budget", { spent: under })).toBe(
      "已停止 · 已花费不到 $0.01",
    );
    expect(translate("zh-CN", "claim.readBudget.readRest", { most })).toBe(
      "读取其余部分 · 最多 $0.50",
    );
    expect(translate("zh-CN", "cost.provider.thisMonth", { spent: under })).toBe(
      "本月已花不到 $0.01",
    );
    expect(translate("zh-CN", "task.details.cost", { cost: under })).toBe("目前已花费不到 $0.01");
    expect(setAsideText([{ amount: 0.004, currency: "USD" }], t("zh-CN"), "zh-CN")).toBe(
      "进行中的任务预留不到 $0.01",
    );
    expect(translate("zh-CN", "cost.estimate.month", { spent: under, cap: "$20.00" })).toBe(
      "本月已用不到 $0.01，上限 $20.00",
    );
  });

  test.each([
    ["en", "Stopped · Under $0.01 spent", "Read the rest · up to $0.50"],
    ["zh-CN", "已停止 · 已花费不到 $0.01", "读取其余部分 · 最多 $0.50"],
  ] as const)(
    "a stopped read says what it spent, and the action that reads the rest the most it may (%s)",
    (language, line, action) => {
      const detail = JSON.stringify({
        most: { amount: 0.5, currency: "USD" },
        spent: { amount: 0.0048, currency: "USD" },
        judgesAbsence: false,
      });
      expect(reasonText(t(language), language, "read-budget", detail)).toBe(line);
      expect(readRestText(t(language), language, detail)).toBe(action);
    },
  );

  test("a line that begins with an amount under a cent begins with a capital", () => {
    const under = { amount: 0.004, currency: "USD" as const };
    expect(setAsideText([under], t("en"), "en")).toBe("Under $0.01 set aside for work in progress");
    expect(
      atLineStart(translate("en", "task.details.cost", { cost: formatMoney(under, "en") })),
    ).toBe("Under $0.01 so far");
    expect(
      estimateLine(
        {
          billing: "per-token",
          calls: 2,
          tokens: 1_200,
          cost: { amount: 0.4, currency: "USD" },
          spentTowardCap: under,
          setAsideTowardCap: null,
          cap: { amount: 20, currency: "USD" },
        },
        t("en"),
        "en",
      )?.parts.at(-1),
    ).toBe("Under $0.01 of $20.00 used this month");
    expect(atLineStart("不到 $0.01")).toBe("不到 $0.01");
  });

  test.each([
    ["en", "USD", 0.004, "About $0.40", "Cost per 100 Answers"],
    ["zh-CN", "USD", 0.004, "约 $0.40", "每 100 个回答的费用"],
    ["en", "CNY", 0.0213, "About ¥2.13", "Cost per 100 Answers"],
    ["zh-CN", "CNY", 0.0213, "约 ¥2.13", "每 100 个回答的费用"],
    ["en", "CNY", 0.00004, "Under ¥0.01", "Cost per 100 Answers"],
  ] as const)(
    "a model's page compares its models per 100 Answers (%s, %s)",
    (language, currency, perAnswer, line, label) => {
      expect(perHundredAnswers({ amount: perAnswer, currency }, t(language), language)).toBe(line);
      expect(t(language)("models.provider.cost")).toBe(label);
    },
  );

  test("Settings and the research plan say their estimates through the same words", () => {
    expect(
      translate("en", "tagging.cost.estimate", {
        cost: estimateText({ amount: 0.004, currency: "USD" }, null, t("en"), "en") ?? "",
      }),
    ).toBe("Under $0.01 per 100 Documents");
    expect(
      translate("en", "research.plan.estimate", {
        cost: estimateText({ amount: 0.004, currency: "USD" }, null, t("en"), "en") ?? "",
        from: 4,
        to: 8,
        model: "Claude Haiku 5.5",
      }),
    ).toBe("Under $0.01 · 4–8 min · Claude Haiku 5.5");
  });

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
    ["en", "Stopped · $0.38 spent", "Read the rest · up to $0.41"],
    ["zh-CN", "已停止 · 已花费 $0.38", "读取其余部分 · 最多 $0.41"],
  ] as const)(
    "says what it spent, and its most on Read the rest (%s)",
    (language, line, action) => {
      const detail = JSON.stringify({
        most: { amount: 0.41, currency: "USD" },
        spent: { amount: 0.38, currency: "USD" },
        judgesAbsence: false,
      });
      expect(reasonText(t(language), language, "read-budget", detail)).toBe(line);
      expect(readRestText(t(language), language, detail)).toBe(action);
      expect(readRestText(t(language), language, "not money")).toBe(
        language === "en" ? "Read the rest" : "读取其余部分",
      );
    },
  );

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
