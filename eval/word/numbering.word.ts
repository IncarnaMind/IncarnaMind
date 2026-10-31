/**
 * `npm run eval:word` (eval/word/README.md): numbered lists' schemes in Word (#1419). A Mind with a
 * list in each scheme, three levels deep, and one that starts a level deeper, exports to .docx;
 * LibreOffice opens it and draws each item's number as the scheme writes it ("(a)", "(i)", "1.1.",
 * "（一）"). A second Mind has a list under a bullet, a nested list from 3, and two nested lists in
 * one item, the second starting again. Its PDF is kept for a person to look at when
 * INCARNAMIND_WORD_PDFS is set (CI uploads it). Without LibreOffice the check is skipped, unless
 * INCARNAMIND_WORD_REQUIRE_LIBREOFFICE=1.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDocx } from "../../src/core/exports/docx";
import { exportLabels } from "../../src/core/exports/labels";
import { type Block, NO_MARKS } from "../../src/core/mindText";
import {
  NUMBERING_SCHEMES,
  type NumberingScheme,
  numberingMarker,
} from "../../src/shared/numbering";
import { convertFile, findLibreOffice } from "./libreoffice";

const soffice = findLibreOffice();
const keepPdfs = process.env.INCARNAMIND_WORD_PDFS;
const required = process.env.INCARNAMIND_WORD_REQUIRE_LIBREOFFICE === "1";

/** Each item's number as the scheme draws it, in the order LibreOffice writes the lines. */
const DRAWN: Record<NumberingScheme, readonly string[]> = {
  default: ["1.", "a.", "i.", "2.", "a."],
  outline: ["1.", "1.1.", "1.1.1.", "2.", "1.1."],
  clauses: ["(a)", "(i)", "(A)", "(b)", "(i)"],
  chinese: ["一、", "（一）", "1.", "二、", "（一）"],
};

/** The same, for the second Mind: Alpha and Beta under a bullet, Delta from 3, Eta and Theta in one item. */
const DRAWN_NESTED: Record<NumberingScheme, readonly string[]> = {
  default: ["1.", "2.", "1.", "c.", "d.", "2.", "a.", "a."],
  outline: ["1.", "2.", "1.", "1.3.", "1.4.", "2.", "2.1.", "2.1."],
  clauses: ["(a)", "(b)", "(a)", "(iii)", "(iv)", "(b)", "(i)", "(i)"],
  chinese: ["一、", "二、", "一、", "（三）", "（四）", "二、", "（一）", "（一）"],
};

const words = (text: string): Block => ({
  kind: "paragraph",
  content: [{ kind: "text", text, marks: NO_MARKS }],
});

/** A list of `texts` in `scheme` at `level`, each item holding the Blocks in `inside` at its place. */
const list = (
  scheme: NumberingScheme,
  level: number,
  texts: readonly string[],
  inside: readonly (Block | readonly Block[] | null)[] = [],
  start = 1,
): Block => ({
  kind: "list",
  ordered: true,
  start,
  items: texts.map((text, at) => {
    const nested = inside[at];
    return [words(text), ...(nested ? (Array.isArray(nested) ? nested : [nested]) : [])];
  }),
  numbering: {
    scheme,
    level,
    markers: texts.map((_, at) =>
      numberingMarker(scheme, level, [...Array.from({ length: level }, () => 1), start + at]),
    ),
  },
});

/** The scheme's list three levels deep, a paragraph, and a list that starts a level deeper. */
const threeDeep = (scheme: NumberingScheme): Block[] => [
  list(
    scheme,
    0,
    ["Rent", "Deposit"],
    [list(scheme, 1, ["Monthly"], [list(scheme, 2, ["In advance"])])],
  ),
  words("Then the repairs."),
  list(scheme, 1, ["Repairs"]),
];

/** A list under a bullet, then a list whose items hold a list from 3 and two lists, the second starting again. */
const nested = (scheme: NumberingScheme): Block[] => [
  {
    kind: "list",
    ordered: false,
    start: 1,
    items: [[words("Bullet"), list(scheme, 0, ["Alpha", "Beta"])]],
  },
  list(
    scheme,
    0,
    ["Gamma", "Zeta"],
    [
      list(scheme, 1, ["Delta", "Epsilon"], [], 3),
      [list(scheme, 1, ["Eta"]), words("Then."), list(scheme, 1, ["Theta"])],
    ],
  ),
];

function exported(scheme: NumberingScheme, blocks: Block[]): Uint8Array {
  return renderDocx(blocks, {
    title: `Lease, ${scheme}`,
    labels: exportLabels("en"),
    language: "en-US",
    paper: "a4",
    created: "2026-10-21T00:00:00Z",
    font: null,
    lineSpacing: null,
  }).data;
}

/** The number LibreOffice draws before each item named in `items`, in the order of its lines. */
async function drawnNumbers(
  name: string,
  blocks: Block[],
  scheme: NumberingScheme,
  items: readonly string[],
): Promise<string[] | null> {
  if (!soffice) {
    expect(required, "LibreOffice is required (INCARNAMIND_WORD_REQUIRE_LIBREOFFICE)").toBe(false);
    return null;
  }
  const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-numbering-"));
  try {
    const path = join(folder, `${name}.docx`);
    writeFileSync(path, exported(scheme, blocks));
    if (keepPdfs) await convertFile(soffice, path, "pdf", ".pdf", join(keepPdfs, `${name}.pdf`));
    const text = await convertFile(soffice, path, "txt:Text (encoded):UTF8", ".txt");
    expect(text.opened, text.problem).toBe(true);
    const item = new RegExp(`\\s*(${items.join("|")})$`);
    return (text.data?.toString("utf8") ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => item.test(line))
      .map((line) => line.replace(item, ""));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe("numbered lists' schemes open in LibreOffice as Word numbering", () => {
  it.each(NUMBERING_SCHEMES)("%s", async (scheme) => {
    const numbers = await drawnNumbers(`numbering-${scheme}`, threeDeep(scheme), scheme, [
      "Rent",
      "Monthly",
      "In advance",
      "Deposit",
      "Repairs",
    ]);
    if (numbers) expect(numbers).toEqual(DRAWN[scheme]);
  });

  it.each(NUMBERING_SCHEMES)("%s, under a bullet and nested from a start", async (scheme) => {
    const numbers = await drawnNumbers(`numbering-${scheme}-nested`, nested(scheme), scheme, [
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
      "Zeta",
      "Eta",
      "Theta",
    ]);
    if (numbers) expect(numbers).toEqual(DRAWN_NESTED[scheme]);
  });
});
