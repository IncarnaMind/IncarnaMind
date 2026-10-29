/**
 * A verified document's text as paragraphs, and the claims the model names
 * (#97, src/core/answers/checks/claims.ts).
 */
import { describe, expect, test } from "vitest";
import { paragraphsOf, readClaimDecisions } from "../../src/core/answers/checks/claims";

const page = (number: number, ...lines: string[]) => ({
  page: number,
  text: lines.join("\n"),
  kind: "page" as const,
  label: null,
});

describe("A PDF's lines become paragraphs", () => {
  test("a sentence runs on across lines, past a year or a date that starts one; a short line before a fresh one ends its paragraph; a word broken at a hyphen is mended", () => {
    const paragraphs = paragraphsOf([
      page(
        1,
        "Riverside Library roof and insulation works: progress",
        "report 3",
        "1 Summary",
        "This report covers the roof and insulation package from 1 to 31 March 2027. Roof works were programmed to",
        "start on 4 January 2027. Under our contract, the package is due to be completed in April",
        "2027. Our contract for the package is valued at £1,240,000. It is due to be com-",
        "pleted on",
        "12 March 2028.",
      ),
      page(2, "Forty-two operatives worked on site during March."),
    ]);
    expect(paragraphs).toEqual([
      {
        page: 1,
        text: "Riverside Library roof and insulation works: progress report 3",
        heading: false,
      },
      { page: 1, text: "1 Summary", heading: true },
      {
        page: 1,
        heading: false,
        text: "This report covers the roof and insulation package from 1 to 31 March 2027. Roof works were programmed to start on 4 January 2027. Under our contract, the package is due to be completed in April 2027. Our contract for the package is valued at £1,240,000. It is due to be completed on 12 March 2028.",
      },
      { page: 2, text: "Forty-two operatives worked on site during March.", heading: false },
    ]);
  });

  test("a numbered heading starts a paragraph of its own, after a line as long as the page's", () => {
    const paragraphs = paragraphsOf([
      page(
        1,
        "Meridian Health Staffing · for the clinic network's workforce team · 2 November 2026",
        "1 Your plan as we understand it",
        "Your 2027 staffing plan sets a total budget of £50,929,200 across the network and its clinics.",
      ),
    ]);
    expect(paragraphs.map((each) => each.text)).toEqual([
      "Meridian Health Staffing · for the clinic network's workforce team · 2 November 2026",
      "1 Your plan as we understand it",
      "Your 2027 staffing plan sets a total budget of £50,929,200 across the network and its clinics.",
    ]);
  });

  test("Chinese runs on across lines with no space, until a sentence ends or a heading starts", () => {
    const paragraphs = paragraphsOf([
      page(
        1,
        "老年人持卡乘车继续免费。第三季度共处理乘客投诉1,250",
        "件。",
        "二、库存情况",
        "萧山冷链仓有机鲜牛奶库存量为4200，高于3000的安全库存。",
        "三、供货说明我公司供应的有机鲜牛奶保质期为7天。双方约定的结算周期为月结30天。",
      ),
    ]);
    // A section a PDF ran into its heading's line is text, not a heading.
    expect(paragraphs.map((each) => [each.text, each.heading])).toEqual([
      ["老年人持卡乘车继续免费。第三季度共处理乘客投诉1,250件。", false],
      ["二、库存情况", true],
      ["萧山冷链仓有机鲜牛奶库存量为4200，高于3000的安全库存。", false],
      ["三、供货说明我公司供应的有机鲜牛奶保质期为7天。双方约定的结算周期为月结30天。", false],
    ]);
  });
});

describe("The claims the model names", () => {
  test.each([
    [
      '{"1": "claim", "2": "no", "3": "claim"}',
      [1, 2, 3],
      [
        [1, true],
        [2, false],
        [3, true],
      ],
    ],
    [
      'Here they are:\n```json\n{"2": "Claim", "5": " no "}\n```',
      [2, 5],
      [
        [2, true],
        [5, false],
      ],
    ],
    ['{"1": "claim", "2": "maybe", "9": "claim"}', [1, 2, 3], [[1, true]]],
    ['{"1": "claim", "2": true}', [1, 2], [[1, true]]],
  ])("reads %j", (reply, numbers, decisions) => {
    expect(readClaimDecisions(reply, numbers)).toEqual(new Map(decisions as [number, boolean][]));
  });

  test.each(["No claims.", '{"claims": [1, 2]}', '{"7": "claim"}', "[1, 2]", "{not json}"])(
    "reads nothing from %j",
    (reply) => {
      expect(readClaimDecisions(reply, [1, 2])).toBeNull();
    },
  );
});
