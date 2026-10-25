/**
 * The round-trip check for the Word corpus (#105): a file imported as a Mind
 * (#104) and exported back into itself.
 *
 * - Unchanged, the export is the file byte for byte, every entry.
 * - After a scripted edit (a word changed in the first paragraph that has
 *   one, and a paragraph with a Citation added after its Block), the edit is
 *   in the file, the Citation is a footnote, every entry but those an edit
 *   needs is byte for byte the file's, every other paragraph and table of the
 *   body is as it was, the package passes the checks Word's repair prompt is
 *   about, nothing is reported as lost, and the file imports again with the edit.
 */
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import {
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  WORD_CHANGE_ID,
  type WordRefusalReason,
} from "../../src/core/api";
import { readWordDocument, readWordStructure } from "../../src/core/documents/formats/docxImport";
import {
  openWordPackage,
  reviewOf,
  WordRefusedError,
} from "../../src/core/documents/formats/docxPackage";
import { child, elements, parseXml, walk } from "../../src/core/documents/formats/xml";
import { openPackage } from "../../src/core/documents/formats/zip";
import { exportLabels } from "../../src/core/exports/labels";
import { exportWordPatch } from "../../src/core/exports/wordPatch";
import type { ReviewChoices } from "../../src/core/exports/wordReview";
import { reviewReading } from "../../src/core/mindText";
import { recordChanges, recordSources } from "../../src/core/wordImports";
import type { NodeJSON } from "../../src/shared/blockJson";
import { NUMBERED_STYLE } from "../../src/shared/citationStyles";
import {
  NODE_CHARACTER,
  outOfDateProposals,
  pendingProposals,
  proposalRequestOf,
  readProposalAttribute,
  readProposalRef,
  recordProposalRequest,
  resolveProposals,
  targetText,
} from "../../src/shared/proposals";
import {
  recordWordImportProgress,
  startWordImport,
  wordSourceOf,
} from "../../src/shared/wordFiles";
import { acceptedParagraphs } from "../../tests/helpers/docx";
import { inspectPackage } from "./corpus";

const REFUSED: ReadonlySet<WordRefusalReason> = new Set([
  "legacy",
  "macros",
  "encrypted",
  "strict",
]);

/** The footnote the added Citation becomes, as the export names its source. */
const SOURCE = "Round-trip check source, p. 1";
const ADDED = "Added by the round-trip check.";
const EDITED = "Roundtripped";

export interface ExportCheck {
  ok: boolean;
  detail: string;
  /** The export with the scripted edit, for opening in LibreOffice. */
  exported?: Uint8Array;
}

/** A Mind as the import writes one: the Blocks, where each came from, and the file. */
export async function mindOf(bytes: Uint8Array): Promise<Y.Doc> {
  const pkg = await openWordPackage(bytes);
  const structure = await readWordStructure(pkg, await reviewOf(pkg));
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  doc.transact(() => {
    startWordImport(
      doc,
      { name: "corpus.docx", sha256: "", size: bytes.byteLength, part: pkg.part },
      "own",
      structure.report,
      structure.blocks.length,
    );
    recordChanges(doc, structure);
    const created = structure.blocks.map(createElement);
    blocks.insert(0, created);
    for (const element of created) recordSources(doc, element, structure);
    recordWordImportProgress(doc, structure.blocks.length, structure.blocks.length);
  });
  return doc;
}

/** What an export says for review: nothing, unless a check asks (#107). */
const PLAIN: ReviewChoices = {
  trackAs: null,
  markAiText: false,
  commentFailedChecks: false,
  now: "2026-10-13T09:00:00.000Z",
};

async function exportOf(
  bytes: Uint8Array,
  doc: Y.Doc,
  review: ReviewChoices = PLAIN,
  listed = false,
) {
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  return exportWordPatch({
    bytes,
    blocks,
    readOptions: {
      includeQuestions: false,
      footnote: (attributes) =>
        attributes.check === "not-found"
          ? {
              source: SOURCE,
              unverified: true,
              failed: { check: "not-found", quote: NOT_FOUND, verdict: null },
            }
          : { source: SOURCE, unverified: false },
      trimBeforeCitation: !listed,
      trimBeforeFootnote: true,
      review: reviewReading(blocks),
    },
    labels: exportLabels("en"),
    style: { id: "numbered", ...NUMBERED_STYLE },
    bibliography: false,
    listed,
    bibliographyHeading: "References",
    sources: { language: "en", documents: [] },
    formatCitations: () => Promise.reject(new Error("Numbered needs no formatting.")),
    withPictures: async (written) => written,
    review,
  });
}

/** Each entry of a package, by name. */
async function entriesOf(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = openPackage(bytes);
  const entries = new Map<string, Uint8Array>();
  for (const name of zip.names()) entries.set(name, (await zip.read(name)) ?? new Uint8Array());
  return entries;
}

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** A word in a text that no change still waiting adds or removes: where it starts, its length and formatting. */
function plainWord(
  text: Y.XmlText,
): { index: number; length: number; attributes: Record<string, unknown> } | null {
  let at = 0;
  for (const run of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const length = typeof run.insert === "string" ? run.insert.length : 1;
    const changed =
      run.attributes !== undefined &&
      ("proposalInsert" in run.attributes || "proposalDelete" in run.attributes);
    const word =
      typeof run.insert === "string" && !changed
        ? /[\p{L}]{4,}|[\p{Script=Han}]{2,}/u.exec(run.insert)
        : null;
    if (word) {
      return { index: at + word.index, length: word[0].length, attributes: run.attributes ?? {} };
    }
    at += length;
  }
  return null;
}

/**
 * The scripted edit: a word of the first imported paragraph that has one
 * changed, and a paragraph with a Citation added after the Block it is in.
 * Returns the place of the paragraph changed, or null if none has a word.
 */
function edit(doc: Y.Doc): string | null {
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  let changed: string | null = null;
  let after = blocks.length;
  const visit = (element: Y.XmlElement, top: number): boolean => {
    if (element.nodeName === "paragraph" || element.nodeName === "heading") {
      const id = element.getAttribute("id");
      const source = typeof id === "string" ? wordSourceOf(doc, id) : null;
      for (const text of element.toArray()) {
        if (!(text instanceof Y.XmlText) || !source) continue;
        const word = plainWord(text);
        if (!word) continue;
        text.delete(word.index, word.length);
        text.insert(word.index, EDITED, word.attributes);
        changed = source.n;
        after = top + 1;
        return true;
      }
    }
    return element.toArray().some((each) => each instanceof Y.XmlElement && visit(each, top));
  };
  doc.transact(() => {
    blocks.toArray().some((each, index) => each instanceof Y.XmlElement && visit(each, index));
    const citationOf = () => {
      const element = new Y.XmlElement("citation");
      for (const [key, value] of Object.entries({
        passageId: "round-trip",
        documentId: "round-trip",
        documentName: "Round-trip check source",
        quote: "A quote.",
        check: "found",
      })) {
        element.setAttribute(key, value);
      }
      return element;
    };
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(`${ADDED} `), citationOf()]);
    // The same source and place again: a cross-reference to the first one's note.
    const again = new Y.XmlElement("paragraph");
    again.insert(0, [new Y.XmlText(`${ADDED} `), citationOf()]);
    blocks.insert(after, [paragraph, again]);
  });
  return changed;
}

/**
 * Edits of every kind the export writes: a paragraph deleted, a word made
 * bold, a link added, a heading's level changed, a list item and a table row
 * added, a paragraph moved, and a new list and table at the end.
 */
function editEveryKind(doc: Y.Doc): void {
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const all = (kind: string) => {
    const found: Y.XmlElement[] = [];
    const visit = (element: Y.XmlElement) => {
      if (element.nodeName === kind) found.push(element);
      for (const each of element.toArray()) if (each instanceof Y.XmlElement) visit(each);
    };
    for (const each of blocks.toArray()) if (each instanceof Y.XmlElement) visit(each);
    return found;
  };
  const texts = (element: Y.XmlElement) =>
    element.toArray().filter((each): each is Y.XmlText => each instanceof Y.XmlText);
  doc.transact(() => {
    const top = () =>
      blocks.toArray().filter((each): each is Y.XmlElement => each instanceof Y.XmlElement);
    const paragraphs = top().filter((each) => each.nodeName === "paragraph");
    if (paragraphs.length >= 3) blocks.delete(top().indexOf(paragraphs[1] as Y.XmlElement), 1);
    const bolded = all("paragraph").find((each) => texts(each).some((text) => text.length > 3));
    const text = bolded && texts(bolded).find((each) => each.length > 3);
    text?.format(0, 3, { bold: true });
    const linked = all("paragraph").at(-1);
    const end = linked && texts(linked).at(-1);
    end?.insert(end.length, " (see the site)", {
      link: { href: "https://example.com/round-trip" },
    });
    const heading = all("heading")[0];
    if (heading)
      heading.setAttribute(
        "level",
        String((Number(heading.getAttribute("level")) % 6) + 1) as never,
      );
    const item = all("listItem")[0];
    if (item?.parent instanceof Y.XmlElement) {
      const list = item.parent;
      list.insert(list.toArray().indexOf(item) + 1, [
        createElement({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "A new item." }] }],
        }),
      ]);
    }
    const table = all("table")[0];
    const firstRow = table?.toArray()[0];
    if (table && firstRow instanceof Y.XmlElement) {
      const cells = firstRow.toArray().length;
      table.push([
        createElement({
          type: "tableRow",
          content: Array.from({ length: cells }, () => ({
            type: "tableCell",
            content: [{ type: "paragraph", content: [{ type: "text", text: "A new row." }] }],
          })),
        }),
      ]);
    }
    const last = top()
      .filter((each) => each.nodeName === "paragraph")
      .at(-1);
    if (last && top().length > 2) {
      const at = top().indexOf(last);
      const moved = last.clone();
      blocks.delete(at, 1);
      blocks.insert(0, [moved]);
    }
    blocks.push([
      createElement({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "A new list." }] }],
          },
        ],
      }),
      createElement({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "New" }] }],
              },
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Table" }] }],
              },
            ],
          },
        ],
      }),
    ]);
  });
}

/** The top-level body elements of a main part, as written, and where the element at `place` is. */
async function bodyPieces(bytes: Uint8Array, place: string | null) {
  const pkg = await openWordPackage(bytes);
  const document = await readWordDocument(pkg, await reviewOf(pkg));
  const body = child(document.root, "w:body");
  const edited = place ? document.places.get(place) : undefined;
  return (body ? elements(body) : []).map((element) => ({
    place: document.places.placeOf(element) ?? "",
    xml: document.text.slice(element.start ?? 0, element.end ?? 0),
    holdsEdit:
      edited !== undefined &&
      (element.start ?? 0) <= (edited.start ?? 0) &&
      (edited.end ?? 0) <= (element.end ?? 0),
  }));
}

function* textsOf(node: NodeJSON): Generator<string> {
  if (node.text) yield node.text;
  for (const each of node.content ?? []) yield* textsOf(each);
}

export async function checkExport(bytes: Uint8Array): Promise<ExportCheck> {
  let doc: Y.Doc;
  try {
    doc = await mindOf(bytes);
  } catch (error) {
    if (error instanceof WordRefusedError && REFUSED.has(error.reason)) {
      return { ok: true, detail: `refused, as it should be: ${error.reason}` };
    }
    return {
      ok: false,
      detail: `didn't import: ${error instanceof Error ? error.message : error}`,
    };
  }
  const original = await entriesOf(bytes);
  const pkg = await openWordPackage(bytes);

  try {
    const unchanged = await exportOf(bytes, doc);
    const differ = [...(await entriesOf(unchanged.data))].filter(
      ([name, data]) => !same(data, original.get(name)),
    );
    if (differ.length > 0) {
      return {
        ok: false,
        detail: `unchanged, the export still differs in ${differ.map(([name]) => name).join(", ")}`,
      };
    }

    const edited = edit(doc);
    const result = await exportOf(bytes, doc);
    const exported = await entriesOf(result.data);
    // Word's repair prompt: nothing the file didn't already have.
    const before = new Set((await inspectPackage(bytes)).problems);
    const problems = (await inspectPackage(result.data)).problems.filter(
      (each) => !before.has(each),
    );
    if (problems.length > 0)
      return {
        ok: false,
        detail: `the export: ${problems.slice(0, 2).join("; ")}`,
        exported: result.data,
      };
    if (result.report.notKept.length > 0) {
      return {
        ok: false,
        detail: `reported as not kept: ${result.report.notKept.map((each) => each.kind).join(", ")}`,
        exported: result.data,
      };
    }

    // Only the parts the edit needs are written.
    const allowed = new Set([pkg.part, "[Content_Types].xml"]);
    for (const name of exported.keys()) {
      if (/^word\/(footnotes\d*|styles)\.xml$|^word\/_rels\//.test(name)) allowed.add(name);
    }
    const touched = [...exported.keys()].filter(
      (name) => !same(exported.get(name), original.get(name)),
    );
    const unexpected = touched.filter((name) => !allowed.has(name));
    if (unexpected.length > 0)
      return { ok: false, detail: `also wrote ${unexpected.join(", ")}`, exported: result.data };
    const missing = [...original.keys()].filter((name) => !exported.has(name));
    if (missing.length > 0)
      return { ok: false, detail: `left out ${missing.join(", ")}`, exported: result.data };

    // Every other paragraph and table of the body is as it was, in order, and so is everything
    // before the body: the root's namespaces, mc:Ignorable among them, are never pruned.
    const main = new TextDecoder().decode(exported.get(pkg.part));
    const head = (xml: string) => xml.slice(0, xml.search(/<(?:[\w.-]+:)?body[\s>]/));
    if (head(main) !== head(new TextDecoder().decode(original.get(pkg.part)))) {
      return { ok: false, detail: "the document's start changed", exported: result.data };
    }
    let at = 0;
    let kept = 0;
    for (const piece of await bodyPieces(bytes, edited)) {
      if (piece.holdsEdit) continue;
      const found = main.indexOf(piece.xml, at);
      if (found < 0) {
        return { ok: false, detail: `${piece.place} isn't as it was`, exported: result.data };
      }
      at = found + piece.xml.length;
      kept++;
    }

    // The edit is there, and the Citation is a footnote.
    // The text of every w:t, without recursion: a table can nest thousands deep.
    const shown = [...walk(parseXml(main))]
      .filter((element) => element.name === "w:t")
      .map((element) => element.children.filter((part) => typeof part === "string").join(""))
      .join("");
    if (edited && !shown.includes(EDITED))
      return { ok: false, detail: "the changed word isn't in the file", exported: result.data };
    if (!shown.includes(ADDED))
      return { ok: false, detail: "the added paragraph isn't in the file", exported: result.data };
    const footnotes = [...exported].find(([name]) => /^word\/footnotes\d*\.xml$/.test(name));
    const notes = footnotes ? new TextDecoder().decode(footnotes[1]) : "";
    if (!notes.includes(SOURCE)) {
      return { ok: false, detail: "the Citation isn't a footnote", exported: result.data };
    }
    const cited = notes.split(SOURCE).length - 1;
    const refs = (xml: string) => xml.split("NOTEREF ").length - 1;
    const first = new TextDecoder().decode(original.get(pkg.part));
    if (cited !== 1 || refs(main) !== refs(first) + 1) {
      return {
        ok: false,
        detail: `the same Citation again isn't one footnote and a cross-reference to it (${cited} notes, ${refs(main) - refs(first)} cross-references added)`,
        exported: result.data,
      };
    }
    const again = await readWordStructure(
      await openWordPackage(result.data),
      await reviewOf(await openWordPackage(result.data)),
    );
    const text = JSON.stringify(again.blocks.map((block) => [...textsOf(block)].join("")));
    if (!text.includes(ADDED) || (edited && !text.includes(EDITED))) {
      return {
        ok: false,
        detail: "the export doesn't import with the edit",
        exported: result.data,
      };
    }
    return {
      ok: true,
      detail: `${edited ? "a word changed, " : ""}two paragraphs, a footnote and a cross-reference to it added; ${touched.length} parts written, ${kept} body elements as they were`,
      exported: result.data,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `export failed: ${error instanceof Error ? error.message : error}`,
    };
  } finally {
    doc.destroy();
  }
}

/**
 * The scripted edit exported with the Citations in a list at the end (#1600): the Citation is
 * "[1]" in the added paragraph, the list holds its source under the Bibliography's heading, no
 * footnote is added, and the package passes the checks Word's repair prompt is about.
 */
export async function checkListExport(bytes: Uint8Array): Promise<ExportCheck> {
  let doc: Y.Doc;
  try {
    doc = await mindOf(bytes);
  } catch (error) {
    if (error instanceof WordRefusedError && REFUSED.has(error.reason)) {
      return { ok: true, detail: `refused, as it should be: ${error.reason}` };
    }
    return {
      ok: false,
      detail: `didn't import: ${error instanceof Error ? error.message : error}`,
    };
  }
  const pkg = await openWordPackage(bytes);
  try {
    edit(doc);
    const result = await exportOf(bytes, doc, PLAIN, true);
    const before = new Set((await inspectPackage(bytes)).problems);
    const problems = (await inspectPackage(result.data)).problems.filter(
      (each) => !before.has(each),
    );
    if (problems.length > 0) {
      return {
        ok: false,
        detail: `the export: ${problems.slice(0, 2).join("; ")}`,
        exported: result.data,
      };
    }
    const exported = await entriesOf(result.data);
    const main = new TextDecoder().decode(exported.get(pkg.part));
    const shown = [...walk(parseXml(main))]
      .filter((element) => element.name === "w:t")
      .map((element) => element.children.filter((part) => typeof part === "string").join(""))
      .join("");
    if (!shown.includes(`${ADDED} [1]`)) {
      return { ok: false, detail: "the Citation isn't [1] in the text", exported: result.data };
    }
    if (
      shown.split(`${ADDED} [1]`).length !== 3 ||
      shown.slice(shown.lastIndexOf("References")).includes("[2]")
    ) {
      return {
        ok: false,
        detail: "the same Citation again isn't [1] too, with its source listed once",
        exported: result.data,
      };
    }
    if (!shown.includes("References") || !shown.endsWith("Round-trip check source")) {
      return { ok: false, detail: "the list isn't at the end", exported: result.data };
    }
    const noted = [...exported].some(
      ([name, data]) =>
        /^word\/footnotes\d*\.xml$/.test(name) && new TextDecoder().decode(data).includes(SOURCE),
    );
    if (noted) {
      return { ok: false, detail: "the Citation is also a footnote", exported: result.data };
    }
    return {
      ok: true,
      detail: "the Citation is [1], and its source is listed at the end",
      exported: result.data,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `export failed: ${error instanceof Error ? error.message : error}`,
    };
  } finally {
    doc.destroy();
  }
}

/**
 * Edits of every kind the export writes, on one file: a paragraph deleted, a
 * word made bold, a link added, a heading's level changed, a list item and a
 * table row added, a paragraph moved, and a new list and table at the end.
 * The export must pass the package checks, lose nothing but what was deleted,
 * and import again with the new text.
 */
export async function checkEdits(bytes: Uint8Array): Promise<ExportCheck> {
  let doc: Y.Doc;
  try {
    doc = await mindOf(bytes);
  } catch (error) {
    if (error instanceof WordRefusedError && REFUSED.has(error.reason)) {
      return { ok: true, detail: `refused, as it should be: ${error.reason}` };
    }
    return {
      ok: false,
      detail: `didn't import: ${error instanceof Error ? error.message : error}`,
    };
  }
  try {
    editEveryKind(doc);
    const result = await exportOf(bytes, doc);
    const before = new Set((await inspectPackage(bytes)).problems);
    const problems = (await inspectPackage(result.data)).problems.filter(
      (each) => !before.has(each),
    );
    if (problems.length > 0)
      return {
        ok: false,
        detail: `the export: ${problems.slice(0, 2).join("; ")}`,
        exported: result.data,
      };
    const lost = result.report.notKept.filter(
      (each) => each.kind !== "comment" && each.kind !== "change",
    );
    if (lost.length > 0)
      return {
        ok: false,
        detail: `reported as not kept: ${lost.map((each) => `${each.kind} "${each.text}"`).join(", ")}`,
        exported: result.data,
      };
    const again = await readWordStructure(
      await openWordPackage(result.data),
      await reviewOf(await openWordPackage(result.data)),
    );
    const text = JSON.stringify(again.blocks.map((block) => [...textsOf(block)].join("")));
    for (const expected of ["A new list.", "New", "Table"]) {
      if (!text.includes(expected))
        return { ok: false, detail: `"${expected}" doesn't import again`, exported: result.data };
    }
    return { ok: true, detail: "edits of every kind written", exported: result.data };
  } catch (error) {
    return {
      ok: false,
      detail: `export failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
    };
  } finally {
    doc.destroy();
  }
}

/** Who the User's tracked edits are by, and when changes still waiting were asked for. */
const REVIEWER = "Round-trip Reviewer";
const ASKED = "2026-10-12T14:30:00.000Z";
const REQUEST = "round-trip";
const PROPOSED = "proposed";
const AI_TEXT = "A paragraph the AI wrote for the round-trip check.";
const PROPOSED_PARAGRAPH = "A paragraph a change adds.";
const NOT_FOUND = "A quote the check didn't find.";

/** What a review export is asked to say: the User's edits tracked, and every comment. */
const REVIEWED: ReviewChoices = {
  trackAs: REVIEWER,
  markAiText: true,
  commentFailedChecks: true,
  now: PLAIN.now,
};

/**
 * Changes still waiting, AI text and a Citation whose quote wasn't found: a
 * word of the first paragraph that has one replaced by a change, a paragraph a
 * change adds and one it removes, and an AI paragraph with the Citation.
 */
function editForReview(doc: Y.Doc): void {
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  recordProposalRequest(doc, REQUEST, {
    source: "edit-with-ai",
    providerId: "eval",
    modelId: "eval",
    createdAt: ASKED,
  });
  const change = (id: string) => ({ id, request: REQUEST });
  const top = () =>
    blocks.toArray().filter((each): each is Y.XmlElement => each instanceof Y.XmlElement);
  doc.transact(() => {
    const replaced = top().find(
      (each) =>
        each.nodeName === "paragraph" &&
        each
          .toArray()
          .some((text) => text instanceof Y.XmlText && /\p{L}{5,}/u.test(text.toString())),
    );
    const text = replaced
      ?.toArray()
      .find(
        (each): each is Y.XmlText =>
          each instanceof Y.XmlText && /\p{L}{5,}/u.test(each.toString()),
      );
    const word = text && /\p{L}{5,}/u.exec(text.toString());
    if (text && word) {
      text.format(word.index, word[0].length, { proposalDelete: change("c1") });
      text.insert(word.index + word[0].length, PROPOSED, {
        proposalInsert: change("c1"),
        generated: {},
      });
    }
    const removed = top()
      .filter((each) => each.nodeName === "paragraph")
      .at(-1);
    if (removed && removed !== replaced) {
      removed.setAttribute("proposal", { ...change("c2"), kind: "delete" } as never);
    }
    blocks.push([
      createElement({
        type: "paragraph",
        attrs: { proposal: { ...change("c3"), kind: "insert" } },
        content: [{ type: "text", text: PROPOSED_PARAGRAPH, marks: [{ type: "generated" }] }],
      }),
      createElement({
        type: "paragraph",
        content: [
          { type: "text", text: `${AI_TEXT} `, marks: [{ type: "generated" }] },
          {
            type: "citation",
            attrs: {
              passageId: "round-trip",
              documentId: "round-trip",
              documentName: "Round-trip check source",
              quote: NOT_FOUND,
              check: "not-found",
            },
          },
        ],
      }),
    ]);
  });
}

/** The paragraphs the Mind's text is with every change accepted, as a Word export without review writes it. */
async function acceptedInMind(bytes: Uint8Array, doc: Y.Doc): Promise<string[]> {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    copy.transact(() =>
      resolveProposals(copy.getXmlFragment(MIND_CONTENT_FIELD), () => true, "accept"),
    );
    const { data } = await exportOf(bytes, copy);
    const pkg = await openWordPackage(data);
    return acceptedParagraphs((await pkg.zip.readText(pkg.part)) ?? "");
  } finally {
    copy.destroy();
  }
}

/** Every comment range has its end, its mark and its comment, and every comment of IncarnaMind's its range. */
function commentsProblem(main: string, comments: string): string | null {
  const ids = (pattern: RegExp, xml: string) =>
    new Set([...xml.matchAll(pattern)].map((m) => m[1]));
  const starts = ids(/<w:commentRangeStart w:id="(\d+)"/g, main);
  const ends = ids(/<w:commentRangeEnd w:id="(\d+)"/g, main);
  const marks = ids(/<w:commentReference w:id="(\d+)"/g, main);
  const written = ids(/<w:comment\b[^>]*\sw:id="(\d+)"/g, comments);
  const ours = ids(/<w:comment\b(?=[^>]*\sw:author="IncarnaMind")[^>]*\sw:id="(\d+)"/g, comments);
  for (const id of starts) {
    if (!ends.has(id) || !marks.has(id)) return `comment ${id} has no end or mark`;
    if (!written.has(id)) return `comment ${id} isn't in the comments part`;
  }
  for (const id of ours) if (!starts.has(id)) return `IncarnaMind's comment ${id} has no range`;
  return null;
}

/** The text a review export shows with every change accepted: what LibreOffice should show too. */
export interface ReviewCheck extends ExportCheck {
  accepted?: string[];
}

/**
 * The edits of every kind, as the User's tracked edits, with changes still
 * waiting, AI text and a failed check, exported for review (#107): the
 * package passes the checks Word's repair prompt is about, every comment is
 * whole, and accepting every change gives the text accepting every change in
 * the Mind does.
 */
export async function checkReview(bytes: Uint8Array): Promise<ReviewCheck> {
  let doc: Y.Doc;
  try {
    doc = await mindOf(bytes);
  } catch (error) {
    if (error instanceof WordRefusedError && REFUSED.has(error.reason)) {
      return { ok: true, detail: `refused, as it should be: ${error.reason}` };
    }
    return {
      ok: false,
      detail: `didn't import: ${error instanceof Error ? error.message : error}`,
    };
  }
  try {
    editEveryKind(doc);
    editForReview(doc);
    const result = await exportOf(bytes, doc, REVIEWED);
    const before = new Set((await inspectPackage(bytes)).problems);
    const problems = (await inspectPackage(result.data)).problems.filter(
      (each) => !before.has(each),
    );
    if (problems.length > 0)
      return {
        ok: false,
        detail: `the export: ${problems.slice(0, 2).join("; ")}`,
        exported: result.data,
      };
    const lost = result.report.notKept.filter(
      (each) => each.kind !== "edit" && each.kind !== "signature",
    );
    if (lost.length > 0)
      return {
        ok: false,
        detail: `reported as not kept: ${lost.map((each) => `${each.kind} "${each.text}"`).join(", ")}`,
        exported: result.data,
      };
    const pkg = await openWordPackage(result.data);
    const main = (await pkg.zip.readText(pkg.part)) ?? "";
    const comments = [...pkg.zip.names()].find((name) => /^word\/comments\d*\.xml$/.test(name));
    const commentsXml = comments ? ((await pkg.zip.readText(comments)) ?? "") : "";
    const incomplete = commentsProblem(main, commentsXml);
    if (incomplete) return { ok: false, detail: incomplete, exported: result.data };
    const proposedByIncarnaMind = new RegExp(
      `<w:ins w:id="\\d+" w:author="IncarnaMind"[^>]*><w:r>(?:<w:rPr>(?:(?!</w:r>).)*?</w:rPr>)?<w:t[^>]*>${PROPOSED_PARAGRAPH}</w:t>`,
    );
    if (!proposedByIncarnaMind.test(main)) {
      return {
        ok: false,
        detail: "the paragraph a change adds isn't IncarnaMind's insertion",
        exported: result.data,
      };
    }
    if (!commentsXml.includes(NOT_FOUND) || !main.includes('w:author="IncarnaMind"')) {
      return {
        ok: false,
        detail: "IncarnaMind's comments or changes aren't in the file",
        exported: result.data,
      };
    }

    const shown = acceptedParagraphs(main).filter((line) => line.trim() !== "");
    const accepted = (await acceptedInMind(bytes, doc)).filter((line) => line.trim() !== "");
    const at = shown.findIndex((line, index) => line !== accepted[index]);
    if (at >= 0 || shown.length !== accepted.length) {
      const index = at >= 0 ? at : Math.min(shown.length, accepted.length);
      return {
        ok: false,
        detail: `accepting every change shows ${JSON.stringify(shown[index]?.slice(0, 60))} where the Mind has ${JSON.stringify(accepted[index]?.slice(0, 60))}`,
        exported: result.data,
      };
    }
    const changes = [...main.matchAll(/<w:(?:ins|del) w:id="\d+" w:author="([^"]+)"/g)];
    return {
      ok: true,
      detail: `${changes.filter((m) => m[1] === REVIEWER).length} of the User's changes and ${changes.filter((m) => m[1] === "IncarnaMind").length} of IncarnaMind's tracked, ${[...commentsXml.matchAll(/w:author="IncarnaMind"/g)].length} comments`,
      exported: result.data,
      accepted,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `export failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
    };
  } finally {
    doc.destroy();
  }
}

/** What a change still waiting does, by whom and when, and its text: "insert|author|date|text". */
type ChangeKey = string;

/** Someone's changes waiting in a Mind (#108), each part by its kind, as `ChangeKey`s, sorted. */
function changesInMind(doc: Y.Doc): ChangeKey[] {
  const parts = new Map<string, { request: string; kind: string; text: string }>();
  const add = (value: unknown, kind: string, text: string) => {
    const ref = readProposalRef(value);
    if (!ref?.id.startsWith(WORD_CHANGE_ID)) return;
    const key = `${ref.id}|${kind}`;
    const part = parts.get(key) ?? { request: ref.request, kind, text: "" };
    part.text += text;
    parts.set(key, part);
  };
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const each of parent.toArray()) {
      if (each instanceof Y.XmlText) {
        for (const run of each.toDelta() as {
          insert: unknown;
          attributes?: Record<string, unknown>;
        }[]) {
          const text = typeof run.insert === "string" ? run.insert : NODE_CHARACTER;
          add(run.attributes?.[PROPOSAL_INSERT_MARK], "insert", text);
          add(run.attributes?.[PROPOSAL_DELETE_MARK], "delete", text);
        }
      } else if (each instanceof Y.XmlElement) {
        const attribute = readProposalAttribute(each.getAttribute(PROPOSAL_ATTRIBUTE));
        if (attribute) add(attribute, attribute.kind, targetText(each));
        else visit(each);
      }
    }
  };
  visit(doc.getXmlFragment(MIND_CONTENT_FIELD));
  return [...parts.values()]
    .map((part) => {
      const made = proposalRequestOf(doc, part.request);
      const by = made?.source === "word-change" ? `${made.author}|${made.date}` : "?|?";
      return `${part.kind}|${by}|${part.text}`;
    })
    .sort();
}

/**
 * Someone's changes accepted and rejected (#108): of those a file has, in
 * order, every third accepted, the next rejected and the next left, exported
 * with the User's edits tracked. No change is out of date as imported; the
 * package passes the checks Word's repair prompt is about; nothing is reported
 * lost; nothing is tracked as the User's or IncarnaMind's; the changes left
 * import again as they were, with their author and date; and accepting every
 * change gives the text accepting every change in the Mind does.
 */
export async function checkTheirChanges(bytes: Uint8Array): Promise<ReviewCheck> {
  let doc: Y.Doc;
  try {
    doc = await mindOf(bytes);
  } catch (error) {
    if (error instanceof WordRefusedError && REFUSED.has(error.reason)) {
      return { ok: true, detail: `refused, as it should be: ${error.reason}` };
    }
    return {
      ok: false,
      detail: `didn't import: ${error instanceof Error ? error.message : error}`,
    };
  }
  try {
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    const theirs = pendingProposals(blocks).filter((each) => each.id.startsWith(WORD_CHANGE_ID));
    if (theirs.length === 0) return { ok: true, detail: "no changes of someone's to resolve" };
    const stale = [...outOfDateProposals(blocks)].filter((id) => id.startsWith(WORD_CHANGE_ID));
    if (stale.length > 0) return { ok: false, detail: `${stale.length} out of date as imported` };
    const outcome = (index: number) => (["accept", "reject", null] as const)[index % 3];
    const order = new Map(theirs.map((each, index) => [each.id, index]));
    doc.transact(() => {
      for (const kind of ["accept", "reject"] as const) {
        resolveProposals(blocks, (each) => outcome(order.get(each.id) ?? 2) === kind, kind);
      }
    });
    const left = changesInMind(doc);

    const result = await exportOf(bytes, doc, REVIEWED);
    const before = new Set((await inspectPackage(bytes)).problems);
    const problems = (await inspectPackage(result.data)).problems.filter(
      (each) => !before.has(each),
    );
    if (problems.length > 0)
      return {
        ok: false,
        detail: `the export: ${problems.slice(0, 2).join("; ")}`,
        exported: result.data,
      };
    if (result.report.notKept.length > 0)
      return {
        ok: false,
        detail: `reported as not kept: ${result.report.notKept.map((each) => each.kind).join(", ")}`,
        exported: result.data,
      };
    const pkg = await openWordPackage(result.data);
    const main = (await pkg.zip.readText(pkg.part)) ?? "";
    for (const author of [REVIEWER, "IncarnaMind"]) {
      if (main.includes(`w:author="${author}"`))
        return { ok: false, detail: `a change is tracked as ${author}'s`, exported: result.data };
    }

    const again = await mindOf(result.data);
    try {
      const found = changesInMind(again);
      const missing = left.filter((each) => !found.includes(each));
      const extra = found.filter((each) => !left.includes(each));
      if (missing.length > 0 || extra.length > 0)
        return {
          ok: false,
          detail: `the changes left don't import again as they were: ${JSON.stringify((missing[0] ?? extra[0] ?? "").slice(0, 80))} ${missing.length > 0 ? "is missing" : "is new"}`,
          exported: result.data,
        };
    } finally {
      again.destroy();
    }

    const shown = acceptedParagraphs(main).filter((line) => line.trim() !== "");
    const accepted = (await acceptedInMind(bytes, doc)).filter((line) => line.trim() !== "");
    const at = shown.findIndex((line, index) => line !== accepted[index]);
    if (at >= 0 || shown.length !== accepted.length) {
      const index = at >= 0 ? at : Math.min(shown.length, accepted.length);
      return {
        ok: false,
        detail: `accepting every change shows ${JSON.stringify(shown[index]?.slice(0, 60))} where the Mind has ${JSON.stringify(accepted[index]?.slice(0, 60))}`,
        exported: result.data,
      };
    }
    return {
      ok: true,
      detail: `${theirs.length} changes, ${Math.ceil(theirs.length / 3)} accepted and ${Math.ceil((theirs.length - 1) / 3)} rejected; ${left.length} parts left as they were`,
      exported: result.data,
      accepted,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `export failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
    };
  } finally {
    doc.destroy();
  }
}
