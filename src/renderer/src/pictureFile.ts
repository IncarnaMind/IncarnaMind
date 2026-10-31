/** The longest side a picture keeps in a Note: about twice a card's width, as a cited page is. */
export const PICTURE_MAX_EDGE = 1600;
/** More pixels than this would take too much memory to draw. */
export const PICTURE_MAX_PIXELS = 50_000_000;
/** A picture larger than this in the file is refused, as a saved web page's pictures are (#756). */
export const PICTURE_MAX_BYTES = 50 * 1024 * 1024;
/** What a picture kept in the Note's data should weigh: it syncs with the Note. */
const KEPT_MAX_BYTES = 1_500_000;
/** The sizes a picture over that is drawn at before it is kept: its quality, then its edge. */
const ATTEMPTS = [
  { edge: PICTURE_MAX_EDGE, quality: 0.82 },
  { edge: PICTURE_MAX_EDGE, quality: 0.6 },
  { edge: PICTURE_MAX_EDGE / 2, quality: 0.7 },
] as const;

export interface KeptPicture {
  /** A `data:` URL of the Note's data. */
  src: string;
  /** The size it is kept at, in pixels. */
  width: number;
  height: number;
}

/** A picture that can't be kept, and why, for the User's words where they pasted it. */
export type PreparedPicture =
  | { picture: KeptPicture }
  | { problem: "unreadable" | "empty" | "too-large" };

/** Whether a file is a HEIC or HEIF picture, which the web engine alone can't read. */
export const isHeicPicture = (file: Blob & { name?: string }): boolean =>
  /^image\/hei[cf]$/i.test(file.type) || /\.hei[cf]$/i.test(file.name ?? "");

/** The size a picture of `width` × `height` is drawn at: no longer than `maxEdge`, never larger. */
export function scaledPictureSize(
  width: number,
  height: number,
  maxEdge = PICTURE_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** How the picture is kept: PNG where some of it is see-through (a logo, a diagram), else JPEG. */
export function keptFormat(hasAlpha: boolean): {
  mediaType: "image/png" | "image/jpeg";
  extension: "png" | "jpg";
} {
  return hasAlpha
    ? { mediaType: "image/png", extension: "png" }
    : { mediaType: "image/jpeg", extension: "jpg" };
}

/**
 * A pasted or dropped picture, resized to fit a Note and drawn again as PNG or
 * JPEG, as a `data:` URL the Note keeps: the app's Content-Security-Policy
 * allows no other kind, and Word can hold no HEIC. The web engine reads it
 * where it can; `convert` lets the computer's own decoder read one it can't,
 * as macOS reads a HEIC. Where neither can, the caller says why.
 */
export async function preparePicture(
  file: Blob,
  { convert }: { convert?: (file: Blob) => Promise<Blob | null> } = {},
): Promise<PreparedPicture> {
  if (file.size === 0) return { problem: "empty" };
  if (file.size > PICTURE_MAX_BYTES) return { problem: "too-large" };
  try {
    return await drawPicture(file);
  } catch {
    // The web engine has no decoder for it: the computer's own may.
  }
  const converted = await convert?.(file).catch(() => null);
  if (!converted) return { problem: "unreadable" };
  try {
    return await drawPicture(converted);
  } catch {
    return { problem: "unreadable" };
  }
}

async function drawPicture(file: Blob): Promise<PreparedPicture> {
  // Decoded from the file itself: the page's Content-Security-Policy allows no blob: to draw.
  const image = await createImageBitmap(file);
  try {
    return await keptPicture(image);
  } finally {
    image.close();
  }
}

async function keptPicture(image: ImageBitmap): Promise<PreparedPicture> {
  const natural = { width: image.width, height: image.height };
  if (natural.width * natural.height > PICTURE_MAX_PIXELS) return { problem: "too-large" };
  // The picture is first drawn at its kept size; over the weight, smaller and lighter copies follow.
  for (const attempt of ATTEMPTS) {
    const size = scaledPictureSize(natural.width, natural.height, attempt.edge);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The picture has no canvas to be drawn on.");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, size.width, size.height);
    const format = keptFormat(hasAlpha(context, size.width, size.height));
    const src = canvas.toDataURL(format.mediaType, attempt.quality);
    if (!src.startsWith(`data:${format.mediaType};`)) throw new Error("The picture wasn't drawn.");
    if (src.length <= KEPT_MAX_BYTES || attempt === ATTEMPTS.at(-1)) {
      return { picture: { src, ...size } };
    }
  }
  throw new Error("The picture wasn't drawn.");
}

/** Whether any pixel is see-through, read on the drawn copy, which is small once resized. */
function hasAlpha(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let at = 3; at < pixels.length; at += 4) {
    if (pixels[at] !== 255) return true;
  }
  return false;
}
