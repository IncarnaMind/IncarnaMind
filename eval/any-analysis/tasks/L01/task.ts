import { between, normal, random, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "access.log";
const LINES = 2_000_000;
/** A week of traffic from 2026-10-01 00:00 UTC. */
const START = Date.UTC(2026, 9, 1);
const SPAN_MS = 7 * 24 * 3_600_000;
/** The hour whose 5xx share is planted high: 2026-10-03, 14:00 to 15:00 UTC. */
const SPIKE_FROM = Date.UTC(2026, 9, 3, 14);
const SPIKE_TO = SPIKE_FROM + 3_600_000;

/**
 * Each endpoint's median response time in ms: the ten slowest stand well apart from the rest, so
 * their order by 95th percentile doesn't turn on how the percentile is interpolated.
 */
const ENDPOINTS: readonly (readonly [string, string, number])[] = [
  ["GET", "/api/reports/annual", 2400],
  ["POST", "/api/exports", 1900],
  ["GET", "/api/search", 1500],
  ["POST", "/api/invoices/batch", 1200],
  ["GET", "/api/analytics/cohorts", 980],
  ["GET", "/api/orders/history", 780],
  ["POST", "/api/checkout", 620],
  ["GET", "/api/recommendations", 500],
  ["PUT", "/api/profile/avatar", 400],
  ["GET", "/api/inventory", 320],
  ["GET", "/api/orders", 140],
  ["GET", "/api/products", 110],
  ["POST", "/api/cart", 95],
  ["GET", "/api/cart", 80],
  ["POST", "/api/login", 70],
  ["GET", "/api/session", 45],
  ["GET", "/api/health", 12],
  ["GET", "/static/app.js", 20],
  ["GET", "/static/app.css", 18],
  ["GET", "/", 35],
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");
const clf = (ms: number) => {
  const date = new Date(ms);
  return `${pad(date.getUTCDate())}/${MONTHS[date.getUTCMonth()]}/${date.getUTCFullYear()}:${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
};

/** Common log format with the response time in ms last, as nginx writes it with $request_time. */
function log(): string {
  const next = random(5101);
  const lines: string[] = [];
  for (let index = 0; index < LINES; index++) {
    const at = START + Math.floor((index / LINES) * SPAN_MS);
    const [method, path, median] = ENDPOINTS[between(next, 0, ENDPOINTS.length - 1)] ?? [
      "GET",
      "/",
      35,
    ];
    const failing = at >= SPIKE_FROM && at < SPIKE_TO ? 0.18 : 0.004;
    const status =
      next() < failing ? [500, 502, 503][between(next, 0, 2)] : next() < 0.03 ? 404 : 200;
    const ms = Math.max(1, Math.round(median * Math.exp(0.35 * normal(next))));
    const ip = `10.${between(next, 0, 9)}.${between(next, 0, 255)}.${between(next, 1, 254)}`;
    lines.push(
      `${ip} - - [${clf(at)}] "${method} ${path} HTTP/1.1" ${status} ${between(next, 200, 90_000)} ${ms}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export const task: Task = {
  id: "L01",
  title: "A web access log",
  needs: ["N"],
  seed: 5101,
  large: true,
  question: {
    en: "access.log is a week of our web server's access log, 2 million lines in common log format, with the response time in milliseconds as the last field. What share of all requests returned a 5xx status? In which hour was the 5xx rate highest, and what was it? Which 10 endpoints (method and path) were slowest by their 95th percentile response time, and what is each one's 95th percentile?",
  },
  inputs: () => {
    const text = log();
    return { files: [{ name: NAME, bytes: utf8(text) }], data: { "access.log": text } };
  },
  expect: [
    {
      id: "error_share",
      kind: "number",
      label: "Share of requests with a 5xx status",
      unit: "percent",
      tolerance: { abs: 0.0001 },
      near: /5xx|server error|share|rate|错误率|占比/i,
    },
    {
      id: "spike_hour",
      kind: "mention",
      label: "The spike: 2026-10-03, 14:00 UTC",
      match:
        /(?:03\/Oct|Oct(?:ober)?\s+3\b|10-03|10月3日)[^\n]*(?:14:00|14时|2\s?pm)|(?:14:00|14时|2\s?pm)[^\n]*(?:03\/Oct|Oct(?:ober)?\s+3\b|10-03|10月3日)/i,
    },
    {
      id: "spike_rate",
      kind: "number",
      label: "The 5xx rate in that hour",
      unit: "percent",
      tolerance: { abs: 0.002 },
      near: /14:00|14时|2\s?pm|spike|highest|峰值|最高/i,
    },
    {
      id: "slowest",
      kind: "rows",
      label: "The 10 slowest endpoints by 95th percentile",
      key: /\/(?:api\/[a-z/]+|static\/app\.(?:js|css))/g,
      // numpy's nine percentile methods differ by under 1% at a few thousand requests an endpoint.
      columns: [{ id: "p95", unit: "plain", tolerance: { rel: 0.02 } }],
      ordered: true,
    },
  ],
};
