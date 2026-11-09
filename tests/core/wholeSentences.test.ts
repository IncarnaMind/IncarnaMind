import { describe, expect, test } from "vitest";
import { wholeSentences } from "../../src/core/answers/wholeSentences";
import type { PageText } from "../../src/core/documents/passages";

/** A found quote shown as the whole sentence of its Units that holds it (#2739). */

const page = (...lines: string[]): PageText[] => [
  { page: 1, kind: "page", text: lines.join("\n") },
];
const section = (text: string): PageText[] => [{ page: 1, kind: "section", text }];

describe("a found quote's whole sentence", () => {
  test("runs on across a PDF's wrapped line to the end of its date", () => {
    const units = page(
      "The agreement was signed by the Velmora Republic and the Tarsk Federation under the Corvel on 22",
      "July 2022, and the Corvel set up a joint centre in the port of Almer to watch the ships go by.",
      "The corridor carried grain and fertiliser, and it stayed open until the very end of the year.",
    );

    expect(wholeSentences(units, "the Tarsk Federation under the Corvel on 22")).toBe(
      "The agreement was signed by the Velmora Republic and the Tarsk Federation under the Corvel on 22 July 2022, and the Corvel set up a joint centre in the port of Almer to watch the ships go by.",
    );
  });

  test("takes the clause after a comma, in English and in Chinese", () => {
    expect(
      wholeSentences(
        section(
          "The raw crawl is large: 26TB of text before filtering, and 310GB after, which is the version used for training.",
        ),
        "and 310GB after",
      ),
    ).toBe(
      "The raw crawl is large: 26TB of text before filtering, and 310GB after, which is the version used for training.",
    );
    expect(
      wholeSentences(
        section(
          "该协议由维尔莫拉共和国与塔尔斯克联邦签署，签署日期为 2022 年 7 月 22 日。下一句。",
        ),
        "该协议由维尔莫拉共和国与塔尔斯克联邦签署",
      ),
    ).toBe("该协议由维尔莫拉共和国与塔尔斯克联邦签署，签署日期为 2022 年 7 月 22 日。");
  });

  test("lets a numbered clause wrap to its small letters", () => {
    const units = page(
      "9.1 Either party may terminate this Agreement for convenience by giving not less than",
      "ninety (90) days' written notice to the other party, by post or by hand, at its address.",
    );

    expect(wholeSentences(units, "9.1 Either party may terminate this Agreement")).toBe(
      "9.1 Either party may terminate this Agreement for convenience by giving not less than ninety (90) days' written notice to the other party, by post or by hand, at its address.",
    );
  });

  test("never takes a numbered heading, a table's cell or a table's rows into the sentence", () => {
    const heading = page(
      "Section 4 Liability of the supplier for loss or damage arising from late delivery",
      "The supplier is liable for loss caused by late delivery after the agreed delivery date.",
    );
    expect(wholeSentences(heading, "The supplier is liable for loss")).toBe(
      "The supplier is liable for loss caused by late delivery after the agreed delivery date.",
    );

    const cells = section("4.2 Delivery\tThe supplier must deliver within 30 days of the order.");
    expect(wholeSentences(cells, "The supplier must deliver within 30 days")).toBe(
      "The supplier must deliver within 30 days of the order.",
    );

    const rows = page(
      "Revenue (£m) 2021 1,234.5 2022 1,301.2 2023 1,402.9 2024 1,455.0 2025 1,482.6",
      "Operating profit (£m) 2021 101.4 2022 110.0 2023 121.7 2024 125.2 2025 131.9",
      "In 2025 revenue grew strongly, and operating profit rose with it to a record level.",
    );
    expect(wholeSentences(rows, "Operating profit (£m) 2021 101.4")).toBe(
      "Operating profit (£m) 2021 101.4",
    );
  });

  test.each([
    [
      "a footnote's mark",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer's late",
      "* Not followed in later cases, where the court held that the buyer must prove the delay itself.",
    ],
    [
      "a footnote's number",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer's late",
      "1 The respondent has since appealed the decision to the Court of Appeal sitting in Varne.",
    ],
    [
      "a footnote that opens with a case's citation",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer's late",
      "1 [2019] EWCA Civ 1, where the court held that the buyer must prove the delay itself.",
    ],
    [
      "a footnote that opens with a year in brackets",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer's late",
      "1 (1854) 9 Exch 341, where the court held that a loss must have been in view when contracting.",
    ],
    [
      "a footnote that opens with a statute's number",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer's late",
      "1 28 U.S.C. § 1782 lets a court order evidence to be given for use in a foreign tribunal.",
    ],
    [
      "a footnote that opens with a quotation mark",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer's late",
      "1 “Delay” means any day after the delivery date in clause 4 on which the goods are not delivered.",
    ],
    [
      "a footnote's number in brackets",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer's late",
      "[1] The respondent has since appealed the decision to the Court of Appeal sitting in Varne.",
    ],
    [
      "a footnote's number set against its word",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer's late",
      "1The respondent has since appealed the decision to the Court of Appeal sitting in Varne.",
    ],
    [
      "a list's bullet, after a comma",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer,",
      "• the buyer must deliver its drawings within 14 days of the order, at its own cost and risk.",
    ],
    [
      "a list's letter, after a comma",
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer,",
      "(a) the buyer must deliver its drawings within 14 days of the order, at its own cost and risk.",
    ],
    [
      "a note's mark, in Chinese",
      "仲裁庭认定，供应商未能证明延误由买方造成，",
      "* 注：此后的案件未采纳这一观点。",
    ],
    [
      "a footnote's number, in Chinese",
      "仲裁庭认定，供应商未能证明延误由买方造成，",
      "① 被申请人已就该裁决提出上诉。",
    ],
    [
      "a footnote that opens with a case's number, in Chinese",
      "仲裁庭认定，供应商未能证明延误由买方造成，",
      "1 （2019）最高法民终 1 号判决认为，买方应自行证明延误。",
    ],
    [
      "a footnote that opens with a case's number set against it, in Chinese",
      "仲裁庭认定，供应商未能证明延误由买方造成，",
      "1（2019）最高法民终 1 号判决认为，买方应自行证明延误。",
    ],
    [
      "a footnote's number in brackets, in Chinese",
      "仲裁庭认定，供应商未能证明延误由买方造成，",
      "[1] 被申请人已就该裁决提出上诉。",
    ],
    [
      "a list's number, in Chinese",
      "仲裁庭认定，供应商未能证明延误由买方造成，",
      "（一）买方应在订单后 14 日内交付图纸。",
    ],
  ])("never runs on into %s on the next line", (_, line, note) => {
    const quote = line.startsWith("The") ? "The tribunal found that the supplier" : "仲裁庭认定";

    expect(wholeSentences(page(line, note), quote)).toBe(quote);
  });

  test("runs on into a line that only looks like a note: a date, a section's number, a Chinese clause", () => {
    const line =
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer on";
    expect(
      wholeSentences(
        page(line, "22 July 2022, the day the drawings were due."),
        "The tribunal found",
      ),
    ).toBe(`${line} 22 July 2022, the day the drawings were due.`);
    const section =
      "The tribunal found that the supplier had not given the buyer the notice it owed under section";
    expect(
      wholeSentences(
        page(section, "12(3) of the Act, which runs from the day of the order."),
        "The tribunal found",
      ),
    ).toBe(`${section} 12(3) of the Act, which runs from the day of the order.`);
    expect(
      wholeSentences(
        page("仲裁庭认定，供应商未能证明延误由买方造成，", "买方应在订单后 14 日内交付图纸。"),
        "仲裁庭认定",
      ),
    ).toBe("仲裁庭认定，供应商未能证明延误由买方造成，买方应在订单后 14 日内交付图纸。");
  });

  test("never runs a sentence on into a table's cells on the next line", () => {
    const line =
      "The tribunal found that the supplier had not shown that the delay was caused by the buyer and";
    const units = page(line, "Depot 1 was sold.\tClosed\t2019", "Depot 2 was let.\tOpen\t2021");

    expect(wholeSentences(units, "The tribunal found")).toBe("The tribunal found");
  });

  test("measures a page's lines as printed, and never runs a table's row on into the text below it", () => {
    const rows = Array.from(
      { length: 12 },
      (_, index) => `Depot ${index + 1}\tOpen\tStaffed\tLeased since 2019`,
    );
    const heading = page(
      ...rows,
      "Revenue recognition",
      "Revenue is recognised over the term of each contract as the services are delivered.",
    );
    expect(wholeSentences(heading, "Revenue is recognised over the term")).toBe(
      "Revenue is recognised over the term of each contract as the services are delivered.",
    );

    const prose = page(
      ...rows,
      "The depots are run by Halden Logistics under a ten-year contract.",
    );
    expect(wholeSentences(prose, "The depots are run by")).toBe(
      "The depots are run by Halden Logistics under a ten-year contract.",
    );
    expect(wholeSentences(prose, "Leased since 2019")).toBe("Leased since 2019");
  });

  test("keeps the quote as given when it is whole already, too long, or in rows or a Transcript", () => {
    const whole = section("The fee is 3% per week. It applies after ten days.");
    expect(wholeSentences(whole, "The fee is 3% per week.")).toBe("The fee is 3% per week.");

    const long = section(
      `The plan covers ${"each of the regional depots and ".repeat(20)}the port.`,
    );
    expect(wholeSentences(long, "The plan covers each of the regional depots")).toBe(
      "The plan covers each of the regional depots",
    );

    const sheet: PageText[] = [{ page: 1, kind: "rows", text: "Region\tQ1\nWest\t350,200" }];
    expect(wholeSentences(sheet, "West")).toBe("West");
  });
});
