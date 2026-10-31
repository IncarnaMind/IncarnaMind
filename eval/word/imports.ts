/**
 * The import check for the Word corpus (#104): a file imports as a Mind
 * without being refused (unless #104 refuses its kind: Strict Open XML,
 * macros, a password), every node is one the editor's schema takes, and
 * nothing is dropped without a word: the text of every paragraph of the body,
 * as the Document reader reads it, is kept in the Mind (its text, or the text
 * an atom kept as is holds or shows), and the import says what it made
 * editable and what it kept, by count.
 */
import { getSchema } from "@tiptap/core";
import {
  FOOTNOTE_NODE,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  WORD_ATOM_NODE,
  WORD_BLOCK_NODE,
  type WordImportReport,
  type WordRefusalReason,
} from "../../src/core/api";
import { textIn } from "../../src/core/documents/formats/docx";
import { readWordStructure } from "../../src/core/documents/formats/docxImport";
import {
  openWordPackage,
  reviewOf,
  WordRefusedError,
} from "../../src/core/documents/formats/docxPackage";
import {
  child,
  descendants,
  parseXml,
  type XmlElement,
  type XmlNode,
} from "../../src/core/documents/formats/xml";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readProposalAttribute } from "../../src/shared/proposals";
import { readWordAtom } from "../../src/shared/wordFiles";

const schema = getSchema(noteExtensions());

const REFUSED: ReadonlySet<WordRefusalReason> = new Set([
  "legacy",
  "macros",
  "encrypted",
  "strict",
]);

export interface ImportCheck {
  ok: boolean;
  detail: string;
  report?: WordImportReport;
}

/** Text compared without its spacing, and with the hyphens and breaks Word writes as characters. */
const normal = (text: string) => text.replace(/[\s­]/g, "").replace(/‑/g, "-");

/**
 * The text a Mind's nodes keep, in order: atoms by what they show or hold.
 * Struck text (another person's deletion, as a change to accept or reject or
 * kept as is, a move's old place) is apart, as the editor shows it; comments
 * and notes are kept beside the text, not in it.
 */
function mindText(nodes: readonly NodeJSON[], into = { shown: "", struck: "" }, struck = false) {
  for (const node of nodes) {
    if (node.type === FOOTNOTE_NODE) continue;
    const removed =
      struck ||
      readProposalAttribute(node.attrs?.[PROPOSAL_ATTRIBUTE])?.kind === "delete" ||
      (node.marks?.some((mark) => mark.type === PROPOSAL_DELETE_MARK) ?? false);
    if (node.type === "text") {
      if (removed) into.struck += node.text ?? "";
      else into.shown += node.text ?? "";
    } else if (node.type === WORD_ATOM_NODE || node.type === WORD_BLOCK_NODE) {
      const atom = readWordAtom(node.attrs ?? {});
      if (atom.kind === "deletion") into.struck += atom.label;
      else if (!["comment", "footnote", "endnote"].includes(atom.kind)) {
        into.shown += `${atom.label}${atom.text}`;
      }
    }
    if (node.content) mindText(node.content, into, removed);
  }
  return into;
}

/** An element without what it moved away, which the Document reader reads as if it were still there. */
const withoutMoves = (node: XmlElement): XmlElement => ({
  ...node,
  children: node.children.flatMap((each): XmlNode[] => {
    if (typeof each === "string") return [each];
    return each.name === "w:moveFrom" ? [] : [withoutMoves(each)];
  }),
});

/** What the import made editable and kept as is, in one line. */
function counts(report: WordImportReport, changes: number): string {
  const listed = (counted: Partial<Record<string, number>>) =>
    Object.entries(counted)
      .filter(([, count]) => (count ?? 0) > 0)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
  return [
    `${report.paragraphs} paragraphs`,
    `${report.tables} tables`,
    `${report.images} pictures`,
    `${report.links} links`,
    ...(changes > 0 ? [`${changes} changes to accept or reject`] : []),
    `kept: ${listed(report.kept) || "nothing"}`,
    ...(report.keptChanges ? [`changes kept: ${listed(report.keptChanges)}`] : []),
  ].join(", ");
}

export async function checkImport(bytes: Uint8Array): Promise<ImportCheck> {
  let blocks: NodeJSON[];
  let report: WordImportReport;
  let changes: number;
  let body: ReturnType<typeof child>;
  try {
    const pkg = await openWordPackage(bytes);
    const structure = await readWordStructure(pkg, await reviewOf(pkg));
    blocks = structure.blocks;
    report = structure.report;
    changes = structure.changes.size;
    body = child(parseXml((await pkg.zip.readText(pkg.part)) ?? ""), "w:body");
  } catch (error) {
    // What #104 refuses on purpose, before any Mind is made: a Strict file, macros, a password.
    if (error instanceof WordRefusedError && REFUSED.has(error.reason)) {
      return { ok: true, detail: `refused, as it should be: ${error.reason}` };
    }
    return { ok: false, detail: `refused: ${error instanceof Error ? error.message : error}` };
  }
  try {
    if (blocks.length > 0) schema.nodeFromJSON({ type: "doc", content: blocks }).check();
  } catch (error) {
    return {
      ok: false,
      detail: `not a Mind the editor takes: ${(error as Error).message}`,
      report,
    };
  }
  const kept = mindText(blocks);
  const shown = normal(kept.shown);
  const struck = normal(kept.struck);
  const missing = [
    ...(body ? descendants(body, "w:p") : [])
      .map((paragraph) => normal(textIn(withoutMoves(paragraph))))
      .filter((text) => text !== "" && !shown.includes(text)),
    ...(body ? descendants(body, "w:moveFrom") : [])
      .map((moved) => normal(textIn(moved)))
      .filter((text) => text !== "" && !struck.includes(text)),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `${missing.length} paragraphs' text not in the Mind, first: "${missing[0]?.slice(0, 60)}"`,
      report,
    };
  }
  return { ok: true, detail: counts(report, changes), report };
}
