/**
 * A person's edits on a drawn slide, written into the deck: a text shape's
 * paragraphs as typed, and a shape's position and size. Only what changed is
 * written. An edited run keeps its own properties and a paragraph its own, so
 * what they inherit from the layout, master and theme stays inherited; a
 * paragraph left as it was keeps its bytes, and so does the rest of the part.
 */
import {
  child,
  descendants,
  elements,
  local,
  textOf,
  walk,
  type XmlElement,
} from "../../documents/formats/xml";
import { PackagePartError } from "../packagePatch/package";
import {
  applySplices,
  parentsOf,
  type Splice,
  selfClosing,
  sliceOf,
  startOf,
} from "../packagePatch/text";
import { escapeXml } from "../wordml";
import { Deck, NAMESPACES } from "./deck";
import {
  type EditedParagraph,
  type EditedRun,
  joinedRuns,
  type RunSource,
  type ShapeBox,
  type ShapeEdit,
  type TextFit,
  writtenInPlace,
} from "./shapeEdit";
import { animatesParagraphs, shapesById } from "./shapes";

const EMU_PER_PX = 9525;
const PIECES = new Set(["r", "br", "fld"]);

const prefixOf = (element: XmlElement) =>
  element.name.includes(":") ? element.name.slice(0, element.name.indexOf(":") + 1) : "";

const piecesOf = (paragraph: XmlElement) =>
  elements(paragraph).filter((each) => PIECES.has(local(each.name)));

const textOfPiece = (piece: XmlElement) => {
  if (local(piece.name) === "br") return "\n";
  const t = child(piece, "t");
  return t ? t.children.filter((each) => typeof each === "string").join("") : "";
};

/** A piece's text set, in place: only its `a:t` changes. */
function textSplice(text: string, piece: XmlElement, value: string): Splice {
  const prefix = prefixOf(piece);
  const t = child(piece, "t");
  const written = `<${prefix}t>${escapeXml(value)}</${prefix}t>`;
  if (!t) {
    const rPr = child(piece, "rPr");
    const at = rPr ? (rPr.end ?? 0) : (piece.openEnd ?? 0);
    if (selfClosing(piece)) {
      const tag = sliceOf(text, piece).replace(/\s*\/>$/, ">");
      return { from: startOf(piece), to: piece.end ?? 0, text: `${tag}${written}</${piece.name}>` };
    }
    return { from: at, to: at, text: written };
  }
  if (selfClosing(t)) return { from: startOf(t), to: t.end ?? 0, text: written };
  return { from: t.openEnd ?? 0, to: (t.end ?? 0) - `</${t.name}>`.length, text: escapeXml(value) };
}

/** A piece of the slide's text with its own text set: a run's or field's `a:t`, the rest kept. */
function withText(text: string, piece: XmlElement, value: string): string {
  const from = startOf(piece);
  const splice = textSplice(text, piece, value);
  return applySplices(sliceOf(text, piece), [
    { ...splice, from: splice.from - from, to: splice.to - from },
  ]);
}

/**
 * The paragraph's own text with only its runs' text changed, or null when
 * the runs typed in are not its runs in their order. A run with no text, which
 * the page doesn't show, is kept as it is.
 */
function inPlace(
  text: string,
  paragraph: XmlElement,
  index: number,
  runs: readonly EditedRun[],
): string | null {
  const pieces = piecesOf(paragraph);
  if (!writtenInPlace(pieces.map(textOfPiece), index, runs)) return null;
  const shown = pieces.filter((piece) => textOfPiece(piece) !== "");
  const splices: Splice[] = [];
  for (const [place, piece] of shown.entries()) {
    const run = runs[place];
    if (run && local(piece.name) !== "br" && run.text !== textOfPiece(piece))
      splices.push(textSplice(text, piece, run.text));
  }
  const from = startOf(paragraph);
  return applySplices(
    sliceOf(text, paragraph),
    splices.map((each) => ({ ...each, from: each.from - from, to: each.to - from })),
  );
}

/** A run property element written as another of its kind: `a:endParaRPr` → `a:rPr`. */
function renamed(text: string, element: XmlElement, name: string): string {
  const prefix = prefixOf(element);
  const slice = sliceOf(text, element);
  const opened = slice.replace(new RegExp(`^<${element.name}`), `<${prefix}${name}`);
  return selfClosing(element)
    ? opened
    : opened.replace(new RegExp(`</${element.name}>$`), `</${prefix}${name}>`);
}

/** A paragraph written anew: the properties of the one it was, each run in its own run's. */
function rebuilt(
  text: string,
  like: XmlElement,
  runs: readonly EditedRun[],
  source: (at: RunSource | null) => XmlElement | undefined,
): string {
  const prefix = prefixOf(like);
  const pPr = child(like, "pPr");
  const end = child(like, "endParaRPr");
  const propertiesOf = (piece: XmlElement | undefined) => {
    const rPr = piece && child(piece, "rPr");
    return rPr ? sliceOf(text, rPr) : null;
  };
  // Text typed outside any run takes the formatting of the run before it, else after it, else the paragraph's end.
  const typedProperties = (at: number, previous: string | null) => {
    if (previous !== null) return previous;
    const following = runs.slice(at + 1).find((each) => each.source !== null && each.text !== "\n");
    const next = propertiesOf(source(following?.source ?? null));
    if (next !== null) return next;
    return end ? renamed(text, end, "rPr") : "";
  };
  const written: string[] = [];
  let previous: string | null = null;
  for (const [at, run] of runs.entries()) {
    const piece = source(run.source);
    if (run.text === "\n") {
      if (piece && local(piece.name) === "br") written.push(sliceOf(text, piece));
      else written.push(previous ? `<${prefix}br>${previous}</${prefix}br>` : `<${prefix}br/>`);
      continue;
    }
    // A field (a slide number, a date) stays a field: PowerPoint fills its text in again.
    if (piece && local(piece.name) === "fld") {
      written.push(withText(text, piece, run.text));
      previous = propertiesOf(piece);
      continue;
    }
    const rPr = piece ? (propertiesOf(piece) ?? "") : typedProperties(at, previous);
    written.push(`<${prefix}r>${rPr}<${prefix}t>${escapeXml(run.text)}</${prefix}t></${prefix}r>`);
    previous = rPr === "" ? null : rPr;
  }
  const properties = pPr ? sliceOf(text, pPr) : "";
  const ending = end ? sliceOf(text, end) : "";
  return `<${prefix}p>${properties}${written.join("")}${ending}</${prefix}p>`;
}

/**
 * Sets a text shape's paragraphs as they were edited, and how the shape
 * follows its text (`fit`). Refused when an animation builds the shape
 * paragraph by paragraph and the count changes: it would name paragraphs that
 * are gone, and PowerPoint repairs such a file.
 */
export async function setShapeRuns(
  deck: Deck,
  slidePart: string,
  shapeId: string,
  edited: readonly EditedParagraph[],
  fit?: TextFit,
): Promise<void> {
  const part = await deck.pkg.part(slidePart);
  if (!part) throw new PackagePartError(slidePart, "is missing.");
  const copies = shapesById(part.root, shapeId).filter((shape) => local(shape.name) === "sp");
  // The edit names runs of the copy the viewer drew: another copy whose words or runs differ
  // (a Choice that says more than its Fallback) can't take them, so neither is changed.
  /** Each paragraph's pieces in order: its runs' words, its line breaks and its fields. */
  const runsOf = (shape: XmlElement) =>
    descendants(shape, "a:p").map((paragraph) =>
      elements(paragraph).flatMap((piece) =>
        local(piece.name) === "br"
          ? ["br"]
          : local(piece.name) === "r" || local(piece.name) === "fld"
            ? [
                `${local(piece.name)}:${descendants(piece, "a:t")
                  .map((t) => textOf(t))
                  .join("")}`,
              ]
            : [],
      ),
    );
  const [one, ...others] = copies;
  if (
    one &&
    others.some((other) => JSON.stringify(runsOf(other)) !== JSON.stringify(runsOf(one)))
  ) {
    throw new PackagePartError(slidePart, `shape ${shapeId}'s copies don't hold the same runs.`);
  }
  const paragraphs = edited.length > 0 ? edited : [{ source: 0, runs: [] }];
  const parents = parentsOf(part.root);
  const splices = copies.flatMap((shape) => {
    const txBody = child(shape, "txBody");
    const existing = txBody ? elements(txBody).filter((each) => local(each.name) === "p") : [];
    if (!txBody || existing.length === 0) return [];
    if (paragraphs.length !== existing.length && animatesParagraphs(part.root, shapeId)) {
      throw new PackagePartError(
        slidePart,
        `shape ${shapeId} is animated by paragraph, so its ${existing.length} paragraphs can't become ${paragraphs.length}.`,
      );
    }
    const written = paragraphSplices(part.text, existing, paragraphs);
    if (fit?.kind === "grow") {
      const holder = child(shape, "spPr");
      if (holder) {
        // A fit sets the height alone: the box's place and width stay the file's, so a fit made
        // on a slide drawn before a move landed can't take the move back.
        const sized = inShapeSpace(fit.box, shape, parents);
        const own = child(holder, "xfrm");
        const off = own && child(own, "off");
        const ext = own && child(own, "ext");
        const wanted = {
          x: off?.attrs.x ?? sized.x,
          y: off?.attrs.y ?? sized.y,
          cx: ext?.attrs.cx ?? sized.cx,
          cy: sized.cy,
        };
        written.push(
          ...transformSplices(part.text, part.root, holder, "sp", wanted, () => {
            throw new PackagePartError(slidePart, `shape ${shapeId} has no transform.`);
          }),
        );
      }
    }
    if (fit?.kind === "shrink") written.push(...shrinkSplices(part.text, part.root, txBody, fit));
    return written;
  });
  if (splices.length === 0) throw new PackagePartError(slidePart, `has no text shape ${shapeId}.`);
  deck.pkg.set(slidePart, applySplices(part.text, splices));
}

/** A table's cell's paragraphs set as they were edited, in every copy of its frame. */
export async function setCellRuns(
  deck: Deck,
  slidePart: string,
  shapeId: string,
  row: number,
  column: number,
  edited: readonly EditedParagraph[],
): Promise<void> {
  const part = await deck.pkg.part(slidePart);
  if (!part) throw new PackagePartError(slidePart, "is missing.");
  const paragraphs = edited.length > 0 ? edited : [{ source: 0, runs: [] }];
  const splices = shapesById(part.root, shapeId)
    .filter((shape) => local(shape.name) === "graphicFrame")
    .flatMap((frame) => {
      const table = [...walk(frame)].find((each) => local(each.name) === "tbl");
      const tr = table && elements(table).filter((each) => local(each.name) === "tr")[row];
      const tc = tr && elements(tr).filter((each) => local(each.name) === "tc")[column];
      const txBody = tc && child(tc, "txBody");
      const existing = txBody ? elements(txBody).filter((each) => local(each.name) === "p") : [];
      return paragraphSplices(part.text, existing, paragraphs);
    });
  if (splices.length === 0) {
    throw new PackagePartError(slidePart, `has no cell ${row}.${column} in table ${shapeId}.`);
  }
  deck.pkg.set(slidePart, applySplices(part.text, splices));
}

const FULL = 100_000;

/**
 * A text body's shrink on overflow written as PowerPoint writes it: `a:normAutofit`'s font scale
 * and line spacing reduction, in thousandths of a percent, each left out at its default.
 */
function shrinkSplices(
  text: string,
  root: XmlElement,
  txBody: XmlElement,
  fit: Extract<TextFit, { kind: "shrink" }>,
): Splice[] {
  const bodyPr = child(txBody, "bodyPr");
  if (!bodyPr) return [];
  const scale = Math.round(fit.fontScale * FULL);
  const reduction = Math.round(fit.lineReduction * FULL);
  const values: Record<string, string | null> = {
    fontScale: scale >= FULL ? null : String(scale),
    lnSpcReduction: reduction <= 0 ? null : String(reduction),
  };
  const own = child(bodyPr, "normAutofit");
  if (own) {
    const changed = Object.fromEntries(
      Object.entries(values).filter(([name, value]) => (own.attrs[name] ?? null) !== value),
    );
    if (Object.keys(changed).length === 0) return [];
    const end = selfClosing(own) ? (own.end ?? 0) : (own.openEnd ?? 0);
    return [{ from: startOf(own), to: end, text: withAttributes(text, own, changed) }];
  }
  // The shape takes its shrink from its layout: it gets its own, in the place the schema gives it.
  const a = drawingPrefix(root);
  const attributes = Object.entries(values)
    .flatMap(([name, value]) => (value === null ? [] : [` ${name}="${value}"`]))
    .join("");
  const written = `<${a}:normAutofit${attributes}/>`;
  // noAutofit, spAutoFit and normAutofit are one choice in the schema: the shrink takes its place.
  const other = elements(bodyPr).find((each) =>
    ["noAutofit", "spAutoFit"].includes(local(each.name)),
  );
  if (other) {
    return [{ from: startOf(other), to: other.end ?? 0, text: written }];
  }
  if (selfClosing(bodyPr)) {
    const tag = sliceOf(text, bodyPr).replace(/\s*\/>$/, ">");
    return [
      { from: startOf(bodyPr), to: bodyPr.end ?? 0, text: `${tag}${written}</${bodyPr.name}>` },
    ];
  }
  const warp = child(bodyPr, "prstTxWarp");
  const at = warp ? (warp.end ?? 0) : (bodyPr.openEnd ?? 0);
  return [{ from: at, to: at, text: written }];
}

/** The splices that write a text body's paragraphs as edited, each left as it was kept byte for byte. */
function paragraphSplices(
  text: string,
  existing: readonly XmlElement[],
  paragraphs: readonly EditedParagraph[],
): Splice[] {
  const first = existing[0];
  const last = existing.at(-1);
  if (!first || !last) return [];
  const source = (at: RunSource | null) =>
    at ? piecesOf(existing[at.paragraph] ?? first)[at.run] : undefined;
  const used = new Set<number>();
  let like = first;
  const written = paragraphs.map((paragraph) => {
    const runs = joinedRuns(paragraph.runs);
    const own = paragraph.source !== null ? existing[paragraph.source] : undefined;
    if (own) like = own;
    if (own && paragraph.source !== null && !used.has(paragraph.source)) {
      used.add(paragraph.source);
      const kept = inPlace(text, own, paragraph.source, runs);
      if (kept !== null) return kept;
    }
    return rebuilt(text, like, runs, source);
  });
  const sameParagraphs =
    paragraphs.length === existing.length &&
    paragraphs.every((paragraph, index) => paragraph.source === index);
  return sameParagraphs
    ? existing.map((paragraph, index) => ({
        from: startOf(paragraph),
        to: paragraph.end ?? 0,
        text: written[index] ?? "",
      }))
    : [{ from: startOf(first), to: last.end ?? 0, text: written.join("") }];
}

/** An element's start tag with these attributes set (or, null, taken out), the others as they were. */
function withAttributes(
  text: string,
  element: XmlElement,
  values: Record<string, string | null>,
): string {
  let tag = sliceOf(text, element);
  if (!selfClosing(element)) tag = text.slice(startOf(element), element.openEnd ?? 0);
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`);
    if (value === null) tag = tag.replace(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`), "");
    else if (pattern.test(tag)) tag = tag.replace(pattern, `$1"${value}"`);
    else tag = tag.replace(/(\s*\/?>)$/, ` ${name}="${value}"$1`);
  }
  return tag;
}

/** The prefix the part binds to DrawingML, "a" in every deck PowerPoint writes. */
function drawingPrefix(root: XmlElement): string {
  const declared = Object.entries(root.attrs).find(
    ([name, value]) => name.startsWith("xmlns:") && value === NAMESPACES.a,
  );
  return declared ? declared[0].slice("xmlns:".length) : "a";
}

interface Transform {
  x: string;
  y: string;
  cx: string;
  cy: string;
}

const numberOf = (element: XmlElement | undefined, name: string, fallback: number) => {
  const value = Number(element?.attrs[name]);
  return Number.isFinite(value) ? value : fallback;
};

/**
 * A box on the slide as the shape's own transform says it: through each group around the shape,
 * outermost first, from the group's place on its parent into its child space (`a:chOff`,
 * `a:chExt`), as PowerPoint places a group's shapes.
 */
function inShapeSpace(
  box: ShapeBox,
  shape: XmlElement,
  parents: ReadonlyMap<XmlElement, XmlElement>,
): Transform {
  const groups: XmlElement[] = [];
  for (let at = parents.get(shape); at; at = parents.get(at)) {
    if (local(at.name) === "grpSp") groups.unshift(at);
  }
  let x = box.x * EMU_PER_PX;
  let y = box.y * EMU_PER_PX;
  let w = box.w * EMU_PER_PX;
  let h = box.h * EMU_PER_PX;
  for (const group of groups) {
    const grpSpPr = child(group, "grpSpPr");
    const xfrm = grpSpPr && child(grpSpPr, "xfrm");
    const off = xfrm && child(xfrm, "off");
    const ext = xfrm && child(xfrm, "ext");
    if (!off || !ext) continue;
    const chOff = xfrm && child(xfrm, "chOff");
    const chExt = xfrm && child(xfrm, "chExt");
    const width = numberOf(ext, "cx", 0);
    const height = numberOf(ext, "cy", 0);
    const sx = width > 0 ? numberOf(chExt, "cx", width) / width : 1;
    const sy = height > 0 ? numberOf(chExt, "cy", height) / height : 1;
    x = numberOf(chOff, "x", numberOf(off, "x", 0)) + (x - numberOf(off, "x", 0)) * sx;
    y = numberOf(chOff, "y", numberOf(off, "y", 0)) + (y - numberOf(off, "y", 0)) * sy;
    w *= sx;
    h *= sy;
  }
  const emu = (value: number) => String(Math.round(value));
  return { x: emu(x), y: emu(y), cx: emu(w), cy: emu(h) };
}

/**
 * Moves or sizes a shape: only the offset or extent that changed is written,
 * in its own transform (a frame's `p:xfrm`, a group's, a shape's or
 * picture's), its rotation, flips and a group's child space kept. A shape in
 * a group is placed in the group's child space. A placeholder that takes its
 * place from its layout gets a transform of its own, as PowerPoint gives it one.
 */
export async function setShapeBox(
  deck: Deck,
  slidePart: string,
  shapeId: string,
  box: ShapeBox,
): Promise<void> {
  const part = await deck.pkg.part(slidePart);
  if (!part) throw new PackagePartError(slidePart, "is missing.");
  const copies = shapesById(part.root, shapeId);
  if (copies.length === 0) throw new PackagePartError(slidePart, `has no shape ${shapeId}.`);
  const parents = parentsOf(part.root);
  const splices = copies.flatMap((shape) => {
    const kind = local(shape.name);
    const holder =
      kind === "graphicFrame" ? shape : child(shape, kind === "grpSp" ? "grpSpPr" : "spPr");
    if (!holder) throw new PackagePartError(slidePart, `shape ${shapeId} has no properties.`);
    return transformSplices(
      part.text,
      part.root,
      holder,
      kind,
      inShapeSpace(box, shape, parents),
      () => {
        throw new PackagePartError(slidePart, `shape ${shapeId} has no transform to write into.`);
      },
    );
  });
  if (splices.length > 0) deck.pkg.set(slidePart, applySplices(part.text, splices));
}

function transformSplices(
  text: string,
  root: XmlElement,
  holder: XmlElement,
  kind: string,
  wanted: Transform,
  missing: () => never,
): Splice[] {
  const xfrm = child(holder, "xfrm");
  const off = xfrm && child(xfrm, "off");
  const ext = xfrm && child(xfrm, "ext");
  if (xfrm && off && ext) {
    const splices: Splice[] = [];
    for (const [element, names] of [
      [off, ["x", "y"]],
      [ext, ["cx", "cy"]],
    ] as const) {
      const changed = Object.fromEntries(
        names
          .filter((name) => element.attrs[name] !== wanted[name])
          .map((name) => [name, wanted[name]]),
      );
      if (Object.keys(changed).length === 0) continue;
      const end = selfClosing(element) ? (element.end ?? 0) : (element.openEnd ?? 0);
      splices.push({
        from: startOf(element),
        to: end,
        text: withAttributes(text, element, changed),
      });
    }
    return splices;
  }
  if (kind === "graphicFrame" || kind === "grpSp") return missing();
  const a = drawingPrefix(root);
  const written = `<${a}:xfrm><${a}:off x="${wanted.x}" y="${wanted.y}"/><${a}:ext cx="${wanted.cx}" cy="${wanted.cy}"/></${a}:xfrm>`;
  if (xfrm) return [{ from: startOf(xfrm), to: xfrm.end ?? 0, text: written }];
  if (selfClosing(holder)) {
    const tag = sliceOf(text, holder).replace(/\s*\/>$/, ">");
    return [
      { from: startOf(holder), to: holder.end ?? 0, text: `${tag}${written}</${holder.name}>` },
    ];
  }
  // The transform is the first of a shape's properties.
  const at = holder.openEnd ?? 0;
  return [{ from: at, to: at, text: written }];
}

/** The deck with the edits made, in order; slides are named by their number as shown. */
export async function applyShapeEdits(
  bytes: Uint8Array,
  edits: readonly ShapeEdit[],
): Promise<Uint8Array> {
  const deck = Deck.open(bytes);
  const slides = await deck.slides();
  for (const edit of edits) {
    const slide = slides.find((each) => each.number === edit.slide);
    if (!slide)
      throw new PackagePartError(await deck.presentationPart(), `has no slide ${edit.slide}.`);
    if (edit.kind === "text") {
      await setShapeRuns(deck, slide.part, edit.shape, edit.paragraphs, edit.fit);
    } else if (edit.kind === "cell") {
      await setCellRuns(deck, slide.part, edit.shape, edit.row, edit.column, edit.paragraphs);
    } else {
      await setShapeBox(deck, slide.part, edit.shape, edit.box);
    }
  }
  return deck.save();
}
