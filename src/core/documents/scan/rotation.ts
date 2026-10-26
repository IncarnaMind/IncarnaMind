import type { Anchor, QuarterTurn } from "../../../shared/units";
import type { PagePicture, PicturePoint, RecognizedLine } from "../../adapters";

export type { QuarterTurn } from "../../../shared/units";

const TURN_BACK: Readonly<Record<QuarterTurn, QuarterTurn>> = {
  0: 0,
  90: 270,
  180: 180,
  270: 90,
};

function quarterTurn(degrees: number): QuarterTurn {
  const turn = ((degrees % 360) + 360) % 360;
  return turn === 90 || turn === 180 || turn === 270 ? turn : 0;
}

export function turnPicture(picture: PagePicture, turn: QuarterTurn): PagePicture {
  if (turn === 0) return picture;
  const { width, height, pixels } = picture;
  const widthAfter = turn === 180 ? width : height;
  const heightAfter = turn === 180 ? height : width;
  const after = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [afterX, afterY]: PicturePoint =
        turn === 90
          ? [height - 1 - y, x]
          : turn === 180
            ? [width - 1 - x, height - 1 - y]
            : [y, width - 1 - x];
      after[afterY * widthAfter + afterX] = pixels[y * width + x] as number;
    }
  }
  return { width: widthAfter, height: heightAfter, pixels: after };
}

/** Turns a point in a continuous picture coordinate space clockwise. */
export function turnPoint(
  [x, y]: PicturePoint,
  turn: QuarterTurn,
  picture: { width: number; height: number },
): PicturePoint {
  switch (turn) {
    case 0:
      return [x, y];
    case 90:
      return [picture.height - y, x];
    case 180:
      return [picture.width - x, picture.height - y];
    case 270:
      return [y, picture.width - x];
  }
}

export function turnQuad(
  quad: readonly number[],
  turn: QuarterTurn,
  picture: { width: number; height: number },
): number[] {
  const turned: number[] = [];
  for (let index = 0; index < quad.length; index += 2) {
    turned.push(...turnPoint([quad[index] ?? 0, quad[index + 1] ?? 0], turn, picture));
  }
  return turned;
}

interface Reading {
  picture: PagePicture;
  lines: RecognizedLine[];
  turn: QuarterTurn;
  score: {
    confidence: number;
    characters: number;
    horizontalShare: number;
  };
}

interface ReadingResult {
  picture: PagePicture;
  lines: RecognizedLine[];
  turn: QuarterTurn;
  passes: number;
}

function score(lines: readonly RecognizedLine[]): Reading["score"] {
  let characters = 0;
  let confidence = 0;
  let horizontal = 0;
  let vertical = 0;
  for (const line of lines) {
    const count = line.text.replaceAll(/\s/g, "").length;
    if (count === 0) continue;
    characters += count;
    confidence += line.confidence * count;
    const [topLeft, topRight, , bottomLeft] = line.quad;
    const top = Math.hypot(topRight[0] - topLeft[0], topRight[1] - topLeft[1]);
    const side = Math.hypot(bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]);
    if (top === 0 && side === 0) continue;
    if (top >= side) horizontal += count;
    else vertical += count;
  }
  return {
    characters,
    confidence: characters === 0 ? 0 : confidence / characters,
    horizontalShare: horizontal + vertical === 0 ? 0 : horizontal / (horizontal + vertical),
  };
}

function settled(reading: Reading): boolean {
  return (
    reading.score.characters > 0 &&
    reading.score.confidence >= 0.85 &&
    reading.score.horizontalShare >= 0.5
  );
}

function clearlyBetter(candidate: Reading, first: Reading): boolean {
  const a = candidate.score;
  const b = first.score;
  const comparable = a.characters >= b.characters * 0.8 && a.confidence >= b.confidence - 0.1;
  return (
    a.characters > 0 &&
    comparable &&
    (a.horizontalShare >= b.horizontalShare + 0.25 || a.confidence >= b.confidence + 0.1)
  );
}

function preferred(candidate: Reading, best: Reading): boolean {
  const horizontal = candidate.score.horizontalShare - best.score.horizontalShare;
  if (Math.abs(horizontal) >= 0.25) return horizontal > 0;
  if (candidate.score.confidence !== best.score.confidence) {
    return candidate.score.confidence > best.score.confidence;
  }
  return candidate.score.characters > best.score.characters;
}

function result(reading: Reading, passes: number): ReadingResult {
  const { score: _score, ...chosen } = reading;
  return { ...chosen, passes };
}

/**
 * Reads the displayed picture first, using the PDF's rotation only to order
 * fallbacks. Line boxes supply the orientation signal; recognition confidence
 * and the amount read choose between turns, so a high-confidence sideways
 * reading is not accepted merely because the model read it confidently.
 */
export async function readWithQuarterTurn(
  picture: PagePicture,
  hint: number,
  read: (picture: PagePicture) => Promise<RecognizedLine[]>,
): Promise<ReadingResult> {
  let passes = 0;
  const at = async (turn: QuarterTurn): Promise<Reading> => {
    const turned = turnPicture(picture, turn);
    // The processing worker transfers what it reads; leave the displayed pixels available for fallbacks.
    const input = turn === 0 ? { ...turned, pixels: new Uint8Array(turned.pixels) } : turned;
    const lines = await read(input);
    passes++;
    return { picture: turned, lines, turn, score: score(lines) };
  };
  const first = await at(0);
  if (settled(first)) return result(first, passes);

  const suggested = TURN_BACK[quarterTurn(hint)];
  const ordered = first.score.horizontalShare < 0.5 ? [90, 270, 180] : [180, 90, 270];
  const turns = [suggested, ...ordered].filter(
    (turn, index, all): turn is QuarterTurn => turn !== 0 && all.indexOf(turn) === index,
  );
  let best: Reading | null = null;
  for (const turn of turns) {
    const candidate = await at(turn);
    if (!clearlyBetter(candidate, first)) continue;
    if (!best || preferred(candidate, best)) best = candidate;
    if (best === candidate && settled(candidate)) return result(candidate, passes);
  }
  return result(best ?? first, passes);
}

/** Maps final reading-space anchors back to fractions of the displayed page. */
export function anchorsBack(anchors: readonly Anchor[], turn: QuarterTurn): Anchor[] {
  return anchors.map((anchor) => ({
    ...anchor,
    ...(anchor.quad && {
      quad: turnQuad(anchor.quad, TURN_BACK[turn], { width: 1, height: 1 }),
    }),
  }));
}
