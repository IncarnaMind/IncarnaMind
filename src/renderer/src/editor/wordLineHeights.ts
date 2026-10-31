import type { WordLook, WordParagraphLook, WordRunLook } from "../../../core/api";
import { SINGLE_LINE } from "../../../shared/mindStyle";

/**
 * Word's single line of each font, as a multiple of its size: as Windows measures the font
 * (GDI's height and external leading), its OS/2 usWinAscent and usWinDescent, and the hhea
 * line gap where it reaches past them, over its units per em. Read from each font's own tables;
 * Chromium's own line height would be up to 6% off, and Page view's pages depend on these.
 */
const SINGLE_LINES: Readonly<Record<string, number>> = {
  calibri: 1.2207,
  carlito: 1.2207,
  cambria: 1.1724,
  candara: 1.2207,
  constantia: 1.2207,
  corbel: 1.2207,
  aptos: 1.2847,
  "times new roman": 1.1499,
  arial: 1.1499,
  "courier new": 1.1328,
  consolas: 1.1709,
  georgia: 1.1362,
  verdana: 1.2153,
  tahoma: 1.207,
  "trebuchet ms": 1.1611,
  garamond: 1.125,
  "book antiqua": 1.2427,
  "palatino linotype": 1.3491,
  "bookman old style": 1.1738,
  century: 1.2021,
  "century schoolbook": 1.2021,
  "century gothic": 1.2261,
  "franklin gothic book": 1.1338,
  "gill sans mt": 1.1597,
  rockwell: 1.1743,
  "segoe ui": 1.3301,
  simsun: 1.1406,
  宋体: 1.1406,
  nsimsun: 1.1406,
  新宋体: 1.1406,
  fangsong: 1.1406,
  仿宋: 1.1406,
  "microsoft yahei": 1.3198,
  微软雅黑: 1.3198,
  dengxian: 1.042,
  等线: 1.042,
  stzhongsong: 1.325,
  华文中宋: 1.325,
  "microsoft jhenghei": 1.3301,
  微軟正黑體: 1.3301,
  pmingliu: 1.1992,
  新細明體: 1.1992,
  mingliu: 1.1992,
  細明體: 1.1992,
  "ms mincho": 1,
  "ｍｓ 明朝": 1,
  "ms gothic": 1,
  "ｍｓ ゴシック": 1,
  "yu mincho": 1.6021,
  游明朝: 1.6021,
  "yu gothic": 1.6021,
  游ゴシック: 1.6021,
  meiryo: 1.5,
  メイリオ: 1.5,
  batang: 1.1484,
  바탕: 1.1484,
  gulim: 1.1484,
  굴림: 1.1484,
  dotum: 1.1484,
  돋움: 1.1484,
  "malgun gothic": 1.3301,
  "맑은 고딕": 1.3301,
};

const singleOf = (font: string | undefined) =>
  font ? SINGLE_LINES[font.trim().toLowerCase()] : undefined;

/**
 * A run's single line as a multiple of its size: its font's, the larger of its two where the
 * file has East Asian text, as Word gives a line its tallest font's height; Word's usual where
 * neither font is known.
 */
export function singleLineOf(run: WordRunLook | undefined, eastAsian: boolean): number {
  const known = [singleOf(run?.font), eastAsian ? singleOf(run?.eastAsia) : undefined].filter(
    (each): each is number => each !== undefined,
  );
  return known.length > 0 ? Math.max(...known) : SINGLE_LINE;
}

const twips = (points: number) => Math.round(points * 20) / 20;
const ratio = (value: number) => String(Math.round(value * 10000) / 10000);

export interface LineHeight {
  /** The paragraph's single line, as a multiple of its size: for a line spacing set on it later. */
  single: string;
  lineHeight: string;
}

/**
 * A paragraph's line height in the Word look, as a multiple of its text's size so text of
 * another size keeps the proportion: its font's single line in whole twips, as Word lays lines
 * out, times its spacing. On a document grid an "auto" line takes a whole number of the grid's
 * pitches, unless the paragraph turns the grid off; an exact height ignores the grid.
 */
export function paragraphLineHeight(
  paragraph: WordParagraphLook,
  run: WordRunLook | undefined,
  look: Pick<WordLook, "body" | "linePitch" | "eastAsian">,
  length: (points: number) => string,
): LineHeight {
  const size = run?.size ?? look.body ?? 11;
  const natural = twips(size * singleLineOf(run, look.eastAsian === true));
  const pitch = paragraph.snapToGrid === false ? undefined : look.linePitch;
  const single = pitch ? Math.max(1, Math.ceil(natural / pitch - 1e-6)) * pitch : natural;
  const { line } = paragraph;
  const lineHeight =
    !line || line.rule === "auto"
      ? ratio(twips(single * (line?.value ?? 1)) / size)
      : line.rule === "exact"
        ? length(line.value)
        : `max(${ratio(single / size)}em, ${length(line.value)})`;
  return { single: ratio(single / size), lineHeight };
}
