/** A piece of a Transcript line's text as the window shows it: a word, or what lies between two. */
export interface WordPiece {
  /** Where it starts in its file's line's text. */
  at: number;
  text: string;
  word: boolean;
}

const segmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(language: string): Intl.Segmenter {
  let segmenter = segmenters.get(language);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(language, { granularity: "word" });
    segmenters.set(language, segmenter);
  }
  return segmenter;
}

/** A line's words, in English and Chinese alike, which a click plays from and a caret moves by (#138). */
export function wordPieces(text: string, language: string): WordPiece[] {
  return [...segmenterFor(language).segment(text)].map((segment) => ({
    at: segment.index,
    text: segment.segment,
    word: segment.isWordLike === true,
  }));
}

/**
 * The pieces of one part of a line, `from` to `to` in its text, without the spaces at its ends. A
 * piece across an end is cut there: a split made where another language's words end.
 */
export function piecesBetween(pieces: readonly WordPiece[], from: number, to: number): WordPiece[] {
  const inside = pieces.flatMap((piece) => {
    const start = Math.max(piece.at, from);
    const end = Math.min(piece.at + piece.text.length, to);
    if (end <= start) return [];
    return [{ ...piece, at: start, text: piece.text.slice(start - piece.at, end - piece.at) }];
  });
  const blank = (piece: WordPiece | undefined) => piece !== undefined && piece.text.trim() === "";
  while (blank(inside[0])) inside.shift();
  while (blank(inside.at(-1))) inside.pop();
  return inside;
}
