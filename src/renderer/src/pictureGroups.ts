import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MouseEvent, PointerEvent } from "react";
import { ANSWER_BLOCK, PICTURE_NODE } from "../../core/api";

/**
 * The pictures the picture viewer steps through (#2377), worked out from a
 * Note's or an Answer's document, and the file name Save picture… gives one.
 * Pure: no store, no DOM.
 */

/** A picture the viewer shows, and where it is. */
export interface ViewerPicture {
  /** The picture itself: the `data:` URL it is kept as, or the address a Document reads it by. */
  src: string;
  /** The caption or description it carries, when it says something. */
  description: string;
  /** Where it is in a Document, in a Citation's words ("figure 2", "slide 4"); null outside one. */
  place: string | null;
}

/** What the pictures belong to, which decides how the bar names each one. */
export type PictureGroup =
  | { kind: "answer" }
  | { kind: "note" }
  | { kind: "document"; name: string };

export interface PictureViewerTarget {
  group: PictureGroup;
  pictures: readonly ViewerPicture[];
  index: number;
  /** The picture element it grows out of, and puts the focus back on when it closes. */
  source: HTMLElement | null;
}

/** A picture in an editor's document, with the position it sits at. */
interface PlacedPicture {
  pos: number;
  picture: ViewerPicture;
}

const picturesIn = (parent: ProseMirrorNode, contentPos: number): PlacedPicture[] => {
  const found: PlacedPicture[] = [];
  parent.forEach((node, offset) => {
    if (node.type.name !== PICTURE_NODE) return;
    found.push({
      pos: contentPos + offset,
      picture: {
        src: typeof node.attrs.src === "string" ? node.attrs.src : "",
        description: typeof node.attrs.alt === "string" ? node.attrs.alt : "",
        place: null,
      },
    });
  });
  return found;
};

export interface PicturesAt {
  kind: "answer" | "note";
  pictures: ViewerPicture[];
  index: number;
}

/** Whether the position sits inside an Answer, whose pictures open on a press rather than a Note's. */
export function inAnswerAt(doc: ProseMirrorNode, pos: number): boolean {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  for (let depth = $pos.depth; depth >= 1; depth--) {
    if ($pos.node(depth).type.name === ANSWER_BLOCK) return true;
  }
  return false;
}

/**
 * The pictures the picture at `pos` belongs to: the Answer's when it is inside
 * one, else the Note's own. `surface` says it is in an Answer's editor, which
 * holds that Answer's Blocks alone. Null when no picture is exactly there.
 */
export function picturesAt(
  doc: ProseMirrorNode,
  pos: number,
  surface: "answer" | null = null,
): PicturesAt | null {
  const at = (found: PlacedPicture[], kind: "answer" | "note"): PicturesAt | null => {
    const index = found.findIndex((each) => each.pos === pos);
    if (index < 0 || found[index]?.picture.src === "") return null;
    return { kind, pictures: found.map((each) => each.picture), index };
  };
  if (surface === null) {
    const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
    for (let depth = $pos.depth; depth >= 1; depth--) {
      if ($pos.node(depth).type.name !== ANSWER_BLOCK) continue;
      return at(picturesIn($pos.node(depth), $pos.before(depth) + 1), "answer");
    }
  }
  return at(picturesIn(doc, 0), surface ?? "note");
}

const PICTURE_SELECTOR = "img[data-picture-viewer]";

/** How far a press may move and still count as a click on the picture, in pixels. */
const DRAG = 4;

/**
 * A click on a picture in an Answer or a Document opens it; a drag is left
 * alone, so a drag over it still selects an area to ask about (#118, #2377).
 */
export function pictureClickHandlers(open: (picture: HTMLImageElement) => void): {
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  onClick(event: MouseEvent<HTMLElement>): void;
} {
  let down: { x: number; y: number } | null = null;
  return {
    onPointerDown(event) {
      down = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    },
    onClick(event) {
      const start = down;
      down = null;
      if (!start || event.altKey) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG) return;
      const found = event.target instanceof Element ? event.target.closest(PICTURE_SELECTOR) : null;
      if (found instanceof HTMLImageElement && found.src !== "") open(found);
    },
  };
}

/** A file name the file systems take, longer than a picture's, cut short. */
const fileNameOf = (name: string): string => {
  const clean = name
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${clean || "Picture"}.png`;
};

/** The PNG "Save picture…" writes, named after where the picture is from. */
export function pictureFileName(target: PictureViewerTarget): string {
  const picture = target.pictures[target.index];
  if (!picture) return "Picture.png";
  switch (target.group.kind) {
    case "answer":
      return fileNameOf(`Plot ${target.index + 1}`);
    case "note":
      return fileNameOf(picture.description || `Picture ${target.index + 1}`);
    case "document":
      return fileNameOf(
        picture.place ? `${target.group.name} · ${picture.place}` : target.group.name,
      );
  }
}
