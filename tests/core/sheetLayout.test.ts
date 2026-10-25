/**
 * Reading how a workbook looks, for the sheet preview (ADR-0011): cell
 * styles, rich text, sizes, hidden rows and columns, frozen panes, gridlines,
 * notes, pictures and charts, and values as Excel's own format shows them.
 * Indexing doesn't ask for any of it, and what it reads is unchanged.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { cellIndex } from "../../src/core/documents/formats/sheetLayout";
import { readWorkbook } from "../../src/core/documents/formats/xlsx";
import { tint } from "../../src/core/documents/formats/xlsxStyles";
import { xlsxPackage } from "../helpers/office";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/formats/${name}`, import.meta.url)));

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;

const STYLES = [
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="d-mmm-yy"/><numFmt numFmtId="165" formatCode="#,##0;[Red]-#,##0"/></numFmts>`,
  `<fonts count="3">`,
  `<font><sz val="11"/><color theme="1"/><name val="Calibri"/><scheme val="minor"/></font>`,
  `<font><b/><i/><u/><sz val="14"/><color rgb="FFC00000"/><name val="Georgia"/></font>`,
  `<font><strike/><u val="double"/><sz val="9"/><color theme="4" tint="-0.249977111117893"/><name val="Arial"/></font>`,
  `</fonts>`,
  `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`,
  `<fill><patternFill patternType="solid"><fgColor theme="4" tint="0.79998168889431442"/><bgColor indexed="64"/></patternFill></fill>`,
  `<fill><patternFill patternType="solid"><fgColor indexed="13"/></patternFill></fill></fills>`,
  `<borders count="2"><border><left/><right/><top/><bottom/></border>`,
  `<border><left style="thin"><color auto="1"/></left><right style="medium"><color rgb="FF0000FF"/></right><top style="dashed"><color indexed="10"/></top><bottom style="double"><color theme="1"/></bottom></border></borders>`,
  `<cellXfs count="6">`,
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`,
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1" indent="2" textRotation="90"/></xf>`,
  `<xf numFmtId="164" fontId="2" fillId="3" borderId="0"/>`,
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0"/>`,
  `<xf numFmtId="14" fontId="0" fillId="0" borderId="0"/>`,
  `<xf numFmtId="0" fontId="0" fillId="2" borderId="0"/>`,
  `</cellXfs>`,
].join("");

describe("how a workbook looks, for the sheet preview", () => {
  test("cell styles: fonts, theme and indexed colours, fills, borders and alignment", async () => {
    const bytes = xlsxPackage({
      sheets: [
        {
          name: "Styled",
          xml: `<sheetData><row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Title</t></is></c><c r="B1" s="2"><v>46114</v></c><c r="C1" s="3"><v>-1250</v></c><c r="D1" s="5"/></row></sheetData>`,
        },
      ],
      styles: STYLES,
      theme: THEME,
    });
    const { sheets, layout } = await readWorkbook(bytes, undefined, {});
    const look = sheets[0]?.layout;
    if (!layout || !look) throw new Error("No layout was read.");

    expect(layout.defaultFont).toEqual({ name: "Calibri", size: 11, color: "#000000" });
    const title = layout.styles[look.styles.get(cellIndex(1, 0)) ?? 0];
    expect(title?.font).toEqual({
      name: "Georgia",
      size: 14,
      bold: true,
      italic: true,
      underline: "single",
      color: "#C00000",
    });
    expect(title?.fill).toBe(`#${tint("4472C4", 0.79998168889431442)}`);
    expect(title?.border).toEqual({
      left: { style: "thin", color: "#000000" },
      right: { style: "medium", color: "#0000FF" },
      top: { style: "dashed", color: "#FF0000" },
      bottom: { style: "double", color: "#000000" },
    });
    expect(title).toMatchObject({
      horizontal: "center",
      vertical: "top",
      wrap: true,
      indent: 2,
      rotation: 90,
    });
    const date = layout.styles[look.styles.get(cellIndex(1, 1)) ?? 0];
    expect(date?.font).toMatchObject({ strike: true, underline: "double", size: 9 });
    expect(date?.font.color).toBe(`#${tint("4472C4", -0.249977111117893)}`);
    expect(date?.fill).toBe("#FFFF00");
    // An empty cell keeps its style, and reaches the sheet's extent.
    expect(look.styles.get(cellIndex(1, 3))).toBe(5);
    expect(look.extent).toEqual({ rows: 1, columns: 4 });
  });

  test("values show as Excel's own format does, while what is indexed stays the same", async () => {
    const sheet = `<sheetData><row r="1"><c r="A1" s="2"><v>46114</v></c><c r="B1" s="3"><v>-1250</v></c><c r="C1" s="4"><v>46114</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><v>#DIV/0!</v></c><c r="F1"><v>0.333333333333333</v></c></row></sheetData>`;
    const bytes = xlsxPackage({ sheets: [{ name: "Values", xml: sheet }], styles: STYLES });
    const plain = await readWorkbook(bytes);
    const { sheets } = await readWorkbook(bytes, undefined, { shortDate: "dd/mm/yyyy" });

    // The values indexed are the same, with or without the look.
    expect(sheets[0]?.cells).toEqual(plain.sheets[0]?.cells);
    expect(plain.sheets[0]?.cells.map((cell) => cell.value)).toEqual([
      "2026-04-02",
      "-1,250",
      "2026-04-02",
      "TRUE",
      "#DIV/0!",
      "0.333333333333333",
    ]);
    expect(plain.sheets[0]?.layout).toBeUndefined();
    const look = sheets[0]?.layout;
    expect(look?.shown.get(cellIndex(1, 0))).toEqual({ text: "2-Apr-26" });
    expect(look?.shown.get(cellIndex(1, 1))).toEqual({ text: "-1,250", color: "#FF0000" });
    // Format 14 is the system's short date.
    expect(look?.shown.get(cellIndex(1, 2))).toEqual({ text: "02/04/2026" });
    // General fits the standard column: 8 characters.
    expect(look?.shown.get(cellIndex(1, 5))).toEqual({ text: "0.333333" });
    expect([...(look?.centred ?? [])]).toEqual([cellIndex(1, 3), cellIndex(1, 4)]);
  });

  test("rich text keeps each run's font", async () => {
    const bytes = xlsxPackage({
      sheets: [
        {
          name: "Rich",
          xml: `<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData>`,
        },
      ],
      styles: STYLES,
      sharedStrings: [
        `<si><r><t xml:space="preserve">Net </t></r><r><rPr><b/><color rgb="FFFF0000"/><sz val="11"/><rFont val="Calibri"/></rPr><t>loss</t></r></si>`,
        `<si><t>plain</t></si>`,
      ],
    });
    const { sheets } = await readWorkbook(bytes, undefined, {});
    expect(sheets[0]?.cells.map((cell) => cell.value)).toEqual(["Net loss", "plain"]);
    expect(sheets[0]?.layout?.runs.get(cellIndex(1, 0))).toEqual([
      { text: "Net " },
      { text: "loss", font: { name: "Calibri", size: 11, bold: true, color: "#FF0000" } },
    ]);
    expect(sheets[0]?.layout?.runs.has(cellIndex(1, 1))).toBe(false);
  });

  test("sizes, hidden rows and columns, frozen panes, gridlines and the tab colour", async () => {
    const xml = [
      `<sheetPr><tabColor rgb="FF00B050"/></sheetPr>`,
      `<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`,
      `<sheetFormatPr defaultRowHeight="18" defaultColWidth="12"/>`,
      `<cols><col min="1" max="1" width="20" customWidth="1"/><col min="2" max="3" width="9.140625" hidden="1"/><col min="4" max="4" width="10" style="5"/></cols>`,
      `<sheetData><row r="1" ht="30" customHeight="1"><c r="A1" t="inlineStr"><is><t>Tall</t></is></c></row><row r="2" hidden="1"><c r="A2"><v>1</v></c></row><row r="3" s="5" customFormat="1"><c r="A3"><v>2</v></c></row></sheetData>`,
    ].join("");
    const bytes = xlsxPackage({
      sheets: [
        { name: "Hidden", xml: "<sheetData/>", state: "hidden" },
        { name: "Sized", xml },
        { name: "Plain", xml: "<sheetData/>" },
      ],
      styles: STYLES,
      activeTab: 2,
    });
    const { sheets, layout } = await readWorkbook(bytes, undefined, {});
    const look = sheets[0]?.layout;

    expect(sheets.map((sheet) => sheet.name)).toEqual(["Sized", "Plain"]);
    // The active tab counts the hidden sheet; the index is among the sheets shown.
    expect(layout?.activeSheet).toBe(1);
    expect(look?.tabColor).toBe("#00B050");
    expect(look?.showGridLines).toBe(false);
    expect(look?.frozen).toEqual({ rows: 2, columns: 1 });
    expect(look?.defaultRowHeight).toBe(24);
    expect(look?.defaultColumnWidth).toBe(84);
    expect(look?.columns.get(0)).toEqual({ width: 140 });
    expect(look?.columns.get(1)).toEqual({ width: 64, hidden: true });
    expect(look?.columns.get(2)).toEqual({ width: 64, hidden: true });
    expect(look?.columns.get(3)).toEqual({ width: 70, style: 5 });
    expect(look?.rows.get(1)).toEqual({ height: 40 });
    expect(look?.rows.get(2)).toEqual({ hidden: true });
    expect(look?.rows.get(3)).toEqual({ style: 5 });
    expect(sheets[0]?.columnWidths[0]).toBe(140);
  });

  test("pictures, charts and notes over the cells", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>10</xdr:row><xdr:rowOff>190500</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1" descr="Site map"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>
<xdr:oneCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="4572000" cy="2743200"/><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>
<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="4" name="TextBox 1"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill></xdr:spPr><xdr:txBody><a:bodyPr/><a:p><a:r><a:t>Draft figures</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>`;
    const chart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue by quarter</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
    const comments = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>J. Moreau</author></authors><commentList><comment ref="B2" authorId="0"><text><r><t>Check against the audit.</t></r></text></comment></commentList></comments>`;
    const rel = (id: string, type: string, target: string) =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
    const bytes = xlsxPackage({
      sheets: [
        {
          name: "Drawn",
          xml: `<sheetData><row r="2"><c r="B2"><v>1</v></c></row></sheetData><drawing r:id="rId1"/>`,
          rels:
            rel("rId1", "drawing", "../drawings/drawing1.xml") +
            rel("rId2", "comments", "../comments1.xml"),
        },
      ],
      parts: [
        { name: "xl/drawings/drawing1.xml", data: drawing },
        {
          name: "xl/drawings/_rels/drawing1.xml.rels",
          data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "image", "../media/image1.png")}${rel("rId2", "chart", "../charts/chart1.xml")}</Relationships>`,
        },
        { name: "xl/media/image1.png", data: png },
        { name: "xl/charts/chart1.xml", data: chart },
        { name: "xl/comments1.xml", data: comments },
      ],
    });
    const look = (await readWorkbook(bytes, undefined, {})).sheets[0]?.layout;

    expect(look?.drawings).toEqual([
      {
        kind: "picture",
        src: `data:image/png;base64,${png.toString("base64")}`,
        text: "Site map",
        from: { row: 3, column: 1, x: 10, y: 0 },
        to: { row: 11, column: 4, x: 0, y: 20 },
      },
      {
        kind: "chart",
        chart: "column",
        text: "Revenue by quarter",
        from: { row: 1, column: 6, x: 0, y: 0 },
        size: { width: 480, height: 288 },
      },
      {
        kind: "shape",
        text: "Draft figures",
        fill: "#FFF2CC",
        from: { row: 13, column: 0, x: 0, y: 0 },
        to: { row: 15, column: 2, x: 0, y: 0 },
      },
    ]);
    expect(look?.notes.get(cellIndex(2, 1))).toBe("J. Moreau:\nCheck against the audit.");
    expect(look?.extent).toEqual({ rows: 15, columns: 7 });
  });

  test("the fixture's look: a frozen header, a navy heading row, bold totals, its widths", async () => {
    const { sheets, layout } = await readWorkbook(fixture("Regional Revenue.xlsx"), undefined, {});
    const look = sheets[0]?.layout;
    if (!layout || !look) throw new Error("No layout was read.");
    expect(look.frozen).toEqual({ rows: 3, columns: 0 });
    expect(look.columns.get(0)?.width).toBe(112);
    const heading = layout.styles[look.styles.get(cellIndex(3, 0)) ?? 0];
    expect(heading?.fill).toBe("#1E3A5F");
    expect(heading?.font).toMatchObject({ bold: true, color: "#FFFFFF" });
    expect(look.rows.get(3)?.style).toBe(3);
    expect(layout.styles[look.styles.get(cellIndex(8, 0)) ?? 0]?.font.bold).toBe(true);
    expect(layout.styles[look.styles.get(cellIndex(1, 0)) ?? 0]?.font).toMatchObject({
      bold: true,
      size: 14,
    });
  });
});

describe("a formula the file saved no result for (#1514)", () => {
  // protects=a cell whose formula has no saved result, as openpyxl writes it, isn't read as 0 or indexed, and the preview is told to say "No saved value" for it; a cell with a saved 0 stays 0; fails_when=the empty result reads as 0; no_claim=the viewer's wording.
  test("isn't 0: it has no value of its own, and the layout says so", async () => {
    const sheet = [
      `<sheetData>`,
      `<row r="1"><c r="A1" t="inlineStr"><is><t>Shipments</t></is></c><c r="B1"><v>128400</v></c></row>`,
      `<row r="2"><c r="A2" t="inlineStr"><is><t>Total</t></is></c><c r="B2"><f>SUM(B1:B1)</f><v></v></c><c r="C2"><f>SUM(B1:B1)</f></c><c r="D2"><f>SUM(B1:B1)</f><v>0</v></c><c r="E2" t="str"><f>"x"</f><v></v></c></row>`,
      `</sheetData>`,
    ].join("");
    const { sheets } = await readWorkbook(
      xlsxPackage({ sheets: [{ name: "Totals", xml: sheet }], styles: STYLES }),
      undefined,
      {},
    );
    const cells = sheets[0]?.cells ?? [];
    const at = (column: number) => cells.find((each) => each.row === 2 && each.column === column);
    // No number, so nothing for an Answer to quote as 0.
    expect(at(1)).toBeUndefined();
    expect(at(2)).toBeUndefined();
    // A saved 0 is a 0, and a text result that is empty is the empty text it saved.
    expect(at(3)?.value).toBe("0");
    expect(at(4)).toBeUndefined();
    const look = sheets[0]?.layout;
    expect([...(look?.noValue ?? [])].sort()).toEqual([cellIndex(2, 1), cellIndex(2, 2)].sort());
  });
});
