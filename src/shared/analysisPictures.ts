/**
 * The plots an Answer's Analyses drew with matplotlib (#2346), in its Blocks:
 * a line that is only "[=picture 2]" becomes that picture, as a pasted
 * picture is kept in a Note (#1937), with its title as its alt text. Pure: the
 * core writes an Answer into a Note with it, and the assistant draws an Answer
 * of a conversation with it.
 */
import { type AnswerAnalysis, PICTURE_NODE } from "../core/api";
import type { AnalysisPicture } from "./analysis";
import type { NodeJSON } from "./blockJson";

const PICTURE_LINE = /^\[=picture (\d+)\]$/;

/** matplotlib draws at twice a plot's size in points, so it stays sharp on a high-density screen. */
const DRAWN_AT = 2;

const textOf = (node: NodeJSON): string =>
  (node.content ?? [])
    .map((child) => (child.type === "text" ? (child.text ?? "") : "\u0000"))
    .join("");

export function withAnalysisPictures(
  blocks: readonly NodeJSON[],
  analyses: readonly Pick<AnswerAnalysis, "markers" | "output">[] | undefined,
): NodeJSON[] {
  const pictures = new Map<number, AnalysisPicture>();
  // The first Analysis that gave a marker names it: this Answer's, when it is listed first.
  for (const analysis of analyses ?? []) {
    (analysis.markers.pictures ?? []).forEach((marker, index) => {
      const picture = analysis.output.pictures?.[index];
      if (picture && !pictures.has(marker)) pictures.set(marker, picture);
    });
  }
  if (pictures.size === 0) return [...blocks];
  return blocks.flatMap((block) => {
    const marker = block.type === "paragraph" ? PICTURE_LINE.exec(textOf(block).trim()) : null;
    if (!marker) return [block];
    const picture = pictures.get(Number(marker[1]));
    if (!picture) return [];
    return [
      {
        type: PICTURE_NODE,
        attrs: {
          src: `data:image/png;base64,${picture.png}`,
          alt: picture.title,
          width: Math.max(1, Math.round(picture.width / DRAWN_AT)),
          height: Math.max(1, Math.round(picture.height / DRAWN_AT)),
        },
      },
    ];
  });
}
