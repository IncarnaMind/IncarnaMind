import { between, random, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "app.log";
/** About 50 MB of a service's log over four days. */
const ENTRIES = 650_000;
const START = Date.UTC(2026, 9, 12);
const SPAN_MS = 4 * 24 * 3_600_000;

/**
 * The errors the service throws, each with its own share of entries: the message varies by ids
 * and numbers, so each signature is found only once those are taken out.
 */
const ERRORS: readonly {
  exception: string;
  share: number;
  message: (next: () => number) => string;
  stack: readonly string[];
}[] = [
  {
    exception: "java.net.SocketTimeoutException",
    share: 0.011,
    message: (next) => `Read timed out after ${between(next, 3000, 9000)} ms calling payments-api`,
    stack: [
      "PaymentClient.charge(PaymentClient.java:118)",
      "CheckoutService.pay(CheckoutService.java:64)",
    ],
  },
  {
    exception: "java.lang.NullPointerException",
    share: 0.0045,
    message: (next) => `customer is null for order ${between(next, 100000, 999999)}`,
    stack: [
      "OrderMapper.toDto(OrderMapper.java:41)",
      "OrderController.get(OrderController.java:27)",
    ],
  },
  {
    exception: "java.sql.SQLTransientConnectionException",
    share: 0.0022,
    message: (next) => `pool exhausted, ${between(next, 2, 40)} requests waiting`,
    stack: [
      "HikariPool.getConnection(HikariPool.java:213)",
      "OrderRepository.save(OrderRepository.java:88)",
    ],
  },
  {
    exception: "java.lang.IllegalStateException",
    share: 0.0008,
    message: (next) => `order ${between(next, 100000, 999999)} already shipped`,
    stack: [
      "Shipment.cancel(Shipment.java:56)",
      "ShipmentController.cancel(ShipmentController.java:33)",
    ],
  },
  {
    exception: "java.io.IOException",
    share: 0.00015,
    message: (next) =>
      `disk quota exceeded writing /var/data/export-${between(next, 1000, 9999)}.csv`,
    stack: ["ExportWriter.flush(ExportWriter.java:97)", "NightlyExport.run(NightlyExport.java:22)"],
  },
];

const INFO = [
  (next: () => number) =>
    `Processed order ${between(next, 100000, 999999)} in ${between(next, 5, 400)} ms`,
  (next: () => number) => `Cache hit ratio ${between(next, 70, 99)}% over the last minute`,
  (next: () => number) => `User ${between(next, 10000, 99999)} signed in`,
  (next: () => number) => `Sent ${between(next, 1, 30)} notification emails`,
];

const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

function log(): string {
  const next = random(5201);
  const lines: string[] = [];
  for (let index = 0; index < ENTRIES; index++) {
    const at = stamp(START + Math.floor((index / ENTRIES) * SPAN_MS));
    const worker = `worker-${between(next, 1, 16)}`;
    let draw = next();
    const error = ERRORS.find((each) => {
      draw -= each.share;
      return draw < 0;
    });
    if (!error) {
      const info = INFO[between(next, 0, INFO.length - 1)] ?? INFO[0];
      lines.push(`${at} INFO  [${worker}] ${info ? info(next) : ""}`);
      continue;
    }
    lines.push(`${at} ERROR [${worker}] Request failed`);
    lines.push(`${error.exception}: ${error.message(next)}`);
    for (const frame of error.stack) lines.push(`\tat com.example.shop.${frame}`);
    lines.push("\tat java.base/java.lang.Thread.run(Thread.java:1583)");
  }
  return `${lines.join("\n")}\n`;
}

export const task: Task = {
  id: "L02",
  title: "An application log with stack traces",
  needs: ["N"],
  seed: 5201,
  large: true,
  question: {
    en: "app.log is four days of our shop service's log, about 50 MB, with a stack trace after each error. Group the errors by signature: the exception class and its message with the ids, numbers and file names taken out. How many distinct signatures are there? For each, give the exception class, how many times it occurred, and the line numbers in app.log of its first and last occurrence (the line with the exception class).",
  },
  inputs: () => {
    const text = log();
    return { files: [{ name: NAME, bytes: utf8(text) }], data: { "app.log": text } };
  },
  expect: [
    {
      id: "signatures",
      kind: "number",
      label: "Distinct error signatures",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /signature|distinct|kinds?|types?|种|类/i,
    },
    {
      id: "errors",
      kind: "rows",
      label: "Each signature's count, first and last line",
      key: /\b(?:SocketTimeoutException|NullPointerException|SQLTransientConnectionException|IllegalStateException|IOException)\b/g,
      columns: [
        {
          id: "count",
          unit: "plain",
          tolerance: { abs: 0 },
          heading: /count|occurr|times|次数|数量/i,
        },
        { id: "first", unit: "plain", tolerance: { abs: 0 }, heading: /first|首次|最早/i },
        { id: "last", unit: "plain", tolerance: { abs: 0 }, heading: /last|末次|最后|最晚/i },
      ],
    },
  ],
};
