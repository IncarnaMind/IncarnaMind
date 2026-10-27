import { buildPdf, type PdfPage, pdfAppearance, pdfString } from "./pdf";

export function inspectionPage(chinese = false): PdfPage {
  const labels = chinese
    ? ["批次编号", "单件质量（g）", "数量", "检查日期", "处置", "暂停放行", "已放行", "操作员备注"]
    : [
        "Batch identifier",
        "Unit mass (g)",
        "Quantity",
        "Inspection date",
        "Disposition",
        "On hold",
        "Released",
        "Operator note",
      ];
  const note = chinese
    ? "不包括BIRCH-41。仅BIRCH-42在本次检查范围内。"
    : "Exclude BIRCH-41. Only BIRCH-42 is in scope.";
  const values = [
    "BIRCH-42",
    "125.50",
    "4",
    "2026-10-23",
    chinese ? "隔离" : "Quarantine",
    "[x]",
    "[ ]",
    note,
  ];
  return {
    printed: [{ text: chinese ? "检查记录" : "Inspection record", size: 18 }],
    placed: labels.map((text, index) => ({ text, x: 48, y: 700 - index * 45 })),
    fields: labels.map((label, index) => {
      const value = values[index] ?? "";
      const y = 700 - index * 45;
      const box = index === 5 || index === 6;
      const type = box
        ? "/FT /Btn"
        : index === 4
          ? `/FT /Ch /Ff 131072 /Opt [[(Q) ${pdfString(value)}] [(R) (Released)]]`
          : "/FT /Tx";
      const stored = box ? `/${index === 5 ? "Yes" : "Off"}` : pdfString(index === 4 ? "Q" : value);
      return {
        dictionary: `${type} /T (field${index}) /TU ${pdfString(label)} /V ${stored} ${box ? `/AS ${stored}` : ""} /Rect [210 ${y - 6} ${box ? 234 : 570} ${y + 18}] /F 4`,
        appearance: box
          ? { Off: "0 0 300 24 re S", Yes: "0 0 300 24 re S 0 0 m 300 24 l 0 24 m 300 0 l S" }
          : pdfAppearance(value),
      };
    }),
  };
}

export const inspectionPdf = (chinese = false) => buildPdf([inspectionPage(chinese)]);
