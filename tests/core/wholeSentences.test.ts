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
