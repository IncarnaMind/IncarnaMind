/**
 * What a saved copy did to the deck it came from, measured the same way for
 * every arm: which parts kept their bytes, which changed and what they
 * lost, where on an edited slide the bytes changed, whether our own reader
 * reads the copy back with the edit in it, and whether the package holds
 * together (well-formed XML, every relationship's target there).
 */
import { DOMParser } from "@xmldom/xmldom";
import { extractPptx } from "../../src/core/documents/formats/pptx";
import { drawPptx } from "../../src/core/documents/formats/pptxDrawing";
import {
  descendants,
  elements,
  local,
  parseXml,
  walk,
  type XmlElement,
} from "../../src/core/documents/formats/xml";
import { openPackage, resolvePart, type ZipArchive } from "../../src/core/documents/formats/zip";
import { shapesById } from "../../src/core/exports/pptxPatch/shapes";
import type { BoxTarget, DeckTargets, TextTarget } from "./targets";

/** A save with no edit, the text or box edits, or a save with no edit through a rebuild of the deck. */
export type Kind = "noedit" | "text" | "box" | "rebuild";

export interface CopyReport {
  kind: Kind;
  /** The whole file, byte for byte. */
  fileIdentical: boolean;
  /** Every part there, in the same order, with the same stored bytes. */
  partsIdentical: boolean;
  /** Parts whose content (inflated) differs. */
  changed: string[];
  /** Parts whose content is the same but stored differently (recompressed). */
  restored: number;
  missing: string[];
  added: string[];
  /** ZIP entries for folders (names ending "/"), which hold no part, dropped from the copy. */
  foldersDropped: number;
  /** For each changed XML part, the elements it has fewer of, by name and count. */
  dropped: Record<string, Record<string, number>>;
  /** Parts changed that no edit named: not the edited slides. */
  changedOutsideEdited: string[];
  /** Edited slides whose bytes changed outside the edited shapes. */
  slidesChangedOutsideShape: number[];
  /** The same, not counting the line break after the XML declaration. */
  slidesChangedOutsideShapeBeyondDeclaration: number[];
  /** Our reader: the copy's slide count and whether every edit reads back. */
  readBack: {
    slides: number;
    sameCount: boolean;
    editsFound: number;
    editsExpected: number;
    error: string | null;
  };
  /** Parts written that aren't well-formed XML, with the first problem. */
  malformed: string[];
  /** Relationships pointing at parts the copy doesn't have, beyond those the original already had. */
  danglingAdded: string[];
}

const sameStored = (a: ZipArchive, b: ZipArchive, name: string) => {
  const x = a.raw(name);
  const y = b.raw(name);
  return (
    x !== undefined &&
    y !== undefined &&
    x.crc32 === y.crc32 &&
    x.size === y.size &&
    x.method === y.method &&
    Buffer.from(x.data).equals(Buffer.from(y.data))
  );
};

const isXml = (name: string) => /\.(xml|rels)$/i.test(name);

function counts(root: XmlElement): Map<string, number> {
  const out = new Map<string, number>();
  out.set(root.name, 1);
  for (const element of walk(root)) out.set(element.name, (out.get(element.name) ?? 0) + 1);
  return out;
}

function droppedElements(before: string, after: string): Record<string, number> {
  const was = counts(parseXml(before));
  const now = counts(parseXml(after));
  const lost: Record<string, number> = {};
  for (const [name, count] of was) {
    const left = now.get(name) ?? 0;
    if (left < count) lost[name] = count - left;
  }
  return lost;
}

function wellFormed(text: string): string | null {
  const problems: string[] = [];
  try {
    new DOMParser({ onError: (_level, message) => problems.push(String(message)) }).parseFromString(
      text.replace(/^﻿/, ""),
      "text/xml",
    );
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems[0] ?? null;
}

async function dangling(zip: ZipArchive): Promise<Set<string>> {
  const out = new Set<string>();
  for (const name of zip.names()) {
    if (!name.endsWith(".rels")) continue;
    const text = await zip.readText(name);
    if (!text) continue;
    const owner = name.replace(/_rels\/([^/]+)\.rels$/, "$1");
    let root: XmlElement;
    try {
      root = parseXml(text);
    } catch {
      out.add(`${name}: unreadable`);
      continue;
    }
    for (const rel of descendants(root, "Relationship")) {
      if (rel.attrs.TargetMode === "External" || rel.attrs.Target === undefined) continue;
      const target = resolvePart(owner === name ? "" : owner, rel.attrs.Target);
      if (!zip.has(target)) out.add(`${name} → ${target}`);
    }
  }
  return out;
}

/** The offsets of the elements an edit may change on its slide, in every copy of the shape: its text body, or its transform's holder. */
function editedRegions(
  xml: string,
  shapeIds: readonly string[],
  kind: Kind,
): { from: number; to: number }[] {
  const root = parseXml(xml);
  return shapeIds
    .flatMap((id) => shapesById(root, id))
    .flatMap((shape) => {
      const inside = elements(shape);
      const region =
        kind === "text"
          ? inside.find((each) => local(each.name) === "txBody")
          : local(shape.name) === "graphicFrame"
            ? inside.find((each) => local(each.name) === "xfrm")
            : inside.find((each) => ["spPr", "grpSpPr"].includes(local(each.name)));
      return region ? [{ from: region.start ?? 0, to: region.end ?? 0 }] : [];
    })
    .sort((a, b) => a.from - b.from);
}

/** The text with those regions cut out. */
const without = (text: string, regions: readonly { from: number; to: number }[]) => {
  let out = "";
  let at = 0;
  for (const region of regions) {
    out += text.slice(at, region.from);
    at = region.to;
  }
  return out + text.slice(at);
};

const squash = (text: string) => text.replace(/\s+/g, "");

export async function compareCopy(
  original: Uint8Array,
  copy: Uint8Array,
  kind: Kind,
  targets: DeckTargets,
  /** How far a moved or sized shape may land from where it was asked to, CSS pixels: a drag lands on whole screen pixels. */
  tolerance = 1,
): Promise<CopyReport> {
  const before = openPackage(original);
  const after = openPackage(copy);
  const isFolder = (name: string) => name.endsWith("/");
  const names = before.names().filter((name) => !isFolder(name));
  const changed: string[] = [];
  let restored = 0;
  const dropped: Record<string, Record<string, number>> = {};
  const malformed: string[] = [];
  for (const name of names) {
    if (!after.has(name)) continue;
    if (sameStored(before, after, name)) continue;
    const a = await before.read(name);
    const b = await after.read(name);
    if (a && b && Buffer.from(a).equals(Buffer.from(b))) {
      restored++;
      continue;
    }
    changed.push(name);
    if (isXml(name)) {
      const was = (await before.readText(name)) ?? "";
      const now = (await after.readText(name)) ?? "";
      try {
        const lost = droppedElements(was, now);
        if (Object.keys(lost).length > 0) dropped[name] = lost;
      } catch {
        // A part our reader can't parse is counted as malformed below.
      }
    }
  }
  const missing = names.filter((name) => !after.has(name));
  const added = after.names().filter((name) => !before.has(name) && !isFolder(name));
  const foldersDropped = before.names().filter((name) => isFolder(name) && !after.has(name)).length;
  for (const name of [...changed, ...added]) {
    if (!isXml(name)) continue;
    const problem = wellFormed((await after.readText(name)) ?? "");
    if (problem) malformed.push(`${name}: ${problem.slice(0, 160)}`);
  }

  const edits: (TextTarget | BoxTarget)[] =
    kind === "text" ? targets.text : kind === "box" ? targets.box : [];
  const editedParts = new Set(edits.map((each) => each.slidePart));
  const changedOutsideEdited = [...changed, ...missing].filter((name) => !editedParts.has(name));
  const slidesChangedOutsideShape: number[] = [];
  const slidesChangedOutsideShapeBeyondDeclaration: number[] = [];
  const declaration = /^\uFEFF?<\?xml[^>]*\?>\s*/;
  for (const part of editedParts) {
    const was = (await before.readText(part)) ?? "";
    const now = (await after.readText(part)) ?? "";
    if (was === now) continue;
    const ids = edits.filter((each) => each.slidePart === part).map((each) => each.shapeId);
    const slide = edits.find((each) => each.slidePart === part)?.slide ?? 0;
    const outside = (a: string, b: string) => {
      try {
        return without(a, editedRegions(a, ids, kind)) !== without(b, editedRegions(b, ids, kind));
      } catch {
        return true;
      }
    };
    if (outside(was, now)) slidesChangedOutsideShape.push(slide);
    if (outside(was.replace(declaration, ""), now.replace(declaration, ""))) {
      slidesChangedOutsideShapeBeyondDeclaration.push(slide);
    }
  }

  const readBack: CopyReport["readBack"] = {
    slides: 0,
    sameCount: false,
    editsFound: 0,
    editsExpected: edits.length,
    error: null,
  };
  try {
    const was = await extractPptx(original);
    const now = await extractPptx(copy);
    readBack.slides = now.slides.length;
    readBack.sameCount = was.slides.length === now.slides.length;
    if (kind === "text") {
      for (const target of targets.text) {
        const slide = now.slides.find((each) => each.number === target.slide);
        const texts = [slide?.title ?? "", ...(slide?.blocks.flat() ?? [])].map(squash);
        if (texts.some((each) => each.includes(squash(target.after)))) readBack.editsFound++;
      }
    } else if (kind === "box") {
      const drawing = await drawPptx(copy);
      for (const target of targets.box) {
        const slide = drawing.slides.find((each) => each.number === target.slide);
        const item =
          slide && "items" in slide
            ? slide.items.find((each) => each.shapeId === target.shapeId)
            : undefined;
        const near = (px: number | undefined, emu: number) =>
          px !== undefined && Math.abs(px * 9525 - emu) <= tolerance * 9525;
        if (
          item &&
          near(item.box.x, target.to.x) &&
          near(item.box.y, target.to.y) &&
          near(item.box.w, target.to.w) &&
          near(item.box.h, target.to.h)
        ) {
          readBack.editsFound++;
        }
      }
    }
  } catch (error) {
    readBack.error = error instanceof Error ? error.message : String(error);
  }

  const already = await dangling(before);
  const danglingAdded = [...(await dangling(after))].filter((each) => !already.has(each));
  const partsIdentical =
    changed.length === 0 &&
    restored === 0 &&
    missing.length === 0 &&
    added.length === 0 &&
    after
      .names()
      .filter((name) => !isFolder(name))
      .join("\n") === names.join("\n");
  return {
    kind,
    fileIdentical: Buffer.from(original).equals(Buffer.from(copy)),
    partsIdentical,
    changed,
    restored,
    missing,
    added,
    foldersDropped,
    dropped,
    changedOutsideEdited,
    slidesChangedOutsideShape,
    slidesChangedOutsideShapeBeyondDeclaration,
    readBack,
    malformed,
    danglingAdded,
  };
}
