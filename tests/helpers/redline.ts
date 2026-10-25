import { escapeXml, paragraph, run, wordFile } from "./word";

const DANA = 'w:author="Dana Kim" w:date="2026-10-02T09:00:00Z"';
const LUIS = 'w:author="Luis Ortega" w:date="2026-10-05T16:20:00Z"';

const ins = (id: number, who: string, text: string) =>
  `<w:ins w:id="${id}" ${who}>${run(text)}</w:ins>`;
const del = (id: number, who: string, text: string) =>
  `<w:del w:id="${id}" ${who}><w:r><w:delText xml:space="preserve">${escapeXml(text)}</w:delText></w:r></w:del>`;
const comment = (id: number, author: string, text: string) => ({
  mark: `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`,
  entry: `<w:comment w:id="${id}" w:author="${escapeXml(author)}" w:date="2026-10-02T09:00:00Z"><w:p><w:r><w:annotationRef/></w:r>${run(text)}</w:p></w:comment>`,
});

const RESIN = comment(
  100,
  "Dana Kim",
  "Resin is up 11% since June. Our letter of 19 September has the figures.",
);
const CAP = comment(101, "Dana Kim", "Our insurer needs a cap in every supply contract.");

/**
 * The supply agreement on the board Final-10-Redlines: Dana Kim's five
 * changes and Luis Ortega's two, in typed clause numbers, and two comments of
 * Dana's. 7.1 is a paragraph Dana added whole.
 */
export function supplyRedline(): Buffer {
  return wordFile({
    body: [
      paragraph("Supply agreement", { style: "Title" }),
      paragraph("1. Supply", { style: "Heading1" }),
      paragraph(
        `${run("1.2 Northwind makes the Products in Schedule 2 at its plants in Leeds")}${ins(1, DANA, " and Gdańsk")}${run(" and delivers them to Corran under clause 4.")}`,
      ),
      paragraph(
        `${run("1.3 Northwind gives ")}${del(2, LUIS, "90")}${ins(3, LUIS, "60")}${run(" days’ notice before moving production to another plant.")}`,
      ),
      paragraph("2. Prices", { style: "Heading1" }),
      paragraph(
        `${run("2.1 Prices are fixed for the first twelve months at the rates in Schedule 2. After that, Northwind may raise its prices once a year by up to ")}${del(4, DANA, "8%, on 30 days’ notice")}${ins(5, DANA, "6%, on 45 days’ notice, as agreed on the call of 3 September")}${run(".")}${RESIN.mark}`,
      ),
      paragraph("3. Orders and payment", { style: "Heading1" }),
      paragraph(
        `${run("3.1 Corran pays each invoice within ")}${del(6, LUIS, "14")}${ins(7, LUIS, "30")}${run(" days of the invoice date. Late payments carry interest at 4% a year above the Bank of England base rate.")}`,
      ),
      paragraph("4. Delivery", { style: "Heading1" }),
      paragraph(
        `${run("4.2 Northwind delivers within 48 hours of an order placed before noon, to the sites in Schedule 3")}${ins(8, DANA, ", for orders of at least 40 pallets")}${run(".")}`,
      ),
      paragraph("6. Liability", { style: "Heading1" }),
      paragraph(
        "6.1 Nothing in this agreement limits liability for death or personal injury caused by negligence.",
      ),
      paragraph(
        `${run("6.2 Otherwise, ")}${ins(9, DANA, "Northwind’s total liability is capped at the fees paid in the three months before the claim")}${run(".")}${CAP.mark}`,
      ),
      paragraph("7. Quality", { style: "Heading1" }),
      `<w:p><w:pPr><w:rPr><w:ins w:id="10" ${DANA}/></w:rPr></w:pPr>${ins(11, DANA, "7.1 Every plant that makes the Products holds ISO 22000 certification.")}</w:p>`,
    ].join(""),
    comments: RESIN.entry + CAP.entry,
  });
}
