/**
 * `npm run eval:word` (eval/word/README.md): numbered lists' schemes in Word (#1419). A Mind with a
 * list in each scheme, three levels deep, and one that starts a level deeper, exports to .docx;
 * LibreOffice opens it and draws each item's number as the scheme writes it ("(a)", "(i)", "1.1.",
 * "（一）"). Its PDF is kept for a person to look at when INCARNAMIND_WORD_PDFS is set (CI uploads
 * it). Without LibreOffice the check is skipped, unless INCARNAMIND_WORD_REQUIRE_LIBREOFFICE=1.
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

const words = (text: string): Block => ({
  kind: "paragraph",
  content: [{ kind: "text", text, marks: NO_MARKS }],
});

/** A list of `texts` in `scheme` at `level`, each item holding the lists in `inside` at its place. */
const list = (
  scheme: NumberingScheme,
  level: number,
  texts: readonly string[],
  inside: readonly (Block | null)[] = [],
): Block => ({
  kind: "list",
  ordered: true,
  start: 1,
  items: texts.map((text, at) => {
    const nested = inside[at];
    return nested ? [words(text), nested] : [words(text)];
  }),
  numbering: {
    scheme,
    level,
    markers: texts.map((_, at) =>
      numberingMarker(scheme, level, [...Array.from({ length: level }, () => 1), at + 1]),
    ),
  },
});

/** The scheme's list three levels deep, a paragraph, and a list that starts a level deeper. */
function exported(scheme: NumberingScheme): Uint8Array {
  const blocks: Block[] = [
    list(
      scheme,
      0,
      ["Rent", "Deposit"],
      [list(scheme, 1, ["Monthly"], [list(scheme, 2, ["In advance"])])],
    ),
    words("Then the repairs."),
    list(scheme, 1, ["Repairs"]),
  ];
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

describe("numbered lists' schemes open in LibreOffice as Word numbering", () => {
  it.each(NUMBERING_SCHEMES)("%s", async (scheme) => {
    if (!soffice) {
      expect(required, "LibreOffice is required (INCARNAMIND_WORD_REQUIRE_LIBREOFFICE)").toBe(
        false,
      );
      return;
    }
    const folder = mkdtempSync(join(tmpdir(), "incarnamind-word-numbering-"));
    try {
      const path = join(folder, `numbering-${scheme}.docx`);
      writeFileSync(path, exported(scheme));
      if (keepPdfs)
        await convertFile(soffice, path, "pdf", ".pdf", join(keepPdfs, `numbering-${scheme}.pdf`));
      const text = await convertFile(soffice, path, "txt:Text (encoded):UTF8", ".txt");
      expect(text.opened, text.problem).toBe(true);
      const numbers = (text.data?.toString("utf8") ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /(Rent|Monthly|In advance|Deposit|Repairs)$/.test(line))
        .map((line) => line.replace(/\s*(Rent|Monthly|In advance|Deposit|Repairs)$/, ""));
      expect(numbers).toEqual(DRAWN[scheme]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
