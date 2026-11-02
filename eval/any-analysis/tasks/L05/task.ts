import { between, csv, normal, random, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "mail.mbox";
const MESSAGES = 10_000;
/** Six weeks of a team's mail from 2026-09-01 00:00 UTC. */
const START = Date.UTC(2026, 8, 1);
const SPAN_MS = 42 * 24 * 3_600_000;

/** Made-up people at reserved example domains; the first three send most, in this order. */
const PEOPLE = [
  ["Marta Oyelaran", "marta.oyelaran@example.org", 1412],
  ["Teodor Vanko", "teodor.vanko@example.org", 1096],
  ["Lin Qiaoyu", "lin.qiaoyu@example.net", 873],
  ["Priya Dandekar", "priya.dandekar@example.org", 640],
  ["Jonas Ferreira", "jonas.ferreira@example.com", 610],
  ["Aiko Brennan", "aiko.brennan@example.org", 590],
  ["Sefa Mutua", "sefa.mutua@example.net", 560],
  ["Ola Lindqvist", "ola.lindqvist@example.com", 540],
  ["Ravi Chandran", "ravi.chandran@example.org", 520],
  ["Noor Haddad", "noor.haddad@example.org", 500],
  ["Emil Rask", "emil.rask@example.com", 480],
  ["Zainab Okafor", "zainab.okafor@example.net", 460],
  ["Hugo Marchetti", "hugo.marchetti@example.org", 430],
  ["Wen Hao", "wen.hao@example.net", 389],
  ["Ines Duarte", "ines.duarte@example.com", 300],
] as const;

const SUBJECTS = [
  "Q4 forecast",
  "Supplier review",
  "Hiring plan",
  "Release notes",
  "Budget sign-off",
  "Offsite agenda",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");
const rfc2822 = (ms: number) => {
  const date = new Date(ms);
  return `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
};
const envelope = (ms: number) => {
  const date = new Date(ms);
  return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
};

interface Message {
  id: string;
  from: number;
  at: number;
  replyTo: string | null;
  subject: string;
}

/**
 * The messages in time order. Most hours are quiet; working hours are busy, 10:00 UTC the
 * busiest. About half are replies to an earlier message, after a delay of an hour or so.
 */
function messages(): Message[] {
  const next = random(5501);
  const senders = PEOPLE.flatMap(([, , count], index) =>
    Array.from({ length: count }, () => index),
  );
  for (let index = senders.length - 1; index > 0; index--) {
    const other = between(next, 0, index);
    [senders[index], senders[other]] = [senders[other] ?? 0, senders[index] ?? 0];
  }
  const weights = Array.from({ length: 24 }, (_, hour) =>
    hour === 10 ? 14 : hour >= 8 && hour <= 17 ? 9 - Math.abs(hour - 12) * 0.5 : 0.6,
  );
  const total = weights.reduce((sum, each) => sum + each, 0);
  const sent: Message[] = senders.map((from, index) => {
    let draw = next() * total;
    const hour = weights.findIndex((weight) => (draw -= weight) < 0);
    const day = between(next, 0, 41);
    const at =
      START + day * 86_400_000 + Math.max(hour, 0) * 3_600_000 + between(next, 0, 3_599) * 1000;
    return {
      id: `<m${String(index + 1).padStart(5, "0")}@example.org>`,
      from,
      at,
      replyTo: null,
      subject: SUBJECTS[between(next, 0, SUBJECTS.length - 1)] ?? "Note",
    };
  });
  sent.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const [index, message] of sent.entries()) {
    if (index === 0 || next() < 0.5) continue;
    const delay = Math.exp(Math.log(55 * 60_000) + 0.8 * normal(next));
    const earlier = sent.filter(
      (each, at) => at < index && each.at < message.at - delay * 0.5 && each.from !== message.from,
    );
    const original =
      earlier[earlier.length - 1 - between(next, 0, Math.min(5, earlier.length - 1))];
    if (!original) continue;
    message.replyTo = original.id;
    message.subject = `Re: ${original.subject}`;
  }
  return sent;
}

function mbox(sent: readonly Message[]): string {
  return sent
    .map((message) => {
      const [name, address] = PEOPLE[message.from] ?? PEOPLE[0];
      return [
        `From ${address} ${envelope(message.at)}`,
        `From: ${name} <${address}>`,
        "To: team@example.org",
        `Date: ${rfc2822(message.at)}`,
        `Subject: ${message.subject}`,
        `Message-ID: ${message.id}`,
        ...(message.replyTo ? [`In-Reply-To: ${message.replyTo}`] : []),
        "",
        "Thanks, see the notes below and let me know if anything needs changing.",
        "",
      ].join("\n");
    })
    .join("\n");
}

export const task: Task = {
  id: "L05",
  title: "A mail export",
  needs: ["N"],
  seed: 5501,
  large: true,
  question: {
    en: "mail.mbox is our team's mail for six weeks, 10,000 messages. Who are the top 3 senders by number of messages, and how many did each send? Which hour of the day (UTC) is busiest? For the top sender, what is their median reply time: for each message they sent with an In-Reply-To header, the time from the message it replies to, in minutes?",
  },
  inputs: () => {
    const sent = messages();
    const text = mbox(sent);
    const byId = new Map(sent.map((message) => [message.id, message]));
    return {
      files: [{ name: NAME, bytes: utf8(text) }],
      data: {
        "messages.csv": csv([
          ["id", "from", "at", "reply_to_at"],
          ...sent.map((message) => [
            message.id,
            PEOPLE[message.from]?.[1] ?? "",
            message.at,
            message.replyTo ? (byId.get(message.replyTo)?.at ?? null) : null,
          ]),
        ]),
      },
    };
  },
  expect: [
    {
      id: "top_senders",
      kind: "rows",
      label: "The top 3 senders and their counts",
      key: /\b[a-z]+\.[a-z]+@example\.(?:org|net|com)\b/g,
      columns: [{ id: "count", unit: "plain", tolerance: { abs: 0 } }],
      ordered: true,
    },
    {
      id: "busiest_hour",
      kind: "mention",
      label: "The busiest hour, 10:00 UTC",
      match: /\b10:00\b|\b10\s?(?:am|a\.m\.)|10点|10时/i,
    },
    {
      id: "median_reply_minutes",
      kind: "number",
      label: "The top sender's median reply time, minutes",
      unit: "plain",
      tolerance: { abs: 0.5 },
      near: /median|reply|回复|中位/i,
    },
  ],
};
