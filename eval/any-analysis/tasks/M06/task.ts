import { between, csv, normal, random, round, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Subscription cancellations 2025.csv";
const SEED = 2106;
const CUSTOMERS = 12_000;

/**
 * 12,000 subscribers: six columns known before a customer cancels, each nudging the odds, and
 * cancellation_fee_charged, which is only set once a customer has cancelled (waived for a few),
 * so a model given it scores an AUC near 1 that no live scoring could reach.
 */
function customers(): string {
  const next = random(SEED);
  const rows: (string | number)[][] = [
    [
      "customer",
      "tenure_months",
      "monthly_fee",
      "support_calls",
      "late_payments",
      "discount_pct",
      "logins_per_week",
      "cancellation_fee_charged",
      "cancelled",
    ],
  ];
  for (let customer = 0; customer < CUSTOMERS; customer++) {
    const tenure = between(next, 1, 72);
    const fee = round(Math.max(9.99, 42 + 14 * normal(next)), 2);
    const calls = Math.min(12, Math.floor(-Math.log(Math.max(next(), 1e-9)) * 1.8));
    const late = Math.min(6, Math.floor(-Math.log(Math.max(next(), 1e-9)) * 0.7));
    const discount = [0, 0, 0, 5, 10, 15, 20][between(next, 0, 6)] ?? 0;
    const logins = round(Math.max(0, 4 + 2.5 * normal(next)), 1);
    const logit =
      -1.3 -
      0.05 * (tenure - 36) +
      0.035 * (fee - 42) +
      0.4 * (calls - 1.8) +
      0.6 * (late - 0.7) -
      0.05 * (discount - 7) -
      0.3 * (logins - 4);
    const cancelled = next() < 1 / (1 + Math.exp(-logit)) ? 1 : 0;
    const charged = cancelled === 1 && next() < 0.96 ? 1 : 0;
    rows.push([
      `S${String(customer + 1).padStart(5, "0")}`,
      tenure,
      fee,
      calls,
      late,
      discount,
      logins,
      charged,
      cancelled,
    ]);
  }
  return csv(rows);
}

export const task: Task = {
  id: "M06",
  title: "A leaking column",
  needs: ["P"],
  seed: SEED,
  question: {
    en: "Subscription cancellations 2025.csv has one row per subscriber, and cancelled, which is 1 if they cancelled during 2025. Build a model that predicts cancelled from the other columns, so we can score our current subscribers before they cancel. Hold out 25% of the rows at random as a test set, with a fixed random seed, and give the test AUC. Which columns matter most?",
  },
  inputs: () => {
    const text = customers();
    return { files: [{ name: NAME, bytes: utf8(text) }], data: { "subscribers.csv": text } };
  },
  expect: [
    {
      id: "leak",
      kind: "mention",
      label: "Names cancellation_fee_charged as a leak and leaves it out",
      match:
        /(?:leak|after (?:the |a )?(?:customer |subscriber )?(?:has )?cancel|only (?:known|set|recorded) (?:once|after)|future information|泄漏|泄露|事后|取消之后|取消后)[\s\S]{0,300}cancellation[_ ]fee|cancellation[_ ]fee[\s\S]{0,300}(?:leak|after (?:the |a )?(?:customer |subscriber )?(?:has )?cancel|only (?:known|set|recorded) (?:once|after)|drop|remov|exclud|left out|leave it out|泄漏|泄露|事后|取消之后|取消后|剔除|删除|去掉|排除)/i,
    },
    {
      id: "honest_auc",
      kind: "number",
      label: "Test AUC without the leaking column",
      unit: "plain",
      // Covers 0.80 to 0.85, reference.py's spread over 20 splits and two models; leaking, 0.99.
      tolerance: { abs: 0.04 },
      near: /AUC|ROC/i,
    },
  ],
  sources: { documents: [NAME] },
};
