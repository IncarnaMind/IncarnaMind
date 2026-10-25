/**
 * The everyday requests' measure of dates an Answer gives that its
 * Documents' text doesn't (eval/everyday/dates.ts), the guard that reads it,
 * the count of a summary's cited sentences, and the dated Documents
 * themselves (eval/everyday/dated.ts), as the core reads them.
 */
import { describe, expect, test } from "vitest";
import { requestFailures } from "../../eval/everyday/checks";
import { DATED_TEXTS, writeDatedDocuments } from "../../eval/everyday/dated";
import { citedClaims, datesIn, datesNotInText } from "../../eval/everyday/dates";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder } from "../helpers/documents";

describe("Dates an Answer gives", () => {
  test("are read as written, at the precision written, in English and Chinese", () => {
    expect(
      datesIn(
        "Signed on 2026-10-18, held on 12 March 2024, from April 1st, 2024, in June 2024, by 2025.",
      ),
    ).toEqual(["2026-10-18", "2024-03-12", "2024-04-01", "2024-06", "2025"]);
    expect(
      datesIn("签订日期为 2026 年 10 月 18 日，会议于2024年3月12日召开，2025年生效。"),
    ).toEqual(["2026-10-18", "2024-03-12", "2025"]);
    expect(
      datesIn("3,200 pounds a month, 25 days of leave, 1,950 staff and 2019.5 tonnes."),
    ).toEqual([]);
  });

  // protects=a date the Documents' text doesn't write fails the request, in English and Chinese, while the text's own dates and a date named as the file's pass; fails_when=a file's date given as the signing date passes, or the meeting's own date fails; no_claim=dates written in words ("the eighteenth of October").
  test("fail when no Document's text writes them, unless named as the file's", () => {
    const texts = ["Held on 12 March 2024.", "会议时间：2024年3月12日"];
    expect(datesNotInText("The contract was signed on 18 October 2026.", texts)).toEqual([
      "2026-10-18",
    ]);
    expect(datesNotInText("签订日期为 2026-10-18。", texts)).toEqual(["2026-10-18"]);
    expect(datesNotInText("The board met on 12 March 2024, in March 2024.", texts)).toEqual([]);
    expect(datesNotInText("董事会于 2024 年 3 月 12 日开会。", texts)).toEqual([]);
    expect(
      datesNotInText(
        "The contract gives no signing date. Its file was created on 2026-10-18. Both files show the same creation date (2026-10-18). 文件创建于 2026-10-18。",
        texts,
      ),
    ).toEqual([]);
  });

  test("fail the request that holds its Answer to the text's dates, and no other", () => {
    const outcome = (textDates: boolean) => ({
      expected: { write: false, cite: false, coverAll: false, textDates },
      answer: {
        text: "It was signed on 2026-10-18.",
        citations: [],
        toolCalls: [],
        steps: null,
      },
      verdict: { unbacked: [] },
      citedInMinds: [],
      changedBlocks: [],
      scoped: [],
      texts: DATED_TEXTS,
    });

    expect(requestFailures(outcome(true))).toEqual([
      { kind: "date-not-in-text", dates: ["2026-10-18"] },
    ]);
    expect(requestFailures(outcome(false))).toEqual([]);
  });
});

describe("A summary's sentences outside its headings", () => {
  test("count those with a Citation, a marker after the full stop included", () => {
    expect(
      citedClaims(
        [
          "## Employment contract",
          "",
          "Harbour Logistics employs Wei Chen as Warehouse Supervisor[^1]. The salary is 3,200 pounds a month.[^2]",
          "",
          "The key terms:",
          "- The term is three years from the start date[^3].",
          "- It leaves the signing date blank.",
          "",
          "| Term | Value |",
          "|---|---|",
          "| Notice period | one month's written notice[^4] |",
        ].join("\n"),
      ),
    ).toEqual({ claims: 5, cited: 4 });
    expect(citedClaims("## 劳动合同\n\n乙方担任仓库主管[^1]。合同期限为三年。")).toEqual({
      claims: 2,
      cited: 1,
    });
  });
});

describe("The dated Documents", { timeout: 60_000 }, () => {
  // protects=the evaluation's dated Documents read as their text says, each dated by its file only (a PDF's creation date, a text file's modified day), so the measure's text is what the model reads; fails_when=a file's date is in the text, or the text the core reads differs from what the measure holds; no_claim=none beyond protects.
  test("are read with the text the measure holds, and their files' dates are none of it", async () => {
    const core = startCore(await createTempDataFolder());
    const written = await writeDatedDocuments(await createSourceFolder());
    const documents = await addAndProcess(
      core,
      written.map((each) => each.path),
    );

    expect(documents.map((document) => document.status)).toEqual(documents.map(() => "ready"));
    const texts = DATED_TEXTS.join("\n");
    expect(texts).not.toContain("2026");
    expect(texts).not.toContain("2025");
    const plain = (text: string) => text.replace(/^#+/gm, "").replace(/\s+/g, "");
    for (const [index, document] of documents.entries()) {
      const { pages } = await core.readDocumentText(document.id);
      const read = plain(pages.map((page) => page.text).join("\n"));
      for (const line of DATED_TEXTS[index]?.split("\n") ?? []) {
        expect(read, document.name).toContain(plain(line));
      }
    }
  });
});
