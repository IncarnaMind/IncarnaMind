import { buildPdf, type PdfPage } from "../../../../tests/helpers/pdf";
import { between, csv, random } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Brackenfold Utilities supplier payments Q3 2025.pdf";
const SEED = 6002;
/** Payments on each of the register's three pages. */
const PER_PAGE = [30, 30, 24] as const;
const FOOTER = "Brackenfold Utilities Ltd - supplier payments register Q3 2025 - page";

const SUPPLIERS = [
  "Marlow Fixings",
  "Corran Cable Works",
  "Ashgrove Plant Hire",
  "Tealby Safety Supply",
  "Pennock Survey Services",
  "Wrenfield Pipe Co",
  "Hallam Meter Systems",
  "Oxley Fleet Repairs",
  "Fenwick Civils",
  "Duncombe Office Supply",
  "Larkspur IT Services",
  "Quarrington Aggregates",
  "Belmont Valve Co",
  "Rowan Traffic Management",
  "Selby Waste Services",
  "Kettering Lane Electrical",
];

/** Footnote marks, as the register prints them after an amount or a supplier's name. */
const NOTES = [
  "¹ Paid in two instalments.",
  "² Includes a late-payment charge agreed with the supplier.",
  "* Supplier added to the approved list during the quarter.",
];

/** About one payment in five carries a mark. */
const MARKS = ["", "", "", "", "", "", "", "", "", "", "", "", "¹", "²", "*"] as const;

const euros = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Payment {
  date: string;
  supplier: string;
  invoice: string;
  cents: number;
  /** "¹" or "²" after the amount, "*" after the supplier, or none. */
  mark: string;
}

function payments(): Payment[] {
  const next = random(SEED);
  const count = PER_PAGE.reduce((sum, each) => sum + each, 0);
  const days = Array.from({ length: count }, () => between(next, 0, 91)).sort((a, b) => a - b);
  const used = new Set<number>();
  return days.map((day, index) => {
    let cents = between(next, 50_000, 2_400_000);
    while (used.has(cents)) cents += 1;
    used.add(cents);
    const date = new Date(Date.UTC(2025, 6, 1) + day * 86_400_000).toISOString().slice(0, 10);
    return {
      date,
      supplier: SUPPLIERS[between(next, 0, SUPPLIERS.length - 1)] ?? "",
      invoice: `INV-${40_000 + between(next, 1, 9999) * 3 + index}`,
      cents,
      mark: MARKS[between(next, 0, MARKS.length - 1)] ?? "",
    };
  });
}

const COLUMNS = [72, 140, 330, 450] as const;

function row(cells: readonly string[], y: number): { text: string; x: number; y: number }[] {
  return cells.flatMap((text, index) => (text ? [{ text, x: COLUMNS[index] ?? 72, y }] : []));
}

/**
 * The register over three pages, its heading repeated on each, a carried-forward line at the foot
 * of the first two and a brought-forward line at the head of the next: the payments alone add up
 * to the total printed at the end.
 */
function registerPages(all: readonly Payment[]): PdfPage[] {
  const total = all.reduce((sum, payment) => sum + payment.cents, 0);
  const pages: PdfPage[] = [];
  let start = 0;
  let carried = 0;
  for (const [index, count] of PER_PAGE.entries()) {
    const shown = all.slice(start, start + count);
    const placed = [...row(["Date", "Supplier", "Invoice", "Amount (EUR)"], 700)];
    let y = 684;
    if (index > 0) {
      placed.push(...row(["", "Brought forward", "", euros(carried)], y));
      y -= 16;
    }
    for (const payment of shown) {
      const supplier = payment.mark === "*" ? `${payment.supplier}*` : payment.supplier;
      const amount =
        payment.mark === "*" ? euros(payment.cents) : `${euros(payment.cents)}${payment.mark}`;
      placed.push(...row([payment.date, supplier, payment.invoice, amount], y));
      y -= 16;
    }
    carried += shown.reduce((sum, payment) => sum + payment.cents, 0);
    placed.push(
      ...row(
        index < PER_PAGE.length - 1
          ? ["", "Carried forward", "", euros(carried)]
          : ["", "Total payments", "", euros(total)],
        y - 4,
      ),
    );
    pages.push({
      lines: [
        `Supplier payments register, July to September 2025${index > 0 ? " (continued)" : ""}`,
      ],
      placed: [...placed, { text: `${FOOTER} ${index + 2}`, x: 72, y: 40 }],
    });
    start += count;
  }
  return pages;
}

function pages(all: readonly Payment[]): PdfPage[] {
  return [
    {
      lines: [
        "Brackenfold Utilities Ltd",
        "",
        "Supplier payments register: third quarter 2025",
        "",
        "This register lists every payment to a supplier made between 1 July and",
        "30 September 2025, in the order paid. The notes to the register are on page 5.",
        "",
        `${FOOTER} 1`,
      ],
    },
    ...registerPages(all),
    { lines: ["Notes to the register", "", ...NOTES, "", `${FOOTER} 5`] },
  ];
}

export const task: Task = {
  id: "D02",
  title: "A table over three pages",
  needs: ["T"],
  seed: SEED,
  question: {
    en: "Brackenfold Utilities supplier payments Q3 2025.pdf has a register of supplier payments that runs over three pages. Put the payments into one table. How many payments are there, what do they add up to, and does that match the total printed at the end of the register?",
  },
  inputs: () => {
    const all = payments();
    return {
      files: [{ name: NAME, bytes: buildPdf(pages(all)) }],
      data: {
        "payments.csv": csv([
          ["date", "supplier", "invoice", "amount"],
          ...all.map((payment) => [
            payment.date,
            payment.supplier,
            payment.invoice,
            payment.cents / 100,
          ]),
        ]),
      },
    };
  },
  expect: [
    {
      id: "payment_count",
      kind: "number",
      label: "Payments in the register",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /payments|rows|entries|items|笔|条|行/i,
    },
    {
      id: "payments_total",
      kind: "number",
      label: "What the payments add up to",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /total|sum|add(?:s|ed)? up|合计|总计|总额|总和/i,
    },
    {
      id: "matches",
      kind: "mention",
      label: "Says the sum matches the printed total",
      match: /match|agree|equal|reconcil|same as|一致|相符|吻合|相等|相同/i,
    },
  ],
  sources: { documents: [NAME] },
};
