import { buildPdf } from "../helpers/pdf";
import { paragraph, wordFile } from "../helpers/word";
import type { BriefCase } from "./verifyBrief.cases";

/** A paragraph's lines as a PDF breaks them: a page holds about 85 Latin or 36 Chinese characters across. */
const wrap = (text: string, chinese: boolean): string[] => {
  if (chinese) return text.match(/[\s\S]{1,36}/g) ?? [];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > 85) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  return line === "" ? lines : [...lines, line];
};

export const pdfOf = (each: BriefCase) => {
  const chinese = each.language === "Chinese";
  const lines = (sections: BriefCase["sections"]) =>
    sections.flatMap((s) => [s.heading, ...s.lines].flatMap((line) => wrap(line, chinese)));
  const first = [...wrap(each.title, chinese), ...lines(each.sections.slice(0, 2))];
  const second = lines(each.sections.slice(2));
  return buildPdf(
    chinese
      ? [{ chineseLines: first }, { chineseLines: second }]
      : [{ lines: first }, { lines: second }],
  );
};

export const wordOf = (each: BriefCase) =>
  wordFile({
    body: [
      paragraph(each.title, { style: "Heading1" }),
      ...each.sections.flatMap((s) => [
        paragraph(s.heading, { style: "Heading2" }),
        ...s.lines.map((line) => paragraph(line)),
      ]),
    ].join(""),
  });
