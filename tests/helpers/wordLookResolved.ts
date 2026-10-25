import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, WORD_DIR } from "../../eval/word/corpus";
import {
  PARAGRAPH_FORMAT_ATTRIBUTE,
  SUBSCRIPT_MARK,
  SUPERSCRIPT_MARK,
  TEXT_COLOR_MARK,
  WORD_LOOK_ATTRIBUTE,
  WORD_RUN_MARK,
  type WordLook,
  type WordParagraphLook,
  type WordRunLook,
} from "../../src/core/api";
import type { MarkJSON, NodeJSON } from "../../src/shared/blockJson";
import { readParagraphFormat } from "../../src/shared/paragraphFormat";
import { sorted } from "../../src/shared/wordFiles";
import { contractFile, resumeFile } from "./wordLookFiles";

const FIXTURE_FOLDERS = [
  "tests/fixtures/formats",
  "tests/fixtures/word-look",
  "tests/fixtures/organize/files",
];

/** Every Word file the tests and the corpus hold, by name. */
export function wordFixtures(): [string, Uint8Array][] {
  const found: [string, Uint8Array][] = readManifest().map((entry) => [
    `eval/word/${entry.file}`,
    readFileSync(join(WORD_DIR, entry.file)),
  ]);
  for (const folder of FIXTURE_FOLDERS) {
    for (const name of readdirSync(folder).sort()) {
      if (name.endsWith(".docx"))
        found.push([`${folder}/${name}`, readFileSync(join(folder, name))]);
    }
  }
  found.push(["helpers/resume", resumeFile()], ["helpers/contract", contractFile()]);
  return found;
}

const rounded = (value: unknown): unknown =>
  typeof value === "number"
    ? Math.round(value * 100) / 100
    : Array.isArray(value)
      ? value.map(rounded)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, each]) => [key, rounded(each)]))
        : value;

const short = (value: unknown) =>
  createHash("sha1")
    .update(JSON.stringify(sorted(rounded(value))))
    .digest("hex")
    .slice(0, 8);

/** A paragraph's look with its format over it, as a look that has it all says it. */
export function withFormat(
  own: WordParagraphLook,
  characterSize: number | undefined,
  value: unknown,
) {
  const format = readParagraphFormat(value);
  const look: WordParagraphLook = { ...own };
  const set = <K extends keyof WordParagraphLook>(
    name: K,
    to: WordParagraphLook[K] | undefined,
  ) => {
    if (to === undefined || to === 0 || to === "left") delete look[name];
    else look[name] = to;
  };
  if (format.align !== undefined) set("align", format.align);
  for (const name of ["left", "right", "before", "after"] as const) {
    if (format[name] !== undefined) set(name, format[name]);
  }
  if (format.firstLineChars !== undefined) {
    if (characterSize === undefined) throw new Error("A character indent with no size.");
    set("firstLine", format.firstLineChars * characterSize);
  } else if (format.firstLine !== undefined) set("firstLine", format.firstLine);
  if (format.line) look.line = format.line;
  return look;
}

/** A run's look with the text's colour and raise over it. */
export function withMarks(look: WordRunLook | null, marks: readonly MarkJSON[] | undefined) {
  const color = marks?.find((mark) => mark.type === TEXT_COLOR_MARK)?.attrs?.color;
  const vertical = marks?.some((mark) => mark.type === SUPERSCRIPT_MARK)
    ? "superscript"
    : marks?.some((mark) => mark.type === SUBSCRIPT_MARK)
      ? "subscript"
      : undefined;
  if (typeof color !== "string" && !vertical) return look;
  return {
    ...look,
    ...(typeof color === "string" && { color }),
    ...(vertical && { vertical }),
  };
}

/**
 * Each paragraph's look as it draws: the paragraph's own with its format over it, and each
 * text's run look with its colour and raise. One short hash a paragraph, so a file's paragraphs
 * compare in one line.
 */
export function drawnParagraphs(blocks: readonly NodeJSON[], look: WordLook): string {
  const hashes: string[] = [];
  const visit = (node: NodeJSON) => {
    if (node.type === "paragraph" || node.type === "heading") {
      const key = node.attrs?.[WORD_LOOK_ATTRIBUTE];
      const entry = typeof key === "string" ? look.paragraphs[key] : undefined;
      const { run, next: _next, characterSize, ...own } = entry ?? {};
      const format = node.attrs?.[PARAGRAPH_FORMAT_ATTRIBUTE];
      const runs = (node.content ?? [])
        .filter((child) => child.type === "text")
        .map((child) => {
          const k = child.marks?.find((mark) => mark.type === WORD_RUN_MARK)?.attrs?.k ?? run;
          const runLook = typeof k === "string" ? (look.runs[k] ?? null) : null;
          return [child.text?.length ?? 0, withMarks(runLook, child.marks)];
        });
      const drawn = entry ? withFormat(own, characterSize, format) : null;
      hashes.push(short({ look: drawn, runs }));
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const block of blocks) visit(block);
  return hashes.join(" ");
}
