/**
 * Pictures inside Office packages as `data:` URLs, which the app's
 * Content-Security-Policy allows (not `blob:` ones): the formats a browser
 * shows, by extension. SVG is left out, as it can carry scripts and links;
 * EMF, WMF and TIFF a browser can't show.
 */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

/** The media type of a picture part a browser can show, or null. */
export const imageTypeOf = (part: string): string | null =>
  IMAGE_TYPES[part.split(".").pop()?.toLowerCase() ?? ""] ?? null;

/** A picture's bytes as a `data:` URL of its media type. */
export function dataUrlOf(data: Uint8Array, type: string): string {
  let binary = "";
  for (let at = 0; at < data.length; at += 0x8000) {
    binary += String.fromCharCode(...data.subarray(at, at + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** The brands an ISO base media file uses for HEIC and HEIF pictures. */
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

/**
 * Whether the bytes are a HEIC or HEIF picture (a phone photo, say), which
 * the engine that draws pictures can't read where the app runs (#1937).
 */
export function isHeifPicture(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const marker = String.fromCharCode(...bytes.subarray(4, 8));
  const brand = String.fromCharCode(...bytes.subarray(8, 12)).toLowerCase();
  return marker === "ftyp" && HEIF_BRANDS.has(brand);
}
